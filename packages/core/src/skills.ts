import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pluginBundleSkillRoots } from "./plugin-bundles.js";
import { musterRoot } from "./profiles.js";
import { readJsonFile } from "./store.js";
import { estimateTokens } from "./tokens.js";
import type { MusterConfig } from "./types.js";

type SkillUsage = Record<string, { uses: number; lastUsedAt: string }>;
import type { EvolveReport } from "./evolve.js";

/**
 * Eval-gated skill loop. The substrate is Hermes's proven design (SKILL.md
 * files, agentskills.io frontmatter, telemetry sidecar, curator GC, top-K
 * injection); the two structural fixes are Muster's:
 *  1. skills are born as CANDIDATES in quarantine and become active ONLY
 *     through a converged evolve report (upstream #25833: no correctness
 *     mechanism — the agent was author, executor, and inspector of itself);
 *  2. injection is top-K under a hard token budget with dropped skills
 *     reported, never inject-all (upstream #22620: 10-15K tokens per call).
 */

export type SkillStatus = "candidate" | "active" | "stale" | "archived";

export interface SkillFrontmatter {
  readonly userInvocable?: boolean;
  readonly disableModelInvocation?: boolean;
  readonly commandDispatch?: "prompt" | "tool";
  readonly commandTool?: string;
  readonly commandArgMode?: "raw" | "json";
  readonly homepage?: string;
}

export interface OpenClawSkillMetadata {
  readonly requires?: {
    readonly bins?: readonly string[];
    readonly anyBins?: readonly string[];
    readonly env?: readonly string[];
    readonly config?: readonly string[];
  };
  readonly primaryEnv?: string;
  readonly os?: readonly string[];
  readonly always?: boolean;
  readonly install?: unknown;
}

export interface SkillRecord {
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly tags: string[];
  readonly status: SkillStatus;
  readonly provenance: { readonly createdBy: "agent" | "user"; readonly sourceRunId?: string; readonly createdAt: string };
  readonly gate?: { readonly passedAt: string; readonly suiteTasks: number };
  readonly frontmatter: SkillFrontmatter;
  readonly openclaw?: OpenClawSkillMetadata;
  readonly body: string;
}

export interface SkillIndexEntry {
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly status: SkillStatus;
  readonly digest: string;
  readonly frontmatter: SkillFrontmatter;
  readonly openclaw?: OpenClawSkillMetadata;
  readonly provenance: SkillRecord["provenance"];
  readonly gate?: SkillRecord["gate"];
}

export interface SkillIndex {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly skills: Record<string, SkillIndexEntry>;
}

export interface AppliedSkillEnv {
  readonly applied: readonly string[];
  restore(): void;
}

export interface SkillDiscoveryOptions {
  readonly extraDirs?: readonly string[];
  readonly includeHomeDirs?: boolean;
  /** How long a coherent catalog snapshot may be reused without filesystem I/O. */
  readonly snapshotTtlMs?: number;
}

interface SkillSearchRoot {
  readonly path: string;
  readonly indexed: boolean;
  readonly candidates: boolean;
}

interface SkillFileCandidate {
  readonly root: SkillSearchRoot;
  readonly path: string;
}

interface SkillCatalogSnapshot {
  readonly generation: number;
  readonly expiresAtMs: number;
  readonly skills: readonly SkillRecord[];
}

interface SkillCatalogRefresh {
  readonly generation: number;
  readonly promise: Promise<SkillCatalogSnapshot>;
}

interface MutableSkillCatalogMetrics {
  cacheHits: number;
  refreshes: number;
  recursiveWalks: number;
  directoryReads: number;
  fileReads: number;
  hashOperations: number;
}

export interface SkillCatalogSnapshotMetrics extends Readonly<MutableSkillCatalogMetrics> {
  readonly generation: number;
  readonly cachedSkills: number;
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const DEFAULT_SKILL_CATALOG_SNAPSHOT_TTL_MS = 30_000;
const MAX_SKILL_CATALOG_SNAPSHOT_TTL_MS = 300_000;
const skillCatalogCache = new Map<string, SkillCatalogSnapshot>();
const skillCatalogRefreshes = new Map<string, SkillCatalogRefresh>();
const skillCatalogMetrics = new Map<string, MutableSkillCatalogMetrics>();
let skillCatalogGeneration = 0;

export function skillsDir(cwd = process.cwd()): string {
  return join(musterRoot(cwd), "skills");
}

export function skillsIndexPath(cwd = process.cwd()): string {
  return join(skillsDir(cwd), ".index.json");
}

function skillPath(name: string, status: SkillStatus, cwd: string): string {
  return join(skillsDir(cwd), status === "candidate" ? ".candidates" : ".", name, "SKILL.md");
}

function serialize(skill: SkillRecord): string {
  const frontmatterLines = serializeSkillFrontmatter(skill.frontmatter);
  const meta = {
    version: skill.version,
    tags: skill.tags,
    status: skill.status,
    provenance: skill.provenance,
    ...(skill.gate ? { gate: skill.gate } : {}),
  };
  const openclaw = skill.openclaw ? `  openclaw: ${JSON.stringify(skill.openclaw)}\n` : "";
  return `---\nname: ${skill.name}\ndescription: ${skill.description}\n${frontmatterLines}metadata:\n  muster: ${JSON.stringify(meta)}\n${openclaw}---\n\n${skill.body}\n`;
}

function parse(raw: string): SkillRecord {
  // Skills written elsewhere (Claude Code, Codex plugins) may skip the blank line after the frontmatter.
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n(?:\r?\n)?([\s\S]*)$/);
  if (!match) throw new Error("Malformed SKILL.md");
  const frontmatter = parseFrontmatter(match[1]);
  const meta = frontmatter.metadata.muster ?? {};
  return {
    name: frontmatter.name,
    description: frontmatter.description,
    version: meta.version ?? "0.1.0",
    tags: meta.tags ?? [],
    status: meta.status ?? "active",
    provenance: meta.provenance ?? { createdBy: "user", createdAt: new Date().toISOString() },
    gate: meta.gate,
    frontmatter: frontmatter.skill,
    openclaw: frontmatter.metadata.openclaw,
    body: match[2],
  };
}

