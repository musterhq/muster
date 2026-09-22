import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join as pathJoin } from "node:path";
import { tmpdir } from "node:os";

/** Lifecycle contract consumed by Agent Mode. Keep it opt-in for older callers. */
export const CODEX_RUN_LIFECYCLE_VERSION = 1;

export interface CodexAppServerBudgets {
  readonly idleMs: number;
  readonly requestMs: number;
  readonly turnMs: number;
}

export interface CodexAppServerRunInput {
  readonly prompt: string;
  readonly cwd: string;
  readonly model?: string;
  readonly reasoning?: "none" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
  /** Native app-server developer contract; sent in protocol, never process arguments. */
  readonly developerInstructions?: string;
  /** Fresh host-verified context for this turn; never made sticky on the provider thread. */
  readonly applicationContext?: string;
  readonly instructionsFile?: string;
  readonly sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  readonly networkAccess?: boolean;
  readonly env?: Record<string, string>;
  readonly timeoutMs?: number;
  /** Independent lifecycle budgets; omitted callers retain legacy timeout behavior. */
  readonly budgets?: CodexAppServerBudgets;
  /** Cancellation is scoped to this run and never implies remote completion. */
  readonly signal?: AbortSignal;
  readonly onThreadReady?: (threadId: string) => void;
  readonly onTurnAccepted?: (identity: { readonly threadId: string; readonly turnId: string; readonly dispatchState: "dispatched" }) => void;
  readonly command?: string;
  /** Native Codex config overrides supplied by the governed host. */
  readonly configOverrides?: readonly string[];
  /** Persisted Codex thread to re-open when no warm process is cached. */
  readonly threadId?: string;
  /** Stable conversation identity. Omit it to disable cross-call process reuse. */
  readonly cacheKey?: string;
  /** Long-lived host that owns the warm process (gateway, RPC server, or TUI). */
  readonly transportOwner?: string;
  readonly keepAlive?: boolean;
  /** Start a fresh provider thread while retaining the already-warm app-server process. */
  readonly rotateThread?: boolean;
  readonly onDelta?: (text: string) => void;
  /** Provider-visible reasoning summary deltas. Raw hidden reasoning is never forwarded. */
  readonly onReasoningDelta?: (text: string) => void;
  /**
   * Every `item/*` and `turn/*` notification, raw. This is how an IDE paints
   * streaming file edits (`item/fileChange/outputDelta` carries the patch text
   * token by token) and tool activity live, the way the Codex app does.
   */
  readonly onEvent?: (method: string, params: Record<string, unknown>) => void;
  /**
   * Server→client requests (approvals, MCP elicitations such as Computer Use's
   * "Allow ChatGPT to use Safari?", user-input prompts). Return the response
   * to send; return undefined to decline. Without a handler every request is
   * declined — which is why computer use never worked from muster before.
   */
  readonly onRequest?: (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown> | undefined>;
  /** Per-turn approval policy (turn/start `approvalPolicy`); the thread itself starts with "never". */
  readonly approvalPolicy?: "untrusted" | "on-request" | "never";
  /** Local image paths attached to the prompt (turn/start `localImage` inputs). */
  readonly images?: readonly string[];
  /** Codex collaboration mode for the turn: plan mode is `{ mode: "plan", settings: { model, reasoning_effort } }`. */
  readonly collaborationMode?: CodexCollaborationMode;
}

export interface CodexCollaborationMode {
  readonly mode: "plan" | "default";
  readonly settings: { readonly model: string; readonly reasoning_effort?: string | null; readonly developer_instructions?: string | null };
}

export type CodexAppServerCacheState = "hit" | "miss" | "shared-miss" | "disabled";

export interface CodexAppServerTimings {
  readonly startupMs: number;
  readonly queueMs: number;
  readonly threadOpenMs: number;
  readonly requestToFirstDeltaMs?: number;
  readonly cacheState: CodexAppServerCacheState;
  readonly threadOpenState: "cached" | "started" | "resumed";
}

export interface CodexAppServerRunResult {
  readonly status: "completed" | "failed";
  readonly finalMessage: string;
  readonly threadId?: string;
  readonly durationMs: number;
  readonly firstDeltaMs?: number;
  readonly timings?: CodexAppServerTimings;
  readonly errorMessage?: string;
  /** Whether turn/start was accepted by the provider. A dispatched turn is never retried automatically. */
  readonly dispatchState: "not-dispatched" | "dispatched" | "unknown";
  readonly turnId?: string;
  readonly failure?: {
    readonly kind: "rpc-rejected" | "request-timeout" | "aborted";
    readonly method?: string;
    readonly statusCode?: number;
    readonly retryAfterMs?: number;
    readonly requestId?: string;
  };
  /** A cold app-server failure may safely fall back; an active turn may not be replayed. */
  readonly fallbackEligible?: boolean;
  readonly hadActivity?: boolean;
  readonly tokenUsage?: {
    readonly inputTokens?: number;
    readonly cachedInputTokens?: number;
    readonly outputTokens?: number;
    readonly reasoningOutputTokens?: number;
  };
}

interface PendingRequest {
  readonly method: string;
  readonly resolve: (value: Record<string, unknown>) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

class CodexRpcError extends Error {
  constructor(
    message: string,
    readonly method: string,
    readonly code?: number,
    readonly data?: Record<string, unknown>,
  ) { super(message); this.name = "CodexRpcError"; }
}

class CodexRunError extends Error {
  constructor(
    message: string,
    readonly dispatchState: CodexAppServerRunResult["dispatchState"],
    readonly failure?: CodexAppServerRunResult["failure"],
  ) { super(message); this.name = "CodexRunError"; }
}

interface CachedSession {
  readonly client: CodexAppServerClient;
  threadId: string;
  readonly cacheKey: string;
  readonly conversationKey?: string;
  readonly transportOwner?: string;
  readonly cwd: string;
  readonly model?: string;
  readonly scopeKey: string;
  readonly createdAt: number;
  lastUsedAt: number;
  pendingRuns: number;
  queue: Promise<void>;
  idleTimer?: NodeJS.Timeout;
}

interface CreatedSession {
  readonly session: CachedSession;
  readonly startupMs: number;
  readonly threadOpenMs: number;
  readonly threadOpenState: "started" | "resumed";
}

interface SessionLease extends CreatedSession {
  readonly cacheState: CodexAppServerCacheState;
}

interface SessionCreation {
  readonly conversationKey?: string;
  readonly transportOwner?: string;
  readonly requestedThreadId?: string;
  waiters: number;
  client?: CodexAppServerClient;
  promise: Promise<CreatedSession>;
}

interface ClientMetadata {
  readonly conversationKey?: string;
  readonly transportOwner?: string;
  session?: CachedSession;
}

const SESSION_CACHE = new Map<string, CachedSession>();
const SESSION_CREATIONS = new Map<string, SessionCreation>();
const ACTIVE_CLIENTS = new Map<CodexAppServerClient, ClientMetadata>();
const DEFAULT_SESSION_CACHE_SIZE = 8;
const DEFAULT_SESSION_IDLE_MS = 30 * 60_000;
const DEFAULT_GATEWAY_SESSION_IDLE_MS = 5 * 60_000;

export function gatewayCodexWarmThreadStatePath(pid: number): string {
  return pathJoin(tmpdir(), `muster-gateway-codex-${pid}.json`);
}

export function readGatewayCodexWarmThreadCount(pid: number): number {
  try {
    const parsed = JSON.parse(readFileSync(gatewayCodexWarmThreadStatePath(pid), "utf8")) as { pid?: unknown; count?: unknown };
    return parsed.pid === pid && Number.isSafeInteger(parsed.count) && Number(parsed.count) >= 0 ? Number(parsed.count) : 0;
  } catch {
    return 0;
  }
}

function recordGatewayWarmThreadCount(): void {
  const count = [...SESSION_CACHE.values()].filter((session) => session.transportOwner?.startsWith("gateway:")).length;
  const path = gatewayCodexWarmThreadStatePath(process.pid);
  if (count === 0) {
    try { unlinkSync(path); } catch { /* already absent */ }
    return;
  }
  writeFileSync(path, `${JSON.stringify({ pid: process.pid, count, updatedAt: new Date().toISOString() })}\n`, { mode: 0o600 });
}

export function clearCodexAppServerSessions(transportOwner?: string): void {
  for (const [key, session] of SESSION_CACHE) {
    if (transportOwner === undefined || session.transportOwner === transportOwner) {
      if (session.idleTimer) clearTimeout(session.idleTimer);
      SESSION_CACHE.delete(key);
    }
  }
  for (const [key, creation] of SESSION_CREATIONS) {
    if (transportOwner === undefined || creation.transportOwner === transportOwner) SESSION_CREATIONS.delete(key);
  }
  for (const [client, metadata] of ACTIVE_CLIENTS) {
    if (transportOwner === undefined || metadata.transportOwner === transportOwner) client.close();
  }
  recordGatewayWarmThreadCount();
}

/** Interrupt the active native Codex turn owned by this host, if there is one. */
export async function interruptActiveCodexTurn(transportOwner?: string, conversationKey?: string): Promise<boolean> {
  const attempts = [...ACTIVE_CLIENTS]
    .filter(([, metadata]) => (transportOwner === undefined || metadata.transportOwner === transportOwner) && (conversationKey === undefined || metadata.conversationKey === conversationKey))
    .map(([client]) => client.interruptActiveTurn());
  if (!attempts.length) return false;
  return (await Promise.allSettled(attempts)).some((result) => result.status === "fulfilled" && result.value);
}

/**
 * Inject a user message into the turn that is running right now (`turn/steer`): the model sees it at its
 * next step, the way the Codex app and CLI let you type mid-turn. False when no matching turn is active.
 */
export async function steerActiveCodexTurn(text: string, transportOwner?: string, conversationKey?: string): Promise<boolean> {
  for (const [client, metadata] of ACTIVE_CLIENTS) {
    if (transportOwner !== undefined && metadata.transportOwner !== transportOwner) continue;
    if (conversationKey !== undefined && metadata.conversationKey !== conversationKey) continue;
    try { if (await client.steerActiveTurn(text)) return true; } catch { /* try the next client */ }
  }
  return false;
}

/**
 * Call a method on the warm process that owns a conversation (`thread/rollback`, `thread/name/set`, …);
 * a thread has one writer, so this must not go through a fresh process while one is warm. Falls back
 * to a one-shot process when nothing is warm for the conversation.
 */
export async function callCodexConversation(
  conversationKey: string,
  method: string,
  params: Record<string, unknown>,
  options: { readonly transportOwner?: string; readonly cwd?: string; readonly timeoutMs?: number; readonly requireOwner?: boolean } = {},
): Promise<Record<string, unknown>> {
  for (const [client, metadata] of ACTIVE_CLIENTS) {
    if (metadata.conversationKey !== conversationKey) continue;
    if (options.transportOwner !== undefined && metadata.transportOwner !== options.transportOwner) continue;
    if (!client.isAlive()) continue;
    return client.call(method, params, options.timeoutMs ?? 30_000);
  }
  if (options.requireOwner) throw new Error(`No live app-server owner for conversation ${conversationKey}.`);
  return queryCodexAppServer(method, params, { ...(options.cwd ? { cwd: options.cwd } : {}), ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) });
}

/**
 * Ask the app-server one question with a throwaway process — which models,
 * permission profiles, threads, skills it knows — so hosts never hardcode them.
 */
export async function queryCodexAppServer(
  method: string,
  params: Record<string, unknown> = {},
  options: { readonly cwd?: string; readonly command?: string; readonly timeoutMs?: number } = {},
): Promise<Record<string, unknown>> {
  const client = new CodexAppServerClient({ command: resolveCodexCommand(options.command), cwd: options.cwd ?? process.cwd() });
  try {
    await client.initialize();
    return await client.call(method, params, options.timeoutMs ?? 15_000);
  } finally {
    client.close();
  }
}

/** Drop only one conversation's warm process; other chats keep their cache state. */
export function clearCodexAppServerConversation(conversationKey: string, transportOwner?: string): void {
  for (const [key, session] of SESSION_CACHE) {
    if (session.conversationKey !== conversationKey || (transportOwner !== undefined && session.transportOwner !== transportOwner)) continue;
    if (session.idleTimer) clearTimeout(session.idleTimer);
    SESSION_CACHE.delete(key);
  }
  for (const [key, creation] of SESSION_CREATIONS) {
    if (creation.conversationKey !== conversationKey || (transportOwner !== undefined && creation.transportOwner !== transportOwner)) continue;
    SESSION_CREATIONS.delete(key);
    creation.client?.close();
  }
  for (const [client, metadata] of ACTIVE_CLIENTS) {
    if (metadata.conversationKey !== conversationKey || (transportOwner !== undefined && metadata.transportOwner !== transportOwner)) continue;
    if (!metadata.session || metadata.session.pendingRuns === 0) client.close();
  }
  recordGatewayWarmThreadCount();
}

export async function runCodexAppServer(input: CodexAppServerRunInput): Promise<CodexAppServerRunResult> {
  if (!input.prompt.trim()) throw new Error("Codex prompt is required.");
  validateLifecycleBudgets(input.budgets);
  if (input.signal?.aborted) return coldFailure(new CodexRunError("Codex turn was cancelled before dispatch.", "not-dispatched", { kind: "aborted" }), Date.now());
  if (!(input.configOverrides ?? []).some((value) => /^model_reasoning_summary\s*=/.test(value))) {
    // Request provider-approved summaries for the transcript without changing
    // ~/.codex/config.toml. Models that emit no summary remain silent.
    input = { ...input, configOverrides: [...(input.configOverrides ?? []), 'model_reasoning_summary="detailed"'] };
  }
  const started = Date.now();
  const keepAlive = (input.keepAlive ?? true) && input.cacheKey !== undefined;
  const instructionsHash = await hashInstructions(input.developerInstructions, input.instructionsFile);
  const command = resolveCodexCommand(input.command);
  const conversationIdentity = input.cacheKey ?? `anonymous:${randomUUID()}`;
  const scopeKey = appServerScopeKey(input, command, conversationIdentity);
  const key = `${scopeKey}\0instructions:${instructionsHash}`;
  let lease: SessionLease;
  try {
    lease = await acquireSession({ input, command, key, scopeKey, keepAlive });
  } catch (error) {
    if (input.threadId && missingProviderThread(error)) {
      try {
        lease = await acquireSession({ input: { ...input, threadId: undefined }, command, key, scopeKey, keepAlive });
      } catch (recoveryError) {
        return coldFailure(recoveryError, started);
      }
    } else {
      return coldFailure(error, started);
    }
  }

  let queueMs = 0;
  let firstDeltaAt: number | undefined;
  let providerActivity = false;
  let effectiveThreadOpenMs = lease.threadOpenMs;
  let effectiveThreadOpenState: CodexAppServerTimings["threadOpenState"] = lease.cacheState === "hit" ? "cached" : lease.threadOpenState;
  return await runExclusive(lease.session, async (measuredQueueMs) => {
    queueMs = measuredQueueMs;
    if (keepAlive) {
      // A turn queued behind another one must take ownership only after it
      // acquires the session queue. Stopping observation before queuing lets
      // the preceding turn restart the observer and consume the queued turn's
      // notifications before this run can read them.
      await lease.session.client.stopObservation();
      lease.session.client.setObserver({ ...(input.onEvent ? { onEvent: input.onEvent } : {}), ...(input.onRequest ? { onRequest: input.onRequest } : {}) });
    }
    input.onThreadReady?.(lease.session.threadId);
    if (input.rotateThread && lease.cacheState === "hit") {
      const threadOpenStartedAt = Date.now();
      lease.session.threadId = await lease.session.client.startThread(input.cwd);
      effectiveThreadOpenMs += Date.now() - threadOpenStartedAt;
      effectiveThreadOpenState = "started";
      input.onThreadReady?.(lease.session.threadId);
    }
    const turn = await lease.session.client.runTurn({
      threadId: lease.session.threadId,
      prompt: input.prompt,
      applicationContext: input.applicationContext,
      ...(input.approvalPolicy ? { approvalPolicy: input.approvalPolicy } : {}),
      ...(input.images?.length ? { images: input.images } : {}),
      ...(input.collaborationMode ? { collaborationMode: input.collaborationMode } : {}),
      timeoutMs: input.timeoutMs ?? 180_000,
      ...(input.budgets ? { budgets: input.budgets } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      onTurnAccepted: (identity) => { providerActivity = true; input.onTurnAccepted?.(identity); },
      onDelta: (text) => {
        providerActivity = true;
        firstDeltaAt ??= Date.now();
        input.onDelta?.(text);
      },
      onReasoningDelta: (text) => {
        providerActivity = true;
        input.onReasoningDelta?.(text);
      },
      onActivity: () => { providerActivity = true; },
      ...(input.onEvent ? { onEvent: (method: string, params: Record<string, unknown>) => { providerActivity = true; input.onEvent?.(method, params); } } : {}),
      ...(input.onRequest ? { onRequest: input.onRequest } : {}),
    });
    if (keepAlive) await lease.session.client.startObservation();
    const requestToFirstDeltaMs = firstDeltaAt === undefined ? undefined : firstDeltaAt - started;
    const result = {
      status: turn.errorMessage ? "failed" : "completed",
      finalMessage: turn.finalMessage,
      threadId: lease.session.threadId,
      durationMs: Date.now() - started,
      firstDeltaMs: turn.firstDeltaMs,
      timings: appServerTimings(
        lease,
        queueMs,
        requestToFirstDeltaMs,
        effectiveThreadOpenMs,
        effectiveThreadOpenState,
      ),
      errorMessage: turn.errorMessage,
      dispatchState: turn.turnId ? "dispatched" : turn.failure?.kind === "rpc-rejected" || turn.failure?.kind === "aborted" ? "not-dispatched" : providerActivity ? "dispatched" : "unknown",
      ...(turn.turnId ? { turnId: turn.turnId } : {}),
      ...(turn.failure ? { failure: turn.failure } : {}),
      fallbackEligible: turn.errorMessage ? !providerActivity : false,
      hadActivity: providerActivity,
      tokenUsage: turn.tokenUsage,
    } as const;
    if (turn.errorMessage) {
      lease.session.client.close();
      if (SESSION_CACHE.get(key) === lease.session) SESSION_CACHE.delete(key);
    }
    if (SESSION_CACHE.get(key) === lease.session) pruneSessionCache(Date.now(), key);
    return result;
  }).catch((error: unknown) => {
      lease.session.client.close();
      if (SESSION_CACHE.get(key) === lease.session) SESSION_CACHE.delete(key);
      return {
        status: "failed",
        finalMessage: "",
        threadId: lease.session.threadId,
        durationMs: Date.now() - started,
        timings: appServerTimings(
          lease,
          queueMs,
          firstDeltaAt === undefined ? undefined : firstDeltaAt - started,
          effectiveThreadOpenMs,
          effectiveThreadOpenState,
        ),
        errorMessage: error instanceof Error ? error.message : String(error),
        dispatchState: lease.session.client.dispatchedTurnId() ? "dispatched" : error instanceof CodexRunError ? error.dispatchState : providerActivity ? "unknown" : "unknown",
        ...(lease.session.client.dispatchedTurnId() ? { turnId: lease.session.client.dispatchedTurnId() } : {}),
        ...(error instanceof CodexRunError && error.failure ? { failure: error.failure } : {}),
        fallbackEligible: !providerActivity && (error instanceof CodexRunError ? error.dispatchState === "not-dispatched" : false),
        hadActivity: providerActivity,
      };
    });
}

function coldFailure(error: unknown, started: number): CodexAppServerRunResult {
  return {
    status: "failed",
    finalMessage: "",
    durationMs: Date.now() - started,
    errorMessage: error instanceof Error ? error.message : String(error),
    dispatchState: "not-dispatched",
    ...(error instanceof CodexRunError && error.failure ? { failure: error.failure } : {}),
    fallbackEligible: true,
    hadActivity: false,
  };
}

function validateLifecycleBudgets(budgets: CodexAppServerBudgets | undefined): void {
  if (!budgets) return;
  for (const [name, value] of Object.entries(budgets)) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) {
      throw new Error(`Codex ${name} must be a positive finite millisecond budget no greater than 2147483647.`);
    }
  }
}

