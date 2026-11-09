import { execFile } from "node:child_process";
import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { loadConfig } from "./config.js";
import { persistToolResult, resultFetch } from "./context-renderer.js";
import type { FlowToolRegistry } from "./flow.js";
import { addMemory, findMemory, formatMemoryScope, isVisibleInScopes, parseMemoryScope, searchMemory } from "./memory.js";
import { activeProfile } from "./profiles.js";
import { createAutomation, describeAutomation, formatAutomationsTable, listAutomations, MAX_ACTIVE_AUTOMATIONS, MAX_AUTOMATION_TEXT, WHEN_FORMS } from "./automations.js";
import { removeSchedule } from "./scheduler.js";
import { openSessionStore, type SessionSearchArgs } from "./sessions.js";
import { buildCockpitState } from "./store.js";
import type { ContextObject, MemoryScope } from "./types.js";

const execFileAsync = promisify(execFile);

/**
 * Tool registry v2 — declarative entries, composable toolsets, availability
 * gates, and per-tool result caps enforced centrally. First-party tools stay
 * a small dependency-free set; anything integration-shaped belongs in MCP
 * servers or capability packs, never here (the upstream 72-tool sprawl is
 * maintenance debt we refuse).
 */

export type ToolResult =
  | { readonly ok: true; readonly data: unknown; readonly mediaRefs?: string[] }
  | { readonly ok: false; readonly error: string; readonly retryable?: boolean };

export interface ToolContext {
  readonly cwd: string;
  /** Explicit allowlist for the terminal tool; default deny-all. */
  readonly allowCommands?: readonly string[];
  /** Hosts the web_fetch tool may reach; default: any public host. */
  readonly allowHosts?: readonly string[];
  /** Optional catalog scope for tool_search/tool_describe/tool_call. */
  readonly toolAllowlist?: readonly string[];
  /** Test/host injection point; defaults to global fetch. */
  readonly fetch?: typeof globalThis.fetch;
}

export interface ToolEntry<A = Record<string, unknown>> {
  readonly name: string;
  readonly toolset: string;
  readonly description: string;
  readonly handler: (args: A, ctx: ToolContext) => Promise<ToolResult>;
  readonly available?: (ctx: ToolContext) => boolean;
  readonly requiresEnv?: readonly string[];
  readonly maxResultChars?: number;
  readonly inputSchema?: unknown;
}

export interface ToolsetDef {
  readonly description: string;
  readonly tools: readonly string[];
  readonly includes?: readonly string[];
}

const DEFAULT_MAX_RESULT_CHARS = 8000;
const DISCOVERY_TOOLS = new Set(["tool_search", "tool_describe", "tool_call"]);
const WEB_SEARCH_CACHE_TTL_MS = 15 * 60_000;
const webSearchCache = new Map<string, { expiresAt: number; data: WebSearchResult[] }>();