function serializeSkillFrontmatter(frontmatter: SkillFrontmatter): string {
  const lines: string[] = [];
  if (frontmatter.userInvocable !== undefined) lines.push(`user-invocable: ${frontmatter.userInvocable}`);
  if (frontmatter.disableModelInvocation !== undefined) lines.push(`disable-model-invocation: ${frontmatter.disableModelInvocation}`);
  if (frontmatter.commandDispatch) lines.push(`command-dispatch: ${frontmatter.commandDispatch}`);
  if (frontmatter.commandTool) lines.push(`command-tool: ${frontmatter.commandTool}`);
  if (frontmatter.commandArgMode) lines.push(`command-arg-mode: ${frontmatter.commandArgMode}`);
  if (frontmatter.homepage) lines.push(`homepage: ${frontmatter.homepage}`);
  return lines.length ? `${lines.join("\n")}\n` : "";
}

function parseFrontmatter(raw: string): {
  name: string;
  description: string;
  skill: SkillFrontmatter;
  metadata: { muster?: Record<string, any>; openclaw?: OpenClawSkillMetadata };
} {
  const result: {
    name?: string;
    description?: string;
    skill: SkillFrontmatter;
    metadata: { muster?: Record<string, any>; openclaw?: OpenClawSkillMetadata };
  } = { skill: {}, metadata: {} };
  let inMetadata = false;
  for (const line of raw.split("\n")) {
    if (line === "metadata:") {
      inMetadata = true;
      continue;
    }
    if (inMetadata && line.startsWith("  ")) {
      const parsed = parseKeyValue(line.slice(2));
      if (!parsed) continue;
      if (parsed.key === "muster") result.metadata.muster = parseJsonMetadata(parsed.value, "metadata.muster");
      if (parsed.key === "openclaw") result.metadata.openclaw = parseJsonMetadata(parsed.value, "metadata.openclaw") as OpenClawSkillMetadata;
      continue;
    }
    inMetadata = false;
    const parsed = parseKeyValue(line);
    if (!parsed) continue;
    if (parsed.key === "name") result.name = unquote(parsed.value.trim());
    if (parsed.key === "description") result.description = unquote(parsed.value.trim());
    if (parsed.key === "user-invocable") result.skill = { ...result.skill, userInvocable: parseBoolean(parsed.value) };
    if (parsed.key === "disable-model-invocation") result.skill = { ...result.skill, disableModelInvocation: parseBoolean(parsed.value) };
    if (parsed.key === "command-dispatch" && (parsed.value === "prompt" || parsed.value === "tool")) result.skill = { ...result.skill, commandDispatch: parsed.value };
    if (parsed.key === "command-tool") result.skill = { ...result.skill, commandTool: parsed.value.trim() };
    if (parsed.key === "command-arg-mode" && (parsed.value === "raw" || parsed.value === "json")) result.skill = { ...result.skill, commandArgMode: parsed.value };
    if (parsed.key === "homepage") result.skill = { ...result.skill, homepage: parsed.value.trim() };
  }
  if (!result.name || !result.description) throw new Error("Malformed SKILL.md");
  return {
    name: result.name,
    description: result.description,
    skill: result.skill,
    metadata: { muster: result.metadata.muster, openclaw: normalizeOpenClawMetadata(result.metadata.openclaw) },
  };
}

