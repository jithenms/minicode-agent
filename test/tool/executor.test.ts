import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { GitWorkspace } from "../../src/worktree/git.js";
import { LocalToolExecutor } from "../../src/tool/executor.js";
import type { FileState } from "../../src/types.js";
import { createRepo } from "../fixture/repo.js";

test("full reads have only a 64 KiB limit and oversized reads fail", async () => {
  const manyLines = `${"x\n".repeat(10_000)}`;
  const root = await createRepo({ "many.txt": manyLines, "large.txt": "x".repeat(65_537) });
  const workspace = await GitWorkspace.open(root);
  const executor = await LocalToolExecutor.create(workspace, () => ({}));
  try {
    const many = await executor.execute({ name: "read_file", arguments: { path: "many.txt" } });
    assert.equal(many.status, "succeeded");
    if (many.status === "succeeded") assert.equal(many.output.mode, "full");
    const large = await executor.execute({ name: "read_file", arguments: { path: "large.txt" } });
    assert.equal(large.status, "failed");
    if (large.status === "failed") assert.equal(large.error.code, "FILE_TOO_LARGE_TO_EDIT");
  } finally {
    await executor.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("ranged reads are exploratory and bounded by 400 lines", async () => {
  const root = await createRepo({ "lines.txt": "line\n".repeat(500) });
  const workspace = await GitWorkspace.open(root);
  const executor = await LocalToolExecutor.create(workspace, () => ({}));
  try {
    const result = await executor.execute({ name: "read_file", arguments: { path: "lines.txt", offset: 0, limit: 500 } });
    assert.equal(result.status, "succeeded");
    if (result.status === "succeeded") {
      assert.equal(result.output.mode, "range");
      if (result.output.mode === "range") {
        assert.equal(result.output.offset, 0);
        assert.equal(result.output.linesRead, 400);
        assert.equal(result.output.truncated, true);
      }
    }
  } finally {
    await executor.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("ranged reads retain bounded output for files much larger than the range limit", async () => {
  const root = await createRepo({ "huge-line.txt": `${"x".repeat(2 * 1024 * 1024)}\n` });
  const workspace = await GitWorkspace.open(root);
  const executor = await LocalToolExecutor.create(workspace, () => ({}));
  try {
    const result = await executor.execute({ name: "read_file", arguments: { path: "huge-line.txt", offset: 0, limit: 1 } });
    assert.equal(result.status, "succeeded");
    if (result.status === "succeeded" && result.output.mode === "range") {
      assert.equal(result.output.content, "");
      assert.equal(result.output.truncated, true);
    }
  } finally {
    await executor.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("read offsets are zero-based line offsets", async () => {
  const root = await createRepo({ "lines.txt": "zero\none\ntwo\n" });
  const workspace = await GitWorkspace.open(root);
  const executor = await LocalToolExecutor.create(workspace, () => ({}));
  try {
    const result = await executor.execute({ name: "read_file", arguments: { path: "lines.txt", offset: 1, limit: 1 } });
    assert.equal(result.status, "succeeded");
    if (result.status === "succeeded" && result.output.mode === "range") {
      assert.equal(result.output.content, "one\n");
      assert.equal(result.output.offset, 1);
      assert.equal(result.output.linesRead, 1);
    }
  } finally {
    await executor.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("edit_file is self-contained and preserves its pre-edit content internally", async () => {
  const root = await createRepo({ "value.txt": "before\n" });
  const workspace = await GitWorkspace.open(root);
  const executor = await LocalToolExecutor.create(workspace, () => ({}));
  try {
    const result = await executor.execute({ name: "edit_file", arguments: { path: "value.txt", oldText: "before", newText: "after" } });
    assert.equal(result.status, "succeeded");
    if (result.status === "succeeded") {
      assert.equal(Buffer.from(result.output.beforeContent).toString("utf8"), "before\n");
      assert.equal(typeof result.output.beforeContentId, "string");
    }
    assert.equal(await readFile(path.join(root, "value.txt"), "utf8"), "after\n");
  } finally {
    await executor.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("self-contained edits retain exact-match and file-size safety", async () => {
  const root = await createRepo({
    "missing.txt": "current\n",
    "ambiguous.txt": "same same\n",
    "large.txt": "x".repeat(65_537),
  });
  const workspace = await GitWorkspace.open(root);
  const executor = await LocalToolExecutor.create(workspace, () => ({}));
  try {
    const missing = await executor.execute({ name: "edit_file", arguments: { path: "missing.txt", oldText: "absent", newText: "new" } });
    assert.equal(missing.status, "failed");
    if (missing.status === "failed") assert.equal(missing.error.code, "TEXT_NOT_FOUND");
    const ambiguous = await executor.execute({ name: "edit_file", arguments: { path: "ambiguous.txt", oldText: "same", newText: "new" } });
    assert.equal(ambiguous.status, "failed");
    if (ambiguous.status === "failed") assert.equal(ambiguous.error.code, "AMBIGUOUS_EDIT");
    const large = await executor.execute({ name: "edit_file", arguments: { path: "large.txt", oldText: "x", newText: "y" } });
    assert.equal(large.status, "failed");
    if (large.status === "failed") assert.equal(large.error.code, "FILE_TOO_LARGE_TO_EDIT");
  } finally {
    await executor.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("create_file proves startup absence and never replaces an untracked file", async () => {
  const root = await createRepo({ "tracked.txt": "tracked" });
  await writeFile(path.join(root, "user.txt"), "user work");
  const workspace = await GitWorkspace.open(root);
  const states: Record<string, FileState> = {};
  const executor = await LocalToolExecutor.create(workspace, () => states);
  try {
    const rejected = await executor.execute({ name: "create_file", arguments: { path: "user.txt", content: "agent" } });
    assert.equal(rejected.status, "failed");
    if (rejected.status === "failed") assert.equal(rejected.error.code, "PATH_NOT_ABSENT_AT_STARTUP");
    assert.equal(await readFile(path.join(root, "user.txt"), "utf8"), "user work");
    const created = await executor.execute({ name: "create_file", arguments: { path: "new.txt", content: "new" } });
    assert.equal(created.status, "succeeded");
    if (created.status === "succeeded") assert.equal(typeof created.output.resultingContentId, "string");
  } finally {
    await executor.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("bash uses a reduced environment without credentials", async () => {
  const root = await createRepo({ "tracked.txt": "tracked" });
  const workspace = await GitWorkspace.open(root);
  const executor = await LocalToolExecutor.create(workspace, () => ({}));
  const oldKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "must-not-leak";
  try {
    const result = await executor.execute({ name: "bash", arguments: { command: "env" } });
    assert.equal(result.status, "succeeded");
    if (result.status === "succeeded") {
      assert.doesNotMatch(result.output.stdout, /OPENAI_API_KEY/);
      assert.doesNotMatch(result.output.stdout, /must-not-leak/);
    }
  } finally {
    if (oldKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = oldKey;
    await executor.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("bash cancels its Unix process group", async () => {
  const root = await createRepo({ "tracked.txt": "tracked" });
  const workspace = await GitWorkspace.open(root);
  const controller = new AbortController();
  const executor = await LocalToolExecutor.create(workspace, () => ({}), controller.signal);
  try {
    const running = executor.execute({
      name: "bash",
      arguments: { command: "sleep 10 & wait" },
    });
    setTimeout(() => controller.abort(), 50);
    const result = await running;
    assert.equal(result.status, "cancelled");
  } finally {
    await executor.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("a pre-aborted bash call never spawns the child", async () => {
  const root = await createRepo({ "tracked.txt": "tracked" });
  const workspace = await GitWorkspace.open(root);
  const controller = new AbortController();
  controller.abort();
  const executor = await LocalToolExecutor.create(workspace, () => ({}), controller.signal);
  try {
    const result = await executor.execute({
      name: "bash",
      arguments: { command: "touch should-not-exist.txt" },
    });
    assert.equal(result.status, "cancelled");
    await assert.rejects(access(path.join(root, "should-not-exist.txt")));
  } finally {
    await executor.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("edit_file rejects file symlinks and create_file rejects symlinked parents", async () => {
  const root = await createRepo({ "target.txt": "before\n" });
  await symlink("target.txt", path.join(root, "alias.txt"));
  await mkdir(path.join(root, "real-dir"));
  await symlink("real-dir", path.join(root, "alias-dir"));
  const workspace = await GitWorkspace.open(root);
  const executor = await LocalToolExecutor.create(workspace, () => ({}));
  try {
    const read = await executor.execute({ name: "read_file", arguments: { path: "alias.txt" } });
    assert.equal(read.status, "succeeded");
    const edited = await executor.execute({
      name: "edit_file",
      arguments: { path: "alias.txt", oldText: "before", newText: "after" },
    });
    assert.equal(edited.status, "failed");
    assert.equal(await readFile(path.join(root, "target.txt"), "utf8"), "before\n");

    const created = await executor.execute({ name: "create_file", arguments: { path: "alias-dir/new.txt", content: "new" } });
    assert.equal(created.status, "failed");
    if (created.status === "failed") assert.equal(created.error.code, "PATH_NOT_ABSENT_AT_STARTUP");
    await assert.rejects(access(path.join(root, "real-dir", "new.txt")));
  } finally {
    await executor.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("create_file rejects a symlinked parent that escapes the workspace", async () => {
  const root = await createRepo({ "tracked.txt": "tracked" });
  const outside = await mkdtemp(path.join(tmpdir(), "minicode-agent-outside-"));
  await symlink(outside, path.join(root, "escape"));
  const workspace = await GitWorkspace.open(root);
  const executor = await LocalToolExecutor.create(workspace, () => ({}));
  try {
    const result = await executor.execute({ name: "create_file", arguments: { path: "escape/new.txt", content: "new" } });
    assert.equal(result.status, "failed");
    if (result.status === "failed") assert.equal(result.error.code, "PATH_NOT_ABSENT_AT_STARTUP");
    await assert.rejects(access(path.join(outside, "new.txt")));
  } finally {
    await executor.dispose();
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("bash reports nonzero exits with focused output details", async () => {
  const root = await createRepo({ "tracked.txt": "tracked" });
  const workspace = await GitWorkspace.open(root);
  const executor = await LocalToolExecutor.create(workspace, () => ({}));
  try {
    const result = await executor.execute({ name: "bash", arguments: { command: "printf problem >&2; exit 7" } });
    assert.equal(result.status, "failed");
    if (result.status === "failed") {
      assert.equal(result.error.code, "BASH_EXIT_NONZERO");
      assert.equal(result.error.details?.exitCode, 7);
      assert.equal(result.error.details?.stderr, "problem");
      assert.equal(result.error.details?.stderrTruncated, false);
    }
  } finally {
    await executor.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
