import { chmod, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import type { ToolArgumentsMap, ToolOutputMap } from "../types.js";
import { LIMITS } from "../types.js";
import type { GitWorkspace } from "../worktree/git.js";

const decoder = new TextDecoder("utf-8", { fatal: true });

export async function editFile(
  workspace: GitWorkspace,
  args: ToolArgumentsMap["edit_file"],
): Promise<ToolOutputMap["edit_file"]> {
  enforceByteLimit(args.oldText, LIMITS.editStringBytes, "oldText");
  enforceByteLimit(args.newText, LIMITS.editStringBytes, "newText");
  if (!args.oldText) throw toolError("INVALID_ARGUMENT", "oldText must not be empty", { field: "oldText" });
  if (args.oldText === args.newText) throw toolError("NO_CHANGE", "oldText and newText must differ", { path: args.path });
  const resolved = await workspace.resolveForMutation(args.path);
  if (await workspace.isIgnored(resolved.relative)) throw toolError("IGNORED_PATH", "Git-ignored files cannot be edited", { path: resolved.relative });
  const bytes = await readFile(resolved.absolute);
  if (bytes.byteLength > LIMITS.fullReadBytes) {
    throw toolError("FILE_TOO_LARGE_TO_EDIT", `File is ${bytes.byteLength} bytes; edits are limited to ${LIMITS.fullReadBytes}`, {
      path: resolved.relative, sizeBytes: bytes.byteLength, limitBytes: LIMITS.fullReadBytes,
    });
  }
  const beforeContentId = await workspace.contentId(bytes);
  const text = decodeUtf8(bytes, resolved.relative);
  const first = text.indexOf(args.oldText);
  const second = first < 0 ? -1 : text.indexOf(args.oldText, first + args.oldText.length);
  if (first < 0) throw toolError("TEXT_NOT_FOUND", "oldText does not occur in the file", { path: resolved.relative, occurrences: 0 });
  if (second >= 0) throw toolError("AMBIGUOUS_EDIT", "oldText occurs more than once", { path: resolved.relative, occurrences: "multiple" });
  const updated = text.slice(0, first) + args.newText + text.slice(first + args.oldText.length);
  const updatedBytes = Buffer.from(updated, "utf8");
  const mode = (await stat(resolved.absolute)).mode;
  const temp = `${resolved.absolute}.minicode-agent-${process.pid}-${crypto.randomUUID()}`;
  try {
    await writeFile(temp, updatedBytes, { flag: "wx", mode });
    await chmod(temp, mode);
    await rename(temp, resolved.absolute);
  } finally {
    await rm(temp, { force: true });
  }
  return {
    path: resolved.relative,
    beforeContent: bytes,
    beforeContentId,
    resultingContentId: await workspace.contentId(updatedBytes),
  };
}

function enforceByteLimit(value: string, limit: number, field: string): void {
  const sizeBytes = Buffer.byteLength(value);
  if (sizeBytes > limit) throw toolError("ARGUMENT_TOO_LARGE", `${field} exceeds ${limit} bytes`, { field, sizeBytes, limitBytes: limit });
}

function decodeUtf8(bytes: Uint8Array, filePath: string): string {
  try { return decoder.decode(bytes); }
  catch { throw toolError("BINARY_FILE", "File is not valid UTF-8 text", { path: filePath }); }
}

function toolError(code: string, message: string, details?: Record<string, unknown>): Error {
  return Object.assign(new Error(message), { code, ...(details ? { details } : {}) });
}
