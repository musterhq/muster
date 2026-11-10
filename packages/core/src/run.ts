import type { McpServerConfig } from "./mcp.js";
import { withConfigHooks } from "./config-hooks.js";
import { claudePermissionModeForAccess, codexApprovalRequest, codexSandboxForAccess, isWorkspaceGitCommand, type AccessMode, type ApprovalDecision, type ApprovalRequest } from "./access.js";
import { codexThreadMcpConfig, resolveRuntimeMcpServers, writeClaudeMcpConfig } from "./mcp-runtime.js";
import type { AgentToolEvent } from "./tool-events.js";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { chmod, mkdtemp, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { loadAgentRules } from "./agent-rules.js";
import { defaultHookBus, type HookBus } from "./hooks.js";
import { appendGoalLoopTurn, buildGoalLoopTurn, rememberedMemoryWrite, type GoalLoopMemoryWrite } from "./goal-loop.js";
import { runClaudeCode } from "./claude.js";
import { runCodex } from "./codex.js";
import { clearCodexAppServerConversation, clearCodexAppServerSessions, runCodexAppServer } from "./codex-app-server.js";
import { canReuseHandle, clearConversationSessionHandles, clearSessionHandle, loadSessionHandle, saveSessionHandle } from "./session-handle.js";
import { renderConversation } from "./compactor.js";
import { messagesToTranscript, openSessionStore } from "./sessions.js";

/** Token budget for the provider-direct rendered transcript (bounds runaway multi-turn context). */
const DEFAULT_CONTEXT_BUDGET_TOKENS = 16_000;

const FAST_SIMPLE_QA_RULES = "Answer only the user's request. If unsure, say so. Do not mention internal rules or process.";

const execFileAsync = promisify(execFile);

/**
 * Native provider hosts can contribute thousands of tokens of ambient tools,
 * apps, and skills. Answer-only turns retain Codex's basic execution/safety
 * surface, but defer capabilities whose domains cannot be relevant to the
 * current prompt. Full turns use the provider exactly as configured.
 */
const LEAN_CODEX_FEATURES = [
  "apps",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "computer_use",
  "goals",
  "image_generation",
  "in_app_browser",
  "multi_agent",
  "plugins",
  "workspace_dependencies",
] as const;

const leanCodexSupport = new Map<string, Promise<readonly string[] | undefined>>();
const leanCodexWrappers = new Map<string, Promise<string>>();
const leanCodexWrapperDirs = new Set<string>();
let leanCodexCleanupRegistered = false;

const EXACT_RESPONSE_RE = /\b(?:reply|respond|answer|say|return|output)\s+(?:(?:to\s+this\s+)?with\s+)?exactly\b/i;
const GREETING_RE = /^(?:hi|hello|hey|thanks|thank you|good\s+(?:morning|afternoon|evening))[\s!.?]*$/i;
const AGENTIC_PROMPT_RE = /\b(?:analy[sz]e|approve|artifact|audit|browse|build|cancel|chart|cite|code|commit|compare|compile|create|debug|delete|deploy|design|docx|download|edit|evidence|execute|export|fetch|file|folder|generate|image|install|latest|mcp|modify|pdf|plan|plugin|post|pptx|push|reject|remove|report|repository|research|run|search|send|shell|skill|source|spreadsheet|submit|summari[sz]e|terminal|test|tool|update|upload|url|website|workspace|write|xlsx)\b/i;
const CONVERSATION_REFERENCE_RE = /(?:^(?:and|also|but|so)\b|\b(?:again|above|continue|earlier|former|last\s+(?:answer|message|one|request|turn)|latter|previous|same|that|those|you\s+(?:mentioned|said))\b|\b(?:how|what)\s+about\b)/i;

interface PromptActivation {
  readonly mode: "full" | "lean";
  readonly freshConversation: boolean;
  readonly reason: "exact_response" | "greeting" | "trusted_context_qa" | "full_capability";
}

/** Split a conversation key ("channel:...:peer") into the session store's (channel, peer). */
function splitConversationKey(key: string): { channel: string; peer: string } {
  const idx = key.lastIndexOf(":");
  return idx === -1 ? { channel: key, peer: "default" } : { channel: key.slice(0, idx), peer: key.slice(idx + 1) };
}

function hashSystemContext(system: string): string {
  return createHash("sha256").update(system).digest("hex");
}

function codexCommandForLeanMode(): string {
  if (process.env.MUSTER_CODEX_COMMAND) return process.env.MUSTER_CODEX_COMMAND;
  const appBundle = "/Applications/Codex.app/Contents/Resources/codex";
  return existsSync(appBundle) ? appBundle : "codex";
}

function supportedLeanCodexFeatures(command: string): Promise<readonly string[] | undefined> {
  let pending = leanCodexSupport.get(command);
  if (pending) return pending;
  pending = (async () => {
    const help = await execFileAsync(command, ["--help"], { encoding: "utf8", timeout: 5_000, maxBuffer: 1024 * 1024 });
    if (!/--disable\s+<FEATURE>/.test(`${help.stdout}\n${help.stderr}`)) return undefined;
    const listing = await execFileAsync(command, ["features", "list"], { encoding: "utf8", timeout: 5_000, maxBuffer: 1024 * 1024 });
    const available = new Set(listing.stdout.split("\n").map((line) => line.trim().split(/\s+/, 1)[0]).filter(Boolean));
    const supported = LEAN_CODEX_FEATURES.filter((feature) => available.has(feature));
    return supported.length ? supported : undefined;
  })().catch(() => undefined);
  leanCodexSupport.set(command, pending);
  return pending;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function cleanupLeanCodexWrappers(): void {
  for (const dir of leanCodexWrapperDirs) rmSync(dir, { recursive: true, force: true });
  leanCodexWrapperDirs.clear();
  leanCodexWrappers.clear();
}

async function leanCodexCommand(): Promise<string | undefined> {
  const command = codexCommandForLeanMode();
  const features = await supportedLeanCodexFeatures(command);
  if (!features) return undefined;
  let pending = leanCodexWrappers.get(command);
  if (!pending) {
    pending = (async () => {
      const dir = await mkdtemp(join(tmpdir(), "muster-codex-lean-"));
      const wrapper = join(dir, "codex-lean");
      const flags = features.flatMap((feature) => ["--disable", feature]);
      await writeFile(wrapper, `#!/bin/sh\nexec ${shellQuote(command)} ${flags.map(shellQuote).join(" ")} "$@"\n`, { encoding: "utf8", mode: 0o700 });
      await chmod(wrapper, 0o700);
      leanCodexWrapperDirs.add(dir);
      if (!leanCodexCleanupRegistered) {
        process.once("exit", cleanupLeanCodexWrappers);
        leanCodexCleanupRegistered = true;
      }
      return wrapper;
    })();
    leanCodexWrappers.set(command, pending);
    pending.catch(() => leanCodexWrappers.delete(command));
  }
  return pending;
}
import { applySkillEnvForRun, exportClaudeSkillSnapshot, recordSkillUse, resolveAgentSkillAllowlist, selectSkills } from "./skills.js";
import { addMemory, searchMemoryWithReceipts, type SearchMemoryReceiptResult } from "./memory.js";
import { piToolsForSandbox, runPiEmbeddedAgent, type PiAgentRunResult, type PiSessionMode } from "./pi.js";
import { completeChat, ProviderCompletionError } from "./provider.js";
import { classifyTask, planRun } from "./router.js";
import { appendEpisode } from "./store.js";
import { synthesizeDeltas } from "./stream.js";
import { endSpan, genAiAttributes, startSpan } from "./telemetry.js";
import { appendTokenRecord, buildTokenRecord, type TokenRecord } from "./tokens.js";
import type {
  ChatMessage,
  ContextObject,
  EpisodeRecord,
  EvidenceRecord,
  MusterConfig,
  MemoryScope,
  ModelRoute,
  RunPlan,
  TaskKind,
} from "./types.js";

export interface RunOptions {
  readonly prompt: string;
  /**
   * Trusted, per-turn operating context supplied by the host integration.
   * It is sent as system context where the provider supports one and is kept
   * separate from the user message and persisted episode prompt.
   */
  readonly systemContext?: string;
  /**
   * Trusted application data that is valid only for this turn. Native
   * transports must attach it to the turn rather than the persisted thread.
   */
  readonly turnContext?: string;
  readonly runtime?: string;
  readonly taskKind?: TaskKind;
  readonly sensitive?: boolean;
  readonly provider?: string;
  readonly model?: string;
  readonly thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  readonly sessionMode?: PiSessionMode;
  readonly sessionDir?: string;
  readonly scopes?: MemoryScope[];
  readonly recallLimit?: number;
  readonly cwd?: string;
  /**
   * Execution sandbox for native provider CLIs (codex/claude) — the profile
   * workspace, NOT the muster install root. Falls back to cwd when unset.
   */
  readonly workspaceDir?: string;
  /** CODEX_HOME for the codex runtime (carries the user's subscription auth). */
  readonly codexHome?: string;
  /** Provider-neutral ids for inherited native tool servers that this governed turn must not use. */
  readonly inheritedToolDeny?: readonly string[];
  /** Host-governed native Codex filesystem sandbox. Existing callers retain workspace-write. */
  readonly nativeSandbox?: "read-only" | "workspace-write" | "danger-full-access";
  /** Host-governed native Codex network access. Existing callers retain network access. */
  readonly nativeNetworkAccess?: boolean;
  /** Exclude ambient TMPDIR and /tmp writable roots so workspace-write means exactly the run workspace. */
  readonly nativeStrictWorkspace?: boolean;
  /**
   * Stable, non-secret host-policy identity for native session reuse. A changed
   * value rotates the provider thread so stale permissions or tools cannot
   * survive a governance-policy change.
   */
  readonly nativeSessionPolicyKey?: string;
  /** Test/advanced override for the claude-code command binary. */
  readonly claudeCommand?: string;
  /** Native provider session handle to resume (codex thread_id / claude session id). */
  readonly sessionId?: string;
  readonly resume?: boolean;
  /** Native CLI session continuity. Disable for faster one-off Codex turns. */
  readonly nativeSession?: boolean;
  /** Keep native app-server transports alive after the turn. Interactive chat uses this; one-shot commands should not. */
  readonly nativeSessionKeepAlive?: boolean;
  /** Rotate native provider context after this many completed turns. */
  readonly nativeSessionMaxTurns?: number;
  /** Rotate native provider context after this wall-clock age. */
  readonly nativeSessionMaxAgeMs?: number;
  /** Native transport preference. "warm" reuses app-server/session transports where supported; "exec" forces one process per turn. */
  readonly nativeTransport?: "auto" | "warm" | "exec";
  /** Long-lived host that owns warm native transports, for targeted shutdown. */
  readonly nativeTransportOwner?: string;
  /**
   * Conversation identity (e.g. the surface conversation id). When set, the
   * native provider session for THIS conversation is resumed across turns via
   * the session-handle store — so a multi-turn chat keeps one provider thread.
   */
  readonly conversationKey?: string;
  /** Token budget for the provider-direct multi-turn transcript. Default 16k. */
  readonly contextBudgetTokens?: number;
  readonly timeoutMs?: number;
  /** Skip memory lookup for latency-sensitive turns. Explicit memory commands should leave this false. */
  readonly skipRecall?: boolean;
  /** Skip ambient skill scoring/injection for latency-sensitive turns. Explicit skill commands still run outside executeRun. */
  readonly skipSkillSelection?: boolean;
  readonly skipMemoryWrite?: boolean;
  readonly skipAgentRules?: boolean;
  /** Hook bus for prompt.build gating; defaults to the process-wide bus. */
  readonly hooks?: HookBus;
  /** Surface label for per-surface token accounting (set by the gateway). */
  readonly surfaceId?: string;
  /** Profile/agent id used for scoped skill visibility. */
  readonly agentId?: string;
  /**
   * Optional streaming hook (packages/core/src/stream.ts). For the pi runtime
   * this receives live assistant deltas from the embedded session; for
   * claude-code/native runtimes the buffered response is chunked into
   * synthetic deltas so the same coalescer/draft pipeline runs everywhere.
   */
  readonly onDelta?: (text: string) => void;
  /** Provider-visible reasoning summary deltas. Raw hidden reasoning is never forwarded. */
  readonly onReasoningDelta?: (text: string) => void;
  /** Tool activity (commands, MCP calls, searches) while the turn runs; file edits come from the workspace observer. */
  readonly onToolEvent?: (event: AgentToolEvent) => void;
  /**
   * A `[model_providers.<id>]` from the Codex config (e.g. an OpenAI-compatible
   * gateway) that Codex turns should use instead of the default provider.
   */
  readonly codexModelProvider?: string;
  /** MCP servers the host adds to this run (e.g. Muster's own `mcp serve`), subject to the same deny rules. */
  readonly extraMcpServers?: Readonly<Record<string, McpServerConfig>>;
  /** How much the turn may do without asking; unset keeps the caller's sandbox and never asks. */
  readonly accessMode?: AccessMode;
  /** Answers provider approval requests (ask mode). Without it every request is declined. */
  readonly onApprovalRequest?: (request: ApprovalRequest) => Promise<ApprovalDecision>;
  /** A policy hook declined a tool request (the provider is told no; the user sees why). */
  readonly onPolicyBlock?: (request: ApprovalRequest, block: { readonly hookId?: string; readonly reason?: string }) => void;
}

export interface RunOutcome {
  readonly plan: RunPlan;
  readonly episode: EpisodeRecord;
  readonly tokens: TokenRecord;
  /** Window occupancy on the latest model call, when the runtime reports it. */
  readonly context?: { readonly usedTokens: number; readonly windowTokens: number };
  readonly recalled: ContextObject[];
  readonly recallReceipt?: SearchMemoryReceiptResult;
  readonly timings?: RunTimingBreakdown;
  readonly fallbackUsed?: string;
  readonly piResult?: PiAgentRunResult;
  /** Native codex session handle to persist for resuming the next turn. */
  readonly codexThreadId?: string;
  /** The provider's id for this turn (Codex app-server), for rewind. */
  readonly providerTurnId?: string;
}

export interface RunTimingBreakdown {
  readonly totalMs: number;
  readonly planningMs: number;
  readonly recallMs: number;
  readonly agentRulesMs?: number;
  readonly skillSelectionMs?: number;
  readonly promptBuildMs: number;
  readonly hookMs?: number;
  readonly providerMs: number;
  readonly firstTokenMs?: number;
  readonly providerTransport?: string;
  readonly providerAttemptCount?: number;
  readonly providerStartupMs?: number;
  readonly providerQueueMs?: number;
  readonly providerThreadOpenMs?: number;
  readonly providerRequestToFirstDeltaMs?: number;
  readonly providerCacheState?: string;
  readonly providerThreadOpenState?: string;
  readonly fallbackMs?: number;
  readonly backendFallbackMs?: number;
  readonly memoryWriteMs?: number;
  readonly persistMs: number;
}

/** Provider-neutral lifecycle boundary used by long-lived gateway/RPC hosts. */
export function closeWarmProviderTransports(transportOwner?: string): void {
  clearCodexAppServerSessions(transportOwner);
  if (transportOwner === undefined) cleanupLeanCodexWrappers();
}

/** Clear persisted and in-memory native continuity for one conversation only. */
export async function invalidateNativeConversation(conversationKey: string, cwd = process.cwd()): Promise<number> {
  clearCodexAppServerConversation(conversationKey);
  return clearConversationSessionHandles(conversationKey, cwd);
}

interface LocalFastAnswer {
  readonly responseText: string;
  readonly label: string;
  readonly detail: string;
}

function defaultScopes(): MemoryScope[] {
  const user = process.env.USER || process.env.USERNAME || "local";
  return [{ kind: "user", id: user }];
}

function referencesPriorConversation(prompt: string): boolean {
  const normalized = prompt.trim();
  if (EXACT_RESPONSE_RE.test(normalized) || GREETING_RE.test(normalized)) return false;
  const words = normalized.match(/[a-z0-9]+/gi) ?? [];
  return words.length <= 3 || CONVERSATION_REFERENCE_RE.test(normalized);
}

function promptActivation(plan: RunPlan, options: RunOptions, hasPromptBuildHooks: boolean): PromptActivation {
  const prompt = options.prompt.trim();
  const explicitComplexTask = options.taskKind !== undefined && options.taskKind !== "simple_qa";
  const explicitContinuity = options.resume === true || Boolean(options.sessionId) || options.contextBudgetTokens !== undefined;
  const exactResponse = EXACT_RESPONSE_RE.test(prompt);
  const greeting = GREETING_RE.test(prompt);
  const trustedContextQa = Boolean(options.systemContext?.trim() || options.turnContext?.trim()) && prompt.length <= 400;
  const lean = plan.taskKind === "simple_qa"
    && !explicitComplexTask
    && !explicitContinuity
    && !hasPromptBuildHooks
    && !AGENTIC_PROMPT_RE.test(prompt)
    && (exactResponse || greeting || trustedContextQa);
  const reason: PromptActivation["reason"] = !lean
    ? "full_capability"
    : exactResponse
      ? "exact_response"
      : greeting
        ? "greeting"
        : "trusted_context_qa";
  return {
    mode: lean ? "lean" : "full",
    freshConversation: Boolean(options.conversationKey) && lean && !referencesPriorConversation(prompt),
    reason,
  };
}

async function maybeAnswerLocalWorkspacePrompt(prompt: string, cwd: string): Promise<LocalFastAnswer | undefined> {
  const normalized = prompt.toLowerCase().replace(/\s+/g, " ").trim();
  const asksForListing = /\b(list|show|what(?:'s| is)?|which)\b/.test(normalized)
    && /\b(files?|directories|folders?|present|contents?)\b/.test(normalized);
  const currentFolderOnly = /\b(current|this|working|personal)\s+(folder|directory)\b/.test(normalized)
    || /\b(folder|directory)\s+(i am in|i'm in|we are in|we're in)\b/.test(normalized);
  const targetedPath = /(?:^|\s)(?:\.{1,2}\/|~\/|\/|[a-z0-9_.-]+\/[a-z0-9_.\/-]*)/.test(normalized);
  const fileTarget = /\b[a-z0-9_-]+\.[a-z0-9]{1,8}\b/.test(normalized);
  const needsProvider = /\b(explain|summari[sz]e|analy[sz]e|why|compare|find|search|grep|read|open|modify|change|changed|status|diff|delete|install|content of|contents of)\b/.test(normalized);
  if (!asksForListing || !currentFolderOnly || targetedPath || fileTarget || needsProvider) return undefined;

  const includeHidden = /\b(hidden|dotfiles?|all files)\b/.test(normalized);
  const entries = (await readdir(cwd, { withFileTypes: true }))
    .filter((entry) => includeHidden || !entry.name.startsWith("."))
    .sort((left, right) => left.name.localeCompare(right.name));
  const visible = entries.slice(0, 200).map((entry) => `\`${entry.name}${entry.isDirectory() ? "/" : ""}\``);
  const suffix = entries.length > visible.length ? `\n\n...and ${entries.length - visible.length} more entries.` : "";
  const responseText = visible.length
    ? `Current folder contains:\n\n${visible.map((entry) => `- ${entry}`).join("\n")}${suffix}`
    : "Current folder is empty.";
  return {
    responseText,
    label: "local_workspace_listing",
    detail: `listed=${Math.min(entries.length, visible.length)} total=${entries.length} include_hidden=${includeHidden}`,
  };
}

export async function recallMemory(prompt: string, scopes: MemoryScope[], limit: number, cwd: string): Promise<ContextObject[]> {
  return (await recallMemoryWithReceipt(prompt, scopes, limit, cwd)).receipts.map((receipt) => receipt.memory);
}

export async function recallMemoryWithReceipt(prompt: string, scopes: MemoryScope[], limit: number, cwd: string): Promise<SearchMemoryReceiptResult> {
  return searchMemoryWithReceipts({
    query: prompt,
    scopes,
    includeGlobal: true,
    limit,
    candidateLimit: Math.max(limit * 20, 50),
    match: "any",
  }, cwd);
}

export function buildRecalledBlock(recalled: readonly ContextObject[]): string {
  if (!recalled.length) return "";
  const lines = recalled.map((object) => `- [${object.kind}] ${object.summary}`);
  return `Recalled context (scoped memory, provenance-tracked; verify before relying on it):\n${lines.join("\n")}`;
}

function planForManagedRuntime(
  config: MusterConfig,
  runtimeId: "pi" | "claude-code" | "codex",
  options: RunOptions,
): RunPlan {
  const taskKind = classifyTask(options.prompt, options.taskKind);
  const builtIn = runtimeId === "pi"
    ? { provider: "pi-default", model: "pi-default" }
    : runtimeId === "codex"
      ? { provider: "codex", model: "gpt-5.5" }
      : { provider: "anthropic", model: "sonnet" };
  const acceptsProvider = (providerId: string): boolean => {
    if (runtimeId === "pi") return true;
    const kind = config.providers[providerId]?.kind;
    return runtimeId === "codex" ? kind === "codex-cli" : kind === "anthropic";
  };
  const configuredRuntimes = [
    config.runtimes[runtimeId],
    config.runtimes[config.routing.defaultRuntime],
    ...Object.values(config.runtimes),
  ].filter((runtime, index, runtimes) => runtime?.enabled && runtimes.indexOf(runtime) === index);
  const configuredRoute = configuredRuntimes
    .map((runtime) => runtime?.routes[taskKind])
    .find((route): route is ModelRoute => Boolean(route && acceptsProvider(route.provider)));
  const configuredProviderId = options.provider
    ?? configuredRoute?.provider
    ?? configuredRuntimes.map((runtime) => runtime?.provider).find((providerId) => providerId && acceptsProvider(providerId))
    ?? Object.values(config.providers).find((provider) => acceptsProvider(provider.id))?.id;
  const configuredProvider = configuredProviderId ? config.providers[configuredProviderId] : undefined;
  const defaults = {
    provider: configuredProviderId ?? builtIn.provider,
    model: configuredRoute?.model ?? configuredProvider?.defaultModel ?? builtIn.model,
    reasoning: configuredRoute?.reasoning,
  };
  return {
    runId: `run_${randomUUID()}`,
    taskKind,
    runtimeId,
    route: {
      provider: options.provider ?? defaults.provider,
      model: options.model ?? defaults.model,
      reasoning: defaults.reasoning,
    },
    sensitive: options.sensitive ?? false,
    createdAt: new Date().toISOString(),
  };
}

interface AttemptResult {
  readonly responseText: string;
  readonly status: "completed" | "failed";
  readonly errorMessage?: string;
  readonly route: ModelRoute;
  readonly piResult?: PiAgentRunResult;
  readonly codexThreadId?: string;
  readonly sessionMode?: string;
  readonly sessionId?: string;
  readonly firstTokenMs?: number;
  readonly providerTransport?: string;
  readonly providerStartupMs?: number;
  readonly providerQueueMs?: number;
  readonly providerThreadOpenMs?: number;
  readonly providerRequestToFirstDeltaMs?: number;
  readonly providerCacheState?: string;
  readonly providerThreadOpenState?: string;
  /** Actual ambient provider context after dynamic activation and compatibility fallback. */
  readonly providerContextMode?: "full" | "lean";
  readonly backendFallbackMs?: number;
  /** False once a provider turn may have executed tools; unsafe attempts must never be replayed. */
  readonly fallbackEligible?: boolean;
  readonly tokenUsage?: {
    readonly inputTokens?: number;
    readonly cachedInputTokens?: number;
    readonly outputTokens?: number;
  };
  readonly context?: { readonly usedTokens: number; readonly windowTokens: number };
  readonly providerTurnId?: string;
}

function normalizeNativeTransport(value: string | undefined): "auto" | "warm" | "exec" {
  if (value === "exec") return "exec";
  if (value === "warm" || value === "app-server") return "warm";
  return "auto";
}

function defaultTaskTimeoutMs(taskKind: TaskKind): number {
  if (taskKind === "simple_qa") return 45_000;
  if (taskKind === "artifact" || taskKind === "workflow" || taskKind === "coding" || taskKind === "debugging") return 300_000;
  return 180_000;
}

function nativeSessionBudget(options: RunOptions): { readonly maxAgeMs?: number; readonly maxTurns?: number } | undefined {
  if (options.nativeSessionMaxAgeMs === undefined && options.nativeSessionMaxTurns === undefined) return undefined;
  return {
    maxAgeMs: options.nativeSessionMaxAgeMs,
    maxTurns: options.nativeSessionMaxTurns,
  };
}

interface PromptParts {
  /** Preamble + user prompt concatenated (pi/native send this — behaviour unchanged). */
  readonly combined: string;
  /** Just the user's prompt (claude-code sends this as the user message). */
  readonly user: string;
  /** Operating rules / recalled context (claude-code sends this as the system prompt). */
  readonly system: string;
  /** Stable instructions used for native session identity; volatile recall/skills must not bust warm sessions. */
  readonly stableSystem: string;
  /** Host-verified context attached natively to only the current provider turn. */
  readonly applicationContext?: string;
  /** Per-run Claude Code plugin dirs, currently used for temporary skill snapshots. */
  readonly claudePluginDirs?: readonly string[];
  /** High-confidence answer-only turns can defer unrelated ambient provider capabilities. */
  readonly capabilityMode: "full" | "lean";
  /** Do not replay an unrelated provider/session transcript into this self-contained turn. */
  readonly freshConversation: boolean;
}

function emptyRecallReceipt(query: string, scopes: readonly MemoryScope[], limit: number): SearchMemoryReceiptResult {
  return {
    query,
    scopes: [...scopes],
    includeGlobal: false,
    backend: "sqlite-fts5",
    requestedLimit: Math.max(1, Math.floor(limit)),
    candidateCount: 0,
    receipts: [],
    fallbackUsed: false,
  };
}

/**
 * A provider CLI backend: turns a route + prompt parts into an attempt result.
 * Each native-CLI runtime is ONE entry in CLI_BACKENDS below; attemptRoute
 * dispatches through the registry and never special-cases a provider, so adding
 * gemini/cursor/copilot is a single backend + registry line (acpx's adapter
 * registry idea, kept in-repo with no runtime install). Native CLIs own their
 * own sessions/compaction, so they bypass the provider-direct render path.
 */
type CliBackendRunner = (route: ModelRoute, prompts: PromptParts, options: RunOptions, config?: MusterConfig) => Promise<AttemptResult>;

const runClaudeCodeBackend: CliBackendRunner = async (route, prompts, options, config) => {
  const stateCwd = options.cwd ?? process.cwd();
  const claudeCwd = options.cwd ?? process.cwd();
  // Resume THIS conversation's claude session when the stable config (cwd+model)
  // is unchanged; otherwise pin a FRESH muster-generated id so the next turn can
  // resume it. Explicit options.sessionId (e.g. CLI) takes precedence; no
  // conversationKey means the original stateless behaviour.
  const stored = options.conversationKey && !options.sessionId
    ? await loadSessionHandle(options.conversationKey, "claude", stateCwd)
    : undefined;
  const contextHash = hashSystemContext(`${prompts.stableSystem}\0${options.nativeSessionPolicyKey ?? ""}`);
  const reuse = !prompts.freshConversation && canReuseHandle(stored, claudeCwd, route.model, contextHash, nativeSessionBudget(options));
  const sessionId = options.conversationKey
    ? (reuse ? stored.handle : (options.sessionId ?? randomUUID()))
    : options.sessionId;
  // Muster's MCP servers ride along in a private config file for this turn only.
  const mcp = config ? await resolveRuntimeMcpServers(config, stateCwd, options.extraMcpServers) : undefined;
  const mcpFile = mcp && Object.keys(mcp.servers).length ? await writeClaudeMcpConfig(mcp.servers) : undefined;
  let claudeResult: Awaited<ReturnType<typeof runClaudeCode>>;
  try {
    claudeResult = await runClaudeCode({
      prompt: prompts.user,
      systemPrompt: prompts.system || undefined,
      cwd: claudeCwd,
      model: route.model,
      timeoutMs: options.timeoutMs,
      command: options.claudeCommand,
      sessionId,
      resume: reuse ? true : options.resume,
      pluginDirs: prompts.claudePluginDirs,
      ...(mcpFile ? { mcpConfig: mcpFile.path } : {}),
      ...(options.onDelta ? { onDelta: options.onDelta } : {}),
      ...(options.onToolEvent ? { onToolEvent: options.onToolEvent } : {}),
      // No explicit mode means the chat default, auto-edit (spec 10-1E).
      permissionMode: claudePermissionModeForAccess(options.accessMode ?? "auto-edit"),
    });
  } finally {
    await mcpFile?.dispose().catch(() => {});
  }
  // Persist the session for next turn on success; drop a broken one on failure.
  if (options.conversationKey && sessionId) {
    if (claudeResult.status === "completed") {
      const updatedAt = new Date().toISOString();
      await saveSessionHandle({
        conversationKey: options.conversationKey,
        backendId: "claude",
        handle: sessionId,
        cwd: claudeCwd,
        model: route.model,
        contextHash,
        createdAt: reuse ? (stored.createdAt ?? stored.updatedAt) : updatedAt,
        turnCount: reuse ? (stored.turnCount ?? 0) + 1 : 1,
        updatedAt,
      }, stateCwd);
    } else {
      await clearSessionHandle(options.conversationKey, "claude", stateCwd);
    }
  }
  const responseText = claudeResult.stdout.trim();
  // In stream-json mode the deltas already went out live; only plain-text
  // runs synthesize them.
  return {
    responseText,
    ...(claudeResult.usage
      ? { tokenUsage: { inputTokens: claudeResult.usage.inputTokens, cachedInputTokens: claudeResult.usage.cachedInputTokens, outputTokens: claudeResult.usage.outputTokens } }
      : {}),
    status: claudeResult.status,
    errorMessage: claudeResult.status === "failed" ? (claudeResult.errorMessage || claudeResult.stderr.trim() || "claude command failed") : undefined,
    route,
    sessionMode: sessionId ? (reuse ? "continue" : "create") : undefined,
    sessionId,
    providerContextMode: prompts.capabilityMode,
    fallbackEligible: claudeResult.status === "failed" ? (claudeResult.fallbackEligible ?? false) : undefined,
  };
};

export async function codexMcpDisableOverrides(
  ids: readonly string[] | undefined,
  codexHome?: string,
): Promise<string[]> {
  const requested = [...new Set(ids ?? [])];
  for (const id of requested) {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Invalid inherited tool server id: ${id}`);
  }
  if (!requested.length) return [];
  const home = codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
  let config = "";
  try {
    config = await readFile(join(home, "config.toml"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const configured = new Set<string>();
  const section = /^\s*\[mcp_servers\.(?:"([A-Za-z0-9_-]+)"|'([A-Za-z0-9_-]+)'|([A-Za-z0-9_-]+))(?:\.|\])/gm;
  for (const match of config.matchAll(section)) configured.add(match[1] ?? match[2] ?? match[3]!);
  // A false override for a missing MCP is not a no-op in Codex: it creates an
  // incomplete server table and fails configuration parsing with "invalid
  // transport". Only disable servers that the selected Codex home declares.
  return requested.filter((id) => configured.has(id)).map((id) => `mcp_servers.${id}.enabled=false`);
}

const runCodexBackend: CliBackendRunner = async (route, prompts, options, config) => {
  const workspaceDir = options.workspaceDir ?? options.cwd ?? process.cwd();
  const stateCwd = options.cwd ?? process.cwd();
  const leanCommand = prompts.capabilityMode === "lean" ? await leanCodexCommand().catch(() => undefined) : undefined;
  // muster memory/rules go to a SYSTEM-level instructions file, never the user
  // turn — so the provider's own AGENTS.md still stacks natively and rule 6 (no
  // preamble narration) holds.
  let instructionsFile: string | undefined;
  if (prompts.system.trim()) {
    instructionsFile = join(tmpdir(), `muster-codex-inject-${randomUUID()}.md`);
    await writeFile(instructionsFile, prompts.system, "utf8");
  }
  // Resume THIS conversation's native codex thread when the stable config
  // (workspace + model) is unchanged; otherwise mint a fresh one. Explicit
  // options.sessionId/resume (e.g. CLI) still take precedence.
  const useNativeSession = options.nativeSession !== false;
  const stored = useNativeSession && options.conversationKey && !options.sessionId
    ? await loadSessionHandle(options.conversationKey, "codex", stateCwd)
    : undefined;
  const contextHash = hashSystemContext(`${prompts.stableSystem}\0${options.nativeSessionPolicyKey ?? ""}`);
  const compatible = canReuseHandle(stored, workspaceDir, route.model, contextHash);
  const reuse = !prompts.freshConversation && canReuseHandle(stored, workspaceDir, route.model, contextHash, nativeSessionBudget(options));
  const rotateWarmThread = Boolean(stored && !reuse);
  try {
    const codexEnv = options.codexHome ? { CODEX_HOME: options.codexHome } : undefined;
    if (options.codexModelProvider && !/^[A-Za-z0-9_-]+$/.test(options.codexModelProvider)) {
      throw new Error(`Invalid Codex model provider id: ${options.codexModelProvider}`);
    }
    const configOverrides = [
      ...(options.codexModelProvider ? [`model_provider=${JSON.stringify(options.codexModelProvider)}`] : []),
      ...await codexMcpDisableOverrides(options.inheritedToolDeny, options.codexHome),
      ...(options.nativeStrictWorkspace
        ? ["sandbox_workspace_write.exclude_tmpdir_env_var=true", "sandbox_workspace_write.exclude_slash_tmp=true"]
        : []),
    ];
    const policyGate = Boolean(options.hooks && options.hooks.count("tool.before") > 0) && options.accessMode !== "read-only";
    const codexMcpThreadConfig = config
      ? codexThreadMcpConfig((await resolveRuntimeMcpServers(config, stateCwd, options.extraMcpServers)).servers)
      : {};
    const nativeTransport = normalizeNativeTransport(options.nativeTransport ?? process.env.MUSTER_NATIVE_TRANSPORT ?? process.env.MUSTER_CODEX_TRANSPORT);
    const useAppServer = useNativeSession
      && nativeTransport !== "exec"
      && (process.stdin.isTTY || nativeTransport === "warm");
    const codexResult = useAppServer
      ? await runCodexAppServer({
          prompt: prompts.user,
          cwd: workspaceDir,
          model: route.model,
          reasoning: route.reasoning,
          developerInstructions: prompts.stableSystem || undefined,
          applicationContext: prompts.applicationContext,
          sandbox: codexSandboxForAccess(options.accessMode, options.nativeSandbox),
          networkAccess: options.nativeNetworkAccess ?? true,
          configOverrides,
          env: codexEnv,
          timeoutMs: options.timeoutMs,
          threadId: reuse ? stored.handle : (options.resume ? options.sessionId : undefined),
          keepAlive: options.nativeSessionKeepAlive ?? true,
          cacheKey: options.conversationKey,
          transportOwner: options.nativeTransportOwner,
          rotateThread: rotateWarmThread,
          onDelta: options.onDelta,
          onReasoningDelta: options.onReasoningDelta,
          ...(options.onToolEvent ? { onToolEvent: options.onToolEvent } : {}),
          ...(Object.keys(codexMcpThreadConfig).length ? { threadConfig: codexMcpThreadConfig } : {}),
          // Approvals are on in ask mode, and whenever a tool.before policy
          // hook exists: the hook answers every request, the user only in ask.
          // auto-edit asks "on request": Codex only asks to step outside the
          // sandbox, and Muster approves local git (commits) itself.
          ...(options.accessMode === "ask" || policyGate ? { approvalPolicy: "untrusted" as const } : options.accessMode === "auto-edit" ? { approvalPolicy: "on-request" as const } : {}),
          ...(options.accessMode === "ask" || options.accessMode === "auto-edit" || options.onApprovalRequest || policyGate
            ? {
                onRequest: async (method: string, params: Record<string, unknown>) => {
                  const request = codexApprovalRequest(method, params);
                  if (!request) return undefined;
                  if (policyGate) {
                    const verdict = await options.hooks!.emit("tool.before", { event: "tool.before", kind: request.kind, title: request.title, ...(request.cwd ? { cwd: request.cwd } : {}), ...(request.reason ? { reason: request.reason } : {}) });
                    if (verdict.action === "block") {
                      try { options.onPolicyBlock?.(request, { ...(verdict.blockedBy ? { hookId: verdict.blockedBy } : {}), ...(verdict.reason ? { reason: verdict.reason } : {}) }); } catch { /* display only */ }
                      return { decision: "decline" };
                    }
                    // With a policy gate Codex asks about every command, not just
                    // escalations; passing the policy is the approval (except in ask).
                    if (options.accessMode !== "ask") return { decision: "accept" };
                  }
                  if (options.accessMode === "auto-edit") {
                    return { decision: request.kind === "command" && isWorkspaceGitCommand(request.title, request.cwd, workspaceDir) ? "accept" : "decline" };
                  }
                  const decision = options.onApprovalRequest ? await options.onApprovalRequest(request).catch(() => "decline" as const) : "decline";
                  return { decision };
                },
              }
            : {}),
          command: leanCommand,
        })
      : await runCodex({
          prompt: prompts.user,
          cwd: workspaceDir,
          model: route.model,
          reasoning: route.reasoning,
          instructionsFile,
          sandbox: codexSandboxForAccess(options.accessMode, options.nativeSandbox),
          networkAccess: options.nativeNetworkAccess ?? true,
          configOverrides,
          sessionId: reuse ? stored.handle : options.sessionId,
          resume: reuse ? true : options.resume,
          ephemeral: !useNativeSession,
          ignoreRules: options.surfaceId === "cli-chat",
          env: codexEnv,
          timeoutMs: options.timeoutMs,
          command: leanCommand,
        });
    const useBackendFallback = useAppServer
      && codexResult.status === "failed"
      && codexResult.fallbackEligible === true;
    const backendFallbackStartedAt = Date.now();
    const finalCodexResult = useBackendFallback
      ? await runCodex({
          prompt: prompts.user,
          cwd: workspaceDir,
          model: route.model,
          reasoning: route.reasoning,
          instructionsFile,
          sandbox: codexSandboxForAccess(options.accessMode, options.nativeSandbox),
          networkAccess: options.nativeNetworkAccess ?? true,
          configOverrides,
          sessionId: reuse ? stored.handle : options.sessionId,
          resume: reuse ? true : options.resume,
          ephemeral: false,
          ignoreRules: options.surfaceId === "cli-chat",
          env: codexEnv,
          timeoutMs: options.timeoutMs,
          command: leanCommand,
        })
      : codexResult;
    const backendFallbackMs = useBackendFallback ? Date.now() - backendFallbackStartedAt : 0;
    const appServerTimings = useAppServer && "timings" in codexResult ? codexResult.timings : undefined;
    // Persist the thread for next turn on success; drop a broken thread on
    // failure so it is never resumed into a dead end.
    if (useNativeSession && options.conversationKey) {
      if (finalCodexResult.status === "completed" && finalCodexResult.threadId) {
        const updatedAt = new Date().toISOString();
        await saveSessionHandle({
          conversationKey: options.conversationKey,
          backendId: "codex",
          handle: finalCodexResult.threadId,
          cwd: workspaceDir,
          model: route.model,
          contextHash,
          createdAt: reuse ? (stored.createdAt ?? stored.updatedAt) : updatedAt,
          turnCount: reuse ? (stored.turnCount ?? 0) + 1 : 1,
          updatedAt,
        }, stateCwd);
      } else if (finalCodexResult.status === "failed") {
        await clearSessionHandle(options.conversationKey, "codex", stateCwd);
      }
    }
    const responseText = finalCodexResult.finalMessage.trim();
    if ((!useAppServer || useBackendFallback) && options.onDelta && finalCodexResult.status === "completed" && responseText) {
      for (const chunk of synthesizeDeltas(responseText)) options.onDelta(chunk);
    }
    return {
      responseText,
      status: finalCodexResult.status,
      errorMessage: finalCodexResult.status === "failed" ? (finalCodexResult.errorMessage || "codex run failed") : undefined,
      route,
      codexThreadId: finalCodexResult.threadId,
      ...("turnId" in finalCodexResult && finalCodexResult.turnId ? { providerTurnId: finalCodexResult.turnId } : {}),
      sessionMode: useNativeSession && finalCodexResult.threadId ? (reuse ? "continue" : "create") : undefined,
      sessionId: finalCodexResult.threadId,
      firstTokenMs: "firstDeltaMs" in finalCodexResult ? finalCodexResult.firstDeltaMs : undefined,
      providerTransport: useAppServer
        ? (useBackendFallback ? "warm-fallback-exec" : "warm")
        : "exec",
      providerStartupMs: appServerTimings?.startupMs,
      providerQueueMs: appServerTimings?.queueMs,
      providerThreadOpenMs: appServerTimings?.threadOpenMs,
      providerRequestToFirstDeltaMs: appServerTimings?.requestToFirstDeltaMs,
      providerCacheState: appServerTimings?.cacheState,
      providerThreadOpenState: appServerTimings?.threadOpenState,
      providerContextMode: leanCommand ? "lean" : "full",
      backendFallbackMs,
      fallbackEligible: finalCodexResult.status === "failed"
        ? ("fallbackEligible" in finalCodexResult ? (finalCodexResult.fallbackEligible ?? false) : false)
        : undefined,
      tokenUsage: "tokenUsage" in finalCodexResult ? finalCodexResult.tokenUsage : undefined,
      ...("context" in finalCodexResult && finalCodexResult.context ? { context: finalCodexResult.context } : {}),
    };
  } finally {
    if (instructionsFile) await rm(instructionsFile, { force: true }).catch(() => {});
  }
};

/** The provider-agnostic backend registry — add a CLI provider with one entry. */
const CLI_BACKENDS: Record<string, CliBackendRunner> = {
  "claude-code": runClaudeCodeBackend,
  codex: runCodexBackend,
};

export function listCliBackends(): string[] {
  return Object.keys(CLI_BACKENDS);
}

async function attemptRoute(
  config: MusterConfig,
  plan: RunPlan,
  route: ModelRoute,
  prompts: PromptParts,
  options: RunOptions,
): Promise<AttemptResult> {
  const backend = CLI_BACKENDS[plan.runtimeId];
  if (backend) return backend(route, prompts, options, config);
  if (plan.runtimeId === "pi") {
    const piResult = await runPiEmbeddedAgent({
      prompt: prompts.combined,
      cwd: options.cwd,
      provider: route.provider === "pi-default" ? undefined : route.provider,
      model: route.model === "pi-default" ? undefined : route.model,
      thinking: options.thinking,
      sessionMode: options.sessionMode,
      sessionDir: options.sessionDir,
      timeoutMs: options.timeoutMs,
      onDelta: options.onDelta,
      tools: piToolsForSandbox(codexSandboxForAccess(options.accessMode, options.nativeSandbox)),
      ...(options.onToolEvent ? { onToolEvent: options.onToolEvent } : {}),
    });
    return {
      responseText: piResult.stdout.trim(),
      status: piResult.status,
      errorMessage: piResult.errorMessage,
      route,
      piResult,
      sessionMode: piResult.sessionMode,
      sessionId: piResult.sessionId,
      providerTransport: "pi",
      providerContextMode: prompts.capabilityMode,
      fallbackEligible: piResult.status === "failed" ? (piResult.fallbackEligible ?? false) : undefined,
    };
  }
  const provider = config.providers[route.provider];
  if (!provider) {
    return { responseText: "", status: "failed", errorMessage: `Provider not configured: ${route.provider}`, route };
  }
  if (provider.kind === "codex-cli") {
    return runCodexBackend({ ...route, model: route.model || provider.defaultModel }, prompts, options, config);
  }
  // Multi-turn, budgeted context for the provider-direct (API) path only: load
  // this conversation's prior turns, render them to fit the budget (stub old
  // tool results, compact if needed), and persist the new turn for next time.
  // Gated on conversationKey, so single-shot runs (CLI, no conversation) keep
  // the original flat-message behaviour. Native CLI runtimes own their own
  // sessions and never reach this branch.
  const runCwd = options.cwd ?? process.cwd();
  const store = options.conversationKey ? openSessionStore(runCwd) : undefined;
  try {
    let messages: ChatMessage[] = [
      ...(prompts.system.trim() ? [{ role: "system" as const, content: prompts.system }] : []),
      { role: "user", content: prompts.user },
    ];
    let sessionId: string | undefined;
    if (store && options.conversationKey) {
      const { channel, peer } = splitConversationKey(options.conversationKey);
      sessionId = store.findOrCreateSession({ channel, peer }).id;
      const prior = prompts.freshConversation ? [] : messagesToTranscript(store.loadActiveMessages(sessionId));
      const rendered = await renderConversation({
        system: prompts.system || undefined,
        prior,
        userPrompt: prompts.user,
        budgetTokens: options.contextBudgetTokens ?? DEFAULT_CONTEXT_BUDGET_TOKENS,
      });
      messages = rendered.map((message) => ({ role: message.role === "tool" ? "user" : message.role, content: message.content }));
    }
    const text = await completeChat({ provider, route, messages, timeoutMs: options.timeoutMs });
    if (options.onDelta && text) {
      for (const chunk of synthesizeDeltas(text)) options.onDelta(chunk);
    }
    if (store && sessionId && text) {
      store.appendMessage(sessionId, "user", prompts.user);
      store.appendMessage(sessionId, "assistant", text);
    }
    return {
      responseText: text,
      status: text ? "completed" : "failed",
      errorMessage: text ? undefined : "Empty response",
      route,
      providerTransport: "http",
      providerContextMode: prompts.capabilityMode,
      fallbackEligible: text ? undefined : false,
    };
  } catch (error) {
    return {
      responseText: "",
      status: "failed",
      errorMessage: error instanceof Error ? error.message : String(error),
      route,
      fallbackEligible: error instanceof ProviderCompletionError ? error.fallbackEligible : false,
    };
  } finally {
    store?.close();
  }
}

export async function executeRun(config: MusterConfig, initialOptions: RunOptions): Promise<RunOutcome> {
  const runStartedAt = Date.now();
  const cwd = initialOptions.cwd ?? process.cwd();
  // Config policy hooks layer over the in-process bus for this run only.
  const runHooks = withConfigHooks(initialOptions.hooks ?? defaultHookBus, config.hooks, cwd);
  const started = await runHooks.emit("turn.start", { event: "turn.start", prompt: initialOptions.prompt });
  if (started.action === "block") {
    throw new Error(`Run blocked by hook ${started.blockedBy ?? "unknown"}: ${started.reason ?? "blocked"}`);
  }
  const startedPrompt = (started.payload as { prompt?: unknown }).prompt;
  const onToolEvent = initialOptions.onToolEvent;
  const options: RunOptions = {
    ...initialOptions,
    hooks: runHooks,
    ...(typeof startedPrompt === "string" ? { prompt: startedPrompt } : {}),
    ...(runHooks.count("tool.after") || onToolEvent
      ? {
          onToolEvent: (event) => {
            onToolEvent?.(event);
            if (event.phase === "end" && runHooks.count("tool.after")) void runHooks.emit("tool.after", { event: "tool.after", ...event }).catch(() => {});
          },
        }
      : {}),
  };
  const planningStartedAt = Date.now();
  const plan = options.runtime === "pi" || options.runtime === "claude-code" || options.runtime === "claude" || options.runtime === "codex"
    ? planForManagedRuntime(config, options.runtime === "pi" ? "pi" : options.runtime === "codex" ? "codex" : "claude-code", options)
    : planRun(config, {
        prompt: options.prompt,
        runtime: options.runtime,
        taskKind: options.taskKind,
        sensitive: options.sensitive,
        cwd,
      });
  const planningMs = Date.now() - planningStartedAt;

  const scopes = options.scopes ?? defaultScopes();
  const localFastAnswer = await maybeAnswerLocalWorkspacePrompt(options.prompt, options.workspaceDir ?? cwd);
  if (localFastAnswer) {
    const persistStartedAt = Date.now();
    const recallReceipt: SearchMemoryReceiptResult = {
      query: options.prompt,
      scopes,
      includeGlobal: false,
      backend: "sqlite-fts5",
      requestedLimit: options.recallLimit ?? 5,
      candidateCount: 0,
      receipts: [],
      fallbackUsed: false,
    };
    const evidence: EvidenceRecord[] = [
      {
        kind: "tool_result",
        label: localFastAnswer.label,
        status: "observed",
        detail: localFastAnswer.detail,
      },
      {
        kind: "system_check",
        label: "memory_recall",
        status: "observed",
        detail: "skipped=local_fast_path recalled=0 candidates=0",
      },
      {
        kind: "model_response",
        label: "final_response",
        status: "observed",
        detail: `${localFastAnswer.responseText.length} chars; provider_skipped=local_fast_path`,
      },
    ];
    const episode: EpisodeRecord = {
      id: plan.runId,
      createdAt: plan.createdAt,
      cwd,
      prompt: options.prompt,
      taskKind: plan.taskKind,
      runtimeId: plan.runtimeId,
      providerId: "muster-local",
      model: "workspace-read",
      responseText: localFastAnswer.responseText,
      evidence,
      outcome: { kind: "completed" },
    };
    await appendEpisode(episode, cwd);
    const durationMs = Date.now() - runStartedAt;
    const tokens = buildTokenRecord({
      runId: plan.runId,
      provider: "muster-local",
      model: "workspace-read",
      plannedModel: plan.route.model,
      prompt: options.prompt,
      recalledContext: "",
      responseText: localFastAnswer.responseText,
      durationMs,
      inputTokens: 0,
      outputTokens: 0,
      surfaceId: options.surfaceId,
    });
    await appendTokenRecord(tokens, cwd);
    const memoryWrite: GoalLoopMemoryWrite = { status: "skipped", reason: "local workspace read; no model memory write" };
    await appendGoalLoopTurn(buildGoalLoopTurn({
      runId: plan.runId,
      episodeId: episode.id,
      createdAt: episode.createdAt,
      activeGoal: options.prompt,
      taskKind: plan.taskKind,
      status: "completed",
      scopes,
      recallReceipt,
      memoryWrite,
    }), cwd);
    const persistMs = Date.now() - persistStartedAt;
    return {
      plan,
      episode,
      tokens,
      recalled: [],
      recallReceipt,
      timings: {
        totalMs: Date.now() - runStartedAt,
        planningMs,
        recallMs: 0,
        agentRulesMs: 0,
        skillSelectionMs: 0,
        promptBuildMs: 0,
        hookMs: 0,
        providerMs: 0,
        providerTransport: "local",
        providerAttemptCount: 0,
        fallbackMs: 0,
        backendFallbackMs: 0,
        memoryWriteMs: 0,
        persistMs,
      },
    };
  }
  const hooks = options.hooks ?? defaultHookBus;
  const activation = promptActivation(plan, options, hooks.count("prompt.build") > 0);
  const recallStartedAt = Date.now();
  const recallReceipt = options.skipRecall
    ? emptyRecallReceipt(options.prompt, scopes, options.recallLimit ?? 5)
    : await recallMemoryWithReceipt(options.prompt, scopes, options.recallLimit ?? 5, cwd);
  const recallMs = Date.now() - recallStartedAt;
  const recalled = recallReceipt.receipts.map((receipt) => receipt.memory);
  const promptBuildStartedAt = Date.now();
  const recalledBlock = buildRecalledBlock(recalled);
  const agentRulesStartedAt = Date.now();
  const rules = options.skipAgentRules ? undefined : await loadAgentRules(cwd);
  const agentRulesMs = Date.now() - agentRulesStartedAt;
  const skillSelectionStartedAt = Date.now();
  const skillAllowlist = resolveAgentSkillAllowlist(config, options.agentId);
  const skillDiscovery = config.skills?.load;
  const skipSkillSelection = options.skipSkillSelection === true || activation.mode === "lean";
  const claudeSkillSnapshot = !skipSkillSelection && plan.runtimeId === "claude-code"
    ? await exportClaudeSkillSnapshot(cwd, { skillAllowlist, discovery: skillDiscovery })
    : undefined;
  const skills = claudeSkillSnapshot
    ? { block: "", included: [...claudeSkillSnapshot.skillNames], dropped: [], includedReceipts: [...claudeSkillSnapshot.skillReceipts] }
    : skipSkillSelection
      ? { block: "", included: [], dropped: [], includedReceipts: [] }
      : await selectSkills(options.prompt, 500, cwd, { skillAllowlist, discovery: skillDiscovery });
  if (!claudeSkillSnapshot && skills.included.length) await recordSkillUse(skills.included, cwd);
  const skillSelectionMs = Date.now() - skillSelectionStartedAt;
  // Profile identity is self-knowledge for the agent, written so it shapes
  // behaviour silently (rule 6) rather than being quoted back.
  const identityBlock = config.identity
    ? [
        `You are ${config.identity.name}.`,
        config.identity.description,
        config.identity.persona,
        "Treat this as self-knowledge — never quote or narrate this section.",
      ].filter(Boolean).join(" ")
    : undefined;
  const rulesText = rules?.source === "default" && activation.mode === "lean"
    ? FAST_SIMPLE_QA_RULES
    : rules?.text;
  const stablePreamble = [identityBlock, rulesText].filter(Boolean).join("\n\n");
  const stableSystem = [stablePreamble, options.systemContext?.trim()].filter(Boolean).join("\n\n");
  const applicationContext = options.turnContext?.trim();
  const systemPreamble = [stableSystem, applicationContext].filter(Boolean).join("\n\n");
  const volatilePreamble = [skills.block, recalledBlock].filter(Boolean).join("\n\n");
  const preamble = [systemPreamble, volatilePreamble].filter(Boolean).join("\n\n");
  const assembledPrompt = preamble ? `${preamble}\n\n---\n\n${options.prompt}` : options.prompt;
  let fullPrompt = assembledPrompt;
  const hookStartedAt = Date.now();
  if (hooks.count("prompt.build")) {
    const hookOutcome = await hooks.emit("prompt.build", fullPrompt);
    if (hookOutcome.action === "block") {
      throw new Error(`Run blocked by hook ${hookOutcome.blockedBy ?? "unknown"}${hookOutcome.reason ? `: ${hookOutcome.reason}` : ""}`);
    }
    fullPrompt = hookOutcome.payload;
  }
  const hookMs = Date.now() - hookStartedAt;
  // Route the preamble to the model's *system* prompt where the runtime supports it
  // (claude-code), so the operating rules shape behaviour instead of being narrated
  // back into the answer. If a prompt.build hook rewrote the assembled prompt we can
  // no longer separate system from user, so send it as one combined message.
  const hookRewrote = fullPrompt !== assembledPrompt;
  const prompts: PromptParts = {
    combined: fullPrompt,
    user: hookRewrote ? fullPrompt : (volatilePreamble ? `${volatilePreamble}\n\n---\n\n${options.prompt}` : options.prompt),
    system: hookRewrote ? "" : systemPreamble,
    stableSystem: hookRewrote ? "" : stableSystem,
    applicationContext: hookRewrote ? undefined : applicationContext,
    claudePluginDirs: claudeSkillSnapshot ? [claudeSkillSnapshot.pluginDir] : undefined,
    capabilityMode: activation.mode,
    freshConversation: activation.freshConversation,
  };
  const promptBuildMs = Date.now() - promptBuildStartedAt;

  const rootSpan = startSpan("muster.run", {
    kind: "internal",
    attributes: { "muster.run_id": plan.runId, "muster.task_kind": plan.taskKind, "muster.runtime": plan.runtimeId },
  });
  // Each model attempt (primary or governed fallback) gets a child span under the
  // run. Per GenAI semconv the span name is "{operation} {model}" and the kind is
  // "client" (a remote model invocation). The try/finally guarantees the span is
  // ended even if the attempt throws, so spans never leak.
  const tracedAttempt = async (route: ModelRoute): Promise<AttemptResult> => {
    const span = startSpan(`chat ${route.model}`, {
      kind: "client",
      parent: rootSpan,
      attributes: genAiAttributes({ operation: "chat", system: route.provider, requestModel: route.model }),
    });
    try {
      const result = await attemptRoute(config, plan, route, prompts, {
        ...options,
        timeoutMs: options.timeoutMs ?? defaultTaskTimeoutMs(plan.taskKind),
      });
      await endSpan(span, {
        status: result.status === "completed" ? "ok" : "error",
        statusMessage: result.errorMessage,
        attributes: { "gen_ai.response.model": result.route.model },
        cwd,
      });
      return result;
    } catch (error) {
      await endSpan(span, { status: "error", statusMessage: error instanceof Error ? error.message : String(error), cwd });
      throw error;
    }
  };

  const startedAt = Date.now();
  const evidence: EvidenceRecord[] = [];
  const skillEnv = await applySkillEnvForRun(skills.included, config, cwd, process.env, skillDiscovery);
  let attempt: AttemptResult;
  let fallbackUsed: string | undefined;
  let fallbackMs = 0;
  let providerAttemptCount = 0;
  const providerStartedAt = Date.now();
  try {
    providerAttemptCount += 1;
    attempt = await tracedAttempt(plan.route);

    if (attempt.status === "failed" && attempt.fallbackEligible !== false && config.routing.fallbacks?.length) {
      for (const fallbackRoute of config.routing.fallbacks) {
        const fallbackStartedAt = Date.now();
        evidence.push({
          kind: "system_check",
          label: "model_fallback",
          status: "observed",
          detail: `Primary route ${plan.route.provider}/${plan.route.model} failed (${attempt.errorMessage ?? "unknown"}). Governed fallback to ${fallbackRoute.provider}/${fallbackRoute.model}.`,
        });
        providerAttemptCount += 1;
        const fallbackAttempt = await tracedAttempt(fallbackRoute);
        fallbackMs += Date.now() - fallbackStartedAt;
        if (fallbackAttempt.status === "completed") {
          attempt = fallbackAttempt;
          fallbackUsed = `${fallbackRoute.provider}/${fallbackRoute.model}`;
          break;
        }
        attempt = fallbackAttempt;
        if (fallbackAttempt.fallbackEligible === false) break;
      }
    }
  } finally {
    skillEnv.restore();
    await claudeSkillSnapshot?.cleanup();
  }
  const providerMs = Date.now() - providerStartedAt;

  const durationMs = Date.now() - startedAt;
  const persistStartedAt = Date.now();

  if (attempt.piResult?.eventTrace) {
    for (const trace of attempt.piResult.eventTrace) {
      if (trace.kind === "tool") {
        evidence.push({
          kind: "tool_result",
          label: trace.toolName ?? trace.type,
          status: trace.status === "failed" ? "failed" : "observed",
          detail: trace.message,
        });
      }
    }
  }
  evidence.push({
    kind: "system_check",
    label: "memory_recall",
    status: "observed",
    detail: `backend=${recallReceipt.backend} recalled=${recallReceipt.receipts.length} candidates=${recallReceipt.candidateCount} fallback=${recallReceipt.fallbackUsed}`,
  });
  evidence.push({
    kind: "system_check",
    label: "context_activation",
    status: "observed",
    detail: `mode=${activation.mode} reason=${activation.reason} history=${options.conversationKey ? (activation.freshConversation ? "fresh" : "continuity") : "none"} skills=${skipSkillSelection ? "deferred" : `selected:${skills.included.length}`} provider_context=${attempt.providerContextMode ?? "full"} trusted_system_context=${Boolean(options.systemContext?.trim())} trusted_turn_context=${Boolean(options.turnContext?.trim())}`,
  });
  evidence.push({
    kind: "system_check",
    label: "run_timing",
    status: "observed",
    detail: `total=${Date.now() - runStartedAt}ms planning=${planningMs}ms recall=${recallMs}ms rules=${agentRulesMs}ms skills=${skillSelectionMs}ms prompt=${promptBuildMs}ms hooks=${hookMs}ms provider=${providerMs}ms first_token_ms=${attempt.firstTokenMs ?? "-"} transport=${attempt.providerTransport ?? "unknown"} startup=${attempt.providerStartupMs ?? "-"}ms queue=${attempt.providerQueueMs ?? "-"}ms thread_open=${attempt.providerThreadOpenMs ?? "-"}ms request_first_delta=${attempt.providerRequestToFirstDeltaMs ?? "-"}ms cache=${attempt.providerCacheState ?? "-"} thread_state=${attempt.providerThreadOpenState ?? "-"} fallback=${fallbackMs}ms backend_fallback=${attempt.backendFallbackMs ?? 0}ms attempts=${providerAttemptCount}`,
  });
  for (const receipt of recallReceipt.receipts) {
    evidence.push({
      kind: "system_check",
      label: `memory:${receipt.memory.id}`,
      status: "observed",
      detail: `${receipt.reason}; score=${receipt.score.toFixed(3)}; scopes=${receipt.memory.scopes.map((scope) => `${scope.kind}:${scope.id}`).join(",")}; confidence=${receipt.memory.confidence}; provenance=${receipt.memory.provenance.join(",")}`,
    });
  }
  evidence.push({
    kind: "model_response",
    label: "final_response",
    status: attempt.status === "completed" ? "observed" : "failed",
    detail: attempt.status === "completed" ? `${attempt.responseText.length} chars` : attempt.errorMessage,
  });

  const episode: EpisodeRecord = {
    id: plan.runId,
    createdAt: plan.createdAt,
    cwd,
    prompt: options.prompt,
    taskKind: plan.taskKind,
    runtimeId: plan.runtimeId,
    providerId: attempt.route.provider,
    model: attempt.route.model,
    responseText: attempt.responseText,
    evidence,
    outcome: { kind: attempt.status === "completed" ? "completed" : "failed", detail: attempt.errorMessage },
  };
  await appendEpisode(episode, cwd);

  const tokens = buildTokenRecord({
    runId: plan.runId,
    provider: attempt.route.provider,
    model: attempt.route.model,
    plannedModel: plan.route.model,
    prompt: options.prompt,
    recalledContext: recalledBlock,
    responseText: attempt.responseText,
    durationMs,
    sessionMode: attempt.sessionMode ?? options.sessionMode,
    sessionId: attempt.sessionId ?? attempt.piResult?.sessionId,
    inputTokens: attempt.tokenUsage?.inputTokens,
    outputTokens: attempt.tokenUsage?.outputTokens,
    cachedInputTokens: attempt.tokenUsage?.cachedInputTokens,
    surfaceId: options.surfaceId,
    skills: skills.includedReceipts.length ? skills.includedReceipts : undefined,
  });
  await appendTokenRecord(tokens, cwd);

  await endSpan(rootSpan, {
    status: attempt.status === "completed" ? "ok" : "error",
    statusMessage: attempt.errorMessage,
    attributes: attempt.status === "completed"
      ? { "gen_ai.usage.input_tokens": tokens.inputTokens, "gen_ai.usage.output_tokens": tokens.outputTokens }
      : undefined,
    cwd,
  });

  let memoryWrite: GoalLoopMemoryWrite = attempt.status === "completed"
    ? { status: "skipped", reason: options.skipMemoryWrite ? "skipMemoryWrite=true" : "empty response" }
    : { status: "rejected", reason: "run did not complete; no memory auto-promotion" };
  const memoryWriteStartedAt = Date.now();
  if (attempt.status === "completed" && attempt.responseText && !options.skipMemoryWrite) {
    const remembered = await addMemory({
      kind: "episode_summary",
      summary: `${plan.taskKind}: ${options.prompt.slice(0, 100)} -> ${attempt.responseText.slice(0, 200)}`,
      provenance: [`run:${plan.runId}`],
      scopes: scopes.filter((scope) => scope.kind !== "global"),
      confidence: 0.6,
    }, cwd);
    memoryWrite = rememberedMemoryWrite(remembered);
  }
  const memoryWriteMs = Date.now() - memoryWriteStartedAt;

  await appendGoalLoopTurn(buildGoalLoopTurn({
    runId: plan.runId,
    episodeId: episode.id,
    createdAt: episode.createdAt,
    activeGoal: options.prompt,
    taskKind: plan.taskKind,
    status: episode.outcome?.kind ?? "unknown",
    scopes,
    recallReceipt,
    memoryWrite,
  }), cwd);

  const persistMs = Date.now() - persistStartedAt;
  const timings: RunTimingBreakdown = {
    totalMs: Date.now() - runStartedAt,
    planningMs,
    recallMs,
    agentRulesMs,
    skillSelectionMs,
    promptBuildMs,
    hookMs,
    providerMs,
    firstTokenMs: attempt.firstTokenMs,
    providerTransport: attempt.providerTransport,
    providerAttemptCount,
    providerStartupMs: attempt.providerStartupMs,
    providerQueueMs: attempt.providerQueueMs,
    providerThreadOpenMs: attempt.providerThreadOpenMs,
    providerRequestToFirstDeltaMs: attempt.providerRequestToFirstDeltaMs,
    providerCacheState: attempt.providerCacheState,
    providerThreadOpenState: attempt.providerThreadOpenState,
    fallbackMs,
    backendFallbackMs: attempt.backendFallbackMs ?? 0,
    memoryWriteMs,
    persistMs,
  };

  if (options.hooks?.count("turn.end")) {
    await options.hooks.emit("turn.end", { event: "turn.end", prompt: options.prompt, responseText: episode.responseText }).catch(() => undefined);
  }
  return { plan, episode, tokens, recalled, recallReceipt, timings, fallbackUsed, piResult: attempt.piResult, codexThreadId: attempt.codexThreadId, ...(attempt.context ? { context: attempt.context } : {}), ...(attempt.providerTurnId ? { providerTurnId: attempt.providerTurnId } : {}) };
}