function unquote(value: string): string {
  return value.replace(/^(["'])(.*)\1$/, "$2");
}

function parseKeyValue(line: string): { key: string; value: string } | undefined {
  const index = line.indexOf(":");
  if (index === -1) return undefined;
  return { key: line.slice(0, index).trim(), value: line.slice(index + 1).trim() };
}

function parseBoolean(value: string): boolean {
  return value === "true";
}

function parseJsonMetadata(value: string, label: string): Record<string, unknown> {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Malformed ${label}: ${detail}`);
  }
}

function normalizeOpenClawMetadata(value: OpenClawSkillMetadata | undefined): OpenClawSkillMetadata | undefined {
  if (!value || typeof value !== "object") return undefined;
  const requires = typeof value.requires === "object" && value.requires !== null ? value.requires : undefined;
  return {
    requires: requires
      ? {
          bins: Array.isArray(requires.bins) ? requires.bins.filter(isString) : undefined,
          anyBins: Array.isArray(requires.anyBins) ? requires.anyBins.filter(isString) : undefined,
          env: Array.isArray(requires.env) ? requires.env.filter(isString) : undefined,
          config: Array.isArray(requires.config) ? requires.config.filter(isString) : undefined,
        }
      : undefined,
    primaryEnv: isString(value.primaryEnv) ? value.primaryEnv : undefined,
    os: Array.isArray(value.os) ? value.os.filter(isString) : undefined,
    always: typeof value.always === "boolean" ? value.always : undefined,
    install: value.install,
  };
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function skillDigest(raw: string): string {
  return `sha256:${createHash("sha256").update(raw).digest("hex")}`;
}

function skillIndexEntry(skill: SkillRecord, raw: string): SkillIndexEntry {
  return {
    name: skill.name,
    description: skill.description,
    version: skill.version,
    status: skill.status,
    digest: skillDigest(raw),
    frontmatter: skill.frontmatter,
    openclaw: skill.openclaw,
    provenance: skill.provenance,
    gate: skill.gate,
  };
}

async function upsertSkillIndex(skill: SkillRecord, raw: string, cwd: string): Promise<void> {
  const path = skillsIndexPath(cwd);
  const current = await readJsonFile<SkillIndex>(
    path,
    { schemaVersion: 1, generatedAt: new Date(0).toISOString(), skills: {} },
  );
  if (current.schemaVersion !== 1 || typeof current.skills !== "object" || current.skills === null) {
    throw new Error(`Corrupt skill index in ${path}: expected schemaVersion=1 with a skills object.`);
  }
  const next: SkillIndex = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    skills: {
      ...current.skills,
      [skill.name]: skillIndexEntry(skill, raw),
    },
  };
  await mkdir(skillsDir(cwd), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`);
  await rename(temp, path);
}

function verifySkillIndexEntry(
  index: SkillIndex | undefined,
  skill: SkillRecord,
  raw: string,
  path: string,
  metrics?: MutableSkillCatalogMetrics,
): void {
  const entry = index?.skills?.[skill.name];
  if (!entry) {
    if (index && skill.status === "active") {
      throw skillTrustError(`Skill index missing active skill "${skill.name}" at ${path}.`);
    }
    return;
  }
  if (entry.status !== skill.status) {
    throw skillTrustError(`Skill index status mismatch for "${skill.name}" at ${path}: index=${entry.status}, file=${skill.status}.`);
  }
  if (metrics) metrics.hashOperations += 1;
  const actual = skillDigest(raw);
  if (entry.digest !== actual) {
    throw skillTrustError(`Skill digest mismatch for "${skill.name}" at ${path}: expected ${entry.digest}, got ${actual}.`);
  }
}

function skillTrustError(message: string): Error {
  const error = new Error(message);
  error.name = "SkillTrustError";
  return error;
}

function isSkillTrustError(error: unknown): boolean {
  return error instanceof Error && error.name === "SkillTrustError";
}

async function writeSkill(skill: SkillRecord, cwd: string): Promise<string> {
  const path = skillPath(skill.name, skill.status, cwd);
  await mkdir(join(path, ".."), { recursive: true });
  const raw = serialize(skill);
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, raw);
  await rename(temp, path);
  await upsertSkillIndex(skill, raw, cwd);
  clearSkillCatalogSnapshots();
  return path;
}

export async function writeCandidateSkill(
  input: {
    name: string;
    description: string;
    body: string;
    tags?: string[];
    createdBy?: "agent" | "user";
    sourceRunId?: string;
    frontmatter?: SkillFrontmatter;
    openclaw?: OpenClawSkillMetadata;
  },
  cwd = process.cwd(),
): Promise<SkillRecord> {
  if (!NAME_PATTERN.test(input.name)) throw new Error(`Invalid skill name "${input.name}" (lowercase, digits, ._- only).`);
  if (input.body.length > 100_000) throw new Error("SKILL.md body exceeds 100K chars.");
  const skill: SkillRecord = {
    name: input.name,
    description: input.description.trim(),
    version: "0.1.0",
    tags: input.tags ?? [],
    status: "candidate",
    provenance: { createdBy: input.createdBy ?? "agent", sourceRunId: input.sourceRunId, createdAt: new Date().toISOString() },
    frontmatter: input.frontmatter ?? {},
    openclaw: input.openclaw,
    body: input.body,
  };
  await writeSkill(skill, cwd);
  return skill;
}

export async function writeBundledSkill(
  input: {
    name: string;
    description: string;
    body: string;
    tags?: string[];
    frontmatter?: SkillFrontmatter;
    openclaw?: OpenClawSkillMetadata;
    /** The run that brought this skill in (a migration run id, for example). */
    sourceRunId?: string;
  },
  cwd = process.cwd(),
): Promise<SkillRecord> {
  if (!NAME_PATTERN.test(input.name)) throw new Error(`Invalid skill name "${input.name}" (lowercase, digits, ._- only).`);
  if (input.body.length > 100_000) throw new Error("SKILL.md body exceeds 100K chars.");
  const skill: SkillRecord = {
    name: input.name,
    description: input.description.trim(),
    version: "0.1.0",
    tags: input.tags ?? [],
    status: "active",
    provenance: { createdBy: "user", ...(input.sourceRunId ? { sourceRunId: input.sourceRunId } : {}), createdAt: new Date().toISOString() },
    frontmatter: input.frontmatter ?? {},
    openclaw: input.openclaw,
    body: input.body,
  };
  await writeSkill(skill, cwd);
  return skill;
}

/**
 * Delete an active skill's directory and its index entry. Used by
 * `muster migrate undo`; returns false when there was nothing to remove.
 */
export async function removeSkill(name: string, cwd = process.cwd()): Promise<boolean> {
  if (!NAME_PATTERN.test(name)) throw new Error(`Invalid skill name "${name}" (lowercase, digits, ._- only).`);
  const dir = join(skillsDir(cwd), name);
  const existed = existsSync(dir);
  await rm(dir, { recursive: true, force: true });
  const path = skillsIndexPath(cwd);
  const current = await readJsonFile<SkillIndex | undefined>(path, undefined);
  if (current?.skills?.[name]) {
    const skills = { ...current.skills };
    delete skills[name];
    const temp = `${path}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify({ ...current, generatedAt: new Date().toISOString(), skills }, null, 2)}\n`);
    await rename(temp, path);
  }
  clearSkillCatalogSnapshots();
  return existed;
}

