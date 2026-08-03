import assert from "node:assert/strict";
import { access, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { CodingAgentRunner } from "../../src/agent/runner.js";
import type { ModelAdapter, ModelTurn, ModelTurnInput, ToolName, ToolReportEvent } from "../../src/types.js";
import { createRepo } from "../fixture/repo.js";

class SuccessfulModel implements ModelAdapter {
  async runTurn(input: ModelTurnInput): Promise<ModelTurn> {
    switch (input.step) {
      case 1: return tool("read_file", { path: "./value.ts" });
      case 2:
        assert.equal(input.observation.kind, "tool_result");
        if (input.observation.kind === "tool_result") {
          assert.equal(input.observation.tool, "read_file");
          assert.equal("contentId" in input.observation.result, false);
          assert.match(JSON.stringify(input.observation.result), /Read the full file value\.ts/);
        }
        return tool("edit_file", { path: "value.ts", oldText: "return 1", newText: "return 2" });
      case 3:
        assert.doesNotMatch(JSON.stringify(input.observation), /resultingContentId/);
        return tool("inspect_changes", {});
      case 4: return tool("bash", { command: "true" });
      default: return { kind: "complete", summary: "The function now returns two and Bash verification passed." };
    }
  }
}

test("runner completes with canonical paths, fresh inspection, and post-edit verification", async () => {
  const root = await createRepo({ "value.ts": "export function value() { return 1; }\n" });
  const events: ToolReportEvent[] = [];
  const steps: ToolName[] = [];
  try {
    const result = await new CodingAgentRunner(new SuccessfulModel()).run({
      task: "Return two",
      cwd: root,
      onTool: (event) => events.push(event),
      onStep: (_step, _max, toolName) => steps.push(toolName),
    });
    assert.deepEqual(result, {
      status: "completed",
      summary: "The function now returns two and Bash verification passed.",
      changedFiles: [{ path: "value.ts", status: "M" }],
      verification: { command: "true" },
      steps: 5,
    });
    assert.match(await readFile(path.join(root, "value.ts"), "utf8"), /return 2/);
    assert.deepEqual(steps, ["read_file", "edit_file", "inspect_changes", "bash"]);
    const mutation = events.find((event) => event.tool === "edit_file");
    assert.equal(mutation?.status, "succeeded");
    assert.deepEqual(mutation, { step: 2, tool: "edit_file", status: "succeeded", durationMs: mutation?.durationMs, path: "value.ts" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

class SelfContainedEditModel implements ModelAdapter {
  async runTurn(input: ModelTurnInput): Promise<ModelTurn> {
    if (input.step === 1) return tool("edit_file", { path: "value.ts", oldText: "return 1", newText: "return 2" });
    if (input.step === 2) return tool("inspect_changes", {});
    if (input.step === 3) return tool("bash", { command: "true" });
    return { kind: "complete", summary: "Edited value.ts directly and verified it." };
  }
}

test("edit_file does not require a preceding read and still captures an inspection baseline", async () => {
  const root = await createRepo({ "value.ts": "export function value() { return 1; }\n" });
  try {
    const result = await new CodingAgentRunner(new SelfContainedEditModel()).run({ task: "Return two", cwd: root });
    assert.equal(result.status, "completed");
    assert.match(await readFile(path.join(root, "value.ts"), "utf8"), /return 2/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

class CreateThenEditModel implements ModelAdapter {
  async runTurn(input: ModelTurnInput): Promise<ModelTurn> {
    if (input.step === 1) return tool("create_file", { path: "created.txt", content: "before\n" });
    if (input.step === 2) return tool("edit_file", { path: "created.txt", oldText: "before", newText: "after" });
    if (input.step === 3) return tool("inspect_changes", {});
    if (input.step === 4) return tool("bash", { command: "true" });
    return { kind: "complete", summary: "Created, revised, inspected, and verified created.txt." };
  }
}

test("a newly created file can be edited immediately", async () => {
  const root = await createRepo({ "tracked.txt": "tracked\n" });
  try {
    const result = await new CodingAgentRunner(new CreateThenEditModel()).run({ task: "Create a revised file", cwd: root });
    assert.deepEqual(result, {
      status: "completed",
      summary: "Created, revised, inspected, and verified created.txt.",
      changedFiles: [{ path: "created.txt", status: "A" }],
      verification: { command: "true" },
      steps: 5,
    });
    assert.equal(await readFile(path.join(root, "created.txt"), "utf8"), "after\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

class GateRetryModel implements ModelAdapter {
  async runTurn(input: ModelTurnInput): Promise<ModelTurn> {
    switch (input.step) {
      case 1: return { kind: "complete", summary: "Too early." };
      case 2: return tool("create_file", { path: "created.txt", content: "created\n" });
      case 3: return tool("inspect_changes", {});
      case 4: return tool("bash", { command: "true" });
      case 5: return tool("bash", { command: "printf verified" });
      default: return { kind: "complete", summary: "Created and verified the file." };
    }
  }
}

test("runner reports completion rejection and returns its exact latest qualifying verification", async () => {
  const root = await createRepo({ "tracked.txt": "tracked\n" });
  const rejections: Array<{ step: number; reasons: string[] }> = [];
  try {
    const result = await new CodingAgentRunner(new GateRetryModel()).run({
      task: "Create a file",
      cwd: root,
      onCompletionRejected: (step, reasons) => rejections.push({ step, reasons }),
    });
    assert.equal(rejections.length, 1);
    assert.equal(rejections[0]?.step, 1);
    assert.ok(rejections[0]?.reasons.includes("Current agent-relative change set is empty"));
    assert.deepEqual(result, {
      status: "completed",
      summary: "Created and verified the file.",
      changedFiles: [{ path: "created.txt", status: "A" }],
      verification: { command: "printf verified" },
      steps: 6,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

class FailingProviderModel implements ModelAdapter {
  async runTurn(): Promise<ModelTurn> {
    throw new Error("provider resp_secret call_secret");
  }
}

test("runner does not expose provider exception details in terminal failures", async () => {
  const root = await createRepo({ "tracked.txt": "tracked\n" });
  try {
    const result = await new CodingAgentRunner(new FailingProviderModel()).run({ task: "Fail safely", cwd: root });
    assert.deepEqual(result, { status: "failed", reason: "Model request failed", steps: 1 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

class MutatingBashModel implements ModelAdapter {
  async runTurn(): Promise<ModelTurn> {
    return tool("bash", { command: "touch generated.txt" });
  }
}

test("runner fails with affected paths when bash changes the workspace", async () => {
  const root = await createRepo({ "value.ts": "export const value = 1;\n" });
  try {
    const result = await new CodingAgentRunner(new MutatingBashModel()).run({ task: "Generate", cwd: root });
    assert.equal(result.status, "failed");
    if (result.status === "failed") assert.deepEqual(result.affectedPaths, ["generated.txt"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

class ExternalMutationModel extends SuccessfulModel {
  constructor(private readonly root: string, private readonly afterInspection: boolean) { super(); }

  override async runTurn(input: ModelTurnInput): Promise<ModelTurn> {
    if ((!this.afterInspection && input.step === 5) || (this.afterInspection && input.step === 4)) {
      await writeFile(path.join(this.root, "value.ts"), "external\n");
    }
    return super.runTurn(input);
  }
}

for (const afterInspection of [false, true]) {
  test(`completion detects external content ${afterInspection ? "after inspection" : "before completion"}`, async () => {
    const root = await createRepo({ "value.ts": "export function value() { return 1; }\n" });
    try {
      const result = await new CodingAgentRunner(new ExternalMutationModel(root, afterInspection)).run({ task: "Return two", cwd: root });
      assert.equal(result.status, "failed");
      if (result.status === "failed") {
        assert.equal(result.reason, "WORKSPACE_CHANGED_OUTSIDE_AGENT");
        assert.deepEqual(result.affectedPaths, ["value.ts"]);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

class RestoreModel implements ModelAdapter {
  async runTurn(input: ModelTurnInput): Promise<ModelTurn> {
    switch (input.step) {
      case 1: return tool("read_file", { path: "value.ts" });
      case 2: return tool("edit_file", { path: "value.ts", oldText: "return 1", newText: "return 2" });
      case 3: return tool("read_file", { path: "value.ts" });
      case 4: return tool("edit_file", { path: "value.ts", oldText: "return 2", newText: "return 1" });
      default: return { kind: "complete", summary: "Restored the original content." };
    }
  }
}

test("a restored file leaves the current change set", async () => {
  const original = "export function value() { return 1; }\n";
  const root = await createRepo({ "value.ts": original });
  try {
    const result = await new CodingAgentRunner(new RestoreModel()).run({ task: "No net change", cwd: root, maxSteps: 5 });
    assert.equal(result.status, "failed");
    assert.equal(await readFile(path.join(root, "value.ts"), "utf8"), original);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

class EndlessModel implements ModelAdapter {
  calls = 0;
  async runTurn(): Promise<ModelTurn> {
    this.calls += 1;
    return tool("list_files", {});
  }
}

class PromptCapturingModel implements ModelAdapter {
  readonly inputs: ModelTurnInput[] = [];

  async runTurn(input: ModelTurnInput): Promise<ModelTurn> {
    this.inputs.push(input);
    return tool("list_files", {});
  }
}

test("runner builds one immutable prompt from startup context", async () => {
  const root = await createRepo({ "value.ts": "export const value = 1;\n" });
  await writeFile(path.join(root, "value.ts"), "export const value = 2;\n");
  const model = new PromptCapturingModel();
  try {
    const result = await new CodingAgentRunner(model).run({ task: "Loop", cwd: root, maxSteps: 2 });
    assert.equal(result.status, "failed");
    assert.equal(model.inputs.length, 2);
    assert.equal(model.inputs[0]?.workspaceRoot, await realpath(root));
    assert.equal(model.inputs[0]?.systemPrompt, model.inputs[1]?.systemPrompt);
    assert.match(model.inputs[0]!.systemPrompt, /# Environment context/);
    assert.match(model.inputs[0]!.systemPrompt, /model family: "unknown"/);
    assert.match(model.inputs[0]!.systemPrompt, /working directory: ".+"/);
    assert.match(model.inputs[0]!.systemPrompt, /date: ".+"/);
    assert.match(model.inputs[0]!.systemPrompt, /platform: ".+"/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runner includes the configured model family in the prompt", async () => {
  const root = await createRepo({ "value.ts": "export const value = 1;\n" });
  const model = new PromptCapturingModel();
  try {
    const result = await new CodingAgentRunner(model).run({
      task: "Loop",
      cwd: root,
      modelFamily: "gpt-5.6-terra",
      maxSteps: 1,
    });
    assert.equal(result.status, "failed");
    assert.match(model.inputs[0]!.systemPrompt, /model family: "gpt-5\.6-terra"/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tool execution does not add steps and the runner never requests step 41", async () => {
  const root = await createRepo({ "value.ts": "export const value = 1;\n" });
  const model = new EndlessModel();
  try {
    const result = await new CodingAgentRunner(model).run({ task: "Loop", cwd: root, maxSteps: 40 });
    assert.equal(result.status, "failed");
    assert.equal(result.steps, 40);
    assert.equal(model.calls, 40);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

class DelayedToolModel implements ModelAdapter {
  constructor(private readonly controller: AbortController) {}
  async runTurn(): Promise<ModelTurn> {
    this.controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 30));
    return tool("bash", { command: "touch should-not-exist.txt" });
  }
}

test("cancellation during a model turn prevents its returned tool from executing", async () => {
  const root = await createRepo({ "value.ts": "export const value = 1;\n" });
  const controller = new AbortController();
  try {
    const result = await new CodingAgentRunner(new DelayedToolModel(controller)).run({ task: "Cancel", cwd: root, signal: controller.signal });
    assert.deepEqual(result, { status: "cancelled", steps: 1 });
    await assert.rejects(access(path.join(root, "should-not-exist.txt")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

class RepeatingFailureModel implements ModelAdapter {
  async runTurn(input: ModelTurnInput): Promise<ModelTurn> {
    if (input.step === 1) return tool("edit_file", { path: "value.ts", oldText: "missing", newText: "2" });
    if (input.step === 2) {
      assertToolFailure(input, "TEXT_NOT_FOUND");
      return tool("edit_file", { newText: "2", oldText: "missing", path: "value.ts" });
    }
    if (input.step === 3) {
      assertToolFailure(input, "REPEATED_FAILED_CALL");
      return tool("edit_file", { path: "value.ts", oldText: "1", newText: "2" });
    }
    if (input.step === 4) return tool("inspect_changes", {});
    if (input.step === 5) return tool("bash", { command: "true" });
    return { kind: "complete", summary: "Corrected the edit and verified it." };
  }
}

test("an immediately repeated failed edit is suppressed and corrected arguments can proceed", async () => {
  const root = await createRepo({ "value.ts": "export const value = 1;\n" });
  try {
    const result = await new CodingAgentRunner(new RepeatingFailureModel()).run({ task: "Update", cwd: root });
    assert.equal(result.status, "completed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function assertToolFailure(input: ModelTurnInput, code: string): void {
  assert.equal(input.observation.kind, "tool_result");
  if (input.observation.kind === "tool_result") {
    assert.equal(input.observation.result.status, "failed");
    assert.equal(input.observation.result.code, code);
  }
}

function tool(toolName: ToolName, argumentsValue: unknown): ModelTurn {
  return { kind: "tool_call", tool: toolName, arguments: argumentsValue };
}
