import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import { CodingAgentRunner } from "../../src/agent/runner.js";
import type { ModelAdapter, ModelTurn, ModelTurnInput } from "../../src/types.js";
import { createRepo } from "../fixture/repo.js";

class MutatingTrackedCommandModel implements ModelAdapter {
  async runTurn(_input: ModelTurnInput): Promise<ModelTurn> {
    return {
      kind: "tool_call",
      tool: "bash",
      arguments: { command: "printf changed > value.ts" },
    };
  }
}

test("post-command tracked paths derive their pre-state from the saved index", async () => {
  const root = await createRepo({ "value.ts": "original\n" });
  try {
    const result = await new CodingAgentRunner(new MutatingTrackedCommandModel()).run({ task: "Mutate", cwd: root });
    assert.equal(result.status, "failed");
    if (result.status === "failed") assert.deepEqual(result.affectedPaths, ["value.ts"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
