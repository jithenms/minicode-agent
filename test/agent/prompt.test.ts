import assert from "node:assert/strict";
import test from "node:test";
import { buildAgentPrompt, SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from "../../src/agent/prompt.js";

test("prompt sections have a stable order around one dynamic boundary", () => {
  const prompt = buildAgentPrompt({
    modelFamily: "gpt-5.6-terra",
    workingDirectory: "/repo",
    date: "Sunday, August 2, 2026",
    platform: "darwin 25.0",
  });
  const sections = [
    "You are an agent that helps users with software engineering tasks",
    "# Doing tasks",
    "# Executing actions with care",
    SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
    "# Environment context",
  ];
  let previous = -1;
  for (const section of sections) {
    const index = prompt.indexOf(section);
    assert.ok(index > previous, `${section} should follow the previous section`);
    previous = index;
  }
  assert.equal(prompt.split(SYSTEM_PROMPT_DYNAMIC_BOUNDARY).length, 2);
  assert.match(prompt, /model family: "gpt-5\.6-terra"/);
  assert.match(prompt, /working directory: "\/repo"/);
  assert.match(prompt, /date: "Sunday, August 2, 2026"/);
  assert.match(prompt, /platform: "darwin 25\.0"/);
});

test("unusual working directory paths remain escaped data", () => {
  const prompt = buildAgentPrompt({
    modelFamily: "gpt-5.6-terra",
    workingDirectory: "/repo\nname",
    date: "Sunday, August 2, 2026",
    platform: "test-platform",
  });
  assert.match(prompt, /working directory: "\/repo\\nname"/);
  assert.doesNotMatch(prompt, /working directory: "\/repo\nname"/);
});
