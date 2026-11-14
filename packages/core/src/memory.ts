import { appendFile, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { dataDir } from "./store.js";
import { configPath } from "./config.js";
import type { ContextObject, MemoryScope, MemoryScopeKind, MemoryWritePolicy } from "./types.js";

export interface AddMemoryInput {
  readonly kind?: string;
  readonly summary: string;
  readonly sourceUri?: string;
  /** Explicit observation time for fixtures/imports; defaults to now for normal writes. */
  readonly observedAt?: string;
  readonly confidence?: number;
  readonly provenance: string[];
  readonly scopes: MemoryScope[];
  readonly redactionState?: ContextObject["redactionState"];
  readonly links?: string[];
  /**
   * True only when the human in the loop asked for this fact to be remembered
   * ("remember that…", `muster memory add`). The one thing that satisfies a
   * `never` policy — never set it from a heuristic.
   */
  readonly explicitUserRequest?: boolean;
  /**
   * Proof that consent was obtained for this write under an `ask` policy: the
   * id//description of the confirmation the user answered. Free-form so callers
   * can cite an approval id, a turn id, or a CLI flag.
   */
  readonly consentReceipt?: string;
}

/**
 * Thrown when config.memory.policy forbids a durable write. Enforcement lives in
 * `addMemory` itself, so no caller — including the goal loop in run.ts — can
 * route around it: the policy holds by construction, not by prompt string.
 */
export class MemoryPolicyError extends Error {
  readonly policy: MemoryWritePolicy;

  constructor(policy: MemoryWritePolicy, message: string) {
    super(message);
    this.name = "MemoryPolicyError";
    this.policy = policy;
  }
}

export interface SearchMemoryInput {
  readonly query?: string;
  readonly scopes: MemoryScope[];
  readonly includeGlobal?: boolean;
  readonly limit?: number;
  readonly match?: "all" | "any";
}

export interface MemoryReceipt {
  readonly memory: ContextObject;
  readonly score: number;
  readonly matchedTerms: string[];
  readonly reason: string;
}

export interface SearchMemoryReceiptInput extends SearchMemoryInput {
  readonly candidateLimit?: number;
  readonly minScore?: number;
  /** Opt-in graph lane: include visible memories linked from lexical seed hits. */
  readonly expandLinked?: boolean;
  readonly graphNeighborLimit?: number;
}

export interface SearchMemoryReceiptResult {
  readonly query: string;
  readonly scopes: MemoryScope[];
  readonly includeGlobal: boolean;
  readonly backend: "sqlite-fts5" | "sqlite-like";
  readonly requestedLimit: number;
  readonly candidateCount: number;
  readonly linkedCandidateCount?: number;
  readonly receipts: MemoryReceipt[];
  readonly fallbackUsed: boolean;
}

export interface PromoteMemoryInput {
  readonly id: string;
  readonly targetScopes: MemoryScope[];
  readonly allowGlobal?: boolean;
}

export interface MemoryStoreDiagnostic {
  readonly label: string;
  readonly status: "passed" | "warning" | "failed";
  readonly detail: string;
}

export interface MemoryStoreInspection {
  readonly memoryPath: string;
  readonly dbPath: string;
  readonly jsonl: {
    readonly exists: boolean;
    readonly valid: boolean;
    readonly size: number;
    readonly mtimeMs: number;
    readonly objectCount: number;
    readonly duplicateIds: number;
    readonly zeroScopeObjects: number;
    readonly blockedObjects: number;
    readonly error?: string;
  };
  readonly index: {
    readonly exists: boolean;
    readonly readable: boolean;
    readonly initialized: boolean;
    readonly fresh: boolean;
    readonly backend?: "sqlite-fts5" | "sqlite-like";
    /** Derived-index schema marker (`version:tokenizer`); differs from current when a migration is pending. */
    readonly schema?: string;
    readonly size: number;
    readonly mtimeMs: number;
    readonly objectCount?: number;
    readonly scopeRowCount?: number;
    readonly sourceSize?: number;
    readonly sourceMtimeMs?: number;
    readonly error?: string;
  };
  readonly scopes: readonly { readonly scope: string; readonly count: number }[];
  readonly checks: readonly MemoryStoreDiagnostic[];
}

export interface RebuildMemoryIndexResult {
  readonly rebuilt: boolean;
  readonly removedExisting: boolean;
  readonly inspection: MemoryStoreInspection;
}

export interface MemoryLatencyProbeInput extends SearchMemoryReceiptInput {
  readonly runs?: number;
}

export interface MemoryLatencyProbeResult {
  readonly query: string;
  readonly runs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly minMs: number;
  readonly maxMs: number;
  readonly backend: SearchMemoryReceiptResult["backend"];
  readonly candidateCount: number;
  readonly recalledCount: number;
}

/**
 * FTS5 tokenizer for the derived recall index. `porter` stems English terms so a
 * "deploy" query recalls a "deploys" summary; `unicode61` keeps the non-ASCII
 * folding the default tokenizer already provided.
 */
const MEMORY_FTS_TOKENIZER = "porter unicode61";
/** Bump whenever the derived index shape or tokenizer changes; older indexes then re-derive on open. */
const MEMORY_INDEX_SCHEMA_VERSION = 2;
const MEMORY_INDEX_SCHEMA_KEY = "index_schema";
const MEMORY_INDEX_SCHEMA_MARKER = `${MEMORY_INDEX_SCHEMA_VERSION}:${MEMORY_FTS_TOKENIZER}`;

export function memoryPath(cwd = process.cwd()): string {
  return join(dataDir(cwd), "memory.jsonl");
}

export function memoryDbPath(cwd = process.cwd()): string {
  return join(dataDir(cwd), "memory.db");
}

/**
 * The configured durable-write policy for `cwd`, defaulting to "auto".
 *
 * Reads the profile config directly rather than through `loadConfig` so a
 * missing, unreadable, or older config degrades to today's behaviour instead of
 * failing a write, and an unknown policy string is treated as the strictest
 * thing it can safely mean: nothing (auto) is never inferred from garbage —
 * garbage is rejected loudly at write time.
 */
export async function memoryWritePolicy(cwd = process.cwd()): Promise<MemoryWritePolicy> {
  let raw: string;
  try {
    raw = await readFile(configPath(cwd), "utf8");
  } catch {
    return "auto";
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "auto";
  }
  const policy = (parsed as { memory?: { policy?: unknown } } | null)?.memory?.policy;
  if (policy === undefined || policy === null) return "auto";
  if (policy === "auto" || policy === "ask" || policy === "never") return policy;
  throw new MemoryPolicyError(
    "never",
    `Unknown config.memory.policy: ${JSON.stringify(policy)}. Set it to "auto", "ask", or "never" — durable writes stay blocked until it is a policy Muster can enforce.`,
  );
}

/**
 * Enforce config.memory.policy for one write. Exported so callers that want to
 * check before doing expensive work can, but `addMemory` calls it itself: the
 * gate is not optional.
 */
export async function assertMemoryWriteAllowed(input: AddMemoryInput, cwd = process.cwd()): Promise<MemoryWritePolicy> {
  const policy = await memoryWritePolicy(cwd);
  if (policy === "never" && input.explicitUserRequest !== true) {
    throw new MemoryPolicyError(
      "never",
      "config.memory.policy is \"never\": Muster does not write durable memory on its own. Only a write the user explicitly asked for is allowed — pass explicitUserRequest: true for that case. To change the policy, re-run `muster onboard` and pick a different memory option, or set memory.policy in .muster/config.json.",
    );
  }
  if (policy === "ask" && input.explicitUserRequest !== true) {
    const receipt = typeof input.consentReceipt === "string" ? input.consentReceipt.trim() : "";
    if (!receipt) {
      throw new MemoryPolicyError(
        "ask",
        "config.memory.policy is \"ask\": obtain the user's confirmation for this memory before writing it, then pass consentReceipt with the id of that confirmation (an approval id, turn id, or the flag the user answered). Writes without a consent receipt are refused.",
      );
    }
  }
  return policy;
}

export async function addMemory(input: AddMemoryInput, cwd = process.cwd()): Promise<ContextObject> {
  const validated = validateMemoryInput(input);
  await assertMemoryWriteAllowed(input, cwd);
  const previousStats = await memorySourceStats(cwd);
  const object: ContextObject = {
    id: `mem_${randomUUID()}`,
    kind: validated.kind,
    summary: validated.summary,
    sourceUri: validated.sourceUri,
    observedAt: validated.observedAt ?? new Date().toISOString(),
    confidence: validated.confidence,
    provenance: validated.provenance,
    scopes: validated.scopes,
    redactionState: validated.redactionState,
    links: validated.links
  };
  await appendMemory(object, cwd);
  await indexMemoryObject(object, cwd, previousStats);
  return object;
}

export async function listMemory(cwd = process.cwd()): Promise<ContextObject[]> {
  return readJsonLines<ContextObject>(memoryPath(cwd));
}

export async function findMemory(id: string, cwd = process.cwd()): Promise<ContextObject | undefined> {
  const memoryId = requiredString(id, "findMemory", "id", "a non-empty memory id such as mem_1234.");
  const store = await openMemoryIndex(cwd, { rebuildPolicy: "if-missing" });
  try {
    const object = store.find(memoryId);
    if (object) return object;
  } finally {
    store.close();
  }
  const objects = await listMemory(cwd);
  return objects.find((object) => object.id === memoryId);
}

export async function searchMemory(input: SearchMemoryInput, cwd = process.cwd()): Promise<ContextObject[]> {
  const validated = validateSearchInput(input, "searchMemory");
  const store = await openMemoryIndex(cwd, { rebuildPolicy: "if-missing" });
  try {
    return store.search({ query: validated.query, scopes: validated.effectiveScopes, limit: validated.limit, match: validated.match });
  } finally {
    store.close();
  }
}

export async function searchMemoryWithReceipts(input: SearchMemoryReceiptInput, cwd = process.cwd()): Promise<SearchMemoryReceiptResult> {
  const validated = validateReceiptSearchInput(input, "searchMemoryWithReceipts");
  const { limit, candidateLimit, minScore, query, scopes: allowedScopes, effectiveScopes } = validated;
  const store = await openMemoryIndex(cwd, { rebuildPolicy: "if-missing" });
  try {
    const lexical = query
      ? store.search({ query, scopes: effectiveScopes, limit: candidateLimit, match: validated.match ?? "any" })
      : [];
    const scored = rankMemoryCandidates(query, lexical, minScore);
    let fallbackUsed = false;
    let candidates = lexical;
    let receipts = scored;
    let linkedCandidateCount = 0;
    if (validated.expandLinked && query && lexical.length) {
      const linked = linkedMemoryReceipts({
        seeds: lexical,
        store,
        scopes: effectiveScopes,
        seenIds: new Set(),
        limit: validated.graphNeighborLimit ?? Math.max(limit * 4, 20),
      });
      linkedCandidateCount = linked.length;
      if (linked.length) {
        const candidateIds = new Set(candidates.map((object) => object.id));
        candidates = [...candidates, ...linked.map((receipt) => receipt.memory).filter((memory) => !candidateIds.has(memory.id))];
        receipts = mergeReceiptsByMemoryId([...receipts, ...linked]);
      }
    }
    if (!query && receipts.length < limit) {
      fallbackUsed = true;
      const recent = store.search({ scopes: effectiveScopes, limit: candidateLimit });
      const seen = new Set(candidates.map((object) => object.id));
      candidates = [...candidates, ...recent.filter((object) => !seen.has(object.id))];
      receipts = rankMemoryCandidates(query, candidates, minScore);
    }
    return {
      query,
      scopes: allowedScopes,
      includeGlobal: validated.includeGlobal,
      backend: store.backend,
      requestedLimit: limit,
      candidateCount: candidates.length,
      linkedCandidateCount: validated.expandLinked ? linkedCandidateCount : undefined,
      receipts: receipts.slice(0, limit),
      fallbackUsed,
    };
  } finally {
    store.close();
  }
}

export async function promoteMemory(input: PromoteMemoryInput, cwd = process.cwd()): Promise<ContextObject> {
  const raw = requireInputObject(input, "promoteMemory", "{ id, targetScopes }");
  const id = requiredString(raw.id, "promoteMemory", "id", "a non-empty memory id such as mem_1234.");
  const targetScopes = requiredScopes(raw.targetScopes, "promoteMemory", "targetScopes");
  const allowGlobal = optionalBoolean(raw.allowGlobal, "promoteMemory", "allowGlobal") ?? false;
  const source = await findMemory(id, cwd);
  if (!source) throw new Error(`Memory not found: ${id}`);
  if (targetScopes.some((scope) => scope.kind === "global") && !allowGlobal) {
    throw new Error("Promoting memory to global requires allowGlobal=true.");
  }
  const promoted: ContextObject = {
    ...source,
    id: `mem_${randomUUID()}`,
    observedAt: new Date().toISOString(),
    provenance: [...source.provenance, `promoted-from:${source.id}`],
    scopes: targetScopes,
    links: [...(source.links ?? []), source.id]
  };
  const previousStats = await memorySourceStats(cwd);
  await appendMemory(promoted, cwd);
  await indexMemoryObject(promoted, cwd, previousStats);
  return promoted;
}

export async function inspectMemoryStore(cwd = process.cwd()): Promise<MemoryStoreInspection> {
  const sourcePath = memoryPath(cwd);
  const indexPath = memoryDbPath(cwd);
  const sourceStats = await memorySourceStats(cwd);
  const dbStats = await stat(indexPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  let objects: ContextObject[] = [];
  let jsonlError: string | undefined;
  try {
    objects = await listMemory(cwd);
  } catch (error) {
    jsonlError = error instanceof Error ? error.message : String(error);
  }
  const ids = new Set<string>();
  let duplicateIds = 0;
  let zeroScopeObjects = 0;
  let blockedObjects = 0;
  const scopeCounts = new Map<string, number>();
  if (!jsonlError) {
    for (const object of objects) {
      const id = typeof object?.id === "string" ? object.id : "";
      if (id && ids.has(id)) duplicateIds += 1;
      ids.add(id);
      const scopes = safeNormalizeScopes(object?.scopes);
      if (!scopes.length) zeroScopeObjects += 1;
      if (object?.redactionState === "blocked") blockedObjects += 1;
      for (const scope of scopes) {
        const key = formatMemoryScope(scope);
        scopeCounts.set(key, (scopeCounts.get(key) ?? 0) + 1);
      }
    }
  }
  const index = dbStats
    ? inspectMemoryIndex(indexPath, dbStats.size, dbStats.mtimeMs, sourceStats)
    : {
        exists: false,
        readable: false,
        initialized: false,
        fresh: sourceStats.size === 0,
        size: 0,
        mtimeMs: 0,
      };
  const jsonl = {
    exists: sourceStats.size > 0 || sourceStats.mtimeMs > 0,
    valid: !jsonlError,
    size: sourceStats.size,
    mtimeMs: sourceStats.mtimeMs,
    objectCount: jsonlError ? 0 : objects.length,
    duplicateIds,
    zeroScopeObjects,
    blockedObjects,
    error: jsonlError,
  };
  const checks: MemoryStoreDiagnostic[] = [
    {
      label: "jsonl_valid",
      status: jsonl.valid ? "passed" : "failed",
      detail: jsonl.error ?? `${jsonl.objectCount} memory objects parsed`,
    },
    {
      label: "duplicate_ids",
      status: duplicateIds === 0 ? "passed" : "failed",
      detail: duplicateIds === 0 ? "none" : `${duplicateIds} duplicate ids`,
    },
    {
      label: "zero_scope_objects",
      status: zeroScopeObjects === 0 ? "passed" : "failed",
      detail: zeroScopeObjects === 0 ? "none" : `${zeroScopeObjects} objects without scope`,
    },
    {
      label: "index_readable",
      status: index.exists ? (index.readable ? "passed" : "failed") : "warning",
      detail: index.exists ? (index.error ?? "sqlite index readable") : "index missing; it will be rebuilt from JSONL when needed",
    },
    {
      label: "index_fresh",
      status: index.exists && index.readable && index.fresh ? "passed" : index.exists && index.readable ? "warning" : "warning",
      detail: index.exists ? (index.fresh ? "source stats match" : "source stats differ; derived index should be rebuilt") : "no derived index yet",
    },
    {
      label: "fts_backend",
      status: index.backend === "sqlite-fts5" ? "passed" : "warning",
      detail: index.backend === "sqlite-fts5" ? "FTS5 available" : index.exists ? "using LIKE fallback or unreadable index" : "backend unknown until index is built",
    },
    {
      label: "index_schema",
      status: index.schema === MEMORY_INDEX_SCHEMA_MARKER ? "passed" : "warning",
      detail: index.schema === MEMORY_INDEX_SCHEMA_MARKER
        ? `schema ${MEMORY_INDEX_SCHEMA_MARKER}`
        : index.exists
          ? `schema ${index.schema ?? "pre-tokenizer"}; it re-derives to ${MEMORY_INDEX_SCHEMA_MARKER} on next open`
          : `no derived index yet; it will be built as ${MEMORY_INDEX_SCHEMA_MARKER}`,
    },
  ];
  return {
    memoryPath: sourcePath,
    dbPath: indexPath,
    jsonl,
    index,
    scopes: [...scopeCounts].sort((a, b) => a[0].localeCompare(b[0])).map(([scope, count]) => ({ scope, count })),
    checks,
  };
}

export async function rebuildMemoryIndex(cwd = process.cwd()): Promise<RebuildMemoryIndexResult> {
  await listMemory(cwd);
  let removedExisting = false;
  await unlink(memoryDbPath(cwd)).then(() => {
    removedExisting = true;
  }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  const store = await openMemoryIndex(cwd, { rebuildPolicy: "if-missing" });
  store.close();
  return { rebuilt: true, removedExisting, inspection: await inspectMemoryStore(cwd) };
}

export async function probeMemorySearchLatency(input: MemoryLatencyProbeInput, cwd = process.cwd()): Promise<MemoryLatencyProbeResult> {
  const validated = validateReceiptSearchInput(input, "probeMemorySearchLatency");
  const runs = Math.max(1, Math.min(200, Math.floor(optionalFiniteNumber(input.runs, "probeMemorySearchLatency", "runs", "a finite number of probe runs.") ?? 25)));
  const timings: number[] = [];
  let latest: SearchMemoryReceiptResult | undefined;
  for (let index = 0; index < runs; index += 1) {
    const started = performance.now();
    latest = await searchMemoryWithReceipts(input, cwd);
    timings.push(performance.now() - started);
  }
  timings.sort((a, b) => a - b);
  const p50Ms = percentileValue(timings, 0.5);
  const p95Ms = percentileValue(timings, 0.95);
  return {
    query: latest?.query ?? validated.query,
    runs,
    p50Ms,
    p95Ms,
    minMs: timings[0] ?? 0,
    maxMs: timings.at(-1) ?? 0,
    backend: latest?.backend ?? "sqlite-like",
    candidateCount: latest?.candidateCount ?? 0,
    recalledCount: latest?.receipts.length ?? 0,
  };
}

export function parseMemoryScope(value: string): MemoryScope {
  const raw = requiredString(value, "parseMemoryScope", "value", 'a "kind:id" string, for example user:dhairya.');
  const [kind, ...rest] = raw.split(":");
  const id = rest.join(":");
  if (!isScopeKind(kind) || !id.trim()) {
    throw new Error(`Invalid memory scope "${raw}". Use kind:id, for example user:dhairya or tenant:oxygenhr.`);
  }
  return { kind, id: normalizeScopeId(kind, id) };
}

export function formatMemoryScope(scope: MemoryScope): string {
  if (!isScopeObject(scope)) {
    throw new Error(`formatMemoryScope requires scope: an object like { kind: "user", id: "dhairya" }, received ${describeValue(scope)}.`);
  }
  return `${scope.kind}:${scope.id}`;
}

export function isVisibleInScopes(object: ContextObject, allowedScopes: readonly MemoryScope[]): boolean {
  const target = requireInputObject(object, "isVisibleInScopes", "a memory object with scopes");
  const normalizedAllowed = requiredScopes(allowedScopes, "isVisibleInScopes", "allowedScopes");
  const objectScopes = normalizeScopes(scopeArray(target.scopes, "isVisibleInScopes", "object.scopes"));
  // Zero-scope rows are malformed; the scoped SQL path hides them, so direct reads must too.
  if (!objectScopes.length) return false;
  return objectScopes.every((scope) => normalizedAllowed.some((candidate) => sameScope(scope, candidate)));
}

/**
 * Forget the automatic turn summaries (`episode_summary`, provenance
 * `run:<id>`) of the given runs — what `/rewind` does for rewound turns.
 * Facts the user asked to remember are never removed. Returns how many went.
 */
export async function forgetTurnMemories(runIds: readonly string[], cwd = process.cwd()): Promise<number> {
  if (!runIds.length) return 0;
  const runs = new Set(runIds.map((id) => `run:${id}`));
  const all = await listMemory(cwd);
  const keep = all.filter((memory) => !(memory.kind === "episode_summary" && memory.provenance.some((entry) => runs.has(entry))));
  const removed = all.length - keep.length;
  if (!removed) return 0;
  const path = memoryPath(cwd);
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, keep.map((memory) => `${JSON.stringify(memory)}\n`).join(""), "utf8");
  await rename(temp, path);
  await rebuildMemoryIndex(cwd);
  return removed;
}

/**
 * Remove the memories with these ids (what `muster migrate undo` does for the
 * entries a run added). Returns the ids that were present and removed.
 */
export async function forgetMemories(ids: readonly string[], cwd = process.cwd()): Promise<string[]> {
  if (!ids.length) return [];
  const wanted = new Set(ids);
  const all = await listMemory(cwd);
  const removed = all.filter((memory) => wanted.has(memory.id)).map((memory) => memory.id);
  if (!removed.length) return [];
  const keep = all.filter((memory) => !wanted.has(memory.id));
  const path = memoryPath(cwd);
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, keep.map((memory) => `${JSON.stringify(memory)}\n`).join(""), "utf8");
  await rename(temp, path);
  await rebuildMemoryIndex(cwd);
  return removed;
}

async function appendMemory(object: ContextObject, cwd: string): Promise<void> {
  const path = memoryPath(cwd);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(object)}\n`, "utf8");
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
  };
  close(): void;
}

interface MemoryIndex {
  readonly backend: "sqlite-fts5" | "sqlite-like";
  find(id: string): ContextObject | undefined;
  search(input: { query?: string; scopes: readonly MemoryScope[]; limit?: number; match?: "all" | "any" }): ContextObject[];
  close(): void;
}

function linkedMemoryReceipts(input: {
  readonly seeds: readonly ContextObject[];
  readonly store: MemoryIndex;
  readonly scopes: readonly MemoryScope[];
  readonly seenIds: Set<string>;
  readonly limit: number;
}): MemoryReceipt[] {
  const receipts: MemoryReceipt[] = [];
  const sourcesById = new Map<string, string[]>();
  for (const seed of input.seeds) {
    for (const link of seed.links ?? []) {
      const id = normalizeMemoryLinkId(link);
      if (!id || input.seenIds.has(id)) continue;
      const linked = input.store.find(id);
      if (!linked || linked.redactionState === "blocked" || !isVisibleInScopes(linked, input.scopes)) continue;
      input.seenIds.add(id);
      sourcesById.set(id, [...(sourcesById.get(id) ?? []), seed.id]);
      receipts.push({
        memory: linked,
        score: 1.25 + recencyConfidenceScore(linked),
        matchedTerms: [],
        reason: `linked from ${seed.id}`,
      });
      if (receipts.length >= input.limit) return receipts.sort(compareReceipts);
    }
  }
  return receipts.map((receipt) => {
    const sources = sourcesById.get(receipt.memory.id) ?? [];
    return sources.length > 1
      ? { ...receipt, reason: `linked from ${sources.slice(0, 3).join(",")}` }
      : receipt;
  }).sort(compareReceipts);
}

function mergeReceiptsByMemoryId(receipts: readonly MemoryReceipt[]): MemoryReceipt[] {
  const byId = new Map<string, MemoryReceipt>();
  for (const receipt of receipts) {
    const existing = byId.get(receipt.memory.id);
    if (!existing || compareReceipts(receipt, existing) < 0) byId.set(receipt.memory.id, receipt);
  }
  return [...byId.values()].sort(compareReceipts);
}

function normalizeMemoryLinkId(link: string): string {
  return link.trim().replace(/^memory:/, "");
}

async function indexMemoryObject(object: ContextObject, cwd: string, previousStats: MemorySourceStats): Promise<void> {
  const store = await openMemoryIndex(cwd, { skipRebuild: true, expectedSourceStats: previousStats });
  try {
    store.upsert(object);
    await store.updateSourceStats();
  } finally {
    store.close();
  }
}

interface MemorySourceStats {
  readonly size: number;
  readonly mtimeMs: number;
}

async function openMemoryIndex(cwd: string, options: { skipRebuild?: boolean; expectedSourceStats?: MemorySourceStats; rebuildPolicy?: "if-stale" | "if-missing" | "never" } = {}): Promise<MemoryIndex & { upsert(object: ContextObject): void; updateSourceStats(): Promise<void> }> {
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: new (path: string) => SqliteDatabase };
  mkdirSync(dataDir(cwd), { recursive: true });
  const db = new DatabaseSync(memoryDbPath(cwd));
  let backend: MemoryIndex["backend"] = "sqlite-like";
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS memory (
      rowid INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      summary TEXT NOT NULL,
      source_uri TEXT,
      observed_at TEXT NOT NULL,
      confidence REAL NOT NULL,
      provenance_json TEXT NOT NULL,
      scopes_json TEXT NOT NULL,
      redaction_state TEXT NOT NULL,
      links_json TEXT NOT NULL,
      searchable_text TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memory_scope (
      memory_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      kind TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      PRIMARY KEY (memory_id, scope)
    );
    CREATE INDEX IF NOT EXISTS idx_memory_observed ON memory(observed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_scope_lookup ON memory_scope(scope, memory_id);
  `);
  const staleSchema = readMetaString(db, MEMORY_INDEX_SCHEMA_KEY) !== MEMORY_INDEX_SCHEMA_MARKER;
  if (staleSchema) dropMemoryFts(db);
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(searchable_text, content='memory', content_rowid='rowid', tokenize='${MEMORY_FTS_TOKENIZER}');
      CREATE TRIGGER IF NOT EXISTS memory_ai AFTER INSERT ON memory BEGIN
        INSERT INTO memory_fts(rowid, searchable_text) VALUES (new.rowid, new.searchable_text);
      END;
      CREATE TRIGGER IF NOT EXISTS memory_ad AFTER DELETE ON memory BEGIN
        INSERT INTO memory_fts(memory_fts, rowid, searchable_text) VALUES('delete', old.rowid, old.searchable_text);
      END;
      CREATE TRIGGER IF NOT EXISTS memory_au AFTER UPDATE ON memory BEGIN
        INSERT INTO memory_fts(memory_fts, rowid, searchable_text) VALUES('delete', old.rowid, old.searchable_text);
        INSERT INTO memory_fts(rowid, searchable_text) VALUES (new.rowid, new.searchable_text);
      END;
    `);
    backend = "sqlite-fts5";
    if (staleSchema) {
      // External-content FTS: re-derive every row from `memory` so pre-porter indexes migrate in place.
      db.exec("INSERT INTO memory_fts(memory_fts) VALUES('rebuild');");
      writeMetaString(db, MEMORY_INDEX_SCHEMA_KEY, MEMORY_INDEX_SCHEMA_MARKER);
    }
  } catch {
    // FTS5 is optional in Node builds; LIKE still uses the scoped index.
    // The schema marker stays unwritten so the next open retries the migration.
  }

  const upsert = (object: ContextObject): void => {
    const scopes = normalizeScopes(object.scopes);
    db.prepare(`
      INSERT INTO memory (id, kind, summary, source_uri, observed_at, confidence, provenance_json, scopes_json, redaction_state, links_json, searchable_text)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        kind = excluded.kind,
        summary = excluded.summary,
        source_uri = excluded.source_uri,
        observed_at = excluded.observed_at,
        confidence = excluded.confidence,
        provenance_json = excluded.provenance_json,
        scopes_json = excluded.scopes_json,
        redaction_state = excluded.redaction_state,
        links_json = excluded.links_json,
        searchable_text = excluded.searchable_text
    `).run(
      object.id,
      object.kind,
      object.summary,
      object.sourceUri ?? null,
      object.observedAt,
      object.confidence,
      JSON.stringify(object.provenance),
      JSON.stringify(scopes),
      object.redactionState,
      JSON.stringify(object.links ?? []),
      searchableText({ ...object, scopes }),
    );
    db.prepare("DELETE FROM memory_scope WHERE memory_id = ?").run(object.id);
    const insertScope = db.prepare("INSERT INTO memory_scope (memory_id, scope, kind, scope_id) VALUES (?, ?, ?, ?)");
    for (const scope of scopes) insertScope.run(object.id, formatMemoryScope(scope), scope.kind, scope.id);
  };

  const updateSourceStats = async (): Promise<void> => {
    const stats = await memorySourceStats(cwd);
    writeMetaString(db, "source_size", String(stats.size));
    writeMetaString(db, "source_mtime_ms", String(stats.mtimeMs));
  };

  const rebuild = async (): Promise<void> => {
    const objects = await listMemory(cwd);
    db.exec("BEGIN IMMEDIATE;");
    try {
      db.exec("DELETE FROM memory_scope; DELETE FROM memory;");
      for (const object of objects) upsert(object);
      await updateSourceStats();
      db.exec("COMMIT;");
    } catch (error) {
      db.exec("ROLLBACK;");
      throw error;
    }
  };

  if (options.skipRebuild) {
    if (options.expectedSourceStats && !indexInitialized(db) && await indexStale(db, options.expectedSourceStats)) await rebuild();
  } else if (options.rebuildPolicy !== "never") {
    const shouldRebuild = options.rebuildPolicy === "if-missing"
      ? !indexInitialized(db)
      : await indexStale(db, await memorySourceStats(cwd));
    if (shouldRebuild) await rebuild();
  }

  const toObject = (row: Record<string, unknown>): ContextObject => ({
    id: String(row.id),
    kind: String(row.kind),
    summary: String(row.summary),
    sourceUri: row.source_uri === null || row.source_uri === undefined ? undefined : String(row.source_uri),
    observedAt: String(row.observed_at),
    confidence: Number(row.confidence),
    provenance: parseJsonArray(String(row.provenance_json)),
    scopes: parseJsonScopes(String(row.scopes_json)),
    redactionState: String(row.redaction_state) as ContextObject["redactionState"],
    links: parseJsonArray(String(row.links_json)),
  });

  const visibleClause = (scopes: readonly MemoryScope[]): { sql: string; params: string[] } => {
    const allowed = normalizeScopes(scopes).map(formatMemoryScope);
    if (!allowed.length) throw new Error("At least one query scope is required.");
    return {
      sql: `EXISTS (
        SELECT 1 FROM memory_scope ms_present WHERE ms_present.memory_id = m.id
      ) AND NOT EXISTS (
        SELECT 1 FROM memory_scope ms
        WHERE ms.memory_id = m.id AND ms.scope NOT IN (${allowed.map(() => "?").join(",")})
      )`,
      params: allowed,
    };
  };

  const limitClause = (limit: number | undefined): { sql: string; params: number[] } => {
    if (limit === undefined) return { sql: "", params: [] };
    return { sql: " LIMIT ?", params: [Math.max(1, Math.floor(limit))] };
  };

  /**
   * Fallback used when FTS5 is unavailable (or a MATCH query fails to parse). This is a raw
   * substring scan over `searchable_text`, so it cannot stem: "deploy" matches "deploys"
   * only because "deploys" contains it, while "running" never matches "runs". Porter
   * stemming exists only on the FTS5 path.
   */
  const runLikeSearch = (query: string | undefined, scopes: readonly MemoryScope[], limit?: number): ContextObject[] => {
    const visible = visibleClause(scopes);
    const trimmed = query?.trim();
    const bounded = limitClause(limit);
    const rows = trimmed
      ? db.prepare(`SELECT m.* FROM memory m WHERE ${visible.sql} AND m.searchable_text LIKE ? ESCAPE '\\' ORDER BY m.observed_at DESC${bounded.sql}`)
          .all(...visible.params, `%${escapeLike(trimmed.toLowerCase())}%`, ...bounded.params) as Record<string, unknown>[]
      : db.prepare(`SELECT m.* FROM memory m WHERE ${visible.sql} ORDER BY m.observed_at DESC${bounded.sql}`)
          .all(...visible.params, ...bounded.params) as Record<string, unknown>[];
    return rows.map(toObject);
  };

  return {
    backend,
    upsert,
    updateSourceStats,
    find(id) {
      const row = db.prepare("SELECT * FROM memory WHERE id = ?").get(id) as Record<string, unknown> | undefined;
      return row ? toObject(row) : undefined;
    },
    search(input) {
      const query = input.query?.trim();
      if (!query) return runLikeSearch(undefined, input.scopes, input.limit);
      if (backend !== "sqlite-fts5") return runLikeSearch(query, input.scopes, input.limit);
      const visible = visibleClause(input.scopes);
      const bounded = limitClause(input.limit);
      try {
        const rows = db.prepare(`
          SELECT m.* FROM memory_fts f JOIN memory m ON m.rowid = f.rowid
          WHERE memory_fts MATCH ? AND ${visible.sql}
          ORDER BY rank, m.observed_at DESC${bounded.sql}
        `).all(memoryFtsQuery(query, input.match ?? "all"), ...visible.params, ...bounded.params) as Record<string, unknown>[];
        return rows.map(toObject);
      } catch {
        return runLikeSearch(query, input.scopes, input.limit);
      }
    },
    close() {
      db.close();
    },
  };
}

function readMetaString(db: SqliteDatabase, key: string): string | undefined {
  try {
    const row = db.prepare("SELECT value FROM memory_meta WHERE key = ?").get(key) as { value?: string } | undefined;
    return row?.value;
  } catch {
    return undefined; // Index predates memory_meta, or the file is not a readable memory index.
  }
}

function writeMetaString(db: SqliteDatabase, key: string, value: string): void {
  db.prepare("INSERT INTO memory_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

/** Removes the derived FTS table and its sync triggers together so `memory` writes never target a missing table. */
function dropMemoryFts(db: SqliteDatabase): void {
  try {
    db.exec(`
      DROP TRIGGER IF EXISTS memory_ai;
      DROP TRIGGER IF EXISTS memory_ad;
      DROP TRIGGER IF EXISTS memory_au;
      DROP TABLE IF EXISTS memory_fts;
    `);
  } catch {
    // A build without FTS5 cannot drop an fts5 table; the LIKE fallback still answers searches.
  }
}

async function indexStale(db: SqliteDatabase, stats: MemorySourceStats): Promise<boolean> {
  const size = db.prepare("SELECT value FROM memory_meta WHERE key = ?").get("source_size") as { value?: string } | undefined;
  const mtime = db.prepare("SELECT value FROM memory_meta WHERE key = ?").get("source_mtime_ms") as { value?: string } | undefined;
  return size?.value !== String(stats.size) || mtime?.value !== String(stats.mtimeMs);
}

function indexInitialized(db: SqliteDatabase): boolean {
  const size = db.prepare("SELECT value FROM memory_meta WHERE key = ?").get("source_size") as { value?: string } | undefined;
  const mtime = db.prepare("SELECT value FROM memory_meta WHERE key = ?").get("source_mtime_ms") as { value?: string } | undefined;
  return size?.value !== undefined && mtime?.value !== undefined;
}

async function memorySourceStats(cwd: string): Promise<MemorySourceStats> {
  const stats = await stat(memoryPath(cwd)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  return stats ? { size: stats.size, mtimeMs: stats.mtimeMs } : { size: 0, mtimeMs: 0 };
}

function inspectMemoryIndex(indexPath: string, size: number, mtimeMs: number, sourceStats: MemorySourceStats): MemoryStoreInspection["index"] {
  try {
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: new (path: string) => SqliteDatabase };
    const db = new DatabaseSync(indexPath);
    try {
      const sourceSize = readMetaNumber(db, "source_size");
      const sourceMtimeMs = readMetaNumber(db, "source_mtime_ms");
      const initialized = sourceSize !== undefined && sourceMtimeMs !== undefined;
      const fresh = initialized && sourceSize === sourceStats.size && sourceMtimeMs === sourceStats.mtimeMs;
      const fts = tableExists(db, "memory_fts");
      return {
        exists: true,
        readable: true,
        initialized,
        fresh,
        backend: fts ? "sqlite-fts5" : "sqlite-like",
        schema: readMetaString(db, MEMORY_INDEX_SCHEMA_KEY),
        size,
        mtimeMs,
        objectCount: tableExists(db, "memory") ? readCount(db, "memory") : 0,
        scopeRowCount: tableExists(db, "memory_scope") ? readCount(db, "memory_scope") : 0,
        sourceSize,
        sourceMtimeMs,
      };
    } finally {
      db.close();
    }
  } catch (error) {
    return {
      exists: true,
      readable: false,
      initialized: false,
      fresh: false,
      size,
      mtimeMs,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function readMetaNumber(db: SqliteDatabase, key: string): number | undefined {
  const raw = readMetaString(db, key);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function tableExists(db: SqliteDatabase, table: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'virtual table') AND name = ?").get(table) as { name?: string } | undefined;
  return row?.name === table;
}

function readCount(db: SqliteDatabase, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count?: number } | undefined;
  return Number(row?.count ?? 0);
}

function percentileValue(sorted: readonly number[], percentile: number): number {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * percentile) - 1));
  return sorted[index] ?? 0;
}

function parseJsonArray(raw: string): string[] {
  const value = JSON.parse(raw) as unknown;
  return Array.isArray(value) ? value.map(String) : [];
}

function parseJsonScopes(raw: string): MemoryScope[] {
  const value = JSON.parse(raw) as unknown;
  if (!Array.isArray(value)) return [];
  return normalizeScopes(value.flatMap((entry): MemoryScope[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const scope = entry as Record<string, unknown>;
    return typeof scope.kind === "string" && typeof scope.id === "string" ? [{ kind: scope.kind as MemoryScopeKind, id: scope.id }] : [];
  }));
}

function memoryFtsQuery(query: string, match: "all" | "any" = "all"): string {
  const terms = query.split(/[^\p{L}\p{N}_:-]+/u).filter(Boolean);
  return terms.map((term) => `"${term.replace(/"/g, "\"\"")}"`).join(match === "any" ? " OR " : " ") || '""';
}

