import { execFile, spawn } from "node:child_process";
import { copyFile, lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { GitStatusEntry, WorkspaceBaseline } from "../types.js";
import { normalizeWorkspacePath } from "./path.js";

const execFileAsync = promisify(execFile);

interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface CommandFingerprint {
  head: string | null;
  status: Record<string, string>;
  contentIds: Record<string, string | null>;
  savedIndexPath?: string;
  tempDir: string;
}

export class GitWorkspace {
  private constructor(public readonly baseline: WorkspaceBaseline) {}

  static async open(cwd: string): Promise<GitWorkspace> {
    const root = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
    if (root.code !== 0) throw new Error("Target directory is not inside a Git worktree");
    const gitRoot = await realpath(root.stdout.trim());
    const head = await runGit(gitRoot, ["rev-parse", "--verify", "HEAD"]);
    const headCommit = head.code === 0 ? head.stdout.trim() : null;
    const initialStatus = await statusMap(gitRoot);
    return new GitWorkspace({ gitRoot, headCommit, initialStatus });
  }

  resolveRelative(input: string, mustExist = true): Promise<{ relative: string; absolute: string }> {
    return this.resolvePath(input, mustExist);
  }

  resolveForMutation(input: string, mustExist = true): Promise<{ relative: string; absolute: string }> {
    return this.resolvePath(input, mustExist, true);
  }

  private async resolvePath(input: string, mustExist: boolean, rejectSymlinks = false): Promise<{ relative: string; absolute: string }> {
    const relative = normalizeWorkspacePath(input);
    const absolute = path.join(this.baseline.gitRoot, relative);
    const checkedPath = mustExist ? absolute : path.dirname(absolute);
    const target = await realpath(checkedPath);
    if (!isInside(this.baseline.gitRoot, target)) {
      throw workspacePathError("PATH_OUTSIDE_WORKSPACE", "Resolved path escapes the workspace", relative);
    }
    if (rejectSymlinks && path.normalize(target) !== path.normalize(checkedPath)) {
      throw workspacePathError("SYMLINK_MUTATION_FORBIDDEN", "Mutation paths must not contain symbolic-link aliases", relative);
    }
    return { relative, absolute };
  }

  async head(): Promise<string | null> {
    const result = await runGit(this.baseline.gitRoot, ["rev-parse", "--verify", "HEAD"]);
    return result.code === 0 ? result.stdout.trim() : null;
  }

  async status(): Promise<GitStatusEntry[]> {
    return Object.entries(await statusMap(this.baseline.gitRoot)).map(([path, code]) => ({ path, code }));
  }

  async statusRecord(): Promise<Record<string, string>> {
    return statusMap(this.baseline.gitRoot);
  }

  async gitDiff(): Promise<string> {
    const unstaged = await runGit(this.baseline.gitRoot, ["diff", "--no-ext-diff", "--"]);
    const staged = await runGit(this.baseline.gitRoot, ["diff", "--cached", "--no-ext-diff", "--"]);
    return [staged.stdout, unstaged.stdout].filter(Boolean).join("\n");
  }

  async isIgnored(relativeInput: string): Promise<boolean> {
    const relative = normalizeWorkspacePath(relativeInput);
    const result = await runGit(this.baseline.gitRoot, ["check-ignore", "-q", "--", relative]);
    return result.code === 0;
  }

  async contentId(bytes: Uint8Array): Promise<string> {
    const result = await runGit(this.baseline.gitRoot, ["hash-object", "--stdin"], bytes);
    if (result.code !== 0) throw new Error(result.stderr || "git hash-object failed");
    return result.stdout.trim();
  }

  async currentContentId(relativeInput: string): Promise<string | null> {
    const relative = normalizeWorkspacePath(relativeInput);
    try {
      const resolved = await this.resolvePath(relative, false, true);
      const info = await lstat(resolved.absolute);
      if (!info.isFile()) return null;
      return this.contentId(await readFile(resolved.absolute));
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async proveStartupAbsent(relativeInput: string): Promise<{ relative: string; absolute: string }> {
    const resolved = await this.resolvePath(relativeInput, false, true);
    const relative = resolved.relative;
    if (this.baseline.initialStatus[relative]) throw new Error("Path appeared in startup Git status");
    if (this.baseline.headCommit) {
      const inHead = await runGit(this.baseline.gitRoot, ["cat-file", "-e", `${this.baseline.headCommit}:${relative}`]);
      if (inHead.code === 0) throw new Error("Path existed in startup HEAD");
    }
    const tracked = await runGit(this.baseline.gitRoot, ["ls-files", "--error-unmatch", "--", relative]);
    if (tracked.code === 0) throw new Error("Path is tracked by the index");
    const ignored = await runGit(this.baseline.gitRoot, ["check-ignore", "-q", "--", relative]);
    if (ignored.code === 0) throw new Error("Path is Git-ignored");
    try {
      await lstat(resolved.absolute);
      throw new Error("Path currently exists");
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    return resolved;
  }

  async captureCommandFingerprint(): Promise<CommandFingerprint> {
    const tempDir = await mkdtemp(path.join(tmpdir(), "minicode-agent-index-"));
    const status = await this.statusRecord();
    const contentIds: Record<string, string | null> = {};
    for (const relative of Object.keys(status)) contentIds[relative] = await this.currentContentId(relative);
    const indexResult = await runGit(this.baseline.gitRoot, ["rev-parse", "--git-path", "index"]);
    let savedIndexPath: string | undefined;
    if (indexResult.code === 0) {
      const source = path.resolve(this.baseline.gitRoot, indexResult.stdout.trim());
      savedIndexPath = path.join(tempDir, "index");
      try { await copyFile(source, savedIndexPath); } catch (error) { if (!isMissing(error)) throw error; savedIndexPath = undefined; }
    }
    return { head: await this.head(), status, contentIds, ...(savedIndexPath ? { savedIndexPath } : {}), tempDir };
  }

  async commandChanges(before: CommandFingerprint): Promise<string[]> {
    try {
      const afterStatus = await this.statusRecord();
      const affected = new Set<string>();
      if ((await this.head()) !== before.head) affected.add(".git/HEAD");
      const paths = new Set([...Object.keys(before.status), ...Object.keys(afterStatus)]);
      for (const relative of paths) {
        let beforeId: string | null | undefined = before.contentIds[relative];
        if (!(relative in before.contentIds)) beforeId = await this.preCommandId(relative, before, afterStatus);
        const afterId = await this.currentContentId(relative);
        if (beforeId !== afterId || before.status[relative] !== afterStatus[relative]) affected.add(relative);
      }
      return [...affected].sort();
    } finally {
      await rm(before.tempDir, { recursive: true, force: true });
    }
  }

  private async preCommandId(
    relative: string,
    before: CommandFingerprint,
    afterStatus: Record<string, string>,
  ): Promise<string | null> {
    if (before.savedIndexPath) {
      const result = await runGit(this.baseline.gitRoot, ["ls-files", "-s", "--", relative], undefined, {
        GIT_INDEX_FILE: before.savedIndexPath,
      });
      const match = /^\d+ ([0-9a-f]+) \d+\t/.exec(result.stdout);
      if (match?.[1]) return match[1];
    }
    if (before.head) {
      const result = await runGit(this.baseline.gitRoot, ["rev-parse", `${before.head}:${relative}`]);
      if (result.code === 0) return result.stdout.trim();
    }
    if (afterStatus[relative]?.includes("?")) return null;
    return null;
  }
}

async function statusMap(cwd: string): Promise<Record<string, string>> {
  const result = await runGit(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (result.code !== 0) throw new Error(result.stderr || "git status failed");
  const parts = result.stdout.split("\0");
  const status: Record<string, string> = {};
  for (let index = 0; index < parts.length; index += 1) {
    const item = parts[index];
    if (!item) continue;
    const code = item.slice(0, 2);
    const currentPath = item.slice(3);
    status[normalizeWorkspacePath(currentPath)] = code;
    if (code.includes("R") || code.includes("C")) {
      const otherPath = parts[index + 1];
      if (otherPath) { status[normalizeWorkspacePath(otherPath)] = code; index += 1; }
    }
  }
  return status;
}

async function runGit(
  cwd: string,
  args: string[],
  input?: Uint8Array,
  extraEnv?: Record<string, string>,
): Promise<GitResult> {
  if (input) {
    return new Promise((resolve) => {
      const child = spawn("git", args, {
        cwd,
        env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.on("error", (error) => resolve({ stdout: "", stderr: error.message, code: 1 }));
      child.on("close", (code) => resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        code: code ?? 1,
      }));
      child.stdin.end(input);
    });
  }
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      ...(extraEnv ? { env: { ...process.env, ...extraEnv } } : {}),
    });
    return { stdout: result.stdout, stderr: result.stderr, code: 0 };
  } catch (error) {
    const value = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number };
    return { stdout: value.stdout ?? "", stderr: value.stderr ?? value.message, code: typeof value.code === "number" ? value.code : 1 };
  }
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

function workspacePathError(code: string, message: string, relative: string): Error {
  return Object.assign(new Error(message), { code, details: { path: relative } });
}
