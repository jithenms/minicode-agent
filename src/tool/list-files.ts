import { spawn } from "node:child_process";
import type { ToolArgumentsMap, ToolOutputMap } from "../types.js";
import { LIMITS } from "../types.js";
import type { GitWorkspace } from "../worktree/git.js";
import { normalizeWorkspacePath } from "../worktree/path.js";

export async function listFiles(
  workspace: GitWorkspace,
  args: ToolArgumentsMap["list_files"],
  internalPath?: string,
): Promise<ToolOutputMap["list_files"]> {
  const prefix = internalPath === undefined ? "." : normalizeWorkspacePath(internalPath);
  const result = await captureGit(workspace.baseline.gitRoot, ["ls-files", "-co", "--exclude-standard", "--", prefix]);
  if (result.exitCode !== 0) throw toolError("GIT_ERROR", result.stderr || "git ls-files failed");
  let paths = result.stdout.split("\n").filter(Boolean).map(normalizeWorkspacePath).filter((item) => !isExcluded(item));
  if (args.glob) paths = paths.filter((item) => simpleGlob(item, args.glob!));
  paths.sort();
  return { paths: paths.slice(0, LIMITS.fileList), truncated: paths.length > LIMITS.fileList };
}

async function captureGit(cwd: string, args: string[]): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = new TailBuffer(4 * 1024 * 1024);
    const stderr = new TailBuffer(4 * 1024 * 1024);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({ exitCode, stdout: stdout.text(), stderr: stderr.text() }));
  });
}

class TailBuffer {
  private chunks: Buffer[] = [];
  private total = 0;
  constructor(private readonly limit: number) {}
  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.total += chunk.length;
    while (this.total > this.limit && this.chunks.length) {
      const first = this.chunks[0]!;
      const excess = this.total - this.limit;
      if (first.length <= excess) { this.chunks.shift(); this.total -= first.length; }
      else { this.chunks[0] = first.subarray(excess); this.total -= excess; }
    }
  }
  text(): string { return Buffer.concat(this.chunks).toString("utf8"); }
}

function isExcluded(value: string): boolean {
  return value.split("/").some((part) => [".git", "node_modules", "dist", "build", "target", ".next"].includes(part));
}

function simpleGlob(value: string, glob: string): boolean {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("**", "\u0000").replaceAll("*", "[^/]*").replaceAll("\u0000", ".*").replaceAll("?", ".");
  return new RegExp(`^${escaped}$`).test(value);
}

function toolError(code: string, message: string, details?: Record<string, unknown>): Error {
  return Object.assign(new Error(message), { code, ...(details ? { details } : {}) });
}