function memoryTokens(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^\p{L}\p{N}_:-]+/u).filter((token) => token.length > 2));
}

function rankMemoryCandidates(query: string, candidates: readonly ContextObject[], minScore: number): MemoryReceipt[] {
  const queryTerms = memoryTokens(query);
  if (!queryTerms.size) {
    return candidates
      .filter((memory) => memory.redactionState !== "blocked")
      .map((memory) => ({ memory, score: recencyConfidenceScore(memory), matchedTerms: [], reason: "recent visible memory" }))
      .sort(compareReceipts);
  }
  return candidates
    .filter((memory) => memory.redactionState !== "blocked")
    .map((memory) => receiptForMemory(memory, queryTerms))
    .filter((receipt) => receipt.score >= minScore)
    .sort(compareReceipts);
}

function receiptForMemory(memory: ContextObject, queryTerms: ReadonlySet<string>): MemoryReceipt {
  const fields = [
    memory.kind,
    memory.summary,
    memory.sourceUri ?? "",
    memory.provenance.join(" "),
    memory.scopes.map(formatMemoryScope).join(" "),
  ];
  const candidateTerms = memoryTokens(fields.join(" "));
  const matchedTerms: string[] = [];
  for (const queryTerm of queryTerms) {
    for (const candidateTerm of candidateTerms) {
      if (candidateTerm === queryTerm || candidateTerm.startsWith(queryTerm) || queryTerm.startsWith(candidateTerm)) {
        matchedTerms.push(queryTerm);
        break;
      }
    }
  }
  const lexical = matchedTerms.length / queryTerms.size;
  const score = lexical + recencyConfidenceScore(memory);
  const reason = matchedTerms.length
    ? `matched ${matchedTerms.slice(0, 6).join(", ")}`
    : "recent visible fallback";
  return { memory, score, matchedTerms, reason };
}