function rpcFailure(error: CodexRpcError): NonNullable<CodexAppServerRunResult["failure"]> {
  const source = `${error.message} ${JSON.stringify(error.data ?? {})}`;
  const statusCode = numberValue(error.data?.statusCode)
    ?? numberValue(error.data?.status_code)
    ?? (Number(source.match(/\b(?:HTTP\s*)?(429|503)\b/i)?.[1]) || undefined);
  const retryRaw = error.data?.retryAfterMs ?? error.data?.retry_after_ms;
  const retryAfterMs = typeof retryRaw === "number" && Number.isFinite(retryRaw) && retryRaw >= 0 ? Math.floor(retryRaw) : undefined;
  const requestId = stringValue(error.data?.requestId) ?? stringValue(error.data?.request_id) ?? stringValue(error.data?.requestID);
  return {
    kind: "rpc-rejected",
    method: error.method,
    ...(statusCode ? { statusCode } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    ...(requestId ? { requestId } : {}),
  };
}

function missingProviderThread(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:no rollout found|unknown thread|thread (?:not found|does not exist)|session (?:not found|does not exist))/i.test(message);
}

function appServerTimings(
  lease: SessionLease,
  queueMs: number,
  requestToFirstDeltaMs?: number,
  threadOpenMs = lease.threadOpenMs,
  threadOpenState: CodexAppServerTimings["threadOpenState"] = lease.cacheState === "hit" ? "cached" : lease.threadOpenState,
): CodexAppServerTimings {
  return {
    startupMs: lease.startupMs,
    queueMs,
    threadOpenMs,
    requestToFirstDeltaMs,
    cacheState: lease.cacheState,
    threadOpenState,
  };
}

