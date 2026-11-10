/**
 * Plugin marketplaces: git repos (or folders) with a `marketplace.json` that
 * lists plugins and where each one lives, pinned to a commit. Muster reads the
 * widely used `.claude-plugin/marketplace.json` shape, searches across every
 * added marketplace, and installs by name through the cold-read bundle
 * installer — no plugin code runs.
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { installPluginBundle, isGitPluginSource, type InstallPluginBundleOptions, type InstallPluginBundleResult } from "./plugin-bundles.js";
import { profileDataDir } from "./profiles.js";

const execFileAsync = promisify(execFile);

export interface MarketplaceRecord {
  readonly name: string;
  /** What the user added: a folder, a git URL, or `owner/repo`. */
  readonly source: string;
  /** Where its marketplace.json is read from. */
  readonly dir: string;
  /** True when Muster cloned it (and may update or delete the clone). */
  readonly cloned: boolean;
  readonly addedAt: string;
}

export interface MarketplacePlugin {
  readonly name: string;
  readonly marketplace: string;
  readonly description?: string;
  readonly category?: string;
  readonly version?: string;
  readonly tags: readonly string[];
  readonly sourceKind: "path" | "url" | "git-subdir" | "github";
  readonly entry: Record<string, unknown>;
}

const MANIFEST_PATHS = [join(".claude-plugin", "marketplace.json"), join(".codex-plugin", "marketplace.json"), "marketplace.json"];
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function registryPath(cwd: string): string {
  return join(profileDataDir(cwd), "plugin-marketplaces.json");
}

function clonesDir(cwd: string): string {
  return join(profileDataDir(cwd), "plugin-marketplaces");
}

async function readRegistry(cwd: string): Promise<MarketplaceRecord[]> {
  try {
    const parsed = JSON.parse(await readFile(registryPath(cwd), "utf8")) as { marketplaces?: MarketplaceRecord[] };
    return parsed.marketplaces ?? [];
  } catch {
    return [];
  }
}

async function writeRegistry(cwd: string, marketplaces: readonly MarketplaceRecord[]): Promise<void> {
  await mkdir(profileDataDir(cwd), { recursive: true });
  await writeFile(registryPath(cwd), JSON.stringify({ schemaVersion: 1, marketplaces }, null, 2));
}