export async function archiveSkill(name: string, cwd = process.cwd()): Promise<SkillRecord> {
  const skill = await viewSkill(name, cwd);
  const archived: SkillRecord = { ...skill, status: "archived" };
  await writeSkill(archived, cwd);
  return archived;
}

export function skillDiscoveryRoots(cwd = process.cwd(), options: SkillDiscoveryOptions = {}): readonly string[] {
  return buildSkillSearchRoots(cwd, options).map((root) => root.path);
}

function buildSkillSearchRoots(cwd: string, options: SkillDiscoveryOptions): SkillSearchRoot[] {
  const roots: SkillSearchRoot[] = [
    { path: skillsDir(cwd), indexed: true, candidates: false },
    { path: join(skillsDir(cwd), ".candidates"), indexed: true, candidates: true },
    { path: join(cwd, "skills"), indexed: false, candidates: false },
    { path: join(cwd, ".agents", "skills"), indexed: false, candidates: false },
  ];
  if (options.includeHomeDirs) {
    roots.push(
      { path: join(homedir(), ".agents", "skills"), indexed: false, candidates: false },
      { path: join(homedir(), ".openclaw", "skills"), indexed: false, candidates: false },
    );
  }
  // Installed plugin bundles are discovered in place (see plugin-bundles.ts).
  for (const dir of pluginBundleSkillRoots(cwd)) {
    roots.push({ path: dir, indexed: false, candidates: false });
  }
  for (const dir of options.extraDirs ?? []) {
    roots.push({ path: expandHome(dir, cwd), indexed: false, candidates: false });
  }
  const seen = new Set<string>();
  return roots
    .map((root) => ({ ...root, path: resolve(root.path) }))
    .filter((root) => {
      if (seen.has(root.path)) return false;
      seen.add(root.path);
      return true;
    });
}

function expandHome(path: string, cwd: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return isAbsolute(path) ? path : join(cwd, path);
}

async function findSkillFiles(root: string, metrics: MutableSkillCatalogMetrics): Promise<string[]> {
  const found: string[] = [];
  metrics.recursiveWalks += 1;
  const visit = async (dir: string): Promise<void> => {
    let entries: { name: string; isDirectory(): boolean; isFile(): boolean }[] = [];
    try {
      metrics.directoryReads += 1;
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".candidates") continue;
      const path = join(dir, entry.name);
      if (entry.isFile() && entry.name === "SKILL.md") {
        found.push(path);
        continue;
      }
      if (entry.isDirectory()) await visit(path);
    }
  };
  await visit(root);
  return found.sort();
}

function normalizeSkillCatalogSnapshotTtl(ttlMs: number | undefined): number {
  if (ttlMs === undefined || !Number.isFinite(ttlMs)) return DEFAULT_SKILL_CATALOG_SNAPSHOT_TTL_MS;
  return Math.min(MAX_SKILL_CATALOG_SNAPSHOT_TTL_MS, Math.max(0, Math.floor(ttlMs)));
}

