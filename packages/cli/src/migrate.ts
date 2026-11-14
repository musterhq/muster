/**
 * `muster migrate <source>`: bring another agent setup on this machine into
 * Muster. Reads the source strictly read-only, shows a plan, applies only on
 * `--apply`, keeps every token as an env reference, writes a receipt per run,
 * and `muster migrate undo <run-id>` removes exactly what a run added.
 * Spec: docs/spec/clauses/26-migrate.md.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  addMemory,
  configPath,
  createAutomation,
  digestTree,
  ensureDefaultConfig,
  forgetMemories,
  importedRulesDir,
  listMemory,
  listSchedules,
  loadConfig,
  musterRoot,
  parseCron,
  removeSchedule,
  removeSkill,
  saveConfig,
  dataDir,
  schedulesPath,
  skillsDir,
  writeBundledSkill,
  type AutomationKind,
  type McpServerConfig,
} from "@musterhq/core";
import { gatewayConfigPath, initGatewayConfig, loadGatewayConfig, saveGatewayConfig, type GatewayConfig } from "@musterhq/gateway";
import {
  dotenvLine,
  envNameFor,
  envReferenceName,
  isSecretKey,
  looksLikeSecret,
  parseDotenv,
  parseRelaxedJson,
  parseSkillMarkdown,
  parseToml,
  parseYaml,
  redact,
  splitMemoryEntries,
} from "./migrate-formats.js";

export const MIGRATE_SOURCES = ["openclaw", "hermes", "claude", "codex"] as const;
export type MigrateSourceId = (typeof MIGRATE_SOURCES)[number];

export function isMigrateSource(value: string | undefined): value is MigrateSourceId {
  return (MIGRATE_SOURCES as readonly string[]).includes(value ?? "");
}

export type ItemKind = "memory" | "profile" | "skill" | "mcp" | "channel" | "schedule" | "rule";
export const GROUPS: ReadonlyArray<{ readonly kind: ItemKind; readonly title: string; readonly flag: string }> = [
  { kind: "memory", title: "Memory", flag: "memory" },
  { kind: "profile", title: "Profile", flag: "profile" },
  { kind: "skill", title: "Skills", flag: "skills" },
  { kind: "mcp", title: "MCP servers", flag: "mcp" },
  { kind: "channel", title: "Channels", flag: "channels" },
  { kind: "schedule", title: "Schedules", flag: "schedules" },
  { kind: "rule", title: "Rules", flag: "rules" },
];

/** Where a token was found and the env var that replaces it. Never the value. */
export interface SecretRef {
  readonly env: string;
  readonly from: string;
  /** False when the source names the credential but holds no value (nothing for --write-env). */
  readonly hasValue: boolean;
}

interface SkillPayload { readonly dir: string; readonly description: string; readonly body: string; readonly files: readonly string[] }
interface SchedulePayload { readonly cron?: string; readonly at?: string; readonly tz?: string; readonly text: string; readonly kind: AutomationKind }
interface ChannelPayload { readonly id: "telegram" | "discord"; readonly envName: string }

export interface ScannedItem {
  readonly kind: ItemKind;
  readonly name: string;
  readonly description?: string;
  /** Source location, relative to the source root. */
  readonly from: string;
  readonly secrets: readonly SecretRef[];
  readonly skipped?: string;
  readonly summary?: string;
  readonly skill?: SkillPayload;
  readonly mcp?: McpServerConfig;
  readonly channel?: ChannelPayload;
  readonly schedule?: SchedulePayload;
  readonly ruleText?: string;
}

export interface SourceScan {
  readonly source: MigrateSourceId;
  readonly root: string;
  /** Every directory/file the scan reads; Muster never writes inside them. */
  readonly roots: readonly string[];
  readonly exists: boolean;
  readonly items: ScannedItem[];
  /** env name → value, for --write-env only. Never printed or stored by Muster. */
  readonly secretValues: Map<string, string>;
}

export type PlanStatus = "new" | "already in Muster" | "conflict" | "skipped";

export interface PlanItem extends ScannedItem {
  readonly status: PlanStatus;
  /** Name it is written under (differs from `name` with --rename). */
  readonly target: string;
  readonly reason?: string;
}

export interface MigrationPlan {
  readonly source: MigrateSourceId;
  readonly root: string;
  readonly roots: readonly string[];
  readonly exists: boolean;
  readonly items: PlanItem[];
  readonly secretValues: Map<string, string>;
}

const MAX_MEMORY_ITEMS = 500;
const MAX_SKILL_FILES = 500;
const MAX_SKILL_BYTES = 25 * 1024 * 1024;
const MAX_AUTOMATION_TEXT = 500;

// ── reading (never writes) ──────────────────────────────────────────────────

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

export function sourceRoot(source: MigrateSourceId, home: string, env: NodeJS.ProcessEnv = process.env): string {
  if (source === "openclaw") return join(home, ".openclaw");
  if (source === "hermes") return env.HERMES_HOME || join(home, ".hermes");
  if (source === "claude") return join(home, ".claude");
  return env.CODEX_HOME || join(home, ".codex");
}

class ScanContext {
  readonly items: ScannedItem[] = [];
  readonly secretValues = new Map<string, string>();
  constructor(readonly source: MigrateSourceId, readonly root: string) {}

  /** Record a secret under an env name; a different value under the same name gets a suffix. */
  secret(env: string, from: string, value: string | undefined): SecretRef {
    let name = env;
    if (value) {
      for (let n = 2; this.secretValues.has(name) && this.secretValues.get(name) !== value; n += 1) name = `${env}_${n}`;
      this.secretValues.set(name, value);
    }
    return { env: name, from, hasValue: Boolean(value) };
  }

  clean(text: string): string {
    return redact(text, this.secretValues.values());
  }
}

