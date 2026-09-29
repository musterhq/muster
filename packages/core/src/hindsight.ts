import { createHash } from "node:crypto";
import type { MemoryScope } from "./types.js";
import { formatMemoryScope } from "./memory.js";

/**
 * Opt-in Hindsight external memory client.
 *
 * Muster's authoritative memory stays the scoped local SQLite/FTS store; this
 * module talks to a locally deployed Hindsight HTTP API
 * (hindsight-api-slim contract, see QM-HINDSIGHT-SOURCE-AUDIT.md) as an
 * external retain/recall/reflect surface. It never bypasses scope isolation:
 * bank ids are derived from an authorized MemoryScope, never accepted raw.
 */

export interface HindsightConfig {
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  readonly maxRequestBytes: number;
}

export const HINDSIGHT_URL_ENV = "HINDSIGHT_API_URL";
export const HINDSIGHT_KEY_ENV = "HINDSIGHT_API_KEY";
export const HINDSIGHT_TIMEOUT_ENV = "HINDSIGHT_TIMEOUT_MS";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2_000_000;
const DEFAULT_MAX_REQUEST_BYTES = 1_000_000;
/** Upper bounds keep operator-supplied values from disabling the protections. */
const MAX_TIMEOUT_MS = 600_000;
const MAX_RESPONSE_BYTES_LIMIT = 64_000_000;
const MAX_REQUEST_BYTES_LIMIT = 16_000_000;

export class HindsightConfigError extends Error {}
export class HindsightScopeError extends Error {}

/** Request failed after reaching the service (HTTP status or malformed body). */
export class HindsightRequestError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

/** Service unreachable or timed out; callers should degrade to local memory. */
export class HindsightUnavailableError extends Error {}

/** Positive bounded safe integer, or throw a config error naming the field. */
function assertBoundedPositiveInt(value: number, field: string, max: number): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) {
    throw new HindsightConfigError(`${field} must be a positive integer <= ${max}.`);
  }
}

/**
 * Validate and sanitize the base URL: http(s) only, and reject embedded
 * credentials or query/fragment so secrets can never reach status output or
 * error messages via the URL.
 */
function sanitizeBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HindsightConfigError(`${HINDSIGHT_URL_ENV} is not a valid URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new HindsightConfigError(`${HINDSIGHT_URL_ENV} must use http or https.`);
  }
  if (url.username || url.password) {
    throw new HindsightConfigError(
      `${HINDSIGHT_URL_ENV} must not embed credentials in the URL; use ${HINDSIGHT_KEY_ENV} instead.`,
    );
  }
  if (url.search || url.hash) {
    throw new HindsightConfigError(`${HINDSIGHT_URL_ENV} must not carry a query string or fragment.`);
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

/** Validate a config regardless of origin (env or direct construction). */
export function assertValidHindsightConfig(config: HindsightConfig): void {
  sanitizeBaseUrl(config.baseUrl || "");
  assertBoundedPositiveInt(config.timeoutMs, "timeoutMs", MAX_TIMEOUT_MS);
  assertBoundedPositiveInt(config.maxResponseBytes, "maxResponseBytes", MAX_RESPONSE_BYTES_LIMIT);
  assertBoundedPositiveInt(config.maxRequestBytes, "maxRequestBytes", MAX_REQUEST_BYTES_LIMIT);
}

export function resolveHindsightConfig(env: Record<string, string | undefined> = process.env): HindsightConfig {
  const baseUrl = env[HINDSIGHT_URL_ENV]?.trim();
  if (!baseUrl) {
    throw new HindsightConfigError(
      `Hindsight is opt-in and not configured: set ${HINDSIGHT_URL_ENV} (and ${HINDSIGHT_KEY_ENV} if the deployment requires auth).`,
    );
  }
  const timeoutRaw = env[HINDSIGHT_TIMEOUT_ENV];
  const timeoutMs = timeoutRaw ? Number(timeoutRaw) : DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new HindsightConfigError(
      `${HINDSIGHT_TIMEOUT_ENV} must be a positive integer number of milliseconds <= ${MAX_TIMEOUT_MS}.`,
    );
  }
  const config: HindsightConfig = {
    baseUrl: sanitizeBaseUrl(baseUrl),
    apiKey: env[HINDSIGHT_KEY_ENV]?.trim() || undefined,
    timeoutMs,
    maxResponseBytes: DEFAULT_MAX_RESPONSE_BYTES,
    maxRequestBytes: DEFAULT_MAX_REQUEST_BYTES,
  };
  assertValidHindsightConfig(config);
  return config;
}

/**
 * Deterministic, collision-safe scope -> bank id mapping.
 * Human-readable slug plus a sha256 digest of the exact "kind:id" pair, so two
 * scopes whose ids only differ in characters lost by slugging still map to
 * distinct banks.
 */
export function hindsightBankId(scope: MemoryScope): string {
  const canonical = formatMemoryScope(scope);
  const digest = createHash("sha256").update(canonical).digest("hex").slice(0, 12);
  const slug = `${scope.kind}-${scope.id}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return `muster-${slug}-${digest}`;
}