function recencyConfidenceScore(memory: ContextObject): number {
  const ageMs = Math.max(0, Date.now() - Date.parse(memory.observedAt));
  const ageDays = Number.isFinite(ageMs) ? ageMs / 86_400_000 : 365;
  const recency = Math.max(0, 0.08 - Math.min(ageDays, 365) / 365 * 0.08);
  const confidence = Math.max(0, Math.min(1, memory.confidence)) * 0.12;
  return recency + confidence;
}

function compareReceipts(a: MemoryReceipt, b: MemoryReceipt): number {
  if (b.score !== a.score) return b.score - a.score;
  return b.memory.observedAt.localeCompare(a.memory.observedAt);
}

function escapeLike(value: string): string {
  // The escape character itself must be escaped first; otherwise a literal `\`
  // in the query consumes the next pattern character (querying `a\b` would
  // match "ab", and a trailing `\` would turn `%` into a literal-percent match).
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

/**
 * Every exported entry point funnels missing or wrong-typed fields through these guards so callers
 * see `<entryPoint> requires <field>: <expectation>` instead of a raw TypeError from deep inside SQLite.
 */
function requireInputObject<T>(input: T, entryPoint: string, shape: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(`${entryPoint} requires an input object: pass ${shape}, received ${describeValue(input)}.`);
  }
  return input as Record<string, unknown>;
}

