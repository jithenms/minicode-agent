export const SYSTEM_PROMPT_DYNAMIC_BOUNDARY = "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__";

export interface AgentPromptContext {
  modelFamily: string;
  workingDirectory: string;
  date: string;
  platform: string;
}

export function buildAgentPrompt(context: AgentPromptContext): string {
  return [
    introSection(),
    taskSection(),
    actionSection(),
    SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
    environmentSection(context),
  ].filter((section) => section.trim()).join("\n\n");
}

function introSection(): string {
  return "You are an agent that helps users with software engineering tasks. Use the instructions below and the tools available to you to assist the user.";
}

function taskSection(): string {
  return `# Doing tasks
- read relevant code before changing it and keep changes tightly scoped to the request.
- do not add speculative abstractions, compatibility shims, or unrelated cleanup.
- do not create files unless they are required to complete the task.
- if an approach fails, diagnose the failure before switching tactics.
- be careful not to introduce security vulnerabilities such as command injection, XSS, or SQL injection.
- report outcomes faithfully: if verification fails or was not run, say so explicitly.`;
}

function actionSection(): string {
  return `# Executing actions with care
- carefully consider reversibility and blast radius. Local, reversible actions like editing files or running tests are usually fine. Actions that affect shared systems, publish state, delete data, or otherwise have high blast radius should be explicitly performed by the user.`;
}

function environmentSection(context: AgentPromptContext): string {
  return `# Environment context
- model family: ${quote(context.modelFamily)}
- working directory: ${quote(context.workingDirectory)}
- date: ${quote(context.date)}
- platform: ${quote(context.platform)}`;
}

function quote(value: string): string {
  return JSON.stringify(value);
}