async function acquireSession(input: {
  readonly input: CodexAppServerRunInput;
  readonly command: string;
  readonly key: string;
  readonly scopeKey: string;
  readonly keepAlive: boolean;
}): Promise<SessionLease> {
  const { key, scopeKey, keepAlive } = input;
  pruneSessionCache(Date.now(), key);
  const cached = keepAlive ? SESSION_CACHE.get(key) : undefined;
  if (cached?.client.isAlive() && (!input.input.threadId || cached.threadId === input.input.threadId)) {
    if (cached.idleTimer) clearTimeout(cached.idleTimer);
    cached.idleTimer = undefined;
    cached.pendingRuns += 1;
    cached.lastUsedAt = Date.now();
    SESSION_CACHE.delete(key);
    SESSION_CACHE.set(key, cached);
    return { session: cached, startupMs: 0, threadOpenMs: 0, threadOpenState: "started", cacheState: "hit" };
  }
  if (cached) invalidateCachedSession(key, cached);
  if (keepAlive) closeSupersededSessions(scopeKey, key);

  const existing = keepAlive ? SESSION_CREATIONS.get(key) : undefined;
  if (existing) {
    if (existing.requestedThreadId !== input.input.threadId) {
      await existing.promise.catch(() => undefined);
      return acquireSession(input);
    }
    existing.waiters += 1;
    const created = await existing.promise;
    return { ...created, cacheState: "shared-miss" };
  }

  const creation = {
    conversationKey: input.input.cacheKey,
    transportOwner: input.input.transportOwner,
    requestedThreadId: input.input.threadId,
    waiters: 1,
  } as SessionCreation;
  creation.promise = createSession(input, creation).finally(() => {
    if (SESSION_CREATIONS.get(key) === creation) SESSION_CREATIONS.delete(key);
  });
  if (keepAlive) SESSION_CREATIONS.set(key, creation);
  const created = await creation.promise;
  return { ...created, cacheState: keepAlive ? "miss" : "disabled" };
}