function requiredString(value: unknown, entryPoint: string, field: string, expectation: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${entryPoint} requires ${field}: ${expectation}`);
  return value.trim();
}

function optionalString(value: unknown, entryPoint: string, field: string, expectation: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${entryPoint} requires ${field}: ${expectation}`);
  const trimmed = value.trim();
  return trimmed || undefined;
}

function optionalFiniteNumber(value: unknown, entryPoint: string, field: string, expectation: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${entryPoint} requires ${field}: ${expectation}`);
  return value;
}

function optionalBoolean(value: unknown, entryPoint: string, field: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new Error(`${entryPoint} requires ${field}: true or false when provided.`);
  return value;
}

function optionalMatchMode(value: unknown, entryPoint: string): "all" | "any" | undefined {
  if (value === undefined || value === null) return undefined;
  if (value !== "all" && value !== "any") throw new Error(`${entryPoint} requires match: "all" or "any" when provided.`);
  return value;
}

function stringList(value: unknown, entryPoint: string, field: string, expectation: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${entryPoint} requires ${field}: ${expectation}`);
  for (const item of value) {
    if (typeof item !== "string") throw new Error(`${entryPoint} requires ${field}: every entry must be a string, received ${describeValue(item)}.`);
  }
  return value.map((item) => (item as string).trim()).filter(Boolean);
}