export interface HindsightScopeAuthorization {
  /** Scope this operation targets; the bank id is derived from it. */
  readonly scope: MemoryScope;
  /**
   * Scopes the caller is authorized to touch (session/user policy).
   * Trusted-caller contract: the CLI/runtime computes this list from its own
   * policy; it is an operator convenience guard, NOT a security boundary.
   * Anyone who can call this in-process can supply any list.
   */
  readonly allowedScopes: readonly MemoryScope[];
  /** Global scope must be requested explicitly, mirroring promoteMemory. */
  readonly allowGlobal?: boolean;
}

/** Authorize scope access BEFORE bank selection; returns the derived bank id. */
export function authorizeHindsightBank(input: HindsightScopeAuthorization): string {
  const { scope, allowedScopes, allowGlobal } = input;
  const key = formatMemoryScope(scope);
  if (scope.kind === "global" && !allowGlobal) {
    throw new HindsightScopeError("Hindsight access to global scope requires allowGlobal=true.");
  }
  if (!allowedScopes.some((allowed) => allowed.kind === scope.kind && allowed.id === scope.id)) {
    throw new HindsightScopeError(`Scope ${key} is not in the caller's allowed scopes; refusing to select a Hindsight bank.`);
  }
  return hindsightBankId(scope);
}

export interface HindsightRetainItem {
  readonly content: string;
  readonly timestamp?: string;
  readonly context?: string;
  readonly documentId?: string;
  readonly tags?: readonly string[];
  readonly metadata?: Record<string, string>;
}

export interface HindsightRetainInput extends HindsightScopeAuthorization {
  readonly items: readonly HindsightRetainItem[];
  /** Provenance strings recorded on every item's metadata; required. */
  readonly provenance: readonly string[];
  readonly async?: boolean;
  readonly operationId?: string;
  readonly signal?: AbortSignal;
}

export interface HindsightRetainResult {
  readonly bankId: string;
  readonly success: boolean;
  readonly itemsCount: number;
  readonly isAsync: boolean;
  readonly operationId?: string;
}

export interface HindsightRecallInput extends HindsightScopeAuthorization {
  readonly query: string;
  readonly types?: readonly ("world" | "experience" | "observation")[];
  readonly budget?: "low" | "mid" | "high";
  readonly maxTokens?: number;
  readonly tags?: readonly string[];
  readonly signal?: AbortSignal;
}

export interface HindsightRecallEntry {
  readonly id?: string;
  readonly text: string;
  readonly type?: string;
  readonly score?: number;
}

export interface HindsightRecallResult {
  readonly bankId: string;
  readonly results: readonly HindsightRecallEntry[];
}