function skillCatalogCacheKey(cwd: string, roots: readonly SkillSearchRoot[], ttlMs: number): string {
  return JSON.stringify({
    cwd: resolve(cwd),
    roots: roots.map((root) => ({ path: root.path, indexed: root.indexed, candidates: root.candidates })),
    ttlMs,
  });
}

export function clearSkillCatalogSnapshots(): void {
  skillCatalogGeneration += 1;
  skillCatalogCache.clear();
  skillCatalogRefreshes.clear();
  skillCatalogMetrics.clear();
}

/** Read-only diagnostics used by performance tests and runtime observability. */
export function getSkillCatalogSnapshotMetrics(
  cwd = process.cwd(),
  discovery: SkillDiscoveryOptions = {},
): SkillCatalogSnapshotMetrics {
  const roots = buildSkillSearchRoots(cwd, discovery);
  const ttlMs = normalizeSkillCatalogSnapshotTtl(discovery.snapshotTtlMs);
  const cacheKey = skillCatalogCacheKey(cwd, roots, ttlMs);
  const metrics = skillCatalogMetrics.get(cacheKey) ?? createSkillCatalogMetrics();
  return {
    generation: skillCatalogGeneration,
    cachedSkills: skillCatalogCache.get(cacheKey)?.skills.length ?? 0,
    ...metrics,
  };
}

export async function listSkills(cwd = process.cwd(), statuses?: SkillStatus[], discovery: SkillDiscoveryOptions = {}): Promise<SkillRecord[]> {
  const roots = buildSkillSearchRoots(cwd, discovery);
  const ttlMs = normalizeSkillCatalogSnapshotTtl(discovery.snapshotTtlMs);
  const cacheKey = skillCatalogCacheKey(cwd, roots, ttlMs);
  const metrics = getOrCreateSkillCatalogMetrics(cacheKey);
  let catalog: readonly SkillRecord[];

  while (true) {
    const generation = skillCatalogGeneration;
    const cached = skillCatalogCache.get(cacheKey);
    if (cached?.generation === generation && performance.now() < cached.expiresAtMs) {
      metrics.cacheHits += 1;
      catalog = cached.skills;
      break;
    }

    let refresh = skillCatalogRefreshes.get(cacheKey);
    if (!refresh || refresh.generation !== generation) {
      const promise = refreshSkillCatalog(cwd, roots, ttlMs, generation, metrics);
      refresh = { generation, promise };
      skillCatalogRefreshes.set(cacheKey, refresh);
      void promise.finally(() => {
        if (skillCatalogRefreshes.get(cacheKey)?.promise === promise) skillCatalogRefreshes.delete(cacheKey);
      }).catch(() => undefined);
    }

    const snapshot = await refresh.promise;
    if (snapshot.generation !== skillCatalogGeneration) continue;
    skillCatalogCache.set(cacheKey, snapshot);
    catalog = snapshot.skills;
    break;
  }

  return statuses ? catalog.filter((skill) => statuses.includes(skill.status)) : [...catalog];
}

function createSkillCatalogMetrics(): MutableSkillCatalogMetrics {
  return { cacheHits: 0, refreshes: 0, recursiveWalks: 0, directoryReads: 0, fileReads: 0, hashOperations: 0 };
}

function getOrCreateSkillCatalogMetrics(cacheKey: string): MutableSkillCatalogMetrics {
  const existing = skillCatalogMetrics.get(cacheKey);
  if (existing) return existing;
  const metrics = createSkillCatalogMetrics();
  skillCatalogMetrics.set(cacheKey, metrics);
  return metrics;
}

async function refreshSkillCatalog(
  cwd: string,
  roots: readonly SkillSearchRoot[],
  ttlMs: number,
  generation: number,
  metrics: MutableSkillCatalogMetrics,
): Promise<SkillCatalogSnapshot> {
  metrics.refreshes += 1;
  const candidates: SkillFileCandidate[] = [];
  for (const root of roots) {
    for (const path of await findSkillFiles(root.path, metrics)) candidates.push({ root, path });
  }
  const skills = await loadSkillCatalog(cwd, candidates, metrics);
  return {
    generation,
    expiresAtMs: performance.now() + ttlMs,
    skills,
  };
}

async function loadSkillCatalog(
  cwd: string,
  candidates: readonly SkillFileCandidate[],
  metrics: MutableSkillCatalogMetrics,
): Promise<readonly SkillRecord[]> {
  const skills: SkillRecord[] = [];
  const seen = new Set<string>();
  const index = await readJsonFile<SkillIndex | undefined>(skillsIndexPath(cwd), undefined);
  for (const candidate of candidates) {
      try {
        metrics.fileReads += 1;
        const raw = await readFile(candidate.path, "utf8");
        const skill = parse(raw);
        if (candidate.root.candidates && skill.status !== "candidate") continue;
        if (!candidate.root.candidates && skill.status === "candidate") continue;
        if (candidate.root.indexed) {
          verifySkillIndexEntry(index, skill, raw, candidate.path, metrics);
        }
        if (seen.has(skill.name)) continue;
        seen.add(skill.name);
        skills.push(skill);
      } catch (error) {
        // unreadable/malformed skill folders are skipped, but trust failures
        // must stay loud so tampered active skills cannot silently disappear.
        if (isSkillTrustError(error)) throw error;
      }
  }
  return skills;
}