function scopeArray(value: unknown, entryPoint: string, field: string): MemoryScope[] {
  if (!Array.isArray(value)) {
    throw new Error(`${entryPoint} requires ${field}: an array of memory scopes like { kind: "user", id: "dhairya" }, received ${describeValue(value)}.`);
  }
  return value as MemoryScope[];
}

function requiredScopes(value: unknown, entryPoint: string, field: string): MemoryScope[] {
  const scopes = normalizeScopes(scopeArray(value, entryPoint, field));
  if (!scopes.length) throw new Error(`${entryPoint} requires ${field}: at least one memory scope like { kind: "user", id: "dhairya" }.`);
  return scopes;
}

function optionalRedactionState(value: unknown, entryPoint: string): ContextObject["redactionState"] {
  if (value === undefined || value === null) return "none";
  if (value !== "none" && value !== "redacted" && value !== "hashed" && value !== "blocked") {
    throw new Error(`${entryPoint} requires redactionState: one of none, redacted, hashed, blocked.`);
  }
  return value;
}

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value;
}

interface ValidatedMemoryInput {
  readonly kind: string;
  readonly summary: string;
  readonly sourceUri?: string;
  readonly observedAt?: string;
  readonly confidence: number;
  readonly provenance: string[];
  readonly scopes: MemoryScope[];
  readonly redactionState: ContextObject["redactionState"];
  readonly links?: string[];
}