async function createSession(
  input: {
    readonly input: CodexAppServerRunInput;
    readonly command: string;
    readonly key: string;
    readonly scopeKey: string;
    readonly keepAlive: boolean;
  },
  creation: SessionCreation,
): Promise<CreatedSession> {
  const startupStartedAt = Date.now();
  const client = new CodexAppServerClient({
    command: input.command,
    cwd: input.input.cwd,
    model: input.input.model,
    reasoning: input.input.reasoning,
    developerInstructions: input.input.developerInstructions,
    networkAccess: input.input.networkAccess,
    configOverrides: input.input.configOverrides,
    sandbox: input.input.sandbox,
    env: input.input.env,
    onClose: () => {
      const metadata = ACTIVE_CLIENTS.get(client);
      if (metadata?.session && SESSION_CACHE.get(metadata.session.cacheKey) === metadata.session) {
        if (metadata.session.idleTimer) clearTimeout(metadata.session.idleTimer);
        SESSION_CACHE.delete(metadata.session.cacheKey);
      }
      ACTIVE_CLIENTS.delete(client);
      recordGatewayWarmThreadCount();
    },
  });
  creation.client = client;
  const metadata: ClientMetadata = { conversationKey: input.input.cacheKey, transportOwner: input.input.transportOwner };
  ACTIVE_CLIENTS.set(client, metadata);
  try {
    await client.initialize();
    const startupMs = Date.now() - startupStartedAt;
    const threadOpenStartedAt = Date.now();
    const threadId = input.input.threadId
      ? await client.resumeThread(input.input.threadId, input.input.cwd)
      : await client.startThread(input.input.cwd);
    const threadOpenMs = Date.now() - threadOpenStartedAt;
    const now = Date.now();
    const session: CachedSession = {
      client,
      threadId,
      cacheKey: input.key,
      conversationKey: input.input.cacheKey,
      transportOwner: input.input.transportOwner,
      cwd: input.input.cwd,
      model: input.input.model,
      scopeKey: input.scopeKey,
      createdAt: now,
      lastUsedAt: now,
      pendingRuns: creation.waiters,
      queue: Promise.resolve(),
    };
    metadata.session = session;
    if (input.keepAlive && makeSessionCacheRoom(input.key)) {
      SESSION_CACHE.set(input.key, session);
      recordGatewayWarmThreadCount();
    }
    return { session, startupMs, threadOpenMs, threadOpenState: input.input.threadId ? "resumed" : "started" };
  } catch (error) {
    client.close();
    throw error;
  }
}

