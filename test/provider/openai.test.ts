import assert from "node:assert/strict";
import test from "node:test";
import { OpenAIModelAdapter, TOOL_DEFINITIONS } from "../../src/provider/openai.js";
import type { ModelTurnInput } from "../../src/types.js";

const TEST_SYSTEM_PROMPT = "test system prompt";

test("public tool schemas match the agent contract", () => {
  assert.deepEqual(TOOL_DEFINITIONS.map((tool) => ({
    name: tool.name,
    required: (tool.parameters as { required?: string[] }).required ?? [],
    properties: Object.keys((tool.parameters as { properties: Record<string, unknown> }).properties),
  })), [
    { name: "list_files", required: [], properties: ["glob"] },
    { name: "search_text", required: ["query"], properties: ["query", "path", "glob", "caseSensitive"] },
    { name: "read_file", required: ["path"], properties: ["path", "offset", "limit"] },
    { name: "edit_file", required: ["path", "oldText", "newText"], properties: ["path", "oldText", "newText"] },
    { name: "create_file", required: ["path", "content"], properties: ["path", "content"] },
    { name: "bash", required: ["command"], properties: ["command"] },
    { name: "inspect_changes", required: [], properties: ["paths"] },
  ]);
  assert.doesNotMatch(JSON.stringify(TOOL_DEFINITIONS), /rationale|expectedContentId|run_command|report_blocked/);
});

test("OpenAI adapter maps a function call to the minimal tool_call shape", async () => {
  const adapter = new OpenAIModelAdapter("test-key", "test-model");
  let captured: Record<string, unknown> | undefined;
  mockCreate(adapter, async (request) => {
    captured = request;
    return {
      id: "response-1",
      output_text: "ignored intermediate prose",
      output: [{ type: "function_call", call_id: "call-1", name: "read_file", arguments: '{"path":"src/a.ts"}' }],
    };
  });
  const turn = await adapter.runTurn(initialInput());
  assert.deepEqual(turn, { kind: "tool_call", tool: "read_file", arguments: { path: "src/a.ts" } });
  assert.equal(captured?.model, "test-model");
  assert.equal(captured?.parallel_tool_calls, false);
  assert.equal(captured?.instructions, TEST_SYSTEM_PROMPT);
  assert.equal(captured?.input, "Task: Fix it");
  assert.equal("previous_response_id" in (captured ?? {}), false);
});

test("OpenAI adapter accepts only a nonempty completion summary", async () => {
  const adapter = new OpenAIModelAdapter("test-key");
  mockCreate(adapter, async () => ({ id: "response-2", output_text: "  Task verified.  ", output: [] }));
  assert.deepEqual(await adapter.runTurn(initialInput()), { kind: "complete", summary: "Task verified." });

  mockCreate(adapter, async () => ({ id: "response-3", output_text: "  ", output: [] }));
  await assert.rejects(adapter.runTurn(initialInput()), /neither a function call nor a completion summary/);
});

test("OpenAI continuation metadata stays private and resets on an initial observation", async () => {
  const adapter = new OpenAIModelAdapter("test-key");
  const requests: Record<string, unknown>[] = [];
  let call = 0;
  mockCreate(adapter, async (request) => {
    requests.push(request);
    call += 1;
    if (call === 1 || call === 3) {
      return { id: `response-${call}`, output_text: "", output: [{ type: "function_call", call_id: `call-${call}`, name: "read_file", arguments: '{"path":"src/a.ts"}' }] };
    }
    return { id: "response-2", output_text: "Done", output: [] };
  });

  await adapter.runTurn(initialInput());
  await adapter.runTurn({
    ...initialInput(),
    step: 2,
    observation: {
      kind: "tool_result",
      tool: "read_file",
      result: { status: "succeeded", summary: "Read the full file src/a.ts", path: "src/a.ts", content: "export {};\n" },
    },
  });
  assert.equal(requests[1]?.previous_response_id, "response-1");
  assert.equal(requests[1]?.instructions, TEST_SYSTEM_PROMPT);
  const continuation = requests[1]?.input as Array<{ call_id: string; output: string }>;
  assert.equal(continuation[0]?.call_id, "call-1");
  const observation = JSON.parse(continuation[0]!.output) as Record<string, unknown>;
  assert.match(String(observation.summary), /Read the full file src\/a\.ts/);
  assert.equal("contentId" in observation, false);

  await adapter.runTurn(initialInput());
  assert.equal("previous_response_id" in requests[2]!, false);
});

function initialInput(): ModelTurnInput {
  return {
    task: "Fix it",
    workspaceRoot: "/repo",
    systemPrompt: TEST_SYSTEM_PROMPT,
    step: 1,
    maxSteps: 40,
    observation: { kind: "initial" },
  };
}

function mockCreate(
  adapter: OpenAIModelAdapter,
  create: (request: Record<string, unknown>) => Promise<unknown>,
): void {
  const target = adapter as unknown as { client: { responses: { create: typeof create } } };
  target.client.responses.create = create;
}