function validateMemoryInput(input: AddMemoryInput): ValidatedMemoryInput {
  const raw = requireInputObject(input, "addMemory", "{ summary, provenance, scopes }");
  const observedAt = optionalString(raw.observedAt, "addMemory", "observedAt", "an ISO timestamp string when provided.");
  if (observedAt !== undefined && Number.isNaN(Date.parse(observedAt))) {
    throw new Error("addMemory requires observedAt: a valid ISO timestamp.");
  }
  const confidence = optionalFiniteNumber(raw.confidence, "addMemory", "confidence", "a number between 0 and 1.") ?? 0.7;
  if (confidence < 0 || confidence > 1) throw new Error("addMemory requires confidence: a number between 0 and 1.");
  const provenance = stringList(raw.provenance, "addMemory", "provenance", "at least one non-empty source.");
  if (!provenance.length) throw new Error("addMemory requires provenance: at least one non-empty source.");
  const links = raw.links === undefined || raw.links === null
    ? undefined
    : stringList(raw.links, "addMemory", "links", "an array of memory ids when provided.");
  return {
    kind: optionalString(raw.kind, "addMemory", "kind", "a string when provided.") ?? "note",
    summary: requiredString(raw.summary, "addMemory", "summary", "a non-empty statement of the fact to remember."),
    sourceUri: optionalString(raw.sourceUri, "addMemory", "sourceUri", "a string when provided."),
    observedAt,
    confidence,
    provenance,
    scopes: requiredScopes(raw.scopes, "addMemory", "scopes"),
    redactionState: optionalRedactionState(raw.redactionState, "addMemory"),
    links,
  };
}