export interface ToolRegistryV2 {
  register<A>(entry: ToolEntry<A>): void;
  list(toolset?: string): ToolEntry[];
  resolveToolset(name: string): string[];
  execute(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
  toFlowRegistry(ctx: ToolContext, allowlist?: readonly string[]): FlowToolRegistry;
}

export function createToolRegistry(toolsets: Record<string, ToolsetDef> = BUILTIN_TOOLSETS): ToolRegistryV2 {
  const entries = new Map<string, ToolEntry>();

  const resolveToolset = (name: string, seen = new Set<string>()): string[] => {
    if (seen.has(name)) return [];
    seen.add(name);
    const definition = toolsets[name];
    if (!definition) return [];
    return [...definition.tools, ...(definition.includes ?? []).flatMap((included) => resolveToolset(included, seen))];
  };

  return {
    register(entry) {
      if (entries.has(entry.name)) throw new Error(`Tool already registered: ${entry.name}`);
      entries.set(entry.name, entry as ToolEntry);
    },
    list(toolset) {
      const all = [...entries.values()];
      if (!toolset) return all;
      const allowed = new Set(resolveToolset(toolset));
      return all.filter((entry) => allowed.has(entry.name));
    },
    resolveToolset: (name) => resolveToolset(name),
    async execute(name, args, ctx) {
      const entry = entries.get(name);
      if (!entry) return { ok: false, error: `Unknown tool: ${name}` };
      for (const env of entry.requiresEnv ?? []) {
        if (!process.env[env]) return { ok: false, error: `Tool ${name} requires env ${env} (not set)` };
      }
      if (entry.available && !entry.available(ctx)) {
        return { ok: false, error: `Tool ${name} is not available in this context` };
      }
      let result: ToolResult;
      try {
        result = await entry.handler(args, ctx);
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      if (result.ok) {
        const text = typeof result.data === "string" ? result.data : JSON.stringify(result.data);
        const cap = entry.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS;
        if (text.length > cap) {
          const persisted = await persistToolResult({ toolName: name, ok: true, content: text }, ctx.cwd);
          return { ok: true, data: `${text.slice(0, 400)}\n${persisted.stub}` };
        }
      }
      return result;
    },
    toFlowRegistry(ctx, allowlist) {
      const registry: FlowToolRegistry = {};
      for (const entry of entries.values()) {
        if (allowlist && !allowlist.includes(entry.name)) continue;
        registry[entry.name] = async (args) => {
          const result = await this.execute(entry.name, args, ctx);
          if (!result.ok) throw new Error(result.error);
          return result.data;
        };
      }
      return registry;
    },
  };
}

export const BUILTIN_TOOLSETS: Record<string, ToolsetDef> = {
  files: { description: "Read/write/search the workspace", tools: ["read_file", "write_file", "search_files", "list_dir"] },
  web: { description: "Fetch and search public web content", tools: ["web_fetch", "web_search"] },
  memory: { description: "Read scoped durable memory", tools: ["memory_search", "memory_get"] },
  memory_write: { description: "Write scoped durable memory under config.memory.policy", tools: ["memory_write"] },
  sessions: { description: "Read-only search, navigation, and status over persisted local sessions", tools: ["session_search", "session_status"] },
  shell: { description: "Run allowlisted commands", tools: ["terminal"] },
  schedule: { description: "Create, list and remove reminders and routines", tools: ["schedule_manage"] },
  results: { description: "Fetch persisted oversized tool results", tools: ["result_fetch"] },
  discovery: { description: "Search, describe, and call the authorized tool catalog", tools: ["tool_search", "tool_describe", "tool_call"] },
  core: { description: "Everything safe by default", tools: [], includes: ["files", "web", "memory", "sessions", "results", "discovery"] },
  full: { description: "Core plus shell", tools: [], includes: ["core", "shell"] },
};

/** Tools safe to expose to untrusted webhook triggers (no fs writes, no shell). */
export const WEBHOOK_SAFE_TOOLS: readonly string[] = ["web_fetch", "web_search", "result_fetch"];

/**
 * SSRF guard for web_fetch. Even with no allowlist configured, web_fetch must
 * NOT be a window into the host's private network or the cloud metadata
 * endpoint. We block by hostname/IP-literal pattern (a full DNS resolve +
 * re-check is out of scope for v0.1, and rebinding still needs a resolve):
 * loopback, link-local (incl. 169.254.169.254 metadata), RFC1918 private,
 * carrier-grade NAT (100.64/10), the unspecified address, and "localhost".
 * This is a literal-pattern defense; it does not defeat DNS rebinding.
 */
export function isBlockedFetchHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  if (host === "localhost" || host.endsWith(".localhost")) return true;

  // IPv6 loopback / unspecified.
  if (host === "::1" || host === "::" || host === "0:0:0:0:0:0:0:1") return true;
  // IPv6 link-local (fe80::/10) and unique-local (fc00::/7) ranges.
  if (/^fe[89ab][0-9a-f]:/.test(host) || /^f[cd][0-9a-f]{2}:/.test(host)) return true;
  // IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1): recurse on the embedded IPv4.
  const mapped = host.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) return isBlockedFetchHost(mapped[1]);

  const octets = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (octets) {
    const [a, b] = octets.slice(1).map(Number);
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 10) return true; // 10.0.0.0/8 private
    if (a === 0) return true; // 0.0.0.0/8 (incl. 0.0.0.0 unspecified)
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local + metadata
    if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  }
  return false;
}

function assertPublicOrAllowedUrl(url: URL, ctx: ToolContext): ToolResult | undefined {
  if (ctx.allowHosts) {
    if (!ctx.allowHosts.includes(url.hostname)) {
      return { ok: false, error: `Host not in allowlist: ${url.hostname}` };
    }
  } else if (isBlockedFetchHost(url.hostname)) {
    return { ok: false, error: `Blocked private/loopback/metadata host: ${url.hostname}` };
  }
  return undefined;
}

function fetchFor(ctx: ToolContext): typeof globalThis.fetch {
  return ctx.fetch ?? globalThis.fetch.bind(globalThis);
}

interface WebSearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet?: string;
  readonly source?: string;
}

interface WebSearchArgs {
  readonly query: string;
  readonly count?: number;
  readonly provider?: "duckduckgo" | "brave";
  readonly baseUrl?: string;
  readonly country?: string;
  readonly language?: string;
  readonly search_lang?: string;
  readonly ui_lang?: string;
  readonly freshness?: "day" | "week" | "month" | "year";
  readonly date_after?: string;
  readonly date_before?: string;
  readonly region?: string;
  readonly safeSearch?: "strict" | "moderate" | "off";
}

