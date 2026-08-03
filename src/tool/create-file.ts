import { constants } from "node:fs";
import { access, link, unlink, writeFile } from "node:fs/promises";
import type { ToolArgumentsMap, ToolOutputMap } from "../types.js";
import { LIMITS } from "../types.js";
import type { GitWorkspace } from "../worktree/git.js";

export async function createFile(
  workspace: GitWorkspace,
  args: ToolArgumentsMap["create_file"],
): Promise<ToolOutputMap["create_file"]> {
  if (Buffer.byteLength(args.content) > LIMITS.createBytes) {
    throw toolError("ARGUMENT_TOO_LARGE", `content exceeds ${LIMITS.createBytes} bytes`, {
      field: "content", sizeBytes: Buffer.byteLength(args.content), limitBytes: LIMITS.createBytes,
    });
  }
  let resolved;
  try {
    resolved = await workspace.proveStartupAbsent(args.path);
  } catch (error) {
    const failure = error as Error & { code?: string };
    throw toolError("PATH_NOT_ABSENT_AT_STARTUP", failure.message, { path: args.path, ...(failure.code ? { cause: failure.code } : {}) });
  }
  const bytes = Buffer.from(args.content, "utf8");
  const temp = `${resolved.absolute}.minicode-agent-${process.pid}-${crypto.randomUUID()}`;
  try {
    await writeFile(temp, bytes, { flag: "wx" });
    await access(resolved.absolute, constants.F_OK).then(
      () => { throw toolError("PATH_NOT_ABSENT_AT_STARTUP", "Path appeared before exclusive creation", { path: resolved.relative }); },
      () => undefined,
    );
    await link(temp, resolved.absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw toolError("PATH_NOT_ABSENT_AT_STARTUP", "Path already exists", { path: resolved.relative });
    throw error;
  } finally {
    await unlink(temp).catch(() => undefined);
  }
  return { path: resolved.relative, resultingContentId: await workspace.contentId(bytes) };
}

function toolError(code: string, message: string, details?: Record<string, unknown>): Error {
  return Object.assign(new Error(message), { code, ...(details ? { details } : {}) });
}
