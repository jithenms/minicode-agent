import path from "node:path";

export function normalizeWorkspacePath(input: string): string {
  if (typeof input !== "string" || input.length === 0) {
    throw pathError("Path must be a non-empty workspace-relative path", { path: input });
  }
  if (input.includes("\\")) {
    throw pathError("Workspace paths must use '/' separators; backslashes are not accepted", { path: input });
  }
  if (path.posix.isAbsolute(input)) {
    throw pathError("Path must be workspace-relative", { path: input });
  }
  const normalized = path.posix.normalize(input);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw pathError("Path must identify an item inside the workspace", { path: input });
  }
  if (normalized === ".git" || normalized.startsWith(".git/")) {
    throw pathError("Git metadata cannot be accessed", { path: input });
  }
  return normalized;
}

function pathError(message: string, details: Record<string, unknown>): Error {
  return Object.assign(new Error(message), { code: "INVALID_PATH", details });
}