interface ValidatedSearchInput {
  readonly query: string;
  readonly scopes: MemoryScope[];
  readonly effectiveScopes: MemoryScope[];
  readonly includeGlobal: boolean;
  readonly limit?: number;
  readonly match?: "all" | "any";
}

function validateSearchInput(input: SearchMemoryInput, entryPoint: string): ValidatedSearchInput {
  const raw = requireInputObject(input, entryPoint, "{ scopes, query? }");
  const scopes = requiredScopes(raw.scopes, entryPoint, "scopes");
  const includeGlobal = optionalBoolean(raw.includeGlobal, entryPoint, "includeGlobal") ?? false;
  return {
    query: optionalString(raw.query, entryPoint, "query", "a string when provided.") ?? "",
    scopes,
    effectiveScopes: includeGlobal ? [...scopes, { kind: "global" as const, id: "global" }] : scopes,
    includeGlobal,
    limit: optionalFiniteNumber(raw.limit, entryPoint, "limit", "a finite number of results when provided."),
    match: optionalMatchMode(raw.match, entryPoint),
  };
}

interface ValidatedReceiptSearchInput extends ValidatedSearchInput {
  readonly limit: number;
  readonly candidateLimit: number;
  readonly minScore: number;
  readonly expandLinked: boolean;
  readonly graphNeighborLimit?: number;
}