export interface HindsightReflectInput extends HindsightScopeAuthorization {
  readonly query: string;
  readonly context?: string;
  readonly budget?: "low" | "mid" | "high";
  readonly maxTokens?: number;
  readonly signal?: AbortSignal;
}

export interface HindsightReflectResult {
  readonly bankId: string;
  readonly text: string;
}

function scrubSecrets(text: string, apiKey: string | undefined): string {
  if (!apiKey) return text;
  return text.split(apiKey).join("[redacted]");
}

export class HindsightClient {
  private readonly config: HindsightConfig;

  constructor(config: HindsightConfig) {
    assertValidHindsightConfig(config);
    // Defensive copy with explicit normalization: callers keep their object,
    // later mutation cannot disable validated bounds, and trailing slashes
    // never reach URL assembly.
    this.config = {
      baseUrl: sanitizeBaseUrl(config.baseUrl),
      apiKey: config.apiKey,
      timeoutMs: config.timeoutMs,
      maxResponseBytes: config.maxResponseBytes,
      maxRequestBytes: config.maxRequestBytes,
    };
  }

  private async post(path: string, body: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const url = `${this.config.baseUrl}${path}`;
    const payload = JSON.stringify(body);
    const payloadBytes = Buffer.byteLength(payload, "utf8");
    if (payloadBytes > this.config.maxRequestBytes) {
      throw new HindsightRequestError(
        `Hindsight request body is ${payloadBytes} bytes, above the ${this.config.maxRequestBytes}-byte limit for POST ${path}.`,
      );
    }
    const timeout = AbortSignal.timeout(this.config.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.config.apiKey) headers.authorization = `Bearer ${this.config.apiKey}`;
    let response: Response;
    try {
      response = await fetch(url, { method: "POST", headers, body: payload, signal: combined });
    } catch (error) {
      throw this.transportError(error, path, signal, timeout);
    }
    const raw = await this.readBodyBounded(response, path, signal, timeout);
    if (!response.ok) {
      const excerpt = scrubSecrets(raw.slice(0, 400), this.config.apiKey);
      throw new HindsightRequestError(`Hindsight POST ${path} failed with HTTP ${response.status}: ${excerpt}`, response.status);
    }
    let parsed: unknown;
    try {
      parsed = raw ? JSON.parse(raw) : {};
    } catch {
      throw new HindsightRequestError(`Hindsight POST ${path} returned non-JSON body.`, response.status);
    }
    // JSON.parse legally yields null/arrays/scalars; every operation expects an
    // object root, so reject anything else here instead of crashing downstream.
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new HindsightRequestError(`Hindsight POST ${path} returned a non-object JSON root.`, response.status);
    }
    return parsed as Record<string, unknown>;
  }

  /** Map connect/body-phase failures to typed errors without leaking secrets. */
  private transportError(error: unknown, path: string, signal: AbortSignal | undefined, timeout: AbortSignal): Error {
    if (signal?.aborted) return new HindsightUnavailableError(`Hindsight request cancelled: POST ${path}`);
    if (timeout.aborted) {
      return new HindsightUnavailableError(`Hindsight request timed out after ${this.config.timeoutMs}ms: POST ${path}`);
    }
    const detail = error instanceof Error ? error.message : String(error);
    return new HindsightUnavailableError(
      scrubSecrets(`Hindsight unreachable at ${this.config.baseUrl}: ${detail}`, this.config.apiKey),
    );
  }

  /**
   * Stream the response body counting BYTES (not UTF-16 units), cancel the
   * reader as soon as the cap is exceeded, and surface abort/timeout/network
   * failures during the body phase as typed errors. Never accumulates more
   * than maxResponseBytes (+ one chunk) in memory.
   */
  private async readBodyBounded(
    response: Response,
    path: string,
    signal: AbortSignal | undefined,
    timeout: AbortSignal,
  ): Promise<string> {
    const reader = response.body?.getReader();
    if (!reader) return "";
    const cap = this.config.maxResponseBytes;
    const chunks: Uint8Array[] = [];
    let received = 0;
    try {
      for (;;) {
        let step: ReadableStreamReadResult<Uint8Array>;
        try {
          step = await reader.read();
        } catch (error) {
          throw this.transportError(error, path, signal, timeout);
        }
        if (step.done) break;
        received += step.value.byteLength;
        if (received > cap) {
          await reader.cancel(`response exceeded ${cap} bytes`).catch(() => {});
          throw new HindsightRequestError(
            `Hindsight response exceeded ${cap} bytes for POST ${path}; download cancelled.`,
            response.status,
          );
        }
        chunks.push(step.value);
      }
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  async retain(input: HindsightRetainInput): Promise<HindsightRetainResult> {
    if (!input.items.length) throw new HindsightRequestError("retain requires at least one item.");
    if (!input.provenance.length) throw new HindsightScopeError("retain requires provenance so recalls stay explainable.");
    const bankId = authorizeHindsightBank(input);
    const scopeKey = formatMemoryScope(input.scope);
    const body: Record<string, unknown> = {
      items: input.items.map((item) => ({
        content: item.content,
        ...(item.timestamp ? { timestamp: item.timestamp } : {}),
        ...(item.context ? { context: item.context } : {}),
        ...(item.documentId ? { document_id: item.documentId } : {}),
        ...(item.tags?.length ? { tags: [...item.tags] } : {}),
        metadata: {
          ...item.metadata,
          muster_scope: scopeKey,
          muster_provenance: input.provenance.join(","),
        },
      })),
      async: input.async ?? false,
    };
    if (input.operationId) body.operation_id = input.operationId;
    const data = await this.post(`/v1/default/banks/${bankId}/memories`, body, input.signal);
    return {
      bankId,
      success: data.success === true,
      itemsCount: typeof data.items_count === "number" ? data.items_count : input.items.length,
      isAsync: data.is_async === true,
      operationId: typeof data.operation_id === "string" ? data.operation_id : undefined,
    };
  }

  async recall(input: HindsightRecallInput): Promise<HindsightRecallResult> {
    const bankId = authorizeHindsightBank(input);
    const body: Record<string, unknown> = {
      query: input.query,
      budget: input.budget ?? "mid",
      max_tokens: input.maxTokens ?? 4096,
    };
    if (input.types?.length) body.types = [...input.types];
    if (input.tags?.length) body.tags = [...input.tags];
    const data = await this.post(`/v1/default/banks/${bankId}/memories/recall`, body, input.signal);
    const rawResults = Array.isArray(data.results) ? data.results : [];
    return {
      bankId,
      results: rawResults.flatMap((entry): HindsightRecallEntry[] => {
        if (typeof entry !== "object" || entry === null) return [];
        const record = entry as Record<string, unknown>;
        if (typeof record.text !== "string") return [];
        return [{
          id: typeof record.id === "string" ? record.id : undefined,
          text: record.text,
          type: typeof record.type === "string" ? record.type : undefined,
          score: typeof record.score === "number" ? record.score : undefined,
        }];
      }),
    };
  }

  async reflect(input: HindsightReflectInput): Promise<HindsightReflectResult> {
    const bankId = authorizeHindsightBank(input);
    const body: Record<string, unknown> = {
      query: input.query,
      budget: input.budget ?? "low",
      max_tokens: input.maxTokens ?? 4096,
    };
    if (input.context) body.context = input.context;
    const data = await this.post(`/v1/default/banks/${bankId}/reflect`, body, input.signal);
    if (typeof data.text !== "string") {
      throw new HindsightRequestError("Hindsight reflect response did not include a text answer.");
    }
    return { bankId, text: data.text };
  }
}

export function createHindsightClient(env: Record<string, string | undefined> = process.env): HindsightClient {
  return new HindsightClient(resolveHindsightConfig(env));
}
