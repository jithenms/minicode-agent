import OpenAI from "openai";
import type { FunctionTool, ResponseInput } from "openai/resources/responses/responses.js";
import type { ModelAdapter, ModelTurn, ModelTurnInput, ToolName } from "../types.js";

export const TOOL_DEFINITIONS: FunctionTool[] = [
  functionTool("list_files", "List relevant non-ignored files from the workspace root.", {
    glob: { type: "string" },
  }),
  functionTool("search_text", "Search for literal text in workspace files.", {
    query: { type: "string" }, path: { type: "string" }, glob: { type: "string" }, caseSensitive: { type: "boolean" },
  }, ["query"]),
  functionTool("read_file", "Read a text file. Offset is a zero-based line offset and limit is the maximum number of lines.", {
    path: { type: "string" }, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1 },
  }, ["path"]),
  functionTool("edit_file", "Replace one exact, unique string in the current file.", {
    path: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" },
  }, ["path", "oldText", "newText"]),
  functionTool("create_file", "Atomically create a file proven absent at startup.", {
    path: { type: "string" }, content: { type: "string" },
  }, ["path", "content"]),
  functionTool("bash", "Run one non-mutating verification command through Bash from the workspace root.", {
    command: { type: "string" },
  }, ["command"]),
  functionTool("inspect_changes", "Inspect complete agent-relative diffs before completion.", {
    paths: { type: "array", items: { type: "string" } },
  }),
];

export class OpenAIModelAdapter implements ModelAdapter {
  private readonly client: OpenAI;
  private previousResponseId: string | undefined;
  private pendingCallId: string | undefined;

  constructor(
    apiKey: string,
    private readonly model = "gpt-5.6-terra",
  ) {
    this.client = new OpenAI({ apiKey });
  }

  async runTurn(input: ModelTurnInput): Promise<ModelTurn> {
    if (input.observation.kind === "initial") {
      this.previousResponseId = undefined;
      this.pendingCallId = undefined;
    }
    const requestInput = this.observationInput(input);
    const response = await this.client.responses.create({
      model: this.model,
      instructions: input.systemPrompt,
      input: requestInput,
      tools: TOOL_DEFINITIONS,
      parallel_tool_calls: false,
      ...(this.previousResponseId ? { previous_response_id: this.previousResponseId } : {}),
    });
    this.previousResponseId = response.id;
    const calls = response.output.filter((item: { type: string }) => item.type === "function_call") as Array<{
      type: "function_call";
      call_id: string;
      name: string;
      arguments: string;
    }>;
    if (calls.length > 1) throw new Error("Model response contained more than one function call");
    const call = calls[0];
    if (!call) {
      this.pendingCallId = undefined;
      const summary = response.output_text.trim();
      if (!summary) throw new Error("Model response contained neither a function call nor a completion summary");
      return { kind: "complete", summary };
    }
    if (!isToolName(call.name)) throw new Error(`Model requested unknown tool: ${call.name}`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(call.arguments);
    } catch {
      throw new Error(`Model supplied invalid JSON arguments for ${call.name}`);
    }
    this.pendingCallId = call.call_id;
    return { kind: "tool_call", tool: call.name, arguments: parsed };
  }

  private observationInput(input: ModelTurnInput): string | ResponseInput {
    if (input.observation.kind === "initial") {
      return `Task: ${input.task}`;
    }
    if (input.observation.kind === "completion_rejected") {
      return `Completion was rejected by objective checks:\n- ${input.observation.reasons.join("\n- ")}\nContinue using tools.`;
    }
    if (!this.pendingCallId) throw new Error("Missing function-call protocol state for tool result");
    const callId = this.pendingCallId;
    this.pendingCallId = undefined;
    return [{
      type: "function_call_output",
      call_id: callId,
      output: JSON.stringify(input.observation.result),
    }];
  }
}

function functionTool(name: string, description: string, properties: Record<string, unknown>, required: string[] = []): FunctionTool {
  return {
    type: "function",
    name,
    description,
    strict: false,
    parameters: { type: "object", properties, required, additionalProperties: false },
  };
}

function isToolName(value: string): value is ToolName {
  return ["list_files", "search_text", "read_file", "edit_file", "create_file", "bash", "inspect_changes"].includes(value);
}
