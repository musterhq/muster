#!/usr/bin/env node
import { printBanner, renderBanner } from "./banner.js";
import { buildCompactHeaderLines, createMusterAutocompleteProvider, createNarrationPainter, formatAssistantBlock, formatCostChip, formatStatusLine, formatToolLine, formatUserLine, formatWorkingIndicator, routeEngineLine, runMusterChatTui, workingVerbForFrame, type BoardModeController, type MusterChatSink, type MusterCompletionCatalog, type PickerOption, type ReasoningMode } from "./chat-tui.js";
import { startLiveDiffFeed } from "./live-diff.js";
import { LiveFileTurnAccumulator, renderLiveFilePlain } from "./live-file-view.js";
import {
  BACKEND_CARD_PROVIDERS,
  parseBoardCliCommand,
  parseOrchestrationInvocation,
  runOrchestrationCommand,
  openBoardStore,
  readBoardEvents,
  type BackendAuth,
  type MissionTaskRunInput,
  type MissionTaskRunResult,
  type OrchestrationDeps,
} from "./chat-orchestration.js";
import { commandUsageLines, trimDanglingCodeFence } from "./output.js";
import {
  buildCapabilityOverlayOptions,
  composerTextForCapabilityAction,
  encodeCapabilitySelection,
  parseCapabilityConfirmation,
} from "./capabilities-overlay.js";
import { hasCompletedMusterOnboarding, runMusterOnboardingTui } from "./onboarding-tui.js";
import { formatWorkspaceMismatchBanner, isParallelWorkPrompt, parallelTaskChoiceForKey, workspaceMismatchChoiceForKey, workspaceOverrideForMismatchChoice } from "./directory-awareness.js";
import { runFrappe2RealPromptsQa } from "./qa-frappe2.js";
import { runFrappeConnectCommand } from "./frappe-connect-command.js";
import { CHAT_COMMANDS, directPluginCommand, dynamicPluginCommands, type ChatCommandDef } from "./chat-command-catalog.js";
import { unknownShellCommandMessage, unknownSlashCommandMessage } from "./command-suggestion.js";
import { threadConflictCure } from "./thread-conflict.js";
import { composerPrefillForCapabilityMention, intentfulCapabilityMentions } from "./capability-mention.js";
import { runPtyTuiQa } from "./qa-pty-tui.js";
import {
  buildComposerCatalog,
  buildContinuityContext,
  effortDisplayLabel,
  formatModelStatus,
  modelDisplayLabel,
  modelProvider,
  parseEffortValue,
  readCodexComposerDefaults,
  type EffortValue,
  type ModelProvider,
} from "./model-catalog.js";
import { runServerDelegate, SERVER_USAGE_LINES } from "./server-delegate.js";
import { loadConfiguredGatewayPacks, startConfiguredFrappeIndexing } from "./gateway-registry.js";
import {
  openSessionStore,
  clearConversationSessionHandles,
  listSkills,
  viewSkill,
  promoteSkill,
  curateSkills,
  listPulses,
  addPulse,
  runDuePulses,
  resumePulse,
  listSubRuns,
  reapOrphans,
  spawnSubagent,
  runWasteBenchmark,
  renderWasteReport,
  adjudicateFeedback,
  addMemory,
  appendEpisode,
  buildPiSessionLabel,
  summarizePiEventTrace,
  appendFeedback,
  addOpenAICompatibleProvider,
  addCodexCliProvider,
  DEFAULT_CODEX_MODEL,
  enableBuiltinPlugin,
  enableBuiltinSkill,
  disableBuiltinPlugin,
  disableBuiltinSkill,
  buildCockpitState,
  buildEpisodeContextGraph,
  completeChat,
  configPath,
  ensureDefaultConfig,
  evalPath,
  retrievalEvalPath,
  findEpisode,
  flowPath,
  flowRunPath,
  getFlowRun,
  listFlowRuns,
  listFlows,
  loadFlow,
  parseFlow,
  preflightFlow,
  replayFlowRun,
  diffFlowRuns,
  scheduleFlowLoop,
  executeScheduledJob,
  resumeFlow,
  runFlow,
  saveFlow,
  inspectClaudeCode,
  inspectCapabilityPack,
  inspectCapabilityManifest,
  computeCapabilityEntrypointDigest,
  loadCapabilityPack,
  applyRosterActivationPlan,
  applyRosterMcpActivationPlan,
  buildRosterProjectionCatalog,
  buildRosterEntryFromPack,
  buildRosterIndexFromPacks,
  buildRosterSupportMatrix,
  installRosterCapability,
  materializeRosterCapability,
  planRosterBuiltinProjection,
  planRosterActivation,
  planRosterMcpActivation,
  planRosterLockProjection,
  rosterMcpConfigFromCatalogEntry,
  summarizeRosterIndex,
  summarizeRosterVerification,
  verifyRosterCapability,
  verifyRosterIndex,
  verifyRosterLock,
  verifyRosterLockedCapability,
  inspectPiCommands,
  inspectPiRuntime,
  inspectPiTools,
  listLearningCandidates,
  listEpisodes,
  listMemory,
  inspectMemoryStore,
  probeMemorySearchLatency,
  rebuildMemoryIndex,
  listBuiltinMcpServers,
  loadRosterIndex,
  resolveBuiltinCapabilityMentions,
  resolveBuiltinPluginPackPath,
  type BuiltinMcpCatalogEntry,
  type BuiltinCapabilityMention,
  type BuiltinSkillCatalogEntry,
  type BuiltinPluginCatalogEntry,
  type CapabilityReadinessLevel,
  type RosterCapabilityMetadata,
  mcpOAuthStatus,
  removeMcpOAuthToken,
  writeMcpOAuthToken,
  listPiModels,
  listBuiltinPlugins,
  listBuiltinSkills,
  appendGoalLoopTurn,
  buildGoalLoopTurn,
  promotedMemoryWrite,
  recentGoalLoopTurns,
  loadConfig,
  saveConfig,
  formatMemoryScope,
  parseMemoryScope,
  createHindsightClient,
  resolveHindsightConfig,
  HindsightConfigError,
  HINDSIGHT_URL_ENV,
  planRun,
  promoteMemory,
  runClaudeCode,
  runPiAgent,
  runPiInteractive,
  runEvalCases,
  runRetrievalEvalPathWithArtifacts,
  runRetrievalEvalPath,
  decideHybridRetrievalGate,
  seedFrappeGraphRetrievalEvalPack,
  seedRepresentativeRetrievalEvalPack,
  seedRetrievalEvalCase,
  listRetrievalEvalCases,
  scanMigrationSource,
  applyOpenclawProfile,
  seedEvalFromEpisode,
  searchMemory,
  searchMemoryWithReceipts,
  createToolRegistry,
  registerBuiltinTools,
  setRuntimeProvider,
  addPresetProvider,
  renderProviderPresets,
  inspectCodexRuntime,
  inspectProviderConfig,
  buildRuntimeMaturityScorecard,
  renderRuntimeMaturityScorecard,
  validateStrictReleaseEvidence,
  renderStrictReleaseValidation,
  loadRuntimeQaEvidence,
  qaEvidencePath,
  recordRuntimeQaSuiteEvidence,
  runMcpAuthFailureQa,
  runMemoryRetrievalSpeedQa,
  runPackReadinessQa,
  runProviderLatencyQa,
  runChannelPluginSetupQa,
  REQUIRED_QA_SUITES,
  type RequiredQaSuiteId,
  type RuntimeDoctorStatus,
  PROVIDER_PRESETS,
  executeRun,
  listTokenRecords,
  renderTokenTable,
  listSpans,
  readRosterLock,
  renderTracesTable,
  skillsIndexPath,
  activeProfile,
  dataDir,
  profileConfigPath,
  profileConfigWritePath,
  profileDataDir,
  profileHomeDir,
  profileWorkspaceDir,
  parseCron,
  cloneProfile,
  createProfile,
  listProfiles,
  useProfile,
  addSchedule,
  listSchedules,
  removeSchedule,
  runDueSchedules,
  loadEvolveSuite,
  evolve,
  renderEvolveReport,
  runHarnessChecks,
  verifyIntegrity,
  renderIntegrityReport,
  connectMcpServers,
  clearCodexAppServerSessions,
  clearCodexAppServerConversation,
  readGatewayCodexWarmThreadCount,
  interruptActiveCodexTurn,
  discoverCodexSessions,
  importCodexSession,
  matchCodexThread,
  orderCodexSessionsByLineage,
  resolveCodexForkChain,
  summarizeCodexPrompt,
  type CodexSessionSummary,
  artifact_goal_passes,
  artifact_structural_verify,
  docx_document,
  office_artifact_contract,
  office_artifact_workflow,
  office_tool_integrations,
  pdf_document,
  pptx_presentation,
  xlsx_workbook,
  attachableInheritedServers,
  formatReasoningDecision,
  parseReasoningPreference,
  withReasoningEconomy,
  projectBoardView,
  sessionPreview,
  MODEL_CARD_SEED,
  type ReasoningPreference,
} from "@musterhq/core";
import {
  inheritedEcosystem,
  renderInheritedIntegrationsTable,
  renderSensesPanel,
  resolveAttachableServer,
} from "./inherited-ecosystem.js";
import { DurableWorkerStore, approveAttempt, createAttemptWorktree, findRelaunchOrphans, findStalledAttempts, sweepZombieWorktrees } from "./board-runtime.js";
import {
  approvePairing,
  DEFAULT_GATEWAY_PORT,
  discordInteractionToInbound,
  FrappeOAuthCoordinator,
  FrappeSiteBindingCoordinator,
  inspectFrappeOAuthConnection,
  doctorWhatsApp,
  gchatEventToSurfaceMessage,
  googleChatAudienceIsValid,
  gatewayConfigPath,
  initGatewayConfig,
  loadGatewayConfig,
  loadPairings,
  openSqliteGatewayEnterpriseRuntime,
  pollSlackSocket,
  pollTelegram,
  pollWhatsApp,
  saveGatewayConfig,
  slackEventToSurfaceMessage,
  startGatewayServer,
  teamsActivityToSurfaceMessage,
  telegramUpdateToSurfaceMessage,
  whatsAppWebMessageToSurfaceMessage,
  whatsappSessionDir,
  whatsAppWebhookToSurfaceMessages
} from "@musterhq/gateway";
import { runWhatsAppLoginCommand } from "./whatsapp-login.js";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { access, mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { randomBytes, createHash } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
import { createServer } from "node:http";
import { createInterface, emitKeypressEvents, type Interface } from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import type { BackendEcosystem, CapabilityPluginPolicy, ChatMessage, EvidenceRecord, FeedbackValue, FlowRunEvent, FlowRunState, FlowToolRegistry, HindsightConfig, McpServerConfig, MemoryScope, MessageRow, MigrationSource, RunOutcome, SessionRow } from "@musterhq/core";
import type { GatewayConfig, PairedIdentity } from "@musterhq/gateway";

const originalEmitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...warningArgs: Parameters<typeof process.emitWarning> extends [string | Error, ...infer Rest] ? Rest : never[]) => {
  const message = typeof warning === "string" ? warning : warning.message;
  const type = typeof warningArgs[0] === "string" ? warningArgs[0] : typeof warning === "string" ? undefined : warning.name;
  if (type === "ExperimentalWarning" && message.includes("SQLite")) return;
  originalEmitWarning(warning, ...warningArgs);
}) as typeof process.emitWarning;

process.on("warning", (warning) => {
  if (warning.name === "ExperimentalWarning" && warning.message.includes("SQLite")) return;
  console.warn(`${warning.name}: ${warning.message}`);
});

const [, , command, ...args] = process.argv;
const CLI_MUSTER_VERSION = readCliPackageVersion();
const CLI_PACKAGE_NAME = "@musterhq/cli";
const SHELL_COMMANDS = [
  "help", "version", "update", "init", "onboard", "onboarding", "doctor", "status", "chat", "model", "claude", "codex",
  "episodes", "feedback", "candidates", "eval", "capability", "roster", "artifacts", "plugins", "mcp", "dashboard",
  "context", "latency", "memory", "goal", "tui", "provider", "runtime", "qa", "pi", "state", "migrate", "sessions",
  "skills", "pulse", "subagents", "tasks", "board", "demo", "benchmark", "run", "tokens", "traces", "profile",
  "schedule", "evolve", "flow", "verify", "gateway", "channels", "integrations", "pairing", "frappe", "server",
] as const;

function readCliPackageVersion(): string {
  const packagePath = fileURLToPath(new URL("../package.json", import.meta.url));
  const parsed = JSON.parse(readFileSync(packagePath, "utf8")) as { version?: unknown };
  if (typeof parsed.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(parsed.version)) {
    throw new Error(`Invalid CLI package version in ${packagePath}`);
  }
  return parsed.version;
}

async function main(): Promise<void> {
  if (command === "--skip-onboarding" || command === "--no-onboarding") {
    await chat([command, ...args]);
    return;
  }
  // Help is answered BEFORE dispatch: no command may see a `--help` argument,
  // because at least one of them (run) would have spent money on it.
  if (command && !SELF_HELP_COMMANDS.has(command) && wantsHelp(args)) {
    printCommandUsage(command);
    return;
  }
  switch (command) {
    case undefined:
      await chat(args);
      return;
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return;
    case "version":
    case "--version":
    case "-v":
      printVersion();
      return;
    case "update":
      await updateCommand(args);
      return;
    case "init":
      await init();
      return;
    case "onboard":
    case "onboarding":
      await runMusterOnboardingTui(args);
      return;
    case "doctor":
      await doctor(args);
      return;
    case "status":
      await statusCommand(args);
      return;
    case "chat":
      await chat(args);
      return;
    case "model":
      await chat([`/model${args.length ? ` ${args.join(" ")}` : ""}`]);
      return;
    case "claude":
      await claude(args);
      return;
    case "codex":
      await codexCommand(args);
      return;
    case "episodes":
      await episodes();
      return;
    case "feedback":
      await feedback(args);
      return;
    case "candidates":
      await candidates();
      return;
    case "eval":
      await evalCommand(args);
      return;
    case "capability":
      await capability(args);
      return;
    case "roster":
      await rosterCommand(args);
      return;
    case "artifacts":
      await artifactsCommand(args);
      return;
    case "plugins":
      await pluginsCommand(args);
      return;
    case "mcp":
      await mcpCommand(args);
      return;
    case "dashboard":
      await dashboardCommand(args);
      return;
    case "context":
      await context(args);
      return;
    case "latency":
      await latencyCommand(args);
      return;
    case "memory":
      await memory(args);
      return;
    case "goal":
      await goalCommand(args);
      return;
    case "tui":
      await tui();
      return;
    case "provider":
      await provider(args);
      return;
    case "runtime":
      await runtime(args);
      return;
    case "qa":
      await qaCommand(args);
      return;
    case "pi":
      await pi(args);
      return;
    case "state":
      await state(args);
      return;
    case "migrate":
      await migrate(args);
      return;
    case "sessions":
      await sessionsCommand(args);
      return;
    case "skills":
      await skillsCommand(args);
      return;
    case "pulse":
      await pulseCommand(args);
      return;
    case "subagents":
      await subagentsCommand(args);
      return;
    case "tasks":
    case "board": // legacy hidden alias
      await boardCommand(args);
      return;
    case "demo":
      await demoCommand(args);
      return;
    case "benchmark":
      await benchmarkCommand();
      return;
    case "run":
      await runCommand(args);
      return;
    case "tokens":
      await tokensCommand(args);
      return;
    case "traces":
      await tracesCommand(args);
      return;
    case "profile":
      await profileCommand(args);
      return;
    case "schedule":
      await scheduleCommand(args);
      return;
    case "evolve":
      await evolveCommand(args);
      return;
    case "flow":
      await flowCommand(args);
      return;
    case "verify":
      await verifyCommand();
      return;
    case "gateway":
      await gatewayCommand(args);
      return;
    case "server":
      // Verbatim passthrough to muster-server, including --help when it is installed.
      process.exitCode = await runServerDelegate(args);
      return;
    case "channels":
      await channelsCommand(args);
      return;
    case "integrations":
      await integrationsCommand(args);
      return;
    case "pairing":
      await pairingCommand(args);
      return;
    case "frappe":
      await frappeCommand(args);
      return;
    default:
      throw new Error(unknownShellCommandMessage(command, SHELL_COMMANDS));
  }
}

/**
 * Does this invocation ask for help rather than work?
 *
 * `muster run --help` EXECUTED A PAID MODEL TURN: `--help` survived flag
 * stripping and became the prompt. A flag-shaped argument must never be
 * mistaken for user content, so `--help`/`-h` count ANYWHERE in the argv, while
 * bare `help` counts only in the first position — "explain the help text" is a
 * legitimate prompt, `--help` never is.
 */
function wantsHelp(args: readonly string[]): boolean {
  return args.some((arg) => arg === "--help" || arg === "-h") || args[0] === "help";
}

/**
 * Commands that render their own richer help and must keep doing so
 * (`muster chat --help` lists slash commands; `eval retrieval --help` explains
 * seeding). Everything else is answered from the master usage table.
 */
const SELF_HELP_COMMANDS = new Set(["chat", "eval", "server"]);

/**
 * Usage lines for one command, lifted from the single master help text so the
 * two can never drift. Falls back to full help for a command with no entry.
 */
function printCommandUsage(name: string): void {
  if (name === "codex") {
    printCodexHelp();
    return;
  }
  const lines = commandUsageLines(HELP_TEXT, name);
  if (!lines.length) {
    printHelp();
    return;
  }
  console.log(`muster ${name}\n\nUsage:`);
  for (const line of lines) console.log(line);
  console.log("\nFull command list: muster --help");
}

const HELP_TEXT = `Muster v${CLI_MUSTER_VERSION}

Usage:
  muster                                    # first run: onboarding; after setup: interactive chat
  muster --version
  muster update [--manager npm|pnpm|yarn|bun] [--target latest] [--apply]
  muster --skip-onboarding                  # open chat even if onboarding is incomplete
  muster init
  muster onboard [--preview] [--color=always|never] [--step purpose|style|provider|integrations|channels|memory|finish]
  muster doctor [--fix]
  muster doctor codex [--codex-command path] [--latest-version x.y.z]
  muster status
  muster chat
  muster chat "your prompt"
  muster chat --session work "your prompt"
  muster chat --session work --history
  muster model [name]                       # choose the chat model
  muster claude inspect
  muster claude ask "prompt" [--model sonnet] [--effort low] [--timeout-ms 30000]
  muster codex sessions [--limit 20] [--since 7d] [--here] [--all] [--json]
  muster codex resume <thread-id-prefix> [--session name] [--import-only] [--here]
  muster episodes
  muster feedback <episode-id> --useful|--not-useful [--correct] [--reason "..."]
  muster candidates
  muster eval seed <episode-id> [--expect "..."] [--forbid "..."]
  muster eval run [path-or-dir]
  muster eval retrieval seed <id> --query "..." --scope user:me --expect mem_... | --expect-none
  muster eval retrieval seed-pack <id> [--tenant f2] [--user goblin] [--other-user goblin-other] [--distractors 250]
  muster eval retrieval seed-frappe-pack <id> [--tenant f2] [--user goblin] [--app frappe_app] [--module HR] [--doctype Employee] [--child-doctype "Employee Detail"] [--distractors 250]
  muster eval retrieval list [path-or-dir]
  muster eval retrieval <path-or-dir> [--min-recall 1] [--min-mrr 1] [--max-leakage-rate 0] [--max-stale-hit-rate 0] [--max-p95-ms 50] [--artifact-dir DIR]
  muster capability inspect <path>
  muster capability digest <path> [--write]
  muster capability load <path> [--allow-high-risk]
  muster roster catalog [--host provider|--scan-hosts] [--no-host-cache|--refresh-host-cache] [--host-cache path] [--host-cache-ttl-ms n] [--json] [--report path]
  muster roster index --out roster.index.json [--builtin-packs] [--skip-blocked] [pack-path ...] [--dry-run]
  muster roster plan <id|--all> [--lock .muster/roster.lock.json] [--host provider|--scan-hosts] [--no-host-cache|--refresh-host-cache] [--json] [--report path]
  muster roster verify [--index roster.index.json] [--muster-version x.y.z] [--registry-profile verified|release] [--require-metadata] [--min-readiness level] [--json] [--report path]
  muster roster inspect|install <id> [--index roster.index.json] [--lock .muster/roster.lock.json] [--version x.y.z] [--muster-version x.y.z] [--registry-profile verified|release] [--require-metadata] [--min-readiness level] [--json] [--report path]
  muster roster lock [--lock .muster/roster.lock.json] [--verify] [--muster-version x.y.z] [--json] [--report path]
  muster roster materialize <id> [--index roster.index.json] [--lock .muster/roster.lock.json] [--cache .muster/roster-cache] [--version x.y.z] [--muster-version x.y.z] [--registry-profile verified|release] [--require-metadata] [--min-readiness level] [--json] [--report path]
  muster roster activate <id|mcp:id|channel:id|skill:id> [--lock .muster/roster.lock.json] [--muster-version x.y.z] [--dry-run] [--json] [--report path]
  muster roster publish --dry-run <path> [--source-path path] [--muster-compatibility >=0.1.0] [--muster-version x.y.z] [--json] [--report path]
  muster artifacts contract [--formats docx,xlsx,pptx,pdf]
  muster artifacts plan --format docx|xlsx|pptx|pdf [--destination local|google-drive|microsoft-365] [--polished]
  muster artifacts create --format docx|xlsx|pptx|pdf --title "..." [--summary "..."] [--spec spec.json] [--out path]
  muster artifacts verify <file> [--format docx|xlsx|pptx|pdf] [--require text]
  muster plugins list | catalog | setup <id> | reuse <provider> [--adopt-mcp id|--adopt-all-mcps] | context frappe <setup|docs|module|build> | enable <id> | disable <id> | policy | inspect <path> | load <path>
  muster mcp list | status [name] | login <name> | logout <name> | catalog | check [id] | install <id> | oauth status|setup|import ... | add-http <name> <url> [--oauth ...] | add-stdio <name> <command> [args...] | test <name>
  muster dashboard status | start [--port 7461] [--host 127.0.0.1]
  muster channels list | status [channel] | plan <channel> | simulate <channel> [--message TEXT] | doctor <channel> [--live] | setup|connect|ready <channel> [--mode socket|http] [--public-url URL] [secret flags]
  muster integrations [list|guide|status|workflow <id>|setup <id>|verify <id>|enable <id>|sample <id>]  # guided setup for channels, plugins, and MCPs
  muster integrations inherited [--refresh]                      # read-only inventory of the MCP servers and plugins codex/claude already give this machine
  muster context graph [episode-id] [--scope tenant:hybrow] [--latest]
  muster latency "prompt" [--runs 3] [--runtime codex] [--provider X] [--model Y] [--scope user:me] [--timeout-ms 30000]
  muster qa scorecard [--codex-command path] [--latest-version x.y.z] [--evidence path] [--strict-release]
  muster qa suites
  muster qa run pty_tui|mcp_auth_failure|memory_retrieval_speed|provider_latency|channel_plugin_setup|frappe2_real_prompts|pack_readiness [--artifact-dir DIR] [--evidence path]
  muster qa record <suite> --status passed|warning|failed|unknown --artifact-dir DIR --summary "..."
  muster memory add --summary "..." --scope user:me --provenance manual
  muster memory search --scope user:me [--query "..."] [--include-global]
  muster memory status [--probe --scope user:me --query "..."]
  muster memory doctor [--fix] [--probe --scope user:me --query "..."]
  muster memory providers | plan <memory-provider> [--scope user:me] [--mode export|sync]
  muster memory promote <memory-id> --to tenant:acme [--allow-global]
  muster goal status [--limit 10]       # active-goal loop ledger: retrieval, memory write, follow-up needs
  muster tui
  muster tui ask "your prompt"
  muster provider list
  muster provider add-openai-compatible <id> <base-url> <model> [--api-key-env OPENAI_API_KEY]
  muster provider add-codex-cli <id> <model>
  muster provider presets
  muster provider add <preset> [--model X] [--api-key-env VAR] [--base-url URL]   (openai, anthropic, xai, kimi, deepseek, groq, openrouter, vllm, ...)
  muster runtime use-provider <runtime-id> <provider-id> [model]
  muster runtime doctor [--codex-command path]
  muster pi inspect [--home /path/to/home]
  muster pi models [--provider anthropic] [--available] [--agent-dir ~/.pi/agent]
  muster pi tools [--agent-dir ~/.pi/agent] [--tools read,grep,find,ls]
  muster pi commands [--agent-dir ~/.pi/agent] [--tools read,grep,find,ls]
  muster pi tui ["optional startup prompt"] [--agent-dir ~/.pi/agent] [--session create|continue|memory] [--session-dir path]
  muster pi ask "prompt" [--provider openai] [--model gpt-4o-mini] [--transport sdk|cli] [--session memory|create|continue] [--session-dir path] [--timeout-ms 30000]
  muster state export [--output packages/ui/public/muster-state.json]
  muster state show
  muster migrate openclaw --dry-run [--profile <channel-name>]
  muster migrate hermes --dry-run
  muster migrate pi --dry-run
  muster sessions search "query" | show <id> | recent [--all]
  muster skills list | catalog | enable <id> | disable <id> | view <name> | index | curate
  muster pulse add "<cron>" [--kind heartbeat|task] [--prompt "..."] | list | resume <id> | run-due
  muster subagents list | reap [--ttl-min N]
  muster tasks [list] | why <taskId> | assign <taskId> <cardId> [--session <chat>]   # parallel tasks and agents, outside chat
  muster demo                         # provision a throwaway workspace + stub model, show the full pipeline
  muster benchmark                    # Token Waste Index — prove the ledger savings (deterministic, no model)
  muster run "prompt" [--runtime pi] [--provider anthropic] [--model claude-sonnet-4-5] [--session memory|create|continue] [--scope user:me] [--task-kind coding] [--sensitive]
  muster tokens [--limit 20]
  muster traces [--limit N] [--trace <id>]     # OpenTelemetry spans — set MUSTER_TRACE=1 to record, MUSTER_OTLP_ENDPOINT to export
  muster profile create|list|use|current [name] | clone <from> <to>
  muster schedule add "*/5 * * * *" "prompt" | list | remove <id> | run-due
  muster evolve <suite.json> [--runtime pi] [--provider anthropic] [--model ...] [--iterations 2]
  muster evolve selfcheck
  muster flow save <file.json> | list | check <id> | run <id> [--toolset core|full] [--allow-command cmd] [--allow-host host] [--pack dir]
  muster flow runs | show <run-id> | approve <run-id> | reject <run-id>
  muster gateway init
  muster gateway status              # readiness without printing bearer tokens
  muster gateway start [--port 7460] [--with-telegram-poll] [--with-slack-socket] [--with-whatsapp]
  muster gateway daemon start|stop|status|restart [--with-telegram-poll] [--with-slack-socket] [--with-whatsapp]
  muster gateway webhook telegram --public-url https://your-domain.example
  muster gateway poll                 # local Telegram long-poll fallback; daemonize with gateway daemon start --with-telegram-poll
${SERVER_USAGE_LINES.map((line) => `  ${line}`).join("\n")}
  muster pairing list | approve <code> [--frappe-site URL --frappe-token-env ENV | --frappe-user USER] [--employee EMP --role ROLE]
  muster frappe setup --site-url URL --oauth-credential-file PATH [--connection-id ID] [--support] [--support-customer NAME] [--callback-mode gateway|frappe] [--result-path /api/method/...] [--identity-path /api/method/...] [--identity-ttl-ms 60000]
  muster frappe connect <https-site-origin> [--muster-url https://muster.example] [--wait|--no-wait] [--no-open] [--no-qr] [--timeout-ms 300000]
  muster frappe doctor [--connection-id ID]
  muster flow replay <run-id> [--live-agents]
  muster flow diff <run-id-a> <run-id-b>
  muster flow loop <flow-id> --cron "0 9 * * 1"
  muster verify

Design rule:
  One active runtime per run. Providers/models can route dynamically by task.
`;

function printHelp(): void {
  console.log(HELP_TEXT);
}

async function frappeCommand(args: string[]): Promise<void> {
  const [action] = args;
  if (action === "connect") {
    const site = args[1];
    if (!site || site.startsWith("--")) throw new Error("Usage: muster frappe connect <https-site-origin> [--muster-url https://muster.example] [--wait|--no-wait] [--no-open] [--no-qr] [--timeout-ms 300000]");
    if (args.includes("--wait") && args.includes("--no-wait")) throw new Error("Choose either --wait or --no-wait, not both.");
    await ensureDefaultConfig(process.cwd());
    await enableBuiltinPlugin("frappe-federated-bridge", process.cwd(), { allowHighRisk: true });
    const connection = await runFrappeConnectCommand({
      site,
      musterOrigin: readFlag(args, "--muster-url"),
      openBrowser: !args.includes("--no-open"),
      qr: !args.includes("--no-qr"),
      waitForVerification: args.includes("--wait") ? true : args.includes("--no-wait") ? false : undefined,
      timeoutMs: readNumberFlag(args, "--timeout-ms"),
      color: args.includes("--color=always") ? true : args.includes("--color=never") ? false : undefined,
    });
    console.log("capability_pack=frappe-federated-bridge enabled=true");
    console.log(`frappe_binding=${connection.connected ? "verified" : "pending"}`);
    console.log(connection.connected ? "next=Return to Frappe and ask Muster for a workflow." : "next=Finish Frappe consent, then rerun this command with --wait.");
    return;
  }
  if (action === "doctor") {
    await frappeDoctor(args);
    return;
  }
  if (action !== "setup") {
    throw new Error("Usage: muster frappe setup --site-url URL --oauth-credential-file PATH [--connection-id ID] [--support] [--support-customer NAME] [--callback-mode gateway|frappe] [--result-path /api/method/...] [--identity-path /api/method/...] [--identity-ttl-ms 60000] | muster frappe doctor [--connection-id ID]");
  }

  const site = readFlag(args, "--site-url");
  const credentialFile = readFlag(args, "--oauth-credential-file");
  const connectionId = readFlag(args, "--connection-id") ?? "frappe-default";
  const supportConnection = args.includes("--support");
  const supportCustomer = readFlag(args, "--support-customer");
  if (supportCustomer && !supportConnection) {
    throw new Error("--support-customer requires --support.");
  }
  const assistantName = readFlag(args, "--assistant-name") ?? "Muster Frappe assistant";
  const organization = readFlag(args, "--organization");
  const domain = readFlag(args, "--domain");
  if (!credentialFile || !site) {
    throw new Error("Provide --site-url and --oauth-credential-file so OAuth is configured by reference; secrets are never accepted on this command.");
  }
  let requestedSite: string;
  try {
    const parsed = new URL(site);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash || !["", "/"].includes(parsed.pathname)) {
      throw new Error("must be an HTTPS origin");
    }
    requestedSite = parsed.origin;
  } catch {
    throw new Error("--site-url must be a valid HTTPS origin without a path, query, or credentials.");
  }
  const callbackModeRaw = readFlag(args, "--callback-mode") ?? "gateway";
  if (callbackModeRaw !== "gateway" && callbackModeRaw !== "frappe") {
    throw new Error("--callback-mode must be gateway or frappe.");
  }
  const resultPath = readFlag(args, "--result-path");
  const identityPath = readFlag(args, "--identity-path");
  const identityTtlMs = readNumberFlag(args, "--identity-ttl-ms");
  if (identityTtlMs !== undefined && (identityTtlMs < 5_000 || identityTtlMs > 300_000)) {
    throw new Error("--identity-ttl-ms must be between 5000 and 300000.");
  }
  if (callbackModeRaw === "frappe" && !resultPath) {
    throw new Error("Frappe-hosted callback mode requires --result-path /api/method/...; gateway mode needs no Frappe callback app.");
  }
  if (callbackModeRaw === "gateway" && resultPath) {
    throw new Error("--result-path is only valid with --callback-mode frappe.");
  }
  const connection = {
    id: connectionId,
    credentialFile,
    callbackMode: callbackModeRaw,
    ...(resultPath ? { resultPath } : {}),
    ...(identityPath ? { identityPath } : {}),
    ...(identityTtlMs !== undefined ? { identityTtlMs } : {}),
  } as const;
  let inspection: Awaited<ReturnType<typeof inspectFrappeOAuthConnection>>;
  try {
    inspection = await inspectFrappeOAuthConnection(connection, process.cwd());
  } catch (error) {
    throw new Error(`OAuth credential or callback configuration is unsafe: ${error instanceof Error ? error.message : String(error)} Create the private mode-0600 JSON file from the Frappe OAuth registration; secrets are never accepted on argv.`);
  }
  if (inspection.site !== requestedSite) {
    throw new Error(`OAuth credential site mismatch: --site-url is ${requestedSite}, credential.site is ${inspection.site}.`);
  }

  const gatewayResult = await initGatewayConfig();
  const existing = gatewayResult.config;
  const existingFrappe = existing.frappe;
  const connections = [...(existingFrappe?.oauth?.connections ?? [])].filter((entry) => entry.id !== connectionId);
  const nextGateway = {
    ...existing,
    frappe: {
      ...existingFrappe,
      assistant: {
        ...existingFrappe?.assistant,
        name: assistantName,
        ...(organization ? { organization } : {}),
        ...(domain ? { domains: [domain] } : {}),
        description: "Permission-scoped Frappe/OxygenHR assistant; Frappe remains the authorization authority.",
      },
      oauth: {
        ...existingFrappe?.oauth,
        defaultConnection: supportConnection
          ? existingFrappe?.oauth?.defaultConnection ?? connectionId
          : connectionId,
        connections: [...connections, connection],
      },
      ...(supportConnection ? { support: { site: requestedSite, connectionId, doctype: "HD Ticket" as const, ...(supportCustomer ? { customer: supportCustomer } : {}) } } : {}),
    },
  };
  await saveGatewayConfig(nextGateway as GatewayConfig);
  await ensureDefaultConfig(process.cwd());
  await enableBuiltinPlugin("frappe-federated-bridge", process.cwd(), { allowHighRisk: true });

  console.log(`frappe_setup=configured site=${inspection.site}`);
  console.log("capability_pack=frappe-federated-bridge enabled=true");
  console.log(`assistant=${assistantName} organization=${organization ?? "-"} domain=${domain ?? "-"}`);
  console.log(`oauth_connection=${connectionId} credential_file=configured callback_mode=${inspection.callbackMode}`);
  if (supportConnection) console.log(`support_destination=${requestedSite} doctype=HD Ticket customer=${supportCustomer ?? "-"}`);
  console.log(`oauth_redirect=${inspection.redirectUri} identity_refresh_ms=${inspection.identityTtlMs}`);
  console.log("oauth_secrets=not_printed not_accepted_on_command_line=true");
  console.log(`oauth_registration=${requestedSite}/app/oauth-client`);
  console.log(`oauth_registration_step=Register the exact redirect URI above for client_id in the private credential file.`);
  console.log("next_channel=muster channels ready telegram --bot-token-env TELEGRAM_BOT_TOKEN");
  console.log("next_channel_alternative=muster channels ready slack --bot-token-env SLACK_BOT_TOKEN --app-token-env SLACK_APP_TOKEN");
  console.log("next_verify=muster frappe doctor");
  console.log("rbac=per-user OAuth identity and Frappe permissions remain authoritative");
}

async function frappeDoctor(args: string[]): Promise<void> {
  const gateway = await loadGatewayConfig().catch(() => undefined);
  if (!gateway?.frappe?.oauth?.connections.length) {
    if (gateway?.frappe?.publicOrigin) {
      const bindings = new FrappeSiteBindingCoordinator({
        storePath: join(dataDir(process.cwd()), "frappe-site-bindings.v1.enc.json"),
        encryptionSecret: gateway.token,
      }).verifiedBindings();
      console.log(`frappe_doctor=${bindings.length ? "ready" : "awaiting_consent"}`);
      console.log(`gateway_origin=${gateway.frappe.publicOrigin} verified_site_bindings=${bindings.length}`);
      for (const binding of bindings) console.log(`site=${binding.siteOrigin} tenant=${binding.tenantId} binding=${binding.bindingId}`);
      console.log("secret_check=encrypted_registry secrets_printed=false");
      console.log(bindings.length ? "live_authorization=site_binding_verified" : "next=Complete consent in the Frappe /muster-connect page, then rerun muster frappe doctor.");
      return;
    }
    throw new Error("Frappe OAuth is not configured. Run muster frappe setup --site-url URL --oauth-credential-file PATH.");
  }
  const connectionId = readFlag(args, "--connection-id") ?? gateway.frappe.oauth.defaultConnection ?? gateway.frappe.oauth.connections[0]?.id;
  const connection = gateway.frappe.oauth.connections.find((entry) => entry.id === connectionId);
  if (!connection) throw new Error(`Frappe OAuth connection "${connectionId ?? "-"}" is not configured.`);
  const inspection = await inspectFrappeOAuthConnection(connection, process.cwd());
  const config = await loadConfig();
  const enabled = config.plugins?.entries?.["frappe-federated-bridge"]?.enabled === true
    && config.plugins?.allow?.includes("frappe-federated-bridge");
  const packPath = await resolveBuiltinPluginPackPath("frappe-federated-bridge");
  const ready = enabled && Boolean(packPath);
  console.log(`frappe_doctor=${ready ? "ready" : "blocked"}`);
  console.log(`site=${inspection.site} connection=${inspection.id} callback_mode=${inspection.callbackMode}`);
  console.log(`oauth_redirect=${inspection.redirectUri} identity_refresh_ms=${inspection.identityTtlMs}`);
  if (inspection.resultPath) console.log(`oauth_result_path=${inspection.resultPath}`);
  if (inspection.identityPath) console.log(`oauth_identity_path=${inspection.identityPath}`);
  console.log(`capability_pack=${packPath ? "available" : "missing"} enabled=${enabled}`);
  console.log("secret_check=private_file_valid secrets_printed=false");
  console.log("live_authorization=not_tested next=Use /pair in the connected channel to prove consent, identity, and Frappe RBAC.");
  if (!ready) throw new Error("Frappe capability pack is not available and explicitly enabled in this installation.");
}

function printVersion(): void {
  console.log(`muster ${CLI_MUSTER_VERSION}`);
}

async function updateCommand(commandArgs: string[] = []): Promise<void> {
  if (commandArgs.includes("--help") || commandArgs.includes("-h")) {
    console.log("Usage: muster update [--manager npm|pnpm|yarn|bun] [--target latest] [--apply]");
    return;
  }
  const manager = readUpdateManager(commandArgs);
  const target = readFlag(commandArgs, "--target") ?? readFlag(commandArgs, "--latest-version") ?? "latest";
  const update = updateCommandForManager(manager, target);
  console.log(`muster_current=${CLI_MUSTER_VERSION}`);
  console.log(`package=${CLI_PACKAGE_NAME}`);
  console.log(`target=${target}`);
  console.log(`manager=${manager}`);
  console.log(`command=${update.command} ${update.args.join(" ")}`);
  if (!commandArgs.includes("--apply")) {
    console.log("apply=false");
    console.log("next=muster update --apply");
    return;
  }
  console.log("apply=true");
  await runUpdateCommand(update.command, update.args);
}

type UpdateManager = "npm" | "pnpm" | "yarn" | "bun";

function readUpdateManager(args: readonly string[]): UpdateManager {
  const explicit = readFlag([...args], "--manager");
  if (explicit) {
    if (explicit === "npm" || explicit === "pnpm" || explicit === "yarn" || explicit === "bun") return explicit;
    throw new Error("--manager must be one of npm, pnpm, yarn, bun.");
  }
  const userAgent = process.env.npm_config_user_agent ?? "";
  if (userAgent.startsWith("pnpm/")) return "pnpm";
  if (userAgent.startsWith("yarn/")) return "yarn";
  if (userAgent.startsWith("bun/")) return "bun";
  return "npm";
}

function updateCommandForManager(manager: UpdateManager, target: string): { readonly command: string; readonly args: readonly string[] } {
  const spec = `${CLI_PACKAGE_NAME}@${target}`;
  if (manager === "pnpm") return { command: "pnpm", args: ["add", "-g", spec] };
  if (manager === "yarn") return { command: "yarn", args: ["global", "add", spec] };
  if (manager === "bun") return { command: "bun", args: ["add", "-g", spec] };
  return { command: "npm", args: ["install", "-g", spec] };
}

/* ---------- workspace bootstrap + backend detection ---------- */

interface ProbeResult {
  readonly ok: boolean;
  readonly output: string;
}

/** Run a short probe command. A missing binary is an answer, never a crash. */
async function probeCommand(command: string, commandArgs: readonly string[], timeoutMs = 6000): Promise<ProbeResult> {
  return new Promise<ProbeResult>((resolveProbe) => {
    let output = "";
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveProbe({ ok, output: output.trim() });
    };
    const child = spawn(command, [...commandArgs], { stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(false);
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
    child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
    child.on("error", () => finish(false));
    child.on("exit", (code) => finish(code === 0));
  });
}

/** PATH lookup without spawning `which` — cheaper, and identical in outcome. */
function findOnPath(binary: string): string | undefined {
  for (const entry of (process.env.PATH ?? "").split(":")) {
    if (!entry) continue;
    const candidate = join(entry, binary);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

interface BackendDetection {
  readonly codex: "authenticated" | "installed_logged_out" | "missing";
  readonly claude: "installed" | "missing";
}

async function detectBackends(): Promise<BackendDetection> {
  const codexPath = findOnPath("codex");
  const codex = !codexPath
    ? "missing" as const
    : (await probeCommand("codex", ["login", "status"])).ok ? "authenticated" as const : "installed_logged_out" as const;
  return { codex, claude: findOnPath("claude") ? "installed" : "missing" };
}

function describeBackends(detection: BackendDetection): string {
  const codex = detection.codex === "authenticated" ? "codex: logged in"
    : detection.codex === "installed_logged_out" ? "codex: installed, logged out (codex login)"
      : "codex: not installed";
  return `${codex} · claude: ${detection.claude === "installed" ? "CLI on PATH" : "CLI not on PATH"}`;
}

/** Single keypress, raw mode, restored no matter how the read ends. */
async function readSingleKey(): Promise<string> {
  if (!input.isTTY) return "";
  const wasRaw = input.isRaw === true;
  input.setRawMode(true);
  input.resume();
  try {
    return await new Promise<string>((resolveKey) => {
      const onData = (chunk: Buffer): void => {
        input.off("data", onData);
        resolveKey(chunk.toString("utf8"));
      };
      input.on("data", onData);
    });
  } finally {
    input.setRawMode(wasRaw);
    input.pause();
  }
}

/**
 * Guard every command that needs a configured workspace.
 *
 * `muster run` in a fresh directory used to surface a raw ENOENT for
 * `.muster/config.json` — a stack trace where a decision belongs. Interactively
 * the user is offered the two real choices (init here, or use the global
 * workspace) and the ORIGINAL command then continues. Non-interactively there is
 * nobody to ask, so it fails closed with the exact fix.
 */
async function requireWorkspace(): Promise<void> {
  if (existsSync(configPath())) return;
  if (!input.isTTY || !output.isTTY) {
    throw new Error("No muster workspace. Fix: muster init");
  }
  const detection = await detectBackends();
  console.log(color(`No muster workspace here (${configPath()} is missing).`, "yellow"));
  console.log(color(`detected backends: ${describeBackends(detection)}`, "dim"));
  console.log("[enter] init here with detected backends · [g] global · [esc] cancel");
  const key = await readSingleKey();
  if (key === "\r" || key === "\n") {
    const target = await ensureDefaultConfig(process.cwd());
    console.log(color(`workspace=${target} backends=${describeBackends(detection)}`, "green"));
    return;
  }
  if (key === "g" || key === "G") {
    const target = await ensureDefaultConfig(homedir());
    // "Global" means the command runs against the home workspace, so the cwd
    // moves with it — otherwise the next config read would miss it again.
    process.chdir(homedir());
    console.log(color(`workspace=${target} (global; running from ${homedir()})`, "green"));
    return;
  }
  throw new Error("No muster workspace. Fix: muster init");
}

async function runUpdateCommand(commandName: string, commandArgs: readonly string[]): Promise<void> {
  await new Promise<void>((resolveRun, rejectRun) => {
    const child = spawn(commandName, [...commandArgs], { stdio: "inherit" });
    child.on("error", rejectRun);
    child.on("exit", (code, signal) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`Update command failed${signal ? ` with signal ${signal}` : ` with exit code ${code ?? "unknown"}`}.`));
    });
  });
}

async function init(): Promise<void> {
  printBanner();
  const target = await ensureDefaultConfig();
  console.log(`Created or reused Muster config: ${target}`);
  console.log("Default provider: Codex CLI via your local `codex` login");
  console.log("Next: muster doctor");
}

async function doctor(commandArgs: string[] = []): Promise<void> {
  if (commandArgs[0] === "codex" || commandArgs.includes("--codex")) {
    await printCodexDoctor(commandArgs);
    return;
  }
  if (commandArgs.includes("--fix")) {
    const configTarget = await ensureDefaultConfig();
    console.log(`fix config            ${configTarget}`);
    const data = dataDir();
    await mkdir(data, { recursive: true });
    console.log(`fix data-dir          ${data}`);
  }
  const checks: Array<[string, boolean, string]> = [];
  let configLoaded = false;
  try {
    const config = await loadConfig();
    configLoaded = true;
    checks.push(["config", true, configPath()]);
    checks.push(["one-runtime-per-run", config.routing.oneRuntimePerRun === true, "routing policy"]);
    checks.push(["default-runtime", Boolean(config.runtimes[config.routing.defaultRuntime]), config.routing.defaultRuntime]);
    for (const provider of Object.values(config.providers)) {
      checks.push([`provider:${provider.id}`, true, `${provider.kind} ${provider.baseUrl ?? ""}`.trim()]);
    }
  } catch (error) {
    checks.push(["config", false, error instanceof Error ? error.message : String(error)]);
  }

  if (configLoaded) {
    const config = await loadConfig();
    for (const provider of Object.values(config.providers)) {
      if (provider.kind === "openai-compatible" && provider.baseUrl) {
        const ok = await checkModelsEndpoint(provider.baseUrl);
        checks.push([`provider:${provider.id}:models`, ok, `${provider.baseUrl.replace(/\/$/, "")}/models`]);
      }
    }
  }

  for (const [name, ok, detail] of checks) {
    console.log(`${ok ? "ok " : "err"} ${name.padEnd(28)} ${detail}`);
  }

  for (const check of await runEnvironmentDoctorChecks()) {
    console.log(`${check.status.padEnd(4)} ${check.id.padEnd(28)} ${check.detail}`);
    if (check.fix && check.status !== "pass") console.log(`fix  ${check.id.padEnd(28)} ${check.fix}`);
  }
}

interface EnvironmentCheck {
  readonly id: string;
  readonly status: "pass" | "warn" | "fail";
  readonly detail: string;
  readonly fix?: string;
}

/** Repo root when running from a checkout; undefined for an installed package. */
function workspaceRepoRoot(): string | undefined {
  const packageRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
  const root = resolve(packageRoot, "..", "..");
  return existsSync(join(root, "pnpm-workspace.yaml")) ? root : undefined;
}

/** Newest mtime under `dir`, or undefined when the directory has no files. */
async function newestMtimeMs(dir: string): Promise<number | undefined> {
  let entries: Array<import("node:fs").Dirent<string>>;
  try {
    entries = await readdir(dir, { recursive: true, withFileTypes: true, encoding: "utf8" });
  } catch {
    return undefined;
  }
  let newest: number | undefined;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    try {
      const info = await stat(join(entry.parentPath, entry.name));
      if (newest === undefined || info.mtimeMs > newest) newest = info.mtimeMs;
    } catch {
      // Vanished mid-walk; it cannot be the newest thing that matters.
    }
  }
  return newest;
}

/**
 * The four things that have actually broken a session on this machine and that
 * `doctor` was silent about: a stale dist, a logged-out backend, a daemon that
 * is not running, and a `muster` on PATH pointing somewhere unexpected.
 *
 * Every check reports pass/warn/fail with ONE line of fix. Nothing here mutates
 * anything — doctor diagnoses; `--fix` and the named commands repair.
 */
async function runEnvironmentDoctorChecks(): Promise<readonly EnvironmentCheck[]> {
  const checks: EnvironmentCheck[] = [];

  // 1. dist freshness — stale dist has silently shipped old behaviour twice.
  const repoRoot = workspaceRepoRoot();
  if (!repoRoot) {
    checks.push({ id: "dist-freshness", status: "pass", detail: "installed package (no source tree to compare)" });
  } else {
    for (const pkg of ["core", "gateway", "cli"]) {
      const packageDir = join(repoRoot, "packages", pkg);
      if (!existsSync(packageDir)) continue;
      const srcAt = await newestMtimeMs(join(packageDir, "src"));
      const distAt = await newestMtimeMs(join(packageDir, "dist"));
      const rebuild = `pnpm --filter @musterhq/${pkg} build`;
      if (srcAt === undefined) continue;
      if (distAt === undefined) {
        checks.push({ id: `dist:${pkg}`, status: "fail", detail: `${packageDir}/dist is missing`, fix: rebuild });
      } else if (srcAt > distAt) {
        const behindMin = Math.max(1, Math.round((srcAt - distAt) / 60_000));
        checks.push({ id: `dist:${pkg}`, status: "warn", detail: `src is ${behindMin}m newer than dist`, fix: rebuild });
      } else {
        checks.push({ id: `dist:${pkg}`, status: "pass", detail: "dist newer than src" });
      }
    }
  }

  // 2. backend auth — a run that will fail at the provider should fail here first.
  const backends = await detectBackends();
  checks.push(backends.codex === "authenticated"
    ? { id: "backend:codex", status: "pass", detail: "codex login status: logged in" }
    : backends.codex === "installed_logged_out"
      ? { id: "backend:codex", status: "fail", detail: "codex CLI present but not logged in", fix: "codex login" }
      : { id: "backend:codex", status: "warn", detail: "codex CLI not on PATH", fix: "npm i -g @openai/codex" });
  checks.push(backends.claude === "installed"
    ? { id: "backend:claude", status: "pass", detail: "claude CLI on PATH" }
    : { id: "backend:claude", status: "warn", detail: "claude CLI not on PATH", fix: "install Claude Code, then: claude login" });

  // 3. gateway daemon — pid file AND health, because either alone can lie.
  const gatewayPort = await loadGatewayConfig().then((config) => config.port ?? DEFAULT_GATEWAY_PORT, () => DEFAULT_GATEWAY_PORT);
  const daemon = await inspectGatewayDaemon(gatewayPort);
  checks.push(!daemon.running
    ? { id: "gateway-daemon", status: "warn", detail: "not running", fix: `muster gateway daemon start --port ${gatewayPort}` }
    : daemon.healthy
      ? { id: "gateway-daemon", status: "pass", detail: `pid ${daemon.pid} healthy on :${gatewayPort}` }
      : { id: "gateway-daemon", status: "fail", detail: `pid ${daemon.pid} alive but /v1/health unreachable on :${gatewayPort}`, fix: "muster gateway daemon restart" });
  const warmGatewayThreads = daemon.running && daemon.pid ? readGatewayCodexWarmThreadCount(daemon.pid) : 0;
  checks.push({
    id: "gateway-codex-threads",
    status: warmGatewayThreads > 0 ? "warn" : "pass",
    detail: `gateway holds ${warmGatewayThreads} warm codex threads`,
    ...(warmGatewayThreads > 0 ? { fix: "muster gateway daemon restart" } : {}),
  });

  // 4. PATH shim — the binary the user's terminal actually resolves.
  const shimPath = join(homedir(), ".local", "bin", "muster");
  const resolved = findOnPath("muster");
  checks.push(!existsSync(shimPath)
    ? { id: "path-shim", status: "warn", detail: `${shimPath} is missing`, fix: "npm i -g @musterhq/cli (or symlink the shim into ~/.local/bin)" }
    : resolved === shimPath
      ? { id: "path-shim", status: "pass", detail: shimPath }
      : { id: "path-shim", status: "warn", detail: `PATH resolves muster to ${resolved ?? "nothing"}, not ${shimPath}`, fix: "put ~/.local/bin ahead of the other entry in PATH" });

  return checks;
}

async function printCodexDoctor(commandArgs: string[]): Promise<void> {
  const report = await inspectCodexRuntime({
    command: readFlag(commandArgs, "--codex-command"),
    latestVersion: readFlag(commandArgs, "--latest-version"),
  });
  console.log(`codex_doctor command=${report.command}`);
  console.log(`codex_available=${report.available}`);
  if (report.version) console.log(`codex_version=${report.version}`);
  if (report.latestVersion) console.log(`codex_latest=${report.latestVersion}`);
  console.log(`supports_exec=${report.supportsExec ?? false}`);
  console.log(`supports_app_server=${report.supportsAppServer ?? false}`);
  console.log(`auth_status=${report.authStatus}`);
  for (const check of report.checks) {
    console.log(`${check.status.padEnd(7)} ${check.id.padEnd(20)} ${check.summary}${check.detail ? ` (${check.detail})` : ""}`);
    if (check.fix && check.status !== "passed") console.log(`fix     ${check.id.padEnd(20)} ${check.fix}`);
  }
  console.log(`recommendation=${report.recommendation}`);
  if (report.checks.some((check) => check.status === "failed")) process.exitCode = 1;
}

interface ChatState {
  sessionName: string;
  runtime?: string;
  provider?: string;
  model?: string;
  speedMode?: "session" | "fast";
  scopes: MemoryScope[];
  recallLimit?: number;
  pendingMenu?: ChatMenu;
  pendingSuggestion?: ChatSelectedSuggestion;
  statusSink?: MusterChatSink;
  /** History rendered by the TUI from its very first frame. */
  initialTranscriptLines?: readonly string[];
  /** Launch header density. Compact (4 lines) is the default; /header full restores the panel. */
  headerMode?: "compact" | "full";
  /** undefined ⇒ follow the environment default; see liveDiffEnabled. */
  liveDiff?: boolean;
  /**
   * Workspace the turn executes in. Set by `muster codex resume` so a resumed
   * Codex thread keeps editing the repo it was started against, not wherever
   * the user happened to type the command. undefined ⇒ process.cwd().
   */
  workspaceCwd?: string;
  /** Persistent home recorded on the session row, independent of detached execution. */
  sessionWorkspaceCwd?: string;
  /**
   * Native Codex thread to continue on the NEXT turn only. `executeRun` forwards
   * it to `thread/resume`, then persists its own handle for the conversation, so
   * this is cleared once used (see resumeCodexThread).
   */
  resumeThreadId?: string;
  /**
   * Reasoning summary density. Compact (one dim row per summary) is the
   * default; `/reasoning full` paints every line the provider approved.
   */
  reasoningMode?: ReasoningMode;
  /**
   * Reasoning SPEND tier for this chat. `auto` (the default) lets the prompt
   * heuristic pick, and may only lower the tier below what config would spend;
   * an explicit tier is sticky until changed. See reasoning-economy.ts.
   */
  reasoningTier?: ReasoningPreference;
  /** Tier the last turn actually ran at — rendered in the status line. */
  lastReasoning?: string;
  /** Codex app vocabulary; undefined means follow ~/.codex/config.toml. */
  effortOverride?: EffortValue;
  configuredEffort?: EffortValue;
  configuredEffortSource?: "codex config" | "app default";
  modelSource?: "codex config" | "session" | "app default";
  effortSource?: "codex config" | "session" | "app default";
  composerInitialized?: boolean;
  /** One-turn transcript handoff when the selected provider changes. */
  pendingContinuityContext?: string;
  activeProvider?: ModelProvider;
  /** Session running totals — the bottom status row's tokens and cost. */
  usage?: ChatSessionUsage;
  /** Wall clock the session started at; the status row's idle elapsed. */
  startedAt?: number;
  /** True only while a TTY composer is available for one-key suggestions. */
  interactive?: boolean;
  /** Observer-derived cumulative full-file model for the most recent turn. */
  liveFileTurn?: LiveFileTurnAccumulator;
  /** Active inherited plugins discovered once when chat starts. */
  dynamicCommands?: readonly ChatCommandDef[];
  inheritedTools?: BackendEcosystem;
  /** Conflict recovery differs for a Codex import and a native chat. */
  importedFromCodex?: boolean;
}

interface ChatSessionUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  turns: number;
}

const DEFAULT_CHAT_SESSION = "main";
type ChatMenu =
  | { readonly kind: "commands" | "agents"; readonly options: readonly string[] }
  | { readonly kind: "codex-sessions"; readonly options: readonly string[]; readonly includeAll: boolean }
  | { readonly kind: "parallel-tasks"; readonly prompt: string }
  | { readonly kind: "workspace-mismatch"; readonly sessionName: string; readonly workspaceCwd: string };
interface ChatSuggestion {
  readonly label: string;
  readonly value: string;
  readonly kind: "command" | "agent" | "completion";
}
interface ChatSelectedSuggestion {
  readonly baseLine: string;
  readonly value: string;
  readonly kind: ChatSuggestion["kind"];
}
const CHAT_COMMAND_NAMES = CHAT_COMMANDS.flatMap((command) => [command.name, ...(command.aliases ?? [])]);
const CHAT_COMMAND_ALIASES = new Map(CHAT_COMMANDS.flatMap((command) => (command.aliases ?? []).map((alias) => [alias, command.name] as const)));
const CHAT_TOOLSETS = ["core", "full", "files", "web", "memory", "sessions", "shell", "results", "discovery"];
const CHAT_CLOUD_OPTIONS = PROVIDER_PRESETS
  .filter((preset) => preset.category === "cloud" || preset.category === "aggregator")
  .map((preset) => ({
    value: preset.id,
    label: preset.id,
    description: `${preset.label} · ${preset.defaultModel} · ${preset.apiKeyEnv ?? "no key"}`,
  }));
const CHAT_SPEED_OPTIONS: readonly PickerOption[] = [
  { value: "session", label: "session", description: "full memory and skill context; best for long work" },
  { value: "fast", label: "fast", description: "warm native session with recall/ambient skills off; best for quick turns" },
];
const CHAT_SKILL_OPTIONS = listBuiltinSkills().map((skill) => ({
  value: skill.id,
  label: skill.id,
  description: `${skill.category} · ${skill.source} · risk ${skill.risk}${skill.tags.length ? ` · ${skill.tags.join(", ")}` : ""} · ${skill.description}`,
}));
const CHAT_PLUGIN_OPTIONS = listBuiltinPlugins().map((plugin) => ({
  value: plugin.id,
  label: plugin.id,
  description: `${plugin.category} · ${plugin.actionability} · ${plugin.source} · risk ${plugin.risk}${plugin.aliases?.length ? ` · ${plugin.aliases.join(", ")}` : ""} · ${plugin.description}`,
}));
const CHAT_REUSE_PROVIDER_PRESETS: readonly PickerOption[] = [
  { value: "codex", label: "codex", description: "scan CODEX_HOME or the local Codex host cache for authenticated apps/MCPs" },
  { value: "claude", label: "claude", description: "scan CLAUDE_HOME or the local Claude host cache when available" },
  { value: "openclaw", label: "openclaw", description: "scan OPENCLAW_HOME or the local OpenClaw host cache when available" },
  { value: "hermes", label: "hermes", description: "scan HERMES_HOME or the local Hermes host cache when available" },
  { value: "custom", label: "custom", description: "set MUSTER_<PROVIDER>_PLUGIN_CACHE or MUSTER_PROVIDER_PLUGIN_CACHE" },
];
const CHAT_MCP_OPTIONS = listBuiltinMcpServers().map((server) => ({
  value: server.id,
  label: server.id,
  description: `${server.category} · ${server.source} · risk ${server.risk}`,
}));
const CHAT_MCP_ACTION_OPTIONS: readonly PickerOption[] = [
  { value: "attach", label: "attach", description: "let muster own an inherited codex/claude server that is reachable on localhost" },
  { value: "add-http", label: "add-http", description: "add a custom Streamable HTTP MCP server" },
  { value: "add-stdio", label: "add-stdio", description: "add a custom stdio MCP server" },
  { value: "status", label: "status", description: "show configured MCP auth and transport status" },
  { value: "login", label: "login", description: "start OAuth setup for a configured MCP server" },
  { value: "remove", label: "remove", description: "remove a configured MCP server" },
  { value: "test", label: "test", description: "test a configured MCP server" },
  { value: "check", label: "check", description: "check a built-in MCP setup path" },
  { value: "install", label: "install", description: "install a built-in MCP server" },
];

function defaultChatScopes(): MemoryScope[] {
  return [parseMemoryScope(`user:${process.env.USER || process.env.USERNAME || "local"}`)];
}

function activeChatScopes(state: ChatState): MemoryScope[] {
  return state.scopes.length ? state.scopes : defaultChatScopes();
}

function formatChatScopes(scopes: readonly MemoryScope[]): string {
  return scopes.map(formatMemoryScope).join(", ");
}

async function chat(commandArgs: string[]): Promise<void> {
  if (commandArgs.includes("--help") || commandArgs.includes("-h")) {
    printChatHelp();
    return;
  }
  const state: ChatState = {
    sessionName: safeChatSessionName(readFlag(commandArgs, "--session") ?? readFlag(commandArgs, "--name") ?? DEFAULT_CHAT_SESSION),
    runtime: readFlag(commandArgs, "--runtime"),
    provider: readFlag(commandArgs, "--provider"),
    model: readFlag(commandArgs, "--model"),
    speedMode: commandArgs.includes("--fast") ? "fast" : "session",
    scopes: readFlags(commandArgs, "--scope").map(parseMemoryScope),
    recallLimit: readNumberFlag(commandArgs, "--recall-limit"),
    liveDiff: readLiveDiffFlag(commandArgs),
    startedAt: Date.now(),
    // First turn only: after it lands, executeRun stores a session handle for
    // this conversation and later turns resume the thread without the flag.
    resumeThreadId: readFlag(commandArgs, "--codex-thread"),
    importedFromCodex: Boolean(readFlag(commandArgs, "--codex-thread")),
  };
  const prompt = stripFlags(commandArgs, ["--session", "--name", "--runtime", "--provider", "--model", "--scope", "--recall-limit", "--timeout-ms", "--continue", "--tools", "--complete", "--limit", "--codex-thread"]).filter((arg) => !["--commands", "--shortcuts", "--list", "--sessions", "--history", "--fast", "--session-speed", "--skip-onboarding", "--no-onboarding", "--live-diff", "--no-live-diff"].includes(arg)).join(" ").trim();
  if (commandArgs.includes("--list") || commandArgs.includes("--sessions")) {
    printChatSessions(readNumberFlag(commandArgs, "--limit") ?? 15, commandArgs.includes("--all"));
    return;
  }
  const continueIndex = commandArgs.indexOf("--continue");
  if (continueIndex >= 0) {
    const maybeName = commandArgs[continueIndex + 1];
    const sessionName = maybeName && !maybeName.startsWith("--") ? maybeName : mostRecentChatSessionName() ?? DEFAULT_CHAT_SESSION;
    const resumed = findChatSessionForResume(sessionName);
    state.sessionName = safeChatSessionName(resumed?.peer ?? sessionName);
    state.sessionWorkspaceCwd = resumed?.workspaceCwd ?? process.cwd();
    if (resumed?.workspaceCwd && resumed.workspaceCwd !== process.cwd()) {
      const choice = await promptWorkspaceMismatch(resumed.workspaceCwd);
      if (choice === "home") state.workspaceCwd = resumed.workspaceCwd;
    }
  }
  if (commandArgs.includes("--history")) {
    printChatHistory(state.sessionName, readNumberFlag(commandArgs, "--limit") ?? 40, chatSessionWorkspaceCwd(state));
    return;
  }
  if (commandArgs.includes("--commands")) {
    // Shell-level --commands is a reference dump; only the in-chat /help is curated.
    printChatCommandCatalog({ all: true });
    return;
  }
  if (commandArgs.includes("--shortcuts")) {
    printChatShortcuts();
    return;
  }
  const completeIndex = commandArgs.indexOf("--complete");
  if (completeIndex >= 0) {
    const fragment = commandArgs[completeIndex + 1] ?? "";
    console.log((await chatTuiCompletions(fragment, state)).join("\n"));
    return;
  }
  const toolsIndex = commandArgs.indexOf("--tools");
  if (toolsIndex >= 0) {
    const maybeToolset = commandArgs[toolsIndex + 1];
    printChatTools(maybeToolset && !maybeToolset.startsWith("--") ? maybeToolset : undefined);
    return;
  }
  if (prompt) {
    if (prompt.startsWith("/")) {
      await ensureDefaultConfig();
      await initializeChatComposerState(state);
      await handleChatCommand(prompt, state);
      return;
    }
    await runChatTurn(prompt, state, { timeoutMs: readNumberFlag(commandArgs, "--timeout-ms"), keepAlive: false });
    return;
  }
  if (shouldLaunchOnboarding(commandArgs)) {
    const onboarding = await runMusterOnboardingTui(process.stdin.isTTY && process.stdout.isTTY ? [] : ["--preview"]);
    if (!onboarding.handoffToChat) return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Interactive chat requires a TTY. Use: muster chat "your prompt" or muster chat --history --session main.');
  }
  await interactiveChat(state);
}

function shouldLaunchOnboarding(commandArgs: readonly string[]): boolean {
  if (command !== undefined) return false;
  if (commandArgs.includes("--skip-onboarding") || commandArgs.includes("--no-onboarding")) return false;
  if (process.env.MUSTER_SKIP_ONBOARDING === "1") return false;
  return !hasCompletedMusterOnboarding();
}

function printChatHelp(): void {
  console.log(`muster chat

Usage:
  muster chat                               # interactive terminal chat
  muster chat "your prompt"                 # session-backed turn in the main named session
  muster chat --session work "prompt"       # session-backed turn in a named session
  muster chat --fast "prompt"               # warm native session with light context
  muster chat --continue [name]             # resume by name, or most recent named chat
  muster chat --codex-thread <id> "prompt"  # continue a native Codex thread (see muster codex sessions)
  muster chat --no-live-diff                # stop streaming inline file diffs during a turn
  muster chat --session work --history      # show a named session
  muster chat --tools [toolset]             # list built-in tools
  muster chat --commands                    # show compact command catalog
  muster chat --list                        # list recent chat sessions

In-chat commands:
${CHAT_COMMANDS.map((command) => `  ${command.usage.padEnd(21)} ${command.description}`).join("\n")}

Shortcuts:
  Tab                  complete slash commands, toolsets, and session names
  Ctrl+D               toggle the current turn's full-file live view
  @agent-name <task>   route this turn with agent id agent-name
  End a line with \\   continue multiline input.`);
}

async function interactiveChat(state: ChatState): Promise<void> {
  state.interactive = true;
  if (process.env.MUSTER_LEGACY_READLINE === "1") {
    await legacyInteractiveChat(state);
    return;
  }
  await ensureDefaultConfig();
  await initializeChatComposerState(state);
  const headerLines = await buildChatHeaderLines(state);
  // Owner-ruled 2026-08-30: launch is CLEAN like the reference — history
  // replays only when explicitly invoked (/resume, /codex resume, /history).
  const initialLines = state.initialTranscriptLines ?? [];
  state.initialTranscriptLines = undefined;
  try {
    await runMusterChatTui({
      headerLines,
      initialLines,
      commands: chatCommandsDailyFirst(state),
      toolsets: CHAT_TOOLSETS,
      recentSessions: recentChatSessionNames,
      catalog: createChatCompletionCatalog(state),
      agents: chatAgentOptions,
      pluginReuseProviders: chatReuseProviderOptions,
      integrations: chatIntegrationOptions,
      integrationWorkflows: chatIntegrationWorkflowOptions,
      // Idle chrome is ONE header line; the status row exists only while a
      // turn runs (startTuiWorkingStatus paints it, the turn's end clears it).
      // A permanently ticking idle timer was the reported clutter.
      statusLine: async () => "",
      board: createChatBoardController(state),
      onInterrupt: () => interruptChatTurn(),
      onDecisionKey: (data, sink) => handleChatDecisionKey(data, state, sink),
      onSubmit: async (text, sink) => {
        state.statusSink = sink;
        try {
          return await captureConsoleToSink(() => handleChatInput(text, state), sink);
        } finally {
          state.statusSink = undefined;
        }
      },
    });
  } finally {
    clearCodexAppServerSessions();
    // Session boundary: chats from several projects share one terminal's
    // scrollback (owner-observed); the close stamp keeps them tellable apart.
    console.log(color(`── session ${state.sessionName} · ${basename(chatWorkspaceCwd(state))} · closed ──`, "dim"));
  }
}

async function legacyInteractiveChat(state: ChatState): Promise<void> {
  await ensureDefaultConfig();
  printBanner();
  await printChatHeader(state);
  const rl = createInterface({ input, output, historySize: 200, removeHistoryDuplicates: true, completer: chatCompleter });
  const hintState = { visible: false, key: "", active: true, baseLine: "", selectedIndex: 0, suggestions: [] as ChatSuggestion[], renderSeq: 0 };
  emitKeypressEvents(input, rl);
  const onKeypress = (chunk: string, key: { name?: string; ctrl?: boolean } = {}): void => {
    if (!hintState.active) return;
    const decisionKey = key.name === "return" || key.name === "enter" ? "\r" : key.name === "escape" ? "\x1b" : chunk;
    if (handleChatDecisionKey(decisionKey, state)) {
      setImmediate(() => replaceReadlineLine(rl, ""));
      return;
    }
    if (key.name === "return" || key.name === "enter" || key.name === "tab" || key.name === "escape" || (key.ctrl && (key.name === "c" || key.name === "d"))) return;
    if ((key.name === "up" || key.name === "down") && hintState.visible) {
      renderLiveSuggestions(rl, state, hintState, key.name).catch(() => {});
      return;
    }
    if (key.name === "up" || key.name === "down") return;
    setImmediate(() => renderLiveSuggestions(rl, state, hintState, key.name).catch(() => {}));
  };
  input.on("keypress", onKeypress);
  let pending = "";
  try {
    rl.setPrompt(chatPrompt(state));
    printChatInputFrame();
    rl.prompt();
    for await (const line of rl) {
      clearLiveSuggestions(hintState);
      const promptLabel = pending ? color("... ", "dim") : chatPrompt(state);
      const continues = hasLineContinuation(line);
      const raw = continues ? line.slice(0, -1) : line.replace(/\\\\$/, "\\");
      pending = pending ? `${pending}\n${raw}` : raw;
      if (continues) {
        rl.setPrompt(`${color("│", "accent")} ${color("...", "dim")} `);
        rl.prompt();
        continue;
      }
      printChatInputFrameBottom();
      const text = pending.trim();
      pending = "";
      if (!text) {
        rl.setPrompt(promptLabel);
        printChatInputFrame();
        rl.prompt();
        continue;
      }
      const keepGoing = await handleChatInput(text, state);
      if (!keepGoing) break;
      rl.setPrompt(chatPrompt(state));
      printChatInputFrame();
      rl.prompt();
    }
  } finally {
    hintState.active = false;
    state.pendingSuggestion = undefined;
    input.off("keypress", onKeypress);
    clearLiveSuggestions(hintState);
    rl.close();
    if (process.stdout.isTTY) output.write("\n");
  }
}

function hasLineContinuation(line: string): boolean {
  if (!line.endsWith("\\")) return false;
  let slashCount = 0;
  for (let index = line.length - 1; index >= 0 && line[index] === "\\"; index -= 1) slashCount += 1;
  return slashCount % 2 === 1;
}

function chatPrompt(_state: ChatState): string {
  return `${color("│", "accent")} ${color("›", "highlight")} `;
}

async function initializeChatComposerState(state: ChatState): Promise<void> {
  if (state.composerInitialized) return;
  const [config, codexDefaults, ecosystem] = await Promise.all([loadConfig(), readCodexComposerDefaults(), inheritedEcosystem()]);
  state.inheritedTools = ecosystem;
  state.dynamicCommands = dynamicPluginCommands(ecosystem.codex.plugins);
  const runtimeId = state.runtime ?? config.routing.defaultRuntime;
  const runtime = config.runtimes[runtimeId];
  const configuredProviderId = state.provider ?? runtime?.provider;
  const configuredProvider = configuredProviderId ? config.providers[configuredProviderId] : undefined;
  const inferred = modelProvider(state.model)
    ?? (runtimeId === "claude-code" || configuredProviderId?.includes("claude") || configuredProvider?.kind === "anthropic" ? "claude" : "codex");
  state.activeProvider = inferred;
  if (state.model) {
    state.modelSource = "session";
  } else if (inferred === "codex") {
    state.model = codexDefaults.model ?? firstRuntimeModel(runtime) ?? configuredProvider?.defaultModel ?? DEFAULT_CODEX_MODEL;
    state.modelSource = codexDefaults.modelSource;
  } else {
    const configuredModel = firstRuntimeModel(runtime) ?? configuredProvider?.defaultModel;
    state.model = modelProvider(configuredModel) === "claude" ? configuredModel : "claude-sonnet-5";
    state.modelSource = "app default";
  }
  state.configuredEffort = codexDefaults.effort ?? "medium";
  state.configuredEffortSource = codexDefaults.effortSource;
  state.effortSource = codexDefaults.effortSource;
  state.composerInitialized = true;
}

function chatCommands(state?: ChatState): readonly ChatCommandDef[] {
  return [...CHAT_COMMANDS, ...(state?.dynamicCommands ?? [])];
}

function activeChatProvider(state: ChatState): ModelProvider {
  return state.activeProvider ?? modelProvider(state.model) ?? (state.runtime === "claude-code" ? "claude" : "codex");
}

/**
 * The runtime to name so the plan honors state.model — but ONLY for managed
 * backends. Resolution mirrors the run's own provider resolution: an explicit
 * state.provider wins, else the default runtime's provider. Non-managed kinds
 * (openai-compatible stubs, self-hosted routes) return undefined and keep the
 * default plan path.
 */
function managedRuntimeForChat(
  config: Awaited<ReturnType<typeof loadConfig>>,
  state: ChatState,
): string | undefined {
  const providerId = state.provider ?? config.runtimes[config.routing.defaultRuntime]?.provider;
  const kind = providerId ? config.providers[providerId]?.kind : undefined;
  if (kind === "codex-cli") return "codex";
  if (activeChatProvider(state) === "claude" || kind === "anthropic") return "claude-code";
  return undefined;
}

function applyChatEffort(
  config: Awaited<ReturnType<typeof loadConfig>>,
  state: ChatState,
  prompt: string,
): Awaited<ReturnType<typeof loadConfig>> {
  if (activeChatProvider(state) !== "codex") return config;
  // Ask the existing helper to ensure the classified task has a concrete route,
  // then replace its legacy three-tier decision with the app's session value.
  // With no override, remove route reasoning so Codex reads the user's config.
  // Auto is a POLICY, not a shrug: no override -> classify the prompt and set
  // the tier (simple -> low). Deferring to the config default made a one-line
  // question run Medium (6.0s first token, measured live).
  // The economy helper only knows three tiers; the app's wider effort scale is
  // applied verbatim to the route below, so here an override merely needs a
  // legal clamp (xhigh/max/ultra economize like "high").
  const economyPreference = state.effortOverride === undefined
    ? ("auto" as const)
    : state.effortOverride === "low" || state.effortOverride === "medium" || state.effortOverride === "high"
      ? state.effortOverride
      : ("high" as const);
  const prepared = withReasoningEconomy(config, { prompt, runtimeId: state.runtime, preference: economyPreference }).config;
  const runtimes = Object.fromEntries(Object.entries(prepared.runtimes).map(([id, runtime]) => [
    id,
    {
      ...runtime,
      routes: Object.fromEntries(Object.entries(runtime.routes).map(([kind, route]) => {
        if (!route || prepared.providers[route.provider]?.kind !== "codex-cli") return [kind, route];
        if (state.effortOverride) return [kind, { ...route, reasoning: state.effortOverride }];
        const { reasoning: _reasoning, ...withoutReasoning } = route;
        return [kind, withoutReasoning];
      })),
    },
  ]));
  return { ...prepared, runtimes };
}

function replaceReadlineLine(rl: Interface, value: string): void {
  (rl as Interface & { line: string; cursor: number }).line = value;
  (rl as Interface & { line: string; cursor: number }).cursor = value.length;
  rl.prompt(true);
}

async function printChatHeader(state: ChatState): Promise<void> {
  const width = Math.min(Math.max((process.stdout.columns || 120) - 2, 100), 240);
  const inner = width - 4;
  const gutter = 3;
  const leftWidth = Math.max(24, Math.min(34, Math.floor(inner * 0.2)));
  const midWidth = Math.max(42, Math.floor((inner - leftWidth - gutter * 2) * 0.48));
  const rightWidth = inner - leftWidth - midWidth - gutter * 2;
  const cwd = truncate(chatWorkspaceCwd(state).replace(process.env.HOME ?? "", "~"), leftWidth - 2);
  const sessionCounts = chatSessionsByDirectory();
  const config = await loadConfig().catch(() => undefined);
  const runtimeId = state.runtime ?? config?.routing.defaultRuntime ?? "native";
  const runtime = runtimeId ? config?.runtimes[runtimeId] : undefined;
  const providerId = state.provider ?? runtime?.provider ?? "provider";
  const provider = providerId ? config?.providers[providerId] : undefined;
  const model = state.model ?? firstRuntimeModel(runtime) ?? provider?.defaultModel ?? "model";
  const scopes = activeChatScopes(state);
  const skills = await listSkills().catch(() => []);
  const activeSkills = skills.filter((skill) => skill.status === "active");
  const skillNames = (activeSkills.length ? activeSkills : skills).slice(0, 16).map((skill) => skill.name);
  const pluginPolicy = config?.plugins;
  const pluginCount = (pluginPolicy?.allow?.length ?? 0) + Object.keys(pluginPolicy?.entries ?? {}).length;
  const mcpNames = Object.keys(config?.tools?.mcp?.servers ?? {});
  const middleLines = [
    color("Available Tools", "accent"),
    ...formatCatalogLines([
      ["workspace", "read, edit, shell, git"],
      ["memory", "recall, add, promote, indexed search"],
      ["sessions", "name, resume, history, reset"],
      ["skills", "list, inspect, curate, run"],
      ["plugins", "inspect, load, policy"],
      ["mcp", "list, add-stdio, test, remove"],
      ["dashboard", "status, start"],
      ["agents", "@agent route, sub-runs"],
    ], midWidth),
  ];
  const leftLines = [
    color("MUSTER", "accent"),
    color("agent harness", "dim"),
    " ",
    color(model, "accent"),
    color(cwd, "dim"),
    color(truncate(`Session: ${state.sessionName} (${sessionCounts.here.length} here · ${sessionCounts.all.length} total)`, leftWidth), "dim"),
    color(truncate(`Scope: ${formatChatScopes(scopes)}`, leftWidth), "dim"),
  ];
  const rightLines = [
    color("Commands", "accent"),
    `${color("/help", "highlight")} commands and shortcuts`,
    `${color("/status", "highlight")} model and session`,
    `${color("/sessions", "highlight")} recent chats`,
    `${color("/tools", "highlight")} available tools`,
    `${color("@agent", "highlight")} route a turn`,
    "",
    color("Extensions", "accent"),
    `${color("skills:", "accent")} ${skills.length ? formatSkillList(skillNames, rightWidth - 8) : "none installed"}`,
    `${color("plugins:", "accent")} ${pluginCount ? `${pluginCount} configured` : "none configured"}`,
    `${color("mcp:", "accent")} ${mcpNames.length ? truncate(mcpNames.join(", "), rightWidth - 5) : "no servers"}`,
  ];
  const rows = Math.max(leftLines.length, middleLines.length, rightLines.length);
  console.log(color(`╭${"─".repeat(width - 2)}╮`, "accent"));
  console.log(panelTitle(width, `Muster Agent · ${new Date().toISOString().slice(0, 10)}`));
  for (let index = 0; index < rows; index += 1) {
    const left = visiblePadEnd(leftLines[index] ?? "", leftWidth);
    const middle = visiblePadEnd(middleLines[index] ?? "", midWidth);
    const right = visiblePadEnd(rightLines[index] ?? "", rightWidth);
    console.log(color("│ ", "accent") + left + " ".repeat(gutter) + middle + " ".repeat(gutter) + right + color(" │", "accent"));
  }
  const footer = `${model} · ${providerId} · ${runtimeId} · speed ${state.speedMode ?? "fast"} · scopes ${formatChatScopes(scopes)} · ${formatCompactNumber(8)} tool groups · ${formatCompactNumber(skills.length)} skills · ${formatCompactNumber(pluginCount)} plugins · ${formatCompactNumber(mcpNames.length)} mcp · /help`;
  console.log(color("├" + "─".repeat(width - 2) + "┤", "accent"));
  console.log(color("│ ", "accent") + visiblePadEnd(color(footer, "accent"), width - 4) + color(" │", "accent"));
  console.log(color(`╰${"─".repeat(width - 2)}╯`, "accent"));
  console.log("");
}

/**
 * The single bottom row: `<model> · <session> · <tokens in/out> · $cost ·
 * <elapsed>`, plus the scopes/speed context the compact header no longer
 * repeats. While a turn runs the same row grows a spinner at its left edge
 * (startTuiWorkingStatus) — chrome lives in ONE place now.
 */
async function chatStatusLine(state: ChatState): Promise<string> {
  return formatStatusLine(await chatStatusInfo(state));
}

async function chatStatusInfo(state: ChatState): Promise<Parameters<typeof formatStatusLine>[0]> {
  const config = await loadConfig().catch(() => undefined);
  const runtimeId = state.runtime ?? config?.routing.defaultRuntime ?? "native";
  const runtime = runtimeId ? config?.runtimes[runtimeId] : undefined;
  const providerId = state.provider ?? runtime?.provider ?? "provider";
  const provider = providerId ? config?.providers[providerId] : undefined;
  const model = state.model ?? firstRuntimeModel(runtime) ?? provider?.defaultModel ?? "model";
  const usage = state.usage;
  return {
    model: formatModelStatus(model, state.effortOverride ?? state.configuredEffort),
    session: state.sessionName,
    inputTokens: usage?.inputTokens,
    outputTokens: usage?.outputTokens,
    costUsd: usage?.costUsd,
    elapsedMs: state.startedAt ? Date.now() - state.startedAt : undefined,
    // The row carries only what changes moment to moment: model, session,
    // tokens, cost, elapsed, reasoning tier. Provider/runtime/speed/scopes are
    // stable configuration — /status owns them. Repeating them here was pure
    // noise, and single-scope "scopes user:<me>" doubly so.
    extra: activeChatScopes(state).length > 1 ? [`scopes ${formatChatScopes(activeChatScopes(state))}`] : [],
  };
}

/**
 * `auto→low` after a turn, `auto` before the first one, `high` when pinned.
 * The arrow form is the honest one: `auto` is a policy, the tier after it is
 * what the last turn actually spent.
 */
function chatReasoningTierLabel(state: ChatState): string {
  const preference = state.reasoningTier ?? "auto";
  const last = state.lastReasoning?.split(" · ")[0];
  if (preference !== "auto") return preference;
  return last ? `auto→${last}` : "auto";
}

/** Every completed turn folds into the session totals the status row shows. */
function recordChatUsage(state: ChatState, tokens: { inputTokens?: number; outputTokens?: number; costUsd?: number }): void {
  const usage = state.usage ?? { inputTokens: 0, outputTokens: 0, costUsd: 0, turns: 0 };
  usage.inputTokens += tokens.inputTokens ?? 0;
  usage.outputTokens += tokens.outputTokens ?? 0;
  usage.costUsd += tokens.costUsd ?? 0;
  usage.turns += 1;
  state.usage = usage;
}

async function captureConsoleToSink<T>(fn: () => Promise<T>, sink: MusterChatSink): Promise<T> {
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  const originalClear = console.clear;
  const write = (...values: unknown[]): void => {
    emitEngineOutput(values.map(formatConsoleValue).join(" "), sink);
  };
  console.log = write;
  console.warn = write;
  console.error = write;
  console.clear = () => sink.clearTranscript();
  try {
    return await fn();
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
    console.clear = originalClear;
  }
}

/**
 * The one gate between engine stdout and the TUI transcript (defects #1, #2,
 * #4). A TTY session renders typed events only: run records become a cost
 * chip, recall/timing debug becomes a chip plus a log line, spinner frames go
 * to the status row. Non-TTY output never passes through here, so scripts keep
 * parsing the raw JSON and `memory backend=` lines they always have.
 */
/** Guards against printing two cost chips for one run (proactive + engine echo). */
let lastCostChipRunId: string | undefined;

function emitEngineOutput(text: string, sink: MusterChatSink): void {
  for (const line of String(text).split(/\r?\n/)) {
    const route = routeEngineLine(line);
    switch (route.kind) {
      case "transcript":
        sink.appendLine(route.line);
        break;
      case "status":
        sink.setStatus(route.line);
        break;
      case "cost":
        appendChatDiagnostic(route.log);
        // One chip per run, whoever gets there first.
        if (route.runId && route.runId === lastCostChipRunId) break;
        lastCostChipRunId = route.runId;
        sink.appendLine(route.chip);
        break;
      case "diagnostic":
        appendChatDiagnostic(route.log);
        if (route.chip) sink.appendLine(route.chip);
        break;
    }
  }
}

async function collectConsoleLines(fn: () => Promise<void> | void): Promise<string[]> {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => {
    lines.push(values.map(formatConsoleValue).join(" "));
  };
  try {
    await fn();
  } finally {
    console.log = originalLog;
  }
  return lines.flatMap((line) => line.split(/\r?\n/));
}

/**
 * Defect #6: the launch header defaults to four lines. The ~20-line panel is
 * still one command away (`/header full`) — it is a reference table, not
 * something worth spending half the viewport on every session.
 */
async function buildChatHeaderLines(state: ChatState): Promise<string[]> {
  if ((state.headerMode ?? "compact") === "compact") return buildCompactChatHeaderLines(state);
  return [
    ...renderBanner().split(/\r?\n/).filter((line) => line.length > 0),
    ...(await collectConsoleLines(() => printChatHeader(state))).filter((line) => line.length > 0),
  ];
}

async function buildCompactChatHeaderLines(state: ChatState): Promise<string[]> {
  const config = await loadConfig().catch(() => undefined);
  const runtimeId = state.runtime ?? config?.routing.defaultRuntime ?? "native";
  const runtime = runtimeId ? config?.runtimes[runtimeId] : undefined;
  const providerId = state.provider ?? runtime?.provider ?? "provider";
  const provider = providerId ? config?.providers[providerId] : undefined;
  const sessionCounts = chatSessionsByDirectory();
  return buildCompactHeaderLines({
    session: `${state.sessionName} (${sessionCounts.here.length} here · ${sessionCounts.all.length} total)`,
    cwd: chatWorkspaceCwd(state).replace(process.env.HOME ?? "", "~"),
    scopes: formatChatScopes(activeChatScopes(state)),
    model: formatModelStatus(state.model ?? firstRuntimeModel(runtime) ?? provider?.defaultModel, state.effortOverride ?? state.configuredEffort),
    provider: providerId,
    runtime: runtimeId,
    speed: state.speedMode ?? "fast",
  });
}

function switchChatHeaderMode(args: string, state: ChatState): void {
  const mode = args.trim().toLowerCase();
  if (!mode) {
    console.log(color(`header=${state.headerMode ?? "compact"} — use /header full for the full panel, /header compact for four lines`, "dim"));
    return;
  }
  if (mode !== "full" && mode !== "compact") {
    console.log(color("Usage: /header compact or /header full", "yellow"));
    return;
  }
  state.headerMode = mode;
  console.log(color(`header=${mode}`, "green"));
}

/**
 * Diagnostics belong in a file, not mid-conversation (defect #2). Best effort:
 * a chat turn must never fail because a log line could not be written.
 */
function appendChatDiagnostic(line: string): void {
  try {
    const dir = join(dataDir(), "logs");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, `chat-${new Date().toISOString().slice(0, 10)}.log`), `${new Date().toISOString()} ${line}\n`);
  } catch {
    // A missing/read-only data dir must not break the session.
  }
}

async function refreshChatTuiHeader(state: ChatState): Promise<void> {
  state.statusSink?.setHeaderLines(await buildChatHeaderLines(state));
}

function formatConsoleValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  return String(value);
}

function chatFrameWidth(): number {
  return Math.min(Math.max((process.stdout.columns || 120) - 2, 72), 240);
}

function printChatInputFrame(): void {
  const width = chatFrameWidth();
  console.log(color(`╭─ chat ${"─".repeat(Math.max(1, width - 9))}╮`, "accent"));
  console.log(color("│ ", "dim") + visiblePadEnd(color("type / for commands, @ for agents, Tab completes", "dim"), width - 4) + color(" │", "dim"));
  console.log(color("│ ", "accent") + visiblePadEnd("", width - 4) + color(" │", "accent"));
  console.log(color(`╰${"─".repeat(width - 2)}╯`, "accent"));
  if (process.stdout.isTTY) output.write("\x1b[2A\r");
}

function printChatInputFrameBottom(): void {
  if (process.stdout.isTTY) output.write("\x1b[2B\r");
}

function firstRuntimeModel(runtime: Awaited<ReturnType<typeof loadConfig>>["runtimes"][string] | undefined): string | undefined {
  return runtime?.routes.simple_qa?.model ?? Object.values(runtime?.routes ?? {})[0]?.model;
}

function formatCatalogLines(items: readonly (readonly [string, string])[], width: number): string[] {
  return items.map(([name, value]) => `${color(`${name}:`, "accent")} ${truncate(value, Math.max(12, width - name.length - 3))}`);
}

function formatSkillLines(names: readonly string[], width: number): string[] {
  if (!names.length) return [color("No active skills found.", "dim")];
  const lines: string[] = [];
  let current = "";
  for (const name of names) {
    const next = current ? `${current}, ${name}` : name;
    if (stripAnsi(next).length > width - 2) {
      lines.push(truncate(current, width));
      current = name;
    } else {
      current = next;
    }
  }
  if (current) lines.push(truncate(current, width));
  return lines.slice(0, 5);
}

function formatSkillList(names: readonly string[], width: number): string {
  return truncate(names.join(", "), Math.max(12, width));
}

function panelTitle(width: number, title: string): string {
  const text = ` ${title} `;
  const left = Math.max(1, Math.floor((width - 2 - stripAnsi(text).length) / 2));
  const right = Math.max(1, width - 2 - left - stripAnsi(text).length);
  return color("│", "accent") + color("─".repeat(left), "accent") + color(text, "accent") + color("─".repeat(right), "accent") + color("│", "accent");
}

function visiblePadEnd(value: string, width: number): string {
  const visible = stripAnsi(value).length;
  return value + " ".repeat(Math.max(0, width - visible));
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

function handleChatDecisionKey(data: string, state: ChatState, sink?: MusterChatSink): boolean {
  const menu = state.pendingMenu;
  if (!menu || menu.kind === "commands" || menu.kind === "agents") return false;
  if (menu.kind === "workspace-mismatch") {
    const choice = workspaceMismatchChoiceForKey(data);
    if (!choice) return false;
    state.pendingMenu = undefined;
    state.sessionName = menu.sessionName;
    state.workspaceCwd = workspaceOverrideForMismatchChoice(menu.workspaceCwd, choice);
    void refreshChatTuiHeader(state);
    return true;
  }
  if (menu.kind !== "parallel-tasks") return false;

  const choice = parallelTaskChoiceForKey(data);
  state.pendingMenu = undefined;
  const run = async (): Promise<void> => {
    state.statusSink = sink;
    try {
      if (choice === "tasks") {
        const parsed = parseOrchestrationInvocation("tasks", menu.prompt);
        if (parsed) await runOrchestrationCommand(parsed, chatOrchestrationDeps(state));
      } else {
        await runChatTurn(menu.prompt, state);
      }
    } finally {
      state.statusSink = undefined;
    }
  };
  void (sink ? captureConsoleToSink(run, sink) : run()).catch((error) => {
    emitChatLine(state, color(error instanceof Error ? error.message : String(error), "yellow"));
  });
  return true;
}

async function handleChatInput(text: string, state: ChatState): Promise<boolean> {
  const capabilityCommand = parseCapabilityConfirmation(text);
  if (capabilityCommand) {
    await runConfirmedCapabilityCommand(capabilityCommand.command, capabilityCommand.args);
    return true;
  }
  const suggested = state.pendingSuggestion;
  state.pendingSuggestion = undefined;
  if (text === "/" || text === "@") {
    state.pendingMenu = text === "/"
      ? { kind: "commands", options: chatCommands(state).map((command) => command.name) }
      : { kind: "agents", options: await chatAgentOptions() };
    if (text === "/") printChatCommandCatalog({ numbered: true }, state);
    else await printChatAgents({ numbered: true });
    return true;
  }
  if (suggested && text === suggested.value) {
    if (suggested.kind === "command") return handleChatCommand(suggested.value, state);
    if (suggested.kind === "completion") {
      console.log(color(`selected ${suggested.value}`, "dim"));
      return true;
    }
    if (suggested.kind === "agent") {
      console.log(color(`selected ${suggested.value}. Type ${suggested.value} <task> to route a turn.`, "dim"));
      return true;
    }
  }
  const selected = await handlePendingChatMenu(text, state);
  if (selected !== undefined) return selected;
  state.pendingMenu = undefined;
  if (text.startsWith("/")) return handleChatCommand(text, state);
  if (state.interactive && isParallelWorkPrompt(text)) {
    state.pendingMenu = { kind: "parallel-tasks", prompt: text };
    console.log(color("run as parallel tasks? [enter] yes · [esc] single turn", "dim"));
    return true;
  }
  await runChatTurn(text, state);
  return true;
}

async function handlePendingChatMenu(text: string, state: ChatState): Promise<boolean | undefined> {
  const menu = state.pendingMenu;
  if (!menu || menu.kind === "parallel-tasks" || menu.kind === "workspace-mismatch") return undefined;
  if (menu.kind === "codex-sessions" && text.trim().toLowerCase() === "a") {
    await openCodexSessionPicker(state, !menu.includeAll);
    return true;
  }
  const index = Number(text);
  if (!Number.isInteger(index) || index < 1 || index > menu.options.length) {
    if (text.startsWith("/") || text.startsWith("@")) {
      state.pendingMenu = undefined;
      return undefined;
    }
    console.log(color(`Invalid selection. Type 1-${menu.options.length}, or type /commands to browse commands.`, "yellow"));
    return true;
  }
  state.pendingMenu = undefined;
  const selected = menu.options[index - 1];
  if (menu.kind === "commands" || menu.kind === "codex-sessions") return handleChatCommand(`/${selected}`, state);
  console.log(color(`selected @${selected}. Type @${selected} <task> to route a turn.`, "dim"));
  return true;
}

async function handleChatCommand(text: string, state: ChatState): Promise<boolean> {
  const [nameWithSlash, ...rest] = text.split(/\s+/);
  const rawName = nameWithSlash.slice(1).toLowerCase();
  const name = CHAT_COMMAND_ALIASES.get(rawName) ?? rawName;
  const args = rest.join(" ").trim();
  switch (name) {
    case "exit":
    case "quit":
    case "q":
      console.log(color("bye", "dim"));
      return false;
    case "help":
      printChatCommandCatalog({ all: args.trim().toLowerCase() === "all" }, state);
      if (args.trim().toLowerCase() === "all") printChatShortcuts();
      return true;
    case "commands":
      printChatCommandCatalog({ all: true }, state);
      return true;
    case "shortcuts":
      printChatShortcuts();
      return true;
    case "status":
      await printChatStatus(state);
      return true;
    case "providers":
    case "provider-list":
      await printChatProviders();
      return true;
    case "cloud":
      await cloudChatProvider(args, state);
      return true;
    case "provider":
    case "use-provider":
      await switchChatProvider(args, state);
      return true;
    case "model":
      await switchChatModel(args, state);
      return true;
    case "runtime":
      await switchChatRuntime(args, state);
      return true;
    case "speed":
      switchChatSpeed(args, state);
      return true;
    case "live-diff":
      toggleChatLiveDiff(args, state);
      return true;
    case "diff":
      if (state.statusSink) state.statusSink.toggleLiveDiff();
      else for (const line of renderLiveFilePlain(state.liveFileTurn ?? new LiveFileTurnAccumulator())) console.log(line);
      return true;
    case "tasks":
    case "mission":
    case "board":
    case "kanban":
    case "why":
    case "assign": {
      // The kanban engine's only user surface: orchestration is invoked from the
      // conversation, and every card it prints comes back out of the event log.
      const taskParts = args.trim().split(/\s+/).filter(Boolean);
      if (name === "tasks" && taskParts[0] === "why" && taskParts.length === 1) {
        await openTaskArgumentPicker(state, "why");
        return true;
      }
      if (name === "tasks" && taskParts[0] === "assign" && taskParts.length <= 2) {
        await openTaskArgumentPicker(state, "assign", taskParts[1]);
        return true;
      }
      if (state.statusSink && name === "tasks" && (!args.trim() || args.trim() === "board")) {
        const opened = await state.statusSink.openBoard(args.trim() === "board");
        if (opened) {
          if (!args.trim()) emitChatLine(state, color("[b] board", "dim"));
          return true;
        }
      }
      const parsed = parseOrchestrationInvocation(name === "kanban" ? "board" : name, args);
      if (parsed) await runOrchestrationCommand(parsed, chatOrchestrationDeps(state));
      return true;
    }
    case "reasoning":
      await switchChatReasoningMode(args, state);
      return true;
    case "senses":
      await printChatSenses();
      return true;
    case "header":
      switchChatHeaderMode(args, state);
      await refreshChatTuiHeader(state);
      return true;
    case "sessions":
    case "resume-list":
      printChatSessions(readNumberFromText(args) ?? 15, args.split(/\s+/).includes("--all"));
      return true;
    case "resume":
      if (!args) {
        openNamedSessionPicker(state, "resume");
        return true;
      }
      selectChatSessionForResume(args, state);
      return true;
    case "codex": {
      const [sub, ...restArgs] = args.split(/\s+/).filter(Boolean);
      if (!sub) {
        await openCodexSessionPicker(state, false);
        return true;
      }
      if (sub === "--all" || sub === "all") {
        await openCodexSessionPicker(state, true);
        return true;
      }
      if (sub === "sessions" || sub === "list") {
        await codexSessionsCommand(restArgs.length === 1 && /^\d+$/.test(restArgs[0]!) ? ["--limit", restArgs[0]!] : restArgs);
        return true;
      }
      if (sub === "resume" && restArgs[0]) {
        try {
          const forked = restArgs.includes("--fork");
          const { session, imported } = await importCodexThreadByPrefix(restArgs[0], restArgs.slice(1));
          // FULL thread id: codex ids are UUIDv7, so an 8-char prefix is a
          // ~65-second TIMESTAMP window — threads created in the same minute
          // collided into one muster session (the owner's fluence chats
          // appearing under redis-automation). Identity must never truncate.
          state.sessionName = safeChatSessionName(`codex-${session.threadId}`);
          state.resumeThreadId = forked ? undefined : session.threadId;
          state.importedFromCodex = true;
          state.sessionWorkspaceCwd = session.cwd || process.cwd();
          // The native thread edits ITS OWN repo regardless of where muster
          // runs — the diff observer must watch there by default, or resumed
          // threads' code changes are invisible (owner-reported). The banner's
          // "[c] continue here" still overrides.
          state.workspaceCwd = session.cwd || process.cwd();
          const workspace = session.cwd && session.cwd !== process.cwd() ? session.cwd : undefined;
          ensureNamedChatSession(state.sessionName, workspace ?? process.cwd());
          console.log("");
          console.log(color(`codex: ${session.threadName ?? session.threadId} → session ${state.sessionName}`, "green"));
          console.log(color(`imported ${imported.appended} new message(s); your next message continues the native thread`, "dim"));
          appendImportedHistory(state.statusSink, imported.sessionId, session.threadName ?? `codex ${session.threadId}`);
          if (workspace) {
            state.pendingMenu = { kind: "workspace-mismatch", sessionName: state.sessionName, workspaceCwd: workspace };
            console.log(color(formatWorkspaceMismatchBanner(workspace), "dim"));
          }
        } catch (error) {
          console.log(color(error instanceof Error ? error.message : String(error), "yellow"));
        }
        return true;
      }
      console.log(color("Usage: /codex sessions [limit]  or  /codex resume <thread-id-prefix>", "yellow"));
      return true;
    }
    case "name":
      if (!args) {
        openNamedSessionPicker(state, "name");
        return true;
      }
      state.sessionName = safeChatSessionName(args);
      state.sessionWorkspaceCwd = chatWorkspaceCwd(state);
      ensureNamedChatSession(state.sessionName, chatSessionWorkspaceCwd(state));
      console.log(color(`session=${state.sessionName}`, "green"));
      return true;
    case "history":
      printChatHistory(state.sessionName, args ? Number(args) || 40 : 40, chatSessionWorkspaceCwd(state));
      return true;
    case "memory":
      await printChatMemory(args, state);
      return true;
    case "scope":
      await updateChatScopes(args, state);
      return true;
    case "scopes":
      printChatScopes(state);
      return true;
    case "tools":
      if (!args && state.statusSink) {
        state.statusSink.openPicker("/tools ");
        return true;
      }
      await printChatTools(args, args.trim().toLowerCase() === "all");
      return true;
    case "whoami":
      printChatControlView("Identity", [
        ["Profile", activeProfile()],
        ["Session", state.sessionName],
        ["Runtime", state.runtime ?? "default"],
        ["Memory scopes", state.scopes.length ? state.scopes.map((scope) => `${scope.kind}:${scope.id}`).join(", ") : "session only"],
      ], [
        "When this chat is paired through a channel, Frappe User and Employee identity are resolved at the gateway.",
        "Frappe-aware tools use that identity to decide which records, reports, and actions are visible.",
      ]);
      return true;
    case "reports":
      printChatControlView("Reports", [
        ["Table controls", "filter, group, sort, drill down, export"],
        ["Output types", "summary, table, Excel, PDF, report pack"],
        ["Frappe links", "record links are attached after read/write actions"],
        ["Follow-ups", "date range, department, employee, status, owner, company, branch"],
      ], [
        "Reports should start with the smallest allowed dataset, then let the user deep-dive without repeating context.",
        "For channel users, managers and HRBPs see team/hierarchy reports only when their resolved Frappe permissions allow it.",
      ]);
      return true;
    case "capabilities":
    case "capability":
    case "caps":
      await printChatCapabilities(args, state);
      return true;
    case "skills":
    case "skill":
      await printChatSkills(args, state);
      return true;
    case "plugins":
    case "plugin":
      await printChatPlugins(args, state);
      return true;
    case "mcp":
      await printChatMcp(args, state);
      return true;
    case "integrations":
    case "integration":
      await printChatIntegrations(args, state);
      return true;
    case "agents":
      await printChatAgents();
      return true;
    case "tokens":
    case "usage":
    case "ledger":
      console.log(renderTokenTable(await listTokenRecords(), args ? Number(args) || 20 : 20));
      return true;
    case "limits":
      printChatControlView("Limits", [
        ["Scopes", "user, role, channel, department, agent, tenant"],
        ["Budgets", "requests, tokens, artifacts, tool calls"],
        ["Workflow", "preview impact before applying changes"],
      ], ["Use this for enterprise controls; exact mutation should be gated by role and approval in connected channels."]);
      return true;
    case "security":
      printChatControlView("Security", [
        ["Pairing", "required before channel runs"],
        ["Frappe RBAC", "Frappe remains the authorization authority"],
        ["Writes", "permission preflight, preview, approval, verification"],
        ["Audit", "token ledger, run ledger, document links, denied actions"],
      ], ["If an action is not possible, the response should explain the exact reason and offer safe next steps."]);
      return true;
    case "evals":
      printChatControlView("Evals", [
        ["Permissions", "record visibility and hierarchy scope"],
        ["CRUD", "mandatory fields, property setters, workflow transitions"],
        ["Reports", "filters, totals, exports, document links"],
        ["Security", "blocked prompts, leakage checks, approval gates"],
      ], ["Promote department assistants and response profiles only after evals pass."]);
      return true;
    case "index":
      printChatControlView("Index", [
        ["Hot sync", "recent operational changes"],
        ["Metadata", "DocTypes, fields, property setters, workflows"],
        ["Permissions", "roles, employees, reporting hierarchy"],
        ["Deep sync", "attachments, policies, SOPs"],
      ], ["The fast path should use indexed/read-model answers first and call Frappe live only when needed."]);
      return true;
    case "settings":
      printChatControlView("Settings", [
        ["Response style", "concise, table-first, manager summary, audit-heavy"],
        ["Default format", "direct answer, table, report pack, artifact"],
        ["Safety level", "strict, balanced, read-only, approval-required"],
      ], ["Department/team settings should preview impact before saving and stay permission-gated."]);
      return true;
    case "goal":
    case "receipt":
      await printGoalStatus(args ? Number(args) || 5 : 5);
      return true;
    case "new": {
      state.sessionName = safeChatSessionName(args || `chat-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`);
      state.sessionWorkspaceCwd = chatWorkspaceCwd(state);
      const removed = await clearConversationSessionHandles(chatConversationKey(state.sessionName));
      ensureNamedChatSession(state.sessionName, chatSessionWorkspaceCwd(state));
      console.log(color(`session=${state.sessionName} provider_handles_cleared=${removed}`, "green"));
      return true;
    }
    case "reset": {
      const removed = await clearConversationSessionHandles(chatConversationKey(state.sessionName));
      clearCodexAppServerConversation(chatConversationKey(state.sessionName), "cli-chat");
      console.log(color(`provider_handles_cleared=${removed}`, "green"));
      return true;
    }
    case "clear":
      console.clear();
      return true;
    default:
      {
        const plugin = directPluginCommand(name, args, state.dynamicCommands ?? []);
        if (plugin?.kind === "insert") {
          if (state.statusSink) state.statusSink.openPicker(plugin.text);
          else console.log(plugin.text);
          return true;
        }
        if (plugin?.kind === "prompt") {
          await runChatTurn(plugin.text, state);
          return true;
        }
        const names = chatCommands(state).flatMap((entry) => [entry.name, ...(entry.aliases ?? [])]);
        console.log(color(unknownSlashCommandMessage(rawName, names), "dim"));
      }
      return true;
  }
}

/** The commands a daily driver actually reaches for; the rest live behind /help all. */
const CHAT_DAILY_COMMANDS = ["mission", "board", "codex", "tools", "mcp", "plugins", "model", "reasoning", "sessions", "resume", "memory", "diff", "live-diff", "exit"] as const;

/** Same catalog, dailies first — the ordering every completion surface uses. */
function chatCommandsDailyFirst(state?: ChatState): readonly ChatCommandDef[] {
  const commands = chatCommands(state);
  const daily = commands.filter((command) => (CHAT_DAILY_COMMANDS as readonly string[]).includes(command.name) || command.plugin);
  const rest = commands.filter((command) => !(CHAT_DAILY_COMMANDS as readonly string[]).includes(command.name) && !command.plugin);
  return [...daily, ...rest];
}

function printChatCommandCatalog(options: { numbered?: boolean; all?: boolean } = {}, state?: ChatState): void {
  const commands = chatCommands(state);
  const daily = commands.filter((command) => (CHAT_DAILY_COMMANDS as readonly string[]).includes(command.name) || command.plugin);
  const rest = commands.filter((command) => !(CHAT_DAILY_COMMANDS as readonly string[]).includes(command.name) && !command.plugin);
  const list = options.all || options.numbered ? commands : daily;
  printChatPanel("Commands", list.map((command, index) => {
    const aliases = command.aliases?.length ? ` (${command.aliases.map((alias) => `/${alias}`).join(", ")})` : "";
    const prefix = options.numbered ? `${color(`${String(index + 1).padStart(2)}.`, "accent")} ` : "";
    return `${prefix}${color(command.usage.padEnd(20), "highlight")} ${command.description}${color(aliases, "dim")}`;
  }));
  if (!options.all && !options.numbered && rest.length) {
    console.log(color(`… ${rest.length} more: ${rest.map((command) => `/${command.name}`).join(" ")} — /help all for details`, "dim"));
  }
  if (options.numbered) console.log(color("Type a number to run a command, or type the slash command directly.", "dim"));
}

function printChatShortcuts(): void {
  printChatPanel("Shortcuts", [
    `${color("Tab".padEnd(18), "highlight")} complete slash commands, toolsets, and session names`,
    `${color("@agent <task>".padEnd(18), "highlight")} route a turn with an agent id`,
    `${color("\\ at line end".padEnd(18), "highlight")} continue multiline input`,
    `${color("Ctrl+D".padEnd(18), "highlight")} toggle the current turn's full-file live view`,
  ]);
}

function printChatControlView(
  title: string,
  rows: readonly (readonly [string, string])[],
  notes: readonly string[] = [],
): void {
  printChatPanel(title, [
    ...rows.map(([label, value]) => `${color(label.padEnd(18), "highlight")} ${value}`),
    ...(notes.length ? ["", ...notes.map((note) => color(note, "dim"))] : []),
  ]);
}

function chatCompleter(line: string): [string[], string] {
  return [chatCompletions(line), line];
}

function chatCompletions(line: string): string[] {
  const trimmed = line.trimStart();
  if (!trimmed.startsWith("/")) return [];
  const parts = trimmed.split(/\s+/);
  if (parts.length <= 1 && !trimmed.endsWith(" ")) {
    const fragment = trimmed.slice(1).toLowerCase();
    return CHAT_COMMAND_NAMES.filter((name) => name.startsWith(fragment)).map((name) => `/${name}`);
  }
  const command = CHAT_COMMAND_ALIASES.get(parts[0].slice(1).toLowerCase()) ?? parts[0].slice(1).toLowerCase();
  const fragment = parts.at(-1)?.toLowerCase() ?? "";
  if (command === "tools") {
    return CHAT_TOOLSETS.filter((toolset) => toolset.startsWith(fragment));
  }
  if (command === "capabilities" || command === "capability" || command === "caps") {
    return filterPickerOptions([
      ...chatSkillOptions(),
      ...CHAT_PLUGIN_OPTIONS,
      ...CHAT_MCP_OPTIONS,
    ], fragment).map((option) => option.value);
  }
  if (command === "resume" || command === "name") {
    return recentChatSessionNames().filter((name) => name.toLowerCase().startsWith(fragment));
  }
  if (command === "skills" || command === "skill") {
    return filterPickerOptions(chatSkillOptions(), fragment).map((skill) => skill.value);
  }
  if (command === "plugins" || command === "plugin") {
    const lower = fragment.toLowerCase();
    return CHAT_PLUGIN_OPTIONS
      .map((option, index) => ({ option, index, rank: pickerMatchRank(option, lower) }))
      .filter((entry) => entry.rank < Number.POSITIVE_INFINITY)
      .sort((left, right) => left.rank - right.rank || left.index - right.index)
      .map((entry) => entry.option.value);
  }
  if (command === "mcp") {
    return filterPickerOptions(CHAT_MCP_OPTIONS, fragment).map((server) => server.value);
  }
  if (command === "integrations" || command === "integration") {
    const workflowOnly = parts[1]?.toLowerCase() === "workflow";
    return filterPickerOptions([
      ...(workflowOnly ? chatIntegrationWorkflowOptions() : chatIntegrationOptions()),
    ], fragment).map((integration) => integration.value);
  }
  return [];
}

async function chatTuiCompletions(line: string, state: ChatState): Promise<string[]> {
  await ensureDefaultConfig();
  await initializeChatComposerState(state);
  // `--complete` is a script surface. Keep its historical plain toolset values;
  // encoded interactive actions belong only inside the pi-tui editor.
  if (/^\/tools(?:\s+\S*)?$/i.test(line.trimStart())) return chatCompletions(line);
  const provider = createMusterAutocompleteProvider({
    commands: chatCommandsDailyFirst(state),
    toolsets: CHAT_TOOLSETS,
    recentSessions: recentChatSessionNames,
    catalog: createChatCompletionCatalog(state),
    agents: chatAgentOptions,
  });
  const suggestions = await provider.getSuggestions([line], 0, line.length, { signal: new AbortController().signal });
  return suggestions?.items.map((item) => item.value) ?? [];
}

async function renderLiveSuggestions(
  rl: Interface,
  state: ChatState,
  hintState: { visible: boolean; key: string; active: boolean; baseLine: string; selectedIndex: number; suggestions: ChatSuggestion[]; renderSeq: number },
  keyName?: string,
): Promise<void> {
  if (!hintState.active || !process.stdout.isTTY) return;
  const renderSeq = ++hintState.renderSeq;
  const isArrow = keyName === "up" || keyName === "down";
  const baseLine = isArrow && hintState.visible ? hintState.baseLine : rl.line;
  const suggestions = isArrow && hintState.visible ? hintState.suggestions : await liveSuggestions(baseLine, state);
  if (renderSeq !== hintState.renderSeq || !hintState.active) return;
  if (!suggestions.length) {
    state.pendingSuggestion = undefined;
    clearLiveSuggestions(hintState);
    return;
  }
  if (isArrow) {
    const direction = keyName === "up" ? -1 : 1;
    hintState.selectedIndex = (hintState.selectedIndex + direction + suggestions.length) % suggestions.length;
  } else if (baseLine !== hintState.baseLine) {
    hintState.selectedIndex = 0;
  }
  const width = Math.min(Math.max((process.stdout.columns || 100) - 8, 56), 110);
  const visibleSuggestions = suggestions.slice(0, 24);
  hintState.selectedIndex = Math.min(hintState.selectedIndex, visibleSuggestions.length - 1);
  const selected = visibleSuggestions[hintState.selectedIndex];
  state.pendingSuggestion = { baseLine, value: selected.value, kind: selected.kind };
  if (isArrow) {
    replaceReadlineLine(rl, selected.value);
  }
  const panel = renderSuggestionPanel(width, visibleSuggestions, hintState.selectedIndex);
  const key = `${baseLine}\n${hintState.selectedIndex}\n${panel}`;
  if (hintState.key === key) return;
  output.write(`\x1b[3B\r\n${panel}`);
  hintState.visible = true;
  hintState.key = key;
  hintState.baseLine = baseLine;
  hintState.suggestions = suggestions;
  if (!hintState.active) return;
  rl.prompt(true);
}

function clearLiveSuggestions(hintState: { visible: boolean; key: string; active?: boolean; baseLine?: string; selectedIndex?: number; suggestions?: ChatSuggestion[] }): void {
  if ("renderSeq" in hintState && typeof hintState.renderSeq === "number") hintState.renderSeq += 1;
  hintState.visible = false;
  hintState.key = "";
  hintState.baseLine = "";
  hintState.selectedIndex = 0;
  hintState.suggestions = [];
}

async function liveSuggestions(line: string, state: ChatState): Promise<ChatSuggestion[]> {
  const trimmed = line.trimStart();
  if (trimmed === "/" || (/^\/[a-z-]*$/i.test(trimmed) && !isBareContextualPickerCommand(trimmed))) {
    const fragment = trimmed.slice(1).toLowerCase();
    return chatCommands(state)
      .filter((command) => command.name.startsWith(fragment) || command.aliases?.some((alias) => alias.startsWith(fragment)))
      .map((command) => ({
        label: `${color(command.usage.padEnd(20), "highlight")} ${command.description}`,
        value: `/${command.name}`,
        kind: "command" as const,
      }));
  }
  if (/^\/tools(?:\s+\S*)?$/i.test(trimmed)) {
    const fragment = trimmed.includes(" ") ? trimmed.split(/\s+/).at(-1)?.toLowerCase() ?? "" : "";
    return CHAT_TOOLSETS
      .filter((toolset) => toolset.startsWith(fragment))
      .map((toolset) => ({
        label: `${color(toolset.padEnd(20), "highlight")} toolset`,
        value: `/tools ${toolset}`,
        kind: "completion" as const,
      }));
  }
  if (/^\/(?:capabilities|capability|caps)(?:\s+\S*)?$/i.test(trimmed)) {
    const fragment = trimmed.includes(" ") ? trimmed.split(/\s+/).at(-1)?.toLowerCase() ?? "" : "";
    return filterPickerOptions([
      ...chatSkillOptions(),
      ...await chatPluginOptions(),
      ...await chatMcpOptions(),
    ], fragment)
      .slice(0, 24)
      .map((capability) => ({
        label: `${color(capability.value.padEnd(28), "highlight")} ${capability.description ?? "capability"}`,
        value: `/capabilities ${capability.value}`,
        kind: "completion" as const,
      }));
  }
  if (/^\/(?:resume|name)(?:\s+\S*)?$/i.test(trimmed)) {
    const command = trimmed.split(/\s+/)[0] ?? "/resume";
    const fragment = trimmed.includes(" ") ? trimmed.split(/\s+/).at(-1)?.toLowerCase() ?? "" : "";
    return recentChatSessionNames()
      .filter((name) => name.toLowerCase().startsWith(fragment))
      .map((name) => ({
        label: `${color(name.padEnd(20), "highlight")} chat session`,
        value: `${command} ${name}`,
        kind: "completion" as const,
      }));
  }
  if (/^\/(?:provider|use-provider)(?:\s+\S*)?$/i.test(trimmed)) {
    const fragment = trimmed.includes(" ") ? trimmed.split(/\s+/).at(-1)?.toLowerCase() ?? "" : "";
    return filterPickerOptions(await chatProviderOptions(state), fragment)
      .slice(0, 24)
      .map((provider) => ({
        label: `${color(provider.value.padEnd(28), "highlight")} ${provider.description ?? "provider"}`,
        value: `/provider ${provider.value}`,
        kind: "completion" as const,
      }));
  }
  if (/^\/model(?:\s+\S*)?$/i.test(trimmed)) {
    const fragment = trimmed.includes(" ") ? trimmed.split(/\s+/).at(-1)?.toLowerCase() ?? "" : "";
    return filterPickerOptions(await chatModelOptions(state.provider, state), fragment)
      .slice(0, 24)
      .map((model) => ({
        label: `${color(model.value.padEnd(28), "highlight")} ${model.description ?? "model"}`,
        value: `/model ${model.value}`,
        kind: "completion" as const,
      }));
  }
  if (/^\/runtime(?:\s+\S*)?$/i.test(trimmed)) {
    const fragment = trimmed.includes(" ") ? trimmed.split(/\s+/).at(-1)?.toLowerCase() ?? "" : "";
    return filterPickerOptions(await chatRuntimeOptions(state), fragment)
      .slice(0, 24)
      .map((runtime) => ({
        label: `${color(runtime.value.padEnd(28), "highlight")} ${runtime.description ?? "runtime"}`,
        value: `/runtime ${runtime.value}`,
        kind: "completion" as const,
      }));
  }
  if (/^\/cloud(?:\s+\S*)?$/i.test(trimmed)) {
    const fragment = trimmed.includes(" ") ? trimmed.split(/\s+/).at(-1)?.toLowerCase() ?? "" : "";
    return filterPickerOptions(chatCloudOptions(), fragment)
      .slice(0, 24)
      .map((cloud) => ({
        label: `${color(cloud.value.padEnd(28), "highlight")} ${cloud.description ?? "cloud preset"}`,
        value: `/cloud ${cloud.value}`,
        kind: "completion" as const,
      }));
  }
  if (/^\/speed(?:\s+\S*)?$/i.test(trimmed)) {
    const fragment = trimmed.includes(" ") ? trimmed.split(/\s+/).at(-1)?.toLowerCase() ?? "" : "";
    return filterPickerOptions(chatSpeedOptions(state.speedMode ?? "fast"), fragment)
      .slice(0, 24)
      .map((speed) => ({
        label: `${color(speed.value.padEnd(28), "highlight")} ${speed.description ?? "speed mode"}`,
        value: `/speed ${speed.value}`,
        kind: "completion" as const,
      }));
  }
  if (/^\/skills?\s+\S*$/i.test(trimmed) || /^\/skills?$/i.test(trimmed)) {
    const fragment = trimmed.includes(" ") ? trimmed.split(/\s+/).at(-1)?.toLowerCase() ?? "" : "";
    return filterPickerOptions(chatSkillOptions(), fragment)
      .slice(0, 24)
      .map((skill) => ({
        label: `${color(skill.value.padEnd(28), "highlight")} ${skill.description ?? "built-in skill"}`,
        value: `/skills ${skill.value}`,
        kind: "completion" as const,
      }));
  }
  if (/^\/plugins?\s+reuse(?:\s+\S*)?$/i.test(trimmed)) {
    const fragment = trimmed.split(/\s+/).length > 2 ? trimmed.split(/\s+/).at(-1)?.toLowerCase() ?? "" : "";
    return (await chatReuseProviderOptions())
      .filter((provider) => !fragment || provider.value.toLowerCase().startsWith(fragment) || provider.description?.toLowerCase().includes(fragment))
      .slice(0, 24)
      .map((provider) => ({
        label: `${color(provider.value.padEnd(28), "highlight")} ${provider.description ?? "provider plugin cache"}`,
        value: `/plugins reuse ${provider.value}`,
        kind: "completion" as const,
      }));
  }
  if (/^\/plugins?\s+\S*$/i.test(trimmed) || /^\/plugins?$/i.test(trimmed)) {
    const fragment = trimmed.includes(" ") ? trimmed.split(/\s+/).at(-1)?.toLowerCase() ?? "" : "";
    return filterPickerOptions(await chatPluginOptions(), fragment)
      .slice(0, 24)
      .map((plugin) => ({
        label: `${color(plugin.value.padEnd(28), "highlight")} ${plugin.description ?? "built-in plugin"}`,
        value: `/plugins ${plugin.value}`,
        kind: "completion" as const,
      }));
  }
  if (/^\/mcp\s+\S*$/i.test(trimmed) || /^\/mcp$/i.test(trimmed)) {
    const fragment = trimmed.includes(" ") ? trimmed.split(/\s+/).at(-1)?.toLowerCase() ?? "" : "";
    return filterPickerOptions(await chatMcpOptions(), fragment)
      .slice(0, 24)
      .map((server) => ({
        label: `${color(server.value.padEnd(28), "highlight")} ${server.description ?? "MCP server"}`,
        value: `/mcp ${server.value}`,
        kind: "completion" as const,
      }));
  }
  if (/^\/integrations?(?:\s+(?:workflow|setup|verify|enable|sample))?(?:\s+\S*)?$/i.test(trimmed)) {
    const parts = trimmed.split(/\s+/).filter(Boolean);
    const fragment = parts.length > 1 ? parts.at(-1)?.toLowerCase() ?? "" : "";
    const subAction = parts[1]?.toLowerCase();
    const workflowOnly = subAction === "workflow" || subAction === "setup" || subAction === "verify" || subAction === "enable" || subAction === "sample";
    return filterPickerOptions(workflowOnly ? chatIntegrationWorkflowOptions() : chatIntegrationOptions(), workflowOnly && parts.length <= 2 ? "" : fragment)
      .slice(0, 24)
      .map((integration) => ({
        label: `${color(integration.value.padEnd(28), "highlight")} ${integration.description ?? "integration workflow"}`,
        value: workflowOnly ? `/integrations ${subAction} ${integration.value}` : `/integrations ${integration.value}`,
        kind: "completion" as const,
      }));
  }
  if (trimmed === "@" || /^@[a-zA-Z0-9_.:-]*$/.test(trimmed)) {
    const fragment = trimmed.slice(1).toLowerCase();
    const config = await loadConfig().catch(() => undefined);
    const namedAgents = config?.agents?.list?.map((agent) => agent.id) ?? [];
    const runtimeAgents = Object.keys(config?.runtimes ?? {});
    const suggested = ["research", "debug", "review", "frappe", ...runtimeAgents, ...namedAgents];
    return [...new Set(suggested)]
      .filter((agent) => agent.toLowerCase().startsWith(fragment))
      .map((agent) => ({
        label: `${color(`@${agent}`.padEnd(20), "highlight")} route this turn`,
        value: `@${agent}`,
        kind: "agent" as const,
      }));
  }
  return [];
}

function isBareContextualPickerCommand(trimmed: string): boolean {
  return /^\/(?:tools|resume|name|provider|use-provider|model|runtime|cloud|speed|capabilities|capability|caps|skills?|plugins?|mcp|integrations?)$/i.test(trimmed);
}

function renderSuggestionPanel(width: number, suggestions: readonly ChatSuggestion[], selectedIndex: number): string {
  const lines = [
    color(`╭─ suggestions ${"─".repeat(Math.max(1, width - 15))}╮`, "dim"),
    ...suggestions.map((suggestion, index) => {
      const marker = index === selectedIndex ? color("› ", "highlight") : "  ";
      const row = `${marker}${suggestion.label}`;
      const content = index === selectedIndex
        ? color(visiblePadEnd(stripAnsi(row), width - 4), "selection")
        : visiblePadEnd(row, width - 4);
      return color("│ ", "accent") + content + color(" │", "accent");
    }),
    color(`╰${"─".repeat(width - 2)}╯`, "accent"),
  ];
  return `${lines.join("\n")}\n`;
}

async function runChatTurn(text: string, state: ChatState, options: { timeoutMs?: number; keepAlive?: boolean } = {}): Promise<void> {
  await ensureDefaultConfig();
  await initializeChatComposerState(state);
  const routed = parseAgentMention(text);
  const prompt = routed ? routed.prompt : text;
  const agentId = routed?.agentId;
  const loadedConfig = await loadConfig();
  // Reasoning economy: `executeRun` takes the config BY VALUE, so this turn runs
  // against a per-turn copy whose route for the classified task kind carries the
  // decided tier. Nothing is written back — `/reasoning` is a session control,
  // not a config edit. See core/src/reasoning-economy.ts for the direction rule.
  const config = applyChatEffort(loadedConfig, state, prompt);
  state.lastReasoning = activeChatProvider(state) === "codex"
    ? effortDisplayLabel(state.effortOverride ?? state.configuredEffort ?? "medium")
    : "Extended thinking";
  const mentionedCapabilities = await printMentionedCapabilityChecks(prompt, config, { interactive: Boolean(state.statusSink) });
  // The turn SHOWS its own edits: every observed workspace patch becomes a diff
  // card in the transcript while the run streams (docs/STRATEGY_V2.md §9).
  const workspaceCwd = chatWorkspaceCwd(state);
  const liveFileTurn = new LiveFileTurnAccumulator();
  state.liveFileTurn = liveFileTurn;
  state.statusSink?.setLiveDiffTurn(liveFileTurn);
  const liveDiff = await startLiveDiffFeed({
    cwd: workspaceCwd,
    emit: (line) => emitChatLine(state, line),
    enabled: liveDiffEnabled(state),
    onPatch: (event) => {
      let currentContent = "";
      try {
        currentContent = readFileSync(resolve(event.root, event.path), "utf8");
      } catch {
        // A deletion has no current file; its after-state is the empty document.
      }
      liveFileTurn.add(event, currentContent);
      state.statusSink?.updateLiveDiff(liveFileTurn);
    },
  });
  // Consumed by THIS turn only: once the run completes, executeRun has stored a
  // session handle for the conversation and every later turn resumes from that.
  const resumeThreadId = state.resumeThreadId;
  state.resumeThreadId = undefined;
  const stopWorking = state.statusSink
    ? startTuiWorkingStatus(state.statusSink, { ...(await chatStatusInfo(state)), agentId })
    : startWorkingStatus(agentId);
  // Defect #3: the parent model's narration streams into the transcript while
  // the turn runs. onDelta/onReasoningDelta already arrive in-process; the
  // painter coalesces them fence-aware so a code block never splits mid-fence.
  const painter = state.statusSink
    ? createNarrationPainter({
        emit: (line) => emitChatLine(state, line),
        reasoningMode: state.reasoningMode ?? "compact",
      })
    : undefined;
  let outcome: RunOutcome;
  try {
    outcome = await executeRun(config, {
      onDelta: painter ? (chunk) => painter.delta(chunk) : undefined,
      onReasoningDelta: painter ? (chunk) => painter.reasoning(chunk) : undefined,
      prompt: agentId ? `Agent route: ${agentId}\n\n${prompt}` : prompt,
      turnContext: state.pendingContinuityContext,
      // The managed-runtime plan branch is the ONLY one that honors an explicit
      // model/provider (verified live: without it, --model was silently ignored
      // and a stale workspace route billed a different model than the header
      // showed). Name the runtime ONLY for genuinely managed backends — an
      // openai-compatible or other provider must keep the default plan path,
      // or a stub/self-hosted route would spawn the real codex binary.
      runtime: state.runtime ?? managedRuntimeForChat(loadedConfig, state),
      provider: state.provider,
      model: state.model,
      scopes: state.scopes.length ? state.scopes : undefined,
      recallLimit: state.recallLimit,
      cwd: workspaceCwd,
      conversationKey: chatConversationKey(state.sessionName),
      surfaceId: "cli-chat",
      agentId,
      skipAgentRules: true,
      skipRecall: (state.speedMode ?? "fast") === "fast",
      skipSkillSelection: (state.speedMode ?? "fast") === "fast",
      skipMemoryWrite: (state.speedMode ?? "fast") === "fast",
      nativeSession: true,
      nativeSessionKeepAlive: options.keepAlive ?? true,
      nativeTransportOwner: "cli-chat",
      timeoutMs: options.timeoutMs,
      ...(resumeThreadId ? { sessionId: resumeThreadId, resume: true } : {}),
    });
  } finally {
    painter?.finish();
    stopWorking();
    await liveDiff.finish().catch(() => {});
  }
  persistChatTranscriptIfMissing(state.sessionName, prompt, outcome, chatSessionWorkspaceCwd(state));
  state.pendingContinuityContext = undefined;
  recordChatUsage(state, outcome.tokens);
  // Already painted delta-by-delta — reprinting the body would double it.
  printAssistantResponse(outcome, { streamed: (painter?.painted ?? 0) > 0, bullet: Boolean(state.statusSink), importedFromCodex: state.importedFromCodex });
  emitTurnCostChip(state, outcome);
  openMentionedCapabilityPicker(state, mentionedCapabilities, config);
}

/**
 * Precedence: explicit flag or /live-diff → env kill switch → on. The kill
 * switch exists so a hostile-terminal or CI environment can silence the feed
 * without touching a config file.
 */
/** The workspace a turn runs against — the resumed Codex thread's repo, or here. */
function chatWorkspaceCwd(state: ChatState): string {
  return state.workspaceCwd ?? process.cwd();
}

function chatSessionWorkspaceCwd(state: ChatState): string {
  return state.sessionWorkspaceCwd ?? process.cwd();
}

function liveDiffEnabled(state: ChatState): boolean {
  if (state.liveDiff !== undefined) return state.liveDiff;
  if (process.env.MUSTER_NO_LIVE_DIFF === "1" || process.env.MUSTER_LIVE_DIFF === "0") return false;
  return true;
}

function readLiveDiffFlag(commandArgs: readonly string[]): boolean | undefined {
  if (commandArgs.includes("--no-live-diff")) return false;
  if (commandArgs.includes("--live-diff")) return true;
  return undefined;
}

/**
 * One line into whatever surface the turn owns. In the TUI that is the live
 * transcript sink; on a plain TTY the spinner line is cleared first so a card
 * never lands mid-frame.
 */
function emitChatLine(state: ChatState, line: string): void {
  if (state.statusSink) {
    state.statusSink.appendLine(line);
    return;
  }
  if (process.stdout.isTTY) {
    process.stdout.write(`\r\x1b[2K${line}\n`);
    return;
  }
  console.log(line);
}

async function interruptChatTurn(): Promise<boolean> {
  const [codex, claude] = await Promise.all([
    interruptActiveCodexTurn("cli-chat").catch(() => false),
    interruptClaudeSubprocesses(),
  ]);
  if (codex) {
    // An interrupted app-server turn can leave the warm thread holding its
    // writer lock ("already has an active writer" on the next turn — observed
    // live). Drop the warm sessions so the next turn opens a clean thread; the
    // one-time cold start is cheaper than a wedged conversation.
    clearCodexAppServerSessions("cli-chat");
  }
  return codex || claude;
}

/** Claude Code is a direct child of the CLI; Escape sends its native SIGINT. */
async function interruptClaudeSubprocesses(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,command="]);
    const rows = stdout.split(/\r?\n/).map((line) => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
      return match ? { pid: Number(match[1]), parentPid: Number(match[2]), command: match[3] ?? "" } : undefined;
    }).filter((row): row is { pid: number; parentPid: number; command: string } => Boolean(row));
    const descendants = new Set<number>([process.pid]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows) {
        if (descendants.has(row.parentPid) && !descendants.has(row.pid)) {
          descendants.add(row.pid);
          changed = true;
        }
      }
    }
    const claude = rows.filter((row) => descendants.has(row.pid) && /(?:^|[\s/])claude(?:\s|$)/i.test(row.command));
    let interrupted = false;
    for (const row of claude) {
      try {
        process.kill(row.pid, "SIGINT");
        interrupted = true;
      } catch {
        // The child may finish between `ps` and the signal.
      }
    }
    return interrupted;
  } catch {
    return false;
  }
}

/**
 * Defect #1: a TTY session closes a turn with one formatted chip built from
 * the run's own token record. Scripts (no statusSink) keep the raw JSON line
 * the engine writes, so nothing that parses stdout changes.
 */
function emitTurnCostChip(state: ChatState, outcome: RunOutcome): void {
  if (!state.statusSink) return;
  const tokens = outcome.tokens;
  if (tokens.runId && tokens.runId === lastCostChipRunId) return;
  lastCostChipRunId = tokens.runId;
  state.statusSink.appendLine(formatCostChip(tokens));
}

/**
 * One `/reasoning` command, two knobs the user thinks of as one thing:
 *
 * - SPEND: `auto|low|medium|high`. `auto` runs the prompt heuristic and may only
 *   LOWER the tier below what config would spend, so a two-line question never
 *   burns a high-reasoning budget out of a 5-hour window. An explicit tier is
 *   sticky for the chat.
 * - DENSITY: `compact|full`. Compact keeps the provider-approved summary to one
 *   dim row above the answer it explains; full paints every line. Raw hidden
 *   chain-of-thought is never available to either mode (codex-app-server.ts:34).
 */
async function switchChatReasoningMode(args: string, state: ChatState): Promise<void> {
  await initializeChatComposerState(state);
  const mode = args.trim().toLowerCase();
  if (!mode) {
    await openComposerPicker(state);
    return;
  }
  if (mode === "auto" || mode === "config") {
    state.effortOverride = undefined;
    state.effortSource = state.configuredEffortSource ?? "app default";
    console.log(color(`Effort=${effortDisplayLabel(state.configuredEffort)} · ${state.effortSource}`, "green"));
    await refreshChatTuiHeader(state);
    return;
  }
  const effort = parseEffortValue(mode);
  if (effort) {
    if (activeChatProvider(state) === "claude") {
      console.log(color("Extended thinking — managed by the model", "dim"));
      return;
    }
    state.effortOverride = effort;
    state.effortSource = "session";
    console.log(color(`Effort=${effortDisplayLabel(effort)} · session`, "green"));
    await refreshChatTuiHeader(state);
    return;
  }
  if (mode !== "full" && mode !== "compact") {
    console.log(color("Usage: /reasoning <Light|Medium|High|Extra High|Max|Ultra|config> or /reasoning compact|full", "yellow"));
    return;
  }
  state.reasoningMode = mode;
  console.log(color(`reasoning_density=${mode}`, "green"));
}

function toggleChatLiveDiff(args: string, state: ChatState): void {
  const mode = args.trim().toLowerCase();
  if (!mode) {
    console.log(color(`live-diff=${liveDiffEnabled(state) ? "on" : "off"} — inline file diffs stream into this chat as the turn edits files`, "dim"));
    return;
  }
  if (mode !== "on" && mode !== "off") {
    console.log(color("Usage: /live-diff on or /live-diff off", "yellow"));
    return;
  }
  state.liveDiff = mode === "on";
  console.log(color(`live-diff=${mode}`, "green"));
}

/* ---------- chat-embedded orchestration (/tasks) ---------- */

/**
 * A board card names a BACKEND, so the run is routed by runtime id. The card's
 * own model string is deliberately NOT forced onto the runtime: the codex CLI
 * serves whatever `~/.codex/config.toml` is configured with, and pinning a model
 * the CLI does not offer fails the turn (see DEFAULT_CODEX_MODEL's note in
 * packages/core/src/config.ts). The board records the card that was chosen; the
 * runtime records the model that actually ran.
 */
function runtimeForCardId(cardId: string): string | undefined {
  if (cardId.startsWith(`${BACKEND_CARD_PROVIDERS.claude}/`)) return "claude-code";
  if (cardId.startsWith(`${BACKEND_CARD_PROVIDERS.codex}/`)) return "codex";
  return undefined;
}

/** Deltas arrive token-shaped; the board narration line wants sentences. */
function createNarrationChunker(emit: (text: string) => void): (chunk: string) => void {
  let buffer = "";
  return (chunk: string) => {
    buffer += chunk;
    let cut = Math.max(buffer.lastIndexOf("\n"), buffer.lastIndexOf(". "));
    if (cut < 0 && buffer.length > 160) cut = buffer.length - 1;
    if (cut < 0) return;
    const ready = buffer.slice(0, cut + 1).trim();
    buffer = buffer.slice(cut + 1);
    if (ready) emit(ready.split("\n").filter(Boolean).at(-1) ?? ready);
  };
}

/** Sum the ledger rows this run actually wrote; unpriced stays unpriced. */
async function costForRunId(runId: string | undefined, cwd: string): Promise<number | undefined> {
  if (!runId) return undefined;
  const records = await listTokenRecords(cwd).catch(() => []);
  const priced = records.filter((record) => record.runId === runId && record.costUsd !== undefined);
  return priced.length > 0 ? priced.reduce((sum, record) => sum + (record.costUsd ?? 0), 0) : undefined;
}

function buildOrchestrationDeps(input: {
  readonly sessionName: string;
  readonly cwd: string;
  readonly emit: (line: string) => void;
  readonly runtime?: string;
  readonly provider?: string;
  readonly model?: string;
}): OrchestrationDeps {
  const workerStore = new DurableWorkerStore(join(dataDir(input.cwd), "boards", `${input.sessionName.replace(/[^a-zA-Z0-9._-]/g, "_")}.workers.json`));
  const workerReady = workerStore.restore().then(() => workerStore);
  return {
    sessionName: input.sessionName,
    cwd: input.cwd,
    emit: input.emit,
    width: process.stdout.columns || 100,
    async detectAuth(): Promise<BackendAuth> {
      const backends = await detectBackends();
      return { codex: backends.codex === "authenticated", claude: backends.claude === "installed" };
    },
    async plan(prompt: string): Promise<string> {
      await ensureDefaultConfig(input.cwd);
      const config = await loadConfig(input.cwd);
      const outcome = await executeRun(config, {
        prompt,
        cwd: input.cwd,
        runtime: input.runtime,
        provider: input.provider,
        model: input.model,
        surfaceId: "cli-chat-mission",
        skipRecall: true,
        skipSkillSelection: true,
        skipMemoryWrite: true,
        skipAgentRules: true,
      });
      return outcome.episode.responseText ?? "";
    },
    taskSessionId(task): string {
      const store = openSessionStore(input.cwd);
      try {
        const parent = store.findOrCreateSession({
          channel: "cli-chat", peer: input.sessionName, title: input.sessionName, workspaceCwd: input.cwd,
        });
        return store.findOrCreateSession({
          channel: "cli-task",
          peer: `${input.sessionName}:${task.id}`,
          title: task.title,
          parentId: parent.id,
          workspaceCwd: input.cwd,
        }).id;
      } finally {
        store.close();
      }
    },
    async prepareAttempt({ task, attemptId }) {
      return createAttemptWorktree(input.cwd, `board-${input.sessionName}`, task.id, attemptId);
    },
    async execute(task: MissionTaskRunInput): Promise<MissionTaskRunResult> {
      await ensureDefaultConfig(input.cwd);
      const config = await loadConfig(input.cwd);
      const runtime = runtimeForCardId(task.cardId);
      const prompt = task.nextTurn ?? `${task.task.title}\n\n${task.task.goal}`;
      const attemptCwd = task.worktreePath ?? input.cwd;
      const durableWorker = await workerReady;
      await durableWorker.setWorker(task.task.id, task.sessionId, "woken");
      const sessionStore = openSessionStore(input.cwd);
      try {
        const prior = sessionStore.loadActiveMessages(task.sessionId);
        if (prior.at(-1)?.role !== "user" || prior.at(-1)?.content !== prompt) sessionStore.appendMessage(task.sessionId, "user", prompt);
      } finally { sessionStore.close(); }
      let liveText = "";
      const narrate = createNarrationChunker(task.onNarration);
      const onDelta = (chunk: string): void => { liveText += chunk; taskLiveMessages.set(task.sessionId, liveText); narrate(chunk); };
      const accumulator = new LiveFileTurnAccumulator();
      taskDiffTurns.set(task.task.id, accumulator);
      const diffFeed = await startLiveDiffFeed({
        cwd: attemptCwd,
        emit: () => {},
        onPatch: (event) => {
          let content = "";
          try { content = readFileSync(resolve(event.root, event.path), "utf8"); } catch { /* deletion */ }
          accumulator.add(event, content);
        },
      });
      let run: Awaited<Awaited<ReturnType<typeof spawnSubagent>>["done"]>;
      let executorId: string | undefined;
      try {
        const handle = await spawnSubagent(config, {
          task: prompt,
          parentKey: `mission:${input.sessionName}`,
          runOptions: {
            ...(runtime ? { runtime } : {}),
            onDelta,
            surfaceId: `mission:${input.sessionName}:${task.task.id}`,
            skipRecall: true,
            skipSkillSelection: true,
            skipAgentRules: true,
          },
        }, attemptCwd);
        // The provider runner is in-process; the owning Muster PID is therefore
        // the honest OS kill/relaunch identity. The durable worker keeps the
        // reusable conversation identity separately.
        executorId = String(process.pid);
        await task.onProcessStarted?.(executorId);
        run = await handle.done;
      } finally {
        await diffFeed.finish().catch(() => {});
        taskLiveMessages.delete(task.sessionId);
        await durableWorker.setWorker(task.task.id, task.sessionId, "parked");
      }
      const summary = (run.resultText ?? run.errorMessage ?? "").split("\n").map((line) => line.trim()).find(Boolean) ?? "no output";
      const finalText = run.resultText ?? run.errorMessage ?? summary;
      const finishedStore = openSessionStore(input.cwd);
      try { finishedStore.appendMessage(task.sessionId, "assistant", finalText); } finally { finishedStore.close(); }
      const costUsd = await costForRunId(run.runId, input.cwd);
      return {
        ok: run.status === "completed",
        summary,
        ...(costUsd !== undefined ? { costUsd } : {}),
        ...(run.runId ? { runId: run.runId } : {}),
        ...(executorId ? { processId: executorId } : {}),
      };
    },
  };
}

function chatOrchestrationDeps(state: ChatState): OrchestrationDeps {
  return buildOrchestrationDeps({
    sessionName: state.sessionName,
    cwd: chatWorkspaceCwd(state),
    emit: (line) => emitChatLine(state, line),
    ...(state.runtime ? { runtime: state.runtime } : {}),
    ...(state.provider ? { provider: state.provider } : {}),
    ...(state.model ? { model: state.model } : {}),
  });
}

const taskDiffTurns = new Map<string, LiveFileTurnAccumulator>();
const taskLiveMessages = new Map<string, string>();

function createChatBoardController(state: ChatState): BoardModeController {
  const cwd = chatWorkspaceCwd(state);
  const sessionName = state.sessionName;
  let hygiene: Promise<unknown> | undefined;
  const withStore = async <T>(fn: (store: Awaited<ReturnType<typeof openBoardStore>>) => Promise<T>): Promise<T> => {
    const store = await openBoardStore({ sessionName, cwd });
    return fn(store);
  };
  return {
    cwd,
    async loadView() {
      let events = await readBoardEvents(sessionName, cwd);
      hygiene ??= sweepZombieWorktrees(cwd, events).catch(() => []);
      await hygiene;
      const recoveryStore = await openBoardStore({ sessionName, cwd });
      const orphans = findRelaunchOrphans(recoveryStore.state());
      if (!recoveryStore.readOnly) for (const orphan of orphans) await recoveryStore.commit(
        { actorId: "orchestrator:recovery", actorKind: "system", summary: `reap orphan ${orphan.processId}` },
        { type: "orphan_process_reaped", ...orphan },
      );
      if (orphans.length) events = await readBoardEvents(sessionName, cwd);
      const stalls = findStalledAttempts(events);
      if (stalls.length) {
        const store = await openBoardStore({ sessionName, cwd });
        if (!store.readOnly) for (const stall of stalls) await store.commit(
          { actorId: "orchestrator:recovery", actorKind: "system", summary: `stall detected on ${stall.attemptId}` },
          { type: "attempt_stalled", ...stall },
        );
        events = await readBoardEvents(sessionName, cwd);
      }
      return projectBoardView(events);
    },
    loadMessages(sessionId) {
      const store = openSessionStore(cwd);
      try {
        const rows = store.loadActiveMessages(sessionId);
        const live = taskLiveMessages.get(sessionId);
        return live ? [...rows, { id: Number.MAX_SAFE_INTEGER, sessionId, role: "assistant", content: live, tokenCount: 0, createdAt: new Date().toISOString() }] : rows;
      } finally { store.close(); }
    },
    diff(taskId) { return taskDiffTurns.get(taskId) ?? new LiveFileTurnAccumulator(); },
    comment(taskId, text, anchor) {
      return withStore(async (store) => {
        const entry = store.state().tasks.get(taskId);
        const attemptId = entry?.currentAttemptId;
        const attempt = attemptId ? entry?.attemptHistory.get(attemptId) : undefined;
        if (!attemptId || !attempt || !entry?.sessionId) throw new Error("This task has no attempt/session to comment on.");
        if (!attempt.worktreePath) throw new Error("This attempt has no retained worktree; retry it to create an isolated attempt.");
        await store.commit(
          { actorId: "human:cli", actorKind: "human", summary: `record comment on ${taskId}` },
          { type: "comment_recorded", taskId, attemptId, comment: text, ...(anchor ? { path: anchor.path, line: anchor.line } : {}) },
        );
        const corrective = `${anchor ? `Review comment at ${anchor.path}:${anchor.line}: ` : "Review comment: "}${text}`;
        const result = await chatOrchestrationDeps(state).execute({
          task: entry.task, attemptId, sessionId: entry.sessionId, cardId: entry.assignment?.cardId ?? "", agentId: entry.assignment?.agentId ?? "muster-subagent",
          worktreePath: attempt.worktreePath, nextTurn: corrective, onNarration: () => {},
        });
        if (!result.ok) throw new Error(`comment turn failed: ${result.summary}`);
        await store.commit(
          { actorId: "orchestrator:chat", actorKind: "system", summary: `sent comment as next turn on ${taskId}` },
          { type: "comment_turn_sent", taskId, attemptId, sessionId: entry.sessionId, turnId: result.turnId ?? result.runId ?? `turn-${Date.now()}`, worktreePath: attempt.worktreePath },
        );
      });
    },
    approve(taskId) {
      return withStore(async (store) => {
        const entry = store.state().tasks.get(taskId);
        if (!entry?.currentAttemptId) throw new Error("This task has no attempt to approve.");
        await store.commit(
          { actorId: "human:cli", actorKind: "human", summary: `request approval for ${taskId}` },
          { type: "approval_requested", taskId, attemptId: entry.currentAttemptId, reviewerId: "human:cli" },
        );
        const attempt = entry.attemptHistory.get(entry.currentAttemptId);
        if (!attempt?.worktreePath || !attempt.branchName) throw new Error("This attempt has no retained worktree to approve.");
        const result = await approveAttempt({
          projectCwd: cwd,
          worktree: { path: attempt.worktreePath, branchName: attempt.branchName },
          checks: entry.task.acceptanceChecks ?? [],
        });
        await store.commit(
          { actorId: "human:cli", actorKind: "human", summary: `acceptance checks for ${taskId}` },
          { type: "acceptance_checks_completed", taskId, attemptId: entry.currentAttemptId, results: result.checks },
        );
        if (!result.accepted) {
          if (result.conflict) await store.commit(
            { actorId: "human:cli", actorKind: "human", summary: `merge conflict on ${taskId}` },
            { type: "merge_conflict", taskId, attemptId: entry.currentAttemptId, detail: result.conflict },
          );
          throw new Error(result.conflict ? `merge conflict: ${result.conflict}` : "acceptance checks failed; task remains in Review");
        }
        await store.commit(
          { actorId: "human:cli", actorKind: "human", summary: `accept and merge ${taskId}` },
          { type: "review_accepted", taskId, attemptId: entry.currentAttemptId, reviewerId: "human:cli", acceptanceChecks: result.checks, diffHashes: result.diffHashes, ...(result.mergeCommit ? { mergeCommit: result.mergeCommit } : {}) },
        );
      });
    },
    retry(taskId) {
      return withStore(async (store) => {
        let entry = store.state().tasks.get(taskId);
        if (!entry?.assignment) throw new Error("This task has no assignment to retry.");
        if (entry.status === "review") {
          await store.commit(
            { actorId: "human:cli", actorKind: "human", summary: `retry ${taskId}` },
            { type: "task_review_rejected", taskId, reviewerId: "human:cli", reason: "operator requested a new attempt" },
          );
        } else if (entry.status === "blocked") {
          await store.commit(
            { actorId: "human:cli", actorKind: "human", summary: `ready ${taskId} for retry` },
            { type: "task_ready", taskId, satisfiedDependencies: entry.task.dependsOn },
          );
          entry = store.state().tasks.get(taskId);
          if (entry?.status === "ready" && entry.assignment) {
            await store.commit(
              { actorId: "human:cli", actorKind: "human", summary: `restore assignment for ${taskId} retry` },
              { type: "task_assigned", taskId, assignment: entry.assignment },
            );
          }
        } else if (entry.status === "needs_intervention") {
          await store.commit(
            { actorId: "human:cli", actorKind: "human", summary: `requeue ${taskId} for retry` },
            { type: "task_intervention_resolved", taskId, resolution: "requeue", note: "operator requested a new attempt" },
          );
          entry = store.state().tasks.get(taskId);
          if (entry?.status === "ready" && entry.assignment) {
            await store.commit(
              { actorId: "human:cli", actorKind: "human", summary: `restore assignment for ${taskId} retry` },
              { type: "task_assigned", taskId, assignment: entry.assignment },
            );
          }
        }
        entry = store.state().tasks.get(taskId);
        if (entry?.status !== "assigned" || !entry.assignment) throw new Error(`Task is ${entry?.status ?? "missing"}; retry requires review or a stopped attempt.`);
        const attemptId = `attempt-${taskId}-${entry.attempts + 1}`;
        const worktree = await createAttemptWorktree(cwd, `board-${sessionName}`, taskId, attemptId);
        await store.commit(
          { actorId: "human:cli", actorKind: "human", summary: `start retry ${attemptId}` },
          { type: "task_attempt_started", taskId, attemptId, agentId: entry.assignment.agentId, worktreePath: worktree.path, branchName: worktree.branchName, idleBudgetMs: 120_000 },
        );
        taskDiffTurns.set(taskId, new LiveFileTurnAccumulator());
        const task = entry.task;
        const sessionId = entry.sessionId;
        const cardId = entry.assignment.cardId;
        if (!sessionId) throw new Error("This task has no bound session.");
        const deps = chatOrchestrationDeps(state);
        void deps.execute({
          task, attemptId, sessionId, cardId, agentId: entry.assignment.agentId, worktreePath: worktree.path,
          onNarration: (note) => {
            void openBoardStore({ sessionName, cwd }).then((liveStore) => liveStore.commit(
              { actorId: "orchestrator:chat", actorKind: "system", summary: `${taskId} progress` },
              { type: "task_progress", taskId, note: note.slice(0, 240) },
            )).catch(() => {});
          },
          onProcessStarted: async (processId) => {
            const liveStore = await openBoardStore({ sessionName, cwd });
            await liveStore.commit(
              { actorId: "orchestrator:chat", actorKind: "system", summary: `process ${processId} started` },
              { type: "process_started", taskId, attemptId, processId, ownerPid: process.pid },
            );
          },
        }).then(async (result) => {
          const liveStore = await openBoardStore({ sessionName, cwd });
          const current = liveStore.state().tasks.get(taskId);
          if (current?.status !== "in_progress" || current.currentAttemptId !== attemptId) return;
          if (result.processId) await liveStore.commit(
            { actorId: "orchestrator:chat", actorKind: "system", summary: `process ${result.processId} exited` },
            { type: "process_exited", taskId, attemptId, processId: result.processId, exitCode: result.ok ? 0 : 1 },
          );
          await liveStore.commit(
            { actorId: "orchestrator:chat", actorKind: "system", summary: `${result.ok ? "complete" : "fail"} ${attemptId}` },
            result.ok
              ? { type: "task_attempt_completed", taskId, attemptId, ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}) }
              : { type: "task_attempt_failed", taskId, attemptId, error: result.summary || "retry failed", ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}) },
          );
        }).catch(async (error) => {
          const liveStore = await openBoardStore({ sessionName, cwd });
          const current = liveStore.state().tasks.get(taskId);
          if (current?.status === "in_progress" && current.currentAttemptId === attemptId) await liveStore.commit(
            { actorId: "orchestrator:chat", actorKind: "system", summary: `fail ${attemptId}` },
            { type: "task_attempt_failed", taskId, attemptId, error: error instanceof Error ? error.message : String(error) },
          );
        });
      });
    },
    cancel(taskId) {
      return withStore(async (store) => {
        const entry = store.state().tasks.get(taskId);
        if (entry?.status !== "in_progress" || !entry.currentAttemptId) throw new Error("Only a running attempt can be cancelled.");
        await store.commit(
          { actorId: "human:cli", actorKind: "human", summary: `cancel ${entry.currentAttemptId}` },
          { type: "task_attempt_cancelled", taskId, attemptId: entry.currentAttemptId, reason: "cancelled by operator" },
        );
      });
    },
  };
}

/** The non-chat door onto the same task state: `muster tasks list|why|assign`. */
async function boardCommand(commandArgs: string[]): Promise<void> {
  const sessionName = readFlag(commandArgs, "--session") ?? DEFAULT_CHAT_SESSION;
  const parsed = parseBoardCliCommand(commandArgs.filter((entry, index, all) => {
    if (entry === "--session") return false;
    return all[index - 1] !== "--session";
  }));
  await runOrchestrationCommand(parsed, buildOrchestrationDeps({
    sessionName,
    cwd: process.cwd(),
    emit: (line) => console.log(line),
  }));
}

/**
 * The spinner NEVER enters the transcript (defect #4) and no longer owns a row
 * of its own: it paints at the left edge of the one status line, whose elapsed
 * segment counts THIS turn while the turn runs.
 */
function startTuiWorkingStatus(sink: MusterChatSink, info: Parameters<typeof formatStatusLine>[0]): () => void {
  let frame = 0;
  const startedAt = Date.now();
  const render = (): void => {
    sink.setStatus(formatStatusLine({ ...info, verb: workingVerbForFrame(frame), frame, elapsedMs: Date.now() - startedAt }));
    frame += 1;
  };
  render();
  const timer = setInterval(render, 250);
  return () => {
    clearInterval(timer);
    sink.clearStatus();
  };
}

function startWorkingStatus(agentId: string | undefined): () => void {
  const label = agentId ? `@${agentId} working` : "working";
  if (!process.stdout.isTTY) {
    console.log(`\n${label}`);
    return () => {};
  }
  let frame = 0;
  let lastLength = 0;
  const render = (): void => {
    const text = formatWorkingIndicator(agentId, frame);
    frame += 1;
    lastLength = Math.max(lastLength, stripAnsi(text).length);
    process.stdout.write(`\r${color(text, "accent")}${" ".repeat(Math.max(0, lastLength - stripAnsi(text).length))}`);
  };
  process.stdout.write("\n");
  render();
  const timer = setInterval(render, 250);
  return () => {
    clearInterval(timer);
    process.stdout.write(`\r${" ".repeat(lastLength)}\r`);
  };
}

function parseAgentMention(text: string): { agentId: string; prompt: string } | undefined {
  const match = text.match(/^@([a-zA-Z0-9_.:-]+)\s+([\s\S]+)$/);
  if (!match) return undefined;
  return { agentId: match[1], prompt: match[2].trim() };
}

async function printMentionedCapabilityChecks(
  prompt: string,
  config: Awaited<ReturnType<typeof loadConfig>>,
  options: { interactive?: boolean } = {},
): Promise<readonly BuiltinCapabilityMention[]> {
  const mentions = intentfulCapabilityMentions(prompt, resolveBuiltinCapabilityMentions(prompt, { limit: 5 }));
  if (!mentions.length) return [];
  const lines: string[] = [];
  for (const mention of mentions) {
    lines.push(await formatMentionedCapabilityCheck(mention, config));
  }
  const nextLine = options.interactive
    ? "The matching picker opens after this turn so you can confirm setup instead of guessing commands."
    : "Run the shown next command, or start interactive chat for the guided picker.";
  printChatPanel("Capability Check", [
    color("Muster noticed capability names in your prompt and checked setup before routing.", "dim"),
    ...lines,
    color(nextLine, "dim"),
  ]);
  return mentions;
}

function openMentionedCapabilityPicker(
  state: ChatState,
  mentions: readonly BuiltinCapabilityMention[],
  config: Awaited<ReturnType<typeof loadConfig>>,
): void {
  if (!state.statusSink || !mentions.length) return;
  const mention = mentions.find((candidate) => candidate.kind === "plugin" && !isMentionedPluginEnabled(candidate, config))
    ?? mentions.find((candidate) => candidate.kind === "mcp" && !isMentionedMcpConfigured(candidate, config))
    ?? mentions.find((candidate) => candidate.kind === "skill")
    ?? mentions[0];
  if (!mention) return;
  const prefill = composerPrefillForCapabilityMention(mention, {
    enabled: isMentionedPluginEnabled(mention, config),
    configured: isMentionedMcpConfigured(mention, config),
  });
  if (!prefill) {
    state.statusSink.appendLine(color(`suggestion · review ${mention.id} in /tools before enabling it`, "dim"));
    return;
  }
  openNextPicker(state, prefill);
}

function isMentionedPluginEnabled(
  mention: BuiltinCapabilityMention,
  config: Awaited<ReturnType<typeof loadConfig>>,
): boolean {
  return mention.kind === "plugin" && config.plugins?.entries?.[mention.id]?.enabled !== false && Boolean(
    config.plugins?.entries?.[mention.id] !== undefined || config.plugins?.allow?.includes(mention.id)
  );
}

function isMentionedMcpConfigured(
  mention: BuiltinCapabilityMention,
  config: Awaited<ReturnType<typeof loadConfig>>,
): boolean {
  return mention.kind === "mcp" && Boolean(config.tools?.mcp?.servers?.[safeConfigKey(mention.id)]);
}

async function formatMentionedCapabilityCheck(
  mention: BuiltinCapabilityMention,
  config: Awaited<ReturnType<typeof loadConfig>>,
): Promise<string> {
  const label = `${mention.kind}:${mention.id}`.padEnd(30);
  if (mention.kind === "skill") {
    const installed = await listSkills().catch(() => []);
    const active = installed.some((skill) => skill.name === mention.id && skill.status === "active");
    return `${color(label, "accent")} ${active ? color("active", "green") : color("available", "yellow")} risk=${mention.risk} matched=${mention.matched} next="/skills ${mention.id}"`;
  }
  if (mention.kind === "plugin") {
    const plugin = listBuiltinPlugins().find((entry) => entry.id === mention.id || entry.aliases?.includes(mention.id));
    const enabled = config.plugins?.entries?.[mention.id]?.enabled !== false && (
      config.plugins?.entries?.[mention.id] !== undefined || config.plugins?.allow?.includes(mention.id)
    );
    const missing = missingSetupEnv(plugin?.setup);
    const next = enabled
      ? `"/plugins check ${mention.id}"`
      : mention.risk === "high" ? `"/tools" (review ${mention.id} first)` : `"/plugins ${mention.id}"`;
    return `${color(label, "accent")} ${enabled ? color("enabled", "green") : color("available", "yellow")} action=${mention.actionability ?? "-"} risk=${mention.risk}${missing.length ? ` missing=${missing.join(",")}` : ""} next=${next}`;
  }
  const configured = Boolean(config.tools?.mcp?.servers?.[safeConfigKey(mention.id)]);
  const entry = listBuiltinMcpServers().find((server) => server.id === mention.id);
  const missing = missingMcpEnv(entry);
  const status = configured ? color("configured", "green") : missing.length ? color("needs_env", "yellow") : color("installable", "yellow");
  return `${color(label, "accent")} ${status} risk=${mention.risk}${missing.length ? ` missing=${missing.join(",")}` : ""} next="/mcp ${configured ? `test ${mention.id}` : mention.id}"`;
}

function printAssistantResponse(outcome: RunOutcome, options: { readonly streamed?: boolean; readonly bullet?: boolean; readonly importedFromCodex?: boolean } = {}): void {
  const status = outcome.episode.outcome?.kind ?? "unknown";
  if (process.env.MUSTER_TIMINGS === "1" && outcome.timings) {
    console.log(color(formatTimingLine(outcome.timings), "dim"));
  }
  if (status !== "completed") {
    // A failure is a card, not a stderr dump: one red cause line, one fix line.
    // Full detail stays available in the run record for /status and doctor.
    const detail = outcome.episode.outcome?.kind === "failed" ? outcome.episode.outcome.detail : undefined;
    const cause = detail?.split("\n").map((line) => line.trim()).find((line) => line && !line.startsWith("20")) ?? `turn ${status}`;
    console.log(color(`✖ ${cause.slice(0, 160)}`, "red"));
    if (detail?.includes("already has an active writer")) {
      console.log(color("  This Codex thread is open in another app (Codex desktop or CLI).", "yellow"));
      console.log(color(`  ${threadConflictCure(options.importedFromCodex === true)}`, "yellow"));
    } else {
      console.log(color(`  run ${outcome.plan.runId.slice(0, 8)} · ${outcome.episode.providerId}/${outcome.episode.model} · fix: muster doctor or /status`, "dim"));
    }
    return;
  }
  if (outcome.recallReceipt) {
    const receipt = outcome.recallReceipt;
    const receiptScopes = receipt.scopes ?? uniqueMemoryScopes(outcome.recalled.flatMap((memory) => memory.scopes));
    const scopeSummary = receiptScopes.map(formatMemoryScope).join(",");
    const summary = `memory backend=${receipt.backend} recalled=${receipt.receipts.length} candidates=${receipt.candidateCount} scopes=${scopeSummary}${receipt.fallbackUsed ? " expanded=true" : ""}`;
    console.log(color(summary, receipt.receipts.length ? "dim" : "yellow"));
    for (const item of receipt.receipts.slice(0, 3)) {
      console.log(color(`  ${item.memory.id} score=${item.score.toFixed(3)} ${item.reason}`, "dim"));
    }
  }
  if (outcome.fallbackUsed) console.log(color(`fallback=${outcome.fallbackUsed}`, "yellow"));
  if (options.streamed) return;
  const body = wrapPreserveLines(outcome.episode.responseText || "(empty response)", Math.min(process.stdout.columns || 100, 120) - 2);
  // In the TUI an un-streamed answer is still ONE message block, so it wears
  // the same `●` gutter a streamed one does. Scripts keep the bare lines.
  for (const line of options.bullet ? formatAssistantBlock(body.join("\n")) : body) {
    console.log(line);
  }
}

function formatTimingLine(t: NonNullable<RunOutcome["timings"]>): string {
  return [
    `timings total=${t.totalMs}ms`,
    `provider=${t.providerMs}ms`,
    `transport=${t.providerTransport ?? "unknown"}`,
    `first_token_ms=${t.firstTokenMs ?? "-"}`,
    `recall=${t.recallMs}ms`,
    `prompt=${t.promptBuildMs}ms`,
    `persist=${t.persistMs}ms`,
    `planning=${t.planningMs}ms`,
    `rules=${t.agentRulesMs ?? 0}ms`,
    `skills=${t.skillSelectionMs ?? 0}ms`,
    `hooks=${t.hookMs ?? 0}ms`,
    `memory_write=${t.memoryWriteMs ?? 0}ms`,
    `backend_fallback=${t.backendFallbackMs ?? 0}ms`,
    `attempts=${t.providerAttemptCount ?? 0}`,
  ].join(" ");
}

function uniqueMemoryScopes(scopes: readonly MemoryScope[]): MemoryScope[] {
  return [...new Map(scopes.map((scope) => [formatMemoryScope(scope), scope])).values()];
}

function persistChatTranscriptIfMissing(sessionName: string, prompt: string, outcome: RunOutcome, workspaceCwd: string): void {
  const store = openSessionStore();
  try {
    const session = store.findOrCreateSession({ channel: "cli-chat", peer: sessionName, title: sessionName, workspaceCwd });
    store.setTitle(session.id, sessionName);
    const messages = store.loadActiveMessages(session.id);
    const lastTwo = messages.slice(-2);
    const alreadyStored = lastTwo[0]?.role === "user" && lastTwo[0].content === prompt && lastTwo[1]?.role === "assistant" && lastTwo[1].content === outcome.episode.responseText;
    if (!alreadyStored) {
      store.appendMessage(session.id, "user", prompt);
      store.appendMessage(session.id, "assistant", outcome.episode.responseText);
    }
    store.addUsage(session.id, outcome.tokens.inputTokens, outcome.tokens.outputTokens, outcome.tokens.costUsd ?? 0);
  } finally {
    store.close();
  }
}

function ensureNamedChatSession(sessionName: string, workspaceCwd = process.cwd()): void {
  const store = openSessionStore();
  try {
    const session = store.findOrCreateSession({ channel: "cli-chat", peer: sessionName, title: sessionName, workspaceCwd });
    store.setTitle(session.id, sessionName);
  } finally {
    store.close();
  }
}

function chatSessionsByDirectory(limit = 5000): { here: SessionRow[]; all: SessionRow[] } {
  const store = openSessionStore();
  try {
    const result = store.search({ limit });
    if (result.shape !== "browse") return { here: [], all: [] };
    const all = result.sessions.filter((session) => session.channel === "cli-chat");
    return { here: all.filter((session) => session.workspaceCwd === process.cwd()), all };
  } finally {
    store.close();
  }
}

function printChatSessions(limit: number, includeAll = false): void {
  const store = openSessionStore();
  try {
    const result = store.search({ limit: 5000 });
    if (result.shape !== "browse") return;
    const all = result.sessions.filter((session) => session.channel === "cli-chat");
    const here = all.filter((session) => session.workspaceCwd === process.cwd());
    const sessions = (includeAll ? [...here, ...all.filter((session) => session.workspaceCwd !== process.cwd())] : here).slice(0, limit);
    console.log(color(`(${here.length} here · ${all.length} total)`, "dim"));
    if (!sessions.length) {
      console.log(includeAll ? "No named chat sessions yet." : "No chat sessions in this directory. Use /sessions --all to list everything.");
      return;
    }
    console.log(color("name · when · messages · last human line", "dim"));
    for (const session of sessions) {
      const messages = store.loadActiveMessages(session.id);
      const preview = sessionPreview([...messages].reverse(), 72);
      const when = messages.at(-1)?.createdAt ?? session.createdAt;
      console.log(`${color(session.peer, "accent")} · ${color(formatCodexAge(when), "dim")} · ${messages.length} messages · ${color(preview, "dim")}`);
    }
  } finally {
    store.close();
  }
}

function openNamedSessionPicker(state: ChatState, command: "resume" | "name"): void {
  const store = openSessionStore();
  try {
    const result = store.search({ limit: 5000 });
    const all = result.shape === "browse" ? result.sessions.filter((session) => session.channel === "cli-chat") : [];
    const ordered = [
      ...all.filter((session) => session.workspaceCwd === process.cwd()),
      ...all.filter((session) => session.workspaceCwd !== process.cwd()),
    ].slice(0, 15);
    if (!ordered.length) {
      console.log("No named chat sessions yet.");
      return;
    }
    const options: string[] = [];
    ordered.forEach((session, index) => {
      const messages = store.loadActiveMessages(session.id);
      const preview = sessionPreview([...messages].reverse(), 72);
      const when = messages.at(-1)?.createdAt ?? session.createdAt;
      console.log(`${color(`${index + 1}.`, "accent")} ${color(session.peer, "accent")} · ${color(formatCodexAge(when), "dim")} · ${messages.length} messages · ${color(preview, "dim")}`);
      options.push(`${command} ${session.peer}`);
    });
    state.pendingMenu = { kind: "commands", options };
  } finally {
    store.close();
  }
}

async function openTaskArgumentPicker(state: ChatState, action: "why" | "assign", taskId?: string): Promise<void> {
  if (taskId) {
    const cards = MODEL_CARD_SEED.filter((card) => !card.retired);
    cards.forEach((card, index) => console.log(
      `${color(`${index + 1}.`, "accent")} ${color(card.id, "accent")} · ${color(`${card.provider} · ${card.model} · ${card.costTier}`, "dim")}`,
    ));
    state.pendingMenu = { kind: "commands", options: cards.map((card) => `tasks assign ${taskId} ${card.id}`) };
    return;
  }
  const view = projectBoardView(await readBoardEvents(state.sessionName, chatWorkspaceCwd(state)));
  const tasks = Object.values(view.cards);
  if (!tasks.length) {
    console.log("No tasks yet. Use /tasks \"<goal>\" to create them.");
    return;
  }
  tasks.forEach((task, index) => console.log(
    `${color(`${index + 1}.`, "accent")} ${color(task.taskId, "accent")} · ${color(`${task.status} · ${task.title}`, "dim")}`,
  ));
  state.pendingMenu = { kind: "commands", options: tasks.map((task) => `tasks ${action} ${task.taskId}`) };
}

async function openCodexSessionPicker(state: ChatState, includeAll: boolean): Promise<void> {
  try {
    const scan = await discoverCodexSessions({
      limit: 60,
      includeSubagents: includeAll,
      includeExecNoise: includeAll,
    });
    const now = Date.now();
    const isLive = (item: CodexSessionSummary): boolean => now - Date.parse(item.lastActivityAt) < 120_000;
    const isTrivial = (item: CodexSessionSummary): boolean => item.turnCount <= 1 && item.messageCount <= 4;
    // Substance ranks the list: live threads, then real conversations (this
    // directory first), then one-line probes, then automated noise. Recency
    // orders within a bucket — a "hey" probe must never outrank the thread the
    // owner actually has context in.
    const bucket = (item: CodexSessionSummary): number =>
      item.execNoise ? 3 : isLive(item) ? 0 : isTrivial(item) ? 2 : 1;
    const rows = [...scan.sessions].sort((a, b) =>
      bucket(a) - bucket(b)
      || (a.cwd === process.cwd() ? 0 : 1) - (b.cwd === process.cwd() ? 0 : 1)
      || Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt)).slice(0, 14);
    if (!rows.length) {
      console.log(color("No Codex threads found on this machine.", "dim"));
      return;
    }
    const hidden = scan.execNoiseHidden + scan.subagentsHidden;
    const describe = (item: CodexSessionSummary): string => {
      const size = item.sizeBytes >= 1_048_576
        ? `${(item.sizeBytes / 1_048_576).toFixed(1)}MB`
        : `${Math.max(1, Math.round(item.sizeBytes / 1024))}KB`;
      const facts = `${codexProjectLabel(item)} · ${formatCodexAge(item.lastActivityAt)} · ${item.turnCount} turn${item.turnCount === 1 ? "" : "s"} · ${size}`;
      return `${isLive(item) ? "● live · " : ""}${facts} · ${item.preview.slice(0, 44)}`;
    };
    const sink = state.statusSink;
    if (sink) {
      const toggle = includeAll
        ? [{ value: "__toggle", label: "Hide automated runs", description: "collapse worker-lane and exec rollouts" }]
        : hidden
          ? [{ value: "__toggle", label: `Show ${hidden} automated run${hidden === 1 ? "" : "s"}`, description: "worker-lane and exec rollouts" }]
          : [];
      // The Codex app's OWN thread name leads; the project label is only the
      // fallback for unnamed threads. Duplicates get numbers, the app's habit.
      const labelCounts = new Map<string, number>();
      const numberedLabel = (item: CodexSessionSummary): string => {
        const base = item.threadName ?? codexProjectLabel(item);
        const seen = (labelCounts.get(base) ?? 0) + 1;
        labelCounts.set(base, seen);
        return seen === 1 ? base : `${base} · ${seen}`;
      };
      const picked = await sink.selectFromList("Continue a Codex conversation", [
        ...rows.map((item) => ({
          value: `codex resume ${item.threadId}`,
          label: `${isLive(item) ? "● " : ""}${numberedLabel(item)}`,
          description: describe(item),
        })),
        ...toggle,
      ]);
      if (picked === "__toggle") return openCodexSessionPicker(state, !includeAll);
      if (picked) await handleChatCommand(`/${picked}`, state);
      return;
    }
    printChatPanel("Continue a Codex conversation", rows.map((item, index) =>
      `${color(`${index + 1}.`, "accent")} ${codexProjectLabel(item).padEnd(22)} ${color(describe(item), "dim")}`));
    console.log(color(
      includeAll
        ? "Type a number to continue · a hides automated runs"
        : `Type a number to continue${hidden ? ` · a shows ${hidden} automated run${hidden === 1 ? "" : "s"}` : ""}`,
      "dim",
    ));
    state.pendingMenu = {
      kind: "codex-sessions",
      options: rows.map((item) => `codex resume ${item.threadId}`),
      includeAll,
    };
  } catch (error) {
    console.log(color(error instanceof Error ? error.message : String(error), "yellow"));
  }
}

function recentChatSessionNames(limit = 25): string[] {
  const sessions = chatSessionsByDirectory();
  return sessions.here.slice(0, limit).map((session) => session.peer);
}

function mostRecentChatSessionName(): string | undefined {
  return recentChatSessionNames(1)[0];
}

function printChatHistory(sessionName: string, limit: number, workspaceCwd = process.cwd()): void {
  const store = openSessionStore();
  try {
    const session = store.findOrCreateSession({ channel: "cli-chat", peer: sessionName, title: sessionName, workspaceCwd });
    const messages = store.loadActiveMessages(session.id).slice(-Math.max(1, limit));
    console.log(color(`session=${sessionName} messages=${messages.length}`, "cyan"));
    for (const message of messages) printChatMessage(message);
  } finally {
    store.close();
  }
}

function printChatMessage(message: MessageRow): void {
  const roleColor = message.role === "assistant" ? "green" : message.role === "user" ? "cyan" : "dim";
  console.log(color(`${message.role.padEnd(9)} ${message.createdAt.slice(11, 19)}`, roleColor));
  for (const line of wrapPreserveLines(message.content, Math.min(process.stdout.columns || 100, 120) - 4).slice(0, 12)) {
    console.log(`  ${line}`);
  }
}

async function printChatStatus(state: ChatState): Promise<void> {
  const config = await loadConfig();
  const runtime = state.runtime ?? config.routing.defaultRuntime;
  const rt = config.runtimes[runtime];
  const providerId = state.provider ?? rt?.provider;
  const provider = providerId ? config.providers[providerId] : undefined;
  const model = state.model ?? firstRuntimeModel(rt) ?? provider?.defaultModel;
  const store = openSessionStore();
  try {
    const session = store.findOrCreateSession({ channel: "cli-chat", peer: state.sessionName, title: state.sessionName, workspaceCwd: chatSessionWorkspaceCwd(state) });
    const messages = store.loadActiveMessages(session.id).length;
    const fallbacks = config.routing.fallbacks ?? [];
    printChatPanel("Status", [
      `${color("conversation".padEnd(12), "accent")} ${state.sessionName}`,
      `${color("runtime".padEnd(12), "accent")} ${runtime}`,
      `${color("provider".padEnd(12), "accent")} ${provider?.id ?? providerId ?? "-"}`,
      `${color("model".padEnd(12), "accent")} ${model ?? "-"}`,
      `${color("speed".padEnd(12), "accent")} ${state.speedMode ?? "fast"}${(state.speedMode ?? "fast") === "fast" ? " (warm native, light context)" : " (full memory + skills)"}`,
      `${color("scopes".padEnd(12), "accent")} ${formatChatScopes(activeChatScopes(state))}${state.scopes.length ? " (explicit)" : " (default)"}`,
      `${color("recall".padEnd(12), "accent")} limit ${state.recallLimit ?? 5}`,
      `${color("messages".padEnd(12), "accent")} ${messages}`,
      `${color("tokens".padEnd(12), "accent")} in ${session.tokensIn} / out ${session.tokensOut}`,
      ...(fallbacks.length ? [`${color("fallbacks".padEnd(12), "accent")} ${formatFallbackRoutes(config)}`] : []),
      `${color("resume".padEnd(12), "accent")} /resume ${state.sessionName}`,
      `${color("history".padEnd(12), "accent")} /history ${Math.min(Math.max(messages, 10), 40)}`,
      `${color("inspect".padEnd(12), "accent")} muster sessions show ${session.id}`,
    ]);
  } finally {
    store.close();
  }
}

async function printChatProviders(): Promise<void> {
  const config = await loadConfig();
  const defaultRuntime = config.runtimes[config.routing.defaultRuntime];
  const activeProvider = defaultRuntime?.provider;
  printChatPanel("Providers", [
    ...Object.values(config.providers).map((provider) => {
      const active = provider.id === activeProvider ? "*" : " ";
      const endpoint = provider.kind === "openai-compatible" ? provider.baseUrl ?? "-" : provider.kind;
      return `${color(active, "accent")} ${color(provider.id.padEnd(14), "accent")} ${provider.kind.padEnd(18)} ${provider.defaultModel.padEnd(24)} ${endpoint}`;
    }),
    `${color("fallbacks".padEnd(16), "accent")} ${formatFallbackRoutes(config)}`,
    "",
    color("Managed runtimes", "accent"),
    `${color("claude-code".padEnd(16), "accent")} Claude Code login, no API key. Use /runtime claude-code`,
    `${color("codex".padEnd(16), "accent")} Codex CLI login. Use /runtime codex`,
    `${color("pi".padEnd(16), "accent")} Pi runtime. Use /runtime pi`,
    "",
    color("Cloud presets", "accent"),
    ...PROVIDER_PRESETS.filter((preset) => preset.category === "cloud" || preset.category === "aggregator").slice(0, 10).map((preset) =>
      `${color(preset.id.padEnd(16), "accent")} ${preset.label} · default ${preset.defaultModel}`
    ),
  ]);
  console.log(color("Use /provider <id> [model], /cloud <preset>, /model [name], or /runtime claude-code.", "dim"));
}

function formatFallbackRoutes(config: Awaited<ReturnType<typeof loadConfig>>): string {
  const fallbacks = config.routing.fallbacks ?? [];
  if (!fallbacks.length) return "none configured";
  return fallbacks.map((route) => `${route.provider}/${route.model}`).join(" -> ");
}

async function switchChatProvider(args: string, state: ChatState): Promise<void> {
  if (!args) {
    await printChatProviders();
    openNextPicker(state, "/provider");
    return;
  }
  const [providerId, ...modelParts] = args.split(/\s+/).filter(Boolean);
  if (providerId === "claude-code") {
    await switchChatRuntime("claude-code", state);
    return;
  }
  if (providerId === "codex-cli") {
    await switchChatRuntime("codex", state);
    return;
  }
  let config = await loadConfig();
  let provider = config.providers[providerId];
  if (!provider) {
    const preset = PROVIDER_PRESETS.find((item) => item.id === providerId);
    if (!preset) {
      console.log(color(`Provider not found: ${providerId}. Type /providers or /cloud.`, "yellow"));
      return;
    }
    provider = await addPresetProvider(providerId);
    config = await loadConfig();
    console.log(color(`provider_added=${provider.id} key=${provider.apiKeyEnv ?? "none"} default_model=${provider.defaultModel}`, "green"));
  }
  const runtimeId = state.runtime ?? config.routing.defaultRuntime;
  const model = modelParts.join(" ").trim() || provider.defaultModel;
  await setRuntimeProvider({ runtimeId, providerId, model });
  state.runtime = runtimeId;
  state.provider = providerId;
  state.model = model;
  await refreshChatTuiHeader(state);
  const cleared = await clearConversationSessionHandles(chatConversationKey(state.sessionName));
  console.log(color(`provider=${providerId} model=${model} runtime=${runtimeId} provider_handles_cleared=${cleared}`, "green"));
  if (provider.apiKeyEnv && !process.env[provider.apiKeyEnv]) {
    printChatPanel("Setup Required", [
      `${color(provider.apiKeyEnv, "yellow")} is not set for ${providerId}.`,
      `${color("Open", "accent")} ${providerSetupUrl(providerId) ?? "the provider dashboard in your browser to create an API key."}`,
      `Set it in your shell, then reopen Muster or run ${color(`/provider ${providerId}`, "accent")}.`,
      `${color("Next", "accent")} Choose a model now; the provider will work once the key exists.`,
    ]);
  }
  openNextPicker(state, "/model");
}

async function cloudChatProvider(args: string, state: ChatState): Promise<void> {
  const presetId = args.trim();
  if (!presetId) {
    printChatPanel("Cloud Presets", PROVIDER_PRESETS.filter((preset) => preset.category === "cloud" || preset.category === "aggregator").map((preset) => {
      const key = preset.apiKeyEnv ? `${preset.apiKeyEnv}${process.env[preset.apiKeyEnv] ? " set" : " not set"}` : "no key";
      return `${color(preset.id.padEnd(14), "accent")} ${preset.label.padEnd(38)} ${preset.defaultModel.padEnd(28)} ${key}`;
    }));
    console.log(color("Use /cloud <preset> to add and switch, for example /cloud openrouter or /cloud anthropic.", "dim"));
    openNextPicker(state, "/cloud");
    return;
  }
  const preset = PROVIDER_PRESETS.find((item) => item.id === presetId);
  if (!preset || (preset.category !== "cloud" && preset.category !== "aggregator")) {
    console.log(color(`Cloud preset not found: ${presetId}. Type /cloud to browse.`, "yellow"));
    return;
  }
  await switchChatProvider(preset.id, state);
}

async function switchChatModel(args: string, state: ChatState): Promise<void> {
  const model = args.trim();
  if (!model) {
    await openComposerPicker(state);
    return;
  }
  await selectChatModel(model, state);
}

async function openComposerPicker(state: ChatState): Promise<void> {
  await initializeChatComposerState(state);
  const backends = await detectBackends();
  const pickerState = {
    catalog: buildComposerCatalog({ codex: backends.codex === "authenticated", claude: backends.claude === "installed" }),
    activeModel: state.model ?? DEFAULT_CODEX_MODEL,
    modelSource: state.modelSource ?? "app default",
    effort: state.effortOverride ?? state.configuredEffort ?? "medium",
    effortSource: state.effortSource ?? "app default",
    speed: state.speedMode ?? "fast",
  } as const;
  if (!state.statusSink) {
    printChatPanel("Model", [
      `Model   ${modelDisplayLabel(pickerState.activeModel)} · ${pickerState.modelSource}`,
      activeChatProvider(state) === "claude"
        ? "Effort  Extended thinking — managed by the model"
        : `Effort  ${effortDisplayLabel(pickerState.effort)} · ${pickerState.effortSource}`,
      `Speed   ${pickerState.speed}`,
      ...pickerState.catalog.models.map((item) => `${item.provider.padEnd(7)} ${item.label.padEnd(12)} ${item.value === pickerState.activeModel ? "✓" : ""}`),
    ]);
    return;
  }
  const selection = await state.statusSink.selectComposerSetting(pickerState);
  if (!selection) return;
  if (selection.kind === "model") await selectChatModel(selection.value, state);
  if (selection.kind === "effort") {
    state.effortOverride = selection.value;
    state.effortSource = "session";
    console.log(color(`Effort=${effortDisplayLabel(selection.value)} · session`, "green"));
    await refreshChatTuiHeader(state);
  }
  if (selection.kind === "speed") {
    state.speedMode = selection.value;
    console.log(color(`Speed=${selection.value}`, "green"));
  }
}

async function selectChatModel(model: string, state: ChatState): Promise<void> {
  await initializeChatComposerState(state);
  const nextProvider = modelProvider(model);
  if (!nextProvider) {
    console.log(color(`Model not in the composer catalog: ${model}`, "yellow"));
    return;
  }
  const priorProvider = activeChatProvider(state);
  state.model = model;
  state.modelSource = "session";
  state.activeProvider = nextProvider;
  state.runtime = nextProvider === "claude" ? "claude-code" : "codex";
  state.provider = nextProvider === "claude" ? "claude-code" : "codex";
  if (nextProvider !== priorProvider) {
    state.pendingContinuityContext = loadChatContinuityContext(state.sessionName);
    console.log(color(`switched to ${modelDisplayLabel(model)} — conversation continues; ${priorProvider} thread parked`, "dim"));
  } else {
    console.log(color(`Model=${modelDisplayLabel(model)} · session`, "green"));
  }
  await refreshChatTuiHeader(state);
}

function loadChatContinuityContext(sessionName: string): string {
  const store = openSessionStore();
  try {
    const session = store.findOrCreateSession({ channel: "cli-chat", peer: sessionName, title: sessionName });
    return buildContinuityContext(store.loadActiveMessages(session.id).slice(-30));
  } finally {
    store.close();
  }
}

async function switchChatRuntime(args: string, state: ChatState): Promise<void> {
  const runtimeId = args.trim();
  const config = await loadConfig();
  if (!runtimeId) {
    printChatPanel("Runtimes", [
      ...Object.values(config.runtimes).map((runtime) => {
      const active = runtime.id === (state.runtime ?? config.routing.defaultRuntime) ? "*" : " ";
      const provider = config.providers[runtime.provider];
      return `${color(active, "accent")} ${color(runtime.id.padEnd(16), "accent")} provider=${runtime.provider} model=${firstRuntimeModel(runtime) ?? provider?.defaultModel ?? "-"} enabled=${runtime.enabled}`;
      }),
      "",
      `${color("claude-code".padEnd(18), "accent")} Claude Code local login · no API key · model default sonnet`,
      `${color("codex".padEnd(18), "accent")} Codex CLI local login · model default ${DEFAULT_CODEX_MODEL}`,
      `${color("pi".padEnd(18), "accent")} Pi managed provider runtime`,
    ]);
    console.log(color("Use /runtime claude-code, /runtime codex, /runtime pi, or /provider <id> [model].", "dim"));
    openNextPicker(state, "/runtime");
    return;
  }
  if (runtimeId === "claude" || runtimeId === "claude-code") {
    state.runtime = "claude-code";
    state.provider = "claude-code";
    state.model = "sonnet";
    await refreshChatTuiHeader(state);
    const cleared = await clearConversationSessionHandles(chatConversationKey(state.sessionName));
    console.log(color(`runtime=claude-code provider=claude-code model=${state.model} provider_handles_cleared=${cleared}`, "green"));
    console.log(color("Uses your local Claude Code login. Run `claude` once outside Muster if auth is not set.", "dim"));
    openNextPicker(state, "/model");
    return;
  }
  if (runtimeId === "codex") {
    state.runtime = "codex";
    state.provider = "codex";
    state.model = DEFAULT_CODEX_MODEL;
    await refreshChatTuiHeader(state);
    const cleared = await clearConversationSessionHandles(chatConversationKey(state.sessionName));
    console.log(color(`runtime=codex provider=codex model=${state.model} provider_handles_cleared=${cleared}`, "green"));
    openNextPicker(state, "/model");
    return;
  }
  if (runtimeId === "pi") {
    state.runtime = "pi";
    state.provider = "pi-default";
    state.model = "pi-default";
    await refreshChatTuiHeader(state);
    const cleared = await clearConversationSessionHandles(chatConversationKey(state.sessionName));
    console.log(color(`runtime=pi provider=pi-default model=${state.model} provider_handles_cleared=${cleared}`, "green"));
    openNextPicker(state, "/provider");
    return;
  }
  const runtime = config.runtimes[runtimeId];
  if (!runtime) {
    console.log(color(`Runtime not found: ${runtimeId}. Type /runtime to list runtimes.`, "yellow"));
    return;
  }
  const provider = config.providers[runtime.provider];
  state.runtime = runtimeId;
  state.provider = runtime.provider;
  state.model = firstRuntimeModel(runtime) ?? provider?.defaultModel;
  await refreshChatTuiHeader(state);
  const cleared = await clearConversationSessionHandles(chatConversationKey(state.sessionName));
  console.log(color(`runtime=${runtimeId} provider=${state.provider} model=${state.model ?? "-"} provider_handles_cleared=${cleared}`, "green"));
  openNextPicker(state, "/model");
}

function switchChatSpeed(args: string, state: ChatState): void {
  const mode = args.trim().toLowerCase();
  if (!mode) {
    printChatPanel("Speed", chatSpeedOptions().map((option) => {
      const active = option.value === (state.speedMode ?? "fast") ? "*" : " ";
      return `${color(active, "accent")} ${color(option.value.padEnd(10), "accent")} ${option.description ?? ""}`;
    }));
    openNextPicker(state, "/speed");
    return;
  }
  if (mode !== "session" && mode !== "fast") {
    console.log(color("Usage: /speed session or /speed fast", "yellow"));
    return;
  }
  state.speedMode = mode;
  void refreshChatTuiHeader(state);
  console.log(color(`speed=${mode}${mode === "fast" ? " warm native + light context enabled" : " full memory + skills enabled"}`, "green"));
  printChatPanel("Ready", [
    `${color("Provider", "accent")} ${state.provider ?? "current"} · ${color("Model", "accent")} ${state.model ?? "current"} · ${color("Speed", "accent")} ${mode}`,
    "Type a normal message to run the agent, or use /plugins, /skills, /mcp to add capabilities.",
  ]);
}

function openNextPicker(state: ChatState, command: string): void {
  if (state.statusSink) {
    state.statusSink.openPicker(command);
  } else {
    console.log(color(`Next: ${command}`, "dim"));
  }
}

async function printChatMemory(query: string, state: ChatState): Promise<void> {
  if (!query) {
    console.log(color("Usage: /memory <query>", "yellow"));
    return;
  }
  const scopes = activeChatScopes(state);
  const result = await searchMemoryWithReceipts({ query, scopes, includeGlobal: true, limit: 8, candidateLimit: 50, match: "any" }, process.cwd());
  if (!result.receipts.length) {
    console.log(`No matching scoped memory. scopes=${formatChatScopes(scopes)} backend=${result.backend} candidates=${result.candidateCount}`);
    return;
  }
  console.log(color(`memory query="${query}" scopes=${formatChatScopes(scopes)} backend=${result.backend} candidates=${result.candidateCount}`, "dim"));
  for (const receipt of result.receipts.slice(0, 8)) {
    const memory = receipt.memory;
    console.log(color(`${memory.id} ${memory.kind} ${memory.observedAt}`, "cyan"));
    console.log(`  ${memory.summary}`);
    console.log(color(`  score=${receipt.score.toFixed(3)} reason=${receipt.reason} scopes=${memory.scopes.map(formatMemoryScope).join(",")}`, "dim"));
  }
}

function printChatScopes(state: ChatState): void {
  const explicit = state.scopes.length > 0;
  printChatPanel("Memory Scopes", [
    `${color("active".padEnd(12), "accent")} ${formatChatScopes(activeChatScopes(state))}`,
    `${color("mode".padEnd(12), "accent")} ${explicit ? "explicit" : "default local user"}`,
    `${color("recall".padEnd(12), "accent")} limit ${state.recallLimit ?? 5}`,
    color("Use /scope user:pavan tenant:f2 to replace, /scope add tenant:f2 to append, or /scope clear.", "dim"),
  ]);
}

async function updateChatScopes(args: string, state: ChatState): Promise<void> {
  const parts = args.split(/\s+/).filter(Boolean);
  if (!parts.length) {
    printChatScopes(state);
    return;
  }
  const action = parts[0].toLowerCase();
  try {
    if (action === "clear" || action === "default") {
      state.scopes = [];
      await refreshChatTuiHeader(state);
      console.log(color(`scopes=${formatChatScopes(activeChatScopes(state))} mode=default`, "green"));
      return;
    }
    if (action === "add") {
      const additions = parts.slice(1).map(parseMemoryScope);
      if (!additions.length) {
        console.log(color("Usage: /scope add <kind:id> [...]", "yellow"));
        return;
      }
      const merged = new Map(activeChatScopes(state).map((scope) => [formatMemoryScope(scope), scope]));
      for (const scope of additions) merged.set(formatMemoryScope(scope), scope);
      state.scopes = [...merged.values()];
      await refreshChatTuiHeader(state);
      console.log(color(`scopes=${formatChatScopes(state.scopes)}`, "green"));
      return;
    }
    const scopes = parts.map(parseMemoryScope);
    state.scopes = scopes;
    await refreshChatTuiHeader(state);
    console.log(color(`scopes=${formatChatScopes(scopes)}`, "green"));
  } catch (error) {
    console.log(color(error instanceof Error ? error.message : String(error), "yellow"));
    console.log(color("Usage: /scope user:pavan tenant:f2 | /scope add tenant:f2 | /scope clear", "dim"));
  }
}

/**
 * Muster's own toolsets, plus what the turn INHERITS.
 *
 * A codex turn under muster boots the user's own MCP servers and keeps their
 * codex plugin skills active — verified live. Listing only muster's built-ins
 * made the harness look emptier than the session actually is, so the inherited
 * inventory is rendered underneath (read-only discovery, never a config edit).
 */
async function printChatTools(toolset?: string, all = false): Promise<void> {
  if (all || !toolset) {
    const rows = await chatToolsOverlayRows(all);
    printChatPanel(all ? "All tools" : "Tools", rows.map((row) =>
      `${color(row.label.padEnd(24), row.id === "catalog:all" ? "dim" : "accent")} ${color(row.description, row.id === "catalog:all" ? "dim" : "highlight")}`));
    return;
  }
  const registry = createToolRegistry();
  registerBuiltinTools(registry);
  const entries = registry.list(toolset || undefined);
  if (!entries.length) {
    console.log(color(`No tools found for ${toolset}.`, "yellow"));
    return;
  }
  const grouped = new Map<string, typeof entries>();
  for (const entry of entries) {
    grouped.set(entry.toolset, [...(grouped.get(entry.toolset) ?? []), entry]);
  }
  printChatPanel("Tools", [
    ...[...grouped].map(([name, items]) => `${color(`${name}:`, "accent")} ${items.map((item) => item.name).join(", ")}`),
    color("Use /tools <toolset> to narrow the list.", "dim"),
  ]);
}

/** `/senses` — codex-native perception, surfaced and verified, never simulated. */
async function printChatSenses(): Promise<void> {
  printChatPanel("Senses", renderSensesPanel(await inheritedEcosystem()));
}

async function printChatCapabilities(query: string | undefined, state: ChatState): Promise<void> {
  const config = await loadConfig();
  const trimmed = query?.trim() ?? "";
  if (trimmed) {
    const mentions = resolveBuiltinCapabilityMentions(trimmed, { limit: 10 });
    if (!mentions.length) {
      printChatPanel("Capabilities", [
        color(`No matching skill, plugin, or MCP found for "${trimmed}".`, "yellow"),
        `${color("Try", "accent")} /skills · /plugins · /mcp · /capabilities frappe`,
      ]);
      return;
    }
    const lines = [
      color(`Matched "${trimmed}" against built-in skills, plugins, and MCP servers.`, "dim"),
      ...(await Promise.all(mentions.map((mention) => formatMentionedCapabilityCheck(mention, config)))),
      color(
        state.statusSink
          ? "Pick from the opened selector, or run the shown setup/check command."
          : "Run the shown setup/check command, or start interactive chat for the guided selector.",
        "dim",
      ),
    ];
    printChatPanel("Capabilities", lines);
    openMentionedCapabilityPicker(state, mentions, config);
    return;
  }
  const skills = summarizeCatalog(listBuiltinSkills(), (skill) => skill.category, (skill) => skill.id, 4);
  const plugins = summarizeCatalog(listBuiltinPlugins(), (plugin) => plugin.category, (plugin) => plugin.id, 4);
  const mcps = summarizeCatalog(listBuiltinMcpServers(), (server) => server.category, (server) => server.id, 4);
  printChatPanel("Capabilities", [
    `${color("skills", "accent")} ${skills.join(" · ")}`,
    `${color("plugins", "accent")} ${plugins.join(" · ")}`,
    `${color("mcp", "accent")} ${mcps.join(" · ")}`,
    "",
    `${color("Search", "accent")} /capabilities <what you want>`,
    `${color("Direct", "accent")} /skills <id> · /plugins <id> · /mcp <id>`,
  ]);
  openNextPicker(state, "/capabilities ");
}

async function printChatSkills(selection: string | undefined, state: ChatState): Promise<void> {
  const selected = selection?.trim();
  if (selected) {
    try {
      const skill = await enableBuiltinSkill(selected);
      printChatPanel("Skills", [
        `${color("enabled", "green")} ${color(skill.id, "accent")} · ${skill.category} · risk=${skill.risk}`,
        skill.description,
        color("Next picker: plugins. Pick a matching capability pack or press Escape to continue chatting.", "dim"),
      ]);
      openNextPicker(state, "/plugins");
    } catch (error) {
      const match = listBuiltinSkills().find((skill) => skill.id === selected);
      printChatPanel("Skills", [
        match
          ? `${color(match.id, "accent")} ${match.category} · risk=${match.risk} · ${match.description}`
          : color(error instanceof Error ? error.message : String(error), "yellow"),
        `${color("Try", "accent")} /skills ${listBuiltinSkills().slice(0, 5).map((skill) => skill.id).join(" · ")}`,
      ]);
    }
    return;
  }
  const skills = await listSkills().catch(() => []);
  const installed = new Set(skills.map((skill) => skill.name));
  const catalog = listBuiltinSkills().filter((skill) => !installed.has(skill.id));
  const grouped = summarizeCatalog(catalog, (skill) => skill.category, (skill) => skill.id, 4);
  if (!skills.length) {
    printChatPanel("Skills", [
      color("No installed skills found for this profile.", "dim"),
      `${color("Built-ins", "accent")} ${grouped.join(" · ")}`,
      `${color("Enable", "accent")} /skills <id> · muster skills enable <id> · muster skills catalog`,
    ]);
    openNextPicker(state, "/skills");
    return;
  }
  printChatPanel("Skills", [
    ...skills.slice(0, 16).map((skill) => {
      const tags = skill.tags.length ? ` · ${skill.tags.slice(0, 4).join(", ")}` : "";
      return `${color(skill.name.padEnd(24), "accent")} ${skill.status}${tags}`;
    }),
    "",
    `${color("More built-ins", "accent")} ${grouped.join(" · ")}`,
    `${color("Enable", "accent")} /skills <id>`,
  ]);
  openNextPicker(state, "/skills");
}

async function printChatPlugins(selection: string | undefined, state: ChatState): Promise<void> {
  const parsed = parseChatSelection(selection);
  const selected = parsed.value;
  const rawParts = (selection ?? "").split(/\s+/).filter(Boolean);
  // The plugins the user ALREADY has (codex/claude) come first — they are the
  // ones that actually work today and were getting buried under muster's own
  // catalog machinery.
  if (!selected) {
    try {
      const eco = await inheritedEcosystem();
      const active = eco.codex.plugins.filter((plugin) => plugin.status === "active");
      if (active.length) {
        printChatPanel("Plugins you already have (codex — active on every codex turn)", [
          ...active.slice(0, 8).map((plugin) => `${color("●", "accent")} ${plugin.id}`),
          ...(active.length > 8 ? [color(`… +${active.length - 8} more — muster integrations inherited`, "dim")] : []),
        ]);
      }
    } catch {
      // Discovery is decoration here; the muster catalog below always prints.
    }
  }
  if (selected === "reuse" || selected === "discover") {
    const provider = parsed.rest[0];
    if (!provider) {
      printChatPanel("Plugins", [
        color("Choose a provider to reuse.", "dim"),
        "Reuse authenticated provider apps, plugins, skills, and MCP manifests without copying secrets.",
        `${color("Known", "accent")} ${(await chatReuseProviderOptions()).map((option) => option.value).join(" · ")}`,
        `${color("Custom", "accent")} set MUSTER_<PROVIDER>_PLUGIN_CACHE or MUSTER_PROVIDER_PLUGIN_CACHE`,
        `${color("Explicit", "accent")} /mcp <id> · muster mcp add-http/add-stdio · muster plugins inspect/load · muster skills enable`,
      ]);
      openNextPicker(state, "/plugins reuse");
      return;
    }
    await pluginReuseCommand(provider, rawParts.slice(2));
    openNextPicker(state, "/plugins");
    return;
  }
  if (selected) {
    try {
      const current = await loadConfig();
      const alreadyEnabled = current.plugins?.allow?.includes(selected) ||
        current.plugins?.entries?.[selected]?.enabled !== false && current.plugins?.entries?.[selected] !== undefined;
      if (alreadyEnabled) {
        const plugin = listBuiltinPlugins().find((entry) => entry.id === selected || entry.aliases?.includes(selected));
        printChatPanel("Plugins", [
          `${color("enabled", "green")} ${color(selected, "accent")}${plugin ? ` · ${plugin.category} · risk=${plugin.risk}` : ""}`,
          plugin?.description ?? "Plugin policy is already enabled.",
          ...(pluginSetupUrl(selected) ? [`${color("Setup", "accent")} ${pluginSetupUrl(selected)}`] : []),
          color("Next picker opens related skills or MCP setup. Press Escape to continue chatting.", "dim"),
        ]);
        openNextPicker(state, plugin?.category === "web" || plugin?.id === "browser" || plugin?.id === "mcp-bridge" ? "/mcp" : "/skills");
        return;
      }
      const plugin = await enableBuiltinPlugin(selected, process.cwd(), { allowHighRisk: parsed.allowHighRisk });
      printChatPanel("Plugins", [
        `${color("enabled", "green")} ${color(plugin.id, "accent")} · ${plugin.category} · risk=${plugin.risk}`,
        plugin.description,
        ...(pluginSetupUrl(plugin.id) ? [`${color("Setup", "accent")} ${pluginSetupUrl(plugin.id)}`] : []),
        ...chatPluginSetupLines(plugin),
        plugin.packPath ? `pack=${plugin.packPath}` : color("Policy enabled. Add MCP/tools or credentials when this integration needs execution.", "dim"),
      ]);
      openNextPicker(state, plugin.category === "web" || plugin.id === "browser" || plugin.id === "mcp-bridge" ? "/mcp" : "/skills");
    } catch (error) {
      const match = listBuiltinPlugins().find((plugin) => plugin.id === selected || plugin.aliases?.includes(selected));
      printChatPanel("Plugins", [
        match
          ? `${color(match.id, "accent")} ${match.category} · risk=${match.risk} · ${match.description}`
          : color(error instanceof Error ? error.message : String(error), "yellow"),
        match?.risk === "high"
          ? `${color("High risk", "yellow")} review setup, then enable in chat with: /plugins ${match.id} --allow-high-risk`
          : `${color("Try", "accent")} /plugins ${listBuiltinPlugins().slice(0, 5).map((plugin) => plugin.id).join(" · ")}`,
        ...(match ? chatPluginSetupLines(match).slice(0, 5) : []),
      ]);
      if (match) openNextPicker(state, `/plugins ${match.id}`);
    }
    return;
  }
  const config = await loadConfig();
  const policy = config.plugins;
  const enabled = new Set(Object.entries(policy?.entries ?? {}).filter(([, entry]) => entry.enabled !== false).map(([id]) => id));
  const catalog = listBuiltinPlugins().filter((plugin) => !enabled.has(plugin.id));
  const grouped = summarizeCatalog(catalog, (plugin) => plugin.category, (plugin) => plugin.id, 3);
  if (!policy) {
    printChatPanel("Plugins", [
      color("No plugin policy configured.", "dim"),
      `${color("Built-ins", "accent")} ${grouped.join(" · ")}`,
      `${color("Enable", "accent")} /plugins <id> · muster plugins enable <id> · muster plugins catalog`,
    ]);
    openNextPicker(state, "/plugins");
    return;
  }
  const entries = Object.entries(policy.entries ?? {});
  printChatPanel("Plugins", [
    `${color("allow", "accent")} ${(policy.allow ?? []).join(", ") || "-"}`,
    `${color("deny", "accent")} ${(policy.deny ?? []).join(", ") || "-"}`,
    `${color("load paths", "accent")} ${(policy.load?.paths ?? []).join(", ") || "-"}`,
    ...entries.map(([id, entry]) => `${color(id.padEnd(24), "accent")} ${entry.enabled === false ? "disabled" : "enabled"}`),
    "",
    `${color("More built-ins", "accent")} ${grouped.join(" · ")}`,
    `${color("Enable", "accent")} /plugins <id>`,
  ]);
  openNextPicker(state, "/plugins");
}

async function printChatMcp(selection: string | undefined, state: ChatState): Promise<void> {
  const parsed = parseChatSelection(selection);
  const selected = parsed.value;
  const rawParts = (selection ?? "").split(/\s+/).filter(Boolean);
  // Same rule as /plugins: the servers codex/claude already run come first.
  if (!selected) {
    try {
      const eco = await inheritedEcosystem();
      const servers = [...eco.codex.mcpServers, ...eco.claude.mcpServers];
      if (servers.length) {
        printChatPanel("MCP servers you already have (active ones join every backend turn)", servers.slice(0, 8).map((server) =>
          `${color(server.status === "active" ? "●" : "○", server.status === "active" ? "accent" : "dim")} ${server.name} ${color(`${server.backend} · ${server.status}${server.guidance ? ` · ${server.guidance}` : ""}`, "dim")}`));
      }
    } catch {
      // Best-effort; muster's own server list below always prints.
    }
  }
  if (selected === "status" || selected === "list") {
    await printMcpStatus(parsed.rest[0]);
    return;
  }
  if (selected === "login") {
    const target = parsed.rest[0];
    if (!target) {
      printChatPanel("MCP", [
        "Pick a configured OAuth MCP server.",
      ]);
      openNextPicker(state, "/mcp login ");
      return;
    }
    await printMcpOauthSetup(target, rawParts.slice(2));
    return;
  }
  if (selected === "remove" || selected === "rm") {
    const target = parsed.rest[0];
    if (!target) {
      printChatPanel("MCP", [
        "Remove only the Muster MCP config entry. Provider/cache credentials are not touched.",
      ]);
      openNextPicker(state, "/mcp remove ");
      return;
    }
    const config = await loadConfig();
    const servers = { ...(config.tools?.mcp?.servers ?? {}) };
    const key = safeConfigKey(target);
    const existed = Boolean(servers[key]);
    delete servers[key];
    await saveConfig({ ...config, tools: { ...(config.tools ?? {}), mcp: { ...(config.tools?.mcp ?? {}), servers } } });
    await refreshChatTuiHeader(state);
    printChatPanel("MCP", [
      existed ? `${color("removed", "green")} ${key}` : `${color("not found", "yellow")} ${key}`,
      "Provider-hosted credentials, OAuth tokens, and external app auth were not changed.",
    ]);
    return;
  }
  if (selected === "attach") {
    await chatAttachInheritedMcp(parsed.rest[0], state);
    return;
  }
  if (selected === "add-http") {
    await chatAddHttpMcp(rawParts.slice(1), state);
    return;
  }
  if (selected === "add-stdio") {
    await chatAddStdioMcp(rawParts.slice(1), state);
    return;
  }
  if (selected === "test") {
    const target = parsed.rest[0];
    if (!target) {
      printChatPanel("MCP", [
        "Pick a configured MCP server to test.",
      ]);
      openNextPicker(state, "/mcp test ");
      return;
    }
    await printMcpTest(target, { setExitCode: false });
    return;
  }
  if (selected === "check" || selected === "doctor") {
    const target = parsed.rest[0];
    if (!target) {
      for (const entry of listBuiltinMcpServers()) await printMcpCheck(entry);
      return;
    }
    const entry = findBuiltinMcpEntry(target);
    if (!entry) {
      printChatPanel("MCP", [
        color(`Unknown built-in MCP "${target}".`, "yellow"),
        `${color("Try", "accent")} /mcp ${listBuiltinMcpServers().slice(0, 5).map((server) => server.id).join(" · ")}`,
      ]);
      openNextPicker(state, "/mcp");
      return;
    }
    await printMcpCheck(entry);
    return;
  }
  if (selected === "install") {
    const target = parsed.rest[0];
    if (!target) {
      printChatPanel("MCP", [
        "Pick an MCP server to install.",
      ]);
      openNextPicker(state, "/mcp install ");
      return;
    }
    await printChatMcp(target, state);
    return;
  }
  if (selected) {
    const candidate = listBuiltinMcpServers().find((server) => server.id === selected);
    if (candidate) {
      const added = await enableChatBuiltinMcp(candidate.id);
      if (added) {
        await refreshChatTuiHeader(state);
        printChatPanel("MCP", [
          `${color("configured", "green")} ${color(candidate.id, "accent")} ${candidate.category} · risk=${candidate.risk}`,
          candidate.description,
          ...(mcpSetupUrl(candidate.id) ? [`${color("Open", "accent")} ${mcpSetupUrl(candidate.id)}`] : []),
          `${color("Test", "accent")} run /mcp test ${candidate.id}`,
        ]);
        openNextPicker(state, "/plugins");
        return;
      }
      printChatPanel("MCP", [
        `${color(candidate.id, "accent")} ${candidate.category} · risk=${candidate.risk}`,
        candidate.description,
        ...(mcpSetupUrl(candidate.id) ? [`${color("Open", "accent")} ${mcpSetupUrl(candidate.id)}`] : []),
        `${color("Add", "accent")} ${candidate.commandHint}`,
        `${color("Setup needed", "yellow")} This MCP needs credentials or a connection URL before Muster can enable it automatically.`,
      ]);
      openNextPicker(state, "/mcp");
      return;
    }
  }
  const servers = (await loadConfig()).tools?.mcp?.servers ?? {};
  const entries = Object.entries(servers);
  const configured = new Set(entries.map(([name]) => name));
  const suggested = listBuiltinMcpServers().filter((server) => !configured.has(server.id));
  const grouped = summarizeCatalog(suggested, (server) => server.category, (server) => server.id, 3);
  if (!entries.length) {
    printChatPanel("MCP", [
      color("No MCP servers configured.", "dim"),
      `${color("Suggested", "accent")} ${grouped.join(" · ")}`,
      `${color("Inspect", "accent")} /mcp <id> for the exact add command`,
    ]);
    openNextPicker(state, "/mcp");
    return;
  }
  printChatPanel("MCP", [
    ...entries.map(([name, server]) => {
      const transport = server.transport.kind === "stdio"
        ? `stdio ${server.transport.command} ${(server.transport.args ?? []).join(" ")}`.trim()
        : `http ${server.transport.url}`;
      return `${color(name.padEnd(24), "accent")} ${transport}`;
    }),
    "",
    `${color("Suggested", "accent")} ${grouped.join(" · ")}`,
    `${color("Inspect", "accent")} /mcp <id>`,
  ]);
  openNextPicker(state, "/mcp");
}

async function printChatIntegrations(selection: string | undefined, state: ChatState): Promise<void> {
  const parts = (selection ?? "").split(/\s+/).filter(Boolean);
  const action = parts[0]?.toLowerCase();
  if (!action) {
    const channels = CHANNEL_SETUP_SPECS.slice(0, 6).map((spec) => spec.id).join(" · ");
    const plugins = listBuiltinPlugins().slice(0, 8).map((plugin) => plugin.id).join(" · ");
    const mcps = listBuiltinMcpServers().slice(0, 8).map((mcp) => mcp.id).join(" · ");
    printChatPanel("Integrations", [
      "Pick one channel, plugin, or MCP to see the guided workflow before enabling anything.",
      `${color("Channels", "accent")} ${channels}`,
      `${color("Plugins", "accent")} ${plugins}`,
      `${color("MCP", "accent")} ${mcps}`,
      "",
      `${color("Workflow", "accent")} /integrations <id>`,
      `${color("Status", "accent")} /integrations status`,
      "Each workflow explains impact, auth/setup, verify, enable, sample, and failure behavior.",
    ]);
    openNextPicker(state, "/integrations");
    return;
  }
  if (action === "status") {
    const statusLines = await captureConsoleLines(() => printIntegrationReadiness());
    printChatIntegrationStatus(statusLines);
    return;
  }
  if (action === "setup" || action === "verify" || action === "enable" || action === "sample") {
    const target = parts[1];
    if (!target) {
      printChatPanel("Integrations", [
        `Pick an integration to ${action}.`,
      ]);
      openNextPicker(state, `/integrations ${action}`);
      return;
    }
    const actionLines = await captureConsoleLines(() => runIntegrationAction(action, target));
    printChatIntegrationAction(action, target, actionLines);
    return;
  }
  if (action === "list" || action === "guide") {
    await integrationsCommand([action]);
    return;
  }
  const target = action === "workflow" ? parts[1] : parts[0];
  if (!target) {
    printChatPanel("Integrations", [
      "Pick a channel, plugin, or MCP integration.",
    ]);
    openNextPicker(state, "/integrations workflow ");
    return;
  }
  const workflowLines = await captureConsoleLines(() => printIntegrationWorkflow(target));
  printChatIntegrationWorkflow(workflowLines);
}

async function captureConsoleLines(fn: () => Promise<void>): Promise<string[]> {
  const original = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines;
}

function printChatIntegrationWorkflow(rawLines: readonly string[]): void {
  const fields = new Map<string, string[]>();
  for (const line of rawLines) {
    const index = line.indexOf("=");
    if (index <= 0) continue;
    const key = line.slice(0, index);
    const value = line.slice(index + 1);
    fields.set(key, [...(fields.get(key) ?? []), value]);
  }
  const first = fields.get("integration_workflow")?.[0] ?? "unknown";
  const [id, ...metaParts] = first.split(/\s+/).filter(Boolean);
  const meta = metaParts.join(" · ");
  const setupUrls = fields.get("setup_url") ?? [];
  const nextAction = integrationWorkflowNextAction(fields);
  const lines = [
    `${color(id, "accent")} ${meta ? color(meta, "dim") : ""}`.trim(),
    ...formatWorkflowField(fields, "impact", "Impact"),
    ...formatWorkflowField(fields, "readiness", "Readiness"),
    ...formatWorkflowField(fields, "risk", "Risk"),
    ...formatWorkflowField(fields, "auth", "Auth"),
    ...formatWorkflowField(fields, "authenticate", "Authenticate"),
    ...(nextAction ? [`${color("Next", "green")} ${nextAction}`] : []),
    ...formatWorkflowField(fields, "setup", "Setup"),
    ...formatWorkflowField(fields, "verify", "Verify"),
    ...formatWorkflowField(fields, "enable", "Enable"),
    ...formatWorkflowField(fields, "related_artifacts", "Artifacts"),
    ...formatWorkflowField(fields, "sample", "Sample"),
    ...formatWorkflowField(fields, "failure_behavior", "Failure"),
    ...(setupUrls.length ? [`${color("Open", "accent")} ${setupUrls.join(" · ")}`] : []),
    ...formatWorkflowField(fields, "steps", "Flow"),
    ...formatWorkflowField(fields, "guardrails", "Guardrails"),
  ];
  printChatPanel("Integration workflow", lines);
}

function printChatIntegrationStatus(rawLines: readonly string[]): void {
  const sections = splitIntegrationStatusSections(rawLines);
  const summary = rawLines.filter((line) =>
    line.startsWith("integration_status=") ||
    line.startsWith("profile=") ||
    line.startsWith("catalog_coverage") ||
    line.startsWith("readiness_matrix") ||
    line.startsWith("mcp_matrix"),
  );
  const suggested = (sections.get("suggested_path") ?? []).filter((line) => /^\s*\d+\./.test(line));
  const blockers = (sections.get("top_blockers") ?? []).slice(0, 6);
  const channels = (sections.get("channels_optional") ?? []).slice(0, 6);
  const daily = (sections.get("daily_life_packs") ?? []).slice(0, 5);
  const mcps = (sections.get("mcp_connectors") ?? []).slice(0, 5);
  const guardrails = rawLines.find((line) => line.startsWith("guardrails="));
  printChatPanel("Integration readiness", [
    ...summary.map((line) => humanizeIntegrationStatusLine(line)),
    ...(blockers.length ? ["", `${color("Blockers", "accent")} ${blockers.map(compactIntegrationRow).join(" · ")}`] : []),
    ...(suggested.length ? ["", `${color("Suggested path", "accent")} ${suggested.map((line) => line.trim()).join(" · ")}`] : []),
    ...(channels.length ? ["", `${color("Channels", "accent")} ${channels.map(compactIntegrationRow).join(" · ")}`] : []),
    ...(daily.length ? [`${color("Packs", "accent")} ${daily.map(compactIntegrationRow).join(" · ")}`] : []),
    ...(mcps.length ? [`${color("MCP", "accent")} ${mcps.map(compactIntegrationRow).join(" · ")}`] : []),
    ...(guardrails ? ["", `${color("Guardrails", "accent")} ${guardrails.slice("guardrails=".length)}`] : []),
  ]);
}

function printChatIntegrationAction(action: string, target: string, rawLines: readonly string[]): void {
  const next = rawLines.find((line) => line.startsWith("integration_next="))?.slice("integration_next=".length);
  const lines = rawLines.filter((line) => !line.startsWith("integration_next="));
  const visible = lines.length ? lines : [color("No output returned.", "dim")];
  printChatPanel(`Integration ${action}`, [
    `${color(target, "accent")} ${color("ran through existing Muster command surface", "dim")}`,
    ...(next ? [`${color("Next", "green")} ${next}`] : []),
    ...visible.slice(0, 18),
    ...(visible.length > 18 ? [color(`... ${visible.length - 18} more line(s) omitted`, "dim")] : []),
  ]);
}

function splitIntegrationStatusSections(rawLines: readonly string[]): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  let current: string | undefined;
  for (const line of rawLines) {
    if (/^[a-z_]+$/.test(line)) {
      current = line;
      sections.set(current, []);
      continue;
    }
    if (current) sections.set(current, [...(sections.get(current) ?? []), line]);
  }
  return sections;
}

function humanizeIntegrationStatusLine(line: string): string {
  const [key, value = ""] = line.split(/=(.*)/s);
  return `${color(key.replace(/_/g, " "), "accent")} ${value}`;
}

function compactIntegrationRow(line: string): string {
  return line.trim().replace(/\s+/g, " ").replace(/\t/g, " ");
}

function integrationWorkflowNextAction(fields: ReadonlyMap<string, readonly string[]>): string | undefined {
  const first = fields.get("integration_workflow")?.[0] ?? "";
  const auth = fields.get("auth")?.[0] ?? "";
  const readiness = fields.get("readiness")?.[0] ?? "";
  const setup = fields.get("setup")?.[0];
  const authenticate = fields.get("authenticate")?.[0];
  const verify = fields.get("verify")?.[0];
  const enable = fields.get("enable")?.[0];
  const sample = fields.get("sample")?.[0];
  if (/ready=true|enabled=true|configured=true/.test(first)) return verify ?? sample ?? enable;
  if (/missing|needs_env|needs OAuth|needs_oauth|manual_setup/i.test(auth) || /needs_env|manual_setup|setup_plan_only/i.test(readiness)) {
    return authenticate && authenticate !== "no interactive auth required" ? authenticate : setup;
  }
  if (/installable/i.test(readiness)) return enable ?? setup ?? verify;
  return setup ?? enable ?? verify ?? sample;
}

function formatWorkflowField(fields: ReadonlyMap<string, readonly string[]>, key: string, label: string): string[] {
  return (fields.get(key) ?? []).map((value) => `${color(label, "accent")} ${value}`);
}

/**
 * Take native ownership of a server muster only INHERITED until now.
 *
 * Policy gate, deliberately narrow: loopback HTTP only, active only, and never
 * an account-bound claude.ai connector. Inheriting a server through a codex
 * turn is the backend's trust decision; connecting to it directly is muster's,
 * so it takes an explicit keypress and reuses the same `mcp add-http` config
 * path as any hand-added server. No credential is copied from either backend.
 */
async function chatAttachInheritedMcp(target: string | undefined, state: ChatState): Promise<void> {
  const ecosystem = await inheritedEcosystem();
  if (!target) {
    const attachable = attachableInheritedServers(ecosystem);
    printChatPanel("MCP", attachable.length
      ? [
        color("Attachable inherited servers (reachable on localhost):", "accent"),
        ...attachable.map((server) => `${color(server.name, "highlight")} ${server.url}`),
        color("Submit /mcp attach <name> to let muster own one directly.", "dim"),
      ]
      : [
        color("No inherited MCP server is directly attachable right now.", "yellow"),
        "Remote and stdio servers stay owned by codex/claude; muster inherits them on that backend's turns.",
        color("See the full inventory: muster integrations inherited", "dim"),
      ]);
    return;
  }
  const resolved = resolveAttachableServer(ecosystem, target);
  if ("error" in resolved) {
    printChatPanel("MCP", [color(resolved.error, "yellow")]);
    return;
  }
  await chatAddHttpMcp([resolved.server.name, resolved.server.url!], state);
  printChatPanel("MCP", [
    `${color("attached", "green")} ${resolved.server.name} — inherited from ${resolved.server.backend}, now also owned by muster config.`,
    color("The backend's own copy is untouched; nothing was written to codex or claude config.", "dim"),
  ]);
}

async function chatAddHttpMcp(args: string[], state: ChatState): Promise<void> {
  const [name, url] = args;
  if (!name || !url) {
    printChatPanel("MCP", [
      color("Usage: /mcp add-http <name> <url> [--oauth --setup-url URL --authorization-url URL --token-url URL --client-id ID --client-secret-env ENV --scope S --redirect-port N]", "yellow"),
      "Use this when you want the MCP owned by Muster instead of reused from a provider cache.",
    ]);
    openNextPicker(state, "/mcp add-http");
    return;
  }
  const oauth = args.includes("--oauth");
  const oauthConfig = oauth ? {
    setupUrl: readFlag(args, "--setup-url"),
    authorizationUrl: readFlag(args, "--authorization-url"),
    tokenUrl: readFlag(args, "--token-url"),
    clientId: readFlag(args, "--client-id"),
    clientSecret: readEnvFlag(args, "--client-secret-env"),
    scope: readFlag(args, "--scope"),
    clientName: readFlag(args, "--client-name") ?? "Muster",
    redirectPort: readNumberFlag(args, "--redirect-port"),
  } : undefined;
  const key = safeConfigKey(name);
  const config = await loadConfig();
  const server: McpServerConfig = {
    transport: { kind: "http", url },
    ...(oauth ? { auth: "oauth" as const, oauth: oauthConfig } : {}),
  };
  await saveConfig({
    ...config,
    tools: {
      ...(config.tools ?? {}),
      mcp: {
        ...(config.tools?.mcp ?? {}),
        servers: {
          ...(config.tools?.mcp?.servers ?? {}),
          [key]: server,
        },
      },
    },
  });
  await refreshChatTuiHeader(state);
  printChatPanel("MCP", [
    `${color("configured", "green")} ${key} transport=http${oauth ? " auth=oauth" : ""}`,
    `${color("url", "accent")} ${url}`,
    oauth ? `${color("Login", "accent")} /mcp login ${key}` : `${color("Test", "accent")} /mcp test ${key}`,
    "No provider cache token was copied; this MCP is now owned by Muster config.",
  ]);
}

async function chatAddStdioMcp(args: string[], state: ChatState): Promise<void> {
  const [name, command, ...commandArgs] = args;
  if (!name || !command) {
    printChatPanel("MCP", [
      color("Usage: /mcp add-stdio <name> <command> [args...]", "yellow"),
      "Use this for local MCP servers, provider-discovered stdio helpers, or your own tools.",
    ]);
    openNextPicker(state, "/mcp add-stdio");
    return;
  }
  const key = safeConfigKey(name);
  const config = await loadConfig();
  const server: McpServerConfig = { transport: { kind: "stdio", command, args: commandArgs } };
  await saveConfig({
    ...config,
    tools: {
      ...(config.tools ?? {}),
      mcp: {
        ...(config.tools?.mcp ?? {}),
        servers: {
          ...(config.tools?.mcp?.servers ?? {}),
          [key]: server,
        },
      },
    },
  });
  await refreshChatTuiHeader(state);
  printChatPanel("MCP", [
    `${color("configured", "green")} ${key} transport=stdio`,
    `${color("command", "accent")} ${command}${commandArgs.length ? ` ${commandArgs.join(" ")}` : ""}`,
    `${color("Test", "accent")} /mcp test ${key}`,
    "No provider cache token was copied; this MCP is now owned by Muster config.",
  ]);
}

function parseChatSelection(input: string | undefined): { value: string; rest: string[]; allowHighRisk: boolean } {
  const parts = (input ?? "").split(/\s+/).filter(Boolean);
  const allowHighRisk = parts.includes("--allow-high-risk") || parts.includes("--yes") || parts.includes("--confirm");
  const values = parts.filter((part) => !part.startsWith("--"));
  return { value: values[0] ?? "", rest: values.slice(1), allowHighRisk };
}

async function chatAgentOptions(): Promise<string[]> {
  const config = await loadConfig();
  const namedAgents = config.agents?.list?.map((agent) => agent.id) ?? [];
  const runtimeAgents = Object.keys(config.runtimes);
  return [...new Set([...runtimeAgents, ...namedAgents])];
}

function createChatCompletionCatalog(state: ChatState): MusterCompletionCatalog {
  return {
    async complete(request) {
      switch (request.kind) {
        case "command": {
          const fragment = request.fragment.toLowerCase();
          // Daily-driver commands surface first; the long tail stays reachable
          // by typing. 47 undifferentiated rows was the reported noise.
          return chatCommandsDailyFirst(state)
            .filter((command) => command.name.startsWith(fragment) || command.aliases?.some((alias) => alias.startsWith(fragment)))
            .map((command) => ({ value: `/${command.name}`, label: color(command.usage, "periwinkle"), description: color(command.description, "dim") }));
        }
        case "reasoning":
          if (!request.fragment) return [];
          return filterPickerOptions([
            { value: "low", label: "Light", description: "Codex Effort" },
            { value: "medium", label: "Medium", description: "Codex Effort" },
            { value: "high", label: "High", description: "Codex Effort" },
            { value: "xhigh", label: "Extra High", description: "Codex Effort" },
            { value: "max", label: "Max", description: "Codex Effort" },
            { value: "ultra", label: "Ultra", description: "Consumes usage limits faster" },
            { value: "compact", label: "summaries: brief", description: "one dim line above each answer" },
            { value: "full", label: "summaries: full", description: "every provider-approved summary line" },
          ], request.fragment);
        case "toolset":
          return filterPickerOptions(await chatToolsOverlayOptions(), request.fragment);
        case "session":
          return filterPickerOptions(recentChatSessionNames().map((name) => ({ value: name, label: name, description: "chat session" })), request.fragment);
        case "provider":
          return filterPickerOptions(await chatProviderOptions(state), request.fragment);
        case "provider-model":
          return filterPickerOptions(await chatModelOptions(request.providerId ?? state.provider, state), request.fragment);
        case "model":
          if (!request.fragment) return [];
          return filterPickerOptions(await chatModelOptions(state.provider, state), request.fragment);
        case "runtime":
          return filterPickerOptions(await chatRuntimeOptions(state), request.fragment);
        case "cloud":
          return filterPickerOptions(chatCloudOptions(), request.fragment);
        case "speed":
          return filterPickerOptions(chatSpeedOptions(state.speedMode ?? "fast"), request.fragment);
        case "capability":
          return filterPickerOptions([
            ...chatSkillOptions(),
            ...await chatPluginOptions(),
            ...await chatMcpOptions(),
          ], request.fragment);
        case "skill":
          return filterPickerOptions(chatSkillOptions(), request.fragment);
        case "plugin":
          return filterPickerOptions(await chatPluginOptions(), request.fragment);
        case "plugin-reuse-provider":
          return filterPickerOptions(await chatReuseProviderOptions(), request.fragment);
        case "mcp":
          return filterPickerOptions(await chatMcpOptions(), request.fragment);
        case "mcp-target": {
          const actions = new Set(CHAT_MCP_ACTION_OPTIONS.map((option) => option.value));
          return filterPickerOptions((await chatMcpOptions()).filter((option) => !actions.has(option.value)), request.fragment);
        }
        case "integration":
          return filterPickerOptions(chatIntegrationOptions(), request.fragment);
        case "integration-workflow":
          return filterPickerOptions(chatIntegrationWorkflowOptions(), request.fragment);
        case "agent": {
          const fragment = request.fragment.toLowerCase();
          return [...new Set(await chatAgentOptions())]
            .filter((agent) => agent.toLowerCase().startsWith(fragment))
            .map((agent) => ({ value: `@${agent}`, label: `@${agent}`, description: "route this turn" }));
        }
      }
    },
  };
}

async function chatProviderOptions(state?: ChatState): Promise<PickerOption[]> {
  const config = await loadConfig();
  const activeRuntimeId = state?.runtime ?? config.routing.defaultRuntime;
  const activeRuntime = config.runtimes[activeRuntimeId];
  const activeProvider = state?.provider ?? activeRuntime?.provider;
  const configured = Object.values(config.providers).map((provider) => ({
    value: provider.id,
    label: pickerLabel(provider.id, provider.id === activeProvider),
    description: [
      provider.id === activeProvider ? "selected" : undefined,
      provider.kind,
      `default ${provider.defaultModel}`,
      provider.apiKeyEnv ? `key ${process.env[provider.apiKeyEnv] ? "set" : "missing"}` : "no key needed",
      providerHealthHint(provider),
    ].filter(Boolean).join(" · "),
  }));
  const presets = PROVIDER_PRESETS
    .filter((preset) => !config.providers[preset.id])
    .map((preset) => ({
      value: preset.id,
      label: preset.id,
      description: `${preset.label} · ${preset.category} · default ${preset.defaultModel}${preset.apiKeyEnv ? ` · setup ${preset.apiKeyEnv}` : ""}`,
    }));
  return sortPickerOptions([
    ...configured,
    { value: "claude-code", label: pickerLabel("claude-code", activeProvider === "claude-code"), description: `${activeProvider === "claude-code" ? "selected · " : ""}Claude Code runtime · uses local claude login` },
    ...presets,
  ], activeProvider);
}

async function chatModelOptions(providerId?: string, state?: ChatState): Promise<PickerOption[]> {
  const config = await loadConfig();
  const activeRuntimeId = state?.runtime ?? config.routing.defaultRuntime;
  const activeRuntime = config.runtimes[activeRuntimeId];
  const id = providerId ?? state?.provider ?? activeRuntime?.provider;
  const provider = id ? config.providers[id] : undefined;
  const preset = id ? PROVIDER_PRESETS.find((entry) => entry.id === id) : undefined;
  const activeModel = id && id === (state?.provider ?? activeRuntime?.provider)
    ? state?.model ?? firstRuntimeModel(activeRuntime) ?? provider?.defaultModel
    : provider?.defaultModel ?? preset?.defaultModel;
  const base = [
    provider?.defaultModel,
    preset?.defaultModel,
    ...modelHintsForProvider(id, provider?.kind),
  ].filter((value): value is string => Boolean(value));
  return sortPickerOptions([...new Set(base)].map((model) => ({
    value: model,
    label: pickerLabel(model, model === activeModel),
    description: [
      model === activeModel ? "selected" : undefined,
      id ? `model for ${id}` : "known model",
      modelPolicyHint(model),
      provider?.apiKeyEnv && !process.env[provider.apiKeyEnv] ? `provider key missing: ${provider.apiKeyEnv}` : undefined,
    ].filter(Boolean).join(" · "),
  })), activeModel);
}

async function chatRuntimeOptions(state?: ChatState): Promise<PickerOption[]> {
  const config = await loadConfig();
  const activeRuntime = state?.runtime ?? config.routing.defaultRuntime;
  return sortPickerOptions([
    ...Object.values(config.runtimes).map((runtime) => ({
      value: runtime.id,
      label: pickerLabel(runtime.id, runtime.id === activeRuntime),
      description: `${runtime.id === activeRuntime ? "selected · " : ""}configured · provider ${runtime.provider}`,
    })),
    { value: "claude-code", label: pickerLabel("claude-code", activeRuntime === "claude-code"), description: `${activeRuntime === "claude-code" ? "selected · " : ""}Claude Code · local login, no API key` },
    { value: "codex", label: pickerLabel("codex", activeRuntime === "codex"), description: `${activeRuntime === "codex" ? "selected · " : ""}Codex CLI · local login` },
    { value: "pi", label: pickerLabel("pi", activeRuntime === "pi"), description: `${activeRuntime === "pi" ? "selected · " : ""}Pi managed provider runtime` },
  ], activeRuntime);
}

function chatCloudOptions(): PickerOption[] {
  return [...CHAT_CLOUD_OPTIONS];
}

function chatSpeedOptions(active = "fast"): PickerOption[] {
  return sortPickerOptions(CHAT_SPEED_OPTIONS.map((option) => ({
    ...option,
    label: pickerLabel(option.value, option.value === active),
    description: `${option.value === active ? "selected · " : ""}${option.description ?? ""}`,
  })), active);
}

function chatSkillOptions(): PickerOption[] {
  return [...CHAT_SKILL_OPTIONS];
}

async function chatPluginOptions(): Promise<PickerOption[]> {
  const config = await loadConfig().catch(() => undefined);
  const enabled = new Set([
    ...(config?.plugins?.allow ?? []),
    ...Object.entries(config?.plugins?.entries ?? {}).filter(([, entry]) => entry.enabled !== false).map(([id]) => id),
  ]);
  return sortPickerOptions(CHAT_PLUGIN_OPTIONS.map((option) => ({
    ...option,
    description: `${enabled.has(option.value) ? "enabled · " : ""}${option.description ?? ""}`,
  })), [...enabled][0]);
}

async function chatReuseProviderOptions(): Promise<PickerOption[]> {
  const config = await loadConfig().catch(() => undefined);
  const configuredProviders = Object.keys(config?.providers ?? {})
    .filter((id) => !CHAT_REUSE_PROVIDER_PRESETS.some((preset) => preset.value === id))
    .map((id) => ({ value: id, label: id, description: `configured provider · set MUSTER_${providerEnvKey(id)}_PLUGIN_CACHE to reuse its plugin manifests` }));
  return [...CHAT_REUSE_PROVIDER_PRESETS, ...configuredProviders];
}

async function chatMcpOptions(): Promise<PickerOption[]> {
  const config = await loadConfig().catch(() => undefined);
  const configured = new Set(Object.keys(config?.tools?.mcp?.servers ?? {}));
  const servers = sortPickerOptions(CHAT_MCP_OPTIONS.map((option) => ({
    ...option,
    description: `${configured.has(option.value) ? "configured · " : ""}${option.description ?? ""}`,
  })), [...configured][0]);
  return [...servers, ...CHAT_MCP_ACTION_OPTIONS];
}

async function chatToolsOverlayRows(all = false) {
  const ecosystem = await inheritedEcosystem();
  const skills = all
    ? chatSkillOptions()
    : await listSkills().then((installed) => {
        const active = new Set(installed.filter((skill) => skill.status === "active").map((skill) => skill.name));
        return chatSkillOptions().filter((skill) => active.has(skill.value));
      }).catch(() => [] as PickerOption[]);
  return buildCapabilityOverlayOptions(ecosystem, { toolsets: CHAT_TOOLSETS, skills, all });
}

async function chatToolsOverlayOptions(): Promise<PickerOption[]> {
  return (await chatToolsOverlayRows(false))
    .map((option) => ({
      value: encodeCapabilitySelection(composerTextForCapabilityAction(option.action)),
      label: option.label,
      description: option.description,
    }));
}

async function runConfirmedCapabilityCommand(command: string, args: readonly string[]): Promise<void> {
  const rendered = [command, ...args].join(" ");
  const result = await probeCommand(command, args, 30_000);
  const outputLines = result.output ? result.output.split(/\r?\n/).filter(Boolean) : [result.ok ? "command completed" : "command failed without output"];
  console.log(color(`${result.ok ? "enabled" : "failed"} ${rendered}`, result.ok ? "green" : "yellow"));
  for (const line of outputLines) console.log(color(`  ⎿ ${line}`, "dim"));
}

function chatIntegrationOptions(): PickerOption[] {
  const actionOptions: PickerOption[] = [
    { value: "status", label: "status", description: "show integration readiness, blockers, suggested path, and guardrails" },
    { value: "list", label: "list", description: "show the machine-readable integration catalog" },
    { value: "guide", label: "guide", description: "show setup guidance for channels, plugins, and MCPs" },
    { value: "setup", label: "setup <id>", description: "start setup/install guidance for a selected channel, plugin, or MCP" },
    { value: "verify", label: "verify <id>", description: "run the selected integration's doctor/check/test path" },
    { value: "enable", label: "enable <id>", description: "enable policy or install/configure the selected integration when safe" },
    { value: "sample", label: "sample <id>", description: "run a local sample simulation or readiness check" },
  ];
  return [...actionOptions, ...chatIntegrationWorkflowOptions()];
}

function chatIntegrationWorkflowOptions(): PickerOption[] {
  const channelOptions = CHANNEL_SETUP_SPECS.map((spec) => ({
    value: spec.id,
    label: spec.id,
    description: `channel · ${spec.label} · ${channelAuthMode(spec.id)} · guided setup, verify, enable, sample`,
  }));
  const pluginOptions = CHAT_PLUGIN_OPTIONS.map((option) => ({
    ...option,
    description: `plugin · ${option.description ?? "built-in plugin"} · guided setup, verify, enable, sample`,
  }));
  const mcpOptions = CHAT_MCP_OPTIONS.map((option) => ({
    ...option,
    description: `mcp · ${option.description ?? "built-in MCP server"} · guided authenticate, install, test`,
  }));
  return sortPickerOptions(mergePickerOptionsByValue([...channelOptions, ...pluginOptions, ...mcpOptions]));
}

function mergePickerOptionsByValue(options: readonly PickerOption[]): PickerOption[] {
  const merged = new Map<string, PickerOption>();
  for (const option of options) {
    const current = merged.get(option.value);
    if (!current) {
      merged.set(option.value, option);
      continue;
    }
    const descriptions = [
      ...(current.description ? current.description.split(" · also ") : []),
      ...(option.description ? [option.description] : []),
    ];
    merged.set(option.value, {
      value: current.value,
      label: current.label ?? option.label,
      description: [...new Set(descriptions)].join(" · also "),
    });
  }
  return [...merged.values()];
}

function sortPickerOptions(options: readonly PickerOption[], active?: string): PickerOption[] {
  return [...options].sort((a, b) => Number(b.value === active) - Number(a.value === active) || a.value.localeCompare(b.value));
}

function pickerLabel(value: string, selected: boolean): string {
  return selected ? `* ${value}` : `  ${value}`;
}

function providerHealthHint(provider: Awaited<ReturnType<typeof loadConfig>>["providers"][string]): string | undefined {
  if (provider.kind === "codex-cli") return "fast path uses local Codex app-server when available";
  if (provider.kind === "anthropic") return "good for deep reasoning; use faster models for simple prompts";
  if (provider.kind === "openai-compatible" && provider.baseUrl?.includes("localhost")) return "local endpoint quality and latency depend on your server";
  return undefined;
}

function modelPolicyHint(model: string): string | undefined {
  const lower = model.toLowerCase();
  if (/opus|reasoning|large|70b|120b/.test(lower)) return "slower/deeper";
  if (/mini|haiku|flash|fast|small|8b/.test(lower)) return "faster/lower cost";
  if (/gpt-4(?!\.1)|0314|0613|1106|0125/.test(lower)) return "check availability; may be legacy";
  return undefined;
}

async function enableChatBuiltinMcp(id: string): Promise<boolean> {
  return configureBuiltinMcp(id);
}

function builtinMcpConfig(id: string): McpServerConfig | undefined {
  const entry = findBuiltinMcpEntry(id);
  return entry ? mcpConfigFromCatalogEntry(entry) : undefined;
}

function mcpConfigFromCatalogEntry(entry: BuiltinMcpCatalogEntry): McpServerConfig | undefined {
  return rosterMcpConfigFromCatalogEntry(entry, { cwd: process.cwd() });
}

async function configureBuiltinMcp(id: string): Promise<boolean> {
  const server = builtinMcpConfig(id);
  if (!server) return false;
  const config = await loadConfig();
  await saveConfig({
    ...config,
    tools: {
      ...(config.tools ?? {}),
      mcp: {
        ...(config.tools?.mcp ?? {}),
        servers: {
          ...(config.tools?.mcp?.servers ?? {}),
          [safeConfigKey(id)]: server,
        },
      },
    },
  });
  return true;
}

function findBuiltinMcpEntry(id: string): BuiltinMcpCatalogEntry | undefined {
  return listBuiltinMcpServers().find((entry) => entry.id === id);
}

function missingEnv(names: readonly string[] | undefined): string[] {
  return (names ?? []).filter((name) => !process.env[name]);
}

function missingSetupEnv(setup: BuiltinPluginCatalogEntry["setup"] | undefined): string[] {
  const exact = missingEnv(setup?.requiresEnv);
  const alternatives = (setup?.requiresAnyEnv ?? [])
    .filter((group) => group.length && group.every((name) => !process.env[name]))
    .map((group) => group.join("|"));
  return [...exact, ...alternatives];
}

function missingMcpEnv(entry: BuiltinMcpCatalogEntry | undefined): string[] {
  const exact = missingEnv(entry?.requiresEnv);
  const alternatives = (entry?.requiresAnyEnv ?? [])
    .filter((group) => group.length && group.every((name) => !process.env[name]))
    .map((group) => group.join("|"));
  return [...exact, ...alternatives];
}

async function printPluginSetupStatus(
  plugin: BuiltinPluginCatalogEntry,
  options: { readonly configureDefaults?: boolean; readonly enabled?: boolean } = {},
): Promise<void> {
  const setup = plugin.setup;
  if (!setup) return;
  const configured: string[] = [];
  const defaultServers = setup.defaultMcpServers ?? [];
  if (options.configureDefaults) {
    for (const id of defaultServers) {
      const entry = findBuiltinMcpEntry(id);
      if (missingMcpEnv(entry).length) continue;
      if (await configureBuiltinMcp(id)) configured.push(id);
    }
  }
  if (configured.length) console.log(`configured_mcp=${configured.join(",")}`);
  const missing = missingSetupEnv(setup);
  if (missing.length) console.log(`missing_env=${missing.join(",")}`);
  if (setup.channels?.length) {
    console.log(`available_channels=${setup.channels.join(",")}`);
    const gateway = await loadGatewayConfig().catch(() => undefined);
    for (const channel of setup.channels) {
      const spec = findChannelSpec(channel);
      const ready = spec && gateway ? channelReady(spec.id, gateway) : false;
      console.log(`channel=${channel} status=${ready ? "ready" : "needs_setup"} command="muster channels ready ${channel}"`);
    }
  }
  if (setup.mcpServers?.length) console.log(`available_mcp=${setup.mcpServers.join(",")}`);
  for (const id of setup.mcpServers ?? []) {
    const entry = findBuiltinMcpEntry(id);
    if (!entry) continue;
    const entryMissing = missingMcpEnv(entry);
    const canConfigure = Boolean(builtinMcpConfig(id));
    const status = configured.includes(id) ? "configured" : entryMissing.length ? `needs_env:${entryMissing.join(",")}` : canConfigure ? "installable" : "manual_setup";
    console.log(`mcp=${id} status=${status} command="${entry.commandHint}"`);
  }
  for (const url of setup.setupUrls ?? []) console.log(`setup_url=${url}`);
  for (const note of setup.notes ?? []) console.log(`note=${note}`);
  for (const action of pluginNextActions(plugin, { enabled: options.enabled })) console.log(action);
}

function cliRepoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function capabilityManifestPath(packPath: string): Promise<string> {
  for (const candidate of [join(packPath, "muster.capability.json"), join(packPath, "manifest.json")]) {
    try {
      await access(candidate);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  throw new Error(`Capability pack manifest not found in ${packPath}.`);
}

async function resolveBuiltinPackPath(plugin: BuiltinPluginCatalogEntry): Promise<string | undefined> {
  if (!plugin.packPath) return undefined;
  const bundled = await resolveBuiltinPluginPackPath(plugin.id);
  if (bundled) return bundled;
  for (const candidate of [
    resolve(process.cwd(), plugin.packPath),
    resolve(cliRepoRoot(), plugin.packPath),
    resolve(cliRepoRoot(), "..", plugin.packPath),
  ]) {
    if (await directoryExists(candidate)) return candidate;
  }
  return undefined;
}

async function rawPackTools(packPath: string): Promise<string[]> {
  try {
    const raw = JSON.parse(await readFile(resolve(packPath, "manifest.json"), "utf8")) as { implementedTools?: unknown };
    return Array.isArray(raw.implementedTools) ? raw.implementedTools.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

async function printPluginPackStatus(plugin: BuiltinPluginCatalogEntry): Promise<void> {
  if (!plugin.packPath) {
    console.log("pack=- status=policy_only");
    return;
  }
  const packPath = await resolveBuiltinPackPath(plugin);
  if (!packPath) {
    console.log(`pack=${plugin.packPath} status=missing`);
    return;
  }
  const report = await inspectCapabilityPack(packPath);
  const tools = report.manifest?.implementedTools ?? await rawPackTools(packPath);
  const readiness = report.manifest?.readiness;
  console.log(`pack=${plugin.packPath} status=${report.status} tools=${tools.length} path=${packPath}`);
  if (readiness) {
    console.log(`pack_readiness=level:${readiness.level} status:${readiness.status} action:${readiness.actionability} surfaces:${readiness.surfaces.join(",")}`);
  }
  if (tools.length) {
    const visible = tools.slice(0, 8);
    const suffix = tools.length > visible.length ? `,+${tools.length - visible.length}` : "";
    console.log(`pack_tools=${visible.join(",")}${suffix}`);
  }
  if (report.blockers.length) console.log(`pack_blockers=${report.blockers.join("; ")}`);
  if (report.warnings.length) console.log(`pack_warnings=${report.warnings.join("; ")}`);
}

async function printPluginCheck(plugin: BuiltinPluginCatalogEntry): Promise<void> {
  const config = await loadConfig();
  const entry = config.plugins?.entries?.[plugin.id];
  const enabled = entry ? entry.enabled !== false : false;
  console.log(`plugin=${plugin.id} source=${plugin.source} risk=${plugin.risk} enabled=${enabled} action=${plugin.actionability}`);
  await printPluginPackStatus(plugin);
  if (plugin.id === "frappe-federated-bridge") {
    const gateway = await loadGatewayConfig().catch(() => undefined);
    const connections = gateway?.frappe?.oauth?.connections ?? [];
    console.log("plugin_env=not_required");
    console.log(`plugin_auth=${connections.length ? "per_user_oauth" : "needs_setup"} connections=${connections.length} default=${gateway?.frappe?.oauth?.defaultConnection ?? "-"}`);
    await printPluginSetupStatus(plugin, { enabled });
    console.log(`next="${connections.length ? "muster frappe doctor" : "muster frappe setup --site-url URL --oauth-credential-file PATH"}"`);
    return;
  }
  const missing = missingSetupEnv(plugin.setup);
  console.log(`plugin_env=${missing.length ? "needs_env" : "ready"}${missing.length ? ` missing=${missing.join(",")}` : ""}`);
  await printPluginSetupStatus(plugin, { enabled });
  if (plugin.setup?.mcpServers?.length) {
    for (const id of plugin.setup.mcpServers) {
      const mcp = findBuiltinMcpEntry(id);
      if (mcp) await printMcpCheck(mcp);
    }
  }
  const next = enabled
    ? plugin.setup?.mcpServers?.length
      ? `muster mcp check ${plugin.setup.mcpServers[0]}`
      : plugin.setup?.channels?.length
        ? `muster channels ready ${plugin.setup.channels[0]}`
        : "muster plugins list"
    : `muster plugins enable ${plugin.id}${plugin.risk === "high" ? " --allow-high-risk" : ""}`;
  console.log(`next="${next}"`);
}

function providerSetupUrl(providerId: string): string | undefined {
  const preset = PROVIDER_PRESETS.find((entry) => entry.id === providerId);
  const id = preset?.id ?? providerId;
  const urls: Record<string, string> = {
    openai: "https://platform.openai.com/api-keys",
    anthropic: "https://console.anthropic.com/settings/keys",
    openrouter: "https://openrouter.ai/settings/keys",
    groq: "https://console.groq.com/keys",
    cerebras: "https://cloud.cerebras.ai/platform/",
    gemini: "https://aistudio.google.com/app/apikey",
    deepseek: "https://platform.deepseek.com/api_keys",
    mistral: "https://console.mistral.ai/api-keys/",
    xai: "https://console.x.ai/",
    kimi: "https://platform.moonshot.ai/console/api-keys",
    qwen: "https://bailian.console.aliyun.com/",
    zhipu: "https://open.bigmodel.cn/usercenter/apikeys",
    perplexity: "https://www.perplexity.ai/settings/api",
    together: "https://api.together.xyz/settings/api-keys",
    fireworks: "https://fireworks.ai/account/api-keys",
    "claude-code": "https://docs.anthropic.com/en/docs/claude-code/setup",
    "codex-cli": "https://github.com/openai/codex",
    codex: "https://github.com/openai/codex",
  };
  return urls[id];
}

function pluginSetupUrl(pluginId: string): string | undefined {
  const plugin = listBuiltinPlugins().find((entry) => entry.id === pluginId || entry.aliases?.includes(pluginId));
  if (plugin?.setup?.setupUrls?.[0]) return plugin.setup.setupUrls[0];
  const urls: Record<string, string> = {
    browser: "https://github.com/microsoft/playwright-mcp",
    "web-search": "https://brave.com/search/api/",
    github: "https://github.com/settings/tokens",
    "google-workspace": "https://console.cloud.google.com/apis/credentials",
    notion: "https://www.notion.so/profile/integrations",
    airtable: "https://airtable.com/create/tokens",
    slack: "https://api.slack.com/apps",
    discord: "https://discord.com/developers/applications",
    teams: "https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade",
    huggingface: "https://huggingface.co/settings/tokens",
    codex: "https://github.com/openai/codex",
    "codex-native-tools": "https://github.com/openai/codex",
    "claude-code": "https://docs.anthropic.com/en/docs/claude-code/setup",
    "mcp-bridge": "https://modelcontextprotocol.io/",
  };
  return urls[plugin?.id ?? pluginId];
}

function chatPluginSetupLines(plugin: BuiltinPluginCatalogEntry): string[] {
  const setup = plugin.setup;
  if (!setup) return pluginNextActions(plugin).map((line) => color(line, "dim")).slice(0, 5);
  const lines: string[] = [];
  const missing = missingSetupEnv(setup);
  if (missing.length) lines.push(`${color("Missing env", "yellow")} ${missing.join(", ")}`);
  if (setup.defaultMcpServers?.length) lines.push(`${color("Default MCP", "accent")} ${setup.defaultMcpServers.join(", ")} configured by CLI enable`);
  if (setup.channels?.length) lines.push(`${color("Channel setup", "accent")} ${setup.channels.map((id) => `muster channels ready ${id}`).join(" · ")}`);
  if (setup.mcpServers?.length) lines.push(`${color("MCP options", "accent")} ${setup.mcpServers.join(", ")}`);
  for (const note of setup.notes ?? []) lines.push(color(note, "dim"));
  lines.push(...pluginNextActions(plugin).map((line) => color(line, "dim")));
  return lines.slice(0, 8);
}

function pluginNextActions(
  plugin: BuiltinPluginCatalogEntry,
  options: { readonly enabled?: boolean } = {},
): string[] {
  const actions: string[] = [];
  const providerPreset = pluginProviderPresetId(plugin);
  const setupUrl = plugin.setup?.setupUrls?.[0] ?? pluginSetupUrl(plugin.id);
  const missing = missingSetupEnv(plugin.setup);

  if (providerPreset) {
    actions.push(`next_action=provider_add command="muster provider add ${providerPreset}"`);
    actions.push(`next_action=provider_switch command="/provider ${providerPreset}"`);
    const preset = PROVIDER_PRESETS.find((entry) => entry.id === providerPreset);
    if (preset) actions.push(`provider_default model=${preset.defaultModel} key_env=${preset.apiKeyEnv ?? "-"}`);
    if (missing.length) actions.push(`next_action=credentials missing=${missing.join(",")} setup_url=${setupUrl ?? "-"}`);
    return actions;
  }

  if (plugin.setup?.channels?.length) {
    for (const channel of plugin.setup.channels) {
      actions.push(`next_action=channel_setup command="muster channels ready ${channel}"`);
    }
  }

  const installableMcps = (plugin.setup?.defaultMcpServers?.length ? plugin.setup.defaultMcpServers : plugin.setup?.mcpServers) ?? [];
  if (installableMcps.length) {
    for (const id of installableMcps.slice(0, 4)) {
      const entry = findBuiltinMcpEntry(id);
      const missingMcp = missingMcpEnv(entry);
      const command = missingMcp.length ? `muster mcp check ${id}` : `muster mcp install ${id}`;
      actions.push(`next_action=mcp_${missingMcp.length ? "check" : "install"} command="${command}"`);
    }
  }

  if (plugin.packPath && options.enabled !== true) {
    actions.push(`next_action=enable_pack command="muster plugins enable ${plugin.id}${plugin.risk === "high" ? " --allow-high-risk" : ""}"`);
  }

  if (plugin.category === "memory") {
    actions.push("next_action=memory_policy command=\"muster memory status --probe\" note=\"Muster keeps scoped SQLite/FTS memory local unless you explicitly sync an external memory provider.\"");
  }

  if (!actions.length && plugin.actionability === "setup_plan") {
    actions.push(`next_action=setup_plan command="muster plugins setup ${plugin.id}"`);
  }

  if (setupUrl) actions.push(`next_action=open_setup url=${setupUrl}`);
  if (plugin.actionability === "setup_plan") actions.push("note=setup_plan means this is discoverable and guided, not an installed execution adapter yet.");
  return actions;
}

function pluginProviderPresetId(plugin: BuiltinPluginCatalogEntry): string | undefined {
  const candidates = [
    plugin.id,
    plugin.id.startsWith("provider-") ? plugin.id.slice("provider-".length) : undefined,
    ...(plugin.aliases ?? []),
  ].filter((value): value is string => Boolean(value));
  return candidates.find((candidate) => PROVIDER_PRESETS.some((preset) => preset.id === candidate));
}

function mcpSetupUrl(id: string): string | undefined {
  const urls: Record<string, string> = {
    filesystem: "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
    git: "https://github.com/modelcontextprotocol/servers/tree/main/src/git",
    github: "https://github.com/modelcontextprotocol/servers/tree/main/src/github",
    browser: "https://github.com/microsoft/playwright-mcp",
    postgres: "https://github.com/modelcontextprotocol/servers/tree/main/src/postgres",
    sqlite: "https://github.com/modelcontextprotocol/servers/tree/main/src/sqlite",
    "parallel-search": "https://docs.parallel.ai/integrations/mcp/search-mcp",
    firecrawl: "https://www.firecrawl.dev/app/api-keys",
    linear: "https://linear.app/docs/mcp",
    n8n: "https://github.com/CyberSamuraiX/hermes-n8n-mcp",
    "google-drive": "https://console.cloud.google.com/apis/credentials",
    notion: "https://www.notion.so/profile/integrations",
  };
  return urls[id];
}

function filterPickerOptions(options: readonly PickerOption[], fragment: string): PickerOption[] {
  const lower = fragment.toLowerCase();
  return options
    .map((option, index) => ({ option, index, rank: pickerMatchRank(option, lower) }))
    .filter((entry) => entry.rank < Number.POSITIVE_INFINITY)
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map((entry) => entry.option);
}

function pickerMatchRank(option: PickerOption, lowerFragment: string): number {
  if (!lowerFragment) return 0;
  const value = option.value.toLowerCase();
  const label = option.label?.toLowerCase() ?? "";
  const description = option.description?.toLowerCase() ?? "";
  if (value.startsWith(lowerFragment)) return 0;
  if (label.startsWith(lowerFragment)) return 1;
  if (value.includes(lowerFragment)) return 2;
  if (label.includes(lowerFragment)) return 3;
  if (description.includes(lowerFragment)) return 4;
  return Number.POSITIVE_INFINITY;
}

function modelHintsForProvider(providerId: string | undefined, kind: string | undefined): string[] {
  // gpt-5.6-sol leads because it is what defaultConfig seeds and what the local
  // codex CLI runs; gpt-5.5 stays offered because profiles created before the
  // bump keep it in their config and packages/core/src/run.ts still names it as
  // the managed-codex fallback model — a model the config can hold must be a
  // model this list can offer.
  if (providerId === "codex" || providerId === "codex-cli" || kind === "codex-cli") return ["gpt-5.6-sol", "gpt-5.5", "gpt-5.4", "o4-mini", "o3", "gpt-4.1"];
  if (providerId === "anthropic") return ["claude-fable-5", "claude-sonnet-4.6", "claude-opus-4.5", "sonnet"];
  if (providerId === "openai") return ["gpt-5.6", "gpt-5.5", "gpt-5.4", "gpt-4.1", "o4-mini"];
  if (providerId === "openrouter") return ["anthropic/claude-sonnet-4.6", "openai/gpt-5.4", "google/gemini-2.5-pro"];
  if (providerId === "groq") return ["llama-3.3-70b-versatile", "openai/gpt-oss-120b"];
  if (providerId === "gemini") return ["gemini-2.5-pro", "gemini-2.5-flash"];
  return [];
}

async function printChatAgents(options: { numbered?: boolean } = {}): Promise<void> {
  const config = await loadConfig();
  const agents = config.agents?.list ?? [];
  const lines = Object.values(config.runtimes).map((runtime, index) => {
    const provider = config.providers[runtime.provider];
    const prefix = options.numbered ? `${color(`${String(index + 1).padStart(2)}.`, "accent")} ` : "";
    return `${prefix}${color(`${runtime.id}:`, "accent")} ${runtime.provider} · ${provider?.defaultModel ?? "-"} · ${runtime.enabled ? "enabled" : "disabled"}`;
  });
  if (!agents.length) {
    printChatPanel("Agents", [
      ...lines,
      color("No named agents configured. You can still type @agent-name <task> to route a turn.", "dim"),
      ...(options.numbered ? [color("Type a number to select an agent, or type @agent-name <task> directly.", "dim")] : []),
    ]);
    return;
  }
  printChatPanel("Agents", [
    ...lines,
    "",
    ...agents.map((agent, index) => {
      const prefix = options.numbered ? `${color(`${String(lines.length + index + 1).padStart(2)}.`, "accent")} ` : "";
      return `${prefix}${color(`@${agent.id}`, "accent")} ${agent.skills?.join(", ") || "no skill allowlist"}`;
    }),
    ...(options.numbered ? [color("Type a number to select an agent, or type @agent-name <task> directly.", "dim")] : []),
  ]);
}

/**
 * A command's answer is an ACTION RESULT, not a window: `⏺ Status` on its own
 * line with the body indented beneath it. Full-width frames are gone from the
 * chat surface; the composer is a bare `❯ ` prompt.
 */
function printChatPanel(title: string, lines: readonly string[]): void {
  const width = Math.min(Math.max((process.stdout.columns || 100) - 4, 72), 140);
  console.log(formatToolLine(title, undefined, "success"));
  for (const line of lines) {
    for (const part of wrapPreserveLines(line || "", width - 4)) {
      console.log(part ? `  ${part}` : "");
    }
  }
}

function summarizeCatalog<T>(
  entries: readonly T[],
  categoryOf: (entry: T) => string,
  idOf: (entry: T) => string,
  perCategory: number,
): string[] {
  const grouped = new Map<string, string[]>();
  for (const entry of entries) {
    const category = categoryOf(entry);
    const ids = grouped.get(category) ?? [];
    if (ids.length < perCategory) ids.push(idOf(entry));
    grouped.set(category, ids);
  }
  return [...grouped.entries()].slice(0, 8).map(([category, ids]) => `${category}: ${ids.join(", ")}`);
}

function findChatSessionForResume(value: string): SessionRow | undefined {
  const store = openSessionStore();
  try {
    if (value.startsWith("sess_")) {
      const result = store.search({ sessionId: value });
      return result.shape === "read" && result.session.channel === "cli-chat" ? result.session : undefined;
    }
    const result = store.search({ limit: 5000 });
    if (result.shape !== "browse") return undefined;
    const matches = result.sessions.filter((session) => session.channel === "cli-chat" && session.peer === value);
    return matches.find((session) => session.workspaceCwd === process.cwd()) ?? matches[0];
  } finally {
    store.close();
  }
}

function selectChatSessionForResume(value: string, state: ChatState): void {
  const requested = value.trim();
  const session = findChatSessionForResume(requested);
  state.sessionName = safeChatSessionName(session?.peer ?? requested);
  state.sessionWorkspaceCwd = session?.workspaceCwd ?? process.cwd();
  if (session?.workspaceCwd && session.workspaceCwd !== process.cwd()) {
    state.pendingMenu = { kind: "workspace-mismatch", sessionName: state.sessionName, workspaceCwd: session.workspaceCwd };
    console.log(color(formatWorkspaceMismatchBanner(session.workspaceCwd), "dim"));
    return;
  }
  state.workspaceCwd = undefined;
  console.log(color(`session=${state.sessionName}`, "green"));
}

function readNumberFromText(value: string): number | undefined {
  const token = value.split(/\s+/).find((part) => /^\d+$/.test(part));
  return token ? Number(token) : undefined;
}

async function promptWorkspaceMismatch(workspaceCwd: string): Promise<"home" | "here"> {
  console.log(color(formatWorkspaceMismatchBanner(workspaceCwd), "dim"));
  if (!process.stdin.isTTY || !process.stdout.isTTY) return "here";
  if (!existsSync(workspaceCwd)) return "here";
  emitKeypressEvents(input);
  const wasRaw = input.isRaw;
  input.setRawMode?.(true);
  input.resume();
  return new Promise((resolveChoice) => {
    const onKey = (chunk: string, key: { name?: string } = {}): void => {
      const data = key.name === "return" || key.name === "enter" ? "\r" : chunk;
      const choice = workspaceMismatchChoiceForKey(data);
      if (!choice) return;
      input.off("keypress", onKey);
      input.setRawMode?.(Boolean(wasRaw));
      resolveChoice(choice);
    };
    input.on("keypress", onKey);
  });
}

function chatConversationKey(sessionName: string): string {
  return `cli-chat:${sessionName}`;
}

function safeChatSessionName(value: string): string {
  const cleaned = value.trim().replace(/[^a-zA-Z0-9_.:-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!cleaned) return DEFAULT_CHAT_SESSION;
  return cleaned.slice(0, 80);
}

async function episodes(): Promise<void> {
  const records = await listEpisodes();
  if (!records.length) {
    console.log("No episodes recorded yet.");
    return;
  }
  for (const episode of records.slice(-20)) {
    console.log(
      `${episode.id} ${episode.createdAt} ${episode.taskKind} ${episode.runtimeId}/${episode.providerId}/${episode.model} ${episode.prompt.slice(0, 80)}`
    );
  }
}

async function feedback(args: string[]): Promise<void> {
  const episodeId = args[0];
  if (!episodeId) throw new Error("Missing episode id.");
  const useful = args.includes("--useful");
  const notUseful = args.includes("--not-useful");
  if (useful === notUseful) throw new Error("Pass exactly one of --useful or --not-useful.");
  const reason = readFlag(args, "--reason");
  const episode = await findEpisode(episodeId);
  if (!episode) throw new Error(`Episode not found: ${episodeId}`);
  const record = adjudicateFeedback(
    {
      episodeId,
      value: (useful ? "useful" : "not_useful") as FeedbackValue,
      reason,
      correctAndWorked: args.includes("--correct")
    },
    episode
  );
  await appendFeedback(record);
  console.log(`feedback=${record.value}`);
  console.log(`adjudication=${record.adjudication}`);
  for (const candidate of record.learningCandidates) {
    console.log(`candidate=${candidate.kind} risk=${candidate.risk} auto=${candidate.autoApply} ${candidate.summary}`);
  }
}

async function candidates(): Promise<void> {
  const records = await listLearningCandidates();
  if (!records.length) {
    console.log("No learning candidates recorded yet.");
    return;
  }
  for (const candidate of records) {
    console.log(
      `${candidate.episodeId}\t${candidate.kind}\t${candidate.risk}\tauto=${candidate.autoApply}\t${candidate.summary}`
    );
  }
}

async function evalCommand(args: string[]): Promise<void> {
  const subcommand = args[0];
  if (subcommand === "seed") {
    const episodeId = args[1];
    if (!episodeId) throw new Error('Usage: muster eval seed <episode-id> [--expect "..."] [--forbid "..."]');
    const fixture = await seedEvalFromEpisode(episodeId, {
      expectedContains: readFlags(args, "--expect"),
      forbiddenContains: readFlags(args, "--forbid")
    });
    console.log(`eval=${fixture.id}`);
    console.log(`source_episode=${fixture.sourceEpisodeId}`);
    console.log(`path=${evalPath(fixture.id)}`);
    console.log(`expected=${fixture.expectedContains.join(" | ")}`);
    if (fixture.forbiddenContains?.length) console.log(`forbidden=${fixture.forbiddenContains.join(" | ")}`);
    return;
  }
  if (subcommand === "run") {
    const target = args[1];
    const results = await runEvalCases(target);
    if (!results.length) {
      console.log("No eval fixtures found.");
      return;
    }
    for (const result of results) {
      console.log(`eval=${result.id} status=${result.status} source_episode=${result.sourceEpisodeId}`);
      for (const check of result.checks) {
        console.log(`check=${check.label} status=${check.status} detail=${check.detail}`);
      }
    }
    if (results.some((result) => result.status === "failed")) process.exitCode = 1;
    return;
  }
  if (subcommand === "retrieval") {
    if (args.includes("--help") || args.includes("-h")) {
      console.log("Usage:");
      console.log("  muster eval retrieval seed <id> --query \"...\" --scope user:me --expect mem_... | --expect-none");
      console.log("  muster eval retrieval seed-pack <id> [--tenant f2] [--user goblin] [--other-user goblin-other] [--distractors 250]");
      console.log("  muster eval retrieval seed-frappe-pack <id> [--tenant f2] [--user goblin] [--app frappe_app] [--module HR] [--doctype Employee] [--child-doctype \"Employee Detail\"] [--distractors 250]");
      console.log("  muster eval retrieval list [path-or-dir]");
      console.log("  muster eval retrieval <path-or-dir> [--min-recall 1] [--min-mrr 1] [--max-leakage-rate 0] [--max-stale-hit-rate 0] [--max-p95-ms 50] [--artifact-dir DIR]");
      return;
    }
    if (args[1] === "seed-pack") {
      const pack = await seedRepresentativeRetrievalEvalPack({
        id: args[2],
        tenant: readFlag(args, "--tenant"),
        user: readFlag(args, "--user"),
        otherUser: readFlag(args, "--other-user"),
        distractorCount: readNumberFlag(args, "--distractors"),
      });
      console.log(`retrieval_pack=${pack.id}`);
      console.log(`path=${pack.dir}`);
      console.log(`scopes=${pack.scopes.join(",")}`);
      console.log(`fixtures=${pack.fixtures.length}`);
      console.log(`mem_exact=${pack.memoryIds.exact}`);
      console.log(`mem_fresh=${pack.memoryIds.fresh}`);
      console.log(`mem_stale=${pack.memoryIds.stale}`);
      console.log(`mem_forbidden=${pack.memoryIds.forbidden}`);
      console.log(`distractors=${pack.memoryIds.distractors.length}`);
      return;
    }
    if (args[1] === "seed-frappe-pack") {
      const pack = await seedFrappeGraphRetrievalEvalPack({
        id: args[2],
        tenant: readFlag(args, "--tenant"),
        user: readFlag(args, "--user"),
        otherUser: readFlag(args, "--other-user"),
        app: readFlag(args, "--app"),
        module: readFlag(args, "--module"),
        doctype: readFlag(args, "--doctype"),
        childDoctype: readFlag(args, "--child-doctype"),
        distractorCount: readNumberFlag(args, "--distractors"),
      });
      console.log(`retrieval_pack=${pack.id}`);
      console.log(`kind=frappe-graph`);
      console.log(`path=${pack.dir}`);
      console.log(`scopes=${pack.scopes.join(",")}`);
      console.log(`fixtures=${pack.fixtures.length}`);
      console.log(`mem_doctype=${pack.memoryIds.exact}`);
      console.log(`mem_fresh=${pack.memoryIds.fresh}`);
      console.log(`mem_stale=${pack.memoryIds.stale}`);
      console.log(`mem_forbidden=${pack.memoryIds.forbidden}`);
      console.log(`mem_graph=${pack.memoryIds.graph?.join(",") ?? ""}`);
      console.log(`distractors=${pack.memoryIds.distractors.length}`);
      return;
    }
    if (args[1] === "seed") {
      const id = args[2];
      const query = readFlag(args, "--query");
      if (!id || !query) throw new Error("Usage: muster eval retrieval seed <id> --query \"...\" --scope user:me --expect mem_... | --expect-none");
      const fixture = await seedRetrievalEvalCase({
        id,
        query,
        scopes: readFlags(args, "--scope"),
        expectedIds: readFlags(args, "--expect"),
        expectedNone: args.includes("--expect-none"),
        forbiddenIds: readFlags(args, "--forbid"),
        staleIds: readFlags(args, "--stale"),
        staleBefore: readFlag(args, "--stale-before"),
        graphExpand: args.includes("--graph-expand"),
        includeGlobal: args.includes("--include-global"),
        topK: readNumberFlag(args, "--top-k"),
      });
      console.log(`retrieval_eval=${fixture.id}`);
      console.log(`path=${retrievalEvalPath(fixture.id)}`);
      console.log(`query=${fixture.query}`);
      console.log(`scopes=${fixture.scopes.join(",")}`);
      console.log(`expected=${fixture.expectedNone ? "none" : fixture.expectedIds.join(",")}`);
      if (fixture.forbiddenIds?.length) console.log(`forbidden=${fixture.forbiddenIds.join(",")}`);
      if (fixture.staleIds?.length) console.log(`stale=${fixture.staleIds.join(",")}`);
      if (fixture.staleBefore) console.log(`stale_before=${fixture.staleBefore}`);
      return;
    }
    if (args[1] === "list") {
      const listings = await listRetrievalEvalCases(args[2]);
      if (!listings.length) {
        console.log("No retrieval eval fixtures found.");
        return;
      }
      console.log("id\ttopK\tgraph\tscopes\texpected\tforbidden\tstale\tstale_before\tpath");
      for (const { path, fixture } of listings) {
        console.log([
          fixture.id,
          String(fixture.topK ?? 5),
          fixture.graphExpand ? "yes" : "no",
          fixture.scopes.join(","),
          fixture.expectedNone ? "none" : String(fixture.expectedIds.length),
          String(fixture.forbiddenIds?.length ?? 0),
          String(fixture.staleIds?.length ?? 0),
          fixture.staleBefore ?? "-",
          path,
        ].join("\t"));
      }
      return;
    }
    const target = args[1] === "run" ? args[2] : args[1];
    if (!target) throw new Error("Usage: muster eval retrieval <path-or-dir>");
    const thresholds = {
      minRecallAtK: readNumberFlag(args, "--min-recall") ?? 1,
      minMrr: readNumberFlag(args, "--min-mrr") ?? 1,
      maxLeakageRate: readNonNegativeNumberFlag(args, "--max-leakage-rate") ?? 0,
      maxStaleHitRate: readNonNegativeNumberFlag(args, "--max-stale-hit-rate") ?? 0,
      maxP95LatencyMs: readNonNegativeNumberFlag(args, "--max-p95-ms"),
    };
    const artifactDir = readFlag(args, "--artifact-dir");
    const artifact = artifactDir
      ? await runRetrievalEvalPathWithArtifacts(target, thresholds, artifactDir)
      : undefined;
    const suite = artifact?.suite ?? await runRetrievalEvalPath(target, thresholds);
    const gate = decideHybridRetrievalGate(suite);
    console.log(`retrieval_suite status=${suite.status} cases=${suite.caseCount} recall@5=${suite.recallAtK.toFixed(3)} mrr@5=${suite.mrr.toFixed(3)} leakage_rate=${suite.leakageRate.toFixed(3)} unexpected_hit_rate=${suite.unexpectedHitRate.toFixed(3)} stale_hit_rate=${suite.staleHitRate.toFixed(3)} p95_ms=${suite.p95LatencyMs.toFixed(3)}`);
    console.log(`hybrid_gate allowed=${gate.allowed} reason=${gate.reason}`);
    if (artifact) {
      console.log(`artifact_dir=${artifact.artifactDir}`);
      console.log(`artifact_manifest=${artifact.manifestPath}`);
      console.log(`artifact_cases=${artifact.casesPath}`);
      console.log(`artifact_suite=${artifact.suitePath}`);
      console.log(`artifact_memory_status=${artifact.memoryStatusPath}`);
    }
    for (const check of suite.checks) {
      console.log(`check=${check.label} status=${check.status} detail=${check.detail}`);
    }
    for (const result of suite.results) {
      console.log(`case=${result.id} status=${result.status} recall@5=${result.recallAtK.toFixed(3)} mrr@5=${result.mrr.toFixed(3)} leaks=${result.leakageCount} unexpected_hits=${result.unexpectedHitCount} stale_hits=${result.staleHitCount} latency_ms=${result.latencyMs.toFixed(3)} backend=${result.backend} returned=${result.returnedIds.join(",") || "none"}`);
    }
    if (suite.status === "failed") process.exitCode = 1;
    return;
  }
  throw new Error("Usage: muster eval <seed|run|retrieval>");
}

async function capability(args: string[]): Promise<void> {
  const subcommand = args[0];
  const path = args[1];
  if (subcommand === "load") {
    if (!path) throw new Error("Usage: muster capability load <path> [--allow-high-risk]");
    const registry = builtinFlowRegistry();
    const pluginPolicy = await loadPluginPolicy();
    const packPath = resolveWorkspacePath(path);
    const loaded = await loadCapabilityPack(packPath, {
      registry,
      allowHighRisk: args.includes("--allow-high-risk"),
      pluginPolicy
    });
    console.log(`pack=${loaded.manifest.id} version=${loaded.manifest.version}`);
    console.log(`permissions=${loaded.manifest.permissions.join(",") || "none"}`);
    console.log(`tools_registered=${loaded.toolNames.length} (dry-run: nothing persisted)`);
    for (const name of loaded.toolNames) console.log(`tool=${name}`);
    for (const warning of loaded.warnings) console.log(`warning=${warning}`);
    console.log(`use in flows: { "kind": "tool", "tool": "${loaded.toolNames[0]}" } with: muster flow run <id> --pack ${path}`);
    return;
  }
  if (subcommand === "digest") {
    if (!path) throw new Error("Usage: muster capability digest <path> [--write]");
    const packPath = resolveWorkspacePath(path);
    const manifestPath = await capabilityManifestPath(packPath);
    const raw = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
    const inspection = inspectCapabilityManifest(packPath, raw);
    if (!inspection.manifest) {
      console.log(`capability=${path} status=blocked manifest=${manifestPath}`);
      for (const blocker of inspection.blockers) console.log(`blocker=${blocker}`);
      process.exitCode = 1;
      return;
    }
    const digest = await computeCapabilityEntrypointDigest(packPath, inspection.manifest);
    console.log(`capability=${inspection.manifest.id} digest=${digest} entrypoint=${inspection.manifest.entrypoint}`);
    if (!args.includes("--write")) {
      console.log(`manifest=${manifestPath} write=false`);
      return;
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`Capability manifest ${manifestPath} must be a JSON object.`);
    await writeFile(manifestPath, `${JSON.stringify({ ...(raw as Record<string, unknown>), digest }, null, 2)}\n`, "utf8");
    console.log(`manifest=${manifestPath} write=true`);
    return;
  }
  if (subcommand !== "inspect" || !path) {
    throw new Error("Usage: muster capability <inspect|digest|load> <path>");
  }
  const report = await inspectCapabilityPack(resolveWorkspacePath(path));
  console.log(`status=${report.status}`);
  console.log(`risk=${report.risk}`);
  console.log(`path=${report.path}`);
  if (report.manifest) {
    console.log(`id=${report.manifest.id}`);
    console.log(`name=${report.manifest.name}`);
    console.log(`version=${report.manifest.version}`);
    console.log(`kind=${report.manifest.kind}`);
    console.log(`sandbox=${report.manifest.sandbox}`);
    console.log(`permissions=${report.manifest.permissions.join(",") || "none"}`);
    console.log(`secrets=${report.manifest.secrets?.join(",") || "none"}`);
    console.log(`evals=${report.manifest.evals?.join(",") || "none"}`);
    console.log(`digest=${report.manifest.digest ?? "missing"}`);
  }
  if (report.blockers.length) {
    console.log("blockers:");
    for (const blocker of report.blockers) console.log(`- ${blocker}`);
  }
  if (report.warnings.length) {
    console.log("warnings:");
    for (const warning of report.warnings) console.log(`- ${warning}`);
  }
  if (report.status === "blocked") process.exitCode = 1;
}

async function rosterCommand(args: string[]): Promise<void> {
  const subcommand = args[0];
  const id = args[1];
  const jsonOutput = args.includes("--json");
  if (subcommand === "catalog" || subcommand === undefined) {
    const { shouldScanHosts, detection } = await rosterHostDetectionFromArgs(args);
    const hostConnectors = detection.connectors;
    const matrix = buildRosterSupportMatrix({ hostConnectors });
    const payload = {
      schemaVersion: 1,
      command: "roster.catalog",
      hostScan: shouldScanHosts ? "enabled" : "skipped",
      hostCache: detection.cacheStatus,
      detectedHosts: hostConnectors.length,
      hostConnectors,
      hostEvidence: detection.evidence,
      matrix,
    };
    if (jsonOutput) {
      await printRosterJsonOrReport(args, payload, { jsonOutput });
      return;
    }
    await printRosterJsonOrReport(args, payload, { jsonOutput });
    console.log(`roster_catalog entries=${matrix.entries.length} detected_hosts=${hostConnectors.length} host_scan=${shouldScanHosts ? "enabled" : "skipped"} host_cache=${detection.cacheStatus}`);
    console.log([
      `support_summary owned_packs=${matrix.summary.ownedPacks}`,
      `channel_adapters=${matrix.summary.channelAdapters}`,
      `mcp_installable=${matrix.summary.mcpInstallable}`,
      `host_reuse=${matrix.summary.hostReuse}`,
      `setup_plan_only=${matrix.summary.setupPlanOnly}`,
    ].join(" "));
    for (const item of detection.evidence) printRosterHostEvidence(item);
    for (const entry of matrix.entries) {
      const auth = entry.auth.length ? entry.auth.join(",") : "-";
      const hosts = entry.hosts.length ? entry.hosts.join(",") : "-";
      const pack = entry.packPath ?? "-";
      const mcps = entry.mcpServers.length ? entry.mcpServers.join(",") : "-";
      const channels = entry.channels.length ? entry.channels.join(",") : "-";
      console.log(`${entry.id}\t${entry.kind}\t${entry.source}\t${entry.support.join(",")}\tauth=${auth}\thosts=${hosts}\tpack=${pack}\tmcps=${mcps}\tchannels=${channels}`);
    }
    return;
  }
  if (subcommand === "index") {
    const outPath = readFlag(args, "--out");
    const packPaths = rosterIndexPackArgs(args.slice(1));
    if (args.includes("--builtin-packs")) {
      for (const plugin of listBuiltinPlugins()) {
        if (!plugin.packPath) continue;
        const packPath = await resolveBuiltinPackPath(plugin);
        if (!packPath) throw new Error(`Built-in capability pack ${plugin.id} was not found at ${plugin.packPath}.`);
        packPaths.push(packPath);
      }
    }
    const uniquePackPaths = [...new Set(packPaths)];
    if (!outPath && !args.includes("--dry-run")) {
      throw new Error("Usage: muster roster index --out roster.index.json [--builtin-packs] [--skip-blocked] [pack-path ...] [--dry-run]");
    }
    const musterCompatibility = readFlag(args, "--muster-compatibility") ?? `>=${CLI_MUSTER_VERSION}`;
    const musterVersion = readFlag(args, "--muster-version") ?? CLI_MUSTER_VERSION;
    const skipBlocked = args.includes("--skip-blocked");
    const skipped: RosterSkippedPack[] = [];
    const index = skipBlocked
      ? await buildRosterIndexSkippingBlocked(uniquePackPaths, {
        musterCompatibility,
        musterVersion,
        generatedAt: readFlag(args, "--generated-at"),
      }, skipped)
      : await buildRosterIndexFromPacks(uniquePackPaths, {
        musterCompatibility,
        musterVersion,
        cwd: process.cwd(),
        generatedAt: readFlag(args, "--generated-at"),
      });
    const resolvedOutPath = outPath ? resolveWorkspacePath(outPath) : undefined;
    const summary = summarizeRosterIndex(index);
    const reportPayload = {
      schemaVersion: 1,
      command: "roster.index",
      dryRun: args.includes("--dry-run"),
      outPath: resolvedOutPath,
      musterVersion,
      musterCompatibility,
      skipBlocked,
      summary,
      index,
      skipped,
    };
    const indexPayload = `${JSON.stringify(index, null, 2)}\n`;
    if (jsonOutput) {
      if (!args.includes("--dry-run") && resolvedOutPath) {
        await mkdir(dirname(resolvedOutPath), { recursive: true });
        await writeFile(resolvedOutPath, indexPayload, "utf8");
      }
      await printRosterJsonOrReport(args, reportPayload, { jsonOutput });
      return;
    }
    if (args.includes("--dry-run")) {
      await printRosterJsonOrReport(args, reportPayload, { jsonOutput });
      for (const item of skipped) printSkippedRosterPack(item, "stderr");
      console.log(indexPayload.trimEnd());
      return;
    }
    await mkdir(dirname(resolvedOutPath!), { recursive: true });
    await writeFile(resolvedOutPath!, indexPayload, "utf8");
    await printRosterJsonOrReport(args, reportPayload, { jsonOutput });
    console.log(`roster_index status=ready entries=${index.entries.length} out=${resolvedOutPath}`);
    console.log([
      `summary_total=${summary.total}`,
      `metadata=${summary.withMetadata}/${summary.total}`,
      `diagnostics=${summary.withDiagnostics}`,
      `evals=${summary.withEvalFixtures}`,
      `live_credentials=${summary.requiresLiveCredentials}`,
      `tools=${summary.implementedTools.length}`,
    ].join(" "));
    for (const entry of index.entries) {
      console.log(`entry=${entry.id} version=${entry.version} kind=${entry.kind} source=${entry.source.type}:${entry.source.type === "local" ? entry.source.path : entry.source.url}`);
      if (entry.metadata) printRosterEntryMetadata(entry.metadata);
    }
    for (const item of skipped) printSkippedRosterPack(item, "stdout");
    return;
  }
  if (subcommand === "plan") {
    if (!id && !args.includes("--all")) throw new Error("Usage: muster roster plan <id|--all> [--lock .muster/roster.lock.json] [--host provider|--scan-hosts] [--no-host-cache|--refresh-host-cache]");
    const lockPath = resolveWorkspacePath(readFlag(args, "--lock") ?? join(".muster", "roster.lock.json"));
    const lock = await readRosterLock(lockPath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    const { shouldScanHosts, detection } = await rosterHostDetectionFromArgs(args);
    if (args.includes("--all")) {
      const catalog = buildRosterProjectionCatalog({ lock, cwd: process.cwd(), hostConnectors: detection.connectors });
      const payload = {
        schemaVersion: 1,
        command: "roster.plan",
        mode: "all",
        lockPath: lock ? lockPath : undefined,
        hostScan: shouldScanHosts ? "enabled" : "skipped",
        hostCache: detection.cacheStatus,
        detectedHosts: detection.connectors.length,
        hostEvidence: detection.evidence,
        catalog,
      };
      if (jsonOutput) {
        await printRosterJsonOrReport(args, payload, { jsonOutput });
        if (catalog.summary.blocked) process.exitCode = 1;
        return;
      }
      await printRosterJsonOrReport(args, payload, { jsonOutput });
      console.log(`roster_plan_catalog total=${catalog.summary.total} ready=${catalog.summary.ready} needs_credentials=${catalog.summary.needsCredentials} setup_only=${catalog.summary.setupOnly} blocked=${catalog.summary.blocked} host_scan=${shouldScanHosts ? "enabled" : "skipped"} host_cache=${detection.cacheStatus}`);
      for (const item of detection.evidence) printRosterHostEvidence(item);
      for (const [level, count] of Object.entries(catalog.summary.depthLevels)) console.log(`depth=${level} plans=${count}`);
      for (const [owner, count] of Object.entries(catalog.summary.targetOwners)) console.log(`owner=${owner} targets=${count}`);
      for (const action of catalog.nextActions.slice(0, 12)) {
        console.log([
          `next=${action.planId}`,
          `priority=${action.priority}`,
          `reason=${action.reason}`,
          `command=${action.command ?? "-"}`,
          `summary=${action.summary}`,
        ].join(" "));
      }
      for (const plan of catalog.plans) {
        console.log(`plan=${plan.id} kind=${plan.kind} status=${plan.status} targets=${plan.targets.length} blockers=${plan.blockers.length}`);
      }
      if (catalog.summary.blocked) process.exitCode = 1;
      return;
    }
    const projection = lock?.entries[id]
      ? planRosterLockProjection(lock, id, { cwd: process.cwd() })
      : planRosterBuiltinProjection(id, { hostConnectors: detection.connectors });
    const payload = {
      schemaVersion: 1,
      command: "roster.plan",
      lockPath: lock?.entries[id] ? lockPath : undefined,
      hostScan: shouldScanHosts ? "enabled" : "skipped",
      hostCache: detection.cacheStatus,
      detectedHosts: detection.connectors.length,
      hostEvidence: detection.evidence,
      projection,
    };
    if (jsonOutput) {
      await printRosterJsonOrReport(args, payload, { jsonOutput });
      if (projection.status === "blocked") process.exitCode = 1;
      return;
    }
    await printRosterJsonOrReport(args, payload, { jsonOutput });
    console.log(`roster_plan id=${projection.id} kind=${projection.kind} status=${projection.status} targets=${projection.targets.length} host_scan=${shouldScanHosts ? "enabled" : "skipped"} host_cache=${detection.cacheStatus}`);
    for (const item of detection.evidence) printRosterHostEvidence(item);
    console.log([
      `depth=${projection.depth.level}`,
      `capabilities=${projection.depth.capabilities.length ? projection.depth.capabilities.join(",") : "-"}`,
      `auth=${projection.depth.auth.length ? projection.depth.auth.join(",") : "-"}`,
      `evidence=${projection.depth.evidence.length ? projection.depth.evidence.join(",") : "-"}`,
      `hot_path=${projection.depth.speed.hotPath}`,
      `cache=${projection.depth.speed.cache}`,
    ].join(" "));
    for (const gap of projection.depth.gaps) console.log(`gap=${gap}`);
    if (lock?.entries[id]) console.log(`lock=${lockPath}`);
    for (const blocker of projection.blockers) console.log(`blocker=${blocker}`);
    for (const gate of projection.gates) console.log(`gate=${gate.id} status=${gate.status} summary=${gate.summary}`);
    for (const target of projection.targets) {
      console.log([
        `target=${target.kind}`,
        `owner=${target.owner}`,
        `id=${target.id}`,
        `status=${target.status}`,
        `auth=${target.auth?.length ? target.auth.join(",") : "-"}`,
        `command=${target.command ?? "-"}`,
        `source=${target.source ?? "-"}`,
      ].join(" "));
    }
    for (const note of projection.notes) console.log(`note=${note}`);
    if (projection.status === "blocked") process.exitCode = 1;
    return;
  }
  if (subcommand === "publish") {
    const packPathArg = args.find((arg, index) => index > 0 && !arg.startsWith("--") && args[index - 1] !== "--source-path" && args[index - 1] !== "--muster-compatibility" && args[index - 1] !== "--muster-version");
    if (!args.includes("--dry-run") || !packPathArg) {
      throw new Error("Usage: muster roster publish --dry-run <path> [--source-path path] [--muster-compatibility >=0.1.0] [--muster-version x.y.z] [--json] [--report path]");
    }
    const packPath = resolveWorkspacePath(packPathArg);
    const sourcePath = readFlag(args, "--source-path") ?? packPath;
    const musterCompatibility = readFlag(args, "--muster-compatibility") ?? `>=${CLI_MUSTER_VERSION}`;
    const musterVersion = readFlag(args, "--muster-version") ?? CLI_MUSTER_VERSION;
    const draft = await buildRosterEntryFromPack(packPath, {
      source: { type: "local", path: sourcePath },
      musterCompatibility,
      musterVersion,
      cwd: process.cwd(),
    });
    const payload = {
      schemaVersion: 1,
      command: "roster.publish",
      dryRun: true,
      packPath,
      sourcePath,
      musterVersion,
      musterCompatibility,
      entry: draft.entry,
      verification: draft.verification,
    };
    await printRosterJsonOrReport(args, payload, { jsonOutput });
    if (jsonOutput) return;
    console.log(JSON.stringify(draft.entry, null, 2));
    return;
  }

  if (subcommand === "verify") {
    const indexPath = resolveWorkspacePath(readFlag(args, "--index") ?? "roster.index.json");
    const musterVersion = readFlag(args, "--muster-version") ?? CLI_MUSTER_VERSION;
    const verificationProfile = readRosterVerificationProfile(args);
    const index = await loadRosterIndex(indexPath);
    const report = await verifyRosterIndex(index, { musterVersion, cwd: process.cwd(), requireMetadata: verificationProfile.requireMetadata, minReadinessLevel: verificationProfile.minReadinessLevel });
    const indexSummary = summarizeRosterIndex(index);
    const summary = summarizeRosterVerification(report);
    const payload = {
      schemaVersion: 1,
      command: "roster.verify",
      indexPath,
      musterVersion,
      registryProfile: verificationProfile.registryProfile,
      requireMetadata: verificationProfile.requireMetadata,
      minReadinessLevel: verificationProfile.minReadinessLevel,
      indexSummary,
      summary,
      report,
    };
    if (jsonOutput) {
      await printRosterJsonOrReport(args, payload, { jsonOutput });
      if (report.status === "blocked") process.exitCode = 1;
      return;
    }
    await printRosterJsonOrReport(args, payload, { jsonOutput });
    console.log(`roster_verify status=${report.status} ready=${report.readyCount} blocked=${report.blockedCount} total=${report.results.length}`);
    console.log([
      `index_summary total=${indexSummary.total}`,
      `metadata=${indexSummary.withMetadata}/${indexSummary.total}`,
      `diagnostics=${indexSummary.withDiagnostics}`,
      `evals=${indexSummary.withEvalFixtures}`,
      `live_credentials=${indexSummary.requiresLiveCredentials}`,
      `tools=${indexSummary.implementedTools.length}`,
    ].join(" "));
    console.log(`verify_summary total=${summary.total} ready=${summary.ready} blocked=${summary.blocked} blocked_entries=${summary.blockedEntries.length}`);
    for (const [gateId, totals] of Object.entries(summary.gateTotals)) {
      console.log(`gate_summary=${gateId} passed=${totals.passed} blocked=${totals.blocked}`);
    }
    for (const repair of summary.repairs) {
      console.log(`repair=${repair.entry} gate=${repair.gate} command="${repair.command}"`);
    }
    for (const result of report.results) {
      console.log(`entry=${result.entry.id} version=${result.entry.version} status=${result.status}`);
      for (const gate of result.gates.filter((gate) => gate.status === "blocked")) {
        console.log(`  gate=${gate.id} status=${gate.status} summary=${gate.summary}`);
      }
    }
    if (report.status === "blocked") process.exitCode = 1;
    return;
  }

  if (subcommand === "activate") {
    if (!id) throw new Error("Usage: muster roster activate <id|mcp:id|channel:id|skill:id> [--lock .muster/roster.lock.json] [--muster-version x.y.z] [--dry-run] [--json] [--report path]");
    const dryRun = args.includes("--dry-run");
    if (id.startsWith("skill:")) {
      const skillId = id.slice("skill:".length);
      const projection = planRosterBuiltinProjection(id);
      const target = projection.targets.find((item) => item.kind === "skill" && item.id === skillId);
      const payload = {
        schemaVersion: 1,
        command: "roster.activate",
        kind: "builtin_skill",
        id,
        dryRun,
        projection,
        mutation: {
          configPath: configPath(process.cwd()),
          wouldWriteConfig: projection.status !== "blocked" && Boolean(target) && !dryRun,
          didWriteConfig: false,
          boundary: "profile skill file and skills.entries only",
        },
      };
      if (jsonOutput) {
        if (projection.status !== "blocked" && target && !dryRun) {
          await ensureDefaultConfig(process.cwd());
          const skill = await enableBuiltinSkill(skillId, process.cwd());
          await printRosterJsonOrReport(args, {
            ...payload,
            mutation: { ...payload.mutation, didWriteConfig: true },
            result: { enabled: skill.id, source: skill.source, risk: skill.risk, next: `muster skills view ${skill.id}` },
          }, { jsonOutput });
          return;
        }
        await printRosterJsonOrReport(args, payload, { jsonOutput });
        if (projection.status === "blocked" || !target) process.exitCode = 1;
        return;
      }
      const willApplySkill = projection.status !== "blocked" && Boolean(target) && !dryRun;
      if (!willApplySkill) await printRosterJsonOrReport(args, payload, { jsonOutput });
      console.log(`activation=${id} kind=builtin_skill status=${projection.status}`);
      for (const blocker of projection.blockers) console.log(`blocker=${blocker}`);
      for (const gate of projection.gates) console.log(`gate=${gate.id} status=${gate.status} summary=${gate.summary}`);
      if (!target || projection.status === "blocked") {
        process.exitCode = 1;
        return;
      }
      console.log(`skill=${target.id} command=${target.command ?? `muster skills enable ${skillId}`}`);
      console.log("mutation_boundary=profile skill file and skills.entries only");
      if (dryRun) {
        console.log("config=unchanged dry_run=true");
        return;
      }
      await ensureDefaultConfig(process.cwd());
      const skill = await enableBuiltinSkill(skillId, process.cwd());
      console.log(`enabled=${skill.id} source=${skill.source} risk=${skill.risk}`);
      console.log(`config=${configPath(process.cwd())}`);
      console.log(`next=muster skills view ${skill.id}`);
      await printRosterJsonOrReport(args, {
        ...payload,
        mutation: { ...payload.mutation, didWriteConfig: true },
        result: { enabled: skill.id, source: skill.source, risk: skill.risk, next: `muster skills view ${skill.id}` },
      }, { jsonOutput });
      return;
    }
    if (id.startsWith("channel:")) {
      const channelId = id.slice("channel:".length);
      const spec = requireChannelSpec(channelId);
      const gateway = await loadGatewayConfig().then(
        (config) => ({ config, initialized: true }),
        () => ({ config: emptyGatewayConfig(), initialized: false }),
      );
      const requestedSlackMode = commandLineSlackMode(args);
      const publicUrl = readFlag(args, "--public-url")?.replace(/\/$/, "");
      const missing = channelMissingSetup(spec.id, gateway.config, requestedSlackMode);
      const ready = missing.length === 0;
      const activationPlan = {
        id: spec.id,
        status: ready ? "ready" : "blocked",
        gatewayInitialized: gateway.initialized,
        missing,
        route: spec.route ?? "/v1/messages",
        ingress: channelIngressMode(spec.id, gateway.config, { publicUrl, slackMode: requestedSlackMode }),
        authMode: channelAuthModeForConfig(spec.id, gateway.config, requestedSlackMode),
        replyMode: channelReplyMode(spec.id, gateway.config),
        setupCommand: `muster channels ready ${spec.id}${spec.id === "slack" && requestedSlackMode ? ` --mode ${requestedSlackMode}` : ""}${publicUrl ? ` --public-url ${publicUrl}` : ""}`,
        doctorCommand: `muster channels doctor ${spec.id}${spec.id === "telegram" || spec.id === "slack" ? " --live" : ""}`,
        startCommand: channelStartCommand(spec.id, gateway.config, { publicUrl, slackMode: requestedSlackMode }),
        webhookCommand: spec.id === "telegram" && publicUrl ? `muster gateway webhook telegram --public-url ${publicUrl}` : undefined,
        localSimulationCommand: `muster channels simulate ${spec.id} --message "hello"`,
        mutationBoundary: "gateway channel config only via muster channels ready",
        notes: spec.notes,
      };
      const payload = {
        schemaVersion: 1,
        command: "roster.activate",
        kind: "channel_adapter",
        id,
        dryRun,
        plan: activationPlan,
        mutation: {
          configPath: gatewayConfigPath(process.cwd()),
          wouldWriteConfig: false,
          didWriteConfig: false,
          boundary: activationPlan.mutationBoundary,
        },
      };
      if (jsonOutput) {
        await printRosterJsonOrReport(args, payload, { jsonOutput });
        if (!ready) process.exitCode = 1;
        return;
      }
      await printRosterJsonOrReport(args, payload, { jsonOutput });
      console.log(`activation=${id} kind=channel_adapter status=${activationPlan.status}`);
      console.log(`gateway_config=${gateway.initialized ? "configured" : "missing"} path=${gatewayConfigPath(process.cwd())}`);
      console.log(`route=${activationPlan.route} ingress=${activationPlan.ingress} auth=${activationPlan.authMode} reply=${activationPlan.replyMode}`);
      for (const item of missing) console.log(`missing=${item}`);
      console.log(`setup=${activationPlan.setupCommand}`);
      console.log(`doctor=${activationPlan.doctorCommand}`);
      console.log(`simulate=${activationPlan.localSimulationCommand}`);
      console.log(`start=${activationPlan.startCommand}`);
      if (activationPlan.webhookCommand) console.log(`webhook=${activationPlan.webhookCommand}`);
      console.log(`mutation_boundary=${activationPlan.mutationBoundary}`);
      if (!ready) {
        process.exitCode = 1;
        return;
      }
      console.log(dryRun ? "config=unchanged dry_run=true" : "config=unchanged");
      if (!dryRun) console.log(`enabled=${spec.id}`);
      return;
    }
    if (id.startsWith("mcp:")) {
      const plan = planRosterMcpActivation(id, { cwd: process.cwd() });
      const payload = {
        schemaVersion: 1,
        command: "roster.activate",
        kind: "builtin_mcp",
        id,
        dryRun,
        plan,
        mutation: {
          configPath: configPath(process.cwd()),
          wouldWriteConfig: plan.status === "ready" && !dryRun,
          didWriteConfig: false,
          boundary: plan.mutationBoundary,
        },
      };
      if (jsonOutput) {
        if (plan.status === "ready" && !dryRun) {
          await ensureDefaultConfig(process.cwd());
          const config = await loadConfig(process.cwd());
          const next = { ...config, tools: applyRosterMcpActivationPlan(config.tools, plan) };
          await saveConfig(next, process.cwd());
          await printRosterJsonOrReport(args, {
            ...payload,
            mutation: { ...payload.mutation, didWriteConfig: true },
            result: { enabled: plan.id, configPath: configPath(process.cwd()), postInstallCommands: plan.postInstallCommands },
          }, { jsonOutput });
          return;
        }
        await printRosterJsonOrReport(args, payload, { jsonOutput });
        if (plan.status === "blocked") process.exitCode = 1;
        return;
      }
      const willApplyMcp = plan.status === "ready" && !dryRun;
      if (!willApplyMcp) await printRosterJsonOrReport(args, payload, { jsonOutput });
      console.log(`activation=${id} kind=builtin_mcp status=${plan.status}`);
      for (const blocker of plan.blockers) console.log(`blocker=${blocker}`);
      for (const [serverId, server] of Object.entries(plan.mcpPolicy.servers)) {
        const transport = server.transport.kind === "stdio"
          ? `stdio ${server.transport.command} ${(server.transport.args ?? []).join(" ")}`.trim()
          : `http ${server.transport.url}`;
        console.log(`mcp_server=${serverId} transport=${transport} auth=${server.auth ?? "none"}`);
      }
      for (const command of plan.postInstallCommands) console.log(`next=${command}`);
      if (plan.status === "blocked") {
        process.exitCode = 1;
        return;
      }
      if (dryRun) {
        console.log("config=unchanged dry_run=true");
        return;
      }
      await ensureDefaultConfig(process.cwd());
      const config = await loadConfig(process.cwd());
      const next = { ...config, tools: applyRosterMcpActivationPlan(config.tools, plan) };
      await saveConfig(next, process.cwd());
      console.log(`config=${configPath(process.cwd())}`);
      console.log(`enabled=${plan.id}`);
      await printRosterJsonOrReport(args, {
        ...payload,
        mutation: { ...payload.mutation, didWriteConfig: true },
        result: { enabled: plan.id, configPath: configPath(process.cwd()), postInstallCommands: plan.postInstallCommands },
      }, { jsonOutput });
      return;
    }
    const lockPath = resolveWorkspacePath(readFlag(args, "--lock") ?? join(".muster", "roster.lock.json"));
    const musterVersion = readFlag(args, "--muster-version") ?? CLI_MUSTER_VERSION;
    const lock = await readRosterLock(lockPath);
    const plan = planRosterActivation(lock, id, { cwd: process.cwd() });
    const activationVerification = plan.status === "ready"
      ? await verifyRosterLockedCapability(lock, id, { musterVersion, cwd: process.cwd() })
      : undefined;
    const payload = {
      schemaVersion: 1,
      command: "roster.activate",
      id,
      lockPath,
      musterVersion,
      dryRun: args.includes("--dry-run"),
      plan,
      verification: activationVerification,
      mutation: {
        configPath: configPath(process.cwd()),
        wouldWriteConfig: plan.status === "ready" && activationVerification?.status === "ready" && !dryRun,
        didWriteConfig: false,
        boundary: "plugins.allow/load/entries only",
      },
    };
    if (jsonOutput) {
      if (plan.status === "ready" && activationVerification?.status === "ready" && !dryRun) {
        await ensureDefaultConfig(process.cwd());
        const config = await loadConfig(process.cwd());
        const next = { ...config, plugins: applyRosterActivationPlan(config.plugins, plan) };
        await saveConfig(next, process.cwd());
        await printRosterJsonOrReport(args, {
          ...payload,
          dryRun,
          mutation: { ...payload.mutation, didWriteConfig: true },
          result: { enabled: id, configPath: configPath(process.cwd()) },
        }, { jsonOutput });
        return;
      }
      await printRosterJsonOrReport(args, payload, { jsonOutput });
      if (plan.status === "blocked" || activationVerification?.status === "blocked") process.exitCode = 1;
      return;
    }
    const willApplyLockedCapability = plan.status === "ready" && activationVerification?.status === "ready" && !dryRun;
    if (!willApplyLockedCapability) await printRosterJsonOrReport(args, payload, { jsonOutput });
    console.log(`activation=${id} status=${plan.status} lock=${lockPath}`);
    if (plan.entry) {
      console.log(`locked_version=${plan.entry.version} digest=${plan.entry.digest} actionability=${plan.entry.actionability} risk=${plan.entry.risk}`);
    }
    for (const blocker of plan.blockers) console.log(`blocker=${blocker}`);
    for (const allowed of plan.pluginPolicy.allow ?? []) console.log(`allow=${allowed}`);
    for (const loadPath of plan.pluginPolicy.load?.paths ?? []) console.log(`load_path=${loadPath}`);
    for (const [entryId, entryPolicy] of Object.entries(plan.pluginPolicy.entries ?? {})) {
      console.log(`plugin_entry=${entryId} enabled=${entryPolicy.enabled === true}`);
    }
    if (plan.status === "blocked") {
      process.exitCode = 1;
      return;
    }
    if (!activationVerification) throw new Error(`Activation verification did not run for ${id}.`);
    console.log(`activation_verify=${activationVerification.status} muster=${musterVersion}`);
    for (const gate of activationVerification.gates.filter((gate) => gate.status === "blocked")) {
      console.log(`verify_gate=${gate.id} status=${gate.status} summary=${gate.summary}`);
    }
    if (activationVerification.status === "blocked") {
      process.exitCode = 1;
      return;
    }
    if (args.includes("--dry-run")) {
      console.log("config=unchanged dry_run=true");
      return;
    }
    await ensureDefaultConfig(process.cwd());
    const config = await loadConfig(process.cwd());
    const next = { ...config, plugins: applyRosterActivationPlan(config.plugins, plan) };
    await saveConfig(next, process.cwd());
    console.log(`config=${configPath(process.cwd())}`);
    console.log(`enabled=${id}`);
    await printRosterJsonOrReport(args, {
      ...payload,
      dryRun,
      mutation: { ...payload.mutation, didWriteConfig: true },
      result: { enabled: id, configPath: configPath(process.cwd()) },
    }, { jsonOutput });
    return;
  }

  if (subcommand === "materialize") {
    if (!id) throw new Error("Usage: muster roster materialize <id> [--index roster.index.json] [--lock .muster/roster.lock.json] [--cache .muster/roster-cache] [--version x.y.z] [--muster-version x.y.z] [--registry-profile verified|release] [--require-metadata] [--min-readiness level] [--json] [--report path]");
    const indexPath = resolveWorkspacePath(readFlag(args, "--index") ?? "roster.index.json");
    const lockPath = resolveWorkspacePath(readFlag(args, "--lock") ?? join(".muster", "roster.lock.json"));
    const cacheDir = resolveWorkspacePath(readFlag(args, "--cache") ?? join(".muster", "roster-cache"));
    const musterVersion = readFlag(args, "--muster-version") ?? CLI_MUSTER_VERSION;
    const version = readFlag(args, "--version");
    const verificationProfile = readRosterVerificationProfile(args);
    const index = await loadRosterIndex(indexPath);
    const result = await materializeRosterCapability(index, id, { cacheDir, lockPath, musterVersion, version, cwd: process.cwd(), requireMetadata: verificationProfile.requireMetadata, minReadinessLevel: verificationProfile.minReadinessLevel });
    const payload = {
      schemaVersion: 1,
      command: "roster.materialize",
      indexPath,
      lockPath,
      cacheDir,
      musterVersion,
      registryProfile: verificationProfile.registryProfile,
      requireMetadata: verificationProfile.requireMetadata,
      minReadinessLevel: verificationProfile.minReadinessLevel,
      result,
    };
    if (jsonOutput) {
      await printRosterJsonOrReport(args, payload, { jsonOutput });
      return;
    }
    await printRosterJsonOrReport(args, payload, { jsonOutput });
    console.log(`materialized=${result.lockEntry.id} version=${result.lockEntry.version} source=${result.lockEntry.source.type} status=${result.verification.status}`);
    console.log(`path=${result.materializedPath}`);
    console.log(`digest=${result.lockEntry.digest}`);
    console.log(`lock=${lockPath} entries=${Object.keys(result.lock.entries).length}`);
    return;
  }

  if ((subcommand !== "inspect" && subcommand !== "install" && subcommand !== "lock") || (subcommand !== "lock" && !id)) {
    throw new Error("Usage: muster roster inspect|install <id> [--index roster.index.json] [--lock .muster/roster.lock.json] [--version x.y.z] [--muster-version x.y.z] [--registry-profile verified|release] [--require-metadata] [--min-readiness level]");
  }

  const indexPath = resolveWorkspacePath(readFlag(args, "--index") ?? "roster.index.json");
  const lockPath = resolveWorkspacePath(readFlag(args, "--lock") ?? join(".muster", "roster.lock.json"));
  const musterVersion = readFlag(args, "--muster-version") ?? CLI_MUSTER_VERSION;
  const version = readFlag(args, "--version");
  const verificationProfile = readRosterVerificationProfile(args);

  if (subcommand === "lock") {
    const lock = await readRosterLock(lockPath);
    if (args.includes("--verify")) {
      const report = await verifyRosterLock(lock, { musterVersion, cwd: process.cwd() });
      const summary = summarizeRosterVerification(report);
      const payload = {
        schemaVersion: 1,
        command: "roster.lock.verify",
        lockPath,
        musterVersion,
        summary,
        report,
      };
      if (jsonOutput) {
        await printRosterJsonOrReport(args, payload, { jsonOutput });
        if (report.status === "blocked") process.exitCode = 1;
        return;
      }
      await printRosterJsonOrReport(args, payload, { jsonOutput });
      console.log(`roster_lock_verify status=${report.status} ready=${report.readyCount} blocked=${report.blockedCount} total=${report.results.length} lock=${lockPath}`);
      console.log(`verify_summary total=${summary.total} ready=${summary.ready} blocked=${summary.blocked} blocked_entries=${summary.blockedEntries.length}`);
      for (const [gateId, totals] of Object.entries(summary.gateTotals)) {
        console.log(`gate_summary=${gateId} passed=${totals.passed} blocked=${totals.blocked}`);
      }
      for (const repair of summary.repairs) {
        console.log(`repair=${repair.entry} gate=${repair.gate} command="${repair.command}"`);
      }
      for (const result of report.results) {
        console.log(`entry=${result.entry.id} version=${result.entry.version} status=${result.status}`);
        for (const gate of result.gates.filter((gate) => gate.status === "blocked")) {
          console.log(`  gate=${gate.id} status=${gate.status} summary=${gate.summary}`);
        }
      }
      if (report.status === "blocked") process.exitCode = 1;
      return;
    }
    const payload = {
      schemaVersion: 1,
      command: "roster.lock",
      lockPath,
      lock,
    };
    if (jsonOutput) {
      await printRosterJsonOrReport(args, payload, { jsonOutput });
      return;
    }
    await printRosterJsonOrReport(args, payload, { jsonOutput });
    console.log(`lock=${lockPath} entries=${Object.keys(lock.entries).length}`);
    for (const entry of Object.values(lock.entries)) {
      console.log(`entry=${entry.id} version=${entry.version} kind=${entry.kind} actionability=${entry.actionability} risk=${entry.risk} digest=${entry.digest}`);
    }
    return;
  }

  const index = await loadRosterIndex(indexPath);
  const candidates = index.entries.filter((entry) => entry.id === id && (!version || entry.version === version));
  if (!candidates.length) throw new Error(`Roster capability ${id}${version ? `@${version}` : ""} was not found in ${indexPath}.`);
  const entry = [...candidates].sort((a, b) => b.version.localeCompare(a.version))[0]!;
  const verification = await verifyRosterCapability(entry, { musterVersion, cwd: process.cwd(), requireMetadata: verificationProfile.requireMetadata, minReadinessLevel: verificationProfile.minReadinessLevel });
  if (jsonOutput && subcommand === "inspect") {
    await printRosterJsonOrReport(args, {
      schemaVersion: 1,
      command: "roster.inspect",
      indexPath,
      musterVersion,
      registryProfile: verificationProfile.registryProfile,
      requireMetadata: verificationProfile.requireMetadata,
      minReadinessLevel: verificationProfile.minReadinessLevel,
      verification,
    }, { jsonOutput });
    if (verification.status === "blocked") process.exitCode = 1;
    return;
  }
  if (jsonOutput && subcommand === "install") {
    const result = await installRosterCapability(index, entry.id, { lockPath, musterVersion, version: entry.version, requireMetadata: verificationProfile.requireMetadata, minReadinessLevel: verificationProfile.minReadinessLevel });
    await printRosterJsonOrReport(args, {
      schemaVersion: 1,
      command: "roster.install",
      indexPath,
      lockPath,
      musterVersion,
      registryProfile: verificationProfile.registryProfile,
      requireMetadata: verificationProfile.requireMetadata,
      minReadinessLevel: verificationProfile.minReadinessLevel,
      result,
    }, { jsonOutput });
    return;
  }
  if (subcommand === "inspect") {
    await printRosterJsonOrReport(args, {
      schemaVersion: 1,
      command: "roster.inspect",
      indexPath,
      musterVersion,
      registryProfile: verificationProfile.registryProfile,
      requireMetadata: verificationProfile.requireMetadata,
      minReadinessLevel: verificationProfile.minReadinessLevel,
      verification,
    }, { jsonOutput });
  }
  console.log(`capability=${entry.id} version=${entry.version} status=${verification.status} index=${indexPath}`);
  console.log(`source=${entry.source.type}${entry.source.type === "local" ? ` path=${entry.source.path}` : ""}`);
  console.log(`actionability=${entry.actionability} risk=${entry.risk} compatibility=${entry.compatibility.muster}`);
  if (entry.metadata) printRosterEntryMetadata(entry.metadata);
  for (const gate of verification.gates) console.log(`gate=${gate.id} status=${gate.status} summary=${gate.summary}`);
  if (subcommand === "inspect") {
    if (verification.status === "blocked") process.exitCode = 1;
    return;
  }

  const result = await installRosterCapability(index, entry.id, { lockPath, musterVersion, version: entry.version, requireMetadata: verificationProfile.requireMetadata, minReadinessLevel: verificationProfile.minReadinessLevel });
  await printRosterJsonOrReport(args, {
    schemaVersion: 1,
    command: "roster.install",
    indexPath,
    lockPath,
    musterVersion,
    registryProfile: verificationProfile.registryProfile,
    requireMetadata: verificationProfile.requireMetadata,
    minReadinessLevel: verificationProfile.minReadinessLevel,
    result,
  }, { jsonOutput });
  console.log(`locked=${result.lockEntry.id} version=${result.lockEntry.version} digest=${result.lockEntry.digest}`);
  console.log(`lock=${lockPath} entries=${Object.keys(result.lock.entries).length}`);
}

async function printRosterJsonOrReport(args: readonly string[], payload: unknown, options: { readonly jsonOutput: boolean }): Promise<void> {
  const reportPath = readFlag([...args], "--report");
  if (reportPath) {
    const resolvedReportPath = resolveWorkspacePath(reportPath);
    await mkdir(dirname(resolvedReportPath), { recursive: true });
    await writeFile(resolvedReportPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    if (!options.jsonOutput) console.log(`report=${resolvedReportPath}`);
  }
  if (options.jsonOutput) console.log(JSON.stringify(payload, null, 2));
}

async function buildRosterIndexSkippingBlocked(
  packPaths: readonly string[],
  options: { readonly musterCompatibility: string; readonly musterVersion: string; readonly generatedAt?: string },
  skipped: RosterSkippedPack[],
): Promise<Awaited<ReturnType<typeof buildRosterIndexFromPacks>>> {
  const entries: Awaited<ReturnType<typeof buildRosterEntryFromPack>>["entry"][] = [];
  const seen = new Set<string>();
  for (const packPath of packPaths) {
    try {
      const inspectionPath = resolve(process.cwd(), packPath);
      const draft = await buildRosterEntryFromPack(inspectionPath, {
        source: { type: "local", path: packPath },
        musterCompatibility: options.musterCompatibility,
        musterVersion: options.musterVersion,
        cwd: process.cwd(),
      });
      const key = `${draft.entry.id}@${draft.entry.version}`;
      if (seen.has(key)) throw new Error(`Duplicate roster index entry ${key}.`);
      seen.add(key);
      entries.push(draft.entry);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      skipped.push({
        path: packPath,
        reason,
        repair: rosterSkippedPackRepair(packPath, reason),
      });
    }
  }
  if (!entries.length) {
    throw new Error(`No verified capability packs could be indexed.${skipped.length ? ` Skipped ${skipped.length} blocked pack(s).` : ""}`);
  }
  return {
    schemaVersion: 1,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    entries: entries.sort((left, right) => left.id.localeCompare(right.id) || left.version.localeCompare(right.version)),
  };
}

interface RosterSkippedPack {
  readonly path: string;
  readonly reason: string;
  readonly repair: readonly string[];
}

type RosterRegistryProfile = "verified" | "release";

interface RosterVerificationCliProfile {
  readonly registryProfile?: RosterRegistryProfile;
  readonly requireMetadata: boolean;
  readonly minReadinessLevel?: CapabilityReadinessLevel;
}

function readRosterVerificationProfile(args: readonly string[]): RosterVerificationCliProfile {
  const registryProfile = readRosterRegistryProfileFlag(args);
  const explicitMinReadiness = readRosterMinReadinessFlag(args);
  const profileMinReadiness: CapabilityReadinessLevel | undefined = registryProfile === "release"
    ? "release_ready"
    : registryProfile === "verified"
      ? "verified"
      : undefined;
  return {
    registryProfile,
    requireMetadata: args.includes("--require-metadata") || registryProfile !== undefined,
    minReadinessLevel: explicitMinReadiness ?? profileMinReadiness,
  };
}

function readRosterRegistryProfileFlag(args: readonly string[]): RosterRegistryProfile | undefined {
  const value = readFlag([...args], "--registry-profile");
  if (!value) return undefined;
  if (value === "verified" || value === "release") return value;
  throw new Error("--registry-profile must be verified or release.");
}

function readRosterMinReadinessFlag(args: readonly string[]): CapabilityReadinessLevel | undefined {
  const value = readFlag([...args], "--min-readiness");
  if (!value) return undefined;
  if (
    value === "listed" ||
    value === "setup_plan" ||
    value === "installable" ||
    value === "executable" ||
    value === "verified" ||
    value === "release_ready"
  ) return value;
  throw new Error("--min-readiness must be one of listed, setup_plan, installable, executable, verified, release_ready.");
}

function rosterSkippedPackRepair(packPath: string, reason: string): readonly string[] {
  const steps: string[] = [];
  if (/without a verified digest|digest must be sha256|digest mismatch|digest could not read/i.test(reason)) {
    steps.push(`muster capability digest ${packPath} --write`);
    steps.push(`muster capability inspect ${packPath}`);
  }
  if (/without readiness metadata|readiness metadata is required|readiness diagnostics require/i.test(reason)) {
    steps.push(`add readiness metadata with doctorCommand and smokeCommand in ${packPath}/manifest.json`);
    steps.push(`muster capability inspect ${packPath}`);
  }
  if (/at least one eval fixture|required|missing eval fixture/i.test(reason)) {
    steps.push(`add or fix eval fixture paths declared in ${packPath}/manifest.json`);
    steps.push(`muster capability inspect ${packPath}`);
  }
  if (!steps.length) steps.push(`muster capability inspect ${packPath}`);
  return [...new Set(steps)];
}

function printSkippedRosterPack(item: RosterSkippedPack, stream: "stdout" | "stderr"): void {
  const line = `skipped=${item.path} reason=${item.reason}`;
  if (stream === "stderr") console.error(line);
  else console.log(line);
  for (const repair of item.repair) {
    const repairLine = `repair=${item.path} command="${repair}"`;
    if (stream === "stderr") console.error(repairLine);
    else console.log(repairLine);
  }
}

function printRosterEntryMetadata(metadata: RosterCapabilityMetadata): void {
  console.log([
    `readiness=${metadata.readiness.level}/${metadata.readiness.status}`,
    `surfaces=${metadata.readiness.surfaces.length ? metadata.readiness.surfaces.join(",") : "-"}`,
    `credentials=${metadata.setup.credentialStorage}`,
    `live_credentials=${metadata.diagnostics.requiresLiveCredentials}`,
    `latency_budget_ms=${metadata.diagnostics.latencyBudgetMs ?? "-"}`,
    `evals=${metadata.evals.length}`,
    `tools=${metadata.implementedTools.length ? metadata.implementedTools.join(",") : "-"}`,
  ].join(" "));
}

type CliArtifactResult = {
  filename: string;
  mimeType: string;
  format: "docx" | "xlsx" | "pptx" | "pdf";
  bytes: number;
  base64: string;
};

function artifactFormats(): string {
  return "docx|xlsx|pptx|pdf";
}

function artifactFormatFromPath(path: string): CliArtifactResult["format"] | undefined {
  const lower = path.toLowerCase();
  if (lower.endsWith(".docx")) return "docx";
  if (lower.endsWith(".xlsx")) return "xlsx";
  if (lower.endsWith(".pptx")) return "pptx";
  if (lower.endsWith(".pdf")) return "pdf";
  return undefined;
}

function artifactOutputPath(args: string[], artifact: CliArtifactResult): string {
  const requested = readFlag(args, "--out");
  if (requested) {
    const target = resolve(process.cwd(), requested);
    if (requested.endsWith("/") || requested.endsWith("\\")) return join(target, artifact.filename);
    return target;
  }
  return resolve(process.cwd(), artifact.filename);
}

async function artifactArgs(args: string[]): Promise<Record<string, unknown>> {
  const specPath = readFlag(args, "--spec");
  const spec = specPath ? await readArtifactSpec(specPath) : {};
  const title = readFlag(args, "--title") ?? (typeof spec.title === "string" ? spec.title : "Muster Artifact");
  const summary = readFlag(args, "--summary") ?? (typeof spec.summary === "string" ? spec.summary : "Generated by Muster Artifact Studio.");
  const filename = readFlag(args, "--filename");
  return {
    ...spec,
    title,
    summary,
    filename: filename ?? spec.filename,
    sections: spec.sections ?? [{ heading: "Summary", content: summary }],
    slides: spec.slides ?? [{ title, bullets: summary.split(/\n+/).filter(Boolean) }],
    rows: spec.rows ?? [{ title, summary }],
    sheetName: readFlag(args, "--sheet") ?? spec.sheetName ?? "Artifact",
  };
}

async function readArtifactSpec(specPath: string): Promise<Record<string, unknown>> {
  const resolved = resolve(process.cwd(), specPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(resolved, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read artifact spec ${specPath}: ${detail}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Artifact spec must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

async function printArtifactVerification(format: CliArtifactResult["format"], bytes: Buffer | Uint8Array, requiredText: readonly string[] = []): Promise<"passed" | "failed"> {
  const report = await artifact_structural_verify({
    format,
    base64: Buffer.from(bytes).toString("base64"),
    requiredText,
  }) as { status?: string; checks?: Array<{ id: string; status: string; summary: string }>; failureBehavior?: string };
  const status = report.status === "passed" ? "passed" : "failed";
  console.log(`verification=${status}`);
  for (const check of report.checks ?? []) console.log(`verify_check=${check.id} status=${check.status} summary=${JSON.stringify(check.summary)}`);
  if (report.failureBehavior) console.log(`failure_behavior=${JSON.stringify(report.failureBehavior)}`);
  return status;
}

async function artifactsCommand(args: string[]): Promise<void> {
  const action = args[0];
  if (action === "contract") {
    const formats = readCsvFlag(args, "--formats") ?? ["docx", "xlsx", "pptx", "pdf"];
    const contract = await office_artifact_contract({ formats });
    console.log(`pillar=${(contract as Record<string, unknown>).pillar}`);
    console.log(`promise=${JSON.stringify((contract as Record<string, unknown>).promise)}`);
    for (const item of (contract as { formats: Array<Record<string, unknown>> }).formats) {
      console.log(`format=${item.format} builder=${item.localBuilder} verifier=${item.verifier} app_skill=${item.appServerSkill}`);
      console.log(`quality_gate=${JSON.stringify(item.qualityGate)}`);
    }
    console.log(`workflow=${((contract as { workflow: string[] }).workflow).join(" -> ")}`);
    for (const claim of (contract as { noFalseClaims: string[] }).noFalseClaims) console.log(`no_false_claim=${JSON.stringify(claim)}`);
    return;
  }
  if (action === "plan") {
    const format = readFlag(args, "--format") ?? "docx";
    const destination = readFlag(args, "--destination") ?? "local";
    if (!artifactFormats().split("|").includes(format)) throw new Error(`--format must be one of ${artifactFormats()}.`);
    const hostSkills = readCsvFlag(args, "--host-skills") ?? [];
    const mcpServers = readCsvFlag(args, "--mcp") ?? [];
    const integrations = await office_tool_integrations({ hostCapabilities: { skills: hostSkills, mcpServers } });
    const workflow = await office_artifact_workflow({ format, destination, polished: args.includes("--polished") });
    const passes = await artifact_goal_passes({ goal: `create ${format} artifact`, strictness: "release" });
    console.log(`format=${format}`);
    console.log(`destination=${destination}`);
    console.log(`mode=${workflow.mode}`);
    console.log("local_builders:");
    for (const item of integrations.local as Array<{ id: string; formats: string[]; available: boolean }>) {
      console.log(`- ${item.id} formats=${item.formats.join(",")} available=${item.available}`);
    }
    console.log("app_server_skills:");
    for (const item of integrations.appServerSkills as Array<{ id: string; formats: string[]; available: boolean }>) {
      console.log(`- ${item.id} formats=${item.formats.join(",")} available=${item.available}`);
    }
    console.log("workflow_steps:");
    for (const step of workflow.steps as Array<{ id: string; tool?: string; risk: string; gate?: string }>) {
      console.log(`- ${step.id} tool=${step.tool ?? "-"} risk=${step.risk}${step.gate ? ` gate=${step.gate}` : ""}`);
    }
    console.log("goal_passes:");
    for (const pass of passes.passes as Array<{ id: string; owner: string }>) console.log(`- ${pass.id} owner=${pass.owner}`);
    return;
  }
  if (action === "verify") {
    const target = args[1] ?? readFlag(args, "--file");
    if (!target) throw new Error(`Usage: muster artifacts verify <file> [--format ${artifactFormats()}] [--require text]`);
    const format = (readFlag(args, "--format") as CliArtifactResult["format"] | undefined) ?? artifactFormatFromPath(target);
    if (!format || !artifactFormats().split("|").includes(format)) throw new Error(`Unable to infer format. Pass --format ${artifactFormats()}.`);
    const bytes = await readFile(resolve(process.cwd(), target));
    const required = readFlags(args, "--require");
    console.log(`artifact=${resolve(process.cwd(), target)}`);
    console.log(`format=${format}`);
    const status = await printArtifactVerification(format, bytes, required);
    if (status !== "passed") process.exitCode = 1;
    return;
  }
  if (action === "create") {
    const format = readFlag(args, "--format");
    if (!format || !artifactFormats().split("|").includes(format)) throw new Error(`Usage: muster artifacts create --format ${artifactFormats()} --title "..." [--summary "..."] [--spec spec.json] [--out path]`);
    const input = await artifactArgs(args);
    const artifact = format === "docx"
      ? await docx_document(input)
      : format === "xlsx"
        ? await xlsx_workbook(input)
        : format === "pptx"
          ? await pptx_presentation(input)
          : await pdf_document(input);
    const outPath = artifactOutputPath(args, artifact);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, Buffer.from(artifact.base64, "base64"));
    console.log(`artifact=${outPath}`);
    console.log(`format=${artifact.format}`);
    console.log(`mime=${artifact.mimeType}`);
    console.log(`bytes=${artifact.bytes}`);
    const requiredText = artifact.format === "xlsx"
      ? [String(input.sheetName ?? "")].filter(Boolean)
      : [String(input.title ?? "")].filter(Boolean);
    await printArtifactVerification(artifact.format, Buffer.from(artifact.base64, "base64"), requiredText);
    console.log("visual_qa=use app-server document/spreadsheet/presentation/PDF skills or local renderers for polished layout verification.");
    return;
  }
  throw new Error(`Usage: muster artifacts contract [--formats docx,xlsx,pptx,pdf] | plan --format ${artifactFormats()} [--destination local|google-drive|microsoft-365] [--polished] | create --format ${artifactFormats()} --title "..." [--summary "..."] [--spec spec.json] [--out path] | verify <file> [--format ${artifactFormats()}] [--require text]`);
}

async function pluginsCommand(args: string[]): Promise<void> {
  const [action, path] = args;
  if (action === "catalog") {
    for (const plugin of listBuiltinPlugins()) {
      const aliases = plugin.aliases?.length ? ` aliases=${plugin.aliases.join(",")}` : "";
      const pack = plugin.packPath ? " pack=yes" : " pack=no";
      const mcps = plugin.setup?.mcpServers?.length ? ` mcps=${plugin.setup.mcpServers.join(",")}` : "";
      const channels = plugin.setup?.channels?.length ? ` channels=${plugin.setup.channels.join(",")}` : "";
      console.log(`${plugin.id.padEnd(24)} ${plugin.source.padEnd(9)} ${plugin.category.padEnd(18)} risk=${plugin.risk.padEnd(6)} action=${plugin.actionability.padEnd(17)}${pack}${mcps}${channels} ${plugin.description}${aliases}`);
    }
    return;
  }
  if (action === "setup" && path) {
    const plugin = listBuiltinPlugins().find((entry) => entry.id === path || entry.aliases?.includes(path));
    if (!plugin) throw new Error(`Unknown built-in plugin "${path}". Run muster plugins catalog.`);
    console.log(`plugin=${plugin.id} source=${plugin.source} risk=${plugin.risk} action=${plugin.actionability}`);
    if (plugin.risk === "high") console.log("risk_note=High-risk integrations can send/read external messages or data; enabling requires --allow-high-risk.");
    await printPluginPackStatus(plugin);
    await printPluginSetupStatus(plugin);
    if (!plugin.setup) console.log("setup=none");
    return;
  }
  if ((action === "check" || action === "doctor") && path) {
    const plugin = listBuiltinPlugins().find((entry) => entry.id === path || entry.aliases?.includes(path));
    if (!plugin) throw new Error(`Unknown built-in plugin "${path}". Run muster plugins catalog.`);
    await printPluginCheck(plugin);
    return;
  }
  if (action === "context" && path) {
    await pluginContextCommand(path, args.slice(2));
    return;
  }
  if (action === "reuse" || action === "discover") {
    const providerArg = pluginReuseProviderArg(args.slice(1));
    const rest = args.slice(1).filter((_, index) => index !== providerArg.index);
    await pluginReuseCommand(providerArg.provider, rest);
    return;
  }
  if (action === "enable" && path) {
    const plugin = await enableBuiltinPlugin(path, process.cwd(), { allowHighRisk: args.includes("--allow-high-risk") });
    console.log(`enabled plugin=${plugin.id} source=${plugin.source} risk=${plugin.risk} action=${plugin.actionability}`);
    if (!plugin.packPath) console.log("note=policy enabled; executable loading still requires a local capability pack.");
    await printPluginSetupStatus(plugin, { configureDefaults: true, enabled: true });
    return;
  }
  if (action === "disable" && path) {
    const plugin = await disableBuiltinPlugin(path);
    console.log(`disabled plugin=${plugin.id}`);
    return;
  }
  if (action === "inspect" && path) {
    await capability(["inspect", path]);
    return;
  }
  if (action === "load" && path) {
    await capability(["load", path, ...args.slice(2)]);
    return;
  }
  const config = await loadConfig();
  const policy = config.plugins;
  if (action === "policy") {
    console.log(JSON.stringify(policy ?? {}, null, 2));
    return;
  }
  if (action === "list" || action === undefined) {
    if (!policy) {
      const catalog = listBuiltinPlugins();
      const installable = catalog.filter((plugin) => plugin.packPath || plugin.setup).length;
      const highRisk = catalog.filter((plugin) => plugin.risk === "high").length;
      console.log("No plugins enabled for this profile yet.");
      console.log(`catalog=${catalog.length} setup_or_pack=${installable} high_risk=${highRisk}`);
      console.log("next=muster plugins catalog");
      console.log("setup=muster plugins setup <id>");
      console.log("enable=muster plugins enable <id> [--allow-high-risk]");
      return;
    }
    console.log(`allow=${policy.allow?.join(",") || "-"}`);
    console.log(`deny=${policy.deny?.join(",") || "-"}`);
    console.log(`load_paths=${policy.load?.paths?.join(",") || "-"}`);
    const entries = Object.entries(policy.entries ?? {});
    if (!entries.length) console.log("entries=none");
    for (const [id, entry] of entries) console.log(`entry=${id} enabled=${entry.enabled !== false} config_keys=${Object.keys(entry.config ?? {}).join(",") || "-"}`);
    const slots = Object.entries(policy.slots ?? {});
    if (!slots.length) console.log("slots=none");
    for (const [slot, owner] of slots) console.log(`slot=${slot} owner=${owner}`);
    return;
  }
  throw new Error("Usage: muster plugins list|catalog|setup <id>|reuse <provider>|context frappe <setup|docs|module|build>|check <id>|enable <id>|disable <id>|policy|inspect <path>|load <path> [--allow-high-risk]");
}

interface ProviderReuseSource {
  readonly provider: string;
  readonly root: string;
  readonly layout: "codex-cache" | "provider-cache";
}

interface ProviderReusePlugin {
  readonly id: string;
  readonly provider: string;
  readonly sourceRoot: string;
  readonly version: string;
  readonly apps: readonly ProviderReuseApp[];
  readonly mcps: readonly ProviderReuseMcp[];
}

interface ProviderReuseApp {
  readonly id: string;
  readonly required: boolean;
  readonly optional: boolean;
}

interface ProviderReuseMcp {
  readonly id: string;
  readonly transport: "http" | "stdio";
  readonly auth: "oauth" | "api_key" | "local";
  readonly url?: string;
  readonly command?: string;
  readonly args?: readonly string[];
}

interface ProviderReuseAdoptionResult {
  readonly id: string;
  readonly provider: string;
  readonly status: "configured" | "skipped" | "not_found";
  readonly transport?: string;
  readonly auth?: string;
  readonly next?: string;
}

type RosterHostConnector = { provider: string; kind: "app" | "mcp"; id: string; auth: string; transport?: string; source?: string };
type RosterHostCacheStatus = "skipped" | "disabled" | "hit" | "miss" | "refresh";

interface RosterHostDetection {
  readonly connectors: readonly RosterHostConnector[];
  readonly cacheStatus: RosterHostCacheStatus;
  readonly evidence: readonly RosterHostEvidence[];
}

interface RosterHostEvidence {
  readonly provider: string;
  readonly root: string;
  readonly layout: ProviderReuseSource["layout"];
  readonly cacheStatus: Exclude<RosterHostCacheStatus, "skipped" | "disabled"> | "disabled";
  readonly fingerprint: string;
  readonly scannedAt: string;
  readonly connectorCount: number;
  readonly appCount: number;
  readonly mcpCount: number;
  readonly sourceCount: number;
}

interface RosterHostDetectionOptions {
  readonly cachePath: string;
  readonly useCache: boolean;
  readonly refreshCache: boolean;
  readonly ttlMs: number;
}

async function rosterHostDetectionFromArgs(args: string[]): Promise<{ readonly shouldScanHosts: boolean; readonly detection: RosterHostDetection }> {
  const requestedHosts = readFlags(args, "--host");
  const shouldScanHosts = requestedHosts.length > 0 || args.includes("--scan-hosts");
  const detection = shouldScanHosts
    ? await detectRosterHostConnectors(requestedHosts, {
      cachePath: resolveWorkspacePath(readFlag(args, "--host-cache") ?? join(".muster", "roster", "host-scan-cache.json")),
      refreshCache: args.includes("--refresh-host-cache"),
      useCache: !args.includes("--no-host-cache"),
      ttlMs: rosterHostScanCacheTtlMs(args),
    })
    : emptyRosterHostDetection("skipped");
  return { shouldScanHosts, detection };
}

interface RosterHostScanCacheFile {
  readonly schemaVersion: 1;
  readonly generatedBy: "muster-roster";
  readonly entries: Record<string, RosterHostScanCacheEntry>;
}

interface RosterHostScanCacheEntry {
  readonly schemaVersion: 1;
  readonly cliVersion: string;
  readonly provider: string;
  readonly root: string;
  readonly layout: ProviderReuseSource["layout"];
  readonly fingerprint: string;
  readonly scannedAt: string;
  readonly sourceCount?: number;
  readonly connectors: readonly RosterHostConnector[];
}

function emptyRosterHostDetection(cacheStatus: RosterHostCacheStatus): RosterHostDetection {
  return { connectors: [], cacheStatus, evidence: [] };
}

async function detectRosterHostConnectors(hosts: readonly string[] = [], options?: RosterHostDetectionOptions): Promise<RosterHostDetection> {
  const detectionOptions = options ?? {
    cachePath: join(process.cwd(), ".muster", "roster", "host-scan-cache.json"),
    useCache: false,
    refreshCache: false,
    ttlMs: 0,
  };
  const targets = hosts.length ? hosts : ["codex", "claude", "openclaw", "hermes"];
  const connectors: RosterHostConnector[] = [];
  const evidence: RosterHostEvidence[] = [];
  let cacheStatus: RosterHostCacheStatus = detectionOptions.useCache === false ? "disabled" : detectionOptions.refreshCache ? "refresh" : "miss";
  let cache = detectionOptions.useCache ? await readRosterHostScanCache(detectionOptions.cachePath) : emptyRosterHostScanCache();
  let cacheChanged = false;
  for (const host of targets) {
    const source = providerReuseSource(host);
    if (!source) continue;
    const fingerprint = await providerReuseSourceFingerprint(source);
    const cacheKey = rosterHostScanCacheKey(source);
    const cached = detectionOptions.useCache && !detectionOptions.refreshCache ? cache.entries[cacheKey] : undefined;
    if (cached && rosterHostScanCacheEntryFresh(cached, source, fingerprint, detectionOptions.ttlMs)) {
      connectors.push(...cached.connectors);
      evidence.push(rosterHostEvidenceFromConnectors(source, cached.connectors, {
        cacheStatus: "hit",
        fingerprint: cached.fingerprint,
        scannedAt: cached.scannedAt,
        sourceCount: cached.sourceCount,
      }));
      cacheStatus = cacheStatus === "miss" ? "hit" : cacheStatus;
      continue;
    }
    const scannedAt = new Date().toISOString();
    const scan = await scanRosterHostConnectorsFromSource(source);
    const scanned = scan.connectors;
    connectors.push(...scanned);
    evidence.push(rosterHostEvidenceFromConnectors(source, scanned, {
      cacheStatus: detectionOptions.useCache === false ? "disabled" : detectionOptions.refreshCache ? "refresh" : "miss",
      fingerprint,
      scannedAt,
      sourceCount: scan.sourceCount,
    }));
    if (detectionOptions.useCache) {
      cache = {
        schemaVersion: 1,
        generatedBy: "muster-roster",
        entries: {
          ...cache.entries,
          [cacheKey]: {
            schemaVersion: 1,
            cliVersion: CLI_MUSTER_VERSION,
            provider: source.provider,
            root: source.root,
            layout: source.layout,
            fingerprint,
            scannedAt,
            sourceCount: scan.sourceCount,
            connectors: scanned,
          },
        },
      };
      cacheChanged = true;
    }
  }
  if (detectionOptions.useCache && cacheChanged) await writeRosterHostScanCache(detectionOptions.cachePath, cache);
  return {
    connectors: sortRosterHostConnectors(connectors),
    cacheStatus,
    evidence: sortRosterHostEvidence(evidence),
  };
}

async function scanRosterHostConnectorsFromSource(source: ProviderReuseSource): Promise<{ readonly connectors: readonly RosterHostConnector[]; readonly sourceCount: number }> {
  const connectors: RosterHostConnector[] = [];
  const plugins = await scanProviderPluginReuseCandidates(source);
  for (const plugin of plugins) {
    for (const app of plugin.apps) {
      connectors.push({ provider: source.provider, kind: "app", id: app.id, auth: "host_oauth", transport: "app", source: plugin.sourceRoot });
    }
    for (const mcp of plugin.mcps) {
      connectors.push({ provider: source.provider, kind: "mcp", id: mcp.id, auth: mcp.auth, transport: mcp.transport, source: plugin.sourceRoot });
    }
  }
  return { connectors: sortRosterHostConnectors(connectors), sourceCount: plugins.length };
}

function sortRosterHostConnectors(connectors: readonly RosterHostConnector[]): readonly RosterHostConnector[] {
  return [...connectors].sort((left, right) =>
    left.provider.localeCompare(right.provider) ||
    left.kind.localeCompare(right.kind) ||
    left.id.localeCompare(right.id) ||
    (left.source ?? "").localeCompare(right.source ?? "")
  );
}

function rosterHostEvidenceFromConnectors(
  source: ProviderReuseSource,
  connectors: readonly RosterHostConnector[],
  detail: {
    readonly cacheStatus: RosterHostEvidence["cacheStatus"];
    readonly fingerprint: string;
    readonly scannedAt: string;
    readonly sourceCount?: number;
  },
): RosterHostEvidence {
  const sourceCount = detail.sourceCount ?? new Set(connectors.map((connector) => connector.source ?? "unknown")).size;
  return {
    provider: source.provider,
    root: source.root,
    layout: source.layout,
    cacheStatus: detail.cacheStatus,
    fingerprint: detail.fingerprint,
    scannedAt: detail.scannedAt,
    connectorCount: connectors.length,
    appCount: connectors.filter((connector) => connector.kind === "app").length,
    mcpCount: connectors.filter((connector) => connector.kind === "mcp").length,
    sourceCount,
  };
}

function sortRosterHostEvidence(evidence: readonly RosterHostEvidence[]): readonly RosterHostEvidence[] {
  return [...evidence].sort((left, right) =>
    left.provider.localeCompare(right.provider) ||
    left.root.localeCompare(right.root) ||
    left.layout.localeCompare(right.layout)
  );
}

function printRosterHostEvidence(evidence: RosterHostEvidence): void {
  console.log([
    `host_evidence=${evidence.provider}`,
    `cache=${evidence.cacheStatus}`,
    `layout=${evidence.layout}`,
    `connectors=${evidence.connectorCount}`,
    `apps=${evidence.appCount}`,
    `mcps=${evidence.mcpCount}`,
    `sources=${evidence.sourceCount}`,
    `fingerprint=${evidence.fingerprint.slice(0, 16)}`,
    `scanned_at=${evidence.scannedAt}`,
  ].join(" "));
}

function rosterHostScanCacheTtlMs(args: string[]): number {
  const raw = readFlag(args, "--host-cache-ttl-ms") ?? process.env.MUSTER_ROSTER_HOST_SCAN_CACHE_TTL_MS;
  if (!raw) return 5 * 60 * 1000;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 5 * 60 * 1000;
}

function rosterIndexPackArgs(args: readonly string[]): string[] {
  const valueFlags = new Set(["--out", "--muster-version", "--muster-compatibility", "--generated-at"]);
  const booleanFlags = new Set(["--builtin-packs", "--dry-run"]);
  const paths: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (valueFlags.has(arg)) {
      index += 1;
      continue;
    }
    if (booleanFlags.has(arg)) continue;
    if (arg.startsWith("--")) continue;
    paths.push(arg);
  }
  return paths;
}

function emptyRosterHostScanCache(): RosterHostScanCacheFile {
  return { schemaVersion: 1, generatedBy: "muster-roster", entries: {} };
}

async function readRosterHostScanCache(path: string): Promise<RosterHostScanCacheFile> {
  const raw = await readJsonObject(path);
  if (!raw || raw.schemaVersion !== 1 || raw.generatedBy !== "muster-roster" || !raw.entries || typeof raw.entries !== "object" || Array.isArray(raw.entries)) {
    return emptyRosterHostScanCache();
  }
  const entries: Record<string, RosterHostScanCacheEntry> = {};
  for (const [key, value] of Object.entries(raw.entries)) {
    const entry = parseRosterHostScanCacheEntry(value);
    if (entry) entries[key] = entry;
  }
  return { schemaVersion: 1, generatedBy: "muster-roster", entries };
}

function parseRosterHostScanCacheEntry(value: unknown): RosterHostScanCacheEntry | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entry = value as Record<string, unknown>;
  if (
    entry.schemaVersion !== 1 ||
    entry.cliVersion !== CLI_MUSTER_VERSION ||
    typeof entry.provider !== "string" ||
    typeof entry.root !== "string" ||
    (entry.layout !== "codex-cache" && entry.layout !== "provider-cache") ||
    typeof entry.fingerprint !== "string" ||
    typeof entry.scannedAt !== "string" ||
    !Array.isArray(entry.connectors)
  ) {
    return undefined;
  }
  const connectors = entry.connectors.flatMap((connector) => parseRosterHostConnector(connector));
  return {
    schemaVersion: 1,
    cliVersion: CLI_MUSTER_VERSION,
    provider: entry.provider,
    root: entry.root,
    layout: entry.layout,
    fingerprint: entry.fingerprint,
    scannedAt: entry.scannedAt,
    sourceCount: typeof entry.sourceCount === "number" && Number.isFinite(entry.sourceCount) && entry.sourceCount >= 0
      ? entry.sourceCount
      : undefined,
    connectors,
  };
}

function parseRosterHostConnector(value: unknown): RosterHostConnector[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const connector = value as Record<string, unknown>;
  if (
    typeof connector.provider !== "string" ||
    (connector.kind !== "app" && connector.kind !== "mcp") ||
    typeof connector.id !== "string" ||
    typeof connector.auth !== "string"
  ) {
    return [];
  }
  return [{
    provider: connector.provider,
    kind: connector.kind,
    id: connector.id,
    auth: connector.auth,
    transport: typeof connector.transport === "string" ? connector.transport : undefined,
    source: typeof connector.source === "string" ? connector.source : undefined,
  }];
}

async function writeRosterHostScanCache(path: string, cache: RosterHostScanCacheFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(cache, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function rosterHostScanCacheEntryFresh(entry: RosterHostScanCacheEntry, source: ProviderReuseSource, fingerprint: string, ttlMs: number): boolean {
  const scannedAt = Date.parse(entry.scannedAt);
  return entry.cliVersion === CLI_MUSTER_VERSION &&
    entry.provider === source.provider &&
    entry.root === source.root &&
    entry.layout === source.layout &&
    entry.fingerprint === fingerprint &&
    Number.isFinite(scannedAt) &&
    Date.now() - scannedAt <= ttlMs;
}

function rosterHostScanCacheKey(source: ProviderReuseSource): string {
  const digest = createHash("sha256")
    .update(`${source.provider}\n${source.layout}\n${source.root}`)
    .digest("hex")
    .slice(0, 24);
  return `${source.provider}-${digest}`;
}

function pluginReuseProviderArg(args: readonly string[]): { readonly provider: string; readonly index: number } {
  const valueFlags = new Set(["--adopt-mcp", "--report"]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (valueFlags.has(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith("--")) continue;
    return { provider: arg, index };
  }
  return { provider: "codex", index: -1 };
}

async function pluginReuseCommand(host: string, args: string[] = []): Promise<void> {
  const jsonOutput = args.includes("--json");
  const requestedAdoptions = readFlags(args, "--adopt-mcp").map(normalizeProviderMcpId);
  const adoptAll = args.includes("--adopt-all-mcps") || args.includes("--adopt-all-mcp");
  const policy = requestedAdoptions.length || adoptAll ? "adopt_mcp" : "discover_only";
  const source = providerReuseSource(host);
  if (!source) {
    const payload = {
      schemaVersion: 1,
      command: "plugins.reuse",
      provider: host,
      status: "unsupported",
      supported: ["codex", "claude", "openclaw", "hermes", "custom"],
      customEnv: `MUSTER_${providerEnvKey(host)}_PLUGIN_CACHE`,
      counts: { plugins: 0, apps: 0, mcps: 0 },
      policy,
      safety: { secrets: "not_read", tokens: "not_copied" },
      requestedAdoptions,
      adoptAllMcps: adoptAll,
      plugins: [],
      adoptions: [],
      mutationBoundary: "none",
      mutation: { wouldWriteConfig: false, boundary: "none", configuredMcps: [] },
      note: "Reuse is provider-manifest driven. Point the provider cache env var at a local plugin directory that contains .app.json or .mcp.json manifests.",
    };
    await printRosterJsonOrReport(args, payload, { jsonOutput });
    if (jsonOutput) return;
    console.log(`provider=${host} status=unsupported`);
    console.log("supported=codex,claude,openclaw,hermes,custom");
    console.log(`custom_env=MUSTER_${providerEnvKey(host)}_PLUGIN_CACHE`);
    console.log("note=Reuse is provider-manifest driven. Point the provider cache env var at a local plugin directory that contains .app.json or .mcp.json manifests.");
    return;
  }
  const candidates = await scanProviderPluginReuseCandidates(source);
  const appCount = candidates.reduce((count, plugin) => count + plugin.apps.length, 0);
  const mcpCount = candidates.reduce((count, plugin) => count + plugin.mcps.length, 0);
  const plugins = candidates.map((plugin) => ({
    id: plugin.id,
    provider: plugin.provider,
    version: plugin.version,
    sourceRoot: plugin.sourceRoot,
    apps: plugin.apps.map((app) => ({
      id: app.id,
      mode: app.required ? "required" : app.optional ? "optional" : "available",
      auth: "reuse_host",
      next: providerAppSetupPlugin(app.id, plugin.id) ? `muster plugins setup ${providerAppSetupPlugin(app.id, plugin.id)}` : "muster plugins catalog",
    })),
    mcps: plugin.mcps.map((mcp) => ({
      id: mcp.id,
      transport: mcp.transport,
      auth: mcp.auth,
      url: mcp.transport === "http" ? mcp.url : undefined,
      command: mcp.transport === "stdio" ? mcp.command : undefined,
      args: mcp.transport === "stdio" ? mcp.args : undefined,
      next: providerMcpNextCommand(mcp, plugin),
    })),
  }));
  const adoptions: ProviderReuseAdoptionResult[] = [];
  if (!candidates.length) {
    await printRosterJsonOrReport(args, {
      schemaVersion: 1,
      command: "plugins.reuse",
      provider: source.provider,
      status: "not_found",
      source,
      counts: { plugins: 0, apps: 0, mcps: 0 },
      policy,
      safety: { secrets: "not_read", tokens: "not_copied" },
      requestedAdoptions,
      adoptAllMcps: adoptAll,
      checked: source.root,
      plugins,
      adoptions,
      mutationBoundary: "none",
      mutation: { wouldWriteConfig: false, boundary: "none", configuredMcps: [] },
      nextActions: [
        `Install or authenticate provider plugins, or set MUSTER_${providerEnvKey(source.provider)}_PLUGIN_CACHE to the provider plugin cache path.`,
      ],
    }, { jsonOutput });
    if (jsonOutput) return;
    console.log(`provider=${source.provider} status=not_found plugins=0 apps=0 mcps=0`);
    console.log(`policy=${policy} secrets=not_read tokens=not_copied`);
    console.log(`checked=${source.root}`);
    console.log(`next=Install or authenticate provider plugins, or set MUSTER_${providerEnvKey(source.provider)}_PLUGIN_CACHE to the provider plugin cache path.`);
    return;
  }
  if (requestedAdoptions.length || adoptAll) {
    const allMcps = candidates.flatMap((plugin) => plugin.mcps.map((mcp) => ({ plugin, mcp })));
    const selected = adoptAll
      ? allMcps
      : requestedAdoptions.flatMap((id) => allMcps.filter((candidate) => candidate.mcp.id === id));
    const missing = adoptAll ? [] : requestedAdoptions.filter((id) => !allMcps.some((candidate) => candidate.mcp.id === id));
    for (const id of missing) adoptions.push({ id, provider: source.provider, status: "not_found" });
    const seen = new Set<string>();
    for (const candidate of selected) {
      if (seen.has(candidate.mcp.id)) continue;
      seen.add(candidate.mcp.id);
      const result = await adoptProviderReuseMcp(candidate.mcp, candidate.plugin);
      adoptions.push({ id: candidate.mcp.id, provider: source.provider, ...result });
    }
  }
  const nextActions = [
    "muster mcp catalog",
    "muster plugins setup authenticated-app-reuse",
    "muster plugins reuse <provider> --adopt-mcp <id>",
    "muster plugins reuse <provider> --adopt-all-mcps",
    "muster mcp add-http <name> <url> [--oauth ...]",
    "muster mcp add-stdio <name> <command> [args...]",
    "muster plugins inspect <path> && muster plugins load <path> [--allow-high-risk]",
    "muster skills catalog && muster skills enable <id>",
  ];
  const configuredAdoptions = adoptions.filter((adoption) => adoption.status === "configured");
  const mutationBoundary = configuredAdoptions.length ? "tools.mcp.servers only" : "none";
  await printRosterJsonOrReport(args, {
    schemaVersion: 1,
    command: "plugins.reuse",
    provider: source.provider,
    status: "discovered",
    source,
    counts: { plugins: candidates.length, apps: appCount, mcps: mcpCount },
    policy,
    safety: { secrets: "not_read", tokens: "not_copied" },
    requestedAdoptions,
    adoptAllMcps: adoptAll,
    plugins,
    adoptions,
    mutationBoundary,
    mutation: { wouldWriteConfig: configuredAdoptions.length > 0, boundary: mutationBoundary, configuredMcps: configuredAdoptions.map((adoption) => adoption.id) },
    adoptionNote: adoptions.some((adoption) => adoption.status !== "not_found") ? "Provider secrets and OAuth tokens were not copied; run login/test commands to authenticate or verify Muster-owned config." : undefined,
    nextActions,
  }, { jsonOutput });
  if (jsonOutput) return;
  console.log(`provider=${source.provider} status=discovered plugins=${candidates.length} apps=${appCount} mcps=${mcpCount}`);
  console.log(`policy=${policy} secrets=not_read tokens=not_copied`);
  for (const plugin of candidates) {
    const apps = plugin.apps.length ? plugin.apps.map((app) => `${app.id}${app.required ? "(required)" : app.optional ? "(optional)" : ""}`).join(",") : "-";
    const mcps = plugin.mcps.length ? plugin.mcps.map((mcp) => mcp.id).join(",") : "-";
    console.log(`plugin=${plugin.id} provider=${plugin.provider} version=${plugin.version} apps=${apps} mcps=${mcps}`);
    for (const app of plugin.apps) {
      const setupPlugin = providerAppSetupPlugin(app.id, plugin.id);
      const setupCommand = setupPlugin ? `muster plugins setup ${setupPlugin}` : "muster plugins catalog";
      const mode = app.required ? "required" : app.optional ? "optional" : "available";
      console.log(`  app=${app.id} mode=${mode} auth=reuse_host next="${setupCommand}"`);
    }
    for (const mcp of plugin.mcps) {
      const next = providerMcpNextCommand(mcp, plugin);
      const detail = mcp.transport === "http" ? `url=${mcp.url ?? "-"}` : `command=${mcp.command ?? "-"} ${(mcp.args ?? []).join(" ")}`.trim();
      console.log(`  mcp=${mcp.id} transport=${mcp.transport} ${detail} auth=${mcp.auth} next="${next}"`);
    }
  }
  for (const adoption of adoptions) {
    if (adoption.status === "not_found") {
      console.log(`adopted_mcp=${adoption.id} status=not_found provider=${adoption.provider}`);
      continue;
    }
    console.log(`adopted_mcp=${adoption.id} provider=${adoption.provider} status=${adoption.status} transport=${adoption.transport} auth=${adoption.auth} next="${adoption.next}"`);
  }
  if (adoptions.some((adoption) => adoption.status !== "not_found")) console.log("adoption_note=Provider secrets and OAuth tokens were not copied; run login/test commands to authenticate or verify Muster-owned config.");
  console.log("next=muster mcp catalog");
  console.log("next=muster plugins setup authenticated-app-reuse");
  console.log("adopt_mcp=muster plugins reuse <provider> --adopt-mcp <id>");
  console.log("adopt_all_mcps=muster plugins reuse <provider> --adopt-all-mcps");
  console.log("explicit_mcp_http=muster mcp add-http <name> <url> [--oauth ...]");
  console.log("explicit_mcp_stdio=muster mcp add-stdio <name> <command> [args...]");
  console.log("explicit_plugin=muster plugins inspect <path> && muster plugins load <path> [--allow-high-risk]");
  console.log("explicit_skill=muster skills catalog && muster skills enable <id>");
}

async function adoptProviderReuseMcp(mcp: ProviderReuseMcp, plugin: ProviderReusePlugin): Promise<{ readonly status: "configured" | "skipped"; readonly transport: string; readonly auth: string; readonly next: string }> {
  const key = safeConfigKey(mcp.id);
  const existing = (await loadConfig()).tools?.mcp?.servers?.[key];
  if (existing) {
    return {
      status: "skipped",
      transport: existing.transport.kind,
      auth: existing.auth ?? "none",
      next: `muster mcp status ${key}`,
    };
  }
  const builtin = findBuiltinMcpEntry(mcp.id);
  if (builtin?.install && mcp.transport === "http" && builtin.install.transport.kind === "http" && builtin.install.transport.url === mcp.url) {
    await configureBuiltinMcp(mcp.id);
    return {
      status: "configured",
      transport: "http",
      auth: builtin.install.auth ?? builtin.auth ?? "none",
      next: builtin.install.auth === "oauth" || builtin.auth === "oauth" ? `muster mcp login ${key}` : `muster mcp test ${key}`,
    };
  }
  if (mcp.transport === "http" && mcp.url) {
    if (mcp.auth === "api_key") {
      return { status: "skipped", transport: "http", auth: "api_key", next: providerMcpNextCommand(mcp, plugin) };
    }
    const config = await loadConfig();
    const server: McpServerConfig = {
      transport: { kind: "http", url: mcp.url },
      auth: "oauth",
      oauth: { setupUrl: mcp.url, clientName: "Muster" },
    };
    await saveConfig({
      ...config,
      tools: {
        ...(config.tools ?? {}),
        mcp: {
          ...(config.tools?.mcp ?? {}),
          servers: { ...(config.tools?.mcp?.servers ?? {}), [key]: server },
        },
      },
    });
    return { status: "configured", transport: "http", auth: "oauth", next: `muster mcp login ${key}` };
  }
  if (mcp.transport === "stdio" && mcp.command) {
    const config = await loadConfig();
    const server: McpServerConfig = { transport: { kind: "stdio", command: mcp.command, args: [...(mcp.args ?? [])] } };
    await saveConfig({
      ...config,
      tools: {
        ...(config.tools ?? {}),
        mcp: {
          ...(config.tools?.mcp ?? {}),
          servers: { ...(config.tools?.mcp?.servers ?? {}), [key]: server },
        },
      },
    });
    return { status: "configured", transport: "stdio", auth: "none", next: `muster mcp test ${key}` };
  }
  return { status: "skipped", transport: mcp.transport, auth: "unknown", next: providerMcpNextCommand(mcp, plugin) };
}

function providerReuseSource(provider: string): ProviderReuseSource | undefined {
  const normalized = provider.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  const explicit = process.env[`MUSTER_${providerEnvKey(normalized)}_PLUGIN_CACHE`] ?? process.env.MUSTER_PROVIDER_PLUGIN_CACHE;
  if (explicit) return { provider: normalized, root: explicit, layout: "provider-cache" };
  if (normalized === "codex") {
    const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
    return { provider: "codex", root: join(codexHome, "plugins", "cache"), layout: "codex-cache" };
  }
  if (normalized === "claude" || normalized === "claude-code") {
    const claudeHome = process.env.CLAUDE_HOME || join(homedir(), ".claude");
    return { provider: normalized, root: join(claudeHome, "plugins", "cache"), layout: "provider-cache" };
  }
  if (normalized === "openclaw") {
    const openclawHome = process.env.OPENCLAW_HOME || join(homedir(), ".openclaw");
    return { provider: "openclaw", root: join(openclawHome, "plugins"), layout: "provider-cache" };
  }
  if (normalized === "hermes" || normalized === "hermes-agent") {
    const hermesHome = process.env.HERMES_HOME || join(homedir(), ".hermes");
    return { provider: normalized, root: join(hermesHome, "plugins"), layout: "provider-cache" };
  }
  return undefined;
}

function providerEnvKey(provider: string): string {
  return provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

async function scanProviderPluginReuseCandidates(source: ProviderReuseSource): Promise<ProviderReusePlugin[]> {
  const root = source.root;
  const result: ProviderReusePlugin[] = [];
  for (const pluginPath of await providerPluginManifestRoots(source)) {
    const apps = await readProviderReuseApps(join(pluginPath.path, ".app.json"));
    const mcps = await readProviderReuseMcps(join(pluginPath.path, ".mcp.json"), pluginPath.path);
    if (!apps.length && !mcps.length) continue;
    result.push({
      id: pluginPath.id,
      provider: source.provider,
      sourceRoot: pluginPath.sourceRoot,
      version: pluginPath.version,
      apps,
      mcps,
    });
  }
  return result.sort((left, right) => left.id.localeCompare(right.id) || left.version.localeCompare(right.version));
}

async function providerPluginManifestRoots(source: ProviderReuseSource): Promise<Array<{ readonly id: string; readonly sourceRoot: string; readonly version: string; readonly path: string }>> {
  const roots: Array<{ readonly id: string; readonly sourceRoot: string; readonly version: string; readonly path: string }> = [];
  const root = source.root;
  if (await fileExists(join(root, ".app.json")) || await fileExists(join(root, ".mcp.json"))) {
    roots.push({ id: source.provider, sourceRoot: "root", version: "local", path: root });
    return roots;
  }
  for (const first of await safeReadDir(root)) {
    if (!first.isDirectory()) continue;
    const firstPath = join(root, first.name);
    if (await fileExists(join(firstPath, ".app.json")) || await fileExists(join(firstPath, ".mcp.json"))) {
      roots.push({ id: first.name, sourceRoot: "local", version: "local", path: firstPath });
      continue;
    }
    for (const second of await safeReadDir(firstPath)) {
      if (!second.isDirectory()) continue;
      const secondPath = join(firstPath, second.name);
      if (await fileExists(join(secondPath, ".app.json")) || await fileExists(join(secondPath, ".mcp.json"))) {
        roots.push({ id: first.name, sourceRoot: first.name, version: second.name, path: secondPath });
        continue;
      }
      for (const third of await safeReadDir(secondPath)) {
        if (!third.isDirectory()) continue;
        const thirdPath = join(secondPath, third.name);
        if (await fileExists(join(thirdPath, ".app.json")) || await fileExists(join(thirdPath, ".mcp.json"))) {
          roots.push({ id: second.name, sourceRoot: first.name, version: third.name, path: thirdPath });
        }
      }
    }
  }
  return roots;
}

async function providerReuseSourceFingerprint(source: ProviderReuseSource): Promise<string> {
  const rows: string[] = [`schema=1`, `provider=${source.provider}`, `layout=${source.layout}`, `root=${source.root}`];
  await collectProviderReuseFingerprintRows(source.root, 0, rows);
  return createHash("sha256").update(rows.sort().join("\n")).digest("hex");
}

async function collectProviderReuseFingerprintRows(path: string, depth: number, rows: string[]): Promise<void> {
  if (rows.length > 2000) {
    rows.push("truncated=true");
    return;
  }
  try {
    const detail = await stat(path);
    rows.push(`${depth}:${path}:${detail.isDirectory() ? "dir" : "file"}:${Math.trunc(detail.mtimeMs)}:${detail.size}`);
    if (!detail.isDirectory() || depth >= 4) return;
    for (const entry of await safeReadDir(path)) {
      if (entry.name.startsWith(".")) {
        if (entry.name !== ".app.json" && entry.name !== ".mcp.json") continue;
      }
      await collectProviderReuseFingerprintRows(join(path, entry.name), depth + 1, rows);
    }
  } catch {
    rows.push(`${depth}:${path}:missing`);
  }
}

async function safeReadDir(path: string): Promise<import("node:fs").Dirent[]> {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function readProviderReuseApps(path: string): Promise<ProviderReuseApp[]> {
  const raw = await readJsonObject(path);
  const apps = raw?.apps;
  if (!apps || typeof apps !== "object" || Array.isArray(apps)) return [];
  return Object.entries(apps)
    .map(([id, value]) => {
      const detail = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
      return {
        id: normalizeProviderCapabilityId(id),
        required: detail.required === true,
        optional: detail.optional === true,
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

async function readProviderReuseMcps(path: string, versionPath: string): Promise<ProviderReuseMcp[]> {
  const raw = await readJsonObject(path);
  const servers = raw?.mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return [];
  return Object.entries(servers)
    .map(([id, value]) => {
      const server = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
      if (server.type === "http" || typeof server.url === "string") {
        return {
          id: normalizeProviderMcpId(id),
          transport: "http" as const,
          auth: providerHttpMcpAuth(server),
          url: typeof server.url === "string" ? server.url : undefined,
        };
      }
      const command = typeof server.command === "string" ? server.command : undefined;
      const args = Array.isArray(server.args) ? server.args.filter((item): item is string => typeof item === "string") : [];
      return {
        id: normalizeProviderMcpId(id),
        transport: "stdio" as const,
        auth: "local" as const,
        command,
        args: args.map((arg) => arg.startsWith("./") ? resolve(versionPath, arg) : arg),
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

async function readJsonObject(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function normalizeProviderCapabilityId(id: string): string {
  return id
    .replace(/_/g, "-")
    .replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)
    .replace(/^-/, "")
    .toLowerCase();
}

function normalizeProviderMcpId(id: string): string {
  return normalizeProviderCapabilityId(id);
}

function providerHttpMcpAuth(server: Record<string, unknown>): "oauth" | "api_key" {
  const secretFields = ["apiKey", "api_key", "bearerToken", "accessToken", "token", "authorization"];
  if (secretFields.some((field) => typeof server[field] === "string" && (server[field] as string).length > 0)) return "api_key";
  const headers = server.headers && typeof server.headers === "object" && !Array.isArray(server.headers)
    ? server.headers as Record<string, unknown>
    : undefined;
  const authorization = typeof headers?.Authorization === "string" ? headers.Authorization : undefined;
  if (authorization) return "api_key";
  if (headers && Object.entries(headers).some(([key, value]) => /api[-_]?key|token|authorization/i.test(key) && typeof value === "string" && value.length > 0)) return "api_key";
  return "oauth";
}

function providerAppSetupPlugin(appId: string, pluginId: string): string | undefined {
  const normalizedApp = normalizeProviderCapabilityId(appId);
  const mapped: Record<string, string> = {
    figma: "figma",
    github: "github",
    "google-calendar": "google-calendar",
    "google-drive": "google-workspace",
    heygen: "heygen",
    notion: "notion",
    "openai-platform": "provider-openai",
    salesforce: "sales",
    hubspot: "sales",
    supabase: "supabase",
    slack: "slack",
    teams: "teams",
    "microsoft-teams": "teams",
    gmail: "google-workspace",
    "outlook-calendar": "google-calendar",
    "outlook-email": "google-workspace",
    sharepoint: "google-workspace",
  };
  return mapped[normalizedApp] ?? (listBuiltinPlugins().some((entry) => entry.id === pluginId) ? pluginId : undefined);
}

function providerMcpNextCommand(mcp: ProviderReuseMcp, plugin: ProviderReusePlugin): string {
  if (mcp.transport === "http") {
    const builtin = findBuiltinMcpEntry(mcp.id);
    if (builtin?.install?.transport.kind === "http" && builtin.install.transport.url === mcp.url) return `muster mcp install ${mcp.id} && muster mcp login ${mcp.id}`;
    if (mcp.auth === "api_key" && mcp.url) return `muster mcp add-http ${mcp.id} ${mcp.url}`;
    if (mcp.url) return `muster mcp add-http ${mcp.id} ${mcp.url} --oauth`;
  }
  const command = mcp.command;
  if (command) {
    const args = (mcp.args ?? []).join(" ");
    return `muster mcp add-stdio ${mcp.id} ${command}${args ? ` ${args}` : ""}`;
  }
  return `muster plugins setup ${providerAppSetupPlugin(mcp.id, plugin.id) ?? "authenticated-app-reuse"}`;
}

async function pluginContextCommand(pluginId: string, args: string[]): Promise<void> {
  const plugin = listBuiltinPlugins().find((entry) => entry.id === pluginId || entry.aliases?.includes(pluginId));
  if (!plugin) throw new Error(`Unknown built-in plugin "${pluginId}". Run muster plugins catalog.`);
  if (plugin.id !== "frappe-federated-bridge") {
    throw new Error(`Plugin context builder is currently available for frappe only; got ${plugin.id}.`);
  }
  const mode = args[0] ?? "setup";
  const packPath = await resolveBuiltinPackPath(plugin);
  if (!packPath) throw new Error(`Plugin ${plugin.id} has no local capability pack.`);
  const registry = builtinFlowRegistry();
  await loadCapabilityPack(packPath, {
    registry,
    allowHighRisk: true,
    pluginPolicy: await loadPluginPolicy(),
  });
  const toolArgs = frappeContextToolArgs(args.slice(1));
  const toolName = {
    setup: "frappe-federated-bridge__frappe_context_setup_plan",
    docs: "frappe-federated-bridge__frappe_docs_context",
    module: "frappe-federated-bridge__frappe_module_context",
    build: "frappe-federated-bridge__frappe_context_build",
  }[mode];
  if (!toolName) {
    throw new Error("Usage: muster plugins context frappe <setup|docs|module|build> [--site-url URL] [--api-token TOKEN | --admin-user USER --admin-password PASS] [--app app] [--module module]");
  }
  const tool = registry[toolName];
  if (!tool) throw new Error(`Frappe context tool was not registered: ${toolName}`);
  const result = await tool(toolArgs);
  console.log(JSON.stringify(redactFrappeContextResult(result), null, 2));
}

function frappeContextToolArgs(args: string[]): Record<string, unknown> {
  const modules = readFlags(args, "--module");
  return {
    siteUrl: readFlag(args, "--site-url") ?? readFlag(args, "--site"),
    apiToken: readFlag(args, "--api-token"),
    adminUser: readFlag(args, "--admin-user") ?? readFlag(args, "--user"),
    adminPassword: readFlag(args, "--admin-password") ?? readFlag(args, "--password"),
    apps: readFlags(args, "--app"),
    modules,
    module: modules[0],
    query: readFlag(args, "--query"),
  };
}

function redactFrappeContextResult(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactFrappeContextResult);
  if (typeof value !== "object" || value === null) return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (/password|token|cookie|secret|sid/i.test(key)) {
      result[key] = "[redacted]";
    } else {
      result[key] = redactFrappeContextResult(item);
    }
  }
  return result;
}

async function mcpCommand(args: string[]): Promise<void> {
  const [action, name, ...rest] = args;
  if (action === "oauth") {
    await mcpOauthCommand([name, ...rest].filter((item): item is string => Boolean(item)));
    return;
  }
  if (action === "status") {
    await printMcpStatus(name);
    return;
  }
  if (action === "login") {
    if (!name) throw new Error("Usage: muster mcp login <name> [--callback-url URL] [--no-browser]");
    await printMcpOauthSetup(name, rest);
    return;
  }
  if (action === "logout") {
    if (!name) throw new Error("Usage: muster mcp logout <name>");
    const result = await removeMcpOAuthToken(name);
    console.log(`oauth=${name} status=logged_out removed=${result.removed} token_path=${result.tokenPath}`);
    return;
  }
  if (action === "catalog") {
    for (const server of listBuiltinMcpServers()) {
      const requiredGroups = [...(server.requiresEnv ?? []), ...(server.requiresAnyEnv ?? []).map((group) => group.join("|"))];
      const env = requiredGroups.length ? ` env=${requiredGroups.join(",")}` : "";
      const auth = server.auth ? ` auth=${server.auth}` : "";
      const tools = server.defaultTools?.length ? ` default_tools=${server.defaultTools.join(",")}` : "";
      console.log(`${server.id.padEnd(16)} ${server.source.padEnd(9)} ${server.category.padEnd(14)} risk=${server.risk.padEnd(6)}${auth}${env}${tools} ${server.description}`);
      if (server.setupUrls?.length) console.log(`  setup: ${server.setupUrls.join(" ")}`);
      console.log(`  install: ${server.commandHint}`);
    }
    return;
  }
  if (action === "check" || action === "doctor") {
    if (!name) {
      for (const entry of listBuiltinMcpServers()) await printMcpCheck(entry);
      return;
    }
    const entry = findBuiltinMcpEntry(name);
    if (!entry) throw new Error(`Unknown built-in MCP "${name}". Run muster mcp catalog.`);
    await printMcpCheck(entry);
    return;
  }
  if (action === "install") {
    if (!name) throw new Error("Usage: muster mcp install <id>");
    const entry = findBuiltinMcpEntry(name);
    if (!entry) throw new Error(`Unknown built-in MCP "${name}". Run muster mcp catalog.`);
    const missing = missingMcpEnv(entry);
    if (missing.length) {
      console.log(`mcp=${entry.id} status=needs_env missing=${missing.join(",")}`);
      for (const url of entry.setupUrls ?? []) console.log(`setup_url=${url}`);
      for (const note of entry.notes ?? []) console.log(`note=${note}`);
      return;
    }
    const ok = await configureBuiltinMcp(entry.id);
    if (!ok) {
      console.log(`mcp=${entry.id} status=manual_setup command="${entry.commandHint}"`);
      for (const url of entry.setupUrls ?? []) console.log(`setup_url=${url}`);
      for (const note of entry.notes ?? []) console.log(`note=${note}`);
      return;
    }
    console.log(`mcp=${entry.id} status=configured`);
    if (entry.defaultTools?.length) console.log(`default_tools=${entry.defaultTools.join(",")}`);
    if (entry.auth === "oauth") {
      const status = await mcpOAuthStatus(entry.id);
      console.log(`oauth=${status.authenticated ? "authenticated" : "not_authenticated"}`);
      console.log(`oauth_setup=muster mcp oauth setup ${entry.id}`);
    }
    for (const note of entry.notes ?? []) console.log(`note=${note}`);
    return;
  }
  if (action === "list" || action === undefined) {
    const servers = (await loadConfig()).tools?.mcp?.servers ?? {};
    const entries = Object.entries(servers);
    if (!entries.length) {
      const catalog = listBuiltinMcpServers();
      const oauth = catalog.filter((entry) => entry.auth === "oauth").length;
      const installable = catalog.filter((entry) => entry.install || entry.commandHint).length;
      console.log("No MCP servers configured for this profile yet.");
      console.log(`catalog=${catalog.length} installable_or_guided=${installable} oauth=${oauth}`);
      console.log("next=muster mcp catalog");
      console.log("install=muster mcp install <id>");
      console.log("custom=muster mcp add-http <name> <url> | muster mcp add-stdio <name> <command> [args...]");
      return;
    }
    for (const [serverName, server] of entries) {
      const transport = server.transport.kind === "stdio"
        ? `stdio ${server.transport.command} ${(server.transport.args ?? []).join(" ")}`.trim()
        : `http ${server.transport.url}`;
      const auth = server.auth ? `\tauth=${server.auth}` : "";
      console.log(`${serverName}\t${transport}\tinclude=${server.tools?.include?.join(",") || "-"} exclude=${server.tools?.exclude?.join(",") || "-"}${auth}`);
    }
    return;
  }
  if (action === "add-stdio") {
    if (!name || !rest[0]) throw new Error("Usage: muster mcp add-stdio <name> <command> [args...]");
    const config = await loadConfig();
    const server: McpServerConfig = { transport: { kind: "stdio", command: rest[0], args: rest.slice(1) } };
    await saveConfig({
      ...config,
      tools: {
        ...(config.tools ?? {}),
        mcp: {
          ...(config.tools?.mcp ?? {}),
          servers: {
            ...(config.tools?.mcp?.servers ?? {}),
            [safeConfigKey(name)]: server,
          },
        },
      },
    });
    console.log(`mcp_server=${safeConfigKey(name)} transport=stdio command=${rest[0]}`);
    return;
  }
  if (action === "add-http") {
    if (!name || !rest[0]) throw new Error("Usage: muster mcp add-http <name> <url> [--oauth --authorization-url URL --token-url URL --client-id ID --client-secret-env ENV --scope S --redirect-port N]");
    const oauth = args.includes("--oauth");
    const oauthConfig = oauth ? {
      setupUrl: readFlag(args, "--setup-url"),
      authorizationUrl: readFlag(args, "--authorization-url"),
      tokenUrl: readFlag(args, "--token-url"),
      clientId: readFlag(args, "--client-id"),
      clientSecret: readEnvFlag(args, "--client-secret-env"),
      scope: readFlag(args, "--scope"),
      clientName: readFlag(args, "--client-name") ?? "Muster",
      redirectPort: readNumberFlag(args, "--redirect-port"),
    } : undefined;
    const config = await loadConfig();
    const server: McpServerConfig = {
      transport: { kind: "http", url: rest[0] },
      ...(oauth ? { auth: "oauth" as const, oauth: oauthConfig } : {}),
    };
    await saveConfig({
      ...config,
      tools: {
        ...(config.tools ?? {}),
        mcp: {
          ...(config.tools?.mcp ?? {}),
          servers: {
            ...(config.tools?.mcp?.servers ?? {}),
            [safeConfigKey(name)]: server,
          },
        },
      },
    });
    console.log(`mcp_server=${safeConfigKey(name)} transport=http url=${rest[0]}${oauth ? " auth=oauth" : ""}`);
    if (oauth) console.log(`oauth_setup=muster mcp oauth setup ${safeConfigKey(name)}`);
    return;
  }
  if (action === "remove" || action === "rm") {
    if (!name) throw new Error("Usage: muster mcp remove <name>");
    const config = await loadConfig();
    const servers = { ...(config.tools?.mcp?.servers ?? {}) };
    const existed = Boolean(servers[name]);
    delete servers[name];
    await saveConfig({ ...config, tools: { ...(config.tools ?? {}), mcp: { ...(config.tools?.mcp ?? {}), servers } } });
    console.log(existed ? `removed=${name}` : `not_found=${name}`);
    return;
  }
  if (action === "test") {
    if (!name) throw new Error("Usage: muster mcp test <name>");
    await printMcpTest(name, { setExitCode: true });
    return;
  }
  throw new Error("Usage: muster mcp list|status [name]|login <name>|logout <name>|catalog|check [id]|install <id>|oauth status|setup|import ...|add-http <name> <url> [--oauth ...]|add-stdio <name> <command> [args...]|test <name>|remove <name>");
}

async function printMcpStatus(name?: string): Promise<void> {
  const servers = (await loadConfig()).tools?.mcp?.servers ?? {};
  if (name) {
    const server = servers[name];
    if (!server) throw new Error(`MCP server not configured: ${name}`);
    await printConfiguredMcpStatus(name, server);
    return;
  }
  const entries = Object.entries(servers);
  if (!entries.length) {
    const catalog = listBuiltinMcpServers();
    const oauth = catalog.filter((entry) => entry.auth === "oauth").length;
    const installable = catalog.filter((entry) => entry.install || entry.commandHint).length;
    console.log("No MCP servers configured for this profile yet.");
    console.log(`catalog=${catalog.length} installable_or_guided=${installable} oauth=${oauth}`);
    console.log("next=muster mcp catalog");
    console.log("install=muster mcp install <id>");
    console.log("custom=muster mcp add-http <name> <url> | muster mcp add-stdio <name> <command> [args...]");
    return;
  }
  for (const [serverName, server] of entries) await printConfiguredMcpStatus(serverName, server);
}

async function printConfiguredMcpStatus(name: string, server: McpServerConfig): Promise<void> {
  const transport = server.transport.kind === "stdio"
    ? `stdio ${server.transport.command} ${(server.transport.args ?? []).join(" ")}`.trim()
    : `http ${server.transport.url}`;
  console.log(`mcp=${name} transport=${transport} auth=${server.auth ?? "none"} include=${server.tools?.include?.join(",") || "-"} exclude=${server.tools?.exclude?.join(",") || "-"}`);
  if (server.auth === "oauth") {
    await printMcpOauthStatus(name);
    const status = await mcpOAuthStatus(name);
    console.log(`login=${status.authenticated ? "ok" : `muster mcp login ${name}`}`);
    console.log(`logout=muster mcp logout ${name}`);
  }
}

async function printMcpTest(name: string, options: { readonly setExitCode: boolean }): Promise<void> {
  const server = (await loadConfig()).tools?.mcp?.servers?.[name];
  if (!server) throw new Error(`MCP server not configured: ${name}`);
  const connected = await connectMcpServers({ [name]: server }, process.cwd());
  try {
    const handle = connected.handles[0];
    console.log(`server=${handle.name} status=${handle.status}${handle.error ? ` error=${handle.error}` : ""}`);
    for (const tool of handle.tools) console.log(`tool=${tool.namespaced} ${tool.description ?? ""}`.trim());
    if (handle.status === "failed" && options.setExitCode) process.exitCode = 1;
  } finally {
    connected.close();
  }
}

async function printMcpCheck(entry: BuiltinMcpCatalogEntry): Promise<void> {
  const config = await loadConfig();
  const configured = Boolean(config.tools?.mcp?.servers?.[entry.id]);
  const missing = missingMcpEnv(entry);
  const installable = Boolean(entry.install && !missing.length && mcpConfigFromCatalogEntry(entry));
  const status = configured ? "configured" : missing.length ? "needs_env" : installable ? "installable" : "manual_setup";
  console.log(`mcp=${entry.id} status=${status} configured=${configured} installable=${installable} auth=${entry.auth ?? "none"} risk=${entry.risk}`);
  if (missing.length) console.log(`missing=${missing.join(",")}`);
  if (!entry.install && !configured) console.log(`manual_setup=${entry.commandHint}`);
  if (entry.defaultTools?.length) console.log(`default_tools=${entry.defaultTools.join(",")}`);
  if (entry.auth === "oauth" && configured) {
    const status = await mcpOAuthStatus(entry.id);
    console.log(`oauth=${status.authenticated ? "authenticated" : "not_authenticated"} expired=${status.expired}`);
    if (!status.authenticated) console.log(`oauth_setup=muster mcp oauth setup ${entry.id}`);
  } else if (entry.auth === "oauth") {
    console.log(`oauth_setup=muster mcp install ${entry.id} && muster mcp oauth setup ${entry.id}`);
  }
  for (const url of entry.setupUrls ?? []) console.log(`setup_url=${url}`);
  for (const note of entry.notes ?? []) console.log(`note=${note}`);
  console.log(`next=${configured ? `muster mcp test ${entry.id}` : installable ? `muster mcp install ${entry.id}` : entry.commandHint}`);
}

async function mcpOauthCommand(args: string[]): Promise<void> {
  const [action, name, ...rest] = args;
  if ((action === "status" || action === undefined) && !name) {
    const servers = (await loadConfig()).tools?.mcp?.servers ?? {};
    const oauthServers = Object.entries(servers).filter(([, server]) => server.auth === "oauth");
    if (!oauthServers.length) {
      console.log("No OAuth MCP servers configured.");
      return;
    }
    for (const [serverName] of oauthServers) {
      await printMcpOauthStatus(serverName);
    }
    return;
  }
  if (action === "status" && name) {
    await printMcpOauthStatus(name);
    return;
  }
  if (action === "setup" && name) {
    await printMcpOauthSetup(name, rest);
    return;
  }
  if (action === "import" && name) {
    const envName = readFlag(rest, "--access-token-env");
    if (!envName) throw new Error("Usage: muster mcp oauth import <name> --access-token-env ENV_VAR [--expires-in seconds] [--scope scope]");
    const accessToken = process.env[envName];
    if (!accessToken) throw new Error(`Environment variable ${envName} is not set.`);
    const expiresInRaw = readFlag(rest, "--expires-in");
    let expiresAt: number | undefined;
    if (expiresInRaw) {
      const expiresIn = Number(expiresInRaw);
      if (!Number.isFinite(expiresIn) || expiresIn <= 0) throw new Error("--expires-in must be a positive number of seconds.");
      expiresAt = Date.now() + expiresIn * 1000;
    }
    const scope = readFlag(rest, "--scope");
    const tokenPath = await writeMcpOAuthToken(name, {
      accessToken,
      expiresAt,
      scope,
    });
    console.log(`oauth=${name} status=imported token_path=${tokenPath}`);
    return;
  }
  throw new Error("Usage: muster mcp oauth status [name] | setup <name> | import <name> --access-token-env ENV_VAR [--expires-in seconds] [--scope scope]");
}

async function printMcpOauthStatus(name: string): Promise<void> {
  const status = await mcpOAuthStatus(name);
  console.log(`oauth=${name} authenticated=${status.authenticated} expired=${status.expired} token_path=${status.tokenPath}`);
  if (status.expiresAt) console.log(`expires_at=${new Date(status.expiresAt).toISOString()}`);
  if (status.scope) console.log(`scope=${status.scope}`);
}

async function printMcpOauthSetup(name: string, args: readonly string[] = []): Promise<void> {
  const config = await loadConfig();
  const configured = config.tools?.mcp?.servers?.[name];
  const catalog = findBuiltinMcpEntry(name);
  const setupUrl = configured?.oauth?.setupUrl ?? catalog?.setupUrls?.[0] ?? mcpSetupUrl(name);
  if (!configured && catalog) {
    console.log(`mcp=${name} status=not_installed install="muster mcp install ${name}"`);
  } else if (!configured) {
    console.log(`mcp=${name} status=not_configured`);
  } else if (configured.auth !== "oauth") {
    console.log(`mcp=${name} status=not_oauth`);
  } else {
    console.log(`mcp=${name} status=oauth_configured`);
    if (await runMcpOAuthPkceSetup(name, configured, args)) return;
  }
  if (setupUrl) console.log(`setup_url=${setupUrl}`);
  console.log("token_import=muster mcp oauth import <name> --access-token-env ENV_VAR [--expires-in seconds] [--scope scope]");
  console.log("note=Browser PKCE setup runs when oauth.authorizationUrl, oauth.tokenUrl, and oauth.clientId are configured; otherwise import an access token or use the provider's native MCP login.");
}

async function runMcpOAuthPkceSetup(name: string, configured: McpServerConfig, args: readonly string[]): Promise<boolean> {
  const oauth = configured.oauth;
  if (!oauth) return false;
  const requestedPort = readNumberFlag([...args], "--redirect-port") ?? oauth.redirectPort ?? 0;
  const callbackUrl = readFlag([...args], "--callback-url");
  if (!callbackUrl && !input.isTTY) return false;
  let server: ReturnType<typeof createServer> | undefined;
  let redirectUri = `http://127.0.0.1:${requestedPort || 1}/callback`;
  let callbackPromise: Promise<URL>;

  if (callbackUrl) {
    const pasted = new URL(callbackUrl);
    redirectUri = `${pasted.origin}${pasted.pathname}`;
    callbackPromise = Promise.resolve(pasted);
  } else {
    const callback = await startOAuthCallbackServer(requestedPort);
    server = callback.server;
    redirectUri = callback.redirectUri;
    callbackPromise = callback.callback;
  }

  const resolved = await resolveMcpOAuthClient(configured, redirectUri);
  if (!resolved) {
    server?.close();
    return false;
  }

  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  const state = base64Url(randomBytes(18));
  const authorizationUrl = new URL(resolved.authorizationUrl);
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("client_id", resolved.clientId);
  authorizationUrl.searchParams.set("redirect_uri", redirectUri);
  authorizationUrl.searchParams.set("code_challenge", challenge);
  authorizationUrl.searchParams.set("code_challenge_method", "S256");
  authorizationUrl.searchParams.set("state", state);
  if (resolved.scope) authorizationUrl.searchParams.set("scope", resolved.scope);

  console.log(`authorization_url=${authorizationUrl.toString()}`);
  if (!callbackUrl) console.log(`callback_listening=${redirectUri}`);
  console.log("note=Open the authorization URL, approve access, then return to this terminal. In SSH/headless sessions, paste the final redirect with --callback-url.");

  let callback: URL;
  try {
    const timeoutMs = readNumberFlag([...args], "--timeout-ms") ?? 300_000;
    callback = await withTimeout(callbackPromise, timeoutMs, `OAuth callback timed out after ${timeoutMs}ms`);
  } finally {
    server?.close();
  }

  const error = callback.searchParams.get("error");
  if (error) throw new Error(`OAuth authorization failed: ${error}`);
  const code = callback.searchParams.get("code");
  if (!code) throw new Error("OAuth callback did not contain a code parameter.");
  const returnedState = callback.searchParams.get("state");
  if (returnedState && returnedState !== state && !callbackUrl) throw new Error("OAuth callback state did not match the active setup flow.");

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: resolved.clientId,
    code_verifier: verifier,
  });
  if (resolved.clientSecret) body.set("client_secret", resolved.clientSecret);
  const response = await fetch(resolved.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
  });
  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text ? JSON.parse(text) as Record<string, unknown> : {};
  } catch {
    parsed = {};
  }
  if (!response.ok) {
    const detail = typeof parsed.error_description === "string" ? parsed.error_description : typeof parsed.error === "string" ? parsed.error : text || `HTTP ${response.status}`;
    throw new Error(`OAuth token exchange failed: ${detail}`);
  }
  const accessToken = typeof parsed.access_token === "string" ? parsed.access_token : "";
  if (!accessToken) throw new Error("OAuth token response did not contain access_token.");
  const expiresIn = typeof parsed.expires_in === "number" && Number.isFinite(parsed.expires_in) ? parsed.expires_in : undefined;
  const tokenPath = await writeMcpOAuthToken(name, {
    accessToken,
    refreshToken: typeof parsed.refresh_token === "string" ? parsed.refresh_token : undefined,
    tokenType: typeof parsed.token_type === "string" ? parsed.token_type : "Bearer",
    scope: typeof parsed.scope === "string" ? parsed.scope : resolved.scope,
    expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : undefined,
  });
  console.log(`oauth=${name} status=authenticated token_path=${tokenPath}`);
  return true;
}

interface ResolvedMcpOAuthClient {
  readonly authorizationUrl: string;
  readonly tokenUrl: string;
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly scope?: string;
}

interface OAuthServerMetadata {
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly registrationEndpoint?: string;
}

async function resolveMcpOAuthClient(configured: McpServerConfig, redirectUri: string): Promise<ResolvedMcpOAuthClient | undefined> {
  const oauth = configured.oauth;
  if (!oauth) return undefined;
  if (oauth.authorizationUrl && oauth.tokenUrl && oauth.clientId) {
    return {
      authorizationUrl: oauth.authorizationUrl,
      tokenUrl: oauth.tokenUrl,
      clientId: oauth.clientId,
      clientSecret: oauth.clientSecret,
      scope: oauth.scope,
    };
  }
  if (configured.transport.kind !== "http") return undefined;
  const metadata = await discoverMcpOAuthServer(configured.transport.url);
  if (!metadata) return undefined;
  if (oauth.clientId) {
    return {
      authorizationUrl: oauth.authorizationUrl ?? metadata.authorizationEndpoint,
      tokenUrl: oauth.tokenUrl ?? metadata.tokenEndpoint,
      clientId: oauth.clientId,
      clientSecret: oauth.clientSecret,
      scope: oauth.scope,
    };
  }
  if (!metadata.registrationEndpoint) return undefined;
  const registered = await registerMcpOAuthClient(metadata.registrationEndpoint, {
    clientName: oauth.clientName ?? "Muster",
    redirectUri,
    scope: oauth.scope,
  });
  if (!registered) return undefined;
  return {
    authorizationUrl: metadata.authorizationEndpoint,
    tokenUrl: metadata.tokenEndpoint,
    clientId: registered.clientId,
    clientSecret: registered.clientSecret,
    scope: oauth.scope,
  };
}

async function discoverMcpOAuthServer(resourceUrl: string): Promise<OAuthServerMetadata | undefined> {
  const protectedResource = await discoverProtectedResourceMetadata(resourceUrl);
  const issuer = protectedResource?.authorizationServer;
  if (!issuer) return undefined;
  return discoverAuthorizationServerMetadata(issuer);
}

async function discoverProtectedResourceMetadata(resourceUrl: string): Promise<{ authorizationServer?: string } | undefined> {
  const candidates = protectedResourceMetadataCandidates(resourceUrl);
  const fromChallenge = await protectedResourceMetadataFromChallenge(resourceUrl);
  if (fromChallenge) candidates.unshift(fromChallenge);
  for (const candidate of [...new Set(candidates)]) {
    const json = await fetchJsonRecord(candidate);
    if (!json) continue;
    const servers = stringArray(json.authorization_servers);
    const authorizationServer = servers[0] ?? stringValue(json.authorization_server);
    if (authorizationServer) return { authorizationServer };
  }
  return undefined;
}

async function protectedResourceMetadataFromChallenge(resourceUrl: string): Promise<string | undefined> {
  try {
    const response = await fetch(resourceUrl, { method: "GET", headers: { accept: "application/json" }, signal: AbortSignal.timeout(5000) });
    const header = response.headers.get("www-authenticate");
    return header ? parseBearerChallengeParameter(header, "resource_metadata") : undefined;
  } catch {
    return undefined;
  }
}

function protectedResourceMetadataCandidates(resourceUrl: string): string[] {
  const url = new URL(resourceUrl);
  const path = url.pathname.replace(/^\/+|\/+$/g, "");
  const candidates = [`${url.origin}/.well-known/oauth-protected-resource`];
  if (path) candidates.unshift(`${url.origin}/.well-known/oauth-protected-resource/${path}`);
  return candidates;
}

async function discoverAuthorizationServerMetadata(issuer: string): Promise<OAuthServerMetadata | undefined> {
  const issuerUrl = new URL(issuer);
  const path = issuerUrl.pathname.replace(/^\/+|\/+$/g, "");
  const candidates = [
    path ? `${issuerUrl.origin}/.well-known/oauth-authorization-server/${path}` : `${issuerUrl.origin}/.well-known/oauth-authorization-server`,
    `${issuerUrl.origin}/.well-known/oauth-authorization-server`,
    path ? `${issuerUrl.origin}/.well-known/openid-configuration/${path}` : `${issuerUrl.origin}/.well-known/openid-configuration`,
    `${issuerUrl.origin}/.well-known/openid-configuration`,
  ];
  for (const candidate of [...new Set(candidates)]) {
    const json = await fetchJsonRecord(candidate);
    if (!json) continue;
    const authorizationEndpoint = stringValue(json.authorization_endpoint);
    const tokenEndpoint = stringValue(json.token_endpoint);
    if (authorizationEndpoint && tokenEndpoint) {
      return {
        authorizationEndpoint,
        tokenEndpoint,
        registrationEndpoint: stringValue(json.registration_endpoint),
      };
    }
  }
  return undefined;
}

async function registerMcpOAuthClient(
  registrationEndpoint: string,
  request: { readonly clientName: string; readonly redirectUri: string; readonly scope?: string },
): Promise<{ clientId: string; clientSecret?: string } | undefined> {
  const body: Record<string, unknown> = {
    client_name: request.clientName,
    redirect_uris: [request.redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
  if (request.scope) body.scope = request.scope;
  try {
    const response = await fetch(registrationEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await response.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = text ? JSON.parse(text) as Record<string, unknown> : {};
    } catch {
      parsed = {};
    }
    if (!response.ok) {
      const detail = stringValue(parsed.error_description) ?? stringValue(parsed.error) ?? (text || `HTTP ${response.status}`);
      throw new Error(`OAuth dynamic client registration failed: ${detail}`);
    }
    const clientId = stringValue(parsed.client_id);
    if (!clientId) throw new Error("OAuth dynamic client registration did not return client_id.");
    return { clientId, clientSecret: stringValue(parsed.client_secret) };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("OAuth dynamic client registration")) throw error;
    return undefined;
  }
}

async function fetchJsonRecord(url: string): Promise<Record<string, unknown> | undefined> {
  try {
    const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(5000) });
    if (!response.ok) return undefined;
    const parsed = await response.json() as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function parseBearerChallengeParameter(header: string, key: string): string | undefined {
  const pattern = new RegExp(`${key}="([^"]+)"`, "i");
  return header.match(pattern)?.[1];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())) : [];
}

function base64Url(value: Buffer): string {
  return value.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function startOAuthCallbackServer(port: number): Promise<{ server: ReturnType<typeof createServer>; redirectUri: string; callback: Promise<URL> }> {
  let resolveCallback!: (url: URL) => void;
  let rejectCallback!: (error: Error) => void;
  const callback = new Promise<URL>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });
  const server = createServer((request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
      if (url.pathname !== "/callback") {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        response.end("Not found");
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<html><body><h2>Muster OAuth received.</h2><p>You can close this tab and return to the terminal.</p></body></html>");
      resolveCallback(url);
    } catch (error) {
      rejectCallback(error instanceof Error ? error : new Error(String(error)));
    }
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("Could not determine OAuth callback port.");
  return { server, redirectUri: `http://127.0.0.1:${address.port}/callback`, callback };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolveTimeout, rejectTimeout) => {
    const timer = setTimeout(() => rejectTimeout(new Error(message)), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolveTimeout(value); },
      (error) => { clearTimeout(timer); rejectTimeout(error); },
    );
  });
}

async function dashboardCommand(args: string[]): Promise<void> {
  const action = args[0] ?? "status";
  if (action === "status") {
    const state = await buildCockpitState();
    const config = await loadConfig().catch(() => undefined);
    const gateway = await loadGatewayConfig().catch(() => undefined);
    const memory = await inspectMemoryStore().catch(() => undefined);
    const tokenRecords = await listTokenRecords().catch(() => []);
    const today = new Date().toISOString().slice(0, 10);
    const todayRecords = tokenRecords.filter((record) => record.createdAt.slice(0, 10) === today);
    const todayInputTokens = todayRecords.reduce((sum, record) => sum + record.inputTokens, 0);
    const todayOutputTokens = todayRecords.reduce((sum, record) => sum + record.outputTokens, 0);
    const todayCostUsd = todayRecords.reduce((sum, record) => sum + (record.costUsd ?? 0), 0);
    const configuredMcp = new Set(Object.keys(config?.tools?.mcp?.servers ?? {}));
    const enabledPlugins = activePluginIds(config?.plugins);
    const personalPacks = ["daily-ops", "artifact-studio", "google-workspace", "google-calendar", "notion", "web-search"];
    const enabledPersonalPacks = personalPacks.filter((id) => enabledPlugins.has(id));
    const nextPersonalPack = personalPacks.find((id) => !enabledPlugins.has(id));
    const personalMcps = ["google-drive", "notion", "parallel-search", "browser"];
    const configuredPersonalMcps = personalMcps.filter((id) => configuredMcp.has(id));
    const nextMcp = personalMcps.find((id) => !configuredMcp.has(id));
    const channelCount = CHANNEL_SETUP_SPECS.length;
    const readyChannelCount = gateway ? CHANNEL_SETUP_SPECS.filter((spec) => channelReady(spec.id, gateway)).length : 0;
    const nextChannel = gateway ? CHANNEL_SETUP_SPECS.find((spec) => !channelReady(spec.id, gateway))?.id : undefined;
    const store = openSessionStore();
    try {
      const sessions = store.search({ limit: 1 });
      const sessionCount = sessions.shape === "browse" ? sessions.sessions.length : 0;
      const latestSession = sessions.shape === "browse" ? sessions.sessions[0] : undefined;
      console.log(`profile=${activeProfile()}`);
      console.log(`configured=${state.configured}`);
      console.log(`default_runtime=${state.configSummary?.defaultRuntime ?? "-"}`);
      console.log(`recent_sessions_visible=${sessionCount}`);
      console.log(`personal_agent packs_enabled=${enabledPersonalPacks.length}/${personalPacks.length} channels_ready=${readyChannelCount}/${channelCount} mcps_configured=${configuredPersonalMcps.length}/${personalMcps.length}`);
      console.log(`memory=backend=${memory?.index.backend ?? "unknown"} jsonl_objects=${memory?.jsonl.objectCount ?? 0} index_objects=${memory?.index.objectCount ?? 0} scopes=${memory?.index.scopeRowCount ?? 0} fresh=${memory?.index.fresh ?? false}`);
      console.log(`token_ledger=records=${tokenRecords.length} today_in=${todayInputTokens} today_out=${todayOutputTokens} today_cost_usd=${todayCostUsd.toFixed(4)}`);
      console.log(`sessions=backend=${store.backend} recent=${sessionCount} latest=${latestSession?.id ?? "-"}`);
      console.log(`next_personal_pack=${JSON.stringify(nextPersonalPack ? `muster plugins enable ${nextPersonalPack}` : "configured")}`);
      console.log(`next_channel=${JSON.stringify(gateway ? nextChannel ? `muster channels ready ${nextChannel}` : "configured" : "muster gateway init")}`);
      console.log(`next_mcp=${JSON.stringify(nextMcp ? `muster mcp install ${nextMcp}` : "configured")}`);
      console.log("start=muster dashboard start --port 7461");
    } finally {
      store.close();
    }
    return;
  }
  if (action === "start") {
    const port = readNumberFlag(args, "--port") ?? 7461;
    const host = readFlag(args, "--host") ?? "127.0.0.1";
    if (!["127.0.0.1", "localhost", "::1"].includes(host) && !args.includes("--insecure")) {
      throw new Error("Refusing to bind dashboard outside localhost without --insecure.");
    }
    const server = createServer(async (_request, response) => {
      try {
        const state = await buildCockpitState();
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(renderDashboardHtml(state));
      } catch (error) {
        response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        response.end(error instanceof Error ? error.message : String(error));
      }
    });
    await new Promise<void>((resolveStart) => server.listen(port, host, resolveStart));
    console.log(`dashboard=http://${host}:${port}`);
    console.log("stop with Ctrl-C");
    await new Promise<void>((resolveStop) => {
      process.on("SIGINT", () => {
        server.close(() => resolveStop());
      });
    });
    return;
  }
  throw new Error("Usage: muster dashboard status|start [--port 7461] [--host 127.0.0.1] [--insecure]");
}

function activePluginIds(policy: CapabilityPluginPolicy | undefined): Set<string> {
  const denied = new Set(policy?.deny ?? []);
  const active = new Set<string>();
  for (const id of policy?.allow ?? []) {
    if (!denied.has(id)) active.add(id);
  }
  for (const [id, entry] of Object.entries(policy?.entries ?? {})) {
    if (denied.has(id) || entry.enabled === false) {
      active.delete(id);
      continue;
    }
    active.add(id);
  }
  return active;
}

function safeConfigKey(value: string): string {
  const cleaned = value.trim().replace(/[^a-zA-Z0-9_.:-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!cleaned) throw new Error("Name cannot be empty.");
  return cleaned.slice(0, 80);
}

function renderDashboardHtml(state: Awaited<ReturnType<typeof buildCockpitState>>): string {
  const latest = state.episodes.at(-1);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Muster Dashboard</title>
  <style>
    body{font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;background:#101820;color:#f8fafc}
    main{max-width:960px;margin:0 auto;padding:32px}
    h1{font-size:32px;margin:0 0 8px}
    section{border-top:1px solid #334155;padding:20px 0}
    code,pre{background:#17212b;border:1px solid #334155;border-radius:6px;padding:2px 6px}
    .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}
    .tile{background:#17212b;border:1px solid #334155;border-radius:8px;padding:14px}
    .label{color:#93c5fd;font-size:12px;text-transform:uppercase}
  </style>
</head>
<body>
  <main>
    <h1>Muster Dashboard</h1>
    <p>Local read-only cockpit for this profile.</p>
    <section class="grid">
      <div class="tile"><div class="label">configured</div>${state.configured}</div>
      <div class="tile"><div class="label">runtime</div>${escapeHtml(state.configSummary?.defaultRuntime ?? "-")}</div>
      <div class="tile"><div class="label">providers</div>${state.configSummary?.providers.length ?? 0}</div>
      <div class="tile"><div class="label">candidates</div>${state.candidates.length}</div>
    </section>
    <section>
      <h2>Latest Run</h2>
      <pre>${escapeHtml(JSON.stringify(latest ?? { status: "none" }, null, 2))}</pre>
    </section>
  </main>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

async function context(args: string[]): Promise<void> {
  const subcommand = args[0];
  if (subcommand !== "graph") {
    throw new Error("Usage: muster context graph [episode-id] [--scope kind:id] [--latest]");
  }
  const episodes = await listEpisodes();
  if (!episodes.length) throw new Error("No episodes found. Run a prompt first.");
  const positional = stripFlags(args.slice(1), ["--scope"]).filter((arg) => arg !== "--latest");
  const requestedId = args.includes("--latest") ? undefined : positional[0];
  const episode = requestedId ? episodes.find((item) => item.id === requestedId) : episodes.at(-1);
  if (!episode) throw new Error(`Episode not found: ${requestedId}`);
  const scopeRaw = readFlag(args, "--scope");
  const graph = buildEpisodeContextGraph({
    episode,
    memories: await listMemory(),
    scope: scopeRaw ? parseMemoryScope(scopeRaw) : undefined
  });
  console.log(JSON.stringify(graph, null, 2));
}

async function memory(args: string[]): Promise<void> {
  const subcommand = args[0];
  if (subcommand === "status" || subcommand === "doctor") {
    let inspection = await inspectMemoryStore();
    printMemoryInspection(inspection);
    if (subcommand === "status" && args.includes("--probe")) await printMemoryLatencyProbe(args);
    if (subcommand === "doctor") {
      const failed = inspection.checks.filter((check) => check.status === "failed");
      const sourceFailed = failed.filter((check) => check.label === "jsonl_valid" || check.label === "duplicate_ids" || check.label === "zero_scope_objects");
      if (sourceFailed.length) {
        console.log(color("repair: fix JSONL source errors first; derived SQLite index can be safely rebuilt after source is valid.", "yellow"));
        process.exitCode = 1;
      } else {
        if (args.includes("--fix")) {
          const rebuilt = await rebuildMemoryIndex();
          inspection = rebuilt.inspection;
          console.log(color(`fix: rebuilt derived SQLite index removed_existing=${rebuilt.removedExisting}`, "green"));
          printMemoryInspection(inspection);
        }
        const remainingFailed = inspection.checks.filter((check) => check.status === "failed");
        if (remainingFailed.length) {
          console.log(color("repair: run `muster memory doctor --fix` to rebuild the derived SQLite index.", "yellow"));
          process.exitCode = 1;
          return;
        }
        if (args.includes("--probe")) await printMemoryLatencyProbe(args);
        const warnings = inspection.checks.filter((check) => check.status === "warning");
        console.log(color(warnings.length ? "doctor: passed with warnings" : "doctor: passed", warnings.length ? "yellow" : "green"));
      }
    }
    return;
  }
  if (subcommand === "add") {
    const summary = readFlag(args, "--summary");
    if (!summary) throw new Error('Usage: muster memory add --summary "..." --scope user:me --provenance manual');
    const scopes = readFlags(args, "--scope").map(parseMemoryScope);
    if (!scopes.length) {
      console.log("memory_add status=blocked reason=scope_required");
      console.log("why=memory must be scoped to prevent cross-user, cross-tenant, or cross-session recall leaks");
      console.log("examples=--scope user:me | --scope tenant:acme --scope user:dhairya | --scope session:<name>");
      console.log("next=muster memory add --summary \"...\" --scope user:me --provenance manual");
      process.exitCode = 1;
      return;
    }
    const provenance = readFlags(args, "--provenance");
    if (!provenance.length) {
      console.log("memory_add status=blocked reason=provenance_required");
      console.log("why=memory needs provenance so future recall can explain where the fact came from");
      console.log("examples=--provenance manual | --provenance conversation:<session> | --provenance import:<source>");
      console.log("next=muster memory add --summary \"...\" --scope user:me --provenance manual");
      process.exitCode = 1;
      return;
    }
    const confidenceRaw = readFlag(args, "--confidence");
    const object = await addMemory({
      kind: readFlag(args, "--kind"),
      summary,
      sourceUri: readFlag(args, "--source-uri"),
      confidence: confidenceRaw ? Number(confidenceRaw) : undefined,
      provenance,
      scopes,
      redactionState: readRedactionState(readFlag(args, "--redaction")),
      // Typing `muster memory add` IS the explicit request config.memory.policy
      // asks for, so this write survives an "ask"/"never" profile while the
      // agent's own auto-promotion does not. Never set this flag on a write the
      // user did not ask for by name.
      explicitUserRequest: true
    });
    printMemoryObject(object);
    return;
  }
  if (subcommand === "search") {
    const scopes = readFlags(args, "--scope").map(parseMemoryScope);
    const query = readFlag(args, "--query");
    if (args.includes("--explain")) {
      const receipt = await searchMemoryWithReceipts({
        query,
        scopes,
        includeGlobal: args.includes("--include-global"),
        limit: readNumberFlag(args, "--limit") ?? 20,
        match: "any",
      });
      console.log(`memory search query=${receipt.query || "(recent)"} backend=${receipt.backend} candidates=${receipt.candidateCount} recalled=${receipt.receipts.length} fallback=${receipt.fallbackUsed}`);
      for (const item of receipt.receipts) {
        console.log(`id=${item.memory.id} score=${item.score.toFixed(3)} reason=${item.reason}`);
        console.log(`summary=${item.memory.summary}`);
        console.log(`scopes=${item.memory.scopes.map((scope) => `${scope.kind}:${scope.id}`).join(",")}`);
        console.log(`provenance=${item.memory.provenance.join(",")}`);
        if (item.matchedTerms.length) console.log(`matched=${item.matchedTerms.join(",")}`);
      }
      return;
    }
    const records = await searchMemory({
      query,
      scopes,
      includeGlobal: args.includes("--include-global"),
      limit: readNumberFlag(args, "--limit") ?? undefined,
    });
    if (!records.length) {
      console.log("No memory matched the requested scope and query.");
      return;
    }
    for (const record of records.slice(0, 20)) printMemoryObject(record);
    return;
  }
  if (subcommand === "providers") {
    printMemoryProviderCatalog();
    return;
  }
  if (subcommand === "plan") {
    printMemoryProviderPlan(args);
    return;
  }
  if (subcommand === "promote") {
    const id = args[1];
    if (!id) throw new Error("Usage: muster memory promote <memory-id> --to tenant:acme [--allow-global]");
    const targetScopes = readFlags(args, "--to").map(parseMemoryScope);
    const object = await promoteMemory({ id, targetScopes, allowGlobal: args.includes("--allow-global") });
    const runId = `manual_promote_${Date.now()}`;
    await appendGoalLoopTurn(buildGoalLoopTurn({
      runId,
      episodeId: runId,
      createdAt: new Date().toISOString(),
      activeGoal: `promote memory ${id} to ${object.scopes.map(formatMemoryScope).join(",")}`,
      taskKind: "workflow",
      status: "completed",
      scopes: object.scopes,
      recallReceipt: {
        query: "",
        scopes: object.scopes,
        includeGlobal: false,
        backend: "sqlite-fts5",
        requestedLimit: 0,
        candidateCount: 0,
        receipts: [],
        fallbackUsed: false,
      },
      memoryWrite: promotedMemoryWrite(object, id),
    }));
    printMemoryObject(object);
    return;
  }
  if (subcommand === "hindsight") {
    await memoryHindsight(args.slice(1));
    return;
  }
  throw new Error("Usage: muster memory <add|search|status|doctor|providers|plan|promote|hindsight>");
}

async function memoryHindsight(args: string[]): Promise<void> {
  const action = args[0];
  const usage = 'Usage: muster memory hindsight <status|retain|recall|reflect> --scope user:me [--allow-global] (retain: --content "..." --provenance <src> [--tag t]; recall/reflect: --query "...")';
  if (action === "status") {
    let config: HindsightConfig;
    try {
      config = resolveHindsightConfig();
    } catch (error) {
      if (error instanceof HindsightConfigError) {
        console.log("hindsight status=not_configured");
        console.log(`next=set ${HINDSIGHT_URL_ENV} to a local Hindsight API base URL to opt in`);
        return;
      }
      throw error;
    }
    console.log(`hindsight status=configured url=${config.baseUrl} timeout_ms=${config.timeoutMs} auth=${config.apiKey ? "bearer" : "none"}`);
    return;
  }
  if (action !== "retain" && action !== "recall" && action !== "reflect") throw new Error(usage);
  const scopes = readFlags(args, "--scope").map(parseMemoryScope);
  if (scopes.length !== 1) throw new Error("hindsight requires exactly one --scope (bank is derived from it)");
  const scope = scopes[0];
  const auth = { scope, allowedScopes: scopes, allowGlobal: args.includes("--allow-global") };
  const client = createHindsightClient();
  if (action === "retain") {
    const content = readFlag(args, "--content");
    const provenance = readFlags(args, "--provenance");
    if (!content || !provenance.length) throw new Error(usage);
    const result = await client.retain({
      ...auth,
      items: [{ content, tags: readFlags(args, "--tag"), context: readFlag(args, "--context") }],
      provenance,
    });
    console.log(`hindsight_retain bank=${result.bankId} success=${result.success} items=${result.itemsCount} async=${result.isAsync}`);
    return;
  }
  const query = readFlag(args, "--query");
  if (!query) throw new Error(usage);
  const budgetRaw = readFlag(args, "--budget");
  const budget = budgetRaw === "low" || budgetRaw === "mid" || budgetRaw === "high" ? budgetRaw : undefined;
  if (action === "recall") {
    const result = await client.recall({ ...auth, query, budget });
    console.log(`hindsight_recall bank=${result.bankId} results=${result.results.length}`);
    for (const entry of result.results.slice(0, 20)) {
      console.log(`- [${entry.type ?? "memory"}${entry.score !== undefined ? ` ${entry.score.toFixed(3)}` : ""}] ${entry.text}`);
    }
    return;
  }
  const result = await client.reflect({ ...auth, query, budget });
  console.log(`hindsight_reflect bank=${result.bankId}`);
  console.log(result.text);
}

function memoryProviderCatalog(): BuiltinPluginCatalogEntry[] {
  return listBuiltinPlugins().filter((plugin) => plugin.category === "memory" || plugin.slot === "memory-provider");
}

function findMemoryProvider(id: string | undefined): BuiltinPluginCatalogEntry | undefined {
  if (!id) return undefined;
  return memoryProviderCatalog().find((plugin) => plugin.id === id || plugin.aliases?.includes(id));
}

function printMemoryProviderCatalog(): void {
  console.log("memory_provider\taction\trisk\tenv\tsetup");
  for (const provider of memoryProviderCatalog()) {
    const env = memoryProviderEnv(provider).join("|") || "-";
    const setup = provider.setup?.setupUrls?.[0] ?? "-";
    console.log(`${provider.id}\t${provider.actionability}\t${provider.risk}\t${env}\t${setup}`);
  }
  console.log("local_authority=sqlite-fts scoped_memory=true external_sync=opt-in");
}

function printMemoryProviderPlan(args: readonly string[]): void {
  const provider = findMemoryProvider(args[1]);
  if (!provider) {
    console.log("memory_provider_plan status=unknown");
    console.log(`available=${memoryProviderCatalog().map((entry) => entry.id).join(",")}`);
    console.log("usage=muster memory plan <memory-provider> --scope user:me [--mode export|sync]");
    return;
  }
  const mode = readFlag([...args], "--mode") ?? "export";
  if (mode !== "export" && mode !== "sync") throw new Error("--mode must be export or sync.");
  const scopes = readFlags([...args], "--scope").map(parseMemoryScope);
  const env = memoryProviderEnv(provider);
  const missingEnv = env.filter((name) => !process.env[name]);
  console.log(`memory_provider_plan=${provider.id} source=${provider.source} action=${provider.actionability} risk=${provider.risk}`);
  console.log(`mode=${mode} local_authority=sqlite-fts external_role=sync_target enabled=false`);
  console.log(`scope_required=true scopes=${scopes.length ? scopes.map(formatMemoryScope).join(",") : "-"}`);
  console.log(`export_filter=${scopes.length ? scopes.map(formatMemoryScope).join("|") : "blocked_until_scope_selected"}`);
  console.log(`missing_env=${missingEnv.join("|") || "-"}`);
  for (const url of provider.setup?.setupUrls ?? []) console.log(`setup_url=${url}`);
  console.log("guardrail=no_provider_bypass:true scope_isolation:true explicit_export:true approval_required:true secrets_printed:false");
  console.log("ledger=record exported_memory_ids, destination_provider, scope_filter, consent, and retrieval impact before enabling recurring sync");
  console.log(scopes.length ? "next=muster plugins setup " + provider.id : "next=choose at least one --scope before exporting or syncing memory");
  for (const note of provider.setup?.notes ?? []) console.log(`note=${note}`);
}

function memoryProviderEnv(provider: BuiltinPluginCatalogEntry): string[] {
  return [
    ...(provider.setup?.requiresEnv ?? []),
    ...(provider.setup?.requiresAnyEnv ?? []).flat(),
  ];
}

type MemoryInspection = Awaited<ReturnType<typeof inspectMemoryStore>>;
type MemoryLatencyProbe = Awaited<ReturnType<typeof probeMemorySearchLatency>>;

function printMemoryInspection(inspection: MemoryInspection): void {
  console.log("memory status");
  console.log(`jsonl=${inspection.memoryPath}`);
  console.log(`db=${inspection.dbPath}`);
  console.log(`jsonl_valid=${inspection.jsonl.valid} objects=${inspection.jsonl.objectCount} size=${inspection.jsonl.size} duplicates=${inspection.jsonl.duplicateIds} zero_scope=${inspection.jsonl.zeroScopeObjects} blocked=${inspection.jsonl.blockedObjects}`);
  if (inspection.jsonl.error) console.log(color(`jsonl_error=${inspection.jsonl.error}`, "red"));
  console.log(`index_exists=${inspection.index.exists} readable=${inspection.index.readable} initialized=${inspection.index.initialized} fresh=${inspection.index.fresh} backend=${inspection.index.backend ?? "-"} objects=${inspection.index.objectCount ?? 0} scope_rows=${inspection.index.scopeRowCount ?? 0} size=${inspection.index.size}`);
  if (inspection.index.error) console.log(color(`index_error=${inspection.index.error}`, "red"));
  if (inspection.scopes.length) {
    console.log("scopes");
    for (const { scope, count } of inspection.scopes) console.log(`  ${scope}\t${count}`);
  } else {
    console.log("scopes none");
  }
  console.log("checks");
  for (const check of inspection.checks) {
    const marker = check.status === "passed" ? "ok" : check.status === "warning" ? "warn" : "fail";
    const tone = check.status === "passed" ? "green" : check.status === "warning" ? "yellow" : "red";
    console.log(color(`  ${marker}\t${check.label}\t${check.detail}`, tone));
  }
}

async function printMemoryLatencyProbe(args: string[]): Promise<void> {
  const scopes = readFlags(args, "--scope").map(parseMemoryScope);
  if (!scopes.length) {
    console.log(color("probe skipped: pass --scope kind:id to measure scoped retrieval latency", "yellow"));
    return;
  }
  const probe = await probeMemorySearchLatency({
    query: readFlag(args, "--query") ?? "",
    scopes,
    includeGlobal: args.includes("--include-global"),
    limit: readNumberFlag(args, "--limit") ?? 5,
    candidateLimit: readNumberFlag(args, "--candidate-limit") ?? 50,
    runs: readNumberFlag(args, "--runs") ?? 25,
    match: "any",
  });
  printMemoryLatencyProbeResult(probe);
}

function printMemoryLatencyProbeResult(probe: MemoryLatencyProbe): void {
  console.log(`probe query=${probe.query || "(recent)"} runs=${probe.runs} backend=${probe.backend} recalled=${probe.recalledCount} candidates=${probe.candidateCount}`);
  console.log(`probe_latency p50_ms=${probe.p50Ms.toFixed(3)} p95_ms=${probe.p95Ms.toFixed(3)} min_ms=${probe.minMs.toFixed(3)} max_ms=${probe.maxMs.toFixed(3)}`);
}

async function goalCommand(args: string[]): Promise<void> {
  const action = args[0] ?? "status";
  if (action !== "status" && action !== "recent") {
    throw new Error("Usage: muster goal status [--limit 10]");
  }
  await printGoalStatus(readNumberFlag(args, "--limit") ?? 10);
}

async function tui(): Promise<void> {
  if (args[0] === "/tokens" || args[0] === "tokens") {
    console.log(renderTokenTable(await listTokenRecords(), readNumberFlag(args, "--limit") ?? 20));
    return;
  }
  if (args[0] === "ask") {
    const runtimeFlag = readFlag(args, "--runtime");
    const promptArgs = stripFlags(args.slice(1), ["--runtime", "--provider", "--model", "--thinking", "--effort", "--transport", "--session", "--session-dir", "--timeout-ms"]);
    const prompt = promptArgs.join(" ").trim();
    if (!prompt) throw new Error('Usage: muster tui ask "your prompt"');
    if (runtimeFlag === "pi") {
      await runPiPrompt(prompt, {
        renderTui: true,
        provider: readFlag(args, "--provider"),
        model: readFlag(args, "--model"),
        transport: readPiTransport(readFlag(args, "--transport")),
        sessionMode: readPiSessionMode(readFlag(args, "--session")),
        sessionDir: readFlag(args, "--session-dir"),
        timeoutMs: readNumberFlag(args, "--timeout-ms")
      });
      return;
    }
    if (runtimeFlag === "claude" || runtimeFlag === "claude-code") {
      await runClaudePrompt(prompt, {
        renderTui: true,
        model: readFlag(args, "--model"),
        effort: readClaudeEffort(readFlag(args, "--effort")),
        timeoutMs: readNumberFlag(args, "--timeout-ms")
      });
      return;
    }
    await runPrompt(prompt, { renderTui: true });
    return;
  }
  const state = await buildCockpitState();
  renderTuiState(state);
}

async function runPrompt(prompt: string, options: { readonly renderTui?: boolean } = {}): Promise<void> {
  const config = await loadConfig();
  const plan = planRun(config, { prompt, cwd: process.cwd() });
  const provider = config.providers[plan.route.provider];
  if (!provider) throw new Error(`Missing provider: ${plan.route.provider}`);

  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "You are Muster v0 running inside the terminal harness. Be concise, evidence-aware, and explicit about missing evidence."
    },
    { role: "user", content: prompt }
  ];

  if (!options.renderTui) console.log(`runtime=${plan.runtimeId} provider=${provider.id} model=${plan.route.model} task=${plan.taskKind}`);
  const started = Date.now();
  let responseText = "";
  let errorMessage: string | undefined;
  try {
    responseText = await completeChat({ provider, route: plan.route, messages });
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error);
  }
  const elapsedMs = Date.now() - started;
  const evidence: EvidenceRecord[] = [
    {
      kind: "model_response",
      label: "assistant response",
      status: responseText ? "observed" : "failed",
      detail: errorMessage ? `${elapsedMs}ms ${errorMessage}` : `${elapsedMs}ms`
    }
  ];
  await appendEpisode({
    id: plan.runId,
    createdAt: plan.createdAt,
    cwd: process.cwd(),
    prompt,
    taskKind: plan.taskKind,
    runtimeId: plan.runtimeId,
    providerId: provider.id,
    model: plan.route.model,
    reasoning: plan.route.reasoning,
    responseText: responseText || `Provider failed: ${errorMessage ?? "empty response"}`,
    evidence,
    outcome: { kind: responseText ? "completed" : "failed", detail: errorMessage }
  });
  if (options.renderTui) {
    renderTuiState(await buildCockpitState());
    return;
  }
  if (errorMessage) {
    throw new Error(errorMessage);
  }
  console.log("\n" + responseText + "\n");
  console.log(`episode=${plan.runId}`);
  console.log(`feedback: muster feedback ${plan.runId} --useful --correct`);
}

function renderTuiState(state: Awaited<ReturnType<typeof buildCockpitState>>): void {
  const episode = state.episodes.at(-1);
  const feedback = episode ? state.feedback.filter((item) => item.episodeId === episode.id).at(-1) : undefined;
  const candidates = (episode ? state.candidates.filter((item) => item.episodeId === episode.id) : state.candidates).slice(-5);
  const title = "Muster Terminal Cockpit";
  const width = Math.min(process.stdout.columns || 120, 140);
  console.log(boxLine("top", width));
  console.log(boxText(`${title}  source=${state.source} configured=${state.configured}`, width));
  console.log(boxLine("mid", width));
  console.log(boxText(`run=${episode?.id ?? "-"} runtime=${episode?.runtimeId ?? state.configSummary?.defaultRuntime ?? "-"} provider=${episode?.providerId ?? "-"} model=${episode?.model ?? "-"}`, width));
  console.log(boxText(`prompt=${truncate(episode?.prompt ?? "No run recorded yet. Use muster chat or seed an episode.", width - 10)}`, width));
  console.log(boxLine("mid", width));
  console.log(boxText("assistant", width));
  console.log(wrapText(episode?.responseText ?? "No assistant response recorded yet.", width).map((line) => boxText(line, width)).join("\n"));
  console.log(boxLine("mid", width));
  console.log(boxText(`feedback=${feedback?.adjudication ?? "none"} candidates=${candidates.length}`, width));
  for (const candidate of candidates) {
    console.log(boxText(`- ${candidate.kind}/${candidate.risk}: ${truncate(candidate.summary, width - 18)}`, width));
  }
  console.log(boxLine("mid", width));
  console.log(boxText("next: muster pi inspect | muster state export | muster feedback <episode> --useful --correct", width));
  console.log(boxLine("bottom", width));
}

async function pi(args: string[]): Promise<void> {
  const subcommand = args[0];
  if (subcommand === "tui") {
    const prompt = stripFlags(args.slice(1), ["--agent-dir", "--provider", "--model", "--thinking", "--tools", "--session", "--session-dir", "--session-id"]).join(" ").trim();
    const result = await runPiInteractive({
      prompt,
      cwd: process.cwd(),
      agentDir: readFlag(args, "--agent-dir"),
      provider: readFlag(args, "--provider"),
      model: readFlag(args, "--model"),
      thinking: readPiThinking(readFlag(args, "--thinking")),
      tools: readCsvFlag(args, "--tools"),
      sessionMode: readPiSessionMode(readFlag(args, "--session")),
      sessionDir: readFlag(args, "--session-dir"),
      sessionId: readFlag(args, "--session-id")
    });
    if (result.status === "blocked") {
      console.log(`runtime=pi transport=interactive package=${result.packageName}@${result.packageVersion}`);
      console.log(`status=${result.status}`);
      console.log(`reason=${result.reason}`);
      process.exitCode = 1;
    } else if (result.status === "failed") {
      console.log(`runtime=pi transport=interactive package=${result.packageName}@${result.packageVersion}`);
      console.log(`status=${result.status} exit_code=${result.exitCode ?? "-"} signal=${result.signal ?? "-"}`);
      process.exitCode = result.exitCode ?? 1;
    }
    return;
  }
  if (subcommand === "ask") {
    const prompt = stripFlags(args.slice(1), ["--provider", "--model", "--thinking", "--transport", "--session", "--session-dir", "--timeout-ms"]).join(" ").trim();
    if (!prompt) throw new Error('Usage: muster pi ask "prompt" [--provider openai] [--model gpt-4o-mini] [--transport sdk|cli] [--session memory|create|continue] [--session-dir path] [--timeout-ms 30000]');
    await runPiPrompt(prompt, {
      provider: readFlag(args, "--provider"),
      model: readFlag(args, "--model"),
      thinking: readPiThinking(readFlag(args, "--thinking")),
      transport: readPiTransport(readFlag(args, "--transport")),
      sessionMode: readPiSessionMode(readFlag(args, "--session")),
      sessionDir: readFlag(args, "--session-dir"),
      timeoutMs: readNumberFlag(args, "--timeout-ms")
    });
    return;
  }
  if (subcommand === "models") {
    const models = await listPiModels({
      provider: readFlag(args, "--provider"),
      agentDir: readFlag(args, "--agent-dir"),
      availableOnly: args.includes("--available")
    });
    if (!models.length) {
      console.log("No Pi models matched. Run without filters or login/configure a provider in Pi.");
      return;
    }
    console.log("provider\tmodel\tavailable\tauth\tapi\tthinking\tinput\tcontext\tmax_output\tname");
    for (const model of models) {
      console.log(
        [
          model.provider,
          model.id,
          model.available ? "yes" : "no",
          model.usingOAuth ? "oauth" : model.authSource ?? "-",
          model.api ?? "-",
          model.reasoning ? "yes" : "no",
          model.input.join(","),
          formatCompactNumber(model.contextWindow),
          formatCompactNumber(model.maxTokens),
          model.name
        ].join("\t")
      );
    }
    return;
  }
  if (subcommand === "tools") {
    const report = await inspectPiTools({
      agentDir: readFlag(args, "--agent-dir"),
      tools: readCsvFlag(args, "--tools")
    });
    console.log(`session=${report.sessionId}`);
    console.log(`cwd=${report.cwd}`);
    console.log(`agent_dir=${report.agentDir}`);
    console.log(`active_tools=${report.activeTools.join(",") || "-"}`);
    console.log("tool\tactive\tscope\torigin\tsource\tparameters\tdescription");
    for (const tool of report.tools) {
      console.log(
        [
          tool.name,
          tool.active ? "yes" : "no",
          tool.scope,
          tool.origin,
          tool.source,
          tool.parameterKeys.join(",") || "-",
          tool.description.replace(/\s+/g, " ").trim()
        ].join("\t")
      );
    }
    return;
  }
  if (subcommand === "commands") {
    const report = await inspectPiCommands({
      agentDir: readFlag(args, "--agent-dir"),
      tools: readCsvFlag(args, "--tools")
    });
    console.log(`session=${report.sessionId}`);
    console.log(`cwd=${report.cwd}`);
    console.log(`agent_dir=${report.agentDir}`);
    console.log("command\tsource\tscope\torigin\tpath\tdescription");
    for (const command of report.commands) {
      console.log(
        [
          command.invocation,
          command.source,
          command.scope,
          command.origin,
          command.sourcePath ?? "-",
          command.description.replace(/\s+/g, " ").trim() || "-"
        ].join("\t")
      );
    }
    return;
  }
  if (subcommand !== "inspect") {
    throw new Error("Usage: muster pi <inspect|models|tools|commands|tui|ask>");
  }
  const report = await inspectPiRuntime({ homeDir: readFlag(args, "--home") });
  console.log(`pi_root=${report.rootPath}`);
  console.log(`installed=${report.installed}`);
  console.log(`integration_mode=${report.integrationMode}`);
  console.log(`sdk_loadable=${report.sdkLoadable}`);
  console.log(`missing_sdk_exports=${report.missingSdkExports.length ? report.missingSdkExports.join(",") : "-"}`);
  console.log(`cli_available=${report.cliAvailable}`);
  console.log(`npx_available=${report.npxAvailable}`);
  console.log(`package=${report.packageName}@${report.packageVersion}`);
  console.log(`adapter_state=${report.adapterState}`);
  console.log(`config_files=${report.configFiles.length}`);
  for (const file of report.configFiles.slice(0, 20)) console.log(`config=${file}`);
  console.log(`workflow_files=${report.workflowFiles.length}`);
  for (const file of report.workflowFiles.slice(0, 20)) console.log(`workflow=${file}`);
  console.log("next_actions:");
  for (const action of report.nextActions) console.log(`- ${action}`);
}

async function runPiPrompt(
  prompt: string,
  options: {
    readonly renderTui?: boolean;
    readonly provider?: string;
    readonly model?: string;
    readonly thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
    readonly transport?: "sdk" | "cli";
    readonly sessionMode?: "memory" | "create" | "continue";
    readonly sessionDir?: string;
    readonly timeoutMs?: number;
  } = {}
): Promise<void> {
  const startedAt = new Date().toISOString();
  const runId = `pi_${Date.now()}`;
  const result = await runPiAgent({
    prompt,
    cwd: process.cwd(),
    provider: options.provider,
    model: options.model,
    thinking: options.thinking,
    timeoutMs: options.timeoutMs,
    tools: ["read", "grep", "find", "ls"],
    transport: options.transport,
    sessionMode: options.sessionMode,
    sessionDir: options.sessionDir
  });
  const failureText = result.errorMessage ?? result.stderr ?? "empty response";
  await appendEpisode({
    id: runId,
    createdAt: startedAt,
    cwd: process.cwd(),
    prompt,
    taskKind: "workflow",
    runtimeId: "pi",
    providerId: options.provider ?? "pi-default",
    model: options.model ?? "pi-default",
    reasoning: piThinkingToReasoning(options.thinking),
    responseText: result.stdout || `Pi failed: ${failureText}`,
    evidence: [
      {
        kind: "system_check",
        label: result.transport === "sdk" ? "pi embedded sdk invocation" : "pi cli diagnostic invocation",
        status: result.status === "completed" ? "passed" : "failed",
        detail:
          result.transport === "sdk"
            ? `${buildPiSessionLabel(result)} ${summarizePiEventTrace(result.eventTrace ?? [])} (${result.durationMs}ms)`
            : `${result.command} ${result.args?.slice(0, -1).join(" ")} (${result.durationMs}ms)`
      }
    ],
    outcome: { kind: result.status === "completed" ? "completed" : "failed", detail: result.errorMessage ?? result.stderr }
  });
  if (options.renderTui) {
    renderTuiState(await buildCockpitState());
    return;
  }
  console.log(`runtime=pi transport=${result.transport} package=${result.packageName}@${result.packageVersion}`);
  if (result.command) console.log(`command=${result.command}`);
  if (result.sessionId) console.log(`session=${result.sessionId}`);
  if (result.sessionMode) console.log(`session_mode=${result.sessionMode}`);
  if (result.sessionFile) console.log(`session_file=${result.sessionFile}`);
  if (result.sessionDir) console.log(`session_dir=${result.sessionDir}`);
  if (result.activeTools?.length) console.log(`active_tools=${result.activeTools.join(",")}`);
  if (result.eventTrace?.length) console.log(`event_trace=${summarizePiEventTrace(result.eventTrace)}`);
  console.log(`status=${result.status} duration_ms=${result.durationMs}`);
  if (result.stderr) console.log(`stderr=${result.stderr}`);
  console.log("\n" + (result.stdout || result.errorMessage || "Pi returned no output") + "\n");
  console.log(`episode=${runId}`);
  if (result.status === "failed") process.exitCode = 1;
}

/**
 * `muster codex` — pick up the Codex threads the user already has.
 *
 * Muster's codex backend resumes provider threads natively (`thread/resume`),
 * and a rollout file under CODEX_HOME carries exactly the id that call wants.
 * So "resume" is not a re-enactment: the transcript is imported so Muster's
 * search/memory/ledger see the history, and the NEXT turn continues the real
 * Codex thread with its own server-side context intact.
 */
async function codexCommand(args: string[]): Promise<void> {
  const subcommand = args[0];
  if (!subcommand || subcommand === "--help" || subcommand === "-h" || subcommand === "help") {
    printCodexHelp();
    return;
  }
  if (subcommand === "sessions" || subcommand === "list" || subcommand === "ls") {
    await codexSessionsCommand(args.slice(1));
    return;
  }
  if (subcommand === "resume") {
    await codexResumeCommand(args.slice(1));
    return;
  }
  throw new Error("Usage: muster codex <sessions|resume>");
}

function printCodexHelp(): void {
  console.log(`muster codex — resume the Codex threads you already have

Usage:
  muster codex sessions [--limit 20] [--since 7d] [--here] [--all] [--json]
  muster codex resume <thread-id-prefix> [--session name] [--import-only] [--here]

Options:
  --limit n        rows to list (default 20)
  --since 7d       only threads active within a span (7d, 24h, 30m) or since an ISO date
  --here           only threads whose workspace is the current directory
  --all            include multi-agent subagent threads (hidden by default)
  --json           machine-readable output
  --codex-home p   read a CODEX_HOME other than the default
  --session name   muster chat session to attach the resumed thread to
  --import-only    import the transcript without opening chat`);
}

interface CodexScanFlags {
  readonly codexHome?: string;
  readonly limit: number;
  readonly since?: string;
  readonly cwd?: string;
  readonly includeSubagents: boolean;
  readonly includeExecNoise: boolean;
}

function readCodexScanFlags(args: string[], defaultLimit: number): CodexScanFlags {
  const codexHome = readFlag(args, "--codex-home");
  const since = readFlag(args, "--since");
  return {
    ...(codexHome ? { codexHome } : {}),
    limit: readNumberFlag(args, "--limit") ?? defaultLimit,
    ...(since ? { since } : {}),
    ...(args.includes("--here") ? { cwd: process.cwd() } : {}),
    includeSubagents: args.includes("--all"),
    includeExecNoise: args.includes("--all"),
  };
}

async function codexSessionsCommand(args: string[]): Promise<void> {
  const flags = readCodexScanFlags(args, 20);
  const defaultHere = !args.includes("--here") && !args.includes("--all");
  let result = await discoverCodexSessions(defaultHere ? { ...flags, cwd: process.cwd() } : flags);
  let fellBackToAll = false;
  if (defaultHere && result.sessions.length === 0) {
    result = await discoverCodexSessions(flags);
    fellBackToAll = result.sessions.length > 0;
  }
  if (args.includes("--json")) {
    console.log(JSON.stringify(result, undefined, 2));
    return;
  }
  if (!result.sessions.length) {
    console.log(`No Codex sessions found under ${result.root}.`);
    if (result.subagentsHidden) console.log(`${result.subagentsHidden} subagent thread(s) hidden — pass --all to include them.`);
    return;
  }
  if (fellBackToAll) console.log(color("no Codex sessions match this directory; showing all", "dim"));
  // Two clocks, because one was read as the other: `age` is how old the THREAD
  // is (a month-old redis session), `active` is how long since its last turn.
  // A single "age" column made a long-lived thread that was touched minutes ago
  // read as one second old.
  console.log(color("id        project                age  active  turns  first message", "cyan"));
  for (const row of orderCodexSessionsByLineage(result.sessions)) {
    const session = row.session;
    // A fork is the same conversation continued: nest it under its root with ↳
    // instead of listing it as an unrelated (and confusingly adjacent) thread.
    const marker = row.depth > 0 ? `${"  ".repeat(row.depth - 1)}↳ ` : "";
    console.log([
      session.threadId.slice(0, 8),
      `${marker}${codexProjectLabel(session)}`.padEnd(21).slice(0, 21),
      formatCodexAge(session.startedAt).padStart(4),
      formatCodexAge(session.lastActivityAt).padStart(6),
      `${session.turnCount}${session.turnCountExact ? "" : "+"}`.padStart(6),
      trimToWidth(session.preview, 60),
    ].join(" "));
  }
  const notes = [
    `${result.sessions.length} of ${result.candidates} rollouts`,
    ...(result.subagentsHidden ? [`${result.subagentsHidden} subagent hidden (--all)`] : []),
    ...(result.execNoiseHidden ? [`${result.execNoiseHidden} automated run hidden (--all)`] : []),
    ...(result.skipped.length ? [`${result.skipped.length} unreadable`] : []),
  ];
  console.log(color(notes.join(" · "), "dim"));
  console.log(color("Resume one: muster codex resume <id>", "dim"));
}

function codexProjectLabel(session: CodexSessionSummary): string {
  const label = session.cwd.replace(/[/\\]+$/, "").split(/[/\\]/).pop();
  return label || "(unknown)";
}

/** A turn count is only a floor when the scan was truncated; say so with "+". */
function trimToWidth(value: string, width: number): string {
  const flattened = value.replace(/\s+/g, " ").trim();
  if (!flattened) return color("(no user message)", "dim");
  return flattened.length <= width ? flattened : `${flattened.slice(0, width - 1)}…`;
}

function formatCodexAge(iso: string, nowMs = Date.now()): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "?";
  const seconds = Math.max(0, Math.round((nowMs - at) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86_400)}d`;
}

/**
 * Replay a stored session's transcript into the terminal before the chat takes
 * over — a resumed thread must LOOK resumed, not empty. The provider already
 * has the context; this paints it for the human.
 */
function importedHistoryLines(storeSessionId: string, title: string): string[] {
  const store = openSessionStore();
  try {
    const all = store.loadActiveMessages(storeSessionId);
    if (!all.length) return [];
    // Owner-ratified 2026-08-29: history replays IN FULL — every message, no
    // "… N earlier" cap, no brief-message collapsing. Flow mode owns native
    // scrollback; the whole conversation belongs there.
    const users = all.filter((row) => row.role === "user").length;
    const assistants = all.filter((row) => row.role === "assistant").length;
    const lines = [color(`── history: ${title} · ${all.length} messages (${users} user · ${assistants} assistant) ──`, "dim")];
    for (const row of all) {
      const parts = row.content.split(/\r?\n/);
      if (row.role === "user") {
        lines.push(formatUserLine(parts[0] ?? ""), ...parts.slice(1).map((line) => `  ${line}`));
      } else if (row.role === "assistant") {
        lines.push(...formatAssistantBlock(row.content));
      } else {
        lines.push(...parts.map((line) => color(`  ${line}`, "dim")));
      }
    }
    lines.push(color("── end history ──", "dim"));
    return lines;
  } catch {
    // History is best-effort decoration; a store hiccup must never block the chat.
    return [];
  } finally {
    store.close();
  }
}

function namedChatHistoryLines(sessionName: string): string[] {
  const store = openSessionStore();
  try {
    const session = store.findOrCreateSession({ channel: "cli-chat", peer: sessionName, title: sessionName });
    return importedHistoryLines(session.id, sessionName);
  } finally {
    store.close();
  }
}

function appendImportedHistory(sink: MusterChatSink | undefined, storeSessionId: string, title: string): void {
  if (!sink) return;
  const lines = importedHistoryLines(storeSessionId, title);
  for (const line of lines) sink.appendLine(line);
}

function appendNamedChatHistory(sink: MusterChatSink | undefined, sessionName: string): void {
  if (!sink) return;
  const lines = namedChatHistoryLines(sessionName);
  for (const line of lines) sink.appendLine(line);
}

/** Discovery + import shared by the CLI command and the in-chat /codex command. */
async function importCodexThreadByPrefix(prefix: string, args: string[]): Promise<{
  session: CodexSessionSummary;
  imported: Awaited<ReturnType<typeof importCodexSession>>;
  chain: readonly CodexSessionSummary[];
}> {
  // A resume is deliberate, so scan wider than the listing default and include
  // subagents: the user may well want to continue a specific delegated thread.
  const flags = readCodexScanFlags(args, 200);
  const result = await discoverCodexSessions({ ...flags, includeSubagents: true, includeExecNoise: true });
  const match = matchCodexThread(result.sessions, prefix);
  if (match.kind === "none") {
    throw new Error(`No Codex session matches "${prefix}". Run: muster codex sessions --limit 50`);
  }
  if (match.kind === "ambiguous") {
    const ids = match.candidates.slice(0, 8).map((session) => `  ${session.threadId}  ${codexProjectLabel(session)}`).join("\n");
    throw new Error(`"${prefix}" matches ${match.candidates.length} Codex sessions:\n${ids}\nUse more characters.`);
  }
  const session = match.session;
  // A thread another Codex client wrote to seconds ago holds a live writer
  // lock — resuming it natively fails with a thread-store conflict. Refuse
  // up front with the fix instead of letting the first turn explode.
  const activeMs = Date.now() - Date.parse(session.lastActivityAt);
  if (!args.includes("--fork") && Number.isFinite(activeMs) && activeMs < 120_000) {
    throw new Error(
      `Codex thread ${session.threadId.slice(0, 8)} was active ${Math.round(activeMs / 1000)}s ago — it is likely open in the Codex desktop app or CLI.\n` +
      `Close it there and retry, or add --fork to continue as a copy on a fresh thread.`
    );
  }
  const store = openSessionStore();
  try {
    // A resume must show the thread's LATEST work: scan the whole rollout,
    // keep the newest messages when the cap overflows, and reconcile a stale
    // earlier import window instead of refusing (owner-reported: gigabyte
    // threads replayed "very old history" and never their last message).
    const imported = await importCodexSession(session, store, {
      maxBytes: Number.MAX_SAFE_INTEGER,
      keepTail: true,
      reconcileTail: true,
    });
    return { session, imported, chain: resolveCodexForkChain(result.sessions, session.threadId) };
  } finally {
    store.close();
  }
}

async function codexResumeCommand(args: string[]): Promise<void> {
  const prefix = stripFlags(args, ["--limit", "--since", "--codex-home", "--session"])
    .filter((arg) => !arg.startsWith("--"))[0];
  if (!prefix) throw new Error("Usage: muster codex resume <thread-id-prefix> [--session name]");
  const { session, imported, chain } = await importCodexThreadByPrefix(prefix, args);
  console.log(color(`codex thread ${session.threadId}`, "cyan"));
  console.log(`workspace   ${session.cwd || "(unknown)"}`);
  console.log(`model       ${session.model ?? "(unknown)"}`);
  console.log(`imported    ${imported.appended} new message(s), ${imported.alreadyPresent} already present → session ${imported.sessionId}`);
  if (imported.diverged) {
    console.log(color("stored transcript diverged from the rollout — nothing appended, history left intact", "yellow"));
  }
  if (imported.stats.truncated) {
    console.log(color(`rollout is larger than the import budget; imported the first ${(imported.stats.bytesRead / 1e6).toFixed(0)} MB`, "yellow"));
  }
  if (chain.length > 1) {
    console.log(`fork chain  ${chain.map((entry) => entry.threadId.slice(0, 8)).join(" → ")}`);
  }

  if (args.includes("--import-only")) {
    console.log(color("Imported only. Drop --import-only to continue the thread in chat.", "dim"));
    return;
  }

  const state: ChatState = {
    sessionName: safeChatSessionName(readFlag(args, "--session") ?? `codex-${session.threadId}`),
    scopes: [],
    speedMode: "session",
    startedAt: Date.now(),
    // --fork: keep the imported history but start a FRESH provider thread — the
    // path out of a thread-store writer conflict with another Codex client.
    ...(args.includes("--fork") ? {} : { resumeThreadId: session.threadId }),
    importedFromCodex: true,
    sessionWorkspaceCwd: session.cwd || process.cwd(),
    // Run in the thread's original workspace when it still exists — its context
    // is full of paths from that repo. A vanished dir falls back to cwd.
    ...(session.cwd && existsSync(session.cwd) ? { workspaceCwd: session.cwd } : {}),
    initialTranscriptLines: importedHistoryLines(imported.sessionId, `codex ${session.threadId.slice(0, 8)}`),
  };
  const mismatchWorkspace = session.cwd && session.cwd !== process.cwd() ? session.cwd : undefined;
  if (mismatchWorkspace && !args.includes("--here")) {
    const choice = await promptWorkspaceMismatch(mismatchWorkspace);
    if (choice === "home") state.workspaceCwd = mismatchWorkspace;
  } else if (mismatchWorkspace) {
    console.log(color(formatWorkspaceMismatchBanner(mismatchWorkspace), "dim"));
  }
  ensureNamedChatSession(state.sessionName, session.cwd || process.cwd());
  console.log(`chat        ${state.sessionName} (next turn continues the native Codex thread)`);
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    const prefix = state.workspaceCwd ? `cd ${state.workspaceCwd} && ` : "";
    console.log(color("No TTY. Continue this thread with:", "dim"));
    console.log(color(`  ${prefix}muster chat --session ${state.sessionName} --codex-thread ${session.threadId} "your next message"`, "dim"));
    return;
  }
  await interactiveChat(state);
}

async function claude(args: string[]): Promise<void> {
  const subcommand = args[0];
  if (subcommand === "inspect") {
    const report = await inspectClaudeCode();
    console.log(`available=${report.available}`);
    if (report.version) console.log(`version=${report.version}`);
    return;
  }
  if (subcommand === "ask") {
    const prompt = stripFlags(args.slice(1), ["--model", "--effort", "--timeout-ms"]).join(" ").trim();
    if (!prompt) throw new Error('Usage: muster claude ask "prompt" [--model sonnet] [--effort low] [--timeout-ms 30000]');
    await runClaudePrompt(prompt, {
      model: readFlag(args, "--model"),
      effort: readClaudeEffort(readFlag(args, "--effort")),
      timeoutMs: readNumberFlag(args, "--timeout-ms")
    });
    return;
  }
  throw new Error("Usage: muster claude <inspect|ask>");
}

async function runClaudePrompt(
  prompt: string,
  options: {
    readonly renderTui?: boolean;
    readonly model?: string;
    readonly effort?: "low" | "medium" | "high" | "xhigh" | "max";
    readonly timeoutMs?: number;
  } = {}
): Promise<void> {
  const startedAt = new Date().toISOString();
  const runId = `claude_${Date.now()}`;
  const result = await runClaudeCode({
    prompt,
    cwd: process.cwd(),
    model: options.model,
    effort: options.effort,
    timeoutMs: options.timeoutMs
  });
  const failureText = result.errorMessage ?? result.stderr ?? "empty response";
  await appendEpisode({
    id: runId,
    createdAt: startedAt,
    cwd: process.cwd(),
    prompt,
    taskKind: "workflow",
    runtimeId: "claude-code",
    providerId: "claude-code",
    model: options.model ?? "default",
    reasoning: claudeEffortToReasoning(options.effort),
    responseText: result.stdout || `Claude Code failed: ${failureText}`,
    evidence: [
      {
        kind: "system_check",
        label: "claude code invocation",
        status: result.status === "completed" ? "passed" : "failed",
        detail: `${result.command} ${result.args.slice(0, -1).join(" ")} (${result.durationMs}ms)`
      }
    ],
    outcome: { kind: result.status === "completed" ? "completed" : "failed", detail: result.errorMessage ?? result.stderr }
  });
  if (options.renderTui) {
    renderTuiState(await buildCockpitState());
    return;
  }
  console.log(`runtime=claude-code command=${result.command}`);
  console.log(`status=${result.status} duration_ms=${result.durationMs}`);
  if (result.stderr) console.log(`stderr=${result.stderr}`);
  console.log("\n" + (result.stdout || result.errorMessage || "Claude Code returned no output") + "\n");
  console.log(`episode=${runId}`);
  if (result.status === "failed") process.exitCode = 1;
}

async function provider(args: string[]): Promise<void> {
  const subcommand = args[0];
  if (subcommand === "presets") {
    console.log(renderProviderPresets());
    return;
  }
  if (subcommand === "add") {
    const presetId = args[1];
    if (!presetId) {
      throw new Error("Usage: muster provider add <preset> [--model X] [--api-key-env VAR] [--base-url URL]. List presets with: muster provider presets");
    }
    const added = await addPresetProvider(presetId, {
      model: readFlag(args, "--model"),
      apiKeyEnv: readFlag(args, "--api-key-env"),
      baseUrl: readFlag(args, "--base-url"),
    });
    console.log(`provider_added=${added.id}`);
    console.log(`kind=${added.kind}`);
    if (added.baseUrl) console.log(`base_url=${added.baseUrl}`);
    console.log(`default_model=${added.defaultModel}`);
    if (added.apiKeyEnv) {
      const keyPresent = Boolean(process.env[added.apiKeyEnv]);
      console.log(`api_key_env=${added.apiKeyEnv} (${keyPresent ? "set" : "NOT SET - export it before running"})`);
    } else {
      console.log("api_key_env=- (no key required)");
    }
    console.log(`try: muster run "hello" --runtime native --provider ${added.id}`);
    return;
  }
  if (subcommand === "list") {
    const config = await loadConfig();
    for (const item of Object.values(config.providers)) {
      console.log(
        `${item.id}\t${item.kind}\t${item.defaultModel}\t${item.baseUrl ?? "-"}\tapiKeyEnv=${item.apiKeyEnv ?? "-"}`
      );
    }
    return;
  }
  if (subcommand === "add-openai-compatible") {
    const [id, baseUrl, model] = args.slice(1);
    if (!id || !baseUrl || !model) {
      throw new Error("Usage: muster provider add-openai-compatible <id> <base-url> <model> [--api-key-env ENV_NAME]");
    }
    const apiKeyEnv = readFlag(args, "--api-key-env");
    await addOpenAICompatibleProvider({ id, baseUrl, defaultModel: model, apiKeyEnv });
    console.log(`provider_added=${id}`);
    console.log(`kind=openai-compatible`);
    console.log(`base_url=${baseUrl.replace(/\/$/, "")}`);
    console.log(`default_model=${model}`);
    if (apiKeyEnv) console.log(`api_key_env=${apiKeyEnv}`);
    return;
  }
  if (subcommand === "add-codex-cli") {
    const [id, model] = args.slice(1);
    if (!id || !model) {
      throw new Error("Usage: muster provider add-codex-cli <id> <model>");
    }
    await addCodexCliProvider({ id, defaultModel: model });
    console.log(`provider_added=${id}`);
    console.log("kind=codex-cli");
    console.log(`default_model=${model}`);
    return;
  }
  throw new Error("Usage: muster provider <list|add-openai-compatible|add-codex-cli>");
}

async function runtime(args: string[]): Promise<void> {
  const subcommand = args[0];
  if (subcommand === "doctor") {
    await printCodexDoctor(args);
    return;
  }
  if (subcommand !== "use-provider") {
    throw new Error("Usage: muster runtime use-provider <runtime-id> <provider-id> [model] | muster runtime doctor [--codex-command path]");
  }
  const [runtimeId, providerId, model] = args.slice(1);
  if (!runtimeId || !providerId) {
    throw new Error("Usage: muster runtime use-provider <runtime-id> <provider-id> [model]");
  }
  await setRuntimeProvider({ runtimeId, providerId, model });
  console.log(`runtime=${runtimeId}`);
  console.log(`provider=${providerId}`);
  if (model) console.log(`model=${model}`);
}

async function qaCommand(args: string[]): Promise<void> {
  const subcommand = args[0];
  if (subcommand === "suites" || subcommand === "list") {
    printQaSuites();
    return;
  }
  if (subcommand === "record") {
    await recordQaEvidence(args.slice(1));
    return;
  }
  if (subcommand === "run") {
    await runQaSuite(args.slice(1));
    return;
  }
  if (subcommand !== "scorecard") {
    throw new Error("Usage: muster qa scorecard [--codex-command path] [--latest-version x.y.z] [--evidence path] [--strict-release] | muster qa suites | muster qa run pty_tui|mcp_auth_failure|memory_retrieval_speed|provider_latency|channel_plugin_setup|frappe2_real_prompts|pack_readiness [--artifact-dir DIR] [--evidence path] | muster qa record <suite> --status passed|warning|failed|unknown --artifact-dir DIR --summary \"...\"");
  }
  await ensureDefaultConfig();
  const config = await loadConfig();
  const codex = await inspectCodexRuntime({
    command: readFlag(args, "--codex-command"),
    latestVersion: readFlag(args, "--latest-version"),
  });
  const providerReports = inspectProviderConfig(config);
  const evidencePath = resolve(process.cwd(), readFlag(args, "--evidence") ?? qaEvidencePath(process.cwd()));
  const storedEvidence = await loadQaEvidenceForScorecard(evidencePath);
  const scorecard = buildRuntimeMaturityScorecard({
    config,
    codex,
    providerReports,
    evidence: storedEvidence,
  });
  console.log(renderRuntimeMaturityScorecard(scorecard));
  const strictValidation = args.includes("--strict-release")
    ? validateStrictReleaseEvidence(storedEvidence)
    : undefined;
  if (strictValidation) console.log(renderStrictReleaseValidation(strictValidation));
  if (args.includes("--strict-release")) {
    const releaseReady = scorecard.status === "passed" && strictValidation?.status === "passed";
    console.log(`release_ready=${releaseReady ? "yes" : "no"} mode=strict reason=${releaseReady ? "scorecard_and_strict_release_passed" : "scorecard_or_strict_release_failed"}`);
  } else {
    console.log("release_ready=unknown mode=advisory reason=run_with_--strict-release_before_release_claims");
  }
  console.log(`evidence=${evidencePath}`);
  console.log(`required_suites=${REQUIRED_QA_SUITES.join(",")}`);
  if (providerReports.length) {
    console.log("providers:");
    for (const provider of providerReports) {
      console.log(`${provider.status.padEnd(7)} ${provider.id.padEnd(16)} ${provider.kind} model=${provider.defaultModel} ${provider.detail}`);
      if (provider.fix && provider.status !== "passed") console.log(`fix     ${provider.id.padEnd(16)} ${provider.fix}`);
    }
  }
  if (scorecard.status === "failed" || strictValidation?.status === "failed") process.exitCode = 1;
}

async function loadQaEvidenceForScorecard(evidencePath: string): Promise<Awaited<ReturnType<typeof loadRuntimeQaEvidence>>> {
  let pathStat: Awaited<ReturnType<typeof stat>> | undefined;
  try {
    pathStat = await stat(evidencePath);
  } catch {
    return loadRuntimeQaEvidence(process.cwd(), evidencePath);
  }
  if (!pathStat.isDirectory()) return loadRuntimeQaEvidence(process.cwd(), evidencePath);

  const scorecardPath = resolve(evidencePath, "scorecard.json");
  if (existsSync(scorecardPath)) return loadRuntimeQaEvidence(process.cwd(), scorecardPath);

  const manifestPath = resolve(evidencePath, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`Evidence directory is missing manifest.json or scorecard.json: ${evidencePath}`);
  }
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    readonly kind?: string;
    readonly suite?: string;
    readonly status?: RuntimeDoctorStatus;
    readonly summary?: string;
  };
  if (manifest.kind !== "muster-qa" || !manifest.suite) {
    throw new Error(`Evidence directory manifest is not a Muster QA artifact: ${manifestPath}`);
  }
  if (!(REQUIRED_QA_SUITES as readonly string[]).includes(manifest.suite)) {
    throw new Error(`Evidence directory suite is not required by the release scorecard: ${manifest.suite}`);
  }
  const suite = manifest.suite as RequiredQaSuiteId;
  return {
    suites: {
      [suite]: {
        status: manifest.status ?? "unknown",
        artifactDir: evidencePath,
        summary: manifest.summary ?? `${suite} artifact directory`,
      },
    },
  };
}

function printQaSuites(): void {
  console.log(`required_suites=${REQUIRED_QA_SUITES.join(",")}`);
  for (const suite of REQUIRED_QA_SUITES) {
    console.log(`suite=${suite} record="muster qa record ${suite} --status passed --artifact-dir <dir> --summary <summary>"`);
  }
}

async function recordQaEvidence(args: string[]): Promise<void> {
  const suite = args[0];
  if (!suite || !(REQUIRED_QA_SUITES as readonly string[]).includes(suite)) {
    throw new Error(`Usage: muster qa record <suite> --status passed|warning|failed|unknown --artifact-dir DIR --summary "..."\nvalid_suites=${REQUIRED_QA_SUITES.join(",")}`);
  }
  const status = readFlag(args, "--status") ?? "unknown";
  if (!["passed", "warning", "failed", "unknown"].includes(status)) {
    throw new Error("QA status must be one of: passed, warning, failed, unknown");
  }
  const artifactDir = readFlag(args, "--artifact-dir");
  const summary = readFlag(args, "--summary");
  const evidencePath = readFlag(args, "--evidence");
  const result = await recordRuntimeQaSuiteEvidence({
    suite: suite as RequiredQaSuiteId,
    status: status as RuntimeDoctorStatus,
    artifactDir: artifactDir ? resolve(process.cwd(), artifactDir) : undefined,
    summary,
    evidencePath: evidencePath ? resolve(process.cwd(), evidencePath) : undefined,
  });
  console.log(`qa_recorded suite=${suite} status=${result.suite.status}`);
  console.log(`evidence=${result.evidencePath}`);
  if (result.suite.artifactDir) console.log(`artifact=${result.suite.artifactDir}`);
  if (result.suite.summary) console.log(`summary=${result.suite.summary}`);
}

async function runQaSuite(args: string[]): Promise<void> {
  const suite = args[0];
  if (suite !== "pty_tui" && suite !== "mcp_auth_failure" && suite !== "memory_retrieval_speed" && suite !== "provider_latency" && suite !== "channel_plugin_setup" && suite !== "frappe2_real_prompts" && suite !== "pack_readiness") {
    throw new Error("Usage: muster qa run pty_tui|mcp_auth_failure|memory_retrieval_speed|provider_latency|channel_plugin_setup|frappe2_real_prompts|pack_readiness [--artifact-dir DIR] [--evidence path]");
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  if (suite === "frappe2_real_prompts") {
    await runFrappe2RealPromptsQaSuite(args, stamp);
    return;
  }
  if (suite === "pty_tui") {
    await runPtyTuiQaSuite(args, stamp);
    return;
  }
  if (suite === "channel_plugin_setup") {
    await runChannelPluginSetupQaSuite(args, stamp);
    return;
  }
  if (suite === "provider_latency") {
    await runProviderLatencyQaSuite(args, stamp);
    return;
  }
  if (suite === "memory_retrieval_speed") {
    await runMemoryQaSuite(args, stamp);
    return;
  }
  if (suite === "pack_readiness") {
    await runPackReadinessQaSuite(args, stamp);
    return;
  }
  await runMcpAuthQaSuite(args, stamp);
}

async function runFrappe2RealPromptsQaSuite(args: string[], stamp: string): Promise<void> {
  const artifactDir = resolve(process.cwd(), readFlag(args, "--artifact-dir") ?? join(dataDir(), "qa", `frappe2-real-prompts-${stamp}`));
  const result = await runFrappe2RealPromptsQa({
    artifactDir,
    host: readFlag(args, "--host") ?? "Frappe-2",
    sshCommand: readFlag(args, "--ssh-command") ?? "ssh",
    remoteCwd: readFlag(args, "--remote-cwd") ?? "/home/goblin/personal",
    remoteArtifactRoot: readFlag(args, "--remote-artifact-root") ?? "/home/goblin/muster-artifacts",
    timeoutMs: readNumberFlag(args, "--timeout-ms") ?? 120_000,
  });
  const evidencePath = readFlag(args, "--evidence");
  await recordRuntimeQaSuiteEvidence({
    suite: "frappe2_real_prompts",
    status: result.status,
    artifactDir: result.artifactDir,
    summary: result.summary,
    evidencePath: evidencePath ? resolve(process.cwd(), evidencePath) : undefined,
  });
  console.log(`qa_suite=${result.suite} status=${result.status}`);
  console.log(`artifact_dir=${result.artifactDir}`);
  console.log(`artifact_manifest=${result.manifestPath}`);
  console.log(`artifact_cases=${result.casesPath}`);
  console.log(`artifact_transcript=${result.transcriptPath}`);
  for (const testCase of result.cases) {
    console.log(`case=${testCase.id} status=${testCase.status} exit=${testCase.exitCode} duration_ms=${testCase.durationMs} summary=${testCase.summary}`);
  }
  if (result.status === "failed") process.exitCode = 1;
}

async function runPtyTuiQaSuite(args: string[], stamp: string): Promise<void> {
  const artifactDir = resolve(process.cwd(), readFlag(args, "--artifact-dir") ?? join(dataDir(), "qa", `pty-tui-${stamp}`));
  const result = await runPtyTuiQa({ artifactDir });
  const evidencePath = readFlag(args, "--evidence");
  await recordRuntimeQaSuiteEvidence({
    suite: "pty_tui",
    status: result.status,
    artifactDir: result.artifactDir,
    summary: result.summary,
    evidencePath: evidencePath ? resolve(process.cwd(), evidencePath) : undefined,
  });
  console.log(`qa_suite=${result.suite} status=${result.status}`);
  console.log(`artifact_dir=${result.artifactDir}`);
  console.log(`artifact_manifest=${result.manifestPath}`);
  console.log(`artifact_cases=${result.casesPath}`);
  console.log(`artifact_screens=${result.screensDir}`);
  for (const testCase of result.cases) {
    console.log(`case=${testCase.id} status=${testCase.status} summary=${testCase.summary}`);
    if (testCase.status === "failed" && typeof testCase.evidence.error === "string") {
      console.log(`case=${testCase.id} stage=${String(testCase.evidence.stage ?? "unknown")} detail=${testCase.evidence.error}`);
    }
  }
  if (result.status === "failed") process.exitCode = 1;
}

async function runChannelPluginSetupQaSuite(args: string[], stamp: string): Promise<void> {
  const artifactDir = resolve(process.cwd(), readFlag(args, "--artifact-dir") ?? join(dataDir(), "qa", `channel-plugin-setup-${stamp}`));
  const result = await runChannelPluginSetupQa({ artifactDir });
  const operatorCases = channelOperatorQaCases();
  const integrationActionCases = await integrationActionQaCases();
  const allCases = [...result.cases, ...operatorCases, ...integrationActionCases];
  const operatorCasesPath = join(artifactDir, "operator-cases.json");
  await writeFile(operatorCasesPath, `${JSON.stringify(operatorCases, null, 2)}\n`, "utf8");
  await writeFile(result.casesPath, `${allCases.map((testCase) => JSON.stringify(testCase)).join("\n")}\n`, "utf8");
  const originalManifest = JSON.parse(await readFile(result.manifestPath, "utf8")) as Record<string, unknown>;
  const status = allCases.every((testCase) => testCase.status === "passed") ? "passed" : "failed";
  const summary = status === "passed"
    ? `${result.summary}; channel operator plans, adapter simulations, and integration action loops verified`
    : "Channel/plugin setup QA found missing setup guidance, policy regressions, broken operator simulations, or broken integration action loops";
  await writeFile(result.manifestPath, `${JSON.stringify({
    ...originalManifest,
    status,
    summary,
    caseCount: allCases.length,
  }, null, 2)}\n`, "utf8");
  const evidencePath = readFlag(args, "--evidence");
  await recordRuntimeQaSuiteEvidence({
    suite: "channel_plugin_setup",
    status,
    artifactDir: result.artifactDir,
    summary,
    evidencePath: evidencePath ? resolve(process.cwd(), evidencePath) : undefined,
  });
  console.log(`qa_suite=${result.suite} status=${status}`);
  console.log(`artifact_dir=${result.artifactDir}`);
  console.log(`artifact_manifest=${result.manifestPath}`);
  console.log(`artifact_cases=${result.casesPath}`);
  console.log(`artifact_catalog=${result.catalogPath}`);
  console.log(`artifact_operator_cases=${operatorCasesPath}`);
  for (const testCase of allCases) {
    console.log(`case=${testCase.id} status=${testCase.status} summary=${testCase.summary}`);
  }
  if (status === "failed") process.exitCode = 1;
}

function channelOperatorQaCases(): Array<{ readonly id: string; readonly status: RuntimeDoctorStatus; readonly summary: string; readonly evidence: Record<string, unknown> }> {
  const config = { port: DEFAULT_GATEWAY_PORT } as GatewayConfig;
  const slack = requireChannelSpec("slack");
  const slackMissing = channelMissingSetup("slack", config);
  const slackPlanPassed = slack.route === "/v1/adapters/slack" &&
    channelAuthModeForConfig("slack", config) === "slack-socket-app-token" &&
    channelReplyMode("slack", config) === "direct_post" &&
    slackMissing.includes("slack.botToken") &&
    slackMissing.includes("slack.appToken");
  const simulations = (["telegram", "slack", "gchat", "discord", "whatsapp", "whatsapp-cloud", "teams", "web"] as const).map((channel) => {
    const simulated = simulateChannelInbound(channel, "qa local simulation");
    return {
      channel,
      ok: simulated.ok,
      surfaceId: simulated.ok ? simulated.surfaceId : undefined,
      reason: simulated.ok ? undefined : simulated.reason,
    };
  });
  const failedSimulations = simulations.filter((simulation) => !simulation.ok);
  return [
    {
      id: "operator_plan_slack",
      status: slackPlanPassed ? "passed" : "failed",
      summary: slackPlanPassed ? "Slack operator plan exposes route, auth mode, reply mode, and missing setup" : "Slack operator plan contract is incomplete",
      evidence: { route: slack.route, authMode: channelAuthModeForConfig("slack", config), replyMode: channelReplyMode("slack", config), missing: slackMissing },
    },
    {
      id: "operator_simulations",
      status: failedSimulations.length ? "failed" : "passed",
      summary: failedSimulations.length ? "one or more channel adapter simulations failed" : "all channel adapter simulations normalize local inbound messages",
      evidence: { simulations, failedSimulations },
    },
  ];
}

async function integrationActionQaCases(): Promise<Array<{ readonly id: string; readonly status: RuntimeDoctorStatus; readonly summary: string; readonly evidence: Record<string, unknown> }>> {
  await ensureDefaultConfig();
  const state: ChatState = {
    sessionName: DEFAULT_CHAT_SESSION,
    speedMode: "session",
    scopes: defaultChatScopes(),
  };
  const verifyCompletions = await chatTuiCompletions("/integrations verify tel", state);
  const sampleCompletions = await chatTuiCompletions("/integrations sample gch", state);
  const completionPassed = verifyCompletions.includes("telegram") && sampleCompletions.includes("gchat") && !verifyCompletions.includes("status");

  const gchatSample = await captureConsoleLines(() => runIntegrationAction("sample", "gchat"));
  const parallelVerify = await captureConsoleLines(() => runIntegrationAction("verify", "parallel-search"));
  const githubVerify = await captureConsoleLines(() => runIntegrationAction("verify", "github"));
  const expectedNext = [
    "integration_next=muster integrations setup gchat",
    "integration_next=muster integrations setup parallel-search",
    "integration_next=muster integrations setup github",
  ];
  const nextPassed = expectedNext.every((line, index) => [gchatSample, parallelVerify, githubVerify][index]?.includes(line));
  const actionEvidence = {
    gchatSample: gchatSample.filter((line) => line.startsWith("integration_action=") || line.startsWith("integration_next=") || line.startsWith("channel_simulation=")),
    parallelVerify: parallelVerify.filter((line) => line.startsWith("integration_action=") || line.startsWith("integration_next=") || line.startsWith("mcp=")),
    githubVerify: githubVerify.filter((line) => line.startsWith("integration_action=") || line.startsWith("integration_next=") || line.startsWith("plugin=") || line.startsWith("auth=")),
  };
  return [
    {
      id: "integration_action_completion",
      status: completionPassed ? "passed" : "failed",
      summary: completionPassed
        ? "integration action pickers return real workflow targets and exclude status/list pseudo-actions"
        : "integration action picker suggestions are incomplete or polluted by pseudo-actions",
      evidence: { verifyCompletions, sampleCompletions },
    },
    {
      id: "integration_action_next_steps",
      status: nextPassed ? "passed" : "failed",
      summary: nextPassed
        ? "channel, plugin, and MCP integration actions emit integration_next continuity commands"
        : "one or more integration action paths failed to emit a guided next step",
      evidence: actionEvidence,
    },
  ];
}

async function runMcpAuthQaSuite(args: string[], stamp: string): Promise<void> {
  const artifactDir = resolve(process.cwd(), readFlag(args, "--artifact-dir") ?? join(dataDir(), "qa", `mcp-auth-failure-${stamp}`));
  const result = await runMcpAuthFailureQa({ artifactDir });
  const evidencePath = readFlag(args, "--evidence");
  await recordRuntimeQaSuiteEvidence({
    suite: "mcp_auth_failure",
    status: result.status,
    artifactDir: result.artifactDir,
    summary: result.summary,
    evidencePath: evidencePath ? resolve(process.cwd(), evidencePath) : undefined,
  });
  console.log(`qa_suite=${result.suite} status=${result.status}`);
  console.log(`artifact_dir=${result.artifactDir}`);
  console.log(`artifact_manifest=${result.manifestPath}`);
  console.log(`artifact_cases=${result.casesPath}`);
  console.log(`artifact_server_log=${result.serverLogPath}`);
  for (const testCase of result.cases) {
    console.log(`case=${testCase.id} status=${testCase.status} summary=${testCase.summary}`);
  }
  if (result.status === "failed") process.exitCode = 1;
}

async function runProviderLatencyQaSuite(args: string[], stamp: string): Promise<void> {
  const artifactDir = resolve(process.cwd(), readFlag(args, "--artifact-dir") ?? join(dataDir(), "qa", `provider-latency-${stamp}`));
  const result = await runProviderLatencyQa({
    artifactDir,
    runs: readNumberFlag(args, "--runs") ?? 3,
    providerDelayMs: readNumberFlag(args, "--provider-delay-ms") ?? 25,
    maxMusterOverheadP50Ms: readNumberFlag(args, "--max-overhead-p50-ms") ?? 1_000,
  });
  const evidencePath = readFlag(args, "--evidence");
  await recordRuntimeQaSuiteEvidence({
    suite: "provider_latency",
    status: result.status,
    artifactDir: result.artifactDir,
    summary: result.summary,
    evidencePath: evidencePath ? resolve(process.cwd(), evidencePath) : undefined,
  });
  console.log(`qa_suite=${result.suite} status=${result.status}`);
  console.log(`artifact_dir=${result.artifactDir}`);
  console.log(`artifact_manifest=${result.manifestPath}`);
  console.log(`artifact_samples=${result.samplesPath}`);
  console.log(`artifact_server_log=${result.serverLogPath}`);
  console.log(`metric=p50_total_ms value=${result.metrics.p50TotalMs.toFixed(1)}`);
  console.log(`metric=p95_total_ms value=${result.metrics.p95TotalMs.toFixed(1)}`);
  console.log(`metric=p50_provider_ms value=${result.metrics.p50ProviderMs.toFixed(1)}`);
  console.log(`metric=p50_muster_overhead_ms value=${result.metrics.p50MusterOverheadMs.toFixed(1)}`);
  console.log(`metric=avg_provider_share_pct value=${result.metrics.avgProviderSharePct.toFixed(1)}`);
  console.log(`diagnosis=${result.metrics.diagnosis}`);
  for (const sample of result.samples) {
    console.log(`sample=${sample.index} status=${sample.status} total_ms=${sample.totalMs} provider_ms=${sample.providerMs} overhead_ms=${sample.musterOverheadMs}`);
  }
  if (result.status === "failed") process.exitCode = 1;
}

async function runMemoryQaSuite(args: string[], stamp: string): Promise<void> {
  const artifactDir = resolve(process.cwd(), readFlag(args, "--artifact-dir") ?? join(dataDir(), "qa", `memory-retrieval-speed-${stamp}`));
  const maxP95Ms = readNumberFlag(args, "--max-p95-ms") ?? 75;
  const result = await runMemoryRetrievalSpeedQa({ artifactDir, maxP95Ms });
  const evidencePath = readFlag(args, "--evidence");
  await recordRuntimeQaSuiteEvidence({
    suite: "memory_retrieval_speed",
    status: result.status,
    artifactDir: result.artifactDir,
    summary: result.summary,
    evidencePath: evidencePath ? resolve(process.cwd(), evidencePath) : undefined,
  });
  console.log(`qa_suite=${result.suite} status=${result.status}`);
  console.log(`artifact_dir=${result.artifactDir}`);
  console.log(`artifact_manifest=${result.manifestPath}`);
  console.log(`artifact_cases=${result.casesPath}`);
  console.log(`retrieval_manifest=${result.retrievalManifestPath}`);
  console.log(`probe=${result.probePath}`);
  console.log(`metric=recall@5 value=${result.retrieval.suite.recallAtK.toFixed(3)}`);
  console.log(`metric=mrr@5 value=${result.retrieval.suite.mrr.toFixed(3)}`);
  console.log(`metric=leakage_rate value=${result.retrieval.suite.leakageRate.toFixed(3)}`);
  console.log(`metric=stale_hit_rate value=${result.retrieval.suite.staleHitRate.toFixed(3)}`);
  console.log(`metric=probe_p95_ms value=${result.probe.p95Ms.toFixed(3)} max=${maxP95Ms}`);
  console.log(`backend=${result.probe.backend}`);
  for (const testCase of result.cases) {
    console.log(`case=${testCase.id} status=${testCase.status} summary=${testCase.summary}`);
  }
  if (result.status === "failed") process.exitCode = 1;
}

async function runPackReadinessQaSuite(args: string[], stamp: string): Promise<void> {
  const artifactDir = resolve(process.cwd(), readFlag(args, "--artifact-dir") ?? join(dataDir(), "qa", `pack-readiness-${stamp}`));
  const result = await runPackReadinessQa({ artifactDir });
  const evidencePath = readFlag(args, "--evidence");
  await recordRuntimeQaSuiteEvidence({
    suite: "pack_readiness",
    status: result.status,
    artifactDir: result.artifactDir,
    summary: result.summary,
    evidencePath: evidencePath ? resolve(process.cwd(), evidencePath) : undefined,
  });
  console.log(`qa_suite=${result.suite} status=${result.status}`);
  console.log(`artifact_dir=${result.artifactDir}`);
  console.log(`artifact_manifest=${result.manifestPath}`);
  console.log(`artifact_cases=${result.casesPath}`);
  console.log(`artifact_catalog=${result.catalogPath}`);
  for (const testCase of result.cases) {
    console.log(`case=${testCase.id} status=${testCase.status} summary=${testCase.summary}`);
  }
  if (result.status === "failed") process.exitCode = 1;
}

async function state(args: string[]): Promise<void> {
  const subcommand = args[0];
  if (subcommand === "show") {
    console.log(JSON.stringify(await buildCockpitState(), null, 2));
    return;
  }
  if (subcommand !== "export") {
    throw new Error("Usage: muster state <export|show> [--output path]");
  }
  const output = readFlag(args, "--output") ?? readFlag(args, "--out") ?? "packages/ui/public/muster-state.json";
  const target = resolve(process.cwd(), output);
  const statePayload = await buildCockpitState();
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(statePayload, null, 2)}\n`, "utf8");
  console.log(`state_exported=${target}`);
  console.log(`configured=${statePayload.configured}`);
  if (statePayload.configSummary) {
    console.log(`providers=${statePayload.configSummary.providers.length}`);
    console.log(`runtimes=${statePayload.configSummary.runtimes.length}`);
  }
  console.log(`episodes=${statePayload.episodes.length}`);
  console.log(`feedback=${statePayload.feedback.length}`);
  console.log(`candidates=${statePayload.candidates.length}`);
}

async function migrate(args: string[]): Promise<void> {
  const source = args[0];
  const dryRun = args.includes("--dry-run");
  const apply = args.includes("--apply");
  if (!isMigrationSource(source)) {
    throw new Error("Usage: muster migrate <openclaw|hermes|pi> --dry-run [--profile <name>] | muster migrate openclaw --apply --profile <name> --out <name>");
  }
  if (apply) {
    if (source !== "openclaw") {
      throw new Error(`--apply is only supported for openclaw. ${source} apply is not yet enabled (dry-run only).`);
    }
    const home = readFlag(args, "--home");
    const profile = readFlag(args, "--profile");
    const outProfile = readFlag(args, "--out");
    if (!profile || !outProfile) {
      throw new Error("Usage: muster migrate openclaw --apply --profile <name> --out <new-profile-name>");
    }
    const result = await applyOpenclawProfile({ homeDir: home ?? process.env.HOME ?? process.cwd(), profile, outProfile });
    console.log(`migration_source=openclaw`);
    console.log("mode=apply");
    console.log(`out_profile=${result.outProfile}`);
    console.log(`channel=${result.channel}`);
    console.log(`provider=${result.provider}`);
    console.log(`model=${result.model}`);
    console.log(`runtime=${result.runtime}`);
    console.log(`commands_migrated=${result.commandsMigrated}`);
    console.log(`skills_carried=${result.skillsCarried}`);
    console.log(`tools_carried=${result.toolsCarried}`);
    console.log(`plugins_carried=${result.pluginsCarried}`);
    console.log(`devices_carried=${result.devicesCarried}`);
    if (result.tokenEnvRef) console.log(`token_env_ref=${result.tokenEnvRef}`);
    // Make selectivity explicit: exactly ONE channel/profile was migrated.
    console.log(
      `excluded ${result.excludedChannels.length} other channel(s): ${result.excludedChannels.join(", ") || "none"}`
    );
    console.log(`excluded ${result.excludedAgents} agent(s)`);
    console.log(`config_path=${result.configPath}`);
    // No --runtime flag on purpose: passing one bypasses the profile's routing and
    // falls back to a default model. A flagless run uses the migrated config's
    // defaultRuntime (${result.runtime}) + model (${result.model}).
    console.log(`try: muster profile use ${result.outProfile} && muster run "hello"`);
    return;
  }
  if (!dryRun) {
    throw new Error("v0 only supports migration dry-runs. Apply is enabled only for: muster migrate openclaw --apply --profile <name> --out <name>.");
  }
  const home = readFlag(args, "--home");
  const profile = readFlag(args, "--profile");
  const report = await scanMigrationSource(source, { homeDir: home, profile });
  console.log(`migration_source=${report.source}`);
  console.log("mode=dry-run");
  console.log(`root=${report.rootPath}`);
  console.log(`exists=${report.exists}`);
  console.log(`assets=${report.assets.length}`);
  for (const asset of report.assets) {
    console.log(`asset kind=${asset.kind} mode=${asset.importMode} path=${asset.path}`);
  }
  if (report.missingPaths.length) {
    console.log("missing:");
    for (const missingPath of report.missingPaths) console.log(`- ${missingPath}`);
  }
  if (report.archiveOnlyNotes.length) {
    console.log("archive_only:");
    for (const note of report.archiveOnlyNotes) console.log(`- ${note}`);
  }
  console.log("next_actions:");
  for (const action of report.recommendedNextActions) console.log(`- ${action}`);
}

function isMigrationSource(source: string | undefined): source is MigrationSource {
  return source === "openclaw" || source === "hermes" || source === "pi";
}

async function checkModelsEndpoint(baseUrl: string): Promise<boolean> {
  try {
    const cleanBase = baseUrl.replace(/\/$/, "");
    const response = await fetch(`${cleanBase}/models`, {
      signal: AbortSignal.timeout(2000)
    });
    return response.ok;
  } catch {
    return false;
  }
}

function readFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  return args[index + 1];
}

function readFlags(args: string[], flag: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag && args[index + 1]) values.push(args[index + 1]);
  }
  return values;
}

function readCsvFlag(args: string[], flag: string): string[] | undefined {
  const value = readFlag(args, flag);
  if (!value) return undefined;
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length ? items : undefined;
}

function readNumberFlag(args: string[], flag: string): number | undefined {
  const raw = readFlag(args, flag);
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${flag} must be a positive number.`);
  return value;
}

function readNonNegativeNumberFlag(args: string[], flag: string): number | undefined {
  const raw = readFlag(args, flag);
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${flag} must be a non-negative number.`);
  return value;
}

function stripFlags(args: string[], flagsWithValues: string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (flagsWithValues.includes(arg)) {
      index += 1;
      continue;
    }
    result.push(arg);
  }
  return result;
}

function readRedactionState(value: string | undefined): "none" | "redacted" | "hashed" | "blocked" | undefined {
  if (!value) return undefined;
  if (value === "none" || value === "redacted" || value === "hashed" || value === "blocked") return value;
  throw new Error("Invalid redaction state. Use one of none, redacted, hashed, blocked.");
}

function readPiThinking(value: string | undefined): "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined {
  if (!value) return undefined;
  if (value === "off" || value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh") return value;
  throw new Error("Invalid Pi thinking level. Use off, minimal, low, medium, high, or xhigh.");
}

function readPiTransport(value: string | undefined): "sdk" | "cli" | undefined {
  if (!value) return undefined;
  if (value === "sdk" || value === "cli") return value;
  throw new Error("Invalid Pi transport. Use sdk or cli.");
}

function readNativeTransportFlag(args: string[]): "auto" | "warm" | "exec" | undefined {
  const value = readFlag(args, "--transport");
  if (!value) return undefined;
  if (value === "auto" || value === "warm" || value === "exec") return value;
  throw new Error("Invalid transport. Use auto, warm, or exec.");
}

function readPiSessionMode(value: string | undefined): "memory" | "create" | "continue" | undefined {
  if (!value) return undefined;
  if (value === "memory" || value === "create" || value === "continue") return value;
  throw new Error("Invalid Pi session mode. Use memory, create, or continue.");
}

function readClaudeEffort(value: string | undefined): "low" | "medium" | "high" | "xhigh" | "max" | undefined {
  if (!value) return undefined;
  if (value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max") return value;
  throw new Error("Invalid Claude Code effort. Use low, medium, high, xhigh, or max.");
}

function piThinkingToReasoning(value: ReturnType<typeof readPiThinking>): "none" | "low" | "medium" | "high" | undefined {
  if (!value) return undefined;
  if (value === "off") return "none";
  if (value === "minimal" || value === "low") return "low";
  if (value === "medium") return "medium";
  return "high";
}

function claudeEffortToReasoning(value: ReturnType<typeof readClaudeEffort>): "low" | "medium" | "high" | undefined {
  if (!value) return undefined;
  if (value === "low" || value === "medium") return value;
  return "high";
}

function printMemoryObject(object: Awaited<ReturnType<typeof addMemory>>): void {
  console.log(`id=${object.id}`);
  console.log(`kind=${object.kind}`);
  console.log(`summary=${object.summary}`);
  console.log(`confidence=${object.confidence}`);
  console.log(`redaction=${object.redactionState}`);
  console.log(`scopes=${object.scopes.map((scope) => `${scope.kind}:${scope.id}`).join(",")}`);
  console.log(`provenance=${object.provenance.join(",")}`);
  if (object.sourceUri) console.log(`source_uri=${object.sourceUri}`);
  if (object.links?.length) console.log(`links=${object.links.join(",")}`);
}

function boxLine(position: "top" | "mid" | "bottom", width: number): string {
  const left = position === "top" ? "+" : position === "bottom" ? "+" : "+";
  const right = "+";
  return `${left}${"-".repeat(Math.max(2, width - 2))}${right}`;
}

function boxText(text: string, width: number): string {
  const body = truncate(text, width - 4);
  return `| ${body.padEnd(Math.max(0, width - 4))} |`;
}

function wrapText(text: string, width: number): string[] {
  const max = Math.max(20, width - 4);
  const words = text.replace(/\s+/g, " ").trim().split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (stripAnsi(`${current} ${word}`.trim()).length > max) {
      if (current) lines.push(current);
      current = word;
    } else {
      current = `${current} ${word}`.trim();
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines.slice(0, 12) : [""];
}

function wrapPreserveLines(text: string, width: number): string[] {
  return text.split("\n").flatMap((line) => wrapText(line || " ", width));
}

function truncate(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, Math.max(0, length - 3))}...`;
}

type ColorName = "cyan" | "green" | "yellow" | "accent" | "highlight" | "selection" | "red" | "dim" | "periwinkle";

function color(value: string, name: ColorName): string {
  if (process.env.NO_COLOR || !process.stdout.isTTY) return value;
  // Warm, quiet palette matched to the chat surface (see chat-tui.ts): one
  // coral accent, amber for emphasis, warm grays for everything structural.
  const codes: Record<ColorName, string> = {
    cyan: "38;2;217;119;87",
    green: "38;2;158;186;134",
    yellow: "38;2;224;175;104",
    accent: "38;2;217;119;87",
    highlight: "38;2;224;175;104",
    selection: "30;48;2;217;119;87",
    red: "38;2;255;107;122",
    dim: "38;2;148;144;140",
    periwinkle: "38;2;176;184;248",
  };
  return `\u001b[${codes[name]}m${value}\u001b[0m`;
}

function formatCompactNumber(value: number): string {
  if (value >= 1_000_000) {
    const millions = value / 1_000_000;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
  }
  if (value >= 1_000) {
    const thousands = value / 1_000;
    return `${Number.isInteger(thousands) ? thousands : thousands.toFixed(1)}K`;
  }
  return String(value);
}

async function runCommand(commandArgs: string[]): Promise<void> {
  const flagNames = ["--runtime", "--provider", "--model", "--thinking", "--session", "--session-dir", "--scope", "--task-kind", "--timeout-ms", "--recall-limit", "--transport"];
  const prompt = stripFlags(commandArgs, flagNames).filter((value) => value !== "--sensitive").join(" ").trim();
  if (!prompt) throw new Error('Usage: muster run "prompt" [--runtime pi] [--provider X] [--model Y] [--transport auto|warm|exec] [--session memory|create|continue] [--scope user:me]');
  await requireWorkspace();
  const config = await loadConfig();
  const scopeFlags = commandArgs.flatMap((value, index) => (value === "--scope" && commandArgs[index + 1] ? [commandArgs[index + 1]] : []));
  const outcome = await executeRun(config, {
    prompt,
    runtime: readFlag(commandArgs, "--runtime"),
    provider: readFlag(commandArgs, "--provider"),
    model: readFlag(commandArgs, "--model"),
    thinking: readFlag(commandArgs, "--thinking") as never,
    sessionMode: readPiSessionMode(readFlag(commandArgs, "--session")),
    sessionDir: readFlag(commandArgs, "--session-dir"),
    taskKind: readFlag(commandArgs, "--task-kind") as never,
    sensitive: commandArgs.includes("--sensitive"),
    scopes: scopeFlags.length ? scopeFlags.map(parseMemoryScope) : undefined,
    recallLimit: readNumberFlag(commandArgs, "--recall-limit"),
    nativeTransport: readNativeTransportFlag(commandArgs),
    nativeSessionKeepAlive: false,
    timeoutMs: readNumberFlag(commandArgs, "--timeout-ms")
  });
  if (outcome.recalled.length) {
    console.log(`recalled ${outcome.recalled.length} scoped memories into context`);
  }
  if (outcome.fallbackUsed) {
    console.log(`governed fallback used: ${outcome.fallbackUsed} (recorded as evidence)`);
  }
  console.log(`run=${outcome.plan.runId} runtime=${outcome.plan.runtimeId} model=${outcome.episode.providerId}/${outcome.episode.model} task=${outcome.plan.taskKind} status=${outcome.episode.outcome?.kind}`);
  if (process.env.MUSTER_TIMINGS === "1" && outcome.timings) {
    console.log(formatTimingLine(outcome.timings));
  }
  console.log(`tokens in=${outcome.tokens.inputTokens}${outcome.tokens.estimated ? "~" : ""} out=${outcome.tokens.outputTokens}${outcome.tokens.estimated ? "~" : ""}${outcome.tokens.costUsd !== undefined ? ` cost=$${outcome.tokens.costUsd.toFixed(4)}` : ""}`);
  // Persist to the session store so `muster sessions` works from the CLI, not only the gateway.
  try {
    const store = openSessionStore();
    const session = store.createSession({ channel: "cli", peer: process.env.USER ?? "local", title: prompt.slice(0, 60) });
    store.appendMessage(session.id, "user", prompt);
    store.appendMessage(session.id, "assistant", outcome.episode.responseText);
    store.addUsage(session.id, outcome.tokens.inputTokens, outcome.tokens.outputTokens, outcome.tokens.costUsd ?? 0);
    store.close();
  } catch {
    // session store is best-effort from the CLI; never fail a run over it
  }
  if (outcome.episode.outcome?.kind === "failed") {
    throw new Error(outcome.episode.outcome.detail ?? "Run failed");
  }
  console.log("\n" + trimDanglingCodeFence(outcome.episode.responseText) + "\n");
}

interface LatencySample {
  readonly index: number;
  readonly status: string;
  readonly totalMs: number;
  readonly providerMs: number;
  readonly firstTokenMs?: number;
  readonly transport: string;
  readonly musterOverheadMs: number;
  readonly planningMs: number;
  readonly recallMs: number;
  readonly agentRulesMs: number;
  readonly skillSelectionMs: number;
  readonly promptBuildMs: number;
  readonly hookMs: number;
  readonly memoryWriteMs: number;
  readonly persistMs: number;
  readonly backendFallbackMs: number;
  readonly attempts: number;
  readonly providerSharePct: number;
  readonly responseChars: number;
}

async function latencyCommand(commandArgs: string[]): Promise<void> {
  const flagNames = ["--runs", "--runtime", "--provider", "--model", "--scope", "--timeout-ms", "--recall-limit", "--task-kind", "--workspace-dir", "--codex-home", "--transport"];
  const prompt = stripFlags(commandArgs, flagNames)
    .filter((value) => !["--sensitive", "--fast", "--no-agent-rules", "--write-memory"].includes(value))
    .join(" ")
    .trim();
  if (!prompt) throw new Error('Usage: muster latency "prompt" [--runs 3] [--runtime codex] [--provider X] [--model Y] [--transport auto|warm|exec] [--scope user:me] [--timeout-ms 30000]');

  const runs = Math.max(1, Math.min(20, readNumberFlag(commandArgs, "--runs") ?? 1));
  const scopes = readFlags(commandArgs, "--scope").map(parseMemoryScope);
  const config = await loadConfig();
  const samples: LatencySample[] = [];
  for (let index = 0; index < runs; index += 1) {
    const outcome = await executeRun(config, {
      prompt,
      runtime: readFlag(commandArgs, "--runtime"),
      provider: readFlag(commandArgs, "--provider"),
      model: readFlag(commandArgs, "--model"),
      taskKind: readFlag(commandArgs, "--task-kind") as never,
      sensitive: commandArgs.includes("--sensitive"),
      scopes: scopes.length ? scopes : undefined,
      recallLimit: readNumberFlag(commandArgs, "--recall-limit"),
      timeoutMs: readNumberFlag(commandArgs, "--timeout-ms"),
      workspaceDir: readFlag(commandArgs, "--workspace-dir"),
      codexHome: readFlag(commandArgs, "--codex-home"),
      nativeTransport: readNativeTransportFlag(commandArgs),
      skipAgentRules: commandArgs.includes("--no-agent-rules"),
      skipRecall: commandArgs.includes("--fast"),
      skipSkillSelection: commandArgs.includes("--fast"),
      skipMemoryWrite: commandArgs.includes("--fast") ? true : !commandArgs.includes("--write-memory"),
      nativeSession: true,
      nativeSessionKeepAlive: index < runs - 1,
      surfaceId: "latency-probe",
    });
    const timings = outcome.timings;
    if (!timings) throw new Error("Runtime did not return timing data.");
    const sample = latencySample(index + 1, outcome, timings);
    samples.push(sample);
    console.log(renderLatencySample(sample));
  }
  console.log(renderLatencySummary(samples));
}

function latencySample(index: number, outcome: RunOutcome, timings: NonNullable<RunOutcome["timings"]>): LatencySample {
  const musterOverheadMs = Math.max(0, timings.totalMs - timings.providerMs);
  return {
    index,
    status: outcome.episode.outcome?.kind ?? "unknown",
    totalMs: timings.totalMs,
    providerMs: timings.providerMs,
    firstTokenMs: timings.firstTokenMs,
    transport: timings.providerTransport ?? "unknown",
    musterOverheadMs,
    planningMs: timings.planningMs,
    recallMs: timings.recallMs,
    agentRulesMs: timings.agentRulesMs ?? 0,
    skillSelectionMs: timings.skillSelectionMs ?? 0,
    promptBuildMs: timings.promptBuildMs,
    hookMs: timings.hookMs ?? 0,
    memoryWriteMs: timings.memoryWriteMs ?? 0,
    persistMs: timings.persistMs,
    backendFallbackMs: timings.backendFallbackMs ?? 0,
    attempts: timings.providerAttemptCount ?? 0,
    providerSharePct: timings.totalMs > 0 ? (timings.providerMs / timings.totalMs) * 100 : 0,
    responseChars: outcome.episode.responseText.length,
  };
}

function renderLatencySample(sample: LatencySample): string {
  return [
    `latency_run=${sample.index}`,
    `status=${sample.status}`,
    `total_ms=${sample.totalMs}`,
    `provider_ms=${sample.providerMs}`,
    `transport=${sample.transport}`,
    `first_token_ms=${sample.firstTokenMs ?? "-"}`,
    `muster_overhead_ms=${sample.musterOverheadMs}`,
    `provider_share=${sample.providerSharePct.toFixed(1)}%`,
    `planning_ms=${sample.planningMs}`,
    `recall_ms=${sample.recallMs}`,
    `rules_ms=${sample.agentRulesMs}`,
    `skills_ms=${sample.skillSelectionMs}`,
    `prompt_ms=${sample.promptBuildMs}`,
    `hooks_ms=${sample.hookMs}`,
    `memory_write_ms=${sample.memoryWriteMs}`,
    `persist_ms=${sample.persistMs}`,
    `backend_fallback_ms=${sample.backendFallbackMs}`,
    `attempts=${sample.attempts}`,
    `response_chars=${sample.responseChars}`,
  ].join(" ");
}

function renderLatencySummary(samples: readonly LatencySample[]): string {
  const totals = samples.map((sample) => sample.totalMs).sort((a, b) => a - b);
  const providers = samples.map((sample) => sample.providerMs).sort((a, b) => a - b);
  const overheads = samples.map((sample) => sample.musterOverheadMs).sort((a, b) => a - b);
  const firstTokens = samples.flatMap((sample) => sample.firstTokenMs === undefined ? [] : [sample.firstTokenMs]).sort((a, b) => a - b);
  const avgProviderShare = samples.reduce((sum, sample) => sum + sample.providerSharePct, 0) / Math.max(1, samples.length);
  const transports = [...new Set(samples.map((sample) => sample.transport))].join(",");
  const diagnosis = avgProviderShare >= 80
    ? "provider_bound"
    : percentileNumber(overheads, 0.5) > 1000
      ? "muster_overhead_high"
      : "balanced_or_fast";
  const action = diagnosis === "provider_bound"
    ? "Provider dominates latency; compare --fast, model/provider picker choices, and native Codex auth/session health."
    : diagnosis === "muster_overhead_high"
      ? "Muster overhead is significant; inspect recall, prompt, and persistence timings before blaming the provider."
      : "No dominant overhead in this probe; repeat with --runs 3 and the same prompt under the live runtime.";
  return [
    `latency_summary runs=${samples.length}`,
    `p50_total_ms=${percentileNumber(totals, 0.5).toFixed(1)}`,
    `p95_total_ms=${percentileNumber(totals, 0.95).toFixed(1)}`,
    `p50_provider_ms=${percentileNumber(providers, 0.5).toFixed(1)}`,
    `p50_first_token_ms=${firstTokens.length ? percentileNumber(firstTokens, 0.5).toFixed(1) : "-"}`,
    `p50_muster_overhead_ms=${percentileNumber(overheads, 0.5).toFixed(1)}`,
    `avg_provider_share=${avgProviderShare.toFixed(1)}%`,
    `transports=${transports}`,
    `diagnosis=${diagnosis}`,
    `action="${action}"`,
  ].join(" ");
}

function percentileNumber(sortedValues: readonly number[], q: number): number {
  if (!sortedValues.length) return 0;
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil(sortedValues.length * q) - 1));
  return sortedValues[index] ?? 0;
}

async function tokensCommand(commandArgs: string[]): Promise<void> {
  console.log(renderTokenTable(await listTokenRecords(), readNumberFlag(commandArgs, "--limit") ?? 20));
}

async function printGoalStatus(limit: number): Promise<void> {
  const turns = await recentGoalLoopTurns(limit);
  if (!turns.length) {
    console.log("No goal-loop records yet.");
    return;
  }
  console.log(color("created\trun\tstatus\trecalled\tcandidates\tmemory\tfollow_up\tgoal", "cyan"));
  for (const turn of turns) {
    const follow = formatGoalFollowUp(turn.followUpRetrieval);
    const memory = formatGoalMemoryWrite(turn.memoryWrite);
    console.log([
      turn.createdAt.slice(0, 19),
      turn.runId,
      turn.status,
      String(turn.retrieval.recalledCount),
      String(turn.retrieval.candidateCount),
      memory,
      follow,
      turn.activeGoal.replace(/\s+/g, " ").slice(0, 80),
    ].join("\t"));
    for (const receipt of turn.retrieval.receipts.slice(0, 3)) {
      const matched = receipt.matchedTerms.length ? ` matched=${receipt.matchedTerms.join(",")}` : "";
      const provenance = receipt.provenance.length ? ` provenance=${receipt.provenance.slice(0, 3).join(",")}` : "";
      console.log(color(`  memory=${receipt.memoryId} score=${receipt.score.toFixed(3)} reason=${receipt.reason} scopes=${receipt.scopes.join(",")}${matched}${provenance}`, "dim"));
    }
  }
}

function formatGoalFollowUp(followUp: Awaited<ReturnType<typeof recentGoalLoopTurns>>[number]["followUpRetrieval"]): string {
  if (!followUp.needed) return "no";
  const reason = followUp.reason ?? "needed";
  const query = followUp.query?.replace(/\s+/g, " ").slice(0, 60);
  return query ? `${reason}:${query}` : reason;
}

function formatGoalMemoryWrite(memoryWrite: Awaited<ReturnType<typeof recentGoalLoopTurns>>[number]["memoryWrite"]): string {
  if (memoryWrite.status === "remembered") return `remembered:${memoryWrite.memoryId}`;
  if (memoryWrite.status === "promoted") return `promoted:${memoryWrite.memoryId} from:${memoryWrite.sourceMemoryId}`;
  return `${memoryWrite.status}:${memoryWrite.reason}`;
}

async function tracesCommand(commandArgs: string[]): Promise<void> {
  console.log(
    renderTracesTable(await listSpans(), {
      limit: readNumberFlag(commandArgs, "--limit") ?? 20,
      traceId: readFlag(commandArgs, "--trace")
    })
  );
}

async function profileCommand(commandArgs: string[]): Promise<void> {
  const [action, name] = commandArgs;
  if (action === "create" && name) {
    await createProfile(name);
    console.log(`Created profile: ${name}`);
    printProfileIsolationSummary(name);
    return;
  }
  if (action === "list") {
    const current = activeProfile();
    for (const profile of await listProfiles()) {
      console.log(`${profile === current ? "* " : "  "}${profile}`);
    }
    return;
  }
  if (action === "use" && name) {
    await useProfile(name);
    console.log(`Active profile: ${name}`);
    printProfileIsolationSummary(name);
    return;
  }
  if (action === "clone") {
    const [, from, to] = commandArgs;
    if (!from || !to) throw new Error("Usage: muster profile clone <from> <to>");
    await cloneProfile(from, to);
    console.log(`Cloned profile ${from} -> ${to} (history-free copy of config, memory, and skills)`);
    console.log("clone_excludes=sessions,episodes,tokens,provider-home");
    printProfileIsolationSummary(to);
    return;
  }
  if (action === "current" || action === undefined) {
    console.log(activeProfile());
    return;
  }
  throw new Error("Usage: muster profile create|list|use|current|clone [name]");
}

function printProfileIsolationSummary(profile: string): void {
  console.log(`profile_data=${profileDataDir(process.cwd(), profile)}`);
  console.log(`profile_config_read=${profileConfigPath(process.cwd(), profile)}`);
  console.log(`profile_config_write=${profileConfigWritePath(process.cwd(), profile)}`);
  console.log(`profile_home=${profileHomeDir(process.cwd(), profile)}`);
  console.log(`profile_workspace=${profileWorkspaceDir(process.cwd(), profile)}`);
  console.log("isolation=config,data,memory,skills,provider-home,workspace");
}

async function scheduleCommand(commandArgs: string[]): Promise<void> {
  const [action, ...rest] = commandArgs;
  if (action === "add") {
    const positional = stripFlags(rest, ["--profile"]);
    const [cron, ...promptParts] = positional;
    const prompt = promptParts.join(" ").trim();
    if (!cron || !prompt) throw new Error('Usage: muster schedule add "*/5 * * * *" "prompt" [--profile name]');
    const job = await addSchedule(cron, prompt, { profile: readFlag(rest, "--profile") });
    console.log(`Scheduled ${job.id}: [${job.cron}] ${job.prompt}`);
    console.log("No daemon runs these. Add to external cron: * * * * * cd <repo> && pnpm hc schedule run-due");
    return;
  }
  if (action === "list") {
    const jobs = await listSchedules();
    if (!jobs.length) {
      console.log("No schedules.");
      return;
    }
    for (const job of jobs) {
      console.log(`${job.id} [${job.cron}] ${job.prompt.slice(0, 60)} last=${job.lastRunAt ?? "-"} status=${job.lastStatus ?? "-"}`);
    }
    return;
  }
  if (action === "remove" && rest[0]) {
    const removed = await removeSchedule(rest[0]);
    console.log(removed ? `Removed ${rest[0]}` : `No schedule found: ${rest[0]}`);
    return;
  }
  if (action === "run-due") {
    const config = await loadConfig();
    const results = await runDueSchedules(async (job) =>
      executeScheduledJob(job, { config, registry: builtinFlowRegistry() })
    );
    if (!results.length) {
      console.log("No jobs due.");
      return;
    }
    for (const result of results) {
      console.log(`${result.job.id}: ${result.status}${result.runId ? ` run=${result.runId}` : ""}${result.detail ? ` (${result.detail})` : ""}`);
    }
    return;
  }
  throw new Error("Usage: muster schedule add|list|remove|run-due");
}

async function evolveCommand(commandArgs: string[]): Promise<void> {
  if (commandArgs[0] === "selfcheck") {
    const checks = await runHarnessChecks();
    for (const check of checks) {
      console.log(`[${check.status === "passed" ? "PASS" : "FAIL"}] ${check.id}: ${check.description}${check.detail ? ` - ${check.detail}` : ""}`);
    }
    if (checks.some((check) => check.status === "failed")) process.exitCode = 1;
    return;
  }
  const flagNames = ["--runtime", "--provider", "--model", "--iterations", "--session", "--timeout-ms"];
  const suitePath = stripFlags(commandArgs, flagNames)[0];
  if (!suitePath) throw new Error("Usage: muster evolve <suite.json> [--runtime pi] [--provider anthropic] [--model ...] [--iterations 2] | muster evolve selfcheck");
  const config = await loadConfig();
  const tasks = await loadEvolveSuite(resolve(suitePath));
  const report = await evolve(config, tasks, {
    runtime: readFlag(commandArgs, "--runtime"),
    provider: readFlag(commandArgs, "--provider"),
    model: readFlag(commandArgs, "--model"),
    sessionMode: readPiSessionMode(readFlag(commandArgs, "--session")),
    timeoutMs: readNumberFlag(commandArgs, "--timeout-ms"),
    maxIterations: readNumberFlag(commandArgs, "--iterations") ?? 2
  });
  console.log(renderEvolveReport(report));
  if (!report.converged || report.harnessChecks.some((check) => check.status === "failed")) process.exitCode = 1;
}

function builtinFlowRegistry(commandArgs: readonly string[] = []): FlowToolRegistry {
  const toolRegistry = createToolRegistry();
  registerBuiltinTools(toolRegistry);
  const toolsets = readFlags([...commandArgs], "--toolset");
  const allowedTools = new Set<string>();
  for (const toolset of toolsets.length ? toolsets : ["core"]) {
    for (const tool of toolRegistry.resolveToolset(toolset)) allowedTools.add(tool);
  }
  const registry = toolRegistry.toFlowRegistry({
    cwd: process.cwd(),
    allowCommands: readFlags([...commandArgs], "--allow-command"),
    allowHosts: readFlags([...commandArgs], "--allow-host"),
    toolAllowlist: [...allowedTools],
  }, [...allowedTools]);
  registry.echo = async (args) => args;
  return registry;
}

/** Built-in registry plus any capability packs requested via --pack <dir> (repeatable). */
async function flowRegistryWithPacks(commandArgs: string[]): Promise<FlowToolRegistry> {
  const registry = builtinFlowRegistry(commandArgs);
  const pluginPolicy = await loadPluginPolicy();
  const slotClaims: Record<string, string> = {};
  for (const packDir of readFlags(commandArgs, "--pack")) {
    const loaded = await loadCapabilityPack(resolveWorkspacePath(packDir), {
      registry,
      allowHighRisk: commandArgs.includes("--allow-high-risk"),
      pluginPolicy,
      slotClaims
    });
    console.log(`pack_loaded=${loaded.manifest.id} tools=${loaded.toolNames.join(",")}`);
  }
  return registry;
}

function resolveWorkspacePath(input: string): string {
  if (input.startsWith("/")) return input;
  const candidates = [
    resolve(process.cwd(), input),
    resolve(process.cwd(), "..", input),
    resolve(process.cwd(), "..", "..", input),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

async function loadPluginPolicy(): Promise<CapabilityPluginPolicy | undefined> {
  try {
    return (await loadConfig(process.cwd())).plugins;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function printFlowEvent(event: FlowRunEvent): void {
  if (event.type === "run_started") console.log(`run=${event.runId} flow=${event.flowId}`);
  if (event.type === "step_started") console.log(`step=${event.stepId} status=started`);
  if (event.type === "step_completed") console.log(`step=${event.stepId} status=completed${event.tokensUsed ? ` tokens=~${event.tokensUsed}` : ""}`);
  if (event.type === "step_failed") console.log(`step=${event.stepId} status=failed error=${event.error}`);
  if (event.type === "step_skipped") console.log(`step=${event.stepId} status=skipped reason=${event.reason}`);
  if (event.type === "gate_pending") console.log(`step=${event.stepId} status=gate_pending${event.expiresAt ? ` expires=${event.expiresAt}` : ""}`);
  if (event.type === "gate_resolved") console.log(`step=${event.stepId} status=${event.approved ? "approved" : "rejected"}`);
  if (event.type === "run_finished") console.log(`run_status=${event.status}`);
}

function printFlowRunResult(result: Awaited<ReturnType<typeof runFlow>>): void {
  if (result.status === "awaiting_approval") {
    console.log(`flow_run=${result.runId} status=awaiting_approval gate=${result.gateId}`);
    console.log("--- gate shows ---");
    console.log(typeof result.show === "string" ? result.show : JSON.stringify(result.show, null, 2));
    console.log("------------------");
    console.log(`approve: muster flow approve ${result.runId}`);
    console.log(`reject:  muster flow reject ${result.runId}`);
    return;
  }
  console.log(`flow_run=${result.runId} status=${result.status}`);
  if (result.error) console.log(`error=${result.error}`);
  if (result.status === "failed" || result.status === "budget_exceeded" || result.status === "expired") process.exitCode = 1;
}

function padCell(value: string, width: number): string {
  return value.length >= width ? value.slice(0, width) : value + " ".repeat(width - value.length);
}

function renderFlowRunsTable(runs: readonly FlowRunState[]): string {
  if (!runs.length) return "No flow runs yet. Start one with: muster flow run <id>";
  const lines: string[] = [];
  const header = `${padCell("run", 18)} ${padCell("flow", 24)} ${padCell("status", 18)} ${padCell("steps", 6)} ${padCell("tokens", 8)} ${padCell("started", 24)}`;
  lines.push(header);
  lines.push("-".repeat(header.length));
  for (const run of runs) {
    const completedSteps = run.events.filter((event) => event.type === "step_completed").length;
    lines.push([
      padCell(run.runId, 18),
      padCell(run.flowId, 24),
      padCell(run.status, 18),
      padCell(`${completedSteps}/${run.flow.steps.length}`, 6),
      padCell(run.tokensUsed ? `~${run.tokensUsed}` : "-", 8),
      padCell(run.startedAt, 24)
    ].join(" "));
  }
  return lines.join("\n");
}

async function flowCommand(commandArgs: string[]): Promise<void> {
  const [action, target] = commandArgs;
  if (action === "save") {
    if (!target) throw new Error("Usage: muster flow save <file.json>");
    const flow = parseFlow(await readFile(resolve(process.cwd(), target), "utf8"));
    const saved = await saveFlow(flow);
    console.log(`flow=${flow.id} steps=${flow.steps.length}`);
    console.log(`saved=${saved}`);
    console.log(`next: muster flow check ${flow.id}`);
    return;
  }
  if (action === "list") {
    const flows = await listFlows();
    if (!flows.length) {
      console.log("No flows saved yet. Add one with: muster flow save <file.json>");
      return;
    }
    const header = `${padCell("flow", 28)} ${padCell("steps", 6)} ${padCell("budget", 8)} description`;
    console.log(header);
    console.log("-".repeat(Math.max(header.length, 60)));
    for (const flow of flows) {
      console.log(`${padCell(flow.id, 28)} ${padCell(String(flow.steps.length), 6)} ${padCell(flow.budgetTokens ? String(flow.budgetTokens) : "-", 8)} ${flow.description ?? "-"}`);
    }
    return;
  }
  if (action === "check") {
    if (!target) throw new Error("Usage: muster flow check <id>");
    const flow = await loadFlow(target);
    const report = preflightFlow(flow, await flowRegistryWithPacks(commandArgs), await loadConfig());
    console.log(`flow=${flow.id} preflight=${report.ok ? "ok" : "failed"}`);
    for (const issue of report.issues) console.log(`- ${issue.message}`);
    if (!report.ok) process.exitCode = 1;
    return;
  }
  if (action === "run") {
    if (!target) throw new Error("Usage: muster flow run <id>");
    const flow = await loadFlow(target);
    const result = await runFlow(flow, {
      config: await loadConfig(),
      registry: await flowRegistryWithPacks(commandArgs),
      cwd: process.cwd(),
      onEvent: printFlowEvent
    });
    printFlowRunResult(result);
    return;
  }
  if (action === "runs") {
    console.log(renderFlowRunsTable(await listFlowRuns()));
    return;
  }
  if (action === "show") {
    if (!target) throw new Error("Usage: muster flow show <run-id>");
    const run = await getFlowRun(target);
    console.log(`flow_run=${run.runId} flow=${run.flowId} status=${run.status} tokens=${run.tokensUsed ? `~${run.tokensUsed}` : "-"}`);
    console.log(`file=${flowRunPath(run.runId)}`);
    console.log(`definition=${flowPath(run.flowId)}`);
    for (const event of run.events) printFlowEvent(event);
    if (run.pendingGate) {
      console.log("--- pending gate shows ---");
      console.log(typeof run.pendingGate.show === "string" ? run.pendingGate.show : JSON.stringify(run.pendingGate.show, null, 2));
    }
    return;
  }
  if (action === "approve" || action === "reject") {
    if (!target) throw new Error(`Usage: muster flow ${action} <run-id>`);
    const result = await resumeFlow(target, {
      approve: action === "approve",
      config: await loadConfig(),
      registry: await flowRegistryWithPacks(commandArgs),
      cwd: process.cwd(),
      onEvent: printFlowEvent
    });
    printFlowRunResult(result);
    return;
  }
  if (action === "replay") {
    if (!target) throw new Error("Usage: muster flow replay <run-id> [--live-agents]");
    const result = await replayFlowRun(target, {
      config: await loadConfig(),
      registry: await flowRegistryWithPacks(commandArgs),
      cwd: process.cwd(),
      liveAgents: commandArgs.includes("--live-agents"),
      onEvent: printFlowEvent
    });
    console.log(`replay_of=${target}`);
    printFlowRunResult(result);
    return;
  }
  if (action === "diff") {
    const other = commandArgs[2];
    if (!target || !other) throw new Error("Usage: muster flow diff <run-id-a> <run-id-b>");
    const diff = await diffFlowRuns(target, other);
    console.log(`diff a=${diff.runIdA} b=${diff.runIdB} identical=${diff.identical}`);
    for (const difference of diff.differences) {
      console.log(`step=${difference.stepId} field=${difference.field}`);
      console.log(`  a=${typeof difference.a === "string" ? difference.a : JSON.stringify(difference.a)}`);
      console.log(`  b=${typeof difference.b === "string" ? difference.b : JSON.stringify(difference.b)}`);
    }
    if (!diff.identical) process.exitCode = 1;
    return;
  }
  if (action === "loop") {
    const cron = readFlag(commandArgs, "--cron");
    if (!target || !cron) throw new Error('Usage: muster flow loop <flow-id> --cron "0 9 * * 1"');
    const job = await scheduleFlowLoop(target, cron);
    console.log(`Scheduled ${job.id}: [${job.cron}] flow=${job.flowId}`);
    console.log("No daemon runs these. Add to external cron: * * * * * cd <repo> && pnpm hc schedule run-due");
    return;
  }
  throw new Error("Usage: muster flow <save|list|check|run|runs|show|approve|reject|replay|diff|loop>");
}

/**
 * `muster status`: one-screen mission-control overview of the fleet —
 * active profile, providers, episodes, tokens spent today, schedules due,
 * flows pending approval gates, and store integrity. All local reads.
 */
async function statusCommand(commandArgs: readonly string[] = []): Promise<void> {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);

  let providersLine = "no config (run: muster doctor --fix)";
  let runtimeLine = "-";
  try {
    const config = await loadConfig();
    const providers = Object.values(config.providers);
    providersLine = `${providers.length} configured (${providers.map((provider) => provider.id).join(", ") || "none"})`;
    runtimeLine = config.routing.defaultRuntime;
  } catch {
    // keep the hint; status must never crash on a fresh workspace
  }

  const episodes = await listEpisodes();
  const lastEpisode = episodes.at(-1);
  const todayEpisodes = episodes.filter((episode) => episode.createdAt.startsWith(today));

  const tokenRecords = await listTokenRecords();
  const todayRecords = tokenRecords.filter((record) => record.createdAt.startsWith(today));
  const tokensToday = todayRecords.reduce((sum, record) => sum + record.inputTokens + record.outputTokens, 0);
  const costToday = todayRecords.reduce((sum, record) => sum + (record.costUsd ?? 0), 0);

  const schedules = await listSchedules();
  const currentMinute = new Date(now);
  currentMinute.setSeconds(0, 0);
  const dueSchedules = schedules.filter((job) => {
    if (job.disabled) return false;
    if (!parseCron(job.cron).matches(now)) return false;
    return !(job.lastRunAt && new Date(job.lastRunAt) >= currentMinute);
  });

  const flowRuns = await listFlowRuns();
  const pendingGates = flowRuns.filter((run) => run.status === "awaiting_approval");

  const integrity = await verifyIntegrity();

  const runPhrase = `${todayEpisodes.length} ${todayEpisodes.length === 1 ? "run" : "runs"} today`;
  const lastPhrase = lastEpisode ? `last ${formatHumanAge(lastEpisode.createdAt, now)} ago` : "no previous runs";
  console.log(`${runPhrase}, ${lastPhrase} · $${costToday.toFixed(2)} · verify ${integrity.ok ? "OK" : `${integrity.issues.length} issues`}`);
  console.log(`Profile ${activeProfile()} · ${providersLine} · runtime ${runtimeLine}`);
  console.log(`${schedules.length} schedules, ${dueSchedules.length} due · ${pendingGates.length} flows waiting for approval`);

  if (commandArgs.includes("--verbose")) {
    console.log(`as of ${now.toISOString()}`);
    console.log(`tokens today ${tokensToday} across ${todayRecords.length} token records`);
    if (lastEpisode) console.log(`last run ${lastEpisode.id} at ${lastEpisode.createdAt}`);
    for (const run of pendingGates) {
      console.log(`approve muster flow approve ${run.runId} · reject muster flow reject ${run.runId}`);
    }
  }
}

function formatHumanAge(value: string, now = new Date()): string {
  const elapsedMs = Math.max(0, now.getTime() - new Date(value).getTime());
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

async function verifyCommand(): Promise<void> {
  const report = await verifyIntegrity();
  console.log(renderIntegrityReport(report));
  if (!report.ok) process.exitCode = 1;
}

async function gatewayCommand(commandArgs: string[]): Promise<void> {
  const [action] = commandArgs;
  if (action === "init") {
    const result = await initGatewayConfig();
    console.log(`gateway_config=${result.path} (${result.created ? "created" : "already exists"})`);
    if (commandArgs.includes("--show-token")) {
      console.log(`token=${result.config.token}`);
    } else {
      console.log("token=<redacted> (stored in gateway_config; rerun with --show-token only in a trusted terminal)");
    }
    console.log("Surfaces authenticate with: Authorization: Bearer <token>");
    console.log(`next: muster gateway daemon start --port ${result.config.port ?? DEFAULT_GATEWAY_PORT}`);
    return;
  }
  if (action === "status") {
    const gateway = await loadGatewayConfig().then(
      (config) => ({ config, initialized: true }),
      () => ({ config: emptyGatewayConfig(), initialized: false }),
    );
    const readyChannels = gateway.initialized
      ? CHANNEL_SETUP_SPECS.filter((spec) => channelReady(spec.id, gateway.config)).length
      : 0;
    const port = gateway.config.port ?? DEFAULT_GATEWAY_PORT;
    // The hint has to read the world before advising it. Telling a user to
    // start a daemon that is already serving requests trains them to ignore
    // every next= line the CLI prints.
    const daemon = await inspectGatewayDaemon(port);
    const next = !gateway.initialized
      ? "muster gateway init"
      : daemon.running
        ? "muster gateway daemon status"
        : `muster gateway daemon start --port ${port}`;
    console.log(`gateway_status=${gateway.initialized ? "configured" : "missing"}`);
    console.log(`gateway_config=${gatewayConfigPath()}`);
    console.log(`token=${gateway.initialized && gateway.config.token ? "configured" : "missing"}`);
    console.log(`port=${port}`);
    console.log(`channels_ready=${readyChannels}/${CHANNEL_SETUP_SPECS.length}`);
    console.log(`daemon=${daemon.running ? "running" : "stopped"}${daemon.pid ? ` pid=${daemon.pid}` : ""} health=${daemon.healthy ? "ok" : daemon.running ? "unreachable" : "n/a"}`);
    console.log(`next=${JSON.stringify(next)}`);
    return;
  }
  if (action === "start") {
    const gateway = await loadGatewayConfig();
    const config = await loadConfig();
    const port = readNumberFlag(commandArgs, "--port") ?? gateway.port ?? DEFAULT_GATEWAY_PORT;
    const enterprise = openSqliteGatewayEnterpriseRuntime(process.cwd());
    const frappeOAuthConnections = gateway.frappe?.oauth?.connections ?? [];
    const frappeOAuth = frappeOAuthConnections.length
      ? new FrappeOAuthCoordinator({ connections: frappeOAuthConnections, cwd: process.cwd() })
      : undefined;
    const registry = builtinFlowRegistry(commandArgs);
    await loadConfiguredGatewayPacks(config, registry, {
      cwd: process.cwd(),
      log: (line) => console.log(line),
      env: gatewayCapabilityEnvironment(gateway),
    });
    const frappeIndexing = startConfiguredFrappeIndexing(registry, frappeOAuth, {
      cwd: process.cwd(),
      log: (line) => console.log(line),
      intervalMs: 15 * 60_000,
      deferInitialMs: 60_000,
    });
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    let running: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
    const workers: Promise<void>[] = [];
    try {
      running = await startGatewayServer({ config, gateway, registry, enterprise, frappeOAuth, cwd: process.cwd(), log: (line) => console.log(line) }, port);
      console.log("routes: GET /v1/health | POST /v1/messages | POST /v1/flows/<run>/approve|reject | POST /v1/adapters/telegram|slack|discord|whatsapp-cloud|gchat|teams");
      if (commandArgs.includes("--with-telegram-poll")) {
        workers.push(pollTelegram({ config, gateway, registry, enterprise, frappeOAuth, cwd: process.cwd(), signal: controller.signal, log: (line) => console.log(line) }).catch((error) => {
          console.error(`telegram poll failed: ${error instanceof Error ? error.message : String(error)}`);
        }));
        console.log("telegram_poll=background_in_process");
      }
      if (commandArgs.includes("--with-slack-socket")) {
        workers.push(pollSlackSocket({ config, gateway, registry, enterprise, frappeOAuth, cwd: process.cwd(), signal: controller.signal, log: (line) => console.log(line) }).catch((error) => {
          console.error(`slack socket failed: ${error instanceof Error ? error.message : String(error)}`);
        }));
        console.log("slack_socket=background_in_process");
      }
      if (commandArgs.includes("--with-whatsapp")) {
        workers.push(pollWhatsApp({ config, gateway, registry, enterprise, frappeOAuth, cwd: process.cwd(), signal: controller.signal, log: (line) => console.log(line) }).catch((error) => {
          console.error(`whatsapp connection failed: ${error instanceof Error ? error.message : String(error)}`);
        }));
        console.log("whatsapp=background_in_process");
      }
      console.log("stop with Ctrl-C");
      if (!controller.signal.aborted) {
        await new Promise<void>((resolvePromise) => controller.signal.addEventListener("abort", () => resolvePromise(), { once: true }));
      }
    } finally {
      controller.abort();
      frappeIndexing.stop();
      await Promise.allSettled(workers);
      await frappeIndexing.ready;
      await running?.close();
      await enterprise.close?.();
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
    return;
  }
  if (action === "daemon") {
    await gatewayDaemonCommand(commandArgs.slice(1));
    return;
  }
  if (action === "webhook") {
    await gatewayWebhookCommand(commandArgs.slice(1));
    return;
  }
  if (action === "poll") {
    // Long-poll Telegram getUpdates instead of running a webhook — no public URL
    // needed. Uses the active profile's config + .muster/gateway.json telegram.botToken.
    const gateway = await loadGatewayConfig();
    const config = await loadConfig();
    const frappeOAuthConnections = gateway.frappe?.oauth?.connections ?? [];
    const frappeOAuth = frappeOAuthConnections.length
      ? new FrappeOAuthCoordinator({ connections: frappeOAuthConnections, cwd: process.cwd() })
      : undefined;
    const registry = builtinFlowRegistry(commandArgs);
    await loadConfiguredGatewayPacks(config, registry, {
      cwd: process.cwd(),
      log: (line) => console.log(line),
      env: gatewayCapabilityEnvironment(gateway),
    });
    const frappeIndexing = startConfiguredFrappeIndexing(registry, frappeOAuth, {
      cwd: process.cwd(),
      log: (line) => console.log(line),
      intervalMs: 15 * 60_000,
      deferInitialMs: 60_000,
    });
    const enterprise = openSqliteGatewayEnterpriseRuntime(process.cwd());
    const controller = new AbortController();
    process.on("SIGINT", () => controller.abort());
    console.log("telegram long-poll (no webhook). Message the bot; stop with Ctrl-C.");
    try {
      await pollTelegram({ config, gateway, registry, enterprise, frappeOAuth, cwd: process.cwd(), signal: controller.signal, log: (line) => console.log(line) });
    } finally {
      frappeIndexing.stop();
      await frappeIndexing.ready;
      await enterprise.close?.();
    }
    return;
  }
  throw new Error("Usage: muster gateway <init|status|start [--port 7460] [--with-telegram-poll] [--with-slack-socket] [--with-whatsapp]|daemon start|stop|status|restart [worker flags]|webhook telegram --public-url URL|poll>");
}

function gatewayPidPath(cwd = process.cwd()): string {
  return join(cwd, ".muster", "gateway.pid");
}

function gatewayLogPath(cwd = process.cwd()): string {
  return join(cwd, ".muster", "gateway.log");
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readGatewayPid(cwd = process.cwd()): Promise<number | undefined> {
  const raw = await readFile(gatewayPidPath(cwd), "utf8").catch(() => "");
  const pid = Number(raw.trim());
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

interface GatewayDaemonState {
  readonly pid?: number;
  /** Pid file present AND that process alive. */
  readonly running: boolean;
  /** `/v1/health` answered ok. Only probed when a live pid says it should. */
  readonly healthy: boolean;
}

/** Two independent facts — a live pid and a healthy port — never one guessed from the other. */
async function inspectGatewayDaemon(port: number, cwd = process.cwd()): Promise<GatewayDaemonState> {
  const pid = await readGatewayPid(cwd);
  const running = pid !== undefined && processIsAlive(pid);
  if (!running) return { running: false, healthy: false };
  let healthy = false;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/health`, { signal: AbortSignal.timeout(750) });
    const body = await response.json().catch(() => undefined) as { ok?: boolean } | undefined;
    healthy = response.ok && body?.ok === true;
  } catch {
    healthy = false;
  }
  return { ...(pid === undefined ? {} : { pid }), running, healthy };
}

async function gatewayDaemonCommand(args: string[]): Promise<void> {
  const [subcommand = "status"] = args;
  const pidPath = gatewayPidPath();
  const logPath = gatewayLogPath();
  if (subcommand === "status") {
    const pid = await readGatewayPid();
    const alive = pid !== undefined && processIsAlive(pid);
    console.log(`gateway_daemon=${alive ? "running" : "stopped"}`);
    console.log(`pid=${pid ?? "-"}`);
    console.log(`pid_file=${pidPath}`);
    console.log(`log_file=${logPath}`);
    console.log(`next=${alive ? "muster gateway daemon stop" : "muster gateway daemon start"}`);
    return;
  }
  if (subcommand === "stop") {
    const pid = await readGatewayPid();
    if (!pid || !processIsAlive(pid)) {
      await unlink(pidPath).catch(() => undefined);
      console.log("gateway_daemon=stopped");
      return;
    }
    process.kill(pid, "SIGTERM");
    for (let i = 0; i < 20; i += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
      if (!processIsAlive(pid)) break;
    }
    await unlink(pidPath).catch(() => undefined);
    console.log("gateway_daemon=stopped");
    return;
  }
  if (subcommand === "restart") {
    await gatewayDaemonCommand(["stop"]);
    await gatewayDaemonCommand(["start", ...args.slice(1)]);
    return;
  }
  if (subcommand === "start") {
    const existing = await readGatewayPid();
    if (existing && processIsAlive(existing)) {
      console.log(`gateway_daemon=running pid=${existing}`);
      console.log(`log_file=${logPath}`);
      return;
    }
    await mkdir(dirname(pidPath), { recursive: true, mode: 0o700 });
    await ensureDefaultConfig(process.cwd());
    const gateway = await loadGatewayConfig();
    const port = readNumberFlag(args, "--port") ?? gateway.port ?? DEFAULT_GATEWAY_PORT;
    const childArgs = [...process.execArgv, process.argv[1], "gateway", "start", "--port", String(port)];
    if (args.includes("--with-telegram-poll")) childArgs.push("--with-telegram-poll");
    if (args.includes("--with-slack-socket")) childArgs.push("--with-slack-socket");
    if (args.includes("--with-whatsapp")) childArgs.push("--with-whatsapp");
    const out = openSync(logPath, "a", 0o600);
    const child = spawn(process.execPath, childArgs, {
      cwd: process.cwd(),
      detached: true,
      stdio: ["ignore", out, out],
      env: process.env,
    });
    closeSync(out);
    const pid = child.pid;
    if (!pid) throw new Error(`Gateway daemon did not start. See ${logPath}`);
    const healthy = await waitForGatewayDaemonHealth(port, pid);
    if (!healthy) {
      if (processIsAlive(pid)) process.kill(pid, "SIGTERM");
      await unlink(pidPath).catch(() => undefined);
      throw new Error(`Gateway daemon failed its startup health check. See ${logPath}`);
    }
    child.unref();
    await writeFile(pidPath, `${pid}\n`, { encoding: "utf8", mode: 0o600 });
    console.log(`gateway_daemon=started pid=${pid} health=verified`);
    console.log(`port=${port}`);
    console.log(`pid_file=${pidPath}`);
    console.log(`log_file=${logPath}`);
    console.log(`health=http://127.0.0.1:${port}/v1/health`);
    return;
  }
  throw new Error("Usage: muster gateway daemon start|stop|status|restart [--with-telegram-poll] [--with-slack-socket] [--with-whatsapp] [--port 7460]");
}

async function waitForGatewayDaemonHealth(port: number, pid: number, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let consecutiveHealthyChecks = 0;
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) return false;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/health`, { signal: AbortSignal.timeout(750) });
      const body = await response.json().catch(() => undefined) as { ok?: boolean; service?: string } | undefined;
      if (response.ok && body?.ok === true && body.service === "muster-gateway") {
        consecutiveHealthyChecks += 1;
        if (consecutiveHealthyChecks >= 2 && processIsAlive(pid)) return true;
      } else {
        consecutiveHealthyChecks = 0;
      }
    } catch {
      consecutiveHealthyChecks = 0;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 125));
  }
  return false;
}

async function gatewayWebhookCommand(args: string[]): Promise<void> {
  const [channel] = args;
  if (channel !== "telegram") throw new Error("Usage: muster gateway webhook telegram --public-url https://your-domain.example");
  const gateway = await loadGatewayConfig();
  const publicUrl = readFlag(args, "--public-url")?.replace(/\/$/, "");
  if (!publicUrl || !publicUrl.startsWith("https://")) throw new Error("--public-url must be a public https:// URL for Telegram webhooks.");
  const botToken = gateway.telegram?.botToken;
  if (!botToken) throw new Error("Telegram bot token missing. Run: muster channels ready telegram --bot-token-env TELEGRAM_BOT_TOKEN");
  const secretToken = gateway.telegram?.secretToken;
  if (!secretToken) throw new Error("Telegram webhook secret missing. Run: muster channels ready telegram --bot-token-env TELEGRAM_BOT_TOKEN");
  const url = `${publicUrl}/v1/adapters/telegram`;
  const response = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url,
      secret_token: secretToken,
      drop_pending_updates: false,
      allowed_updates: ["message", "callback_query"],
    }),
    signal: AbortSignal.timeout(12_000),
  });
  const body = await response.json().catch(() => ({})) as { ok?: boolean; description?: string };
  if (!response.ok || body.ok === false) {
    throw new Error(`Telegram setWebhook failed: HTTP ${response.status}${body.description ? ` ${body.description}` : ""}`);
  }
  console.log("telegram_webhook=configured");
  console.log(`webhook_url=${url}`);
  console.log("secret_token=configured");
  console.log(`next=muster gateway daemon start --port ${gateway.port ?? DEFAULT_GATEWAY_PORT}`);
}

type ChannelId = "telegram" | "slack" | "gchat" | "discord" | "whatsapp" | "whatsapp-cloud" | "teams" | "web";

interface ChannelSetupSpec {
  readonly id: ChannelId;
  readonly label: string;
  readonly route?: string;
  readonly setupUrls: readonly string[];
  readonly requiredEnvFlags: readonly string[];
  readonly optionalEnvFlags?: readonly string[];
  readonly notes: readonly string[];
}

const CHANNEL_SETUP_SPECS: readonly ChannelSetupSpec[] = [
  {
    id: "telegram",
    label: "Telegram Bot",
    route: "/v1/adapters/telegram",
    setupUrls: ["https://core.telegram.org/bots/tutorial"],
    requiredEnvFlags: ["--bot-token-env"],
    optionalEnvFlags: ["--name", "--bot-token", "--public-url", "--secret-token-env"],
    notes: ["Simple setup: muster channels ready telegram --name <bot-name> --bot-token <token>. Muster generates the webhook secret internally. Add --public-url when you have a public HTTPS gateway and want Telegram webhooks instead of background long-poll fallback."],
  },
  {
    id: "slack",
    label: "Slack App",
    route: "/v1/adapters/slack",
    setupUrls: ["https://api.slack.com/apps", "https://api.slack.com/scopes/files:write", "https://api.slack.com/apis/connections/socket"],
    requiredEnvFlags: ["--bot-token-env", "--app-token-env"],
    optionalEnvFlags: ["--bot-token", "--app-token", "--mode", "--signing-secret-env", "--signing-secret", "--public-url"],
    notes: [
      "Default setup uses Slack Socket Mode: bot token plus app-level token, no public HTTPS URL. Use --mode http with --signing-secret-env and --public-url only when you want Slack Events API webhooks.",
      "Add bot scopes app_mentions:read, channels:history, chat:write, files:write, im:history, and im:write, then reinstall the Slack app so the issued bot token actually receives them.",
      "Generated PDFs, DOCX, XLSX, PPTX, and other artifacts need files:write; without it Muster can answer in Slack but can only return local MEDIA paths for files.",
    ],
  },
  {
    id: "gchat",
    label: "Google Chat App",
    route: "/v1/adapters/gchat",
    setupUrls: ["https://console.cloud.google.com/apis/library/chat.googleapis.com", "https://developers.google.com/workspace/chat/verify-requests-from-chat"],
    requiredEnvFlags: ["--audience"],
    optionalEnvFlags: ["--verification-token-env", "--verification-token"],
    notes: ["Set the Chat API Authentication Audience to the exact HTTPS endpoint URL and pass that URL as --audience. Muster verifies Google-signed OIDC/JWT bearer tokens and the chat@system.gserviceaccount.com identity.", "The legacy verification token remains available only for existing Chat apps."],
  },
  {
    id: "discord",
    label: "Discord App",
    route: "/v1/adapters/discord",
    setupUrls: ["https://discord.com/developers/applications"],
    requiredEnvFlags: ["--bot-token-env", "--public-key-env"],
    optionalEnvFlags: ["--bot-token", "--public-key"],
    notes: ["Discord interaction webhooks require the application public key because Discord cannot send Muster's gateway bearer token."],
  },
  {
    id: "whatsapp",
    label: "WhatsApp (personal · groups)",
    setupUrls: ["https://docs.openclaw.ai/whatsapp", "https://github.com/WhiskeySockets/Baileys"],
    requiredEnvFlags: [],
    optionalEnvFlags: ["--account", "--activation", "--groups", "--group-allow-from", "--session-dir"],
    notes: ["Unofficial protocol; Meta ToS gray zone; the linked number can be banned — recommend a dedicated number.", "Groups are blocked until --groups contains exact group JIDs or *. Mention activation is the default."],
  },
  {
    id: "whatsapp-cloud",
    label: "WhatsApp Cloud API (business · 1:1)",
    route: "/v1/adapters/whatsapp-cloud",
    setupUrls: ["https://developers.facebook.com/docs/whatsapp/cloud-api/get-started", "https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks"],
    requiredEnvFlags: ["--access-token-env", "--verify-token-env", "--phone-number-id-env", "--app-secret-env"],
    optionalEnvFlags: ["--access-token", "--verify-token", "--phone-number-id", "--app-secret", "--api-version"],
    notes: ["Use a long-lived access token in production; the verify token handles Meta's GET challenge and the app secret verifies POST webhooks."],
  },
  {
    id: "teams",
    label: "Microsoft Teams",
    route: "/v1/adapters/teams",
    setupUrls: ["https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/channel-and-group-conversations"],
    requiredEnvFlags: ["--hmac-secret-env"],
    optionalEnvFlags: ["--hmac-secret"],
    notes: ["The adapter accepts Teams-style webhook payloads. The HMAC secret is required because Teams cannot send Muster's gateway bearer token."],
  },
  {
    id: "web",
    label: "Web App Embed",
    route: "/v1/messages",
    setupUrls: ["http://localhost:7460/v1/health"],
    requiredEnvFlags: [],
    notes: ["Use the gateway bearer token from `muster gateway init` in your webapp backend, never directly from browser JavaScript."],
  },
];

async function channelsCommand(commandArgs: string[]): Promise<void> {
  const [action, channel] = commandArgs;
  if (action === "list" || action === undefined) {
    printChannelCatalog();
    return;
  }
  if (action === "status") {
    const gateway = await loadGatewayConfig().then(
      (config) => ({ config, initialized: true }),
      () => ({ config: emptyGatewayConfig(), initialized: false }),
    );
    if (!gateway.initialized) console.log(`gateway_config=missing next="muster gateway init"`);
    if (channel) {
      const spec = requireChannelSpec(channel);
      printChannelStatus(spec, gateway.config);
      return;
    }
    for (const spec of CHANNEL_SETUP_SPECS) printChannelStatus(spec, gateway.config);
    return;
  }
  if (action === "login" && channel === "whatsapp") {
    const gateway = await loadOrInitGatewayConfig();
    await runWhatsAppLoginCommand({ gateway, isTTY: Boolean(process.stdout.isTTY), output: (line) => console.log(line) });
    return;
  }
  if (action === "plan" && channel) {
    const spec = requireChannelSpec(channel);
    const config = await loadGatewayConfig().catch(() => ({ port: DEFAULT_GATEWAY_PORT }) as GatewayConfig);
    printChannelOperatorPlan(spec, config, commandArgs);
    return;
  }
  if (action === "simulate" && channel) {
    const spec = requireChannelSpec(channel);
    printChannelSimulation(spec, readFlag(commandArgs, "--message") ?? "hello from Muster local simulation");
    return;
  }
  if (action === "doctor") {
    const gateway = await loadGatewayConfig().then(
      (config) => ({ config, initialized: true }),
      () => ({ config: emptyGatewayConfig(), initialized: false }),
    );
    if (!channel) {
      printChannelDoctorSummary(gateway.config, { initialized: gateway.initialized });
      return;
    }
    const spec = requireChannelSpec(channel);
    await printChannelDoctor(spec, gateway.config, { live: commandArgs.includes("--live") });
    return;
  }
  if (action === "ready" && channel) {
    const spec = requireChannelSpec(channel);
    await runChannelReady(spec, commandArgs);
    return;
  }
  if ((action === "setup" || action === "connect") && channel) {
    const spec = requireChannelSpec(channel);
    const config = await loadOrInitGatewayConfig();
    const updated = applyChannelSetup(spec.id, config, commandArgs);
    if (updated !== config) {
      const path = await saveGatewayConfig(updated);
      console.log(`gateway_config=${path}`);
    }
    printChannelSetup(spec, updated, commandArgs, { friendly: action === "connect" });
    return;
  }
  throw new Error("Usage: muster channels list | status [channel] | login whatsapp | plan <channel> | simulate <channel> [--message TEXT] | doctor [telegram|slack|gchat|discord|whatsapp|whatsapp-cloud|teams|web] [--live] | setup|connect|ready <telegram|slack|gchat|discord|whatsapp|whatsapp-cloud|teams|web> [setup flags]");
}

async function runChannelReady(spec: ChannelSetupSpec, args: readonly string[]): Promise<void> {
  const publicUrl = readFlag([...args], "--public-url")?.replace(/\/$/, "");
  const noStart = args.includes("--no-start");
  const setWebhook = args.includes("--set-webhook");
  await ensureDefaultConfig(process.cwd());
  const config = await loadOrInitGatewayConfig();
  const channelConfig = applyChannelSetup(spec.id, config, args);
  const requestedPort = readNumberFlag([...args], "--port");
  const updated = requestedPort && requestedPort !== channelConfig.port
    ? { ...channelConfig, port: requestedPort }
    : channelConfig;
  if (updated !== config) {
    const path = await saveGatewayConfig(updated);
    console.log(`gateway_config=${path}`);
  }
  const missing = channelMissingSetup(spec.id, updated);
  const ready = missing.length === 0;
  console.log(`channel_ready=${spec.id} status=${ready ? "ready" : "needs_setup"}`);
  console.log(`single_command=${noStart ? "false reason=no-start" : "true"}`);
  if (missing.length) console.log(`missing_setup=${missing.join(",")}`);
  printChannelSetup(spec, updated, args, { friendly: true });
  await printChannelDoctor(spec, updated, { live: args.includes("--live") });
  if (!ready) {
    console.log(`enable=blocked next="muster channels ready ${spec.id}"`);
    return;
  }
  if (spec.id === "telegram" && publicUrl && setWebhook) {
    await gatewayWebhookCommand(["telegram", "--public-url", publicUrl]);
  } else if (spec.id === "telegram" && publicUrl) {
    console.log(`webhook_registration=skipped next="muster gateway webhook telegram --public-url ${publicUrl}"`);
  }
  if (noStart) {
    const pollFlag = spec.id === "telegram" && !publicUrl ? " --with-telegram-poll" : spec.id === "whatsapp" ? " --with-whatsapp" : "";
    const slackSocketFlag = spec.id === "slack" && slackMode(updated) === "socket" ? " --with-slack-socket" : "";
    console.log(`daemon=skipped start="muster gateway daemon start${pollFlag}${slackSocketFlag} --port ${updated.port ?? DEFAULT_GATEWAY_PORT}"`);
  } else {
    const daemonArgs = ["start", "--port", String(updated.port ?? DEFAULT_GATEWAY_PORT)];
    if (spec.id === "telegram" && !publicUrl) daemonArgs.push("--with-telegram-poll");
    if (spec.id === "slack" && slackMode(updated) === "socket") daemonArgs.push("--with-slack-socket");
    if (spec.id === "whatsapp") daemonArgs.push("--with-whatsapp");
    await gatewayDaemonCommand(daemonArgs);
  }
  printChannelSimulation(spec, readFlag([...args], "--message") ?? "hello from Muster channel ready check");
  console.log(`done=channel_ready channel=${spec.id} daemon=${noStart ? "skipped" : "started_or_running"} sample=local_simulation`);
}

function printChannelCatalog(): void {
  console.log("channel\tlabel\tconfigured_by\tsetup");
  for (const spec of CHANNEL_SETUP_SPECS) {
    const auth = spec.requiredEnvFlags.length ? spec.requiredEnvFlags.join(",") : spec.optionalEnvFlags?.length ? spec.optionalEnvFlags.join(",") : "gateway token";
    console.log(`${spec.id}\t${spec.label}\t${auth}\tmuster channels ready ${spec.id}`);
  }
}

function printChannelStatus(spec: ChannelSetupSpec, config: GatewayConfig): void {
  const ready = channelReady(spec.id, config);
  console.log(`channel=${spec.id} ready=${ready} webhook=${spec.route ?? "-"} setup="muster channels ready ${spec.id}"`);
  if (spec.id === "telegram") console.log(`  name=${config.telegram?.name ?? "-"} bot_token=${configured(Boolean(config.telegram?.botToken))} secret_token=${configured(Boolean(config.telegram?.secretToken))} stream=${config.telegram?.stream ?? "off"} status=${config.telegram?.status ?? "typing"} thinking=${config.telegram?.thinking ?? "off"} busy=${config.telegram?.busy ?? "queue"}`);
  if (spec.id === "slack") console.log(`  mode=${slackMode(config)} bot_token=${configured(Boolean(config.slack?.botToken))} app_token=${configured(Boolean(config.slack?.appToken))} signing_secret=${configured(Boolean(config.slack?.signingSecret))} stream=${config.slack?.stream ?? "off"} status=${config.slack?.status ?? "message"} thinking=${config.slack?.thinking ?? "off"} busy=${config.slack?.busy ?? "queue"}`);
  if (spec.id === "gchat") console.log(`  auth=${config.gchat?.verification?.mode ?? (config.gchat?.verificationToken ? "legacy_token" : "missing")} audience=${config.gchat?.verification?.audience ?? "-"} verification_token=${configured(Boolean(config.gchat?.verificationToken))}`);
  if (spec.id === "discord") console.log(`  bot_token=${configured(Boolean(config.discord?.botToken))} public_key=${configured(Boolean(config.discord?.publicKey))}`);
  if (spec.id === "whatsapp") console.log(`  account=${config.whatsapp?.account ?? "default"} activation=${config.whatsapp?.activation ?? "mention"} groups=${config.whatsapp?.groups?.join(",") || "-"} session=${configured(existsSync(join(whatsappSessionDir(config.whatsapp), "creds.json")))}`);
  if (spec.id === "whatsapp-cloud") console.log(`  access_token=${configured(Boolean(config["whatsapp-cloud"]?.accessToken))} verify_token=${configured(Boolean(config["whatsapp-cloud"]?.verifyToken))} phone_number_id=${configured(Boolean(config["whatsapp-cloud"]?.phoneNumberId))} app_secret=${configured(Boolean(config["whatsapp-cloud"]?.appSecret))}`);
  if (spec.id === "teams") console.log(`  hmac_secret=${configured(Boolean(config.teams?.hmacSecret))}`);
  if (spec.id === "web") console.log(`  bearer_token=${configured(Boolean(config.token))}`);
}

function printChannelOperatorPlan(spec: ChannelSetupSpec, config: GatewayConfig, args: readonly string[]): void {
  const publicUrl = readFlag([...args], "--public-url")?.replace(/\/$/, "");
  const requestedSlackMode = commandLineSlackMode(args);
  const localBase = `http://127.0.0.1:${config.port ?? DEFAULT_GATEWAY_PORT}`;
  const webhookUrl = spec.route ? `${publicUrl ?? localBase}${spec.route}` : "-";
  const ready = channelReady(spec.id, config);
  const missing = channelMissingSetup(spec.id, config, requestedSlackMode);
  console.log(`channel_plan=${spec.id} label="${spec.label}" ready=${ready}`);
  console.log(`route=${spec.route ?? "-"}`);
  if (spec.id === "telegram" && !publicUrl) {
    console.log("ingress=background_long_poll webhook_url=-");
  } else if (spec.id === "slack" && slackMode(config, requestedSlackMode) === "socket") {
    console.log("ingress=socket_mode webhook_url=-");
  } else {
    console.log(`webhook_url=${webhookUrl}`);
  }
  console.log(`operator_contract=inbound_normalize -> scoped_memory_recall -> policy_gate -> draft_or_reply -> token_ledger`);
  console.log(`local_simulation=muster channels simulate ${spec.id} --message "hello"`);
  console.log(`setup_command=${spec.id === "whatsapp" ? "muster channels setup whatsapp --account default && muster channels login whatsapp" : `muster channels ready ${spec.id}${spec.id === "slack" && requestedSlackMode ? ` --mode ${requestedSlackMode}` : ""}${publicUrl ? ` --public-url ${publicUrl}` : ""}`}`);
  console.log(`doctor_command=muster channels doctor ${spec.id}${channelHasLiveDoctor(spec.id) ? " --live" : ""}`);
  const socketFlag = spec.id === "slack" && slackMode(config, requestedSlackMode) === "socket" ? " --with-slack-socket" : spec.id === "whatsapp" ? " --with-whatsapp" : "";
  console.log(`start_command=muster gateway daemon start${socketFlag} --port ${config.port ?? DEFAULT_GATEWAY_PORT}`);
  if (spec.id === "telegram" && publicUrl) console.log(`webhook_command=muster gateway webhook telegram --public-url ${publicUrl}`);
  else if (spec.id === "telegram") console.log("optional_webhook=muster gateway webhook telegram --public-url https://your-domain.example");
  console.log(`security=signature_or_token_check:${channelAuthModeForConfig(spec.id, config, requestedSlackMode)} approval_required_for_mutations:true secrets_printed:false`);
  console.log(`reply_mode=${channelReplyMode(spec.id, config)}`);
  if (spec.id === "slack") console.log("artifact_delivery=slack_native_files requires=files:write verify=\"muster channels doctor slack --live\"");
  if (missing.length) console.log(`missing_setup=${missing.join(",")}`);
  for (const url of spec.setupUrls) console.log(`setup_url=${url}`);
  for (const note of spec.notes) console.log(`note=${note}`);
}

function printChannelSimulation(spec: ChannelSetupSpec, message: string): void {
  const normalized = simulateChannelInbound(spec.id, message);
  console.log(`channel_simulation=${spec.id} normalized=${normalized.ok}`);
  console.log(`route=${spec.route ?? "/v1/messages"}`);
  if (!normalized.ok) {
    console.log(`ignored_reason=${normalized.reason}`);
    return;
  }
  console.log(`surface=${normalized.surfaceId}`);
  console.log(`conversation=${normalized.conversationId}`);
  console.log(`sender=${normalized.senderId}`);
  console.log(`text=${normalized.text}`);
  console.log(`reply_to=${normalized.replyTo ?? "-"}`);
  console.log(`next=run gateway handler, apply pairing/policy, record tokens, then draft or send reply`);
}

function simulateChannelInbound(channel: ChannelId, message: string): { readonly ok: true; readonly surfaceId: string; readonly conversationId: string; readonly senderId: string; readonly text: string; readonly replyTo?: string } | { readonly ok: false; readonly reason: string } {
  if (channel === "telegram") {
    const mapped = telegramUpdateToSurfaceMessage({
      update_id: 1001,
      message: { message_id: 42, chat: { id: 7001 }, from: { id: 3001 }, text: message },
    });
    return mapped ? simulationFromSurface(mapped) : { ok: false, reason: "telegram mapper returned no message" };
  }
  if (channel === "slack") {
    const inbound = slackEventToSurfaceMessage({
      type: "event_callback",
      team_id: "TLOCAL",
      event: { type: "app_mention", channel: "CLOCAL", user: "ULOCAL", text: message, ts: "1710000000.000100" },
    });
    return inbound.kind === "message"
      ? simulationFromSurface(inbound.message)
      : { ok: false, reason: inbound.kind === "url_verification" ? "slack url verification challenge" : inbound.reason };
  }
  if (channel === "gchat") {
    const inbound = gchatEventToSurfaceMessage({
      type: "MESSAGE",
      space: { name: "spaces/LOCAL" },
      message: { name: "spaces/LOCAL/messages/1", argumentText: message, sender: { name: "users/local", type: "HUMAN" }, thread: { name: "spaces/LOCAL/threads/1" } },
    });
    return inbound.kind === "message" ? simulationFromSurface(inbound.message) : { ok: false, reason: inbound.reason };
  }
  if (channel === "discord") {
    const inbound = discordInteractionToInbound({
      type: 2,
      guild_id: "GLOCAL",
      channel_id: "DLOCAL",
      member: { user: { id: "UDISCORD", bot: false } },
      data: { name: "muster", options: [{ name: "prompt", type: 3, value: message }] },
    });
    return inbound.kind === "message" ? simulationFromSurface(inbound.message) : { ok: false, reason: inbound.kind };
  }
  if (channel === "whatsapp") {
    const mapped = whatsAppWebMessageToSurfaceMessage({
      key: { id: "LOCAL", remoteJid: "919999999999@s.whatsapp.net", fromMe: false },
      message: { conversation: message },
    }, { account: "default" });
    return mapped ? simulationFromSurface(mapped) : { ok: false, reason: "whatsapp mapper returned no message" };
  }
  if (channel === "whatsapp-cloud") {
    const messages = whatsAppWebhookToSurfaceMessages({
      object: "whatsapp_business_account",
      entry: [{ id: "WABA", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: "PNLOCAL" }, messages: [{ from: "919999999999", id: "wamid.LOCAL", type: "text", text: { body: message } }] } }] }],
    });
    return messages[0] ? simulationFromSurface(messages[0]) : { ok: false, reason: "whatsapp-cloud mapper returned no message" };
  }
  if (channel === "teams") {
    const inbound = teamsActivityToSurfaceMessage({
      type: "message",
      id: "activity-local",
      text: `<at>Muster</at> ${message}`,
      from: { id: "UTEAMS", name: "Local Tester" },
      conversation: { id: "CONVLOCAL" },
      channelData: { tenant: { id: "TENANTLOCAL" } },
    });
    return inbound.kind === "message" ? simulationFromSurface(inbound.message) : { ok: false, reason: inbound.reason };
  }
  return {
    ok: true,
    surfaceId: "web:local",
    conversationId: "web-local-conversation",
    senderId: "web-local-user",
    text: message,
  };
}

function simulationFromSurface(message: { readonly surfaceId: string; readonly conversationId: string; readonly senderId: string; readonly text: string; readonly replyTo?: string }): { readonly ok: true; readonly surfaceId: string; readonly conversationId: string; readonly senderId: string; readonly text: string; readonly replyTo?: string } {
  return {
    ok: true,
    surfaceId: message.surfaceId,
    conversationId: message.conversationId,
    senderId: message.senderId,
    text: message.text,
    replyTo: message.replyTo,
  };
}

function channelMissingSetup(channel: ChannelId, config: GatewayConfig, override?: "socket" | "http"): string[] {
  if (channel === "telegram") return [config.telegram?.botToken ? "" : "telegram.botToken"].filter(Boolean);
  if (channel === "slack") {
    const mode = slackMode(config, override);
    return [
      config.slack?.botToken ? "" : "slack.botToken",
      mode === "socket" && !config.slack?.appToken ? "slack.appToken" : "",
      mode === "http" && !config.slack?.signingSecret ? "slack.signingSecret" : "",
    ].filter(Boolean);
  }
  if (channel === "gchat") return [googleChatAudienceIsValid(config.gchat?.verification?.audience) || config.gchat?.verificationToken ? "" : "gchat.verification.audience"].filter(Boolean);
  if (channel === "discord") return [config.discord?.botToken ? "" : "discord.botToken", config.discord?.publicKey ? "" : "discord.publicKey"].filter(Boolean);
  if (channel === "whatsapp") return [existsSync(join(whatsappSessionDir(config.whatsapp), "creds.json")) ? "" : "whatsapp.session"].filter(Boolean);
  if (channel === "whatsapp-cloud") return [config["whatsapp-cloud"]?.accessToken ? "" : "whatsapp-cloud.accessToken", config["whatsapp-cloud"]?.verifyToken ? "" : "whatsapp-cloud.verifyToken", config["whatsapp-cloud"]?.phoneNumberId ? "" : "whatsapp-cloud.phoneNumberId", config["whatsapp-cloud"]?.appSecret ? "" : "whatsapp-cloud.appSecret"].filter(Boolean);
  if (channel === "teams") return [config.teams?.hmacSecret ? "" : "teams.hmacSecret"].filter(Boolean);
  return [config.token ? "" : "gateway.token"].filter(Boolean);
}

function channelAuthMode(channel: ChannelId): string {
  if (channel === "telegram") return "secret-token-header-recommended";
  if (channel === "slack") return "slack-socket-app-token";
  if (channel === "discord") return "ed25519-public-key-recommended";
  if (channel === "whatsapp") return "linked-device";
  if (channel === "whatsapp-cloud") return "verify-token-and-graph-token";
  if (channel === "gchat") return "google-signed-oidc-or-jwt";
  if (channel === "teams") return "hmac-secret-required";
  return "bearer-token";
}

function channelAuthModeForConfig(channel: ChannelId, config: GatewayConfig, override?: "socket" | "http"): string {
  if (channel === "slack") return slackMode(config, override) === "socket" ? "slack-socket-app-token" : "slack-signature-required";
  return channelAuthMode(channel);
}

function channelReplyMode(channel: ChannelId, config: GatewayConfig): string {
  if (channel === "telegram") return config.telegram?.stream === "draft" ? "draft_stream" : "direct_send";
  if (channel === "slack") return config.slack?.stream === "draft" ? "draft_stream" : "direct_post";
  if (channel === "discord" || channel === "gchat" || channel === "teams") return "synchronous_response";
  if (channel === "whatsapp") return "linked-device-send";
  if (channel === "whatsapp-cloud") return "graph_api_send";
  return "http_response";
}

function commandLineSlackMode(args: readonly string[]): "socket" | "http" | undefined {
  const value = readFlag([...args], "--mode");
  if (!value) return undefined;
  if (value !== "socket" && value !== "http") throw new Error("--mode must be socket or http.");
  return value;
}

function slackMode(config: GatewayConfig, override?: "socket" | "http"): "socket" | "http" {
  if (override) return override;
  if (config.slack?.mode) return config.slack.mode;
  if (config.slack?.appToken) return "socket";
  if (config.slack?.signingSecret) return "http";
  return "socket";
}

function channelIngressMode(channel: ChannelId, config: GatewayConfig, options: { readonly publicUrl?: string; readonly slackMode?: "socket" | "http" } = {}): string {
  if (channel === "telegram") return options.publicUrl ? "webhook" : "background_long_poll";
  if (channel === "slack") return slackMode(config, options.slackMode) === "socket" ? "socket_mode" : "http_events";
  if (channel === "whatsapp") return "linked_device";
  if (channel === "web") return "gateway_http";
  return "webhook";
}

function channelStartCommand(channel: ChannelId, config: GatewayConfig, options: { readonly publicUrl?: string; readonly slackMode?: "socket" | "http" } = {}): string {
  const port = config.port ?? DEFAULT_GATEWAY_PORT;
  if (channel === "telegram" && !options.publicUrl) return `muster gateway daemon start --with-telegram-poll --port ${port}`;
  if (channel === "slack" && slackMode(config, options.slackMode) === "socket") return `muster gateway daemon start --with-slack-socket --port ${port}`;
  if (channel === "whatsapp") return `muster gateway daemon start --with-whatsapp --port ${port}`;
  return `muster gateway daemon start --port ${port}`;
}

function printChannelDoctorSummary(config: GatewayConfig, options: { readonly initialized?: boolean } = {}): void {
  const rows = CHANNEL_SETUP_SPECS.map((spec) => {
    const ready = channelReady(spec.id, config);
    const missing = channelMissingSetup(spec.id, config);
    const warnings = channelDoctorWarnings(spec.id, config);
    return { spec, ready, missing, warnings };
  });
  const readyCount = rows.filter((row) => row.ready).length;
  const warningCount = rows.filter((row) => row.warnings.length).length;
  const status = readyCount < rows.length ? "needs_setup" : warningCount ? "warning" : "ready";
  console.log(`channel_doctor=all status=${status} ready=${readyCount}/${rows.length} warnings=${warningCount}`);
  console.log(`gateway_config=${config.token ? "configured" : "missing"} port=${config.port ?? DEFAULT_GATEWAY_PORT}`);
  console.log("operator_matrix");
  for (const row of rows) {
    const channelStatus = row.ready ? row.warnings.length ? "warning" : "ready" : "needs_setup";
    const missing = row.missing.length ? row.missing.join(",") : "-";
    const warnings = row.warnings.length ? row.warnings.join(",") : "-";
    const next = !options.initialized && row.spec.id === "web"
      ? "muster gateway init"
      : row.ready
      ? row.warnings.length ? `muster channels doctor ${row.spec.id}${channelHasLiveDoctor(row.spec.id) ? " --live" : ""}` : `muster gateway daemon start${row.spec.id === "slack" && slackMode(config) === "socket" ? " --with-slack-socket" : ""} --port ${config.port ?? DEFAULT_GATEWAY_PORT}`
      : row.spec.id === "whatsapp" ? "muster channels login whatsapp" : `muster channels ready ${row.spec.id}`;
    console.log(`  channel=${row.spec.id} status=${channelStatus} missing=${missing} warnings=${warnings} auth=${channelAuthModeForConfig(row.spec.id, config)} reply=${channelReplyMode(row.spec.id, config)} next="${next}"`);
  }
  console.log("guardrails=signature_or_token_check,draft_first_when_supported,no_secret_echo,scoped_memory,token_ledger");
  const firstBlocked = rows.find((row) => !row.ready);
  const firstWarning = rows.find((row) => row.ready && row.warnings.length);
  if (!options.initialized) console.log("next=muster gateway init");
  else if (firstBlocked) console.log(`next=muster channels ready ${firstBlocked.spec.id}`);
  else if (firstWarning) console.log(`next=muster channels doctor ${firstWarning.spec.id}${channelHasLiveDoctor(firstWarning.spec.id) ? " --live" : ""}`);
  else console.log(`next=muster gateway daemon start --port ${config.port ?? DEFAULT_GATEWAY_PORT}`);
}

function channelDoctorWarnings(channel: ChannelId, config: GatewayConfig): string[] {
  if (channel === "telegram") {
    return [
      config.telegram?.secretToken ? "" : "telegram.secretToken_auto_generated",
      config.telegram?.botToken ? "telegram.live_check_available" : "",
    ].filter(Boolean);
  }
  if (channel === "slack") {
    return [
      config.slack?.botToken ? "slack.live_check_available" : "",
      config.slack?.botToken ? "slack.files_write_live_check_available" : "",
    ].filter(Boolean);
  }
  if (channel === "gchat" && config.gchat?.verification?.audience) {
    return ["gchat.live_unsigned_rejection_check_available"];
  }
  if (channel === "whatsapp") {
    return existsSync(join(whatsappSessionDir(config.whatsapp), "creds.json")) ? [] : ["whatsapp.login_required"];
  }
  return [];
}

function channelHasLiveDoctor(channel: ChannelId): boolean {
  return channel === "telegram" || channel === "slack" || channel === "gchat";
}

async function printChannelDoctor(
  spec: ChannelSetupSpec,
  config: GatewayConfig,
  options: { readonly live?: boolean } = {},
): Promise<void> {
  const ready = channelReady(spec.id, config);
  const checks: Array<{ name: string; status: "passed" | "needs_setup" | "warning"; detail: string }> = [];
  checks.push({ name: "gateway_config", status: config.token ? "passed" : "needs_setup", detail: config.token ? "gateway bearer token exists" : "run muster gateway init" });
  checks.push({ name: "channel_config", status: ready ? "passed" : "needs_setup", detail: ready ? `${spec.id} has required local credentials` : spec.id === "whatsapp" ? "run muster channels login whatsapp" : `run muster channels ready ${spec.id}` });
  if (spec.route) checks.push({ name: "webhook_route", status: "passed", detail: spec.route });
  if (spec.id === "telegram") {
    checks.push({
      name: "webhook_auth",
      status: config.telegram?.secretToken ? "passed" : "warning",
      detail: config.telegram?.secretToken
        ? "Telegram webhook secret is configured"
        : "run channels setup again; Muster normally auto-generates this from the bot token setup",
    });
    if (options.live) checks.push(await telegramLiveDoctor(config.telegram?.botToken));
    else checks.push({ name: "telegram_live", status: "warning", detail: "not run; add --live to call getMe without printing the token" });
  } else if (spec.id === "slack") {
    const mode = slackMode(config);
    const tokenTypeWarning = config.slack?.botToken && !config.slack.botToken.startsWith("xoxb-")
      ? "Slack bot token does not look like an xoxb- bot token; user tokens can pass auth.test but fail bot/channel behavior."
      : "Slack bot token shape looks like xoxb-.";
    const appTokenWarning = mode === "socket" && config.slack?.appToken && !config.slack.appToken.startsWith("xapp-")
      ? "Slack Socket Mode app token does not look like an xapp- token."
      : mode === "socket" ? "Slack Socket Mode app token shape looks like xapp-." : "HTTP mode does not use an app-level token.";
    checks.push({
      name: "bot_token_type",
      status: tokenTypeWarning.includes("does not look") ? "warning" : config.slack?.botToken ? "passed" : "needs_setup",
      detail: tokenTypeWarning,
    });
    checks.push({
      name: "app_token_type",
      status: appTokenWarning.includes("does not look") ? "warning" : mode === "socket" && !config.slack?.appToken ? "needs_setup" : "passed",
      detail: appTokenWarning,
    });
    checks.push({
      name: mode === "socket" ? "socket_auth" : "webhook_auth",
      status: ready ? "passed" : "needs_setup",
      detail: mode === "socket"
        ? "Slack Socket Mode uses bot token plus app-level token; no public URL required"
        : "Slack Events API uses signing-secret verification and requires a public HTTPS Request URL",
    });
    if (options.live) checks.push(...await slackLiveDoctor(config.slack?.botToken, mode === "socket" ? config.slack?.appToken : undefined));
    else checks.push({ name: "slack_live", status: "warning", detail: "not run; add --live to call auth.test and Socket Mode connection checks without printing tokens" });
  } else if (spec.id === "gchat") {
    const audience = config.gchat?.verification?.audience;
    checks.push({
      name: "gchat_auth",
      status: audience ? "passed" : config.gchat?.verificationToken ? "warning" : "needs_setup",
      detail: audience
        ? "Google-signed bearer verification is configured"
        : config.gchat?.verificationToken
          ? "Legacy verification token is configured; migrate to a Google-signed bearer audience"
          : "set the exact HTTPS endpoint or Cloud project number with --audience",
    });
    if (options.live) checks.push(await gchatLiveDoctor(audience));
    else if (audience) checks.push({ name: "gchat_endpoint", status: "warning", detail: "not run; add --live to verify the endpoint rejects unsigned requests" });
  } else if (spec.id === "whatsapp") {
    const doctor = await doctorWhatsApp(config.whatsapp);
    checks.push({ name: "session_present", status: doctor.sessionPresent ? "passed" : "needs_setup", detail: doctor.sessionPresent ? doctor.sessionDir : doctor.detail });
    checks.push({ name: "creds_age", status: doctor.credsAgeMs === undefined ? "needs_setup" : "passed", detail: doctor.credsAgeMs === undefined ? "credentials are not present" : `${Math.floor(doctor.credsAgeMs / 1000)} seconds` });
    checks.push({ name: "connection_state", status: doctor.connection === "open" ? "passed" : "warning", detail: doctor.detail });
  } else if (options.live) {
    checks.push({ name: "live_check", status: "warning", detail: `no safe live doctor is implemented for ${spec.id}; local configuration checks only` });
  }
  const failed = checks.filter((check) => check.status === "needs_setup").length;
  const warnings = checks.filter((check) => check.status === "warning").length;
  const status = failed ? "needs_setup" : warnings ? "warning" : "ready";
  console.log(`channel_doctor=${spec.id} status=${status}`);
  for (const check of checks) console.log(`check=${check.name} status=${check.status} detail="${check.detail.replace(/"/g, "'")}"`);
  const next = failed
    ? spec.id === "whatsapp" ? "muster channels login whatsapp" : `muster channels ready ${spec.id}`
    : spec.id === "slack" && checks.some((check) => check.name === "slack_file_upload" && check.status !== "passed")
      ? "Add Slack bot scope files:write, reinstall the Slack app, then run muster channels doctor slack --live"
    : warnings && spec.id === "telegram" && !options.live
      ? "muster channels doctor telegram --live"
    : warnings && spec.id === "slack" && !options.live
        ? "muster channels doctor slack --live"
    : warnings && spec.id === "gchat" && !options.live
        ? "muster channels doctor gchat --live"
      : `muster gateway daemon start${spec.id === "slack" && slackMode(config) === "socket" ? " --with-slack-socket" : spec.id === "whatsapp" ? " --with-whatsapp" : ""} --port ${config.port ?? DEFAULT_GATEWAY_PORT}`;
  console.log(`next=${next}`);
}

async function telegramLiveDoctor(botToken: string | undefined): Promise<{ name: string; status: "passed" | "needs_setup" | "warning"; detail: string }> {
  if (!botToken) return { name: "telegram_live", status: "needs_setup", detail: "TELEGRAM_BOT_TOKEN is not configured" };
  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/getMe`, { signal: AbortSignal.timeout(8000) });
    const body = await response.json().catch(() => ({})) as { ok?: boolean; result?: { username?: string; id?: number }; description?: string };
    if (!response.ok || body.ok === false) {
      return { name: "telegram_live", status: "warning", detail: `Bot API returned HTTP ${response.status}${body.description ? `: ${body.description}` : ""}` };
    }
    const username = body.result?.username ? `@${body.result.username}` : `id:${body.result?.id ?? "unknown"}`;
    return { name: "telegram_live", status: "passed", detail: `Bot API reachable as ${username}` };
  } catch (error) {
    return { name: "telegram_live", status: "warning", detail: `Bot API check failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function slackLiveDoctor(botToken: string | undefined, appToken: string | undefined): Promise<Array<{ name: string; status: "passed" | "needs_setup" | "warning"; detail: string }>> {
  if (!botToken) return [{ name: "slack_live", status: "needs_setup", detail: "SLACK_BOT_TOKEN is not configured" }];
  try {
    const auth = await fetch("https://slack.com/api/auth.test", {
      method: "POST",
      headers: { authorization: `Bearer ${botToken}`, "content-type": "application/x-www-form-urlencoded" },
      body: "",
      signal: AbortSignal.timeout(8000),
    });
    const authBody = await auth.json().catch(() => ({})) as { ok?: boolean; team?: string; user?: string; error?: string };
    if (!auth.ok || authBody.ok === false) {
      return [{ name: "slack_live", status: "warning", detail: `Slack auth.test failed${authBody.error ? `: ${authBody.error}` : `: HTTP ${auth.status}`}` }];
    }
    const checks: Array<{ name: string; status: "passed" | "needs_setup" | "warning"; detail: string }> = [
      { name: "slack_live", status: "passed", detail: `Slack bot token reachable for team ${authBody.team ?? "unknown"}` },
      await slackFileUploadScopeDoctor(botToken, auth.headers.get("x-oauth-scopes")),
    ];
    if (!appToken) return checks;
    const socket = await fetch("https://slack.com/api/apps.connections.open", {
      method: "POST",
      headers: { authorization: `Bearer ${appToken}`, "content-type": "application/x-www-form-urlencoded" },
      body: "",
      signal: AbortSignal.timeout(8000),
    });
    const socketBody = await socket.json().catch(() => ({})) as { ok?: boolean; url?: string; error?: string };
    if (!socket.ok || socketBody.ok === false || !socketBody.url) {
      checks.push({ name: "slack_socket", status: "warning", detail: `Slack Socket Mode check failed${socketBody.error ? `: ${socketBody.error}` : `: HTTP ${socket.status}`}` });
      return checks;
    }
    checks.push({ name: "slack_socket", status: "passed", detail: "Socket Mode URL issued" });
    return checks;
  } catch (error) {
    return [{ name: "slack_live", status: "warning", detail: `Slack live check failed: ${error instanceof Error ? error.message : String(error)}` }];
  }
}

async function gchatLiveDoctor(audience: string | undefined): Promise<{ name: string; status: "passed" | "needs_setup" | "warning"; detail: string }> {
  if (!audience) return { name: "gchat_endpoint", status: "needs_setup", detail: "Google Chat bearer audience is not configured" };
  if (/^[1-9]\d{5,29}$/.test(audience)) {
    return {
      name: "gchat_endpoint",
      status: "warning",
      detail: "Cloud project audience is valid, but endpoint reachability cannot be inferred; use the exact HTTPS /v1/adapters/gchat URL as the audience for a live rejection probe",
    };
  }
  try {
    const response = await fetch(audience, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "APP_HOME",
        eventTime: new Date().toISOString(),
        user: { name: "users/muster-doctor", type: "HUMAN" },
        space: { name: "spaces/muster-doctor" },
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (response.status === 401) {
      return { name: "gchat_endpoint", status: "passed", detail: "endpoint is reachable and rejected an unsigned request" };
    }
    if (response.ok) {
      return { name: "gchat_endpoint", status: "warning", detail: `endpoint returned HTTP ${response.status} to an unsigned request; verify Google bearer authentication before enabling the app` };
    }
    return { name: "gchat_endpoint", status: "warning", detail: `endpoint reached but returned HTTP ${response.status}; expected HTTP 401 for the unsigned probe` };
  } catch (error) {
    return { name: "gchat_endpoint", status: "warning", detail: `endpoint probe failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function slackFileUploadScopeDoctor(botToken: string, oauthScopesHeader: string | null): Promise<{ name: string; status: "passed" | "needs_setup" | "warning"; detail: string }> {
  const headerScopes = oauthScopesHeader
    ?.split(",")
    .map((scope) => scope.trim())
    .filter(Boolean);
  if (headerScopes?.length) {
    return headerScopes.includes("files:write")
      ? { name: "slack_file_upload", status: "passed", detail: "Slack bot token includes files:write for native artifact uploads" }
      : { name: "slack_file_upload", status: "warning", detail: "Slack bot token is missing files:write; add it under OAuth & Permissions, reinstall the app, then retry artifact delivery" };
  }
  try {
    const probe = await fetch("https://slack.com/api/files.getUploadURLExternal", {
      method: "POST",
      headers: { authorization: `Bearer ${botToken}`, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ filename: "muster-scope-check.txt", length: "1" }).toString(),
      signal: AbortSignal.timeout(8000),
    });
    const body = await probe.json().catch(() => ({})) as { ok?: boolean; error?: string };
    if (probe.ok && body.ok !== false) {
      return { name: "slack_file_upload", status: "passed", detail: "Slack files.getUploadURLExternal accepted the bot token; native artifact uploads are available" };
    }
    if (body.error === "missing_scope") {
      return { name: "slack_file_upload", status: "warning", detail: "Slack file upload probe returned missing_scope; add files:write to Bot Token Scopes and reinstall the app" };
    }
    return { name: "slack_file_upload", status: "warning", detail: `Slack file upload probe failed${body.error ? `: ${body.error}` : `: HTTP ${probe.status}`}` };
  } catch (error) {
    return { name: "slack_file_upload", status: "warning", detail: `Slack file upload probe failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function printChannelSetup(spec: ChannelSetupSpec, config: GatewayConfig, args: readonly string[], options: { readonly friendly?: boolean } = {}): void {
  const publicUrl = readFlag([...args], "--public-url")?.replace(/\/$/, "");
  const localBase = `http://127.0.0.1:${config.port ?? DEFAULT_GATEWAY_PORT}`;
  const base = publicUrl ?? localBase;
  if (options.friendly) console.log(`channel_connect=${spec.id} status=${channelReady(spec.id, config) ? "ready" : "needs_setup"}`);
  console.log(`channel=${spec.id} label="${spec.label}" ready=${channelReady(spec.id, config)}`);
  if (spec.route && !(spec.id === "telegram" && !publicUrl) && !(spec.id === "slack" && slackMode(config) === "socket")) console.log(`webhook_url=${base}${spec.route}`);
  if (spec.id === "telegram" && !publicUrl) console.log("ingress=background_long_poll");
  if (spec.id === "slack" && slackMode(config) === "socket") console.log("ingress=socket_mode");
  if (spec.id === "whatsapp") console.log("ingress=linked_device");
  for (const url of spec.setupUrls) console.log(`setup_url=${url}`);
  if (spec.requiredEnvFlags.length) console.log(`required_env_flags=${spec.requiredEnvFlags.join(",")}`);
  if (spec.optionalEnvFlags?.length) console.log(`optional_env_flags=${spec.optionalEnvFlags.join(",")}`);
  for (const note of spec.notes) console.log(`note=${note}`);
  console.log("next=muster channels status " + spec.id);
  if (spec.id === "telegram" && publicUrl) console.log(`webhook=muster gateway webhook telegram --public-url ${publicUrl}`);
  if (spec.id === "telegram" && !publicUrl) console.log(`start=muster gateway daemon start --with-telegram-poll --port ${config.port ?? DEFAULT_GATEWAY_PORT}`);
  else if (spec.id === "slack" && slackMode(config) === "socket") console.log(`start=muster gateway daemon start --with-slack-socket --port ${config.port ?? DEFAULT_GATEWAY_PORT}`);
  else if (spec.id === "whatsapp") console.log(`start=muster gateway daemon start --with-whatsapp --port ${config.port ?? DEFAULT_GATEWAY_PORT}`);
  else if (spec.id !== "web") console.log(`start=muster gateway daemon start --port ${config.port ?? DEFAULT_GATEWAY_PORT}`);
  if (options.friendly) console.log(`verify=muster channels doctor ${spec.id}${channelHasLiveDoctor(spec.id) ? " --live" : ""}`);
}

async function loadOrInitGatewayConfig(): Promise<GatewayConfig> {
  const result = await initGatewayConfig();
  return result.config;
}

function emptyGatewayConfig(): GatewayConfig {
  return { port: DEFAULT_GATEWAY_PORT } as GatewayConfig;
}

function gatewayCapabilityEnvironment(gateway: GatewayConfig): Record<string, string | undefined> {
  return {
    ...process.env,
    ...(gateway.frappe?.businessApis?.length
      ? { FRAPPE_BUSINESS_API_CATALOG: JSON.stringify(gateway.frappe.businessApis) }
      : {}),
    ...(gateway.frappe?.readModelPath?.trim()
      ? { FRAPPE_READ_MODEL_PATH: gateway.frappe.readModelPath.trim() }
      : {}),
    ...(gateway.frappe?.approvalSigningKey?.trim()
      ? { FRAPPE_APPROVAL_SIGNING_KEY: gateway.frappe.approvalSigningKey.trim() }
      : {}),
  };
}

function applyChannelSetup(channel: ChannelId, config: GatewayConfig, args: readonly string[]): GatewayConfig {
  if (channel === "telegram") {
    const name = readFlag([...args], "--name");
    const botToken = readSecretFlag(args, "--bot-token", "--bot-token-env");
    const secretToken = readOptionalEnvFlag(args, "--secret-token-env") ?? (botToken ? randomBytes(24).toString("hex") : undefined);
    const stream = readStreamFlag(args);
    const status = readTelegramStatusFlag(args);
    const thinking = readThinkingFlag(args);
    const busy = readBusyFlag(args);
    if (!name && !botToken && !secretToken && !stream && !status && !thinking && !busy) return config;
    return {
      ...config,
      telegram: {
        name: name ?? config.telegram?.name,
        botToken: botToken ?? config.telegram?.botToken ?? "",
        secretToken: secretToken ?? config.telegram?.secretToken,
        stream: stream ?? config.telegram?.stream,
        status: status ?? config.telegram?.status ?? (botToken ? "typing" : undefined),
        thinking: thinking ?? config.telegram?.thinking,
        busy: busy ?? config.telegram?.busy ?? (botToken ? "queue" : undefined),
      },
    };
  }
  if (channel === "slack") {
    const botToken = readSecretFlag(args, "--bot-token", "--bot-token-env");
    const appToken = readSecretFlag(args, "--app-token", "--app-token-env");
    const signingSecret = readSecretFlag(args, "--signing-secret", "--signing-secret-env");
    const requestedMode = commandLineSlackMode(args);
    const mode = requestedMode ?? (appToken ? "socket" : signingSecret ? "http" : config.slack?.mode ?? "socket");
    const stream = readStreamFlag(args);
    const status = readSlackStatusFlag(args);
    const thinking = readThinkingFlag(args);
    const busy = readBusyFlag(args);
    if (!botToken && !appToken && !signingSecret && !stream && !requestedMode && !status && !thinking && !busy) return config;
    return {
      ...config,
      slack: {
        botToken: botToken ?? config.slack?.botToken ?? "",
        appToken: appToken ?? config.slack?.appToken,
        signingSecret: signingSecret ?? config.slack?.signingSecret,
        mode,
        stream: stream ?? config.slack?.stream,
        status: status ?? config.slack?.status ?? (botToken ? "message" : undefined),
        thinking: thinking ?? config.slack?.thinking,
        busy: busy ?? config.slack?.busy ?? (botToken ? "queue" : undefined),
      },
    };
  }
  if (channel === "gchat") {
    const verificationToken = readSecretFlag(args, "--verification-token", "--verification-token-env");
    const audience = readFlag([...args], "--audience");
    if (audience && !googleChatAudienceIsValid(audience)) {
      throw new Error("--audience must be a Google Cloud project number or the exact HTTPS URL ending /v1/adapters/gchat, without credentials, query, or fragment.");
    }
    if (!verificationToken && !audience) return config;
    return {
      ...config,
      gchat: {
        ...config.gchat,
        ...(verificationToken ? { verificationToken } : {}),
        ...(audience ? { verification: { mode: "bearer" as const, audience } } : {}),
      },
    };
  }
  if (channel === "discord") {
    const botToken = readSecretFlag(args, "--bot-token", "--bot-token-env");
    const publicKey = readSecretFlag(args, "--public-key", "--public-key-env");
    if (!botToken && !publicKey) return config;
    return { ...config, discord: { botToken: botToken ?? config.discord?.botToken ?? "", publicKey: publicKey ?? config.discord?.publicKey } };
  }
  if (channel === "whatsapp") {
    const account = readFlag([...args], "--account");
    const activation = readFlag([...args], "--activation");
    if (activation && activation !== "mention" && activation !== "always") throw new Error("--activation must be mention or always.");
    const groupsFlag = readFlag([...args], "--groups");
    const groupAllowFromFlag = readFlag([...args], "--group-allow-from");
    const sessionDir = readFlag([...args], "--session-dir");
    const groups = groupsFlag === undefined ? config.whatsapp?.groups ?? [] : groupsFlag.split(",").map((value) => value.trim()).filter(Boolean);
    const groupAllowFrom = groupAllowFromFlag === undefined ? config.whatsapp?.groupAllowFrom ?? [] : groupAllowFromFlag.split(",").map((value) => value.trim()).filter(Boolean);
    return {
      ...config,
      whatsapp: {
        account: account ?? config.whatsapp?.account ?? "default",
        activation: (activation as "mention" | "always" | undefined) ?? config.whatsapp?.activation ?? "mention",
        groups,
        groupAllowFrom,
        sessionDir: sessionDir ?? config.whatsapp?.sessionDir,
      },
    };
  }
  if (channel === "whatsapp-cloud") {
    const accessToken = readSecretFlag(args, "--access-token", "--access-token-env");
    const verifyToken = readSecretFlag(args, "--verify-token", "--verify-token-env");
    const phoneNumberId = readSecretFlag(args, "--phone-number-id", "--phone-number-id-env");
    const appSecret = readSecretFlag(args, "--app-secret", "--app-secret-env");
    const apiVersion = readFlag([...args], "--api-version") ?? config["whatsapp-cloud"]?.apiVersion;
    if (!accessToken && !verifyToken && !phoneNumberId && !appSecret && !apiVersion) return config;
    return {
      ...config,
      "whatsapp-cloud": {
        accessToken: accessToken ?? config["whatsapp-cloud"]?.accessToken ?? "",
        verifyToken: verifyToken ?? config["whatsapp-cloud"]?.verifyToken ?? "",
        phoneNumberId: phoneNumberId ?? config["whatsapp-cloud"]?.phoneNumberId ?? "",
        appSecret: appSecret ?? config["whatsapp-cloud"]?.appSecret,
        apiVersion,
      },
    };
  }
  if (channel === "teams") {
    const hmacSecret = readSecretFlag(args, "--hmac-secret", "--hmac-secret-env");
    if (!hmacSecret) return config;
    return { ...config, teams: { hmacSecret } };
  }
  return config;
}

function requireChannelSpec(channel: string): ChannelSetupSpec {
  const spec = findChannelSpec(channel);
  if (!spec) throw new Error(`Unknown channel "${channel}". Run: muster channels list`);
  return spec;
}

function findChannelSpec(channel: string): ChannelSetupSpec | undefined {
  return CHANNEL_SETUP_SPECS.find((candidate) => candidate.id === channel);
}

function channelReady(channel: ChannelId, config: GatewayConfig): boolean {
  if (channel === "telegram") return Boolean(config.telegram?.botToken);
  if (channel === "slack") return Boolean(config.slack?.botToken && (slackMode(config) === "socket" ? config.slack.appToken : config.slack.signingSecret));
  if (channel === "gchat") return Boolean(googleChatAudienceIsValid(config.gchat?.verification?.audience) || config.gchat?.verificationToken);
  if (channel === "discord") return Boolean(config.discord?.botToken && config.discord.publicKey);
  if (channel === "whatsapp") return existsSync(join(whatsappSessionDir(config.whatsapp), "creds.json"));
  if (channel === "whatsapp-cloud") return Boolean(config["whatsapp-cloud"]?.accessToken && config["whatsapp-cloud"].verifyToken && config["whatsapp-cloud"].phoneNumberId && config["whatsapp-cloud"].appSecret);
  if (channel === "teams") return Boolean(config.teams?.hmacSecret);
  return Boolean(config.token);
}

function readStreamFlag(args: readonly string[]): "off" | "draft" | undefined {
  const value = readFlag([...args], "--stream");
  if (!value) return undefined;
  if (value !== "off" && value !== "draft") throw new Error("--stream must be off or draft.");
  return value;
}

function readThinkingFlag(args: readonly string[]): "off" | "progress" | undefined {
  const value = readFlag([...args], "--thinking");
  if (!value) return undefined;
  if (value !== "off" && value !== "progress") throw new Error("--thinking must be off or progress.");
  return value;
}

function readBusyFlag(args: readonly string[]): "queue" | "reject" | undefined {
  const value = readFlag([...args], "--busy");
  if (!value) return undefined;
  if (value !== "queue" && value !== "reject") throw new Error("--busy must be queue or reject.");
  return value;
}

function readTelegramStatusFlag(args: readonly string[]): "off" | "typing" | undefined {
  const value = readFlag([...args], "--status");
  if (!value) return undefined;
  if (value !== "off" && value !== "typing") throw new Error("--status must be off or typing for Telegram.");
  return value;
}

function readSlackStatusFlag(args: readonly string[]): "off" | "message" | undefined {
  const value = readFlag([...args], "--status");
  if (!value) return undefined;
  if (value !== "off" && value !== "message") throw new Error("--status must be off or message for Slack.");
  return value;
}

function readEnvFlag(args: readonly string[], flag: string): string | undefined {
  const envName = readFlag([...args], flag);
  if (!envName) return undefined;
  const value = process.env[envName];
  if (!value) throw new Error(`Environment variable ${envName} is not set.`);
  return value;
}

function readSecretFlag(args: readonly string[], directFlag: string, envFlag: string): string | undefined {
  return readFlag([...args], directFlag) ?? readEnvFlag(args, envFlag);
}

function readOptionalEnvFlag(args: readonly string[], flag: string): string | undefined {
  const envName = readFlag([...args], flag);
  if (!envName) return undefined;
  const value = process.env[envName];
  if (!value) throw new Error(`Environment variable ${envName} is not set.`);
  return value;
}

function configured(value: boolean): string {
  return value ? "configured" : "missing";
}

async function printIntegrationReadiness(): Promise<void> {
  const config = await loadConfig().catch(() => undefined);
  const gateway = await loadGatewayConfig().catch(() => undefined);
  const allPlugins = listBuiltinPlugins();
  const allMcps = listBuiltinMcpServers();
  const builtinSkillCount = listBuiltinSkills().length;
  const installedSkills = await listSkills().catch(() => []);
  const enabledPlugins = new Set(
    Object.entries(config?.plugins?.entries ?? {})
      .filter(([, entry]) => entry.enabled !== false)
      .map(([id]) => id),
  );
  const configuredMcp = new Set(Object.keys(config?.tools?.mcp?.servers ?? {}));
  const channelRows = CHANNEL_SETUP_SPECS
    .filter((spec) => spec.id !== "web")
    .map((spec) => ({ id: spec.id, ready: gateway ? channelReady(spec.id, gateway) : false, next: `muster channels ready ${spec.id}` }));
  const paPlugins = ["daily-ops", "google-workspace", "notion", "web-search", "research-lab", "artifact-studio", "security-review"];
  const pluginRows = paPlugins.flatMap((id) => {
    const plugin = listBuiltinPlugins().find((entry) => entry.id === id);
    if (!plugin) return [];
    const missing = missingSetupEnv(plugin.setup);
    return [{ id: plugin.id, enabled: enabledPlugins.has(plugin.id), missing, risk: plugin.risk }];
  });
  const mcpRows = ["google-drive", "notion", "parallel-search", "browser"].flatMap((id) => {
    const mcp = listBuiltinMcpServers().find((entry) => entry.id === id);
    if (!mcp) return [];
    return [{ id: mcp.id, configured: configuredMcp.has(mcp.id), missing: missingMcpEnv(mcp), auth: mcp.auth ?? "none" }];
  });
  const allPluginRows = allPlugins.map((plugin) => ({
    id: plugin.id,
    enabled: enabledPlugins.has(plugin.id),
    missing: missingSetupEnv(plugin.setup),
    actionability: plugin.actionability,
    risk: plugin.risk,
    pack: Boolean(plugin.packPath),
  }));
  const allMcpRows = allMcps.map((mcp) => ({
    id: mcp.id,
    configured: configuredMcp.has(mcp.id),
    missing: missingMcpEnv(mcp),
    auth: mcp.auth ?? "none",
    installable: Boolean(mcp.install),
    risk: mcp.risk,
  }));
  const readyChannels = channelRows.filter((row) => row.ready).length;
  const enabledUsefulPlugins = pluginRows.filter((row) => row.enabled).length;
  const configuredUsefulMcps = mcpRows.filter((row) => row.configured).length;
  const score = Math.min(100, Math.round(
    20
    + Math.min(2, readyChannels) * 12
    + enabledUsefulPlugins * 7
    + configuredUsefulMcps * 8
    + (config ? 10 : 0)
    + (gateway ? 8 : 0),
  ));
  const stage = score >= 80 ? "ready" : score >= 50 ? "usable" : "setup_needed";
  console.log(`integration_status=${stage} score=${score}`);
  console.log(`profile=${config ? "configured" : "missing"} gateway=${gateway ? "configured" : "missing"} memory=scoped_sqlite_fts`);
  console.log(`catalog_coverage channels=${channelRows.length} plugins=${allPlugins.length} mcps=${allMcps.length} skills=${builtinSkillCount}`);
  console.log(`readiness_matrix channels_ready=${readyChannels}/${channelRows.length} plugins_enabled=${allPluginRows.filter((row) => row.enabled).length}/${allPluginRows.length} plugin_env_satisfied=${allPluginRows.filter((row) => !row.missing.length).length}/${allPluginRows.length} plugin_packs=${allPluginRows.filter((row) => row.pack).length} setup_plan_only=${allPluginRows.filter((row) => row.actionability === "setup_plan").length}`);
  console.log(`mcp_matrix configured=${allMcpRows.filter((row) => row.configured).length}/${allMcpRows.length} installable=${allMcpRows.filter((row) => row.installable && !row.missing.length).length} needs_env=${allMcpRows.filter((row) => row.missing.length).length} needs_oauth=${allMcpRows.filter((row) => row.auth === "oauth" && !row.configured).length} skills_enabled=${installedSkills.filter((skill) => skill.status === "active").length}/${builtinSkillCount}`);
  const pluginBlockers = allPluginRows.filter((row) => row.missing.length).slice(0, 5);
  const mcpBlockers = allMcpRows.filter((row) => row.missing.length || (row.auth === "oauth" && !row.configured)).slice(0, 5);
  if (pluginBlockers.length || mcpBlockers.length) {
    console.log("top_blockers");
    for (const row of pluginBlockers) console.log(`  plugin=${row.id} missing=${row.missing.join("|")} risk=${row.risk} next="muster plugins setup ${row.id}"`);
    for (const row of mcpBlockers) {
      const reason = row.missing.length ? `missing=${row.missing.join("|")}` : "oauth=not_configured";
      console.log(`  mcp=${row.id} ${reason} risk=${row.risk} next="muster mcp ${row.installable && !row.missing.length ? "install" : "check"} ${row.id}"`);
    }
  }
  console.log("channels_optional");
  for (const row of channelRows) console.log(`  ${row.id}\t${row.ready ? "ready" : "needs_setup"}\t${row.ready ? "muster gateway daemon start" : row.next}`);
  console.log("daily_life_packs");
  for (const row of pluginRows) {
    const status = row.enabled ? "enabled" : row.missing.length ? `needs_env:${row.missing.join("|")}` : "available";
    const riskFlag = row.risk === "high" ? " --allow-high-risk" : "";
    console.log(`  ${row.id}\t${status}\tmuster plugins ${row.enabled ? "setup" : "enable"} ${row.id}${riskFlag}`);
  }
  console.log("mcp_connectors");
  for (const row of mcpRows) {
    const status = row.configured ? "configured" : row.missing.length ? `needs_env:${row.missing.join("|")}` : row.auth === "oauth" ? "needs_oauth" : "installable";
    const auth = row.auth === "oauth" && row.configured ? `; muster mcp oauth setup ${row.id}` : "";
    console.log(`  ${row.id}\t${status}\tmuster mcp install ${row.id}${auth}`);
  }
  console.log("suggested_path");
  const steps: string[] = [];
  if (!gateway) steps.push("muster gateway init");
  steps.push(!readyChannels ? "muster channels ready telegram" : "channel ready; add another surface only when you need it");
  const firstPlugin = pluginRows.find((row) => !row.enabled);
  if (firstPlugin) steps.push(`muster plugins enable ${firstPlugin.id}${firstPlugin.risk === "high" ? " --allow-high-risk" : ""}`);
  const firstMcp = mcpRows.find((row) => !row.configured);
  if (firstMcp) steps.push(`muster mcp install ${firstMcp.id}`);
  steps.forEach((step, index) => console.log(`  ${index + 1}. ${step}`));
  console.log("guardrails=draft_first_for_channels, scoped_memory, explicit_mcp_auth, no_secret_echo");
}

async function integrationsCommand(args: string[]): Promise<void> {
  const action = args[0] ?? "list";
  if (action !== "list" && action !== "guide" && action !== "status" && action !== "workflow" && action !== "setup" && action !== "verify" && action !== "enable" && action !== "sample" && action !== "inherited") {
    throw new Error("Usage: muster integrations [list|inherited|guide|status|workflow|setup|verify|enable|sample <plugin|mcp|channel>]");
  }
  if (action === "inherited") {
    // Read-only inventory of what codex/claude already give this machine, with
    // the exact enable/auth line for each entry. Muster prints; the human runs.
    const ecosystem = await inheritedEcosystem({ refresh: args.includes("--refresh") });
    for (const line of renderInheritedIntegrationsTable(ecosystem)) console.log(line);
    return;
  }
  if (action === "status") {
    await printIntegrationReadiness();
    return;
  }
  if (action === "workflow") {
    const target = args[1];
    if (!target) throw new Error("Usage: muster integrations workflow <plugin|mcp|channel>");
    await printIntegrationWorkflow(target);
    return;
  }
  if (action === "setup" || action === "verify" || action === "enable" || action === "sample") {
    const target = args[1];
    if (!target) throw new Error(`Usage: muster integrations ${action} <plugin|mcp|channel>`);
    await runIntegrationAction(action, target);
    return;
  }
  const config = await loadConfig().catch(() => undefined);
  const gateway = await loadGatewayConfig().catch(() => undefined);
  const enabledPlugins = new Set(
    Object.entries(config?.plugins?.entries ?? {})
      .filter(([, entry]) => entry.enabled !== false)
      .map(([id]) => id),
  );
  const configuredMcp = new Set(Object.keys(config?.tools?.mcp?.servers ?? {}));

  console.log("Muster integrations");
  console.log("Use these as backends for chat apps, webapps, agents, and local workflows.");
  console.log("");
  console.log("kind\tid\tstatus\tnext");
  for (const spec of CHANNEL_SETUP_SPECS) {
    const ready = gateway ? channelReady(spec.id, gateway) : false;
    const next = ready ? `muster gateway daemon start --port ${gateway?.port ?? DEFAULT_GATEWAY_PORT}` : `muster channels ready ${spec.id}`;
    console.log(`channel\t${spec.id}\t${ready ? "ready" : "needs setup"}\t${next}`);
  }

  const featuredPlugins = ["web-search", "github", "google-workspace", "google-calendar", "notion", "figma", "supabase", "heygen", "product-design", "sales", "authenticated-app-reuse", "artifact-studio", "daily-ops", "data-analytics", "security-review", "research-lab"];
  for (const id of featuredPlugins) {
    const plugin = listBuiltinPlugins().find((entry) => entry.id === id || entry.aliases?.includes(id));
    if (!plugin) continue;
    const missing = missingSetupEnv(plugin.setup);
    const enabled = enabledPlugins.has(plugin.id);
    const status = enabled ? "enabled" : missing.length ? `needs ${missing.join(",")}` : "available";
    const riskFlag = plugin.risk === "high" ? " --allow-high-risk" : "";
    console.log(`plugin\t${plugin.id}\t${status}\tmuster plugins ${enabled ? "setup" : "enable"} ${plugin.id}${riskFlag}`);
  }

  for (const mcp of listBuiltinMcpServers()) {
    const missing = missingMcpEnv(mcp);
    const configured = configuredMcp.has(mcp.id);
    const oauthHint = mcp.auth === "oauth" && configured ? `; auth: muster mcp oauth setup ${mcp.id}` : "";
    const status = configured ? "configured" : missing.length ? `needs ${missing.join(",")}` : mcp.auth === "oauth" ? "needs OAuth" : "installable";
    console.log(`mcp\t${mcp.id}\t${status}\tmuster mcp install ${mcp.id}${oauthHint}`);
  }

  console.log("");
  console.log("For non-technical setup, start with a channel, then add capabilities:");
  console.log("1. muster integrations");
  console.log("2. muster channels ready gchat --audience https://your-domain.example/v1/adapters/gchat --no-start");
  console.log("3. muster plugins enable web-search");
  console.log("4. muster mcp install parallel-search");
}

async function runIntegrationAction(action: "setup" | "verify" | "enable" | "sample", target: string): Promise<void> {
  const channel = findChannelSpec(target);
  if (channel) {
    await runChannelIntegrationAction(action, channel);
    return;
  }
  const plugin = listBuiltinPlugins().find((entry) => entry.id === target || entry.aliases?.includes(target));
  if (plugin) {
    await runPluginIntegrationAction(action, plugin);
    return;
  }
  const mcp = findBuiltinMcpEntry(target);
  if (mcp) {
    await runMcpIntegrationAction(action, mcp);
    return;
  }
  throw new Error(`Unknown integration "${target}". Run: muster integrations`);
}

async function runChannelIntegrationAction(action: "setup" | "verify" | "enable" | "sample", spec: ChannelSetupSpec): Promise<void> {
  console.log(`integration_action=${action} target=${spec.id} kind=channel`);
  if (action === "setup") {
    await channelsCommand(["setup", spec.id]);
    const gateway = await loadGatewayConfig().catch(() => undefined);
    if (!gateway || !channelReady(spec.id, gateway)) {
      console.log(`setup_required=${channelReadySetupCommand(spec.id)}`);
      console.log(`integration_next=${channelReadySetupCommand(spec.id)}`);
      return;
    }
    console.log(`integration_next=muster integrations verify ${spec.id}`);
    return;
  }
  if (action === "verify") {
    await channelsCommand(["doctor", spec.id, ...(channelHasLiveDoctor(spec.id) ? ["--live"] : [])]);
    const gateway = await loadGatewayConfig().catch(() => undefined);
    console.log(`integration_next=muster integrations ${gateway && channelReady(spec.id, gateway) ? "sample" : "setup"} ${spec.id}`);
    return;
  }
  if (action === "enable") {
    const gateway = await loadGatewayConfig().catch(() => undefined);
    if (!gateway || !channelReady(spec.id, gateway)) {
      console.log(`status=blocked next="muster channels ready ${spec.id}"`);
      console.log("reason=channel setup is incomplete; gateway was not started");
      console.log(`integration_next=muster integrations setup ${spec.id}`);
      return;
    }
    console.log(`status=ready start="muster gateway daemon start --port ${gateway.port ?? DEFAULT_GATEWAY_PORT}"`);
    console.log(`integration_next=muster integrations sample ${spec.id}`);
    return;
  }
  await channelsCommand(["simulate", spec.id, "--message", `hello from ${spec.id}`]);
  const gateway = await loadGatewayConfig().catch(() => undefined);
  console.log(`integration_next=muster integrations ${gateway && channelReady(spec.id, gateway) ? "enable" : "setup"} ${spec.id}`);
}

async function runPluginIntegrationAction(action: "setup" | "verify" | "enable" | "sample", plugin: BuiltinPluginCatalogEntry): Promise<void> {
  console.log(`integration_action=${action} target=${plugin.id} kind=plugin`);
  if (action === "setup") {
    await pluginsCommand(["setup", plugin.id]);
    console.log(`integration_next=muster integrations verify ${plugin.id}`);
    return;
  }
  if (action === "verify") {
    await pluginsCommand(["check", plugin.id]);
    const missing = missingSetupEnv(plugin.setup);
    console.log(`integration_next=muster integrations ${missing.length ? "setup" : "enable"} ${plugin.id}`);
    return;
  }
  if (action === "enable") {
    await pluginsCommand(["enable", plugin.id]);
    console.log(`integration_next=muster integrations sample ${plugin.id}`);
    return;
  }
  const firstChannel = plugin.setup?.channels?.[0];
  if (firstChannel) {
    await channelsCommand(["simulate", firstChannel, "--message", `hello from ${plugin.id}`]);
    console.log(`integration_next=muster integrations verify ${plugin.id}`);
    return;
  }
  const firstMcp = plugin.setup?.defaultMcpServers?.[0] ?? plugin.setup?.mcpServers?.[0];
  if (firstMcp) {
    await runMcpSample(firstMcp);
    console.log(`integration_next=muster integrations verify ${plugin.id}`);
    return;
  }
  if (plugin.id === "artifact-studio") {
    const out = join(dataDir(), "samples", "artifact-studio-brief.docx");
    await artifactsCommand([
      "create",
      "--format", "docx",
      "--title", "Muster Artifact Studio Sample",
      "--summary", "A verified local DOCX draft created through the integration sample workflow.",
      "--out", out,
    ]);
    console.log(`sample_artifact=${out}`);
    console.log(`integration_next=muster artifacts contract --formats docx,xlsx,pptx,pdf`);
    return;
  }
  await pluginsCommand(["check", plugin.id]);
  console.log(`integration_next=muster integrations verify ${plugin.id}`);
}

async function runMcpIntegrationAction(action: "setup" | "verify" | "enable" | "sample", entry: BuiltinMcpCatalogEntry): Promise<void> {
  console.log(`integration_action=${action} target=${entry.id} kind=mcp`);
  if (action === "setup" || action === "enable") {
    await mcpCommand(["install", entry.id]);
    console.log(`integration_next=muster integrations verify ${entry.id}`);
    return;
  }
  if (action === "verify") {
    await runMcpVerify(entry.id);
    const config = await loadConfig().catch(() => undefined);
    console.log(`integration_next=muster integrations ${config?.tools?.mcp?.servers?.[entry.id] ? "sample" : "setup"} ${entry.id}`);
    return;
  }
  await runMcpSample(entry.id);
  console.log(`integration_next=muster integrations verify ${entry.id}`);
}

async function runMcpVerify(id: string): Promise<void> {
  const config = await loadConfig().catch(() => undefined);
  if (config?.tools?.mcp?.servers?.[id]) {
    await mcpCommand(["test", id]);
    return;
  }
  await mcpCommand(["check", id]);
}

async function runMcpSample(id: string): Promise<void> {
  await runMcpVerify(id);
}

async function printIntegrationWorkflow(target: string): Promise<void> {
  const channel = findChannelSpec(target);
  if (channel) {
    await printChannelIntegrationWorkflow(channel);
    return;
  }
  const plugin = listBuiltinPlugins().find((entry) => entry.id === target || entry.aliases?.includes(target));
  if (plugin) {
    await printPluginIntegrationWorkflow(plugin);
    return;
  }
  const mcp = findBuiltinMcpEntry(target);
  if (mcp) {
    await printMcpIntegrationWorkflow(mcp);
    return;
  }
  throw new Error(`Unknown integration "${target}". Run: muster integrations`);
}

async function printChannelIntegrationWorkflow(spec: ChannelSetupSpec): Promise<void> {
  const gateway = await loadGatewayConfig().catch(() => ({ port: DEFAULT_GATEWAY_PORT }) as GatewayConfig);
  const ready = channelReady(spec.id, gateway);
  const missing = channelMissingSetup(spec.id, gateway);
  console.log(`integration_workflow=${spec.id} kind=channel ready=${ready}`);
  console.log(`impact=turns ${spec.label} messages into governed Muster runs with scoped memory, policy gates, token ledger, and draft/send controls`);
  console.log(`auth=${channelAuthModeForConfig(spec.id, gateway)} missing=${missing.length ? missing.join(",") : "-"}`);
  console.log(`setup=muster channels ready ${spec.id}`);
  console.log(`verify=muster channels doctor ${spec.id}${channelHasLiveDoctor(spec.id) ? " --live" : ""}`);
  console.log(`enable=${ready ? `muster gateway daemon start --port ${gateway.port ?? DEFAULT_GATEWAY_PORT}` : `muster channels ready ${spec.id}`}`);
  console.log(`sample=muster channels simulate ${spec.id} --message "hello from ${spec.id}"`);
  console.log(`failure_behavior=${ready ? "doctor reports warnings without printing secrets" : "blocked until required setup is present; local simulation still works"}`);
  for (const url of spec.setupUrls) console.log(`setup_url=${url}`);
  console.log("steps=pick -> explain impact -> authenticate/setup -> verify -> enable gateway -> run local sample");
  console.log("guardrails=no_secret_echo, scoped_memory, token_ledger, approval_required_for_mutations");
}

function channelReadySetupCommand(channel: ChannelId): string {
  if (channel === "telegram") return "muster channels ready telegram --name <bot-name> --bot-token <bot-token>";
  if (channel === "slack") return "muster channels ready slack --bot-token <xoxb-token> --app-token <xapp-token>";
  if (channel === "gchat") return "muster channels ready gchat --audience https://your-domain.example/v1/adapters/gchat";
  if (channel === "discord") return "muster channels ready discord --bot-token <bot-token> --public-key <application-public-key>";
  if (channel === "whatsapp") return "muster channels setup whatsapp --account default && muster channels login whatsapp";
  if (channel === "whatsapp-cloud") return "muster channels ready whatsapp-cloud --access-token <access-token> --verify-token <verify-token> --phone-number-id <phone-number-id> --app-secret <app-secret>";
  if (channel === "teams") return "muster channels ready teams --hmac-secret <hmac-secret>";
  return "muster channels ready web";
}

async function printPluginIntegrationWorkflow(plugin: BuiltinPluginCatalogEntry): Promise<void> {
  const config = await loadConfig().catch(() => undefined);
  const enabled = Boolean(config?.plugins?.entries?.[plugin.id] && config.plugins?.entries?.[plugin.id]?.enabled !== false);
  const missing = missingSetupEnv(plugin.setup);
  const riskFlag = plugin.risk === "high" ? " --allow-high-risk" : "";
  const firstChannel = plugin.setup?.channels?.[0];
  const firstMcp = plugin.setup?.defaultMcpServers?.[0] ?? plugin.setup?.mcpServers?.[0];
  const sample = firstChannel
    ? `muster channels simulate ${firstChannel} --message "hello from ${plugin.id}"`
    : firstMcp
      ? `muster mcp check ${firstMcp}`
      : plugin.id === "artifact-studio"
        ? `muster integrations sample ${plugin.id}`
      : plugin.packPath
        ? `muster plugins check ${plugin.id}`
        : `muster plugins setup ${plugin.id}`;
  console.log(`integration_workflow=${plugin.id} kind=plugin enabled=${enabled}`);
  console.log(`impact=${plugin.description}`);
  console.log(`risk=${plugin.risk} action=${plugin.actionability} source=${plugin.source}`);
  console.log(`readiness=${plugin.packPath ? `pack:${plugin.packPath}` : plugin.actionability === "setup_plan" ? "setup_plan_only" : "policy_or_external_setup"}`);
  console.log(`auth=${missing.length ? `missing_env:${missing.join(",")}` : "no_missing_env_detected"}`);
  console.log(`setup=muster plugins setup ${plugin.id}`);
  console.log(`verify=muster plugins check ${plugin.id}`);
  console.log(`enable=muster plugins enable ${plugin.id}${riskFlag}`);
  if (firstChannel) console.log(`related_channel=muster channels ready ${firstChannel}`);
  if (firstMcp) console.log(`related_mcp=muster mcp ${missingMcpEnv(findBuiltinMcpEntry(firstMcp)).length ? "check" : "install"} ${firstMcp}`);
  if (plugin.id === "artifact-studio") console.log("related_artifacts=muster artifacts contract; muster artifacts plan --format pptx --destination google-drive --polished; muster artifacts verify <file>");
  console.log(`sample=${sample}`);
  console.log(`failure_behavior=${missing.length ? "setup/check reports missing env and does not enable credentials implicitly" : "check/setup reports readiness, warnings, or setup-only status before execution"}`);
  for (const url of plugin.setup?.setupUrls ?? []) console.log(`setup_url=${url}`);
  console.log("steps=pick -> explain impact -> authenticate/setup -> verify -> enable policy -> run sample");
  console.log("guardrails=high_risk_requires_allow_flag, no_secret_echo, scoped_memory, token_ledger, explicit_provider_or_mcp_auth");
}

async function printMcpIntegrationWorkflow(entry: BuiltinMcpCatalogEntry): Promise<void> {
  const config = await loadConfig().catch(() => undefined);
  const configured = Boolean(config?.tools?.mcp?.servers?.[entry.id]);
  const missing = missingMcpEnv(entry);
  const installable = Boolean(entry.install && !missing.length && mcpConfigFromCatalogEntry(entry));
  const authStep = entry.auth === "oauth"
    ? configured
      ? `muster mcp oauth setup ${entry.id}`
      : `muster mcp install ${entry.id} && muster mcp oauth setup ${entry.id}`
    : missing.length
      ? `export ${missing[0].split("|")[0]}=...`
      : "no interactive auth required";
  console.log(`integration_workflow=${entry.id} kind=mcp configured=${configured}`);
  console.log(`impact=${entry.description}`);
  console.log(`risk=${entry.risk} auth=${entry.auth ?? "none"} category=${entry.category}`);
  console.log(`readiness=${configured ? "configured" : missing.length ? "needs_env" : installable ? "installable" : "manual_setup"}`);
  console.log(`authenticate=${authStep}`);
  console.log(`setup=${configured ? `muster mcp status ${entry.id}` : installable ? `muster mcp install ${entry.id}` : entry.commandHint}`);
  console.log(`verify=${configured ? `muster mcp test ${entry.id}` : `muster mcp check ${entry.id}`}`);
  console.log(`enable=${configured ? "already_configured" : installable ? `muster mcp install ${entry.id}` : entry.commandHint}`);
  console.log(`sample=${configured ? `muster mcp test ${entry.id}` : `muster mcp check ${entry.id}`}`);
  console.log(`failure_behavior=${missing.length ? "blocked until required env is present; no token is printed" : "failed server startup is isolated to this MCP and shown by test/check"}`);
  if (entry.defaultTools?.length) console.log(`default_tools=${entry.defaultTools.join(",")}`);
  for (const url of entry.setupUrls ?? []) console.log(`setup_url=${url}`);
  console.log("steps=pick -> explain impact -> authenticate/setup -> verify -> enable -> run sample");
  console.log("guardrails=explicit_auth, tool_allowlists, scoped_memory, token_ledger, isolated_mcp_failures");
}

async function pairingCommand(commandArgs: string[]): Promise<void> {
  const [action, code] = commandArgs;
  if (action === "list") {
    const store = await loadPairings();
    if (!store.pending.length && !store.paired.length) {
      console.log("No pairings yet. Senders appear here after their first gateway message.");
      return;
    }
    for (const pending of store.pending) {
      console.log(`pending code=${pending.code} surface=${pending.surfaceId} sender=${pending.senderId} requested=${pending.requestedAt}`);
    }
    for (const paired of store.paired) {
      const identity = paired.identity?.provider === "frappe"
        ? ` frappe_user=${paired.identity.user} employee=${paired.identity.employee ?? "-"} roles=${paired.identity.roles.join(",") || "-"} site=${paired.identity.site}`
        : "";
      console.log(`paired  id=${paired.pairingId} surface=${paired.surfaceId} sender=${paired.senderId} approved=${paired.approvedAt}${identity}`);
    }
    return;
  }
  if (action === "approve" && code) {
    const frappeUser = readFlag(commandArgs, "--frappe-user");
    const frappeSite = readFlag(commandArgs, "--frappe-site");
    const frappeTokenEnv = readFlag(commandArgs, "--frappe-token-env") ?? readFlag(commandArgs, "--frappe-api-token-env");
    const employee = readFlag(commandArgs, "--employee");
    const employeeName = readFlag(commandArgs, "--employee-name");
    const department = readFlag(commandArgs, "--department");
    const company = readFlag(commandArgs, "--company");
    const roles = readFlags(commandArgs, "--role").flatMap((role) => role.split(",")).map((role) => role.trim()).filter(Boolean);
    if (!frappeSite && (frappeUser || frappeTokenEnv)) {
      throw new Error("Frappe identity pairing requires --frappe-site with --frappe-token-env or --frappe-user.");
    }
    const identity = frappeTokenEnv && frappeSite
      ? await resolveFrappePairingIdentityFromTokenEnv(frappeSite, frappeTokenEnv)
      : frappeUser && frappeSite
        ? buildOperatorAssertedFrappeIdentity({ site: frappeSite, user: frappeUser, employee, employeeName, roles, department, company })
        : undefined;
    const paired = await approvePairing(code, process.cwd(), identity);
    console.log(`paired=${paired.pairingId}`);
    console.log(`surface=${paired.surfaceId}`);
    console.log(`sender=${paired.senderId}`);
    if (paired.identity?.provider === "frappe") {
      console.log(`frappe_user=${paired.identity.user}`);
      console.log(`employee=${paired.identity.employee ?? "-"}`);
      console.log(`roles=${paired.identity.roles.join(",") || "-"}`);
      console.log(`site=${paired.identity.site}`);
      console.log(`identity_proof=${paired.identity.authMode}`);
    }
    return;
  }
  throw new Error("Usage: muster pairing list | approve <code> [--frappe-site URL --frappe-token-env ENV | --frappe-user USER] [--employee EMP --role ROLE]");
}

function buildOperatorAssertedFrappeIdentity(input: {
  readonly site: string;
  readonly user: string;
  readonly employee?: string;
  readonly employeeName?: string;
  readonly roles: readonly string[];
  readonly department?: string;
  readonly company?: string;
}): Omit<PairedIdentity, "resolvedAt"> {
  return withoutUndefined({
    provider: "frappe" as const,
    site: input.site,
    user: input.user,
    employee: input.employee,
    employeeName: input.employeeName,
    roles: input.roles,
    department: input.department,
    company: input.company,
    authMode: "operator_asserted" as const,
  });
}

async function resolveFrappePairingIdentityFromTokenEnv(site: string, envName: string): Promise<Omit<PairedIdentity, "resolvedAt">> {
  const token = process.env[envName];
  if (!token) throw new Error(`Missing ${envName}. Set it to a Frappe OAuth bearer token or API key:secret; the token will not be printed or stored.`);
  const authHeader = token.includes(":") ? `token ${token}` : `Bearer ${token}`;
  const request = async (path: string): Promise<Record<string, unknown>> => {
    const response = await fetch(`${site.replace(/\/$/, "")}${path}`, {
      headers: { Authorization: authHeader, Accept: "application/json" },
    });
    const text = await response.text();
    let parsed: unknown = {};
    try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = {}; }
    if (!response.ok) throw new Error(`Frappe identity request failed: HTTP ${response.status} ${extractCliFrappeMessage(parsed, text)}`);
    return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : {};
  };
  const userPayload = await request("/api/method/frappe.auth.get_logged_user");
  const user = typeof userPayload.message === "string" && userPayload.message.trim() ? userPayload.message.trim() : "";
  if (!user) throw new Error("Frappe get_logged_user returned no user for this token.");
  const employeePayload = await request(`/api/resource/Employee?${new URLSearchParams({
    fields: JSON.stringify(["name", "employee_name", "department", "company", "designation", "status"]),
    filters: JSON.stringify([["user_id", "=", user]]),
    limit_page_length: "1",
  }).toString()}`).catch(() => ({}));
  const employeeRows = getArrayField(employeePayload, "data");
  const employeeRow = typeof employeeRows[0] === "object" && employeeRows[0] !== null
    ? employeeRows[0] as Record<string, unknown>
    : undefined;
  const rolesPayload = await request(`/api/method/frappe.core.doctype.user.user.get_roles?${new URLSearchParams({ user }).toString()}`).catch(async () => {
    const rows = await request(`/api/resource/Has%20Role?${new URLSearchParams({
      fields: JSON.stringify(["role"]),
      filters: JSON.stringify([["parent", "=", user]]),
      limit_page_length: "200",
    }).toString()}`).catch(() => ({}));
    return { message: getArrayField(rows, "data").map((row: unknown) => typeof row === "object" && row !== null ? (row as Record<string, unknown>).role : undefined).filter(Boolean) };
  });
  const roles = Array.isArray(rolesPayload.message) ? [...new Set(rolesPayload.message.map(String).filter(Boolean))].sort() : [];
  return withoutUndefined({
    provider: "frappe" as const,
    site,
    user,
    employee: typeof employeeRow?.name === "string" ? employeeRow.name : undefined,
    employeeName: typeof employeeRow?.employee_name === "string" ? employeeRow.employee_name : undefined,
    roles,
    department: typeof employeeRow?.department === "string" ? employeeRow.department : undefined,
    company: typeof employeeRow?.company === "string" ? employeeRow.company : undefined,
    authMode: token.includes(":") ? "api_token" as const : "oauth_bearer" as const,
  });
}

function extractCliFrappeMessage(body: unknown, rawText: string): string {
  if (typeof body === "object" && body !== null) {
    const record = body as Record<string, unknown>;
    if (typeof record.exception === "string") return record.exception;
    if (typeof record.message === "string") return record.message;
  }
  return rawText.slice(0, 200);
}

function getArrayField(value: unknown, key: string): unknown[] {
  return typeof value === "object" && value !== null && Array.isArray((value as Record<string, unknown>)[key])
    ? (value as Record<string, unknown>)[key] as unknown[]
    : [];
}

function withoutUndefined<T extends Record<string, unknown>>(input: T): T {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as T;
}


async function sessionsCommand(commandArgs: string[]): Promise<void> {
  const [first, ...tail] = commandArgs;
  const action = first?.startsWith("--") ? undefined : first;
  const rest = action === undefined ? commandArgs : tail;
  const store = openSessionStore();
  try {
    if (action === "search") {
      const query = stripFlags(rest, ["--limit"]).filter((entry) => entry !== "--all").join(" ").trim();
      if (!query) throw new Error('Usage: muster sessions search "query" [--limit N]');
      const result = store.search({ query, limit: readNumberFlag(rest, "--limit"), ...(rest.includes("--all") ? {} : { workspaceCwd: process.cwd() }) });
      if (result.shape !== "discover") return;
      console.log(`session_backend=${store.backend}`);
      console.log(`query=${JSON.stringify(query)} hits=${result.hits.length}`);
      if (!result.hits.length) { console.log("No matching sessions."); return; }
      for (const hit of result.hits) {
        console.log(`session=${hit.sessionId} title=${JSON.stringify(hit.title || "(untitled)")} message=${hit.messageId} window=${hit.window.length} next=${JSON.stringify(`muster sessions show ${hit.sessionId}`)}`);
        console.log(`snippet=${JSON.stringify(hit.snippet)}`);
      }
      return;
    }
    if (action === "show" && rest[0]) {
      const result = store.search({ sessionId: rest[0] });
      if (result.shape !== "read") return;
      const activeMessages = result.head.length + result.tail.length + result.omitted;
      console.log(`session_backend=${store.backend}`);
      console.log(`session=${result.session.id} title=${JSON.stringify(result.session.title || "(untitled)")} channel=${result.session.channel} peer=${result.session.peer} workspace=${JSON.stringify(result.session.workspaceCwd ?? "(global)")}`);
      console.log(`tokens_in=${result.session.tokensIn} tokens_out=${result.session.tokensOut} cost_usd=${result.session.costUsd.toFixed(4)} active_messages=${activeMessages} omitted=${result.omitted}`);
      for (const message of [...result.head, ...(result.omitted ? [{ role: "system", content: `… ${result.omitted} messages omitted …` } as { role: string; content: string }] : []), ...result.tail]) {
        console.log(`  ${message.role.padEnd(9)} ${message.content.slice(0, 100)}`);
      }
      return;
    }
    if (action === "recent" || action === undefined) {
      const limit = readNumberFlag(rest, "--limit") ?? 15;
      const allResult = store.search({ limit: 5000 });
      const result = rest.includes("--all") ? store.search({ limit }) : store.search({ limit, workspaceCwd: process.cwd() });
      if (result.shape !== "browse" || allResult.shape !== "browse") return;
      const here = allResult.sessions.filter((session) => session.workspaceCwd === process.cwd()).length;
      console.log(`session_backend=${store.backend}`);
      console.log(`scope=(${here} here · ${allResult.sessions.length} total)`);
      console.log(`sessions=${result.sessions.length}`);
      for (const session of result.sessions) {
        console.log(`session=${session.id} created=${session.createdAt.slice(0, 16)} title=${JSON.stringify(session.title || "(untitled)")} channel=${session.channel} peer=${session.peer} workspace=${JSON.stringify(session.workspaceCwd ?? "(global)")} tokens_in=${session.tokensIn} tokens_out=${session.tokensOut} cost_usd=${session.costUsd.toFixed(4)} next=${JSON.stringify(`muster sessions show ${session.id}`)}`);
      }
      return;
    }
    throw new Error("Usage: muster sessions search|show|recent [--all]");
  } finally {
    store.close();
  }
}

async function skillsCommand(commandArgs: string[]): Promise<void> {
  const [action, ...rest] = commandArgs;
  if (action === "catalog") {
    for (const skill of listBuiltinSkills()) {
      console.log(formatBuiltinSkillCatalogLine(skill));
    }
    return;
  }
  if (action === "enable" && rest[0]) {
    const skill = await enableBuiltinSkill(rest[0]);
    console.log(`enabled skill=${skill.id} source=${skill.source} risk=${skill.risk}`);
    console.log(`category=${skill.category} invocation=user-invocable dispatch=prompt`);
    console.log(`tags=${skill.tags.join(",") || "-"}`);
    console.log(`requires=${skill.requires?.join(",") || "-"}`);
    console.log(`guardrail=check prerequisites first; keep scope narrow; confirm credentials, network, destructive writes, and broad filesystem access`);
    console.log(`next="muster skills view ${skill.id}"`);
    return;
  }
  if (action === "disable" && rest[0]) {
    const skill = await disableBuiltinSkill(rest[0]);
    console.log(`disabled skill=${skill.id}`);
    return;
  }
  if (action === "list" || action === undefined) {
    const skills = await listSkills();
    if (!skills.length) {
      const catalog = listBuiltinSkills();
      const highRisk = catalog.filter((skill) => skill.risk === "high").length;
      console.log("No skills enabled for this profile yet.");
      console.log(`catalog=${catalog.length} high_risk=${highRisk}`);
      console.log("next=muster skills catalog");
      console.log("enable=muster skills enable <id>");
      console.log("view=muster skills view <id>");
      return;
    }
    for (const skill of skills) {
      console.log(`${skill.status.padEnd(10)} ${skill.name.padEnd(28)} ${skill.description.slice(0, 60)}`);
    }
    return;
  }
  if (action === "view" && rest[0]) {
    const skill = await viewSkill(rest[0]);
    console.log(`# ${skill.name} (${skill.status}, v${skill.version})\n${skill.description}\n\n${skill.body}`);
    return;
  }
  if (action === "index") {
    const path = skillsIndexPath();
    let index: { skills?: Record<string, { digest?: string; status?: string; version?: string }> };
    try {
      index = JSON.parse(await readFile(path, "utf8")) as typeof index;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        console.log("No skill index yet.");
        return;
      }
      throw error;
    }
    const entries = Object.entries(index.skills ?? {}).sort(([left], [right]) => left.localeCompare(right));
    console.log(`path=${path}`);
    if (!entries.length) {
      console.log("No indexed skills.");
      return;
    }
    for (const [name, entry] of entries) {
      console.log(`${entry.status ?? "unknown"} ${name} v${entry.version ?? "unknown"} ${entry.digest ?? "digest=missing"}`);
    }
    return;
  }
  if (action === "curate") {
    const result = await curateSkills();
    console.log(`staled: ${result.staled.join(", ") || "none"}; archived: ${result.archived.join(", ") || "none"}`);
    return;
  }
  if (action === "promote") {
    console.log("Promotion is eval-gated: a skill becomes active only after `muster evolve` converges on its suite.");
    console.log("This is intentional — skills cannot self-certify. See docs/FEATURE_PARITY_PLAN.md.");
    return;
  }
  throw new Error("Usage: muster skills list|catalog|enable <id>|disable <id>|view <name>|index|curate");
}

function formatBuiltinSkillCatalogLine(skill: BuiltinSkillCatalogEntry): string {
  const tags = skill.tags.length ? ` tags=${skill.tags.slice(0, 5).join(",")}` : "";
  const requires = skill.requires?.length ? ` requires=${skill.requires.join(",")}` : " requires=-";
  return `${skill.id.padEnd(28)} ${skill.source.padEnd(9)} ${skill.category.padEnd(22)} risk=${skill.risk.padEnd(6)} invoke=prompt${requires}${tags} ${skill.description}`;
}

async function pulseCommand(commandArgs: string[]): Promise<void> {
  const [action, ...rest] = commandArgs;
  if (action === "add") {
    const positional = stripFlags(rest, ["--kind", "--prompt", "--max-tokens"]);
    const cron = positional[0];
    if (!cron) throw new Error('Usage: muster pulse add "<cron>" [--kind heartbeat|task] [--prompt "..."] [--max-tokens N]');
    const pulse = await addPulse({
      cron,
      kind: (readFlag(rest, "--kind") as "heartbeat" | "task" | undefined) ?? "heartbeat",
      prompt: readFlag(rest, "--prompt"),
      maxTokensPerDay: readNumberFlag(rest, "--max-tokens"),
    });
    console.log(`${pulse.id} [${pulse.cron}] ${pulse.kind} budget=${pulse.maxTokensPerDay}/day`);
    console.log("No daemon. Add to external cron: * * * * * cd <repo> && pnpm hc pulse run-due");
    if (pulse.kind === "heartbeat") console.log("Heartbeats need a .muster/PULSE.md checklist; empty checklist = zero API calls.");
    return;
  }
  if (action === "list" || action === undefined) {
    const pulses = await listPulses();
    if (!pulses.length) { console.log("No pulses."); return; }
    for (const pulse of pulses) {
      console.log(`${pulse.id} [${pulse.cron}] ${pulse.kind}${pulse.pausedReason ? `  PAUSED: ${pulse.pausedReason}` : ""}`);
    }
    return;
  }
  if (action === "resume" && rest[0]) {
    await resumePulse(rest[0]);
    console.log(`Resumed ${rest[0]}`);
    return;
  }
  if (action === "run-due") {
    const config = await loadConfig();
    const results = await runDuePulses(config);
    if (!results.length) { console.log("No pulses due."); return; }
    for (const result of results) {
      console.log(`${result.pulse.id}: ${result.action}${result.detail ? ` (${result.detail})` : ""}`);
      if (result.action === "surfaced" && result.text) console.log(`  ${result.text.slice(0, 200)}`);
    }
    return;
  }
  throw new Error("Usage: muster pulse add|list|resume|run-due");
}

async function subagentsCommand(commandArgs: string[]): Promise<void> {
  const [action, ...rest] = commandArgs;
  if (action === "list" || action === undefined) {
    const runs = await listSubRuns();
    if (!runs.length) { console.log("No subagent runs."); return; }
    for (const run of runs) {
      console.log(`${run.id}  ${run.status.padEnd(10)} ${run.parentKey.padEnd(24)} ${run.task.slice(0, 50)}`);
    }
    return;
  }
  if (action === "reap") {
    const ttlMin = readNumberFlag(rest, "--ttl-min") ?? 30;
    const reaped = await reapOrphans(ttlMin * 60_000);
    console.log(reaped.length ? `Orphaned ${reaped.length} stale run(s): ${reaped.map((run) => run.id).join(", ")}` : "No stale runs to reap.");
    return;
  }
  throw new Error("Usage: muster subagents list|reap [--ttl-min N]");
}


async function demoCommand(_commandArgs: string[]): Promise<void> {
  const { createServer } = await import("node:http");
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const {
    executeRun, addMemory, verifyIntegrity, renderIntegrityReport,
    listTokenRecords, renderTokenTable, ensureDefaultConfig, loadConfig, saveConfig,
  } = await import("@musterhq/core");

  // Provision a real, isolated workspace + a real stub LLM HTTP service.
  const cwd = await mkdtemp(join(tmpdir(), "muster-demo-"));
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const prompt = JSON.stringify(body);
      const text = /deploy/i.test(prompt)
        ? "Muster deploys to uat-erp.example.com (recalled from scoped memory)."
        : "Demo run complete. Every token above is real, recorded to the ledger.";
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: text } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  try {
    await ensureDefaultConfig(cwd);
    const config = await loadConfig(cwd);
    await saveConfig({
      ...config,
      providers: { ...config.providers, demo: { id: "demo", kind: "openai-compatible", baseUrl: `http://127.0.0.1:${port}/v1`, defaultModel: "demo-model", timeoutMs: 5000 } },
      runtimes: { ...config.runtimes, native: { id: "native", enabled: true, provider: "demo", routes: {} } },
      routing: { ...config.routing, defaultRuntime: "native" },
    }, cwd);
    const live = await loadConfig(cwd);

    console.log("muster demo — provisioned an isolated workspace and a live stub model service.\n");
    // The demo's seeded fact exists because the operator ran `muster demo`; it
    // is written into the demo's own throwaway workspace, so it is an explicit
    // request rather than an inference the memory policy should block.
    await addMemory({ summary: "Muster deploys to uat-erp.example.com", provenance: ["demo"], scopes: [{ kind: "user", id: "demo" }], explicitUserRequest: true }, cwd);

    for (const prompt of ["Where do we deploy?", "Summarize the day's work."]) {
      const outcome = await executeRun(live, { prompt, cwd, scopes: [{ kind: "user", id: "demo" }] });
      console.log(`> ${prompt}`);
      if (outcome.recalled.length) console.log(`  (recalled ${outcome.recalled.length} scoped memory)`);
      console.log(`  ${outcome.episode.responseText}\n`);
    }

    console.log(renderTokenTable(await listTokenRecords(cwd)));
    console.log("\n" + renderIntegrityReport(await verifyIntegrity(cwd)));
    console.log("\nThat was a real run loop: scoped memory recall, token ledger, integrity verification — on a throwaway workspace.");
  } finally {
    server.close();
  }
}


async function benchmarkCommand(): Promise<void> {
  // Built-in Token Waste Index scenarios — deterministic, no model calls.
  const toolResult = (name: string, size: number) => ({ role: "tool" as const, toolName: name, content: `[${name}] ` + "result line ".repeat(size) });
  const task = (id: string, description: string, turns: number, toolSize: number) => {
    const transcript: import("@musterhq/core").TranscriptMessage[] = [
      { role: "system", content: "You are an autonomous coding/ops agent. Use tools, then report." },
      { role: "user", content: `Task: ${description}` },
    ];
    for (let i = 0; i < turns; i += 1) {
      transcript.push({ role: "assistant", content: `Step ${i + 1}: I'll inspect the next artifact and proceed.` });
      transcript.push(toolResult(`read_file_${i}`, toolSize));
      transcript.push({ role: "user", content: `Looks right, continue with step ${i + 2}.` });
    }
    transcript.push({ role: "assistant", content: "Done. Summary of all steps follows." });
    return { id, description, transcript };
  };
  const scenarios = [
    task("codebase-refactor-20", "Refactor a module across 20 files", 20, 120),
    task("incident-triage-30", "Triage an incident across 30 log/metric pulls", 30, 90),
    task("erp-data-audit-40", "Audit ERP records across 40 queries", 40, 70),
    task("research-synthesis-25", "Synthesize findings from 25 fetched sources", 25, 150),
    task("long-support-thread-50", "Resolve a 50-message support thread with tool lookups", 50, 60),
  ];
  const report = await runWasteBenchmark(scenarios, { budgetTokens: 8000, keepRecentToolResults: 5 });
  console.log(renderWasteReport(report));
  console.log(`\nMuster reduced naive token cost by ${report.aggregate.musterReductionPct}% across these scenarios.`);
  console.log("Deterministic — no model calls. Regenerate the published table with: node benchmark/run.mjs");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
