export type {
  IdeEpisodeKind,
  SubjectStrategy,
  IdeCompanionConfig,
  ScannedWorkspaceFile,
  FileCategory,
  GitContext,
  WorkspaceScan,
  ProjectSummary,
  ChangedFile,
  DiagnosticRecord,
  IngestOutcome,
} from "./types.js";
export { IDE_EPISODE_KINDS } from "./types.js";

export { matchesGlob, matchesAnyGlob } from "./glob.js";

export {
  DEFAULT_IGNORE_DIRS,
  classifyFile,
  isIgnored,
  isArchitectureDoc,
  isDocLike,
} from "./classify.js";

export {
  parseGitRemote,
  workspaceSlug,
  sanitizeSubjectId,
  resolveSubject,
} from "./subject.js";
export type { ParsedRemote, ResolveSubjectInput } from "./subject.js";

export { readGitContext } from "./git.js";

export { scanWorkspace } from "./scan.js";
export type { ScanOptions } from "./scan.js";

export {
  buildProjectSummary,
  renderProjectSummaryText,
  fileTitle,
} from "./summary.js";

export {
  redactionOptionsFor,
  applyRedaction,
  redactText,
} from "./redaction.js";

export {
  workspaceIndexedEpisode,
  projectSummaryEpisode,
  gitContextEpisode,
  docsDetectedEpisode,
  architectureDetectedEpisode,
  fileChangedEpisode,
  diagnosticsReportedEpisode,
} from "./episodes.js";
export type { BaseMapInput, ArchitectureDocInput } from "./episodes.js";

export { resolveActiveClients, editorKind } from "./detect.js";
export type { ClientSignals, EditorKind } from "./detect.js";

export {
  buildAgentInstruction,
  wrapForClient,
  mergeMarkedBlock,
  AGENT_INSTRUCTION_TARGETS,
  STATEWAVE_BEGIN,
  STATEWAVE_END,
} from "./agent-instructions.js";
export type {
  InstructionMode,
  InstructionTarget,
  MarkedMergeResult,
} from "./agent-instructions.js";

export {
  docsContentEpisodes,
  gitHistoryEpisode,
  codeStructureEpisode,
} from "./enrich.js";
export type { GitCommit, CodeSymbol, CodeFileStructure } from "./enrich.js";

export { createIngestClient, ingestEpisodes, compileSubject } from "./ingest.js";
export type { CompileOutcome } from "./ingest.js";

export { runIngestQueue, CancellationFlag } from "./ingest-queue.js";
export type {
  IngestQueueOptions,
  IngestProgress,
  IngestQueueResult,
} from "./ingest-queue.js";

export { CompileScheduler } from "./compile-scheduler.js";
export type {
  CompileState,
  CompileReason,
  CompileSnapshot,
  CompileSchedulerOptions,
  Timers,
} from "./compile-scheduler.js";

export { deriveStatus } from "./status.js";
export type { StatusInputs, StatusModel, StatusKind, StatusPhase } from "./status.js";

export {
  emptyCache,
  diffScan,
  isCacheFresh,
  INDEX_CACHE_VERSION,
} from "./index-cache.js";
export type { IndexCacheData, ScanDiff } from "./index-cache.js";

export { explainPath, summarizeTransparency } from "./transparency.js";
export type { PathExplanation, TransparencyReport } from "./transparency.js";

export { diagnose } from "./diagnose.js";
export type { DiagnoseProbe, DiagnoseFinding, DiagnoseReport } from "./diagnose.js";

export { isSecretFile } from "./classify.js";

export {
  STATEWAVE_MCP_KEY,
  STATEWAVE_MCP_LABEL,
  buildStdioEntry,
  mergeMcpServersConfig,
  mergeCursorConfig,
  mergeVscodeMcpConfig,
  mergeClaudeProjectConfig,
  renderContinueYaml,
} from "./mcp-config.js";
export type { McpStdioEntry, MergeResult, ContinueYaml } from "./mcp-config.js";

// Re-export the core episode type so the extension can stay on a single
// import surface (`@statewavedev/ide-core`) without also depending on
// connectors-core directly.
export type { StatewaveEpisode } from "@statewavedev/connectors-core";
