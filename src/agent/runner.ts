import { platform, release } from "node:os";
import type {
  ModelAdapter,
  ModelObservation,
  RunConfig,
  RunResult,
  RunState,
  ToolEvent,
  ToolName,
  ToolOutputMap,
  ToolRequest,
} from "../types.js";
import { LocalToolExecutor } from "../tool/executor.js";
import { GitWorkspace } from "../worktree/git.js";
import { normalizeWorkspacePath } from "../worktree/path.js";
import { buildAgentPrompt } from "./prompt.js";
import { toToolReportEvent } from "./tool-report.js";

export class CodingAgentRunner {
  constructor(private readonly model: ModelAdapter) {}

  async run(config: RunConfig): Promise<RunResult> {
    const maxSteps = config.maxSteps ?? 40;
    let workspace: GitWorkspace;
    try {
      workspace = await GitWorkspace.open(config.cwd);
    } catch (error) {
      return { status: "failed", reason: (error as Error).message, steps: 0 };
    }
    const state: RunState = {
      task: config.task,
      workspace: workspace.baseline,
      steps: 0,
      toolEvents: [],
      files: {},
    };
    const systemPrompt = buildAgentPrompt({
      modelFamily: config.modelFamily ?? "unknown",
      workingDirectory: state.workspace.gitRoot,
      date: formatPromptDate(new Date()),
      platform: `${platform()} ${release()}`,
    });
    config.onPreExistingChanges?.(await workspace.status());
    const executor = await LocalToolExecutor.create(workspace, () => state.files, config.signal);
    let observation: ModelObservation = { kind: "initial" };
    let previousFailedSignature: string | undefined;
    try {
      while (state.steps < maxSteps) {
        if (config.signal?.aborted) return { status: "cancelled", steps: state.steps };
        state.steps += 1;
        let turn;
        try {
          turn = await this.model.runTurn({
            task: state.task,
            workspaceRoot: state.workspace.gitRoot,
            systemPrompt,
            step: state.steps,
            maxSteps,
            observation,
          });
        } catch {
          return { status: "failed", reason: "Model request failed", steps: state.steps };
        }
        if (config.signal?.aborted) return { status: "cancelled", steps: state.steps };
        if (turn.kind === "complete") {
          const gate = await this.completionGate(state, workspace, turn.summary);
          if (gate.kind === "complete") {
            return {
              status: "completed",
              summary: turn.summary.trim(),
              changedFiles: gate.changedFiles,
              verification: gate.verification,
              steps: state.steps,
            };
          }
          if (gate.kind === "fatal") return { status: "failed", reason: gate.reason, ...(gate.affectedPaths ? { affectedPaths: gate.affectedPaths } : {}), steps: state.steps };
          config.onCompletionRejected?.(state.steps, gate.reasons);
          observation = { kind: "completion_rejected", reasons: gate.reasons };
          continue;
        }

        const rawRequest = asRequest(turn.tool, turn.arguments);
        let request = rawRequest;
        let preparationFailure: { code: string; message: string; details?: Record<string, unknown> } | undefined;
        try {
          request = normalizeRequestPaths(rawRequest);
        } catch (error) {
          preparationFailure = normalizeError(error);
        }
        config.onStep?.(state.steps, maxSteps, request.name);

        const signature = stableCallSignature(request);
        let result;
        let commandFingerprint;
        if (signature === previousFailedSignature) {
          result = failedResult("REPEATED_FAILED_CALL", "This operation already failed; change the tool or arguments before retrying", {
            tool: request.name,
          });
        } else if (preparationFailure) {
          result = failedResult(preparationFailure.code, preparationFailure.message, preparationFailure.details);
        } else {
          if (request.name === "bash") commandFingerprint = await workspace.captureCommandFingerprint();
          result = await executor.execute(request);
        }

        const event = {
          eventId: state.toolEvents.length + 1,
          step: state.steps,
          request,
          result,
        } as ToolEvent;
        state.toolEvents.push(event);
        updateStateFromEvent(state, event);
        config.onTool?.(toToolReportEvent(event));
        previousFailedSignature = result.status === "failed" ? signature : undefined;

        if (commandFingerprint) {
          const affectedPaths = await workspace.commandChanges(commandFingerprint);
          if (affectedPaths.length) return { status: "failed", reason: "bash changed the workspace", affectedPaths, steps: state.steps };
        }
        observation = { kind: "tool_result", tool: event.request.name, result: modelObservation(event) };
      }
      return { status: "failed", reason: `Maximum of ${maxSteps} model turns exhausted`, steps: state.steps };
    } finally {
      await executor.dispose();
    }
  }