export async function viewSkill(name: string, cwd = process.cwd()): Promise<SkillRecord> {
  const all = await listSkills(cwd);
  const skill = all.find((entry) => entry.name === name);
  if (!skill) throw new Error(`Skill not found: ${name}`);
  return skill;
}

/**
 * THE GATE: a candidate becomes active only with a converged evolve report.
 * No report, no convergence, no promotion — closing upstream #25833.
 */
export async function promoteSkill(name: string, evalReport: EvolveReport, cwd = process.cwd()): Promise<SkillRecord> {
  const skill = await viewSkill(name, cwd);
  if (skill.status !== "candidate") throw new Error(`Only candidates can be promoted; "${name}" is ${skill.status}.`);
  if (!evalReport.converged) {
    throw new Error(`Promotion refused: eval suite did not converge. Fix the skill and re-run the suite.`);
  }
  const suiteTasks = evalReport.iterations[0]?.results.length ?? 0;
  if (suiteTasks === 0) throw new Error("Promotion refused: eval report contains no tasks — an empty suite is not evidence.");
  const promoted: SkillRecord = {
    ...skill,
    status: "active",
    gate: { passedAt: new Date().toISOString(), suiteTasks },
  };
  await writeSkill(promoted, cwd);
  const { rm } = await import("node:fs/promises");
  await rm(join(skillsDir(cwd), ".candidates", name), { recursive: true, force: true });
  clearSkillCatalogSnapshots();
  return promoted;
}

export interface SkillSelection {
  readonly block: string;
  readonly included: string[];
  readonly dropped: string[];
  /** `name@version` for each injected skill — stamped into the token ledger so cost is attributable to a skill version (#11692 receipts). */
  readonly includedReceipts: string[];
}

export interface ClaudeSkillSnapshot {
  readonly pluginDir: string;
  readonly skillNames: readonly string[];
  readonly skillReceipts: readonly string[];
  cleanup(): Promise<void>;
}

export interface SkillAvailabilityOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly config?: Readonly<Record<string, unknown>>;
  readonly os?: NodeJS.Platform | string;
  readonly binExists?: (name: string) => boolean;
  readonly skillAllowlist?: readonly string[];
  readonly discovery?: SkillDiscoveryOptions;
}

export type SkillCommandResolution =
  | {
      readonly dispatch: "prompt";
      readonly skillName: string;
      readonly commandName: string;
      readonly args: string;
      readonly prompt: string;
    }
  | {
      readonly dispatch: "tool";
      readonly skillName: string;
      readonly commandName: string;
      readonly tool: string;
      readonly args: Record<string, unknown>;
    };