async function readManifest(dir: string): Promise<{ name: string; plugins: Record<string, unknown>[] }> {
  for (const relative of MANIFEST_PATHS) {
    const text = await readFile(join(dir, relative), "utf8").catch(() => undefined);
    if (text === undefined) continue;
    const parsed = JSON.parse(text) as { name?: unknown; plugins?: unknown };
    if (typeof parsed.name !== "string" || !NAME_PATTERN.test(parsed.name)) throw new Error(`${relative} has no valid "name".`);
    return { name: parsed.name, plugins: Array.isArray(parsed.plugins) ? parsed.plugins.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object") : [] };
  }
  throw new Error(`No marketplace.json found in ${dir} (looked for ${MANIFEST_PATHS.join(", ")}).`);
}

/** `owner/repo` → its GitHub URL; anything else unchanged. */
function expandSource(source: string): string {
  return /^[\w.-]+\/[\w.-]+$/.test(source) && !source.startsWith(".") ? `https://github.com/${source}.git` : source;
}

const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1" };
const git = (args: string[], cwd?: string) => execFileAsync("git", ["-c", "core.hooksPath=/dev/null", "-c", "protocol.ext.allow=never", ...args], { cwd, env: GIT_ENV, maxBuffer: 16 * 1024 * 1024 });

export async function addMarketplace(spec: string, cwd = process.cwd()): Promise<{ readonly record: MarketplaceRecord; readonly plugins: number }> {
  const source = expandSource(spec);
  let dir: string;
  let cloned = false;
  if (isGitPluginSource(source)) {
    const staging = join(clonesDir(cwd), `.staging-${Date.now()}`);
    await mkdir(clonesDir(cwd), { recursive: true });
    await git(["clone", "-q", "--depth", "1", "--no-tags", "--single-branch", "--no-recurse-submodules", "--", source, staging]);
    const { name } = await readManifest(staging).catch(async (error) => { await rm(staging, { recursive: true, force: true }); throw error; });
    dir = join(clonesDir(cwd), name);
    await rm(dir, { recursive: true, force: true });
    await execFileAsync("mv", [staging, dir]);
    cloned = true;
  } else {
    dir = resolve(spec);
    if (!(await stat(dir).then((info) => info.isDirectory(), () => false))) throw new Error(`Marketplace source is not a folder or git URL: ${spec}`);
  }
  const manifest = await readManifest(dir);
  const record: MarketplaceRecord = { name: manifest.name, source: spec, dir, cloned, addedAt: new Date().toISOString() };
  const others = (await readRegistry(cwd)).filter((entry) => entry.name !== record.name);
  await writeRegistry(cwd, [...others, record]);
  return { record, plugins: manifest.plugins.length };
}

export async function listMarketplaces(cwd = process.cwd()): Promise<Array<MarketplaceRecord & { readonly plugins: number }>> {
  const records = await readRegistry(cwd);
  return Promise.all(records.map(async (record) => ({ ...record, plugins: (await readManifest(record.dir).catch(() => ({ plugins: [] }))).plugins.length })));
}

export async function removeMarketplace(name: string, cwd = process.cwd()): Promise<MarketplaceRecord> {
  const records = await readRegistry(cwd);
  const record = records.find((entry) => entry.name === name);
  if (!record) throw new Error(`No marketplace named "${name}". Run muster plugins marketplace list.`);
  if (record.cloned) await rm(record.dir, { recursive: true, force: true });
  await writeRegistry(cwd, records.filter((entry) => entry !== record));
  return record;
}

export async function updateMarketplace(name: string, cwd = process.cwd()): Promise<number> {
  const record = (await readRegistry(cwd)).find((entry) => entry.name === name);
  if (!record) throw new Error(`No marketplace named "${name}".`);
  if (record.cloned) {
    await git(["fetch", "-q", "--depth", "1", "origin"], record.dir);
    await git(["reset", "-q", "--hard", "FETCH_HEAD"], record.dir);
  }
  return (await readManifest(record.dir)).plugins.length;
}

function sourceKind(entry: Record<string, unknown>): MarketplacePlugin["sourceKind"] {
  const source = entry.source;
  if (typeof source === "string") return "path";
  const kind = (source as { source?: unknown } | undefined)?.source;
  return kind === "git-subdir" ? "git-subdir" : kind === "github" ? "github" : "url";
}

async function allPlugins(cwd: string): Promise<MarketplacePlugin[]> {
  const plugins: MarketplacePlugin[] = [];
  for (const record of await readRegistry(cwd)) {
    const manifest = await readManifest(record.dir).catch(() => undefined);
    for (const entry of manifest?.plugins ?? []) {
      if (typeof entry.name !== "string") continue;
      const tags = [...(Array.isArray(entry.tags) ? entry.tags : []), ...(Array.isArray(entry.keywords) ? entry.keywords : [])].filter((tag): tag is string => typeof tag === "string");
      plugins.push({
        name: entry.name,
        marketplace: record.name,
        ...(typeof entry.description === "string" ? { description: entry.description } : {}),
        ...(typeof entry.category === "string" ? { category: entry.category } : {}),
        ...(typeof entry.version === "string" ? { version: entry.version } : {}),
        tags,
        sourceKind: sourceKind(entry),
        entry,
      });
    }
  }
  return plugins;
}

/** Plugins whose name, description, category or tags match every word of the query; name matches first. */
export async function searchMarketplacePlugins(query: string, cwd = process.cwd()): Promise<MarketplacePlugin[]> {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const scored = (await allPlugins(cwd)).map((plugin) => {
    const name = plugin.name.toLowerCase();
    const haystack = [name, plugin.description ?? "", plugin.category ?? "", ...plugin.tags].join(" ").toLowerCase();
    if (!words.every((word) => haystack.includes(word))) return undefined;
    const score = words.reduce((sum, word) => sum + (name === word ? 100 : name.startsWith(word) ? 50 : name.includes(word) ? 20 : 1), 0);
    return { plugin, score };
  }).filter((item): item is { plugin: MarketplacePlugin; score: number } => Boolean(item));
  return scored.sort((left, right) => right.score - left.score || left.plugin.name.localeCompare(right.plugin.name)).map((item) => item.plugin);
}

/** `name` or `name@marketplace` → one plugin; ambiguous names list the choices. */
export async function resolveMarketplacePlugin(spec: string, cwd = process.cwd()): Promise<MarketplacePlugin | undefined> {
  const at = spec.lastIndexOf("@");
  const name = at > 0 ? spec.slice(0, at) : spec;
  const market = at > 0 ? spec.slice(at + 1) : undefined;
  const matches = (await allPlugins(cwd)).filter((plugin) => plugin.name === name && (!market || plugin.marketplace === market));
  if (matches.length > 1) throw new Error(`"${name}" is in several marketplaces: ${matches.map((plugin) => `${plugin.name}@${plugin.marketplace}`).join(", ")}. Name one.`);
  return matches[0];
}

const INLINE_FIELDS = ["name", "version", "description", "author", "homepage", "license", "keywords", "mcpServers", "skills", "commands", "agents", "hooks"];

export async function installMarketplacePlugin(spec: string, options: Omit<InstallPluginBundleOptions, "subdir" | "inlineManifest" | "marketplace"> = {}): Promise<InstallPluginBundleResult & { readonly plugin: MarketplacePlugin }> {
  const cwd = options.cwd ?? process.cwd();
  const plugin = await resolveMarketplacePlugin(spec, cwd);
  if (!plugin) throw new Error(`No plugin "${spec}" in your marketplaces. Try muster plugins search <words>.`);
  const record = (await readRegistry(cwd)).find((entry) => entry.name === plugin.marketplace)!;
  const source = plugin.entry.source;
  let location: string;
  let subdir: string | undefined;
  let commit: string | undefined;
  if (typeof source === "string") {
    location = record.dir;
    subdir = source.replace(/^\.\//, "") || undefined;
    // A plugin that lives inside the marketplace repo is pinned by the marketplace's commit.
    commit = (await git(["rev-parse", "HEAD"], record.dir).catch(() => undefined))?.stdout.trim() || undefined;
    if (commit && !/^[0-9a-f]{40}$/.test(commit)) commit = undefined;
  } else {
    const spec_ = source as { source?: string; url?: string; repo?: string; path?: string; ref?: string; sha?: string };
    const url = spec_.source === "github" && spec_.repo ? `https://github.com/${spec_.repo}.git` : spec_.url;
    if (!url) throw new Error(`Marketplace entry "${plugin.name}" has no source url.`);
    const pin = spec_.sha ?? spec_.ref;
    location = pin ? `${url}#${pin}` : url;
    subdir = spec_.path;
  }
  const inlineManifest = plugin.entry.strict === false
    ? Object.fromEntries(INLINE_FIELDS.filter((key) => plugin.entry[key] !== undefined).map((key) => [key, plugin.entry[key]]))
    : undefined;
  const result = await installPluginBundle(location, { ...options, ...(subdir ? { subdir } : {}), ...(inlineManifest ? { inlineManifest } : {}), ...(commit ? { commit } : {}), marketplace: plugin.marketplace });
  return { ...result, plugin };
}
