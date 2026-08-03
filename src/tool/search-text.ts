import { readFile } from "node:fs/promises";
import type { SearchMatch, ToolArgumentsMap, ToolOutputMap } from "../types.js";
import { LIMITS } from "../types.js";
import type { GitWorkspace } from "../worktree/git.js";
import { normalizeWorkspacePath } from "../worktree/path.js";
import { listFiles } from "./list-files.js";

const decoder = new TextDecoder("utf-8", { fatal: true });

export async function searchText(
  workspace: GitWorkspace,
  args: ToolArgumentsMap["search_text"],
): Promise<ToolOutputMap["search_text"]> {
  if (typeof args.query !== "string" || !args.query) throw toolError("INVALID_ARGUMENT", "query must not be empty", { field: "query" });
  const searchPath = args.path === undefined ? undefined : normalizeWorkspacePath(args.path);
  const listed = await listFiles(workspace, {
    ...(args.glob ? { glob: args.glob } : {}),
  }, searchPath);
  const matches: SearchMatch[] = [];
  const needle = args.caseSensitive ? args.query : args.query.toLocaleLowerCase();
  for (const relative of listed.paths) {
    if (matches.length >= LIMITS.searchMatches) break;
    try {
      const resolved = await workspace.resolveRelative(relative);
      const text = decoder.decode(await readFile(resolved.absolute));
      const lines = text.split(/\r?\n/);
      for (let index = 0; index < lines.length && matches.length < LIMITS.searchMatches; index += 1) {
        const line = lines[index] ?? "";
        const source = args.caseSensitive ? line : line.toLocaleLowerCase();
        const column = source.indexOf(needle);
        if (column >= 0) matches.push({ path: relative, line: index + 1, column: column + 1, text: bytePrefix(line, LIMITS.searchLineBytes) });
      }
    } catch { /* Binary, missing, and unreadable files are not search results. */ }
  }
  return { matches, truncated: matches.length >= LIMITS.searchMatches || listed.truncated };
}

function bytePrefix(value: string, limit: number): string {
  const bytes = Buffer.from(value);
  return bytes.length <= limit ? value : bytes.subarray(0, limit).toString("utf8");
}

function toolError(code: string, message: string, details?: Record<string, unknown>): Error {
  return Object.assign(new Error(message), { code, ...(details ? { details } : {}) });
}