/** Top-K budgeted injection — never inject-all, never silently drop. */
export async function selectSkills(task: string, budgetTokens = 500, cwd = process.cwd(), availability: SkillAvailabilityOptions = {}): Promise<SkillSelection> {
  const active = (await listSkills(cwd, ["active"], availability.discovery))
    .filter((skill) => isSkillAllowed(skill, availability.skillAllowlist))
    .filter((skill) => isSkillAvailableForModel(skill, availability));
  if (!active.length) return { block: "", included: [], dropped: [], includedReceipts: [] };
  const stopwords = new Set([
    "about", "after", "again", "also", "answer", "could", "exactly", "from", "give", "have", "into",
    "just", "like", "make", "need", "please", "reply", "show", "that", "the", "this", "what", "when",
    "where", "which", "with", "work", "would", "your",
  ]);
  const taskTokens = new Set(task.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 2 && !stopwords.has(token)));
  const scored = active
    .map((skill) => {
      const haystack = `${skill.name} ${skill.description} ${skill.tags.join(" ")}`.toLowerCase();
      let score = 0;
      for (const token of taskTokens) if (haystack.includes(token)) score += 1;
      return { skill, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  const included: string[] = [];
  const includedReceipts: string[] = [];
  const lines: string[] = [];
  let used = estimateTokens("Available skills (read with skill_view before relying on one):");
  for (const { skill } of scored) {
    const line = `- [skill:${skill.name}] ${skill.description}`;
    const cost = estimateTokens(line);
    if (used + cost > budgetTokens) break;
    used += cost;
    lines.push(line);
    included.push(skill.name);
    includedReceipts.push(`${skill.name}@${skill.version}`);
  }
  const dropped = scored.map((entry) => entry.skill.name).filter((name) => !included.includes(name));
  return {
    block: lines.length ? `Available skills (read with skill_view before relying on one):\n${lines.join("\n")}` : "",
    included,
    dropped,
    includedReceipts,
  };
}

/**
 * Export active eligible skills as a temporary Claude Code plugin.
 *
 * This lets Claude's own skill loader do progressive disclosure via
 * `--plugin-dir` instead of duplicating a skill catalog in the system prompt.
 * The snapshot is per-run and removed after the attempt, so stale plugin-cache
 * duplication cannot accumulate across runs.
 */
export async function exportClaudeSkillSnapshot(cwd = process.cwd(), availability: SkillAvailabilityOptions = {}): Promise<ClaudeSkillSnapshot | undefined> {
  const active = (await listSkills(cwd, ["active"], availability.discovery))
    .filter((skill) => isSkillAllowed(skill, availability.skillAllowlist))
    .filter((skill) => isSkillAvailableForModel(skill, availability));
  if (!active.length) return undefined;

  const pluginDir = await mkdtemp(join(tmpdir(), "muster-claude-skills-"));
  await mkdir(join(pluginDir, ".claude-plugin"), { recursive: true });
  await mkdir(join(pluginDir, "skills"), { recursive: true });
  await writeFile(
    join(pluginDir, ".claude-plugin", "plugin.json"),
    `${JSON.stringify({
      name: "muster-skill-snapshot",
      description: "Temporary per-run Muster skill snapshot.",
      version: "0.0.0",
    }, null, 2)}\n`,
    "utf8",
  );

  for (const skill of active) {
    const dir = join(pluginDir, "skills", skill.name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), serialize(skill), "utf8");
  }

  return {
    pluginDir,
    skillNames: active.map((skill) => skill.name),
    skillReceipts: active.map((skill) => `${skill.name}@${skill.version}`),
    cleanup: async () => {
      await rm(pluginDir, { recursive: true, force: true });
    },
  };
}

export function resolveAgentSkillAllowlist(
  config: Pick<MusterConfig, "agents">,
  agentId?: string,
): readonly string[] | undefined {
  const defaults = normalizeSkillAllowlist(config.agents?.defaults?.skills);
  if (!agentId) return defaults;
  const agent = config.agents?.list?.find((entry) => entry.id === agentId);
  if (!agent || agent.skills === undefined) return defaults;
  return normalizeSkillAllowlist(agent.skills) ?? [];
}

export async function applySkillEnvForRun(
  skillNames: readonly string[],
  config: Pick<MusterConfig, "skills">,
  cwd = process.cwd(),
  targetEnv: NodeJS.ProcessEnv = process.env,
  discovery: SkillDiscoveryOptions = {},
): Promise<AppliedSkillEnv> {
  const entries = config.skills?.entries;
  const uniqueNames = Array.from(new Set(skillNames));
  if (!entries || uniqueNames.length === 0) return { applied: [], restore: () => undefined };

  const skillByName = new Map((await listSkills(cwd, ["active"], discovery)).map((skill) => [skill.name, skill]));
  const saved = new Map<string, string | undefined>();
  const applied: string[] = [];

  const setIfUnset = (name: string, value: string | undefined): void => {
    if (value === undefined || targetEnv[name] !== undefined) return;
    if (!isValidEnvName(name)) throw new Error(`Invalid skill env var name: ${name}`);
    if (!saved.has(name)) saved.set(name, targetEnv[name]);
    targetEnv[name] = value;
    applied.push(name);
  };

  for (const skillName of uniqueNames) {
    const entry = entries[skillName];
    if (!entry || entry.enabled === false) continue;
    for (const [name, value] of Object.entries(entry.env ?? {})) {
      setIfUnset(name, String(value));
    }

    const primaryEnv = skillByName.get(skillName)?.openclaw?.primaryEnv;
    if (primaryEnv && entry.apiKey) {
      if (typeof entry.apiKey === "string") {
        setIfUnset(primaryEnv, entry.apiKey);
      } else if (entry.apiKey.source === "env") {
        setIfUnset(primaryEnv, targetEnv[entry.apiKey.id]);
      }
    }
  }

  return {
    applied,
    restore: () => {
      for (const [name, value] of Array.from(saved.entries()).reverse()) {
        if (value === undefined) delete targetEnv[name];
        else targetEnv[name] = value;
      }
    },
  };
}

function isSkillAvailableForModel(skill: SkillRecord, availability: SkillAvailabilityOptions): boolean {
  if (skill.frontmatter.disableModelInvocation) return false;
  const openclaw = skill.openclaw;
  if (!openclaw) return true;
  if (openclaw.always) return true;

  const platform = availability.os ?? process.platform;
  if (openclaw.os?.length && !openclaw.os.includes(platform)) return false;

  const env = availability.env ?? process.env;
  const requires = openclaw.requires;
  if (requires?.env?.some((name) => !env[name])) return false;
  if (openclaw.primaryEnv && !env[openclaw.primaryEnv]) return false;

  const config = availability.config ?? {};
  if (requires?.config?.some((name) => config[name] === undefined || config[name] === null)) return false;

  const binExists = availability.binExists;
  if (requires?.bins?.length) {
    if (!binExists) return false;
    if (requires.bins.some((name) => !binExists(name))) return false;
  }
  if (requires?.anyBins?.length) {
    if (!binExists) return false;
    if (!requires.anyBins.some((name) => binExists(name))) return false;
  }
  return true;
}

function isValidEnvName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

export async function resolveSkillCommand(
  commandName: string,
  args: string,
  cwd = process.cwd(),
  availability: SkillAvailabilityOptions = {},
): Promise<SkillCommandResolution | undefined> {
  const normalized = commandName.toLowerCase();
  const skill = (await listSkills(cwd, ["active"], availability.discovery))
    .filter((candidate) => isSkillAllowed(candidate, availability.skillAllowlist))
    .filter((candidate) => candidate.name === normalized)
    .find((candidate) => candidate.frontmatter.userInvocable !== false && isSkillAvailableForCommand(candidate, availability));
  if (!skill) return undefined;

  const dispatch = skill.frontmatter.commandDispatch ?? "prompt";
  if (dispatch === "tool") {
    if (!skill.frontmatter.commandTool) {
      throw new Error(`Skill command "${skill.name}" declares command-dispatch=tool but has no command-tool.`);
    }
    return {
      dispatch: "tool",
      skillName: skill.name,
      commandName: normalized,
      tool: skill.frontmatter.commandTool,
      args: buildSkillCommandToolArgs(skill, normalized, args),
    };
  }

  return {
    dispatch: "prompt",
    skillName: skill.name,
    commandName: normalized,
    args,
    prompt: [
      `Run user-invocable skill "${skill.name}".`,
      args ? `Command arguments:\n${args}` : "Command arguments: (none)",
      "",
      `Skill description: ${skill.description}`,
      "Skill instructions:",
      skill.body,
    ].join("\n"),
  };
}

function isSkillAvailableForCommand(skill: SkillRecord, availability: SkillAvailabilityOptions): boolean {
  // Slash invocation is explicit user intent, so disable-model-invocation does
  // not block command resolution; it only blocks ambient model prompt injection.
  const copy: SkillRecord = { ...skill, frontmatter: { ...skill.frontmatter, disableModelInvocation: false } };
  return isSkillAvailableForModel(copy, availability);
}

function buildSkillCommandToolArgs(skill: SkillRecord, commandName: string, args: string): Record<string, unknown> {
  if (skill.frontmatter.commandArgMode === "json" && args.trim()) {
    const parsed = JSON.parse(args) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? { ...(parsed as Record<string, unknown>), commandName, skillName: skill.name }
      : { value: parsed, commandName, skillName: skill.name };
  }
  return { command: args, commandName, skillName: skill.name };
}

function normalizeSkillAllowlist(names: readonly string[] | undefined): readonly string[] | undefined {
  if (!names) return undefined;
  return Array.from(new Set(names.map((name) => name.trim().toLowerCase()).filter(Boolean))).sort();
}

function isSkillAllowed(skill: SkillRecord, allowlist: readonly string[] | undefined): boolean {
  return allowlist === undefined || allowlist.includes(skill.name);
}

/** Telemetry sidecar (never in frontmatter, mirroring upstream). */
export async function recordSkillUse(names: string[], cwd = process.cwd()): Promise<void> {
  if (!names.length) return;
  const path = join(skillsDir(cwd), ".usage.json");
  // Missing telemetry -> first use (start empty); corrupt telemetry -> throw so
  // we don't silently overwrite a damaged file and lose all prior usage counts.
  const usage = await readJsonFile<SkillUsage>(path, {});
  for (const name of names) {
    usage[name] = { uses: (usage[name]?.uses ?? 0) + 1, lastUsedAt: new Date().toISOString() };
  }
  await mkdir(skillsDir(cwd), { recursive: true });
  await writeFile(path, JSON.stringify(usage, null, 2));
}

/** Curator: stale/archive transitions only — skills are never deleted. */
export async function curateSkills(cwd = process.cwd(), now = new Date()): Promise<{ staled: string[]; archived: string[] }> {
  const path = join(skillsDir(cwd), ".usage.json");
  // Missing telemetry -> nothing recorded yet (fall back to provenance dates);
  // corrupt telemetry -> throw rather than mis-curating from a damaged file.
  const usage = await readJsonFile<SkillUsage>(path, {});
  const staled: string[] = [];
  const archived: string[] = [];
  for (const skill of await listSkills(cwd, ["active", "stale"])) {
    const lastUsed = usage[skill.name]?.lastUsedAt ?? skill.provenance.createdAt;
    const idleDays = (now.getTime() - new Date(lastUsed).getTime()) / 86_400_000;
    if (skill.status === "active" && idleDays > 30) {
      await writeSkill({ ...skill, status: "stale" }, cwd);
      staled.push(skill.name);
    } else if (skill.status === "stale" && idleDays > 90) {
      await writeSkill({ ...skill, status: "archived" }, cwd);
      archived.push(skill.name);
    }
  }
  return { staled, archived };
}
