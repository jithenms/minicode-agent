import { readFile } from "node:fs/promises";
import { createTwoFilesPatch } from "diff";
import type { FileState, InspectedFile, ToolArgumentsMap, ToolOutputMap } from "../types.js";
import { LIMITS } from "../types.js";
import type { GitWorkspace } from "../worktree/git.js";
import { normalizeWorkspacePath } from "../worktree/path.js";

const decoder = new TextDecoder("utf-8", { fatal: true });

export async function inspectChanges(
  workspace: GitWorkspace,
  states: Record<string, FileState>,
  args: ToolArgumentsMap["inspect_changes"],
): Promise<ToolOutputMap["inspect_changes"]> {
  const requested = args.paths?.map(normalizeWorkspacePath) ?? Object.keys(states).filter((relative) => {
    const state = states[relative];
    return Boolean(state?.latestMutationEventId && state.baseline);
  });
  const files: InspectedFile[] = [];
  for (const relative of requested) {
    const state = states[relative];
    if (!state?.baseline) continue;
    const resolved = await workspace.resolveRelative(relative);
    const current = await readFile(resolved.absolute);
    const contentId = await workspace.contentId(current);
    const before = state.baseline.kind === "existing" ? decodeUtf8(state.baseline.content, relative) : "";
    const after = decodeUtf8(current, relative);
    const patch = createTwoFilesPatch(
      state.baseline.kind === "existing" ? `a/${relative}` : "/dev/null",
      `b/${relative}`,
      before,
      after,
      "baseline",
      "current",
      { context: 3 },
    );
    const complete = Buffer.byteLength(patch) <= LIMITS.agentDiffBytes;
    files.push({ path: relative, agentDiff: complete ? patch : bytePrefix(patch, LIMITS.agentDiffBytes), contentId, complete });
  }
  const gitDiff = await workspace.gitDiff();
  const gitDiffTruncated = Buffer.byteLength(gitDiff) > LIMITS.gitDiffBytes;
  return {
    gitStatus: await workspace.status(),
    gitDiff: gitDiffTruncated ? bytePrefix(gitDiff, LIMITS.gitDiffBytes) : gitDiff,
    gitDiffTruncated,
    files,
  };
}

function decodeUtf8(bytes: Uint8Array, filePath: string): string {
  try { return decoder.decode(bytes); }
  catch { throw toolError("BINARY_FILE", "File is not valid UTF-8 text", { path: filePath }); }
}

function bytePrefix(value: string, limit: number): string {
  const bytes = Buffer.from(value);
  return bytes.length <= limit ? value : bytes.subarray(0, limit).toString("utf8");
}

function toolError(code: string, message: string, details?: Record<string, unknown>): Error {
  return Object.assign(new Error(message), { code, ...(details ? { details } : {}) });
}