interface ToolSearchArgs {
  readonly query?: string;
  readonly limit?: number;
  readonly toolset?: string;
  readonly includeUnavailable?: boolean;
}

interface ToolDescribeArgs {
  readonly name?: string;
  readonly id?: string;
}

interface ToolCallArgs {
  readonly name?: string;
  readonly id?: string;
  readonly args?: Record<string, unknown>;
}

interface SessionStatusArgs {
  readonly sessionId?: string;
}

interface MemorySearchToolArgs {
  readonly query?: string;
  readonly scopes?: readonly string[];
  readonly includeGlobal?: boolean;
  readonly limit?: number;
}

interface MemoryGetToolArgs {
  readonly id: string;
  readonly scopes?: readonly string[];
  readonly includeGlobal?: boolean;
}

function searchCount(value: number | undefined): number {
  return Math.max(1, Math.min(10, Math.floor(value ?? 5)));
}

function cacheKey(provider: string, url: URL, count: number): string {
  return `${provider}:${count}:${url.toString()}`;
}

async function webSearch(args: WebSearchArgs, ctx: ToolContext): Promise<ToolResult> {
  const query = args.query?.trim();
  if (!query) return { ok: false, error: "web_search requires a non-empty query." };
  const provider = args.provider ?? (process.env.BRAVE_API_KEY ? "brave" : "duckduckgo");
  const count = searchCount(args.count);
  const request = provider === "brave" ? braveSearchRequest(args, count) : duckDuckGoSearchRequest(args, count);
  const blocked = assertPublicOrAllowedUrl(request.url, ctx);
  if (blocked) return blocked;

  const key = cacheKey(provider, request.url, count);
  const cached = webSearchCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return { ok: true, data: { provider, cached: true, results: cached.data } };

  const response = await fetchFor(ctx)(request.url, {
    headers: request.headers,
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) return { ok: false, error: `web_search ${provider} HTTP ${response.status}`, retryable: response.status >= 500 };
  const contentType = response.headers.get("content-type") ?? "";
  const results = provider === "brave"
    ? parseBraveResults(await response.json() as unknown, count)
    : parseDuckDuckGoResults(await response.text(), count);
  if (!results.length && contentType.includes("text/html") && provider === "duckduckgo") {
    return { ok: false, error: "web_search duckduckgo returned no parseable results; provider markup may have changed or a challenge page was served.", retryable: true };
  }
  webSearchCache.set(key, { expiresAt: Date.now() + WEB_SEARCH_CACHE_TTL_MS, data: results });
  return { ok: true, data: { provider, cached: false, results } };
}

function braveSearchRequest(args: WebSearchArgs, count: number): { url: URL; headers: Record<string, string> } {
  const token = process.env.BRAVE_API_KEY;
  if (!token) throw new Error("web_search provider brave requires BRAVE_API_KEY.");
  const base = new URL(args.baseUrl ?? "https://api.search.brave.com");
  const url = new URL("/res/v1/web/search", base);
  url.searchParams.set("q", args.query);
  url.searchParams.set("count", String(count));
  if (args.country) url.searchParams.set("country", args.country);
  if (args.language) url.searchParams.set("language", args.language);
  if (args.search_lang) url.searchParams.set("search_lang", args.search_lang);
  if (args.ui_lang) url.searchParams.set("ui_lang", args.ui_lang);
  if (args.freshness) url.searchParams.set("freshness", args.freshness);
  if (args.date_after) url.searchParams.set("date_after", args.date_after);
  if (args.date_before) url.searchParams.set("date_before", args.date_before);
  return { url, headers: { accept: "application/json", "x-subscription-token": token } };
}

function duckDuckGoSearchRequest(args: WebSearchArgs, count: number): { url: URL; headers: Record<string, string> } {
  const url = new URL(args.baseUrl ?? "https://html.duckduckgo.com/html/");
  url.searchParams.set("q", args.query);
  url.searchParams.set("s", "0");
  url.searchParams.set("dc", String(count));
  url.searchParams.set("kl", args.region ?? "us-en");
  url.searchParams.set("kp", args.safeSearch === "off" ? "-2" : args.safeSearch === "strict" ? "1" : "-1");
  return { url, headers: { accept: "text/html,application/xhtml+xml" } };
}

function parseBraveResults(raw: unknown, count: number): WebSearchResult[] {
  if (!isRecord(raw)) return [];
  const web = isRecord(raw.web) ? raw.web : undefined;
  const results = Array.isArray(web?.results) ? web.results : [];
  return results.slice(0, count).flatMap((entry): WebSearchResult[] => {
    if (!isRecord(entry) || typeof entry.title !== "string" || typeof entry.url !== "string") return [];
    return [{
      title: stripHtml(entry.title),
      url: entry.url,
      ...(typeof entry.description === "string" ? { snippet: stripHtml(entry.description) } : {}),
      source: "brave",
    }];
  });
}

function parseDuckDuckGoResults(html: string, count: number): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const pattern = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>|<div[^>]+class="[^"]*result__snippet[^"]*"[^>]*>)([\s\S]*?)(?:<\/a>|<\/div>)/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) && results.length < count) {
    const url = decodeDuckDuckGoUrl(htmlDecode(match[1]));
    if (!url) continue;
    results.push({
      title: stripHtml(match[2]),
      url,
      snippet: stripHtml(match[3]),
      source: "duckduckgo",
    });
  }
  return results;
}