/** Turn one server entry from any source into a Muster server with env references. */
function convertMcp(ctx: ScanContext, name: string, raw: Record<string, unknown>, from: string): ScannedItem {
  const secrets: SecretRef[] = [];
  const url = str(raw.url) ?? str(raw.serverUrl);
  const command = str(raw.command);
  const declared = str(raw.type) ?? str(raw.transport);
  const inlineSecret = (value: string) => looksLikeSecret(value) || /([?&](key|token|api_key|apikey|access_token)=)/i.test(value);
  if (command && declared !== "http" && declared !== "sse" && declared !== "streamable-http") {
    const args = strings(raw.args);
    const flagSecret = args.some((arg, index) => inlineSecret(arg) || /^--?(api[-_]?key|token|secret|password)(=.+)?$/i.test(arg) && (arg.includes("=") || index + 1 < args.length));
    if (flagSecret || inlineSecret(command)) {
      return { kind: "mcp", name, from, secrets: [], skipped: "a secret is passed on its command line; add it by hand with an env reference" };
    }
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(record(raw.env) ?? {})) {
      if (typeof value !== "string") continue;
      const ref = envReferenceName(key, value);
      if (ref) env[key] = `\${${ref}}`;
      else if (isSecretKey(key) || looksLikeSecret(value)) {
        const secret = ctx.secret(key, `${from}.env.${key}`, value);
        secrets.push(secret);
        env[key] = `\${${secret.env}}`;
      } else env[key] = value;
    }
    for (const key of strings(raw.env_vars)) env[key] = `\${${key}}`;
    const cwd = str(raw.cwd);
    const config: McpServerConfig = {
      transport: { kind: "stdio", command, ...(args.length ? { args } : {}), ...(Object.keys(env).length ? { env } : {}), ...(cwd ? { cwd } : {}) },
    };
    return { kind: "mcp", name, description: [command, ...args].join(" "), from, secrets, mcp: config };
  }
  if (url) {
    if (inlineSecret(url)) return { kind: "mcp", name, from, secrets: [], skipped: "a secret is in its URL; add it by hand with an env reference" };
    const headers: Record<string, string> = {};
    const bearerEnv = str(raw.bearer_token_env_var);
    if (bearerEnv) headers.Authorization = `Bearer \${${bearerEnv}}`;
    for (const [key, envName] of Object.entries(record(raw.env_http_headers) ?? {})) if (typeof envName === "string") headers[key] = `\${${envName}}`;
    const rawHeaders = { ...(record(raw.headers) ?? {}), ...(record(raw.http_headers) ?? {}) };
    for (const [key, value] of Object.entries(rawHeaders)) {
      if (typeof value !== "string") continue;
      if (/\$\{[A-Za-z_][A-Za-z0-9_]*\}/.test(value)) { headers[key] = value; continue; }
      if (!(isSecretKey(key) || /^x-.*(key|token)$/i.test(key) || looksLikeSecret(value) || /^bearer\s/i.test(value))) { headers[key] = value; continue; }
      const bearer = value.match(/^(Bearer|Token|Basic)\s+(.+)$/i);
      const envBase = /^authorization$/i.test(key) ? envNameFor(name, "token") : envNameFor(name, key);
      const secret = ctx.secret(envBase, `${from}.headers.${key}`, bearer ? bearer[2]! : value);
      secrets.push(secret);
      headers[key] = bearer ? `${bearer[1]} \${${secret.env}}` : `\${${secret.env}}`;
    }
    const config: McpServerConfig = { transport: { kind: "http", url, ...(Object.keys(headers).length ? { headers } : {}) } };
    return { kind: "mcp", name, description: url, from, secrets, mcp: config };
  }
  return { kind: "mcp", name, from, secrets: [], skipped: "no command or URL" };
}

function safeName(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+/, "").replace(/-+$/, "") || "item";
}

async function listFiles(root: string): Promise<{ files: string[]; bytes: number } | undefined> {
  const files: string[] = [];
  let bytes = 0;
  const visit = async (dir: string): Promise<boolean> => {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".DS_Store") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!(await visit(path))) return false;
      } else if (entry.isFile()) {
        files.push(relative(root, path).split(sep).join("/"));
        bytes += (await stat(path)).size;
        if (files.length > MAX_SKILL_FILES || bytes > MAX_SKILL_BYTES) return false;
      }
    }
    return true;
  };
  return (await visit(root)) ? { files, bytes } : undefined;
}

/** `<root>/<name>/SKILL.md` (and one category level deeper when `nested`). Links are followed to read. */
async function scanSkills(ctx: ScanContext, root: string, fromPrefix: string, nested = false): Promise<void> {
  let entries: string[];
  try {
    entries = (await readdir(root)).filter((entry) => !entry.startsWith(".")).sort();
  } catch {
    return;
  }
  for (const entry of entries) {
    const dir = join(root, entry);
    const info = await stat(dir).catch(() => undefined);
    if (!info?.isDirectory()) continue;
    const raw = await readText(join(dir, "SKILL.md"));
    if (raw === undefined) {
      if (nested) await scanSkills(ctx, dir, `${fromPrefix}/${entry}`, false);
      continue;
    }
    const head = parseSkillMarkdown(raw);
    // Muster skill names are at least two characters.
    const base = safeName(head.name ?? entry);
    const name = base.length < 2 ? `${base}-skill` : base;
    const from = `${fromPrefix}/${entry}/SKILL.md`;
    const description = ctx.clean(head.description ?? `Skill ${name}`);
    if (head.body.length > 100_000) { ctx.items.push({ kind: "skill", name, description, from, secrets: [], skipped: "SKILL.md is over 100K characters" }); continue; }
    const realDir = realpathSync(dir);
    const listing = await listFiles(realDir).catch(() => undefined);
    if (!listing) { ctx.items.push({ kind: "skill", name, description, from, secrets: [], skipped: `more than ${MAX_SKILL_FILES} files or 25 MB` }); continue; }
    ctx.items.push({
      kind: "skill",
      name,
      description,
      from,
      secrets: [],
      skill: { dir: realDir, description, body: ctx.clean(head.body).trim(), files: listing.files.filter((file) => file !== "SKILL.md") },
    });
  }
}

function addMemoryItems(ctx: ScanContext, kind: "memory" | "profile", text: string, from: string): void {
  for (const entry of splitMemoryEntries(text)) {
    const summary = ctx.clean(entry).slice(0, 2000);
    ctx.items.push({ kind, name: summary.length > 72 ? `${summary.slice(0, 71)}…` : summary, from, secrets: [], summary });
  }
}

function addRule(ctx: ScanContext, fileName: string, text: string | undefined, from: string): void {
  if (!text?.trim()) return;
  ctx.items.push({ kind: "rule", name: fileName, description: `${text.trim().split("\n").length} lines`, from, secrets: [], ruleText: `${ctx.clean(text).trim()}\n` });
}

const EVERY_UNITS: ReadonlyArray<[number, (n: number) => string | undefined]> = [
  [86_400_000, (n) => (n === 1 ? "0 0 * * *" : undefined)],
  [3_600_000, (n) => (24 % n === 0 ? (n === 1 ? "0 * * * *" : `0 */${n} * * *`) : undefined)],
  [60_000, (n) => (60 % n === 0 ? (n === 1 ? "* * * * *" : `*/${n} * * * *`) : undefined)],
];

function everyToCron(ms: number): string | undefined {
  for (const [unit, make] of EVERY_UNITS) if (ms % unit === 0) return make(ms / unit);
  return undefined;
}