  private async completionGate(
    state: RunState,
    workspace: GitWorkspace,
    summary: string,
  ): Promise<
    | { kind: "complete"; changedFiles: Array<{ path: string; status: "M" | "A" }>; verification: { command: string } }
    | { kind: "reject"; reasons: string[] }
    | { kind: "fatal"; reason: string; affectedPaths?: string[] }
  > {
    const finalIds = new Map<string, string | null>();
    const externallyChanged: string[] = [];
    for (const [relative, file] of Object.entries(state.files)) {
      if (file.latestMutationEventId === undefined) continue;
      const finalId = await workspace.currentContentId(relative);
      finalIds.set(relative, finalId);
      if (finalId !== mutationResultingContentId(state, file.latestMutationEventId)) externallyChanged.push(relative);
    }
    if (externallyChanged.length) {
      return { kind: "fatal", reason: "WORKSPACE_CHANGED_OUTSIDE_AGENT", affectedPaths: externallyChanged };
    }

    const changedFiles = Object.entries(state.files).filter(([relative, file]) => {
      if (file.latestMutationEventId === undefined || !file.baseline) return false;
      const baselineId = file.baseline.kind === "existing" ? file.baseline.contentId : null;
      return finalIds.get(relative) !== baselineId;
    }).map(([relative]) => relative).sort();

    const reasons: string[] = [];
    if (!changedFiles.length) reasons.push("Current agent-relative change set is empty");
    for (const relative of changedFiles) {
      const file = state.files[relative]!;
      const inspection = file.latestInspection;
      if (!inspection || inspection.eventId <= file.latestMutationEventId! || inspection.contentId !== finalIds.get(relative)) {
        reasons.push(`${relative} lacks a fresh complete inspection matching its final content`);
      }
    }
    const latestMutationEventId = Math.max(-1, ...changedFiles.map((relative) => state.files[relative]!.latestMutationEventId!));
    const verificationEvent = state.toolEvents.filter((event) => event.eventId > latestMutationEventId
      && event.request.name === "bash"
      && event.result.status === "succeeded").at(-1);
    if (!verificationEvent) reasons.push("No successful Bash verification occurred after the latest mutation");
    if ((await workspace.head()) !== state.workspace.headCommit) return { kind: "fatal", reason: "Repository HEAD changed during the run", affectedPaths: [".git/HEAD"] };
    if (!summary.trim()) reasons.push("Completion summary is empty");
    if (reasons.length) return { kind: "reject", reasons };
    return {
      kind: "complete",
      changedFiles: changedFiles.map((relative) => ({
        path: relative,
        status: state.files[relative]!.baseline?.kind === "absent" ? "A" : "M",
      })),
      verification: { command: (verificationEvent!.request.arguments as { command: string }).command },
    };
  }
}

function updateStateFromEvent(state: RunState, event: ToolEvent): void {
  if (event.result.status !== "succeeded") return;
  if (event.request.name === "edit_file") {
    const output = event.result.output as ToolOutputMap["edit_file"];
    const file = state.files[output.path] ?? {};
    if (!file.baseline) {
      file.baseline = {
        kind: "existing",
        contentId: output.beforeContentId,
        content: output.beforeContent,
      };
    }
    file.latestMutationEventId = event.eventId;
    delete file.latestInspection;
    state.files[output.path] = file;
  } else if (event.request.name === "create_file") {
    const output = event.result.output as ToolOutputMap["create_file"];
    state.files[output.path] = { baseline: { kind: "absent" }, latestMutationEventId: event.eventId };
  } else if (event.request.name === "inspect_changes") {
    const output = event.result.output as ToolOutputMap["inspect_changes"];
    for (const inspected of output.files) {
      const file = state.files[inspected.path];
      if (file && inspected.complete) {
        file.latestInspection = { eventId: event.eventId, contentId: inspected.contentId };
      }
    }
  }
}

