import assert from "node:assert/strict";
import test from "node:test";
import { toToolReportEvent } from "../../src/agent/tool-report.js";
import type { ToolEvent } from "../../src/types.js";

test("projection exposes read metadata without content or content IDs", () => {
  const report = toToolReportEvent({
    eventId: 17,
    step: 2,
    request: { name: "read_file", arguments: { path: "./value.ts" } },
    result: {
      status: "succeeded",
      durationMs: 4,
      output: { mode: "full", path: "value.ts", content: "one\ntwo\n", contentId: "internal-content-id" },
    },
  } as ToolEvent);

  assert.deepEqual(report, {
    step: 2,
    tool: "read_file",
    status: "succeeded",
    durationMs: 4,
    path: "value.ts",
    read: { mode: "full", linesRead: 2 },
  });
  assert.doesNotMatch(JSON.stringify(report), /internal-content-id|one|eventId|content/);
});

test("projection exposes edit path without edit strings, bytes, or IDs", () => {
  const report = toToolReportEvent({
    eventId: 18,
    step: 3,
    request: { name: "edit_file", arguments: { path: "value.ts", oldText: "secret-before", newText: "secret-after" } },
    result: {
      status: "succeeded",
      durationMs: 5,
      output: {
        path: "value.ts",
        beforeContent: Buffer.from("private-file-content"),
        beforeContentId: "before-id",
        resultingContentId: "after-id",
      },
    },
  } as ToolEvent);

  assert.deepEqual(report, { step: 3, tool: "edit_file", status: "succeeded", durationMs: 5, path: "value.ts" });
  assert.doesNotMatch(JSON.stringify(report), /secret|private|before-id|after-id|eventId/);
});

test("failure projection whitelists recovery fields and drops raw details", () => {
  const report = toToolReportEvent({
    eventId: 19,
    step: 4,
    request: { name: "edit_file", arguments: { path: "value.ts", oldText: "secret", newText: "replacement" } },
    result: {
      status: "failed",
      durationMs: 1,
      error: {
        code: "TEXT_NOT_FOUND",
        message: "oldText does not occur in the file",
        details: { path: "value.ts", occurrences: 0, content: "must-not-leak", arbitrary: { nested: true } },
      },
    },
  } as ToolEvent);

  assert.deepEqual(report, {
    step: 4,
    tool: "edit_file",
    status: "failed",
    durationMs: 1,
    code: "TEXT_NOT_FOUND",
    message: "oldText does not occur in the file",
    recovery: [{ label: "Path", value: "value.ts" }, { label: "Occurrences", value: "0" }],
  });
  assert.doesNotMatch(JSON.stringify(report), /must-not-leak|arbitrary|secret|eventId/);
});

test("bash failure projection has a dedicated exit and stream shape", () => {
  const report = toToolReportEvent({
    eventId: 20,
    step: 5,
    request: { name: "bash", arguments: { command: "npm test" } },
    result: {
      status: "failed",
      durationMs: 123,
      error: {
        code: "BASH_EXIT_NONZERO",
        message: "Bash command did not exit successfully",
        details: {
          command: "npm test",
          exitCode: 7,
          signal: null,
          stdout: "test output",
          stderr: "failure",
          stdoutTruncated: true,
          stderrTruncated: false,
          contentId: "must-not-leak",
        },
      },
    },
  } as ToolEvent);

  assert.deepEqual(report, {
    step: 5,
    tool: "bash",
    status: "failed",
    durationMs: 123,
    command: "npm test",
    code: "BASH_EXIT_NONZERO",
    message: "Bash command did not exit successfully",
    exit: { kind: "code", code: 7 },
    recovery: [],
    stdout: { text: "test output", executionTruncated: true },
    stderr: { text: "failure", executionTruncated: false },
  });
  assert.doesNotMatch(JSON.stringify(report), /contentId|must-not-leak|eventId/);
});
