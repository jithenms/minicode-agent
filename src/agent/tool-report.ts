import type {
  BashReportExit,
  BashReportStream,
  RecoveryDetail,
  ToolEvent,
  ToolName,
  ToolOutputMap,
  ToolReportEvent,
} from "../types.js";

export function toToolReportEvent(event: ToolEvent): ToolReportEvent {
  const base = {
    step: event.step,
    tool: event.request.name,
    status: event.result.status,
    durationMs: event.result.durationMs,
  };
  if (event.result.status === "cancelled") {
    return { step: event.step, tool: event.request.name, status: "cancelled", durationMs: event.result.durationMs };
  }
  if (event.result.status === "failed") {
    if (event.request.name === "bash") {
      const details = event.result.error.details ?? {};
      return {
        ...base,
        tool: "bash",
        status: "failed",
        command: commandFrom(event),
        code: event.result.error.code,
        message: event.result.error.message,
        exit: bashExit(details.exitCode, details.signal),
        recovery: recoveryDetails(details, new Set(["exitCode", "signal", "stdout", "stderr", "stdoutTruncated", "stderrTruncated", "command"])),
        stdout: stream(details.stdout, details.stdoutTruncated),
        stderr: stream(details.stderr, details.stderrTruncated),
      };
    }
    return {
      ...base,
      tool: event.request.name as Exclude<ToolName, "bash">,
      status: "failed",
      code: event.result.error.code,
      message: event.result.error.message,
      recovery: recoveryDetails(event.result.error.details ?? {}),
    };
  }

  const output = event.result.output;
  switch (event.request.name) {
    case "list_files": {
      const value = output as ToolOutputMap["list_files"];
      return { ...base, tool: "list_files", status: "succeeded", pathCount: value.paths.length, truncated: value.truncated };
    }
    case "search_text": {
      const value = output as ToolOutputMap["search_text"];
      const args = event.request.arguments as { query?: unknown };
      return {
        ...base,
        tool: "search_text",
        status: "succeeded",
        query: typeof args.query === "string" ? args.query : "",
        matchCount: value.matches.length,
        truncated: value.truncated,
      };
    }
    case "read_file": {
      const value = output as ToolOutputMap["read_file"];
      return {
        ...base,
        tool: "read_file",
        status: "succeeded",
        path: value.path,
        read: value.mode === "full"
          ? { mode: "full", linesRead: countLines(value.content) }
          : { mode: "range", startLine: value.offset + 1, linesRead: value.linesRead, truncated: value.truncated },
      };
    }
    case "edit_file": return { ...base, tool: "edit_file", status: "succeeded", path: (output as ToolOutputMap["edit_file"]).path };
    case "create_file": return { ...base, tool: "create_file", status: "succeeded", path: (output as ToolOutputMap["create_file"]).path };
    case "inspect_changes": {
      const value = output as ToolOutputMap["inspect_changes"];
      return {
        ...base,
        tool: "inspect_changes",
        status: "succeeded",
        fileCount: value.files.length,
        complete: value.files.every((file) => file.complete),
      };
    }
    case "bash": {
      const value = output as ToolOutputMap["bash"];
      return {
        ...base,
        tool: "bash",
        status: "succeeded",
        command: commandFrom(event),
        exit: { kind: "code", code: value.exitCode },
        stdout: { text: value.stdout, executionTruncated: value.stdoutTruncated },
        stderr: { text: value.stderr, executionTruncated: value.stderrTruncated },
      };
    }
  }
}

function commandFrom(event: ToolEvent): string {
  const args = event.request.arguments as { command?: unknown };
  return typeof args.command === "string" ? args.command : "";
}

function countLines(value: string): number {
  if (!value) return 0;
  const newlines = value.match(/\n/g)?.length ?? 0;
  return newlines + (value.endsWith("\n") ? 0 : 1);
}

function bashExit(exitCode: unknown, signal: unknown): BashReportExit {
  if (typeof exitCode === "number") return { kind: "code", code: exitCode };
  if (typeof signal === "string") return { kind: "signal", signal };
  return { kind: "unknown" };
}

function stream(text: unknown, truncated: unknown): BashReportStream {
  return {
    text: typeof text === "string" ? text : "",
    executionTruncated: truncated === true,
  };
}

function recoveryDetails(details: Record<string, unknown>, excluded = new Set<string>()): RecoveryDetail[] {
  const labels: Record<string, string> = {
    path: "Path",
    field: "Field",
    occurrences: "Occurrences",
    sizeBytes: "Size bytes",
    limitBytes: "Limit bytes",
    cause: "Cause",
    tool: "Tool",
  };
  const recovery: RecoveryDetail[] = [];
  for (const key of ["path", "field", "occurrences", "sizeBytes", "limitBytes", "cause", "tool"]) {
    if (excluded.has(key)) continue;
    const value = details[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      recovery.push({ label: labels[key]!, value: String(value) });
    }
  }
  return recovery;
}
