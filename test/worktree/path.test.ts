import assert from "node:assert/strict";
import test from "node:test";
import { normalizeWorkspacePath } from "../../src/worktree/path.js";

test("workspace paths canonicalize POSIX syntax without changing Unicode or case", () => {
  assert.equal(normalizeWorkspacePath("src/./nested/../Value.ts"), "src/Value.ts");
  const decomposed = "src/Cafe\u0301.ts";
  assert.equal(normalizeWorkspacePath(decomposed), decomposed);
  assert.notEqual(normalizeWorkspacePath(decomposed), "src/Caf\u00e9.ts");
});

test("workspace paths reject backslashes and unsafe targets", () => {
  for (const value of ["dir\\file.ts", "", ".", "../file.ts", "/file.ts", ".git/config", "src/../../file.ts"]) {
    assert.throws(() => normalizeWorkspacePath(value), (error: unknown) => (error as { code?: string }).code === "INVALID_PATH");
  }
});