async function scanJobs(ctx: ScanContext, path: string, from: string): Promise<void> {
  const raw = await readText(path);
  if (raw === undefined) return;
  let parsed: unknown;
  try { parsed = parseRelaxedJson(raw); } catch { ctx.items.push({ kind: "schedule", name: from, from, secrets: [], skipped: "unreadable jobs file" }); return; }
  const jobs = Array.isArray(parsed) ? parsed : Array.isArray(record(parsed)?.jobs) ? (record(parsed)!.jobs as unknown[]) : [];
  for (const [index, value] of jobs.entries()) {
    const job = record(value);
    if (!job) continue;
    const name = safeName(str(job.name) ?? str(job.id) ?? `job-${index + 1}`);
    const payload = record(job.payload);
    const text = ctx.clean(str(payload?.message) ?? str(payload?.text) ?? str(job.prompt) ?? str(job.message) ?? "").trim();
    const kind: AutomationKind = payload?.kind === "systemEvent" ? "reminder" : "run";
    const schedule = job.schedule;
    const sched = record(schedule);
    let cron = typeof schedule === "string" ? schedule : str(sched?.expr) ?? str(sched?.cron) ?? str(job.cron);
    const tz = str(sched?.tz) ?? str(job.tz);
    let at = str(sched?.at) ?? str(job.at);
    const everyMs = typeof sched?.everyMs === "number" ? sched.everyMs : undefined;
    const item = { kind: "schedule" as const, name, from: `${from} ${name}`, secrets: [] };
    if (!text) { ctx.items.push({ ...item, skipped: "no prompt or message" }); continue; }
    if (text.length > MAX_AUTOMATION_TEXT) { ctx.items.push({ ...item, skipped: `prompt is over ${MAX_AUTOMATION_TEXT} characters` }); continue; }
    if (!cron && everyMs) {
      cron = everyToCron(everyMs);
      if (!cron) { ctx.items.push({ ...item, skipped: "its interval has no cron form" }); continue; }
    }
    if (cron) {
      at = undefined;
      try { parseCron(cron); } catch { ctx.items.push({ ...item, skipped: `unsupported cron "${cron}"` }); continue; }
    } else if (at) {
      if (!(Date.parse(at) > Date.now())) { ctx.items.push({ ...item, skipped: "its one-off time has passed" }); continue; }
    } else {
      ctx.items.push({ ...item, skipped: "no schedule" });
      continue;
    }
    const when = cron ?? `at ${at}`;
    const shortText = text.length > 40 ? `${text.slice(0, 39)}…` : text;
    ctx.items.push({ ...item, description: `${when}${tz ? ` (${tz})` : ""} · "${shortText}" · imported disabled`, schedule: { cron, at, tz, text, kind } });
  }
}

