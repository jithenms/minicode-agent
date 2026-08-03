import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  FileState,
  ToolArgumentsMap,
  ToolExecutionResult,
  ToolExecutor,
  ToolName,
  ToolOutputMap,
  ToolRequest,
} from "../types.js";
import type { GitWorkspace } from "../worktree/git.js";
import { runBash } from "./bash.js";
import { createFile } from "./create-file.js";
import { editFile } from "./edit-file.js";
import { inspectChanges } from "./inspect-changes.js";
import { listFiles } from "./list-files.js";
import { readFileTool } from "./read-file.js";
import { searchText } from "./search-text.js";

export class LocalToolExecutor implements ToolExecutor {
  private constructor(
    private readonly workspace: GitWorkspace,
    private readonly getFiles: () => Record<string, FileState>,
    private readonly runHome: string,
    private readonly signal?: AbortSignal,
  ) {}

  static async create(
    workspace: GitWorkspace,
    getFiles: () => Record<string, FileState>,
    signal?: AbortSignal,
  ): Promise<LocalToolExecutor> {
    const runHome = await mkdtemp(path.join(tmpdir(), "minicode-agent-home-"));
    return new LocalToolExecutor(workspace, getFiles, runHome, signal);
  }

  async dispose(): Promise<void> {
    await rm(this.runHome, { recursive: true, force: true });
  }

  async execute<N extends ToolName>(
    request: ToolRequest<N>,
  ): Promise<ToolExecutionResult<ToolOutputMap[N]>> {
    const started = performance.now();
    try {
      let output: ToolOutputMap[ToolName];
      switch (request.name) {
        case "list_files": output = await listFiles(this.workspace, request.arguments as ToolArgumentsMap["list_files"]); break;
        case "search_text": output = await searchText(this.workspace, request.arguments as ToolArgumentsMap["search_text"]); break;
        case "read_file": output = await readFileTool(this.workspace, request.arguments as ToolArgumentsMap["read_file"]); break;
        case "edit_file": output = await editFile(this.workspace, request.arguments as ToolArgumentsMap["edit_file"]); break;
        case "create_file": output = await createFile(this.workspace, request.arguments as ToolArgumentsMap["create_file"]); break;
        case "bash": output = await runBash(this.workspace, request.arguments as ToolArgumentsMap["bash"], this.runHome, this.signal); break;
        case "inspect_changes": output = await inspectChanges(this.workspace, this.getFiles(), request.arguments as ToolArgumentsMap["inspect_changes"]); break;
        default: throw toolError("UNKNOWN_TOOL", `Unknown tool: ${String(request.name)}`);
      }
      return { status: "succeeded", output: output as ToolOutputMap[N], durationMs: elapsed(started) };
    } catch (error) {
      if (this.signal?.aborted || (error as { code?: string })?.code === "CANCELLED") {
        return { status: "cancelled", durationMs: elapsed(started) };
      }
      return { status: "failed", error: normalizeError(error), durationMs: elapsed(started) };
    }
  }
}

function elapsed(start: number): number {
  return Math.round(performance.now() - start);
}

function toolError(code: string, message: string, details?: Record<string, unknown>): Error {
  return Object.assign(new Error(message), { code, ...(details ? { details } : {}) });
}

function normalizeError(error: unknown): { code: string; message: string; details?: Record<string, unknown> } {
  const value = error as { code?: string; message?: string; details?: Record<string, unknown> };
  return {
    code: value.code ?? "TOOL_ERROR",
    message: value.message ?? String(error),
    ...(value.details ? { details: value.details } : {}),
  };
}
