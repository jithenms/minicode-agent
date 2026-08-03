import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ToolArgumentsMap, ToolOutputMap } from "../types.js";
import { LIMITS } from "../types.js";
import type { GitWorkspace } from "../worktree/git.js";

export async function runBash(
  workspace: GitWorkspace,
  args: ToolArgumentsMap["bash"],
  runHome: string,
  signal?: AbortSignal,
): Promise<ToolOutputMap["bash"]> {
  if (typeof args.command !== "string" || !args.command.trim()) {
    throw toolError("INVALID_ARGUMENT", "command must not be empty", { field: "command" });
  }
  if (signal?.aborted) throw toolError("CANCELLED", "Bash command cancelled before execution");
  const result = await spawnCapture(args.command, {
    cwd: workspace.baseline.gitRoot,
    limit: LIMITS.commandStreamBytes,
    env: reducedEnvironment(runHome),
    ...(signal ? { signal } : {}),
  });
  if (result.exitCode !== 0 || result.signal !== null) {
    throw toolError("BASH_EXIT_NONZERO", "Bash command did not exit successfully", {
      command: args.command,
      exitCode: result.exitCode,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
      stdoutTruncated: result.stdoutTruncated,
      stderrTruncated: result.stderrTruncated,
    });
  }
  return { ...result, exitCode: 0, signal: null };
}

interface CaptureOptions {
  cwd: string;
  limit: number;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

interface CaptureResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

async function spawnCapture(command: string, options: CaptureOptions): Promise<CaptureResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/bash", ["-lc", command], {
      cwd: options.cwd,
      shell: false,
      env: options.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = new TailBuffer(options.limit);
    const stderr = new TailBuffer(options.limit);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    let cancelled = false;
    const cancel = () => {
      cancelled = true;
      if (child.pid) {
        try { process.kill(-child.pid, "SIGTERM"); } catch { /* already exited */ }
        setTimeout(() => { try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* exited */ } }, 1_000).unref();
      }
    };
    options.signal?.addEventListener("abort", cancel, { once: true });
    if (options.signal?.aborted) cancel();
    child.on("error", reject);
    child.on("close", (exitCode, childSignal) => {
      options.signal?.removeEventListener("abort", cancel);
      if (cancelled) { reject(toolError("CANCELLED", "Bash command cancelled")); return; }
      resolve({
        exitCode,
        signal: childSignal as NodeJS.Signals | null,
        stdout: stdout.text(),
        stderr: stderr.text(),
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
      });
    });
  });
}

class TailBuffer {
  private chunks: Buffer[] = [];
  private total = 0;
  truncated = false;

  constructor(private readonly limit: number) {}

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.total += chunk.length;
    while (this.total > this.limit && this.chunks.length) {
      const first = this.chunks[0]!;
      const excess = this.total - this.limit;
      if (first.length <= excess) { this.chunks.shift(); this.total -= first.length; }
      else { this.chunks[0] = first.subarray(excess); this.total -= excess; }
      this.truncated = true;
    }
  }

  text(): string { return Buffer.concat(this.chunks).toString("utf8"); }
}

function reducedEnvironment(runHome: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: runHome,
    XDG_CONFIG_HOME: path.join(runHome, ".config"),
    XDG_CACHE_HOME: path.join(runHome, ".cache"),
    TMPDIR: tmpdir(),
  };
  for (const key of ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "COLORTERM"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

function toolError(code: string, message: string, details?: Record<string, unknown>): Error {
  return Object.assign(new Error(message), { code, ...(details ? { details } : {}) });
}