/** OpenClaw's memory index (`chunks` table); any other schema is listed as skipped, never guessed. */
async function scanMemoryDb(ctx: ScanContext, path: string, from: string, alreadyRead: ReadonlySet<string>): Promise<void> {
  if (!existsSync(path)) return;
  // Read a private copy so the source database (and its -wal/-shm) is never opened for writing or locked.
  const temp = await mkdtemp(join(tmpdir(), "muster-migrate-db-"));
  try {
    for (const suffix of ["", "-wal"]) if (existsSync(`${path}${suffix}`)) await copyFile(`${path}${suffix}`, join(temp, `main.sqlite${suffix}`));
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(join(temp, "main.sqlite"), { readOnly: true });
    try {
      const columns = (db.prepare("SELECT name FROM pragma_table_info('chunks')").all() as Array<{ name: string }>).map((row) => row.name);
      if (!columns.includes("text") || !columns.includes("path")) {
        ctx.items.push({ kind: "memory", name: from, from, secrets: [], skipped: "unknown memory schema" });
        return;
      }
      const hasSource = columns.includes("source");
      const rows = db.prepare(`SELECT path, text${hasSource ? ", source" : ""} FROM chunks ORDER BY path, rowid`).all() as Array<{ path: string; text: string; source?: string }>;
      for (const row of rows) {
        if (hasSource && row.source !== "memory") continue;
        const base = String(row.path).split("/").pop() ?? "";
        if (alreadyRead.has(base) || String(row.path).includes("memory/")) continue;
        const summary = ctx.clean(String(row.text)).trim().replace(/\s+/g, " ").slice(0, 2000);
        if (summary.length >= 3) ctx.items.push({ kind: "memory", name: summary.length > 72 ? `${summary.slice(0, 71)}…` : summary, from, secrets: [], summary });
      }
    } finally {
      db.close();
    }
  } catch {
    ctx.items.push({ kind: "memory", name: from, from, secrets: [], skipped: "unknown memory schema" });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

function channelItem(ctx: ScanContext, id: "telegram" | "discord", from: string, value: string | undefined, fromLabel: string): ScannedItem {
  const envName = id === "telegram" ? "TELEGRAM_BOT_TOKEN" : "DISCORD_BOT_TOKEN";
  const secret = ctx.secret(envName, fromLabel, value);
  return { kind: "channel", name: id, description: `${id === "telegram" ? "Telegram" : "Discord"} bot, token as env reference`, from, secrets: [secret], channel: { id, envName: secret.env } };
}

async function scanOpenclaw(ctx: ScanContext): Promise<void> {
  const root = ctx.root;
  const raw = await readText(join(root, "openclaw.json"));
  let config: Record<string, unknown> = {};
  if (raw !== undefined) {
    try { config = record(parseRelaxedJson(raw)) ?? {}; } catch { config = {}; }
  }
  // Collect every credential in the file first, so no imported text can carry one.
  const collect = (value: unknown, path: string) => {
    if (typeof value === "string") { if (isSecretKey(path.split(".").pop() ?? "") || looksLikeSecret(value)) ctx.secretValues.set(`__seen_${ctx.secretValues.size}`, value); return; }
    if (Array.isArray(value)) value.forEach((entry, index) => collect(entry, `${path}.${index}`));
    else if (record(value)) for (const [key, entry] of Object.entries(value as Record<string, unknown>)) collect(entry, `${path}.${key}`);
  };
  collect(config, "");

  const channels = record(config.channels) ?? {};
  for (const [id, value] of Object.entries(channels).sort(([a], [b]) => a.localeCompare(b))) {
    const channel = record(value) ?? {};
    const from = `openclaw.json channels.${id}`;
    if (id === "telegram" || id === "discord") {
      const key = id === "telegram" ? "botToken" : str(channel.token) ? "token" : "botToken";
      let token = str(channel[key]);
      let label = `openclaw.json channels.${id}.${key}`;
      const accounts = record(channel.accounts);
      if (!token && accounts) {
        for (const [account, entry] of Object.entries(accounts)) {
          const accountToken = str(record(entry)?.botToken) ?? str(record(entry)?.token);
          if (accountToken) { token = accountToken; label = `openclaw.json channels.${id}.accounts.${account}`; break; }
        }
      }
      ctx.items.push(channelItem(ctx, id, from, token, label));
    } else {
      ctx.items.push({ kind: "channel", name: id, from, secrets: [], skipped: `no automatic mapping; set it up with muster channels setup` });
    }
  }

  const servers: Array<[string, Record<string, unknown>, string]> = [];
  for (const [name, value] of Object.entries(record(record(config.mcp)?.servers) ?? {})) {
    if (record(value)) servers.push([name, value as Record<string, unknown>, `openclaw.json mcp.servers.${name}`]);
  }
  for (const [pluginId, entry] of Object.entries(record(record(config.plugins)?.entries) ?? {})) {
    const list = record(record(entry)?.config)?.servers;
    if (!Array.isArray(list)) continue;
    list.forEach((value, index) => {
      const server = record(value);
      const name = str(server?.name);
      if (server && name) servers.push([name, server, `openclaw.json plugins.entries.${pluginId}.config.servers.${index}`]);
    });
  }
  for (const [name, server, from] of servers) ctx.items.push(convertMcp(ctx, safeName(name), server, from));

  const workspaceSetting = str(record(record(config.agents)?.defaults)?.workspace);
  const workspace = workspaceSetting ? (workspaceSetting.startsWith("~/") ? join(dirname(root), workspaceSetting.slice(2)) : resolve(root, workspaceSetting)) : join(root, "workspace");
  const wsLabel = workspaceSetting ? workspace : "workspace";
  const user = await readText(join(workspace, "USER.md"));
  if (user) addMemoryItems(ctx, "profile", user, `${wsLabel}/USER.md`);
  const memory = await readText(join(workspace, "MEMORY.md"));
  if (memory) addMemoryItems(ctx, "memory", memory, `${wsLabel}/MEMORY.md`);
  const notes = await readdir(join(workspace, "memory")).catch(() => [] as string[]);
  for (const note of notes.filter((name) => name.endsWith(".md")).sort()) {
    const text = await readText(join(workspace, "memory", note));
    if (text) addMemoryItems(ctx, "memory", text, `${wsLabel}/memory/${note}`);
  }
  await scanMemoryDb(ctx, join(root, "memory", "main.sqlite"), "memory/main.sqlite", new Set(["MEMORY.md", "USER.md"]));
  for (const file of ["AGENTS.md", "SOUL.md", "IDENTITY.md", "TOOLS.md"]) addRule(ctx, file, await readText(join(workspace, file)), `${wsLabel}/${file}`);
  if (await readText(join(workspace, "HEARTBEAT.md"))) {
    ctx.items.push({ kind: "rule", name: "HEARTBEAT.md", from: `${wsLabel}/HEARTBEAT.md`, secrets: [], skipped: "a heartbeat checklist; recreate it with muster schedule add" });
  }
  await scanSkills(ctx, join(root, "skills"), "skills");
  await scanJobs(ctx, join(root, "cron", "jobs.json"), "cron/jobs.json");
}

async function scanHermes(ctx: ScanContext): Promise<void> {
  const root = ctx.root;
  const env = parseDotenv((await readText(join(root, ".env"))) ?? "");
  for (const [key, value] of Object.entries(env)) if (value && (isSecretKey(key) || looksLikeSecret(value))) ctx.secretValues.set(`__seen_${key}`, value);
  let config: Record<string, unknown> = {};
  const rawConfig = await readText(join(root, "config.yaml"));
  if (rawConfig !== undefined) {
    try { config = record(parseYaml(rawConfig)) ?? {}; } catch { config = {}; }
  }
  for (const [name, value] of Object.entries(record(config.mcp_servers) ?? {})) {
    if (record(value)) ctx.items.push(convertMcp(ctx, safeName(name), value as Record<string, unknown>, `config.yaml mcp_servers.${name}`));
  }
  if (env.TELEGRAM_BOT_TOKEN !== undefined) ctx.items.push(channelItem(ctx, "telegram", ".env TELEGRAM_BOT_TOKEN", env.TELEGRAM_BOT_TOKEN || undefined, ".env TELEGRAM_BOT_TOKEN"));
  if (env.DISCORD_BOT_TOKEN !== undefined) ctx.items.push(channelItem(ctx, "discord", ".env DISCORD_BOT_TOKEN", env.DISCORD_BOT_TOKEN || undefined, ".env DISCORD_BOT_TOKEN"));
  for (const key of ["SLACK_BOT_TOKEN", "WHATSAPP_ENABLED", "SIGNAL_ACCOUNT"]) {
    if (env[key] !== undefined) ctx.items.push({ kind: "channel", name: key.split("_")[0]!.toLowerCase(), from: `.env ${key}`, secrets: [], skipped: "no automatic mapping; set it up with muster channels setup" });
  }
  const user = await readText(join(root, "memories", "USER.md"));
  if (user) addMemoryItems(ctx, "profile", user, "memories/USER.md");
  const memory = await readText(join(root, "memories", "MEMORY.md"));
  if (memory) addMemoryItems(ctx, "memory", memory, "memories/MEMORY.md");
  addRule(ctx, "SOUL.md", await readText(join(root, "SOUL.md")), "SOUL.md");
  await scanSkills(ctx, join(root, "skills"), "skills", true);
  await scanJobs(ctx, join(root, "cron", "jobs.json"), "cron/jobs.json");
}

async function scanClaude(ctx: ScanContext, home: string, cwd: string): Promise<void> {
  const files: Array<[string, string]> = [[join(home, ".claude.json"), ".claude.json"], [join(cwd, ".mcp.json"), ".mcp.json"]];
  for (const [path, label] of files) {
    const raw = await readText(path);
    if (raw === undefined) continue;
    let parsed: Record<string, unknown> = {};
    try { parsed = record(parseRelaxedJson(raw)) ?? {}; } catch { continue; }
    for (const [name, value] of Object.entries(record(parsed.mcpServers) ?? {})) {
      if (record(value)) ctx.items.push(convertMcp(ctx, safeName(name), value as Record<string, unknown>, `${label} mcpServers.${name}`));
    }
  }
  await scanSkills(ctx, join(ctx.root, "skills"), "skills");
  addRule(ctx, "CLAUDE.md", await readText(join(ctx.root, "CLAUDE.md")), "CLAUDE.md");
}

async function scanCodex(ctx: ScanContext): Promise<void> {
  const raw = await readText(join(ctx.root, "config.toml"));
  if (raw !== undefined) {
    let parsed: Record<string, unknown> = {};
    try { parsed = parseToml(raw); } catch { parsed = {}; }
    for (const [name, value] of Object.entries(record(parsed.mcp_servers) ?? {})) {
      if (record(value)) ctx.items.push(convertMcp(ctx, safeName(name), value as Record<string, unknown>, `config.toml mcp_servers.${name}`));
    }
  }
  addRule(ctx, "AGENTS.md", await readText(join(ctx.root, "AGENTS.md")), "AGENTS.md");
  await scanSkills(ctx, join(ctx.root, "skills"), "skills");
}

/** Read one source. Only reads: no file under the source is ever opened for writing. */
export async function scanSource(source: MigrateSourceId, options: { home?: string; cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<SourceScan> {
  const home = options.home ?? homedir();
  const cwd = options.cwd ?? process.cwd();
  const root = sourceRoot(source, home, options.env);
  const ctx = new ScanContext(source, root);
  const roots = source === "claude" ? [root, join(home, ".claude.json")] : [root];
  const exists = roots.some((path) => existsSync(path));
  if (exists) {
    if (source === "openclaw") await scanOpenclaw(ctx);
    else if (source === "hermes") await scanHermes(ctx);
    else if (source === "claude") await scanClaude(ctx, home, cwd);
    else await scanCodex(ctx);
  }
  // Memory beyond the cap is listed once instead of flooding the plan.
  const memoryItems = ctx.items.filter((item) => (item.kind === "memory" || item.kind === "profile") && !item.skipped);
  if (memoryItems.length > MAX_MEMORY_ITEMS) {
    const drop = new Set(memoryItems.slice(MAX_MEMORY_ITEMS));
    const kept = ctx.items.filter((item) => !drop.has(item));
    ctx.items.length = 0;
    ctx.items.push(...kept, { kind: "memory", name: `${drop.size} more entries`, from: "", secrets: [], skipped: `over the ${MAX_MEMORY_ITEMS}-entry limit for one run` });
  }
  for (const key of [...ctx.secretValues.keys()]) if (key.startsWith("__seen_")) ctx.secretValues.delete(key);
  return { source, root, roots, exists, items: ctx.items, secretValues: ctx.secretValues };
}

// ── planning against Muster's current state (reads only) ────────────────────

function sha(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().filter((key) => (value as Record<string, unknown>)[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  const raw = await readText(path);
  if (raw === undefined) return undefined;
  try { return record(JSON.parse(raw)); } catch { return undefined; }
}

function skillBody(raw: string): string {
  const match = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n(?:\r?\n)?([\s\S]*)$/);
  return (match ? match[1]! : raw).trim();
}

interface MusterState {
  readonly memories: Set<string>;
  readonly servers: Record<string, unknown>;
  readonly gateway?: Record<string, unknown>;
  readonly jobs: Array<{ cron: string; at?: string; prompt: string }>;
  readonly cwd: string;
}

async function readMusterState(cwd: string): Promise<MusterState> {
  const memories = new Set((await listMemory(cwd)).map((memory) => memory.summary.trim()));
  const config = await readJson(configPath(cwd));
  const servers = record(record(record(config?.tools)?.mcp)?.servers) ?? {};
  const gateway = await readJson(gatewayConfigPath(cwd));
  // Opening the scheduler creates its database, so only look when one exists.
  const jobs = existsSync(join(dataDir(cwd), "schedules.sqlite")) || existsSync(schedulesPath(cwd)) ? (await listSchedules(cwd)).map((job) => ({ cron: job.cron, at: job.at, prompt: job.prompt })) : [];
  return { memories, servers, gateway, jobs, cwd };
}

function renamed(name: string, source: MigrateSourceId): string {
  return `${name}-${source}`;
}

function ruleTarget(source: MigrateSourceId, fileName: string): string {
  return `${source}-${fileName.toLowerCase().replace(/\.md$/, "").replace(/[^a-z0-9]+/g, "-")}.md`;
}

async function statusFor(item: ScannedItem, state: MusterState, source: MigrateSourceId, rename: boolean): Promise<{ status: PlanStatus; target: string; reason?: string }> {
  if (item.skipped) return { status: "skipped", target: item.name, reason: item.skipped };
  const cwd = state.cwd;
  if (item.kind === "memory" || item.kind === "profile") {
    return state.memories.has(item.summary!.trim()) ? { status: "already in Muster", target: item.name } : { status: "new", target: item.name };
  }
  if (item.kind === "skill" || item.kind === "mcp") {
    const same = async (name: string): Promise<boolean | undefined> => {
      if (item.kind === "skill") {
        const raw = await readText(join(skillsDir(cwd), name, "SKILL.md"));
        return raw === undefined ? undefined : skillBody(raw) === item.skill!.body.trim();
      }
      const existing = state.servers[name];
      return existing === undefined ? undefined : canonical(record(existing)?.transport) === canonical(item.mcp!.transport);
    };
    const direct = await same(item.name);
    if (direct === undefined) return { status: "new", target: item.name };
    if (direct) return { status: "already in Muster", target: item.name };
    const alt = renamed(item.name, source);
    if (!rename) {
      const altSame = await same(alt);
      if (altSame) return { status: "already in Muster", target: alt };
      return { status: "conflict", target: item.name, reason: `Muster has a different ${item.name}; skipped (--rename imports it as ${alt})` };
    }
    const altSame = await same(alt);
    if (altSame === undefined) return { status: "new", target: alt, reason: `renamed from ${item.name}` };
    if (altSame) return { status: "already in Muster", target: alt };
    return { status: "conflict", target: alt, reason: `Muster has a different ${item.name} and ${alt}; skipped` };
  }
  if (item.kind === "channel") {
    const existing = record(state.gateway?.[item.channel!.id]);
    if (!existing) return { status: "new", target: item.name };
    if (existing.botTokenEnv === item.channel!.envName) return { status: "already in Muster", target: item.name };
    return { status: "conflict", target: item.name, reason: `Muster already has a ${item.name} channel; skipped` };
  }
  if (item.kind === "schedule") {
    const s = item.schedule!;
    const match = state.jobs.some((job) => job.prompt === s.text && (s.cron ? job.cron === s.cron : job.at === new Date(s.at!).toISOString()));
    return match ? { status: "already in Muster", target: item.name } : { status: "new", target: item.name };
  }
  const target = ruleTarget(source, item.name);
  const existing = await readText(join(importedRulesDir(cwd), target));
  if (existing === undefined) return { status: "new", target };
  return existing === item.ruleText ? { status: "already in Muster", target } : { status: "conflict", target, reason: `.muster/rules/${target} was edited; skipped` };
}

export async function buildPlan(source: MigrateSourceId, options: { home?: string; cwd?: string; env?: NodeJS.ProcessEnv; rename?: boolean } = {}): Promise<MigrationPlan> {
  const cwd = options.cwd ?? process.cwd();
  const scan = await scanSource(source, { ...options, cwd });
  const state = await readMusterState(cwd);
  const items: PlanItem[] = [];
  const seen = new Set<string>();
  for (const item of scan.items) {
    const status = await statusFor(item, state, source, options.rename === true);
    // Two entries with the same text or name in one source import once.
    const key = `${item.kind}:${item.kind === "memory" || item.kind === "profile" ? item.summary : status.target}`;
    if (!item.skipped && seen.has(key)) continue;
    seen.add(key);
    items.push({ ...item, ...status });
  }
  return { source, root: scan.root, roots: scan.roots, exists: scan.exists, items, secretValues: scan.secretValues };
}

// ── rendering ───────────────────────────────────────────────────────────────

function displayPath(path: string, home: string): string {
  return path.startsWith(`${home}${sep}`) ? `~/${path.slice(home.length + 1)}` : path;
}

function secretLine(secret: SecretRef): string {
  const file = secret.from.split(" ")[0]!;
  return secret.hasValue
    ? `•••• (from ${secret.from}) → set ${secret.env}`
    : `(no value in ${file}) → set ${secret.env}`;
}

export function formatItemLine(item: PlanItem, statusText?: string): string {
  const status = statusText ?? (item.status === "skipped" ? `skipped: ${item.reason}` : item.status);
  const name = item.target !== item.name && item.kind !== "rule" ? `${item.target} (from ${item.name})` : item.name;
  const detail = item.status === "conflict" ? item.reason : item.description;
  return `  ${status.padEnd(18)} ${name}${detail ? ` — ${detail}` : ""}`;
}

export function formatPlan(plan: MigrationPlan, options: { home?: string; mode?: "dry run" | "review" } = {}): string[] {
  const home = options.home ?? homedir();
  const lines: string[] = [`muster migrate ${plan.source} · ${options.mode ?? "dry run"} · source ${displayPath(plan.root, home)} (read-only)`];
  if (!plan.exists) {
    lines.push("", `No ${plan.source} setup found at ${displayPath(plan.root, home)}. Nothing to migrate.`);
    return redactLines(lines, plan);
  }
  for (const group of GROUPS) {
    lines.push("", group.title);
    const items = plan.items.filter((item) => item.kind === group.kind);
    if (!items.length) lines.push("  (none)");
    for (const item of items) {
      lines.push(formatItemLine(item));
      if (item.status !== "skipped") for (const secret of item.secrets) lines.push(`${" ".repeat(21)}${secretLine(secret)}`);
    }
  }
  const count = (status: PlanStatus) => plan.items.filter((item) => item.status === status).length;
  lines.push("", `${plan.items.length} items: ${count("new")} new · ${count("already in Muster")} already in Muster · ${count("conflict")} conflict · ${count("skipped")} skipped`);
  const envs = [...new Set(plan.items.filter((item) => item.status === "new").flatMap((item) => item.secrets.map((secret) => secret.env)))];
  if (envs.length) lines.push(`Env to set: ${envs.join(", ")} — or pass --write-env <file> to write them to a 0600 dotenv file you own`);
  return redactLines(lines, plan);
}

function redactLines(lines: string[], plan: Pick<MigrationPlan, "secretValues">): string[] {
  return lines.map((line) => redact(line, plan.secretValues.values()));
}

/** "3 skills, 2 channels, memory" — what onboarding offers to bring over. */
export function summarizeScan(scan: Pick<SourceScan, "items">): string {
  const usable = scan.items.filter((item) => !item.skipped);
  const count = (kind: ItemKind) => usable.filter((item) => item.kind === kind).length;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const parts: string[] = [];
  if (count("skill")) parts.push(plural(count("skill"), "skill"));
  if (count("channel")) parts.push(plural(count("channel"), "channel"));
  if (count("mcp")) parts.push(plural(count("mcp"), "MCP server"));
  if (count("schedule")) parts.push(plural(count("schedule"), "schedule"));
  if (count("memory") || count("profile")) parts.push("memory");
  if (count("rule")) parts.push("rules");
  return parts.join(", ");
}

export interface MigrationOffer {
  readonly source: MigrateSourceId;
  readonly summary: string;
}

/** Other setups on this machine that have something to bring over (read-only). */
export async function detectMigrationOffers(options: { home?: string; cwd?: string; env?: NodeJS.ProcessEnv; sources?: readonly MigrateSourceId[] } = {}): Promise<MigrationOffer[]> {
  const offers: MigrationOffer[] = [];
  for (const source of options.sources ?? MIGRATE_SOURCES) {
    const scan = await scanSource(source, options).catch(() => undefined);
    if (!scan?.exists) continue;
    const summary = summarizeScan(scan);
    if (summary) offers.push({ source, summary });
  }
  return offers;
}

export function offerHeadline(offer: MigrationOffer): string {
  return `Found ${/^[aeiou]/.test(offer.source) ? "an" : "a"} ${offer.source} setup: ${offer.summary} — bring it over?`;
}

// ── applying ────────────────────────────────────────────────────────────────

export interface ReceiptItem {
  readonly kind: ItemKind;
  readonly name: string;
  readonly target: string;
  readonly from: string;
  /** Hash of what was written; undo keeps the item when it no longer matches. */
  readonly hash: string;
  readonly memoryId?: string;
  readonly scheduleId?: string;
}

export interface MigrationReceipt {
  readonly runId: string;
  readonly source: MigrateSourceId;
  readonly sourceRoot: string;
  readonly createdAt: string;
  readonly gatewayCreated: boolean;
  readonly items: ReceiptItem[];
  readonly undoneAt?: string;
}

export function migrationsDir(cwd = process.cwd()): string {
  return join(musterRoot(cwd), "migrations");
}

function newRunId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "").replace("T", "T");
  return `mig_${stamp}_${randomBytes(2).toString("hex")}`;
}

function isWithin(root: string, target: string): boolean {
  const real = (path: string) => {
    try { return realpathSync(path); } catch { return resolve(path); }
  };
  const rel = relative(real(root), real(target));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function nearestExisting(path: string): string {
  let current = resolve(path);
  while (!existsSync(current) && dirname(current) !== current) current = dirname(current);
  return current;
}

/** Refuse any write that would land inside a source tree. */
export function assertOutsideSources(target: string, roots: readonly string[], what: string): void {
  const probe = nearestExisting(target);
  for (const root of roots) {
    if (existsSync(root) && isWithin(root, probe) && (resolve(target) === resolve(probe) || isWithin(root, target))) {
      throw new Error(`Refusing to write ${what} inside ${root}: muster migrate never writes to the source setup.`);
    }
  }
}

function scheduleHash(job: { cron: string; prompt: string; tz?: string; kind?: string; at?: string; deliver?: string }): string {
  return sha(canonical({ cron: job.cron, prompt: job.prompt, tz: job.tz, kind: job.kind, at: job.at, deliver: job.deliver }));
}

function channelHash(entry: unknown): string {
  const { botToken: _drop, ...rest } = (record(entry) ?? {}) as Record<string, unknown>;
  return sha(canonical(rest));
}

export interface ApplyResult {
  readonly runId?: string;
  readonly lines: string[];
  readonly applied: PlanItem[];
}

export async function applyPlan(plan: MigrationPlan, options: { cwd?: string; user?: string } = {}): Promise<ApplyResult> {
  const cwd = options.cwd ?? process.cwd();
  assertOutsideSources(musterRoot(cwd), plan.roots, "Muster state");
  const todo = plan.items.filter((item) => item.status === "new");
  const lines: string[] = [];
  if (!todo.length) {
    for (const item of plan.items) lines.push(formatItemLine(item));
    lines.push("", "Nothing to apply: every item is already in Muster, conflicting or skipped.");
    return { lines: redactLines(lines, plan), applied: [] };
  }
  const runId = newRunId();
  const user = options.user ?? (process.env.USER || process.env.USERNAME || "local");
  const tag = `migrated:${plan.source}`;
  const receiptItems: ReceiptItem[] = [];
  const gatewayExisted = existsSync(gatewayConfigPath(cwd));
  const receiptPath = join(migrationsDir(cwd), `${runId}.json`);
  const saveReceipt = async (undoneAt?: string) => {
    const receipt: MigrationReceipt = { runId, source: plan.source, sourceRoot: plan.root, createdAt: new Date().toISOString(), gatewayCreated: !gatewayExisted, items: receiptItems, ...(undoneAt ? { undoneAt } : {}) };
    await mkdir(migrationsDir(cwd), { recursive: true, mode: 0o700 });
    const temp = `${receiptPath}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, receiptPath);
  };
  lines.push(`muster migrate ${plan.source} · apply · run ${runId}`);
  const applied: PlanItem[] = [];
  for (const item of plan.items) {
    if (item.status !== "new") { lines.push(formatItemLine(item)); continue; }
    const base = { kind: item.kind, name: item.name, target: item.target, from: item.from };
    try {
      if (item.kind === "memory" || item.kind === "profile") {
        const memory = await addMemory({
          kind: item.kind === "profile" ? "user_profile" : "fact",
          summary: item.summary!,
          provenance: [tag, `migrate:${runId}`, `source:${plan.source}:${item.from}`],
          scopes: [{ kind: "user", id: user }],
          explicitUserRequest: true,
        }, cwd);
        receiptItems.push({ ...base, hash: sha(memory.summary), memoryId: memory.id });
      } else if (item.kind === "skill") {
        const skill = item.skill!;
        await writeBundledSkill({ name: item.target, description: skill.description, body: skill.body, tags: [tag], sourceRunId: runId }, cwd);
        const dir = join(skillsDir(cwd), item.target);
        for (const file of skill.files) {
          const destination = join(dir, file);
          await mkdir(dirname(destination), { recursive: true });
          const content = await readFile(join(skill.dir, file));
          const text = content.toString("utf8");
          const cleaned = redact(text, plan.secretValues.values());
          await writeFile(destination, cleaned !== text && !text.includes("�") ? cleaned : content);
        }
        receiptItems.push({ ...base, hash: await digestTree(dir) });
      } else if (item.kind === "mcp") {
        await ensureDefaultConfig(cwd);
        const config = await loadConfig(cwd);
        const servers = { ...(config.tools?.mcp?.servers ?? {}), [item.target]: item.mcp! };
        await saveConfig({ ...config, tools: { ...(config.tools ?? {}), mcp: { ...(config.tools?.mcp ?? {}), servers } } }, cwd);
        receiptItems.push({ ...base, hash: sha(canonical(item.mcp)) });
      } else if (item.kind === "channel") {
        await initGatewayConfig(cwd);
        const gateway = await loadGatewayConfig(cwd);
        const channel = item.channel!;
        const next: GatewayConfig = channel.id === "telegram"
          ? { ...gateway, telegram: { botTokenEnv: channel.envName, secretToken: randomBytes(24).toString("hex"), status: "typing", busy: "queue" } }
          : { ...gateway, discord: { botTokenEnv: channel.envName } };
        await saveGatewayConfig(next, cwd);
        receiptItems.push({ ...base, hash: channelHash(next[channel.id]) });
      } else if (item.kind === "schedule") {
        const s = item.schedule!;
        const job = await createAutomation({ kind: s.kind, text: s.text, ...(s.cron ? { cron: s.cron } : { when: s.at! }), tz: s.tz, cwd, disabled: true });
        receiptItems.push({ ...base, hash: scheduleHash(job), scheduleId: job.id });
      } else {
        const path = join(importedRulesDir(cwd), item.target);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, item.ruleText!, { mode: 0o600 });
        receiptItems.push({ ...base, hash: sha(item.ruleText!) });
      }
      applied.push(item);
      lines.push(formatItemLine(item, item.target !== item.name && item.kind !== "rule" ? "added (renamed)" : "added"));
      if (item.kind === "schedule") lines.push(`${" ".repeat(21)}disabled until you run: muster schedule enable ${receiptItems.at(-1)!.scheduleId}`);
      for (const secret of item.secrets) lines.push(`${" ".repeat(21)}${secretLine(secret)}`);
    } catch (error) {
      lines.push(formatItemLine(item, `failed: ${error instanceof Error ? error.message : String(error)}`));
    }
    // A receipt after every item: an interrupted run can still be undone.
    await saveReceipt();
  }
  lines.push("", `Applied ${applied.length} of ${plan.items.length} items. Receipt: ${relative(cwd, receiptPath) || receiptPath}`);
  lines.push(`Undo with: muster migrate undo ${runId}`);
  return { runId, lines: redactLines(lines, plan), applied };
}

// ── undo ────────────────────────────────────────────────────────────────────

export async function readReceipt(runId: string, cwd = process.cwd()): Promise<MigrationReceipt> {
  if (!/^mig_[A-Za-z0-9_]+$/.test(runId)) throw new Error(`Not a migration run id: ${runId}. Run ids look like mig_20261114T101500_ab12 (see muster migrate runs).`);
  const raw = await readText(join(migrationsDir(cwd), `${runId}.json`));
  if (raw === undefined) throw new Error(`No migration run ${runId} in ${migrationsDir(cwd)}.`);
  return JSON.parse(raw) as MigrationReceipt;
}

export async function listReceipts(cwd = process.cwd()): Promise<MigrationReceipt[]> {
  const names = await readdir(migrationsDir(cwd)).catch(() => [] as string[]);
  const out: MigrationReceipt[] = [];
  for (const name of names.filter((entry) => /^mig_.*\.json$/.test(entry)).sort()) {
    try { out.push(JSON.parse((await readText(join(migrationsDir(cwd), name)))!) as MigrationReceipt); } catch { /* skip unreadable */ }
  }
  return out;
}

export async function undoRun(runId: string, cwd = process.cwd()): Promise<string[]> {
  const receipt = await readReceipt(runId, cwd);
  const lines = [`muster migrate undo ${runId} · ${receipt.source}`];
  if (receipt.undoneAt) return [...lines, `Already undone at ${receipt.undoneAt}.`];
  let removed = 0;
  let kept = 0;
  const keep = (item: ReceiptItem, why = "edited after migration") => { kept += 1; lines.push(`  ${`kept: ${why}`.padEnd(18)} ${item.kind} ${item.target}`); };
  const gone = (item: ReceiptItem, label = "removed") => { removed += 1; lines.push(`  ${label.padEnd(18)} ${item.kind} ${item.target}`); };

  const memoryItems = receipt.items.filter((item) => item.memoryId);
  if (memoryItems.length) {
    const current = new Map((await listMemory(cwd)).map((memory) => [memory.id, memory]));
    const forget: string[] = [];
    for (const item of memoryItems) {
      const memory = current.get(item.memoryId!);
      if (!memory) gone(item, "already gone");
      else if (sha(memory.summary) !== item.hash) keep(item);
      else { forget.push(item.memoryId!); gone(item); }
    }
    await forgetMemories(forget, cwd);
  }
  let config = receipt.items.some((item) => item.kind === "mcp") ? await loadConfig(cwd).catch(() => undefined) : undefined;
  const servers = { ...(config?.tools?.mcp?.servers ?? {}) } as Record<string, McpServerConfig>;
  let configChanged = false;
  let gateway = receipt.items.some((item) => item.kind === "channel") ? await loadGatewayConfig(cwd).catch(() => undefined) : undefined;
  let gatewayChanged = false;
  const jobs = receipt.items.some((item) => item.kind === "schedule") ? await listSchedules(cwd) : [];

  for (const item of receipt.items) {
    if (item.memoryId) continue;
    if (item.kind === "skill") {
      const dir = join(skillsDir(cwd), item.target);
      if (!existsSync(dir)) gone(item, "already gone");
      else if ((await digestTree(dir)) !== item.hash) keep(item);
      else { await removeSkill(item.target, cwd); gone(item); }
    } else if (item.kind === "mcp") {
      const server = servers[item.target];
      if (!server) gone(item, "already gone");
      else if (sha(canonical(server)) !== item.hash) keep(item);
      else { delete servers[item.target]; configChanged = true; gone(item); }
    } else if (item.kind === "channel") {
      const id = item.target as "telegram" | "discord";
      const entry = gateway?.[id];
      if (!entry) gone(item, "already gone");
      else if (channelHash(entry) !== item.hash) keep(item);
      else { const next = { ...gateway! }; delete next[id]; gateway = next; gatewayChanged = true; gone(item); }
    } else if (item.kind === "schedule") {
      const job = jobs.find((entry) => entry.id === item.scheduleId);
      if (!job) gone(item, "already gone");
      else if (scheduleHash(job) !== item.hash) keep(item);
      else { await removeSchedule(job.id, cwd); gone(item); }
    } else if (item.kind === "rule") {
      const path = join(importedRulesDir(cwd), item.target);
      const text = await readText(path);
      if (text === undefined) gone(item, "already gone");
      else if (sha(text) !== item.hash) keep(item);
      else { await rm(path, { force: true }); gone(item); }
    }
  }
  if (configChanged && config) {
    config = { ...config, tools: { ...(config.tools ?? {}), mcp: { ...(config.tools?.mcp ?? {}), servers } } };
    await saveConfig(config, cwd);
  }
  if (gatewayChanged && gateway) {
    const leftover = Object.keys(gateway).filter((key) => key !== "token" && key !== "port");
    if (receipt.gatewayCreated && !leftover.length) await rm(gatewayConfigPath(cwd), { force: true });
    else await saveGatewayConfig(gateway, cwd);
  }
  const done: MigrationReceipt = { ...receipt, undoneAt: new Date().toISOString() };
  await writeFile(join(migrationsDir(cwd), `${runId}.json`), `${JSON.stringify(done, null, 2)}\n`, { mode: 0o600 });
  lines.push("", `Undone: ${removed} removed · ${kept} kept`);
  return lines;
}

// ── --write-env ─────────────────────────────────────────────────────────────

export async function writeEnvFile(path: string, plan: MigrationPlan, items: readonly PlanItem[]): Promise<string[]> {
  const target = resolve(path);
  assertOutsideSources(target, plan.roots, "the env file");
  const wanted = new Map<string, string>();
  for (const item of items) for (const secret of item.secrets) {
    const value = plan.secretValues.get(secret.env);
    if (value) wanted.set(secret.env, value);
  }
  const existingRaw = (await readText(target)) ?? "";
  const existing = parseDotenv(existingRaw);
  const added: string[] = [];
  const keptNames: string[] = [];
  let out = existingRaw && !existingRaw.endsWith("\n") ? `${existingRaw}\n` : existingRaw;
  for (const [name, value] of wanted) {
    if (existing[name] !== undefined) { keptNames.push(name); continue; }
    out += `${dotenvLine(name, value)}\n`;
    added.push(name);
  }
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, out, { mode: 0o600 });
  await chmod(target, 0o600);
  const lines = [`Wrote ${added.length} variable${added.length === 1 ? "" : "s"} to ${target} (mode 0600)${added.length ? `: ${added.join(", ")}` : ""}`];
  if (keptNames.length) lines.push(`Kept the existing values for: ${keptNames.join(", ")}`);
  lines.push(`Load it before starting Muster, e.g.: set -a; . ${target}; set +a`);
  return lines;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function flagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function flagValues(args: readonly string[], flag: string): string[] {
  return args.flatMap((arg, index) => (arg === flag && args[index + 1] ? [args[index + 1]!] : []));
}

export const MIGRATE_USAGE = `Usage:
  muster migrate <openclaw|hermes|claude|codex>            show the plan (dry run, reads only)
  muster migrate <source> --apply [--yes] [--rename]       apply new items; conflicts are skipped (or renamed)
      [--only memory,profile,skills,mcp,channels,schedules,rules] [--exclude <name>]
      [--write-env <file>]                                 write found tokens to a 0600 dotenv file you own
      [--home <dir>]                                       read the source from another home directory
  muster migrate runs                                      list migration runs
  muster migrate undo <run-id>                             remove exactly what a run added`;

export async function runMigrateCommand(args: readonly string[], io: { log?: (line: string) => void; confirm?: (question: string) => Promise<boolean> } = {}): Promise<void> {
  const log = io.log ?? ((line: string) => console.log(line));
  const cwd = process.cwd();
  const [first, second] = args;
  if (first === "undo") {
    if (!second) throw new Error("Usage: muster migrate undo <run-id> (see muster migrate runs)");
    for (const line of await undoRun(second, cwd)) log(line);
    return;
  }
  if (first === "runs") {
    const receipts = await listReceipts(cwd);
    if (!receipts.length) log("No migration runs.");
    for (const receipt of receipts) log(`${receipt.runId}  ${receipt.source}  ${receipt.items.length} items  ${receipt.undoneAt ? `undone ${receipt.undoneAt}` : receipt.createdAt}`);
    return;
  }
  if (!isMigrateSource(first)) throw new Error(MIGRATE_USAGE);
  const home = flagValue(args, "--home") ?? process.env.HOME ?? homedir();
  const apply = args.includes("--apply");
  const plan = await buildPlan(first, { home, cwd, rename: args.includes("--rename") });
  const only = flagValue(args, "--only")?.split(",").map((value) => value.trim()).filter(Boolean);
  if (only) {
    const known = new Set(GROUPS.map((group) => group.flag));
    for (const value of only) if (!known.has(value)) throw new Error(`Unknown group "${value}" for --only: use ${[...known].join(", ")}.`);
  }
  const excluded = new Set(flagValues(args, "--exclude"));
  const picked: MigrationPlan = {
    ...plan,
    items: plan.items.filter((item) => (!only || only.includes(GROUPS.find((group) => group.kind === item.kind)!.flag)) && !excluded.has(item.name) && !excluded.has(item.target)),
  };
  const envFile = flagValue(args, "--write-env");
  if (!apply) {
    for (const line of formatPlan(picked, { home })) log(line);
    if (envFile) for (const line of await writeEnvFile(envFile, picked, picked.items.filter((item) => item.status === "new"))) log(line);
    log("");
    log(`Dry run: nothing was written. Apply with: muster migrate ${first} --apply`);
    return;
  }
  const todo = picked.items.filter((item) => item.status === "new").length;
  if (todo && !args.includes("--yes")) {
    const confirm = io.confirm ?? (process.stdin.isTTY ? defaultConfirm : undefined);
    if (!confirm) throw new Error("Pass --yes to apply without a terminal (review the plan first: muster migrate " + first + ").");
    for (const line of formatPlan(picked, { home, mode: "review" })) log(line);
    if (!(await confirm(`Apply ${todo} item${todo === 1 ? "" : "s"}? [y/N] `))) { log("Nothing applied."); return; }
  }
  const result = await applyPlan(picked, { cwd });
  for (const line of result.lines) log(line);
  if (envFile && result.applied.length) for (const line of await writeEnvFile(envFile, picked, result.applied)) log(line);
}

async function defaultConfirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}
