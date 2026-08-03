export const LIMITS = {
  fileList: 500,
  searchMatches: 200,
  searchLineBytes: 500,
  fullReadBytes: 64 * 1024,
  rangeReadBytes: 64 * 1024,
  rangeReadLines: 400,
  commandStreamBytes: 64 * 1024,
  gitDiffBytes: 256 * 1024,
  agentDiffBytes: 64 * 1024,
  editStringBytes: 64 * 1024,
  createBytes: 64 * 1024,
} as const;

export type ToolName =
  | "list_files"
  | "search_text"
  | "read_file"
  | "edit_file"
  | "create_file"
  | "bash"
  | "inspect_changes";

export interface ToolArgumentsMap {
  list_files: { glob?: string };
  search_text: { query: string; path?: string; glob?: string; caseSensitive?: boolean };
  read_file: { path: string; offset?: number; limit?: number };
  edit_file: { path: string; oldText: string; newText: string };
  create_file: { path: string; content: string };
  bash: { command: string };
  inspect_changes: { paths?: string[] };
}

export interface SearchMatch {
  path: string;
  line: number;
  column: number;
  text: string;
}

export interface GitStatusEntry {
  code: string;
  path: string;
}

export type ReadFileOutput =
  | { mode: "full"; path: string; content: string; contentId: string }
  | {
      mode: "range";
      path: string;
      content: string;
      offset: number;
      linesRead: number;
      truncated: boolean;
    };

export interface InspectedFile {
  path: string;
  agentDiff: string;
  contentId: string;
  complete: boolean;
}

export interface ToolOutputMap {
  list_files: { paths: string[]; truncated: boolean };
  search_text: { matches: SearchMatch[]; truncated: boolean };
  read_file: ReadFileOutput;
  edit_file: {
    path: string;
    beforeContent: Uint8Array;
    beforeContentId: string;
    resultingContentId: string;
  };
  create_file: { path: string; resultingContentId: string };
  bash: {
    exitCode: 0;
    signal: null;
    stdout: string;
    stderr: string;
    stdoutTruncated: boolean;
    stderrTruncated: boolean;
  };
  inspect_changes: {
    gitStatus: GitStatusEntry[];
    gitDiff: string;
    gitDiffTruncated: boolean;
    files: InspectedFile[];
  };
}

export interface ToolRequest<N extends ToolName = ToolName> {
  name: N;
  arguments: ToolArgumentsMap[N];
}

export type ToolExecutionResult<T> =
  | { status: "succeeded"; output: T; durationMs: number }
  | {
      status: "failed";
      error: { code: string; message: string; details?: Record<string, unknown> };
      durationMs: number;
    }
  | { status: "cancelled"; durationMs: number };

export interface ToolEvent<N extends ToolName = ToolName> {
  eventId: number;
  step: number;
  request: ToolRequest<N>;
  result: ToolExecutionResult<ToolOutputMap[N]>;
}

export interface ToolReportBase<N extends ToolName, S extends ToolExecutionResult<unknown>["status"]> {
  step: number;
  tool: N;
  status: S;
  durationMs: number;
}

export interface BashReportStream {
  text: string;
  executionTruncated: boolean;
}

export type BashReportExit =
  | { kind: "code"; code: number }
  | { kind: "signal"; signal: string }
  | { kind: "unknown" };

export interface RecoveryDetail {
  label: string;
  value: string;
}

export type ToolReportEvent =
  | (ToolReportBase<"list_files", "succeeded"> & { pathCount: number; truncated: boolean })
  | (ToolReportBase<"search_text", "succeeded"> & { query: string; matchCount: number; truncated: boolean })
  | (ToolReportBase<"read_file", "succeeded"> & {
      path: string;
      read: { mode: "full"; linesRead: number } | { mode: "range"; startLine: number; linesRead: number; truncated: boolean };
    })
  | (ToolReportBase<"edit_file", "succeeded"> & { path: string })
  | (ToolReportBase<"create_file", "succeeded"> & { path: string })
  | (ToolReportBase<"inspect_changes", "succeeded"> & { fileCount: number; complete: boolean })
  | (ToolReportBase<"bash", "succeeded"> & {
      command: string;
      exit: BashReportExit;
      stdout: BashReportStream;
      stderr: BashReportStream;
    })
  | (ToolReportBase<Exclude<ToolName, "bash">, "failed"> & {
      code: string;
      message: string;
      recovery: RecoveryDetail[];
    })
  | (ToolReportBase<"bash", "failed"> & {
      command: string;
      code: string;
      message: string;
      exit: BashReportExit;
      recovery: RecoveryDetail[];
      stdout: BashReportStream;
      stderr: BashReportStream;
    })
  | (ToolReportBase<ToolName, "cancelled">);

export interface WorkspaceBaseline {
  gitRoot: string;
  headCommit: string | null;
  initialStatus: Record<string, string>;
}

export type FileBaseline =
  | { kind: "existing"; contentId: string; content: Uint8Array }
  | { kind: "absent" };

export interface FileState {
  baseline?: FileBaseline;
  latestMutationEventId?: number;
  latestInspection?: { eventId: number; contentId: string };
}

export interface RunState {
  task: string;
  workspace: WorkspaceBaseline;
  steps: number;
  toolEvents: ToolEvent[];
  files: Record<string, FileState>;
}

export type ModelTurn =
  | { kind: "tool_call"; tool: ToolName; arguments: unknown }
  | { kind: "complete"; summary: string };

export type ModelObservation =
  | { kind: "initial" }
  | { kind: "tool_result"; tool: ToolName; result: Record<string, unknown> }
  | { kind: "completion_rejected"; reasons: string[] };

export interface ModelTurnInput {
  task: string;
  workspaceRoot: string;
  systemPrompt: string;
  step: number;
  maxSteps: number;
  observation: ModelObservation;
}

export interface RunConfig {
  task: string;
  cwd: string;
  modelFamily?: string;
  maxSteps?: number;
  signal?: AbortSignal;
  onStep?: (step: number, maxSteps: number, tool: ToolName) => void;
  onTool?: (event: ToolReportEvent) => void;
  onPreExistingChanges?: (entries: GitStatusEntry[]) => void;
  onCompletionRejected?: (step: number, reasons: string[]) => void;
}

export interface ChangedFile {
  path: string;
  status: "M" | "A";
}

export type RunResult =
  | { status: "completed"; summary: string; changedFiles: ChangedFile[]; verification: { command: string }; steps: number }
  | { status: "failed"; reason: string; affectedPaths?: string[]; steps: number }
  | { status: "cancelled"; steps: number };

export interface ModelAdapter {
  runTurn(input: ModelTurnInput): Promise<ModelTurn>;
}

export interface ToolExecutor {
  execute<N extends ToolName>(
    request: ToolRequest<N>,
  ): Promise<ToolExecutionResult<ToolOutputMap[N]>>;
}
