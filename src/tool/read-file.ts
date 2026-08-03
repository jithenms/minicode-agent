import type { Stats } from "node:fs";
import { open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import type { ToolArgumentsMap, ToolOutputMap } from "../types.js";
import { LIMITS } from "../types.js";
import type { GitWorkspace } from "../worktree/git.js";

export async function readFileTool(
  workspace: GitWorkspace,
  args: ToolArgumentsMap["read_file"],
): Promise<ToolOutputMap["read_file"]> {
  const resolved = await workspace.resolveRelative(args.path);
  const handle = await open(resolved.absolute, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw toolError("NOT_A_FILE", "Path is not a regular file", { path: resolved.relative });
    const ranged = args.offset !== undefined || args.limit !== undefined;
    if (!ranged) {
      if (before.size > LIMITS.fullReadBytes) {
        throw toolError("FILE_TOO_LARGE_TO_EDIT", `File is ${before.size} bytes; full reads are limited to ${LIMITS.fullReadBytes}`, {
          path: resolved.relative, sizeBytes: before.size, limitBytes: LIMITS.fullReadBytes,
        });
      }
      const bytes = await handle.readFile();
      if (bytes.byteLength > LIMITS.fullReadBytes) {
        throw toolError("FILE_TOO_LARGE_TO_EDIT", `File grew beyond the ${LIMITS.fullReadBytes}-byte full-read limit`, {
          path: resolved.relative, limitBytes: LIMITS.fullReadBytes,
        });
      }
      const text = decodeUtf8(bytes, resolved.relative);
      return { mode: "full", path: resolved.relative, content: text, contentId: await workspace.contentId(bytes) };
    }

    return await readRange(resolved.relative, handle, before, args);
  } finally {
    await handle.close();
  }
}

async function readRange(
  relative: string,
  handle: FileHandle,
  before: Stats,
  args: ToolArgumentsMap["read_file"],
): Promise<ToolOutputMap["read_file"]> {
  const offset = Math.max(0, args.offset ?? 0);
  const startLine = offset + 1;
  const requestedLines = Math.min(args.limit ?? LIMITS.rangeReadLines, LIMITS.rangeReadLines);
  const requestedEnd = startLine + requestedLines - 1;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let content = "";
  let line = 1;
  let selectedLines = 0;
  let lineStart = 0;
  let currentLineHasData = false;
  let stopped = false;
  let truncated = (args.limit ?? LIMITS.rangeReadLines) > LIMITS.rangeReadLines;

  const consume = (text: string, final: boolean): void => {
    let cursor = 0;
    while (cursor < text.length) {
      const newline = text.indexOf("\n", cursor);
      const completesLine = newline >= 0;
      const end = completesLine ? newline + 1 : text.length;
      const piece = text.slice(cursor, end);
      currentLineHasData ||= piece.length > 0;
      const selected = line >= startLine && line <= requestedEnd;
      if (selected && !stopped) {
        if (selectedLines >= LIMITS.rangeReadLines) {
          stopped = true;
          truncated = true;
        } else if (Buffer.byteLength(content) + Buffer.byteLength(piece) > LIMITS.rangeReadBytes) {
          content = content.slice(0, lineStart);
          stopped = true;
          truncated = true;
        } else {
          content += piece;
        }
      }
      if (completesLine) {
        if (selected && !stopped) selectedLines += 1;
        line += 1;
        lineStart = content.length;
        currentLineHasData = false;
      }
      cursor = end;
    }
    if (final && currentLineHasData) {
      const selected = line >= startLine && line <= requestedEnd;
      if (selected && !stopped) selectedLines += 1;
    }
  };

  try {
    for await (const value of handle.createReadStream({ autoClose: false })) {
      const chunk = value as Buffer;
      consume(decoder.decode(chunk, { stream: true }), false);
    }
    consume(decoder.decode(), true);
  } catch (error) {
    if (error instanceof TypeError) throw toolError("BINARY_FILE", "File is not valid UTF-8 text", { path: relative });
    throw error;
  }
  const after = await handle.stat();
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
    throw toolError("FILE_CHANGED_DURING_READ", "File changed while it was being read", { path: relative });
  }
  return {
    mode: "range",
    path: relative,
    content,
    offset,
    linesRead: selectedLines,
    truncated,
  };
}

function decodeUtf8(bytes: Uint8Array, filePath: string): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw toolError("BINARY_FILE", "File is not valid UTF-8 text", { path: filePath }); }
}

function toolError(code: string, message: string, details?: Record<string, unknown>): Error {
  return Object.assign(new Error(message), { code, ...(details ? { details } : {}) });
}
