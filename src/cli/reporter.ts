import type { GitStatusEntry, RunResult, ToolReportEvent } from "../types.js";

const INLINE = { query: 80, command: 160, path: 200, detail: 240 } as const;
const BASH_DISPLAY_BYTES = 8 * 1024;
const BASH_DISPLAY_LINES = 100;
const CONTINUATION = "         ";

export interface ReporterOutput {
  stdout(text: string): void;
  stderr(text: string): void;
}

const consoleOutput: ReporterOutput = {
  stdout: (text) => console.log(text),
  stderr: (text) => console.error(text),
};

type CompletedRun = Extract<RunResult, { status: "completed" }>;
type FailedRun = Extract<RunResult, { status: "failed" }>;

export class ConsoleReporter {
  constructor(
    private readonly maxSteps: number,
    private readonly output: ReporterOutput = consoleOutput,
  ) {}

  preExisting(entries: GitStatusEntry[]): void {
    if (!entries.length) return;
    const lines = ["Pre-existing changes:"];
    for (const entry of [...entries].sort((left, right) => left.path.localeCompare(right.path))) {
      lines.push(`  ${inline(entry.code, 2)} ${pathPreview(entry.path)}`);
    }
    this.output.stdout(lines.join("\n"));
  }

  tool(event: ToolReportEvent): void {
    this.output.stdout(formatTool(event, this.maxSteps));
  }

  completionRejected(step: number, reasons: string[]): void {
    const lines = [`[${step}/${this.maxSteps}] completion rejected`];
    for (const reason of reasons) lines.push(`${CONTINUATION}${inline(reason, INLINE.detail)}`);
    this.output.stdout(lines.join("\n"));
  }

  completed(result: CompletedRun): void {
    const lines = ["Changed files:"];
    for (const file of result.changedFiles) lines.push(`  ${file.status} ${pathPreview(file.path)}`);
    lines.push("", "Verification:", `  ${commandPreview(result.verification.command)} — passed`, "", "Done:");
    for (const line of safeMultiline(result.summary).split("\n")) lines.push(`  ${line}`);
    this.output.stdout(lines.join("\n"));
  }

  failed(result: FailedRun): void {
    const lines = [`Run failed: ${inline(result.reason, INLINE.detail)}`];
    for (const path of result.affectedPaths ?? []) lines.push(`  ${pathPreview(path)}`);
    this.output.stderr(lines.join("\n"));
  }

  cancelled(): void {
    this.output.stderr("Run cancelled.");
  }
}

export function formatTool(event: ToolReportEvent, maxSteps: number): string {
  const prefix = `[${event.step}/${maxSteps}]`;
  if (event.status === "cancelled") {
    return `${prefix} ${event.tool} — cancelled in ${duration(event.durationMs)}`;
  }
  if (event.status === "failed") return formatFailure(prefix, event);

  switch (event.tool) {
    case "list_files":
      return `${prefix} list_files — ${count(event.pathCount, "path")}${event.truncated ? ", truncated" : ""}`;
    case "search_text":
      return `${prefix} search_text ${queryPreview(event.query)} — ${count(event.matchCount, "match", "matches")}${event.truncated ? ", truncated" : ""}`;
    case "read_file":
      if (event.read.mode === "full") {
        return `${prefix} read_file ${pathPreview(event.path)} — full, ${count(event.read.linesRead, "line")}`;
      }
      return `${prefix} read_file ${pathPreview(event.path)} — range from line ${event.read.startLine}, ${count(event.read.linesRead, "line")}${event.read.truncated ? ", truncated" : ""}`;
    case "edit_file": return `${prefix} edit_file ${pathPreview(event.path)}`;
    case "create_file": return `${prefix} create_file ${pathPreview(event.path)}`;
    case "inspect_changes": return `${prefix} inspect_changes — ${count(event.fileCount, "file")}, ${event.complete ? "complete" : "incomplete"}`;
    case "bash": {
      const lines = [`${prefix} bash ${commandPreview(event.command)} — ${exitText(event.exit)} in ${duration(event.durationMs)}`];
      appendBashStream(lines, "stdout", event.stdout);
      appendBashStream(lines, "stderr", event.stderr);
      return lines.join("\n");
    }
  }
}