function decodeDuckDuckGoUrl(raw: string): string | undefined {
  try {
    const url = raw.startsWith("//") ? new URL(`https:${raw}`) : new URL(raw, "https://duckduckgo.com");
    const uddg = url.searchParams.get("uddg");
    return uddg ? decodeURIComponent(uddg) : url.toString();
  } catch {
    return undefined;
  }
}

function stripHtml(value: string): string {
  return htmlDecode(value.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();
}

function htmlDecode(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, " ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function discoveryLimit(value: number | undefined): number {
  return Math.max(1, Math.min(20, Math.floor(value ?? 8)));
}

function sessionSearchLimit(value: number | undefined): number {
  return Math.max(1, Math.min(20, Math.floor(value ?? 10)));
}

function memorySearchLimit(value: number | undefined): number {
  return Math.max(1, Math.min(20, Math.floor(value ?? 8)));
}

function parseToolMemoryScopes(values: readonly string[] | undefined, includeGlobal = false): MemoryScope[] {
  const scopes = (values ?? []).map(parseMemoryScope);
  if (includeGlobal) scopes.push(parseMemoryScope("global:global"));
  if (!scopes.length) throw new Error("Memory tools require at least one scope, for example user:dhairya or tenant:oxygenhr.");
  return scopes;
}

function memorySummary(object: ContextObject): Record<string, unknown> {
  return {
    id: object.id,
    kind: object.kind,
    summary: object.summary,
    sourceUri: object.sourceUri,
    observedAt: object.observedAt,
    confidence: object.confidence,
    provenance: object.provenance,
    scopes: object.scopes.map(formatMemoryScope),
    redactionState: object.redactionState,
    links: object.links ?? [],
  };
}

async function memorySearch(args: MemorySearchToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const scopes = parseToolMemoryScopes(args.scopes);
  const limit = memorySearchLimit(args.limit);
  const results = await searchMemory({ query: args.query, scopes, includeGlobal: args.includeGlobal, limit }, ctx.cwd);
  return {
    ok: true,
    data: {
      query: args.query?.trim() ?? "",
      count: Math.min(limit, results.length),
      results: results.slice(0, limit).map(memorySummary),
    },
  };
}

interface MemoryWriteToolArgs {
  readonly summary?: string;
  readonly scopes?: readonly string[];
  readonly kind?: string;
  readonly userAskedToRemember?: boolean;
}

/**
 * Durable write through the same gate as `muster memory add`: addMemory()
 * enforces config.memory.policy, so a "never" or "ask" policy refuses here too.
 */
async function memoryWrite(args: MemoryWriteToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const summary = args.summary?.trim();
  if (!summary) return { ok: false, error: "memory_write requires summary." };
  const scopes = parseToolMemoryScopes(args.scopes);
  const userAsked = args.userAskedToRemember === true;
  try {
    const object = await addMemory({
      kind: args.kind?.trim() || "fact",
      summary,
      scopes,
      // The agent's claim that the user asked is recorded, never laundered into a plain fact.
      provenance: ["agent:mcp", ...(userAsked ? ["user-request:stated-by-agent"] : [])],
      explicitUserRequest: userAsked,
    }, ctx.cwd);
    return { ok: true, data: { id: object.id, memory: memorySummary(object) } };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function memoryGet(args: MemoryGetToolArgs, ctx: ToolContext): Promise<ToolResult> {
  const id = args.id?.trim();
  if (!id) return { ok: false, error: "memory_get requires id." };
  const scopes = parseToolMemoryScopes(args.scopes, args.includeGlobal);
  const object = await findMemory(id, ctx.cwd);
  if (!object || !isVisibleInScopes(object, scopes)) return { ok: false, error: `Unknown or unavailable memory: ${id}` };
  return { ok: true, data: { memory: memorySummary(object) } };
}

function sessionSearch(args: SessionSearchArgs, ctx: ToolContext): ToolResult {
  const store = openSessionStore(ctx.cwd);
  try {
    const result = store.search({
      query: args.query,
      sessionId: args.sessionId,
      aroundMessageId: args.aroundMessageId,
      limit: sessionSearchLimit(args.limit),
    });
    return { ok: true, data: { backend: store.backend, ...result } };
  } finally {
    store.close();
  }
}

async function sessionStatus(args: SessionStatusArgs, ctx: ToolContext): Promise<ToolResult> {
  const generatedAt = new Date().toISOString();
  const [config, cockpit] = await Promise.all([
    loadConfig(ctx.cwd).catch(() => undefined),
    buildCockpitState(ctx.cwd).catch(() => undefined),
  ]);
  const store = openSessionStore(ctx.cwd);
  try {
    const sessionResult = args.sessionId
      ? store.search({ sessionId: args.sessionId })
      : store.search({ limit: 1 });
    const session = sessionResult.shape === "read"
      ? sessionResult.session
      : sessionResult.shape === "browse"
        ? sessionResult.sessions[0]
        : undefined;
    const defaultRuntime = config?.routing.defaultRuntime;
    const runtime = defaultRuntime ? config?.runtimes[defaultRuntime] : undefined;
    const provider = runtime ? config?.providers[runtime.provider] : undefined;
    return {
      ok: true,
      data: {
        generatedAt,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        cwd: ctx.cwd,
        profile: activeProfile(ctx.cwd),
        configured: Boolean(config),
        defaultRuntime,
        runtime: runtime ? {
          id: runtime.id,
          enabled: runtime.enabled,
          provider: runtime.provider,
          taskRoutes: Object.keys(runtime.routes).sort(),
        } : undefined,
        provider: provider ? {
          id: provider.id,
          kind: provider.kind,
          defaultModel: provider.defaultModel,
          baseUrl: provider.baseUrl,
        } : undefined,
        session: session ? {
          id: session.id,
          title: session.title,
          channel: session.channel,
          peer: session.peer,
          createdAt: session.createdAt,
          tokensIn: session.tokensIn,
          tokensOut: session.tokensOut,
          costUsd: session.costUsd,
        } : undefined,
        latestRun: cockpit?.episodes.at(-1) ? {
          id: cockpit.episodes.at(-1)!.id,
          createdAt: cockpit.episodes.at(-1)!.createdAt,
          runtimeId: cockpit.episodes.at(-1)!.runtimeId,
          providerId: cockpit.episodes.at(-1)!.providerId,
          model: cockpit.episodes.at(-1)!.model,
          outcome: cockpit.episodes.at(-1)!.outcome?.kind ?? "unknown",
        } : undefined,
      },
    };
  } finally {
    store.close();
  }
}

function tokenise(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9_./:-]+/).filter(Boolean);
}

function toolVisible(entry: ToolEntry, ctx: ToolContext): boolean {
  if (ctx.toolAllowlist && !ctx.toolAllowlist.includes(entry.name)) return false;
  for (const env of entry.requiresEnv ?? []) {
    if (!process.env[env]) return false;
  }
  return entry.available ? entry.available(ctx) : true;
}

function toolSummary(entry: ToolEntry): Record<string, unknown> {
  return {
    id: entry.name,
    name: entry.name,
    toolset: entry.toolset,
    description: entry.description,
    requiresEnv: entry.requiresEnv ?? [],
    maxResultChars: entry.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS,
  };
}

function toolSearch(registry: ToolRegistryV2, args: ToolSearchArgs, ctx: ToolContext): ToolResult {
  const query = (args.query ?? "").trim();
  const terms = tokenise(query);
  const limit = discoveryLimit(args.limit);
  const entries = registry.list(args.toolset).filter((entry) => args.includeUnavailable || toolVisible(entry, ctx));
  const scored = entries.map((entry) => {
    const haystack = `${entry.name} ${entry.toolset} ${entry.description}`.toLowerCase();
    const score = terms.length === 0 ? 1 : terms.reduce((total, term) => {
      if (entry.name.toLowerCase() === term) return total + 12;
      if (entry.name.toLowerCase().includes(term)) return total + 8;
      if (entry.toolset.toLowerCase().includes(term)) return total + 5;
      if (haystack.includes(term)) return total + 2;
      return total;
    }, 0);
    return { entry, score };
  }).filter((hit) => terms.length === 0 || hit.score > 0);
  scored.sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name));
  return {
    ok: true,
    data: {
      query,
      count: Math.min(limit, scored.length),
      results: scored.slice(0, limit).map(({ entry, score }) => ({ ...toolSummary(entry), score })),
    },
  };
}

