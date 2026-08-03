import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function createRepo(files: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "minicode-agent-test-"));
  await git(root, ["init", "-q"]);
  for (const [relative, content] of Object.entries(files)) await writeFile(path.join(root, relative), content);
  if (Object.keys(files).length) {
    await git(root, ["add", "."]);
    await git(root, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "initial"]);
  }
  return root;
}

export async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return result.stdout;
}