function validateReceiptSearchInput(input: SearchMemoryReceiptInput, entryPoint: string): ValidatedReceiptSearchInput {
  const raw = requireInputObject(input, entryPoint, "{ scopes, query? }");
  const base = validateSearchInput(input, entryPoint);
  const limit = Math.max(1, Math.floor(base.limit ?? 5));
  const requestedCandidateLimit = optionalFiniteNumber(raw.candidateLimit, entryPoint, "candidateLimit", "a finite number of candidates when provided.");
  return {
    ...base,
    limit,
    candidateLimit: Math.max(limit, Math.floor(requestedCandidateLimit ?? Math.max(limit * 20, 50))),
    minScore: optionalFiniteNumber(raw.minScore, entryPoint, "minScore", "a finite score threshold when provided.") ?? 0.15,
    expandLinked: optionalBoolean(raw.expandLinked, entryPoint, "expandLinked") ?? false,
    graphNeighborLimit: optionalFiniteNumber(raw.graphNeighborLimit, entryPoint, "graphNeighborLimit", "a finite neighbor budget when provided."),
  };
}

function normalizeScopes(scopes: readonly MemoryScope[]): MemoryScope[] {
  if (!Array.isArray(scopes)) throw new Error(`Memory scopes must be an array of { kind, id } entries, received ${describeValue(scopes)}.`);
  const seen = new Set<string>();
  const result: MemoryScope[] = [];
  for (const scope of scopes) {
    if (!isScopeObject(scope)) throw new Error(`Invalid memory scope entry: expected { kind, id } strings, received ${describeValue(scope)}.`);
    if (!isScopeKind(scope.kind)) throw new Error(`Invalid memory scope kind: ${scope.kind}`);
    const normalized: MemoryScope = { kind: scope.kind, id: normalizeScopeId(scope.kind, scope.id) };
    const key = formatMemoryScope(normalized);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(normalized);
    }
  }
  return result;
}

/** Inspection must report on malformed rows rather than throw, so bad scope payloads count as zero-scope. */
function safeNormalizeScopes(scopes: unknown): MemoryScope[] {
  try {
    return normalizeScopes(scopes as readonly MemoryScope[]);
  } catch {
    return [];
  }
}

function isScopeObject(value: unknown): value is MemoryScope {
  if (typeof value !== "object" || value === null) return false;
  const scope = value as { kind?: unknown; id?: unknown };
  return typeof scope.kind === "string" && typeof scope.id === "string";
}

function normalizeScopeId(kind: MemoryScopeKind, id: string): string {
  const trimmed = id.trim();
  if (!trimmed) throw new Error(`Memory scope ${kind} requires an id.`);
  return kind === "global" ? "global" : trimmed;
}

function sameScope(left: MemoryScope, right: MemoryScope): boolean {
  return left.kind === right.kind && left.id === right.id;
}

function searchableText(object: ContextObject): string {
  return [object.kind, object.summary, object.sourceUri, object.provenance.join(" "), object.scopes.map(formatMemoryScope).join(" ")]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function isScopeKind(value: string): value is MemoryScopeKind {
  return (
    value === "global" ||
    value === "tenant" ||
    value === "workspace" ||
    value === "user" ||
    value === "pairing" ||
    value === "session" ||
    value === "role" ||
    value === "persona"
  );
}

async function readJsonLines<T>(path: string): Promise<T[]> {
  const raw = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  const values: T[] = [];
  for (const [index, line] of raw.split("\n").entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      values.push(JSON.parse(trimmed) as T);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid JSONL in ${path} at line ${index + 1}: ${detail}`);
    }
  }
  return values;
}
