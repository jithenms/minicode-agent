import assert from "node:assert/strict";
import test from "node:test";
import { bashTail, ConsoleReporter, formatTool, type ReporterOutput } from "../../src/cli/reporter.js";
import type { ToolReportEvent } from "../../src/types.js";

test("successful tools render one concise deterministic header", () => {
  const events: ToolReportEvent[] = [
    { step: 1, tool: "list_files", status: "succeeded", durationMs: 1, pathCount: 84, truncated: false },
    { step: 2, tool: "search_text", status: "succeeded", durationMs: 1, query: "SidebarFooter", matchCount: 4, truncated: true },
    { step: 3, tool: "read_file", status: "succeeded", durationMs: 1, path: "src/app.ts", read: { mode: "full", linesRead: 62 } },
    { step: 4, tool: "read_file", status: "succeeded", durationMs: 1, path: "src/app.ts", read: { mode: "range", startLine: 21, linesRead: 10, truncated: true } },
    { step: 5, tool: "edit_file", status: "succeeded", durationMs: 1, path: "src/app.ts" },
    { step: 6, tool: "create_file", status: "succeeded", durationMs: 1, path: "src/new.ts" },
    { step: 7, tool: "inspect_changes", status: "succeeded", durationMs: 1, fileCount: 2, complete: false },
    {
      step: 8,
      tool: "bash",
      status: "succeeded",
      durationMs: 2_400,
      command: "npm run typecheck",
      exit: { kind: "code", code: 0 },
      stdout: { text: "", executionTruncated: false },
      stderr: { text: "", executionTruncated: false },
    },
  ];

  assert.deepEqual(events.map((event) => formatTool(event, 40)), [
    "[1/40] list_files — 84 paths",
    "[2/40] search_text \"SidebarFooter\" — 4 matches, truncated",
    "[3/40] read_file src/app.ts — full, 62 lines",
    "[4/40] read_file src/app.ts — range from line 21, 10 lines, truncated",
    "[5/40] edit_file src/app.ts",
    "[6/40] create_file src/new.ts",
    "[7/40] inspect_changes — 2 files, incomplete",
    "[8/40] bash `npm run typecheck` — exited 0 in 2.4s",
  ]);
});

test("recoverable failures show only projected recovery details", () => {
  const event: ToolReportEvent = {
    step: 10,
    tool: "search_text",
    status: "failed",
    durationMs: 0,
    code: "INVALID_PATH",
    message: "Path must identify an item inside the workspace.",
    recovery: [{ label: "Path", value: "../outside" }],
  };
  assert.equal(formatTool(event, 40), [
    "[10/40] search_text — failed: INVALID_PATH",
    "         Path must identify an item inside the workspace.",
    "         Path: ../outside",
  ].join("\n"));
});

test("bash reports execution and display truncation independently and strips terminal controls", () => {
  const noisy = `\u001b[31mred\u001b[0m\u0000 hash-0123456789abcdef\n${Array.from({ length: 101 }, (_, index) => `line-${index}`).join("\n")}`;
  const event: ToolReportEvent = {
    step: 11,
    tool: "bash",
    status: "succeeded",
    durationMs: 12,
    command: "npm test",
    exit: { kind: "code", code: 0 },
    stdout: { text: noisy, executionTruncated: true },
    stderr: { text: "", executionTruncated: false },
  };
  const output = formatTool(event, 40);
  assert.match(output, /execution output truncated; final 64 KiB retained/);
  assert.match(output, /display truncated; final 8 KiB \/ 100 lines shown/);
  assert.doesNotMatch(output, /\u001b|\u0000|red/);
  assert.match(output, /hash-0123456789abcdef|line-100/);
});

test("bash display tail enforces the byte limit independently", () => {
  const result = bashTail(`prefix-${"x".repeat(9 * 1024)}`);
  assert.equal(result.displayTruncated, true);
  assert.ok(Buffer.byteLength(result.text) <= 8 * 1024);
  assert.match(result.text, /x+$/);
});

test("bash output removes terminal controls without redacting ordinary hashes", () => {
  const result = bashTail("\u001b[31mred\u001b[0m\u0000 hash-0123456789abcdef\rnext");
  assert.equal(result.text, "red hash-0123456789abcdef\nnext");
  assert.equal(result.displayTruncated, false);
});

test("reporter renders rejection, completion evidence, failures, and cancellation", () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const output: ReporterOutput = { stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text) };
  const reporter = new ConsoleReporter(40, output);

  reporter.completionRejected(9, ["src/app.ts lacks a fresh inspection"]);
  reporter.completed({
    status: "completed",
    summary: "Added the requested behavior.",
    changedFiles: [{ path: "src/app.ts", status: "M" }, { path: "src/new.ts", status: "A" }],
    verification: { command: "npm run typecheck" },
    steps: 10,
  });
  reporter.failed({ status: "failed", reason: "bash changed the workspace", affectedPaths: ["generated.txt"], steps: 3 });
  reporter.cancelled();

  assert.equal(stdout[0], "[9/40] completion rejected\n         src/app.ts lacks a fresh inspection");
  assert.equal(stdout[1], [
    "Changed files:",
    "  M src/app.ts",
    "  A src/new.ts",
    "",
    "Verification:",
    "  `npm run typecheck` — passed",
    "",
    "Done:",
    "  Added the requested behavior.",
  ].join("\n"));
  assert.deepEqual(stderr, ["Run failed: bash changed the workspace\n  generated.txt", "Run cancelled."]);
});

test("inline previews escape controls and remain bounded", () => {
  const event: ToolReportEvent = {
    step: 1,
    tool: "search_text",
    status: "succeeded",
    durationMs: 1,
    query: `${"q".repeat(90)}\nnext`,
    matchCount: 1,
    truncated: false,
  };
  const output = formatTool(event, 40);
  assert.equal(output.split("\n").length, 1);
  assert.match(output, /…" — 1 match$/);
});