function formatFailure(prefix: string, event: Extract<ToolReportEvent, { status: "failed" }>): string {
  const subject = event.tool === "bash" ? `bash ${commandPreview(event.command)}` : event.tool;
  const exit = event.tool === "bash" ? ` (${exitText(event.exit)} in ${duration(event.durationMs)})` : "";
  const lines = [`${prefix} ${subject} — failed: ${inline(event.code, INLINE.detail)}${exit}`];
  lines.push(`${CONTINUATION}${inline(event.message, INLINE.detail)}`);
  for (const detail of event.recovery) {
    lines.push(`${CONTINUATION}${inline(detail.label, INLINE.detail)}: ${inline(detail.value, INLINE.detail)}`);
  }
  if (event.tool === "bash") {
    appendBashStream(lines, "stdout", event.stdout);
    appendBashStream(lines, "stderr", event.stderr);
  }
  return lines.join("\n");
}

function appendBashStream(lines: string[], label: string, stream: { text: string; executionTruncated: boolean }): void {
  const displayed = bashTail(stream.text);
  if (!stream.executionTruncated && !displayed.displayTruncated && !displayed.text) return;
  lines.push(`${CONTINUATION}${label}:`);
  if (stream.executionTruncated) lines.push(`${CONTINUATION}  [execution output truncated; final 64 KiB retained]`);
  if (displayed.displayTruncated) lines.push(`${CONTINUATION}  [display truncated; final 8 KiB / 100 lines shown]`);
  if (displayed.text) {
    const outputLines = displayed.text.split("\n");
    if (outputLines.at(-1) === "") outputLines.pop();
    for (const line of outputLines) lines.push(`${CONTINUATION}  ${line}`);
  }
}

export function bashTail(value: string): { text: string; displayTruncated: boolean } {
  let text = safeMultiline(value);
  let displayTruncated = false;
  const lineParts = text.split("\n");
  if (lineParts.length > BASH_DISPLAY_LINES) {
    text = lineParts.slice(-BASH_DISPLAY_LINES).join("\n");
    displayTruncated = true;
  }
  const bytes = Buffer.from(text);
  if (bytes.length > BASH_DISPLAY_BYTES) {
    let start = bytes.length - BASH_DISPLAY_BYTES;
    while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1;
    text = bytes.subarray(start).toString("utf8");
    displayTruncated = true;
  }
  return { text, displayTruncated };
}

function safeMultiline(value: string): string {
  return value
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-_]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "");
}

function inline(value: string, limit: number): string {
  const escaped = value.replace(/[\x00-\x1f\x7f-\x9f]/g, (character) => {
    switch (character) {
      case "\n": return "\\n";
      case "\r": return "\\r";
      case "\t": return "\\t";
      case "\x1b": return "\\e";
      default: return `\\x${character.charCodeAt(0).toString(16).padStart(2, "0")}`;
    }
  });
  return endEllipsis(escaped, limit);
}

function pathPreview(value: string): string {
  const escaped = inline(value, Number.MAX_SAFE_INTEGER);
  const points = [...escaped];
  if (points.length <= INLINE.path) return escaped;
  const left = Math.ceil((INLINE.path - 1) / 2);
  const right = Math.floor((INLINE.path - 1) / 2);
  return `${points.slice(0, left).join("")}…${points.slice(-right).join("")}`;
}

function queryPreview(value: string): string {
  return `"${inline(value, INLINE.query).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function commandPreview(value: string): string {
  return `\`${inline(value, INLINE.command).replaceAll("`", "\\`")}\``;
}

function endEllipsis(value: string, limit: number): string {
  const points = [...value];
  if (points.length <= limit) return value;
  return `${points.slice(0, Math.max(0, limit - 1)).join("")}…`;
}

function count(value: number, noun: string, plural = `${noun}s`): string {
  return `${value} ${value === 1 ? noun : plural}`;
}

function duration(milliseconds: number): string {
  return milliseconds < 1_000 ? `${milliseconds}ms` : `${(milliseconds / 1_000).toFixed(1)}s`;
}

function exitText(exit: { kind: "code"; code: number } | { kind: "signal"; signal: string } | { kind: "unknown" }): string {
  if (exit.kind === "code") return `exited ${exit.code}`;
  if (exit.kind === "signal") return `signalled ${inline(exit.signal, INLINE.detail)}`;
  return "exit unknown";
}