function toolDescribe(registry: ToolRegistryV2, args: ToolDescribeArgs, ctx: ToolContext): ToolResult {
  const name = args.name ?? args.id;
  if (!name) return { ok: false, error: "tool_describe requires name or id." };
  const entry = registry.list().find((candidate) => candidate.name === name);
  if (!entry || !toolVisible(entry, ctx)) return { ok: false, error: `Unknown or unavailable tool: ${name}` };
  return {
    ok: true,
    data: {
      ...toolSummary(entry),
      available: true,
      inputSchema: entry.inputSchema ?? { type: "object", additionalProperties: true },
    },
  };
}

async function toolCall(registry: ToolRegistryV2, args: ToolCallArgs, ctx: ToolContext): Promise<ToolResult> {
  const name = args.name ?? args.id;
  if (!name) return { ok: false, error: "tool_call requires name or id." };
  if (DISCOVERY_TOOLS.has(name)) return { ok: false, error: `tool_call cannot invoke discovery tool: ${name}` };
  const entry = registry.list().find((candidate) => candidate.name === name);
  if (!entry || !toolVisible(entry, ctx)) return { ok: false, error: `Unknown or unavailable tool: ${name}` };
  return registry.execute(name, args.args ?? {}, ctx);
}

function insideWorkspace(ctx: ToolContext, target: string): string {
  const root = resolve(ctx.cwd);
  const absolute = resolve(root, target);
  // A plain `startsWith(root)` check is bypassable: it is case-sensitive even on
  // case-insensitive filesystems, and it treats a sibling like `/work-evil` as
  // inside `/work` (shared prefix). Use path.relative instead: a path is inside
  // root iff the relative path is neither empty-with-escape nor itself absolute
  // and does not start with "..".
  const rel = relative(root, absolute);
  const escapes = rel === "" ? false : rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  if (escapes) throw new Error(`Path escapes the workspace: ${target}`);
  return absolute;
}

