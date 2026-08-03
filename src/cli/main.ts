#!/usr/bin/env node
import process from "node:process";
import { CodingAgentRunner } from "../agent/runner.js";
import { OpenAIModelAdapter } from "../provider/openai.js";
import { ConsoleReporter } from "./reporter.js";

const parsed = parseArgs(process.argv.slice(2));
if (!parsed.task) {
  console.error("Usage: minicode-agent <task> [--cwd PATH] [--model MODEL] [--max-steps N]");
  process.exitCode = 2;
} else if (!process.env.OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY is required");
  process.exitCode = 2;
} else {
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  const maxSteps = parsed.maxSteps ?? 40;
  const reporter = new ConsoleReporter(maxSteps);
  const modelName = parsed.model ?? process.env.OPENAI_MODEL ?? "gpt-5.6-terra";
  const model = new OpenAIModelAdapter(process.env.OPENAI_API_KEY, modelName);
  const runner = new CodingAgentRunner(model);
  const result = await runner.run({
    task: parsed.task,
    cwd: parsed.cwd ?? process.cwd(),
    modelFamily: modelName,
    maxSteps,
    signal: controller.signal,
    onPreExistingChanges: (entries) => reporter.preExisting(entries),
    onTool: (event) => reporter.tool(event),
    onCompletionRejected: (step, reasons) => reporter.completionRejected(step, reasons),
  });
  if (result.status === "completed") {
    reporter.completed(result);
    process.exitCode = 0;
  } else if (result.status === "cancelled") {
    reporter.cancelled();
    process.exitCode = 130;
  } else {
    reporter.failed(result);
    process.exitCode = result.steps === 0 ? 2 : 1;
  }
}

function parseArgs(args: string[]): { task?: string; cwd?: string; model?: string; maxSteps?: number } {
  const result: { task?: string; cwd?: string; model?: string; maxSteps?: number } = {};
  const task: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--cwd") {
      const value = args[++index];
      if (value) result.cwd = value;
    }
    else if (arg === "--model") {
      const value = args[++index];
      if (value) result.model = value;
    }
    else if (arg === "--max-steps") result.maxSteps = Number(args[++index]);
    else task.push(arg);
  }
  if (task.length) result.task = task.join(" ");
  if (result.maxSteps !== undefined && (!Number.isInteger(result.maxSteps) || result.maxSteps < 1)) delete result.maxSteps;
  return result;
}