function mutationResultingContentId(state: RunState, eventId: number): string | null {
  const event = state.toolEvents.find((candidate) => candidate.eventId === eventId);
  if (!event || event.result.status !== "succeeded") return null;
  if (event.request.name === "edit_file") return (event.result.output as ToolOutputMap["edit_file"]).resultingContentId;
  if (event.request.name === "create_file") return (event.result.output as ToolOutputMap["create_file"]).resultingContentId;
  return null;
}

function normalizeRequestPaths(request: ToolRequest): ToolRequest {
  const args = request.arguments as Record<string, unknown>;
  if (["search_text", "read_file", "edit_file", "create_file"].includes(request.name) && typeof args.path === "string") {
    return { ...request, arguments: { ...args, path: normalizeWorkspacePath(args.path) } } as ToolRequest;
  }
  if (request.name === "inspect_changes" && Array.isArray(args.paths) && args.paths.every((value) => typeof value === "string")) {
    return { ...request, arguments: { ...args, paths: args.paths.map(normalizeWorkspacePath) } } as ToolRequest;
  }
  return request;
}

function stableCallSignature(request: ToolRequest): string {
  return stableSerialize({ tool: request.name, arguments: request.arguments });
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().filter((key) => record[key] !== undefined).map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function asRequest(name: ToolName, value: unknown): ToolRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { name, arguments: {} } as ToolRequest;
  return { name, arguments: value } as ToolRequest;
}

function formatPromptDate(date: Date): string {
  return date.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function failedResult(code: string, message: string, details?: Record<string, unknown>) {
  return { status: "failed" as const, error: { code, message, ...(details ? { details } : {}) }, durationMs: 0 };
}

function normalizeError(error: unknown): { code: string; message: string; details?: Record<string, unknown> } {
  const value = error as { code?: string; message?: string; details?: Record<string, unknown> };
  return {
    code: value.code ?? "TOOL_ERROR",
    message: value.message ?? String(error),
    ...(value.details ? { details: value.details } : {}),
  };
}

function modelObservation(event: ToolEvent): Record<string, unknown> {
  if (event.result.status === "cancelled") return { status: "cancelled", tool: event.request.name };
  if (event.result.status === "failed") {
    return {
      status: "failed",
      tool: event.request.name,
      code: event.result.error.code,
      message: event.result.error.message,
      ...(event.result.error.details ? { details: event.result.error.details } : {}),
    };
  }
  const output = event.result.output;
  switch (event.request.name) {
    case "read_file": {
      const read = output as ToolOutputMap["read_file"];
      let visible: Record<string, unknown> = read;
      if (read.mode === "full") {
        const { contentId: _contentId, ...rest } = read;
        visible = rest;
      }
      return {
        status: "succeeded",
        summary: read.mode === "full" ? `Read the full file ${read.path}` : `Read ${read.linesRead} lines from ${read.path} at offset ${read.offset}`,
        output: visible,
      };
    }
    case "edit_file": return { status: "succeeded", summary: `Edited ${(output as ToolOutputMap["edit_file"]).path}` };
    case "create_file": return { status: "succeeded", summary: `Created ${(output as ToolOutputMap["create_file"]).path}` };
    case "bash": return { status: "succeeded", summary: "Bash exited successfully", output };
    case "inspect_changes": {
      const inspected = output as ToolOutputMap["inspect_changes"];
      return {
        status: "succeeded",
        summary: `Inspected ${inspected.files.length} changed files`,
        output: { ...inspected, files: inspected.files.map(({ contentId: _contentId, ...file }) => file) },
      };
    }
    default: return { status: "succeeded", output };
  }
}