async function runExclusive<T>(session: CachedSession, task: (queueMs: number) => Promise<T>): Promise<T> {
  const queuedAt = Date.now();
  const previous = session.queue.catch(() => {});
  let release!: () => void;
  session.queue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await task(Date.now() - queuedAt);
  } finally {
    session.pendingRuns -= 1;
    session.lastUsedAt = Date.now();
    release();
    if (session.pendingRuns === 0 && SESSION_CACHE.get(session.cacheKey) !== session) session.client.close();
    else if (session.pendingRuns === 0) scheduleIdleClose(session);
  }
}

function positiveIntegerEnv(name: string, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(process.env[name]);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function appServerScopeKey(input: CodexAppServerRunInput, command: string, conversationIdentity: string): string {
  const env = [...Object.entries(input.env ?? {})].sort(([left], [right]) => left.localeCompare(right));
  return createHash("sha256").update(JSON.stringify({
    conversation: conversationIdentity,
    transportOwner: input.transportOwner ?? "",
    cwd: input.cwd,
    model: input.model ?? "",
    reasoning: input.reasoning ?? "",
    command,
    networkAccess: input.networkAccess === true,
    configOverrides: input.configOverrides ?? [],
    sandbox: input.sandbox ?? "workspace-write",
    env,
  })).digest("hex");
}

export function buildCodexAppServerArgs(input: {
  readonly model?: string;
  readonly reasoning?: "none" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
  readonly networkAccess?: boolean;
  readonly configOverrides?: readonly string[];
}): string[] {
  const args = ["app-server", "--stdio"];
  if (input.model) args.push("-c", `model=${JSON.stringify(input.model)}`);
  if (input.reasoning) args.push("-c", `model_reasoning_effort=${JSON.stringify(input.reasoning === "none" ? "low" : input.reasoning)}`);
  if (input.networkAccess) args.push("-c", "sandbox_workspace_write.network_access=true");
  for (const override of input.configOverrides ?? []) args.push("-c", override);
  return args;
}

function closeCachedSession(key: string, session: CachedSession): void {
  if (session.pendingRuns > 0) return;
  if (session.idleTimer) clearTimeout(session.idleTimer);
  SESSION_CACHE.delete(key);
  session.client.close();
  recordGatewayWarmThreadCount();
}

function invalidateCachedSession(key: string, session: CachedSession): void {
  if (session.idleTimer) clearTimeout(session.idleTimer);
  SESSION_CACHE.delete(key);
  if (session.pendingRuns === 0) session.client.close();
  recordGatewayWarmThreadCount();
}

function sessionIdleMs(session: Pick<CachedSession, "transportOwner">): number {
  return session.transportOwner?.startsWith("gateway:")
    ? positiveIntegerEnv("MUSTER_GATEWAY_CODEX_IDLE_MS", DEFAULT_GATEWAY_SESSION_IDLE_MS, 1_000, 24 * 60 * 60_000)
    : positiveIntegerEnv("MUSTER_NATIVE_SESSION_IDLE_MS", DEFAULT_SESSION_IDLE_MS, 1_000, 24 * 60 * 60_000);
}

function scheduleIdleClose(session: CachedSession): void {
  if (session.idleTimer) clearTimeout(session.idleTimer);
  const idleMs = sessionIdleMs(session);
  session.idleTimer = setTimeout(() => {
    if (session.pendingRuns === 0 && session.client.hasObservedActiveWork() && SESSION_CACHE.get(session.cacheKey) === session) {
      scheduleIdleClose(session);
      return;
    }
    if (session.pendingRuns === 0 && Date.now() - session.lastUsedAt >= idleMs && SESSION_CACHE.get(session.cacheKey) === session) {
      closeCachedSession(session.cacheKey, session);
    }
  }, idleMs);
  session.idleTimer.unref?.();
}

function closeSupersededSessions(scopeKey: string, protectedKey: string): void {
  for (const [key, session] of SESSION_CACHE) {
    if (key !== protectedKey && session.scopeKey === scopeKey) invalidateCachedSession(key, session);
  }
}

function makeSessionCacheRoom(protectedKey: string): boolean {
  const maxSize = positiveIntegerEnv("MUSTER_NATIVE_SESSION_CACHE_SIZE", DEFAULT_SESSION_CACHE_SIZE, 1, 64);
  for (const [key, session] of [...SESSION_CACHE.entries()].sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt)) {
    if (SESSION_CACHE.size < maxSize) break;
    if (key === protectedKey) continue;
    closeCachedSession(key, session);
  }
  return SESSION_CACHE.size < maxSize;
}

function pruneSessionCache(now: number, protectedKey: string): void {
  for (const [key, session] of SESSION_CACHE) {
    if (key === protectedKey) continue;
    if (!session.client.isAlive()) invalidateCachedSession(key, session);
    else if (now - session.lastUsedAt >= sessionIdleMs(session)) closeCachedSession(key, session);
  }
  makeSessionCacheRoom(protectedKey);
}

async function hashInstructions(direct: string | undefined, path: string | undefined): Promise<string> {
  const content = direct ?? (path ? await readFile(path, "utf8").catch(() => "") : "");
  if (!content) return "";
  return createHash("sha256").update(content).digest("hex");
}

class CodexAppServerClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly onClose?: () => void;
  private readonly developerInstructions?: string;
  private readonly sandbox: "read-only" | "workspace-write" | "danger-full-access";
  private nextId = 1;
  private stdoutBuffer = "";
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notifications: Record<string, unknown>[] = [];
  private readonly waiters: Array<(message: Record<string, unknown>) => void> = [];
  private readonly stderrLines: string[] = [];
  private activeTurn?: { readonly threadId: string; readonly turnId: string };
  private lastDispatchedTurnId: string | undefined;
  private observer?: {
    readonly onEvent?: (method: string, params: Record<string, unknown>) => void;
    readonly onRequest?: (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown> | undefined>;
  };
  private observing = false;
  private observationPromise?: Promise<void>;
  private observationWake?: () => void;
  private observationTimer?: NodeJS.Timeout;
  private readonly observedActiveThreads = new Set<string>();
  private readonly maxNotifications = 512;
  private closed = false;

  constructor(input: {
    readonly command: string;
    readonly cwd: string;
    readonly model?: string;
    readonly reasoning?: "none" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
    readonly developerInstructions?: string;
    readonly sandbox?: "read-only" | "workspace-write" | "danger-full-access";
    readonly networkAccess?: boolean;
    readonly configOverrides?: readonly string[];
    readonly env?: Record<string, string>;
    readonly onClose?: () => void;
  }) {
    this.onClose = input.onClose;
    this.developerInstructions = input.developerInstructions;
    this.sandbox = input.sandbox ?? "workspace-write";
    const args = buildCodexAppServerArgs(input);
    this.child = spawn(input.command, args, {
      cwd: input.cwd,
      env: { ...process.env, ...(input.env ?? {}), RUST_LOG: process.env.RUST_LOG ?? "warn" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.on("data", (chunk: Buffer) => this.readStdout(chunk.toString("utf8")));
    this.child.stderr.on("data", (chunk: Buffer) => this.readStderr(chunk.toString("utf8")));
    this.child.on("error", (error) => {
      this.finishClose(new Error(this.formatError(`codex app-server failed to start: ${error.message}`)));
    });
    this.child.on("exit", () => {
      this.finishClose(new Error(this.formatError("codex app-server exited")));
    });
  }

  isAlive(): boolean {
    return !this.closed && this.child.exitCode === null && !this.child.killed;
  }

  close(): void {
    if (this.closed) return;
    this.observing = false;
    this.observationWake?.();
    this.finishClose(new Error(this.formatError("codex app-server closed")));
    this.child.kill();
    this.child.stdin.destroy();
  }

  setObserver(observer: { readonly onEvent?: (method: string, params: Record<string, unknown>) => void; readonly onRequest?: (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown> | undefined> } | undefined): void { this.observer = observer; }

  async startObservation(): Promise<void> {
    if (this.observing || this.closed || !this.observer) return;
    this.observing = true;
    this.observationPromise = (async () => {
      while (this.observing && !this.closed) {
        const message = await this.takeObservedNotification();
        if (!this.observing) {
          // Do not let a notification arriving at the stop boundary vanish
          // between the observer and the next typed parent turn.
          if (message) this.notifications.unshift(message);
          break;
        }
        if (message) this.dispatchObserved(message);
      }
    })().finally(() => { this.observationPromise = undefined; });
    await Promise.resolve();
  }

  async stopObservation(): Promise<void> {
    this.observing = false;
    this.observationWake?.();
    await this.observationPromise;
  }

  hasObservedActiveWork(): boolean { return this.observedActiveThreads.size > 0; }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: { name: "muster", title: "Muster", version: "0.1" },
      capabilities: { experimentalApi: true },
    }, 10_000);
    this.notify("initialized");
  }

  /** One-shot JSON-RPC call after initialize (model/list, permissionProfile/list, thread/list, …). */
  call(method: string, params: Record<string, unknown>, timeoutMs = 15_000): Promise<Record<string, unknown>> {
    return this.request(method, params, timeoutMs);
  }

  async startThread(cwd: string): Promise<string> {
    const result = await this.request("thread/start", {
      cwd,
      approvalPolicy: "never",
      sandbox: this.sandbox,
      ...(this.developerInstructions ? { developerInstructions: this.developerInstructions } : {}),
    }, 15_000);
    const thread = asRecord(result.thread);
    const threadId = stringValue(thread.id) ?? stringValue(thread.sessionId) ?? stringValue(result.sessionId) ?? stringValue(result.threadId);
    if (!threadId) throw new Error("codex app-server thread/start returned no thread id");
    return threadId;
  }

  async resumeThread(threadId: string, cwd: string): Promise<string> {
    const result = await this.request("thread/resume", {
      threadId,
      cwd,
      excludeTurns: true,
      approvalPolicy: "never",
      sandbox: this.sandbox,
      ...(this.developerInstructions ? { developerInstructions: this.developerInstructions } : {}),
    }, 30_000);
    const thread = asRecord(result.thread);
    const resumedId = stringValue(thread.id) ?? stringValue(thread.sessionId) ?? stringValue(result.sessionId) ?? stringValue(result.threadId);
    if (!resumedId) throw new Error("codex app-server thread/resume returned no thread id");
    if (resumedId !== threadId) throw new Error(`codex app-server resumed unexpected thread ${resumedId}; expected ${threadId}`);
    return resumedId;
  }

  async interruptActiveTurn(): Promise<boolean> {
    const active = this.activeTurn;
    if (!active || !this.isAlive()) return false;
    await this.request("turn/interrupt", active, 15_000);
    return true;
  }

  /** Retain the acknowledgement after a timeout so callers can classify an
   * unsafe replay boundary without retrying a possibly accepted turn. */
  dispatchedTurnId(): string | undefined { return this.lastDispatchedTurnId; }

  /** `turn/steer`: append a user message to the active turn; the request fails if the turn already ended. */
  async steerActiveTurn(text: string): Promise<boolean> {
    const active = this.activeTurn;
    if (!active || !this.isAlive()) return false;
    await this.request("turn/steer", { threadId: active.threadId, expectedTurnId: active.turnId, input: [{ type: "text", text }] }, 15_000);
    return true;
  }

  async runTurn(input: {
    readonly threadId: string;
    readonly prompt: string;
    readonly applicationContext?: string;
    readonly timeoutMs: number;
    readonly budgets?: CodexAppServerBudgets;
    readonly signal?: AbortSignal;
    readonly onTurnAccepted?: CodexAppServerRunInput["onTurnAccepted"];
    readonly onDelta?: (text: string) => void;
    readonly onReasoningDelta?: (text: string) => void;
    readonly onActivity?: () => void;
    readonly onEvent?: (method: string, params: Record<string, unknown>) => void;
    readonly onRequest?: (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown> | undefined>;
    readonly approvalPolicy?: "untrusted" | "on-request" | "never";
    readonly images?: readonly string[];
    readonly collaborationMode?: CodexCollaborationMode;
  }): Promise<{
    readonly finalMessage: string;
    readonly firstDeltaMs?: number;
    readonly errorMessage?: string;
    readonly turnId?: string;
    readonly failure?: CodexAppServerRunResult["failure"];
    readonly tokenUsage?: CodexAppServerRunResult["tokenUsage"];
  }> {
    const started = Date.now();
    // A prior completed turn must not make a later pre-dispatch failure look
    // replayable. This marker belongs to the current turn attempt only.
    this.lastDispatchedTurnId = undefined;
    if (input.signal?.aborted) {
      return { finalMessage: "", errorMessage: "Codex turn was cancelled before dispatch.", failure: { kind: "aborted" } };
    }
    const requestMs = input.budgets?.requestMs ?? 15_000;
    let turnStart: Record<string, unknown>;
    try {
      turnStart = await this.request("turn/start", {
      threadId: input.threadId,
      input: [{ type: "text", text: input.prompt }, ...(input.images ?? []).map((path) => ({ type: "localImage", path }))],
      ...(input.approvalPolicy ? { approvalPolicy: input.approvalPolicy } : {}),
      ...(input.collaborationMode ? { collaborationMode: input.collaborationMode } : {}),
      ...(input.applicationContext
        ? {
            additionalContext: {
              "muster.application": {
                value: input.applicationContext,
                kind: "application",
              },
            },
          }
        : {}),
      }, requestMs);
    } catch (error) {
      // A JSON-RPC error response is a confirmed rejection. A timeout, pipe
      // close, or malformed response remains uncertain and must never replay.
      if (error instanceof CodexRpcError) {
        return { finalMessage: "", errorMessage: error.message, failure: rpcFailure(error) };
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new CodexRunError(
        message,
        "unknown",
        /timed out/i.test(message) ? { kind: "request-timeout", method: "turn/start" } : undefined,
      );
    }
    const turnId = stringValue(asRecord(turnStart.turn).id);
    if (turnId) {
      this.activeTurn = { threadId: input.threadId, turnId };
      this.lastDispatchedTurnId = turnId;
      input.onTurnAccepted?.({ threadId: input.threadId, turnId, dispatchState: "dispatched" });
    } else {
      // The server returned a successful response but omitted identity; treat
      // it as accepted/uncertain, never as permission to replay.
      throw new CodexRunError("Codex app-server accepted turn/start without a turn identity.", "unknown");
    }
    let finalMessage = "";
    let firstDeltaMs: number | undefined;
    let tokenUsage: CodexAppServerRunResult["tokenUsage"] | undefined;
    // Raw events remain observable for multi-agent graph consumers, but the
    // synthesized parent turn must never consume a child's output. Older
    // servers omitted one or both IDs, so a missing ID remains compatible.
    const belongsToActiveTurn = (params: Record<string, unknown>): boolean => {
      const eventThreadId = stringValue(params.threadId);
      if (eventThreadId && eventThreadId !== input.threadId) return false;
      const eventTurnId = stringValue(params.turnId) ?? stringValue(asRecord(params.turn).id);
      return !(eventTurnId && turnId && eventTurnId !== turnId);
    };

    // timeoutMs is an IDLE budget, not a wall-clock one: a turn that is still
    // sending notifications must never be killed mid-stream (a 7-word prompt
    // over a 45-turn resumed thread legitimately outlives a "simple" budget).
    // A hung provider still dies after timeoutMs of silence, and an absolute
    // ceiling guards against a notification-spamming runaway turn.
    const idleMs = input.budgets?.idleMs ?? input.timeoutMs;
    const absoluteCeilingMs = input.budgets?.turnMs ?? Math.max(input.timeoutMs * 8, 15 * 60_000);
    let lastNotificationAt = Date.now();
    let interruptSent = false;
    const requestInterrupt = () => {
      if (interruptSent || !turnId || !this.isAlive()) return;
      interruptSent = true;
      void this.request("turn/interrupt", { threadId: input.threadId, turnId }, requestMs).catch(() => undefined);
    };
    const onAbort = () => requestInterrupt();
    input.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      while (Date.now() - lastNotificationAt < idleMs && Date.now() - started < absoluteCeilingMs) {
        if (input.signal?.aborted) requestInterrupt();
        if (Date.now() - started >= absoluteCeilingMs) {
          throw new CodexRunError(this.formatError(`codex app-server turn exceeded the absolute ceiling of ${absoluteCeilingMs}ms`), "dispatched");
        }
        if (!this.isAlive()) throw new Error(this.formatError("codex app-server exited during turn"));
        const message = await this.takeNotification(250);
        if (!message) continue;
        lastNotificationAt = Date.now();
        const method = stringValue(message.method) ?? "";
        const params = asRecord(message.params);
        if (method.startsWith("item/")) input.onActivity?.();
        if (method.startsWith("item/") || method.startsWith("turn/") || method.startsWith("account/") || method.startsWith("thread/")) input.onEvent?.(method, params);
        // JSON-RPC: a message carrying BOTH an id and a method is a server→client
        // request awaiting our answer (…/requestApproval, …/requestUserInput,
        // mcpServer/elicitation/request). Matching only "/request" left the
        // server waiting on every approval — the silent cause of hung turns.
        if (message.id !== undefined && message.id !== null && method) {
          const decline = { decision: "decline", action: "decline", content: null, _meta: null };
          if (!input.onRequest) {
            this.respond(message.id, decline);
            continue;
          }
          const id = message.id;
          void input.onRequest(method, params)
            .then((response) => this.respond(id, response ?? decline))
            .catch(() => this.respond(id, decline));
          continue;
        }
        if (method === "item/agentMessage/delta") {
          if (!belongsToActiveTurn(params)) continue;
          const delta = stringValue(params.delta) ?? "";
          if (delta) {
            firstDeltaMs ??= Date.now() - started;
            input.onDelta?.(delta);
          }
          continue;
        }
        if (method === "item/reasoning/summaryTextDelta") {
          if (!belongsToActiveTurn(params)) continue;
          const delta = stringValue(params.delta) ?? "";
          if (delta) input.onReasoningDelta?.(delta);
          continue;
        }
        if (method === "item/completed") {
          if (!belongsToActiveTurn(params)) continue;
          const item = asRecord(params.item);
          if (item.type === "agentMessage") {
            finalMessage = stringValue(item.text) ?? finalMessage;
          }
          continue;
        }
        if (method === "thread/tokenUsage/updated") {
          if (!belongsToActiveTurn(params)) continue;
          const last = asRecord(asRecord(params.tokenUsage).last);
          tokenUsage = {
            inputTokens: numberValue(last.inputTokens),
            cachedInputTokens: numberValue(last.cachedInputTokens),
            outputTokens: numberValue(last.outputTokens),
            reasoningOutputTokens: numberValue(last.reasoningOutputTokens),
          };
          continue;
        }
        if (method === "turn/completed") {
          if (!belongsToActiveTurn(params)) continue;
          const turn = asRecord(params.turn);
          const error = asRecord(turn.error);
          const status = stringValue(turn.status);
          if (turnId && stringValue(turn.id) && stringValue(turn.id) !== turnId) continue;
          if (status && status !== "completed" && status !== "interrupted") {
            return { finalMessage, firstDeltaMs, turnId, errorMessage: stringValue(error.message) ?? `codex turn ended with status ${status}`, tokenUsage };
          }
          if (input.signal?.aborted) {
            return { finalMessage, firstDeltaMs, turnId, errorMessage: "Codex turn was interrupted.", failure: { kind: "aborted" }, tokenUsage };
          }
          return { finalMessage, firstDeltaMs, turnId, tokenUsage };
        }
      }
      if (input.signal?.aborted) {
        throw new CodexRunError("Codex turn was interrupted locally; provider terminal status was not observed.", "dispatched", { kind: "aborted" });
      }
      if (Date.now() - started >= absoluteCeilingMs) {
        throw new CodexRunError(this.formatError(`codex app-server turn exceeded the absolute ceiling of ${absoluteCeilingMs}ms`), "dispatched");
      }
      throw new CodexRunError(this.formatError(`codex app-server turn timed out: silent for ${idleMs}ms with no notifications`), "dispatched");
    } finally {
      input.signal?.removeEventListener("abort", onAbort);
      if (this.activeTurn?.threadId === input.threadId && this.activeTurn.turnId === turnId) this.activeTurn = undefined;
    }
  }

  private request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    if (!this.isAlive()) return Promise.reject(new Error(this.formatError("codex app-server is not running")));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(this.formatError(`codex app-server method ${method} timed out`)));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      this.write({ id, method, params });
    });
  }

  private notify(method: string, params: Record<string, unknown> = {}): void {
    this.write({ method, params });
  }

  private respond(id: unknown, result: Record<string, unknown>): void {
    if (typeof id === "number" || typeof id === "string") this.write({ id, result });
  }

  private write(message: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private readStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    const lines = this.stdoutBuffer.split(/\n/);
    this.stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const id = numberValue(message.id);
      if (id !== undefined && this.pending.has(id)) {
        const pending = this.pending.get(id)!;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        const error = asRecord(message.error);
        if (Object.keys(error).length) {
          pending.reject(new CodexRpcError(
            stringValue(error.message) ?? `codex app-server ${pending.method} failed`,
            pending.method,
            numberValue(error.code),
            asRecord(error.data),
          ));
        } else {
          pending.resolve(asRecord(message.result));
        }
        continue;
      }
      const waiter = this.waiters.shift();
      if (waiter) waiter(message);
      else {
        if (this.notifications.length >= this.maxNotifications) this.notifications.shift();
        this.notifications.push(message);
        this.observationWake?.();
      }
    }
  }

  private dispatchObserved(message: Record<string, unknown>): void {
    const method = stringValue(message.method) ?? "";
    const params = asRecord(message.params);
    if (!method) return;
    this.trackObservedWork(method, params);
    if (method.startsWith("item/") || method.startsWith("turn/") || method.startsWith("account/") || method.startsWith("thread/")) this.observer?.onEvent?.(method, params);
    if (message.id === undefined || message.id === null) return;
    const decline = { decision: "decline", action: "decline", content: null, _meta: null };
    if (!this.observer?.onRequest) { this.respond(message.id, decline); return; }
    void this.observer.onRequest(method, params)
      .then((response) => this.respond(message.id, response ?? decline))
      .catch(() => this.respond(message.id, decline));
  }

  private trackObservedWork(method: string, params: Record<string, unknown>): void {
    const threadId = stringValue(params.threadId);
    if (!threadId) return;
    if (method === "turn/started") this.observedActiveThreads.add(threadId);
    else if (method === "turn/completed") this.observedActiveThreads.delete(threadId);
    else if (method === "thread/status/changed") {
      const type = stringValue(asRecord(params.status).type);
      if (type === "active") this.observedActiveThreads.add(threadId);
      else if (type === "idle" || type === "notLoaded" || type === "systemError") this.observedActiveThreads.delete(threadId);
    }
  }

  private readStderr(chunk: string): void {
    for (const line of chunk.split(/\r?\n/)) {
      if (line.trim()) this.stderrLines.push(line.trim());
    }
    this.stderrLines.splice(0, Math.max(0, this.stderrLines.length - 80));
  }

  private takeNotification(timeoutMs: number): Promise<Record<string, unknown> | undefined> {
    const existing = this.notifications.shift();
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.indexOf(waiter);
        if (idx >= 0) this.waiters.splice(idx, 1);
        resolve(undefined);
      }, timeoutMs);
      const waiter = (message: Record<string, unknown>) => {
        clearTimeout(timer);
        resolve(message);
      };
      this.waiters.push(waiter);
    });
  }

  private takeObservedNotification(): Promise<Record<string, unknown> | undefined> {
    const existing = this.notifications.shift();
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => {
      const finish = () => { if (this.observationTimer) clearTimeout(this.observationTimer); this.observationTimer = undefined; this.observationWake = undefined; resolve(this.notifications.shift()); };
      this.observationWake = finish;
      this.observationTimer = setTimeout(finish, 250);
    });
  }

  private formatError(message: string): string {
    const tail = this.stderrLines.slice(-12).join("\n");
    return tail ? `${message}\ncodex stderr:\n${tail}` : message;
  }

  private finishClose(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.observing = false;
    this.observationWake?.();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.onClose?.();
  }
}

function resolveCodexCommand(command?: string): string {
  if (command) return command;
  if (process.env.MUSTER_CODEX_COMMAND) return process.env.MUSTER_CODEX_COMMAND;
  const appBundle = "/Applications/Codex.app/Contents/Resources/codex";
  if (existsSync(appBundle)) return appBundle;
  const home = process.env.HOME;
  if (home) {
    const candidates = [
      pathJoin(home, ".nvm/versions/node/v24.17.0/bin/codex"),
      pathJoin(home, ".nvm/versions/node/v22.22.3/bin/codex"),
      pathJoin(home, ".nvm/versions/node/v22.15.1/bin/codex"),
      pathJoin(home, ".nvm/versions/node/v20.19.5/bin/codex"),
      pathJoin(home, ".local/bin/codex"),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return "codex";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}