interface ScheduleManageArgs {
  readonly action?: string;
  readonly kind?: string;
  readonly message?: string;
  readonly when?: string;
  readonly cron?: string;
  readonly tz?: string;
  readonly deliver?: string;
  readonly id?: string;
}

async function scheduleManage(args: ScheduleManageArgs, ctx: ToolContext): Promise<ToolResult> {
  try {
    if (args.action === "create") {
      const job = await createAutomation({
        kind: (args.kind ?? "reminder") as "reminder" | "run",
        text: String(args.message ?? ""),
        when: args.when,
        cron: args.cron,
        tz: args.tz,
        deliver: args.deliver,
        cwd: ctx.cwd,
        enforceActiveCap: true,
      });
      return { ok: true, data: describeAutomation(job) };
    }
    if (args.action === "list") {
      return { ok: true, data: formatAutomationsTable(await listAutomations(ctx.cwd)).join("\n") };
    }
    if (args.action === "remove") {
      if (!args.id) return { ok: false, error: "remove needs an id (see action list)." };
      return (await removeSchedule(args.id, ctx.cwd))
        ? { ok: true, data: `Removed ${args.id}.` }
        : { ok: false, error: `No automation ${args.id}.` };
    }
    return { ok: false, error: 'action must be "create", "list" or "remove".' };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function registerBuiltinTools(registry: ToolRegistryV2): void {
  registry.register<ToolSearchArgs>({
    name: "tool_search", toolset: "discovery", description: "Search the authorized tool catalog by name, toolset, or description.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number", minimum: 1, maximum: 20 },
        toolset: { type: "string" },
        includeUnavailable: { type: "boolean" },
      },
    },
    async handler(args, ctx) {
      return toolSearch(registry, args, ctx);
    },
  });
  registry.register<ToolDescribeArgs>({
    name: "tool_describe", toolset: "discovery", description: "Load full metadata and input schema for one authorized tool.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
      },
    },
    async handler(args, ctx) {
      return toolDescribe(registry, args, ctx);
    },
  });
  registry.register<ToolCallArgs>({
    name: "tool_call", toolset: "discovery", description: "Call one authorized non-discovery tool by id/name with JSON arguments.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        args: { type: "object", additionalProperties: true },
      },
    },
    async handler(args, ctx) {
      return toolCall(registry, args, ctx);
    },
  });
  registry.register<{ path: string; offset?: number; limit?: number }>({
    name: "read_file", toolset: "files", description: "Read a workspace file (offset/limit in lines).",
    inputSchema: {
      type: "object",
      required: ["path"],
      properties: {
        path: { type: "string" },
        offset: { type: "number", minimum: 0 },
        limit: { type: "number", minimum: 1 },
      },
    },
    async handler(args, ctx) {
      const lines = (await readFile(insideWorkspace(ctx, args.path), "utf8")).split("\n");
      const offset = args.offset ?? 0;
      return { ok: true, data: lines.slice(offset, offset + (args.limit ?? 2000)).join("\n") };
    },
  });
  registry.register<{ path: string; content: string }>({
    name: "write_file", toolset: "files", description: "Write a workspace file (creates parent dirs).",
    inputSchema: {
      type: "object",
      required: ["path", "content"],
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
    },
    async handler(args, ctx) {
      const target = insideWorkspace(ctx, args.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, args.content);
      return { ok: true, data: `wrote ${args.content.length} chars to ${args.path}` };
    },
  });
  registry.register<{ query: string; dir?: string }>({
    name: "search_files", toolset: "files", description: "Substring search across workspace files.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string" },
        dir: { type: "string" },
      },
    },
    async handler(args, ctx) {
      const root = insideWorkspace(ctx, args.dir ?? ".");
      const hits: string[] = [];
      const walk = async (dir: string): Promise<void> => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
          const full = join(dir, entry.name);
          if (entry.isDirectory()) await walk(full);
          else if (hits.length < 50) {
            try {
              const content = await readFile(full, "utf8");
              const index = content.indexOf(args.query);
              if (index >= 0) hits.push(`${full.slice(root.length + 1)}: ${content.slice(Math.max(0, index - 40), index + 80).replace(/\s+/g, " ")}`);
            } catch { /* binary or unreadable: skip */ }
          }
        }
      };
      await walk(root);
      return { ok: true, data: hits.join("\n") || "no matches" };
    },
  });
  registry.register<{ dir?: string }>({
    name: "list_dir", toolset: "files", description: "List a workspace directory.",
    inputSchema: {
      type: "object",
      properties: {
        dir: { type: "string" },
      },
    },
    async handler(args, ctx) {
      const entries = await readdir(insideWorkspace(ctx, args.dir ?? "."), { withFileTypes: true });
      return { ok: true, data: entries.map((entry) => `${entry.isDirectory() ? "d" : "f"} ${entry.name}`).join("\n") };
    },
  });
  registry.register<{ url: string }>({
    name: "web_fetch", toolset: "web", description: "Fetch a public URL as text.",
    inputSchema: {
      type: "object",
      required: ["url"],
      properties: {
        url: { type: "string", format: "uri" },
      },
    },
    async handler(args, ctx) {
      const url = new URL(args.url);
      const blocked = assertPublicOrAllowedUrl(url, ctx);
      if (blocked) return blocked;
      const response = await fetchFor(ctx)(url, { signal: AbortSignal.timeout(15_000) });
      return { ok: response.ok, ...(response.ok ? { data: await response.text() } : { error: `HTTP ${response.status}`, retryable: response.status >= 500 }) } as ToolResult;
    },
  });
  registry.register<WebSearchArgs>({
    name: "web_search", toolset: "web", description: "Search the public web using DuckDuckGo or Brave.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string" },
        count: { type: "number", minimum: 1, maximum: 10 },
        provider: { enum: ["duckduckgo", "brave"] },
        baseUrl: { type: "string", format: "uri" },
        country: { type: "string" },
        language: { type: "string" },
        search_lang: { type: "string" },
        ui_lang: { type: "string" },
        freshness: { enum: ["day", "week", "month", "year"] },
        date_after: { type: "string" },
        date_before: { type: "string" },
        region: { type: "string" },
        safeSearch: { enum: ["strict", "moderate", "off"] },
      },
    },
    async handler(args, ctx) {
      return webSearch(args, ctx);
    },
  });
  registry.register<SessionSearchArgs>({
    name: "session_search", toolset: "sessions", description: "Search or browse persisted local conversation sessions; returns actual DB messages without LLM summarization.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Full-text query for discovery across active messages." },
        sessionId: { type: "string", description: "Session id to read or scroll." },
        aroundMessageId: { type: "number", minimum: 1, description: "When paired with sessionId, return a small window around this message id." },
        limit: { type: "number", minimum: 1, maximum: 20 },
      },
    },
    async handler(args, ctx) {
      return sessionSearch(args, ctx);
    },
  });
  registry.register<SessionStatusArgs>({
    name: "session_status", toolset: "sessions", description: "Show a compact read-only status card: live time, profile, default runtime, provider, latest run, and session usage.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Optional session id to report; omitted means the most recent visible local session." },
      },
    },
    async handler(args, ctx) {
      return sessionStatus(args, ctx);
    },
  });
  registry.register<MemorySearchToolArgs>({
    name: "memory_search", toolset: "memory", description: "Search durable memory visible to the provided scopes; optional global inclusion is explicit.",
    inputSchema: {
      type: "object",
      required: ["scopes"],
      properties: {
        query: { type: "string", description: "Optional case-insensitive substring query over summary, provenance, source, kind, and scope labels." },
        scopes: { type: "array", minItems: 1, items: { type: "string" }, description: "Caller scopes as kind:id, for example tenant:hybrow or user:dhairya." },
        includeGlobal: { type: "boolean", description: "Also search global:global memory." },
        limit: { type: "number", minimum: 1, maximum: 20 },
      },
    },
    async handler(args, ctx) {
      return memorySearch(args, ctx);
    },
  });
  registry.register<MemoryGetToolArgs>({
    name: "memory_get", toolset: "memory", description: "Read one durable memory item only if it is visible to the provided scopes.",
    inputSchema: {
      type: "object",
      required: ["id", "scopes"],
      properties: {
        id: { type: "string" },
        scopes: { type: "array", minItems: 1, items: { type: "string" }, description: "Caller scopes as kind:id, for example tenant:hybrow or user:dhairya." },
        includeGlobal: { type: "boolean", description: "Also allow global:global memory." },
      },
    },
    async handler(args, ctx) {
      return memoryGet(args, ctx);
    },
  });
  registry.register<MemoryWriteToolArgs>({
    name: "memory_write", toolset: "memory_write", description: "Remember a durable fact for the given scopes. Obeys the workspace memory policy; set userAskedToRemember only when the user explicitly asked to remember it.",
    inputSchema: {
      type: "object",
      required: ["summary", "scopes"],
      properties: {
        summary: { type: "string", description: "The fact, in one sentence." },
        scopes: { type: "array", minItems: 1, items: { type: "string" }, description: "Who the fact belongs to, as kind:id, for example user:dhairya or tenant:hybrow." },
        kind: { type: "string", description: "fact (default), preference, decision, …" },
        userAskedToRemember: { type: "boolean", description: "True only when the user explicitly asked you to remember this." },
      },
    },
    async handler(args, ctx) {
      return memoryWrite(args, ctx);
    },
  });
  registry.register<{ command: string; args?: string[] }>({
    name: "terminal", toolset: "shell", description: "Run an allowlisted command (no shell interpolation).",
    inputSchema: {
      type: "object",
      required: ["command"],
      properties: {
        command: { type: "string" },
        args: { type: "array", items: { type: "string" } },
      },
    },
    available: (ctx) => (ctx.allowCommands ?? []).length > 0,
    async handler(args, ctx) {
      if (!(ctx.allowCommands ?? []).includes(args.command)) {
        return { ok: false, error: `Command not allowlisted: ${args.command}` };
      }
      try {
        const { stdout, stderr } = await execFileAsync(args.command, args.args ?? [], { cwd: ctx.cwd, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
        return { ok: true, data: stdout + (stderr ? `\n[stderr] ${stderr}` : "") };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  });
  registry.register<ScheduleManageArgs>({
    name: "schedule_manage", toolset: "schedule",
    description: `Set reminders and routines that run by themselves. create: kind "reminder" delivers a fixed message at a time (no model call); kind "run" runs a prompt then delivers the answer. Give when ("in 5m", "in 2h", "in 1d", or an ISO time with offset) for one-off, or cron (5 fields, optional tz) for recurring. deliver: terminal (the user's open Muster chat), desktop, or channel:<id>. Messages up to ${MAX_AUTOMATION_TEXT} characters; at most ${MAX_ACTIVE_AUTOMATIONS} active jobs. The result states exactly what was scheduled — repeat it to the user. list shows all jobs; remove takes an id.`,
    inputSchema: {
      type: "object",
      required: ["action"],
      properties: {
        action: { type: "string", enum: ["create", "list", "remove"] },
        kind: { type: "string", enum: ["reminder", "run"], description: "create: reminder (default) or run." },
        message: { type: "string", maxLength: MAX_AUTOMATION_TEXT, description: "create: the reminder text, or the prompt for a run." },
        when: { type: "string", description: `create one-off: ${WHEN_FORMS}.` },
        cron: { type: "string", description: "create recurring: five-field cron, e.g. \"0 9 * * 1-5\"." },
        tz: { type: "string", description: "IANA time zone the cron is read in, e.g. Asia/Kolkata." },
        deliver: { type: "string", description: "terminal (default), desktop, or channel:<id>." },
        id: { type: "string", description: "remove: the job id (sched_…)." },
      },
    },
    async handler(args, ctx) {
      return scheduleManage(args, ctx);
    },
  });
  registry.register<{ id: string; offset?: number; limit?: number }>({
    name: "result_fetch", toolset: "results", description: "Fetch a persisted oversized tool result by id.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string" },
        offset: { type: "number", minimum: 0 },
        limit: { type: "number", minimum: 1 },
      },
    },
    async handler(args, ctx) {
      const fetched = await resultFetch(args.id, { offset: args.offset, limit: args.limit }, ctx.cwd);
      return { ok: true, data: fetched.content };
    },
  });
}
