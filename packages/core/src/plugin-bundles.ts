/**
 * Plugin bundles: install plugins written for other agents (Agent Plugins v1,
 * Claude Code, Codex) by reading their manifests cold — never importing,
 * building or running anything in them. What a bundle contributes that needs
 * no code (MCP server definitions and SKILL.md skills) becomes active on every
 * runtime; everything else (commands, agents, hooks, apps) is recorded as not
 * activated.
 *
 * Installed bundles live in `<profile data>/plugins/<id>` and are recorded in
 * `<profile data>/plugins/plugins.lock.json` (source, commit, content digest).
 * Their MCP servers go into `config.tools.mcp.servers` as `<id>__<server>`
 * with `origin.plugin = <id>`, so removal deletes exactly them. Their skills
 * are discovered in place by skills.ts from the lock's `skillRoots`.
 */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile, copyFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { loadConfig, saveConfig } from "./config.js";
import type { McpServerConfig } from "./mcp.js";
import { profileDataDir } from "./profiles.js";
import type { MusterConfig } from "./types.js";

const execFileAsync = promisify(execFile);

export type PluginBundleFormat = "agent-plugins-v1" | "claude-code" | "codex";
export type PluginBundleRisk = "low" | "medium" | "high";

export interface PluginBundleServer {
  /** Name in `config.tools.mcp.servers`: `<plugin id>__<server>`. */
  readonly name: string;
  /** Name inside the bundle. */
  readonly bundleName: string;
  readonly config: McpServerConfig;
  /** `remote-url`, `command-outside-bundle`. */
  readonly flags: readonly string[];
}

export interface PluginBundleSkill {
  readonly name: string;
  readonly description: string;
  /** Path relative to the bundle root. */
  readonly path: string;
}

export interface PluginBundleIgnoredPart {
  readonly part: string;
  readonly reason: string;
}

export interface PluginBundleCommand {
  readonly name: string;
  readonly description?: string;
  readonly argumentHint?: string;
  /** Relative to the bundle root in an inspection; absolute in the lock. */
  readonly path: string;
}

export interface PluginBundleInspection {
  readonly path: string;
  readonly installRoot: string;
  readonly format: PluginBundleFormat;
  readonly manifestPath: string;
  readonly id: string;
  readonly version?: string;
  readonly description?: string;
  readonly servers: readonly PluginBundleServer[];
  readonly skills: readonly PluginBundleSkill[];
  /** Skill directories relative to the bundle root. */
  readonly skillRoots: readonly string[];
  /** Markdown prompt commands (`commands/*.md`), usable as chat slash commands. */
  readonly commands: readonly PluginBundleCommand[];
  readonly ignored: readonly PluginBundleIgnoredPart[];
  readonly risk: PluginBundleRisk;
  readonly permissions: readonly string[];
  readonly status: "ready" | "blocked";
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
}

export type PluginBundleSource =
  | { readonly type: "local"; readonly path: string; readonly marketplace?: string }
  | { readonly type: "git"; readonly url: string; readonly ref?: string; readonly path?: string; readonly marketplace?: string };

export interface PluginBundleLockEntry {
  readonly id: string;
  readonly format: PluginBundleFormat;
  readonly version?: string;
  readonly source: PluginBundleSource;
  /** Resolved 40-hex commit for git sources. */
  readonly commit?: string;
  readonly digest: string;
  readonly installedPath: string;
  readonly installedAt: string;
  readonly mcpServers: readonly string[];
  readonly skills: readonly string[];
  /** Absolute skill directories, scanned by skills.ts. */
  readonly skillRoots: readonly string[];
  /** Absolute paths to the bundle's prompt commands (older locks have none). */
  readonly commands?: readonly PluginBundleCommand[];
  readonly ignored: readonly PluginBundleIgnoredPart[];
  readonly risk: PluginBundleRisk;
}

export interface PluginBundleLock {
  readonly schemaVersion: 1;
  readonly generatedBy: "muster-plugin-bundles";
  readonly entries: Readonly<Record<string, PluginBundleLockEntry>>;
}

const MANIFESTS: readonly { readonly format: PluginBundleFormat; readonly path: string }[] = [
  { format: "claude-code", path: join(".claude-plugin", "plugin.json") },
  { format: "codex", path: join(".codex-plugin", "plugin.json") },
  { format: "agent-plugins-v1", path: "plugin.json" },
];

/** Variables bundles use for "the directory this plugin is installed in". */
const ROOT_VARIABLES = ["CLAUDE_PLUGIN_ROOT", "CODEX_PLUGIN_ROOT", "PLUGIN_ROOT", "AGENT_PLUGIN_ROOT"];
const NOT_ACTIVATED = "not activated (needs register API)";
const MUSTER_EXTENSION = "com.musterhq.muster";
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function pluginBundlesDir(cwd = process.cwd()): string {
  return join(profileDataDir(cwd), "plugins");
}

export function pluginBundleLockPath(cwd = process.cwd()): string {
  return join(pluginBundlesDir(cwd), "plugins.lock.json");
}

/** True for sources `install` treats as git (optionally `<url>#<ref>`). */
export function isGitPluginSource(source: string): boolean {
  return /^(https?|ssh|git|file):\/\//.test(source) || /^[\w.-]+@[\w.-]+:/.test(source);
}

export async function detectPluginBundle(dir: string): Promise<{ readonly format: PluginBundleFormat; readonly manifestPath: string } | undefined> {
  for (const candidate of MANIFESTS) {
    const path = join(dir, candidate.path);
    if (await isFile(path)) return { format: candidate.format, manifestPath: path };
  }
  return undefined;
}

/**
 * Read a bundle without running it. `installRoot` is where it will live once
 * installed; root variables and relative paths are resolved against it.
 */
export async function inspectPluginBundle(dir: string, options: { readonly installRoot?: string; readonly id?: string } = {}): Promise<PluginBundleInspection> {
  const root = resolve(dir);
  const detected = await detectPluginBundle(root);
  if (!detected) throw new Error(`No plugin bundle manifest in ${root} (looked for .claude-plugin/plugin.json, .codex-plugin/plugin.json, plugin.json).`);
  const blockers: string[] = [];
  const warnings: string[] = [];
  const ignored: PluginBundleIgnoredPart[] = [];
  let manifest: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(await readFile(detected.manifestPath, "utf8")) as unknown;
    if (isRecord(parsed)) manifest = parsed;
    else blockers.push("The plugin manifest must be a JSON object.");
  } catch (error) {
    blockers.push(`The plugin manifest is not valid JSON: ${(error as Error).message}`);
  }
  const rawName = typeof manifest.name === "string" && manifest.name.trim() ? manifest.name.trim() : basename(root);
  const id = options.id ?? pluginIdFrom(rawName);
  if (!ID_PATTERN.test(id)) blockers.push(`Plugin id "${id}" must be lowercase letters, digits, - or _.`);
  const installRoot = resolve(options.installRoot ?? root);
  const version = typeof manifest.version === "string" ? manifest.version : undefined;
  const description = typeof manifest.description === "string" ? manifest.description : undefined;

  // Paths a manifest names must stay inside the bundle.
  const inside = (field: string, value: string): string | undefined => {
    const target = resolve(root, value);
    if (isAbsolute(value) || !isWithin(root, target)) {
      blockers.push(`${field} points outside the bundle: ${value}`);
      return undefined;
    }
    return target;
  };
  const declaredPaths = (field: string, fallback: readonly string[]): string[] => {
    const value = manifest[field];
    const list = typeof value === "string" ? [value] : Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : fallback;
    return list.map((item) => inside(field, item)).filter((item): item is string => Boolean(item));
  };

  // MCP servers: inline object in the manifest, manifest-named files, or the format's default files.
  const servers: PluginBundleServer[] = [];
  const rawServers: Record<string, unknown> = {};
  const declared = manifest.mcpServers;
  if (isRecord(declared)) {
    Object.assign(rawServers, unwrapMcpDocument(declared));
  } else {
    const files = declared === undefined
      ? (detected.format === "agent-plugins-v1" ? ["mcp.json", ".mcp.json"] : [".mcp.json"]).map((file) => join(root, file))
      : declaredPaths("mcpServers", []);
    for (const file of files) {
      if (!(await isFile(file))) {
        if (declared !== undefined) blockers.push(`mcpServers file is missing: ${relative(root, file)}`);
        continue;
      }
      try {
        Object.assign(rawServers, unwrapMcpDocument(JSON.parse(await readFile(file, "utf8")) as unknown));
      } catch (error) {
        blockers.push(`${relative(root, file)} is not valid JSON: ${(error as Error).message}`);
      }
      if (declared === undefined) break;
    }
  }
  for (const [bundleName, raw] of Object.entries(rawServers)) {
    const server = normalizeBundleServer(id, bundleName, raw, { root, installRoot, blockers, warnings });
    if (server) servers.push(server);
  }

  // Skills.
  const skillDirs = declaredPaths("skills", ["skills"]);
  const skillRoots: string[] = [];
  const skills: PluginBundleSkill[] = [];
  for (const skillDir of skillDirs) {
    if (!(await isDirectory(skillDir))) continue;
    skillRoots.push(relative(root, skillDir) || ".");
    for (const file of await findSkillFiles(skillDir)) {
      const head = readSkillHead(await readFile(file, "utf8"));
      if (!head) {
        warnings.push(`${relative(root, file)} has no name/description frontmatter; it will not be listed.`);
        continue;
      }
      skills.push({ ...head, path: relative(root, file) });
    }
  }

  // Prompt commands: Markdown with front matter, read cold, never executed.
  const commands: PluginBundleCommand[] = [];
  for (const commandDir of declaredPaths("commands", ["commands"])) {
    if (!(await isDirectory(commandDir))) continue;
    for (const entry of (await readdir(commandDir)).filter((name) => name.endsWith(".md")).sort()) {
      const name = entry.slice(0, -3);
      if (!/^[a-z0-9][a-z0-9:_-]{0,63}$/i.test(name)) continue;
      const head = readCommandHead(await readFile(join(commandDir, entry), "utf8"));
      commands.push({ name, ...head, path: relative(root, join(commandDir, entry)) });
    }
  }

  // Parts that would need plugin code or a register API.
  const optionalParts: readonly { part: string; field?: string; paths: readonly string[] }[] = [
    ...(commands.length ? [] : [{ part: "commands", field: "commands", paths: ["commands"] }]),
    { part: "agents", field: "agents", paths: ["agents"] },
    { part: "hooks", field: "hooks", paths: ["hooks", join("hooks", "hooks.json")] },
    { part: "apps", field: "apps", paths: [".app.json"] },
    { part: "outputStyles", field: "outputStyles", paths: ["output-styles"] },
    { part: "lspServers", field: "lspServers", paths: [".lsp.json"] },
  ];
  for (const { part, field, paths } of optionalParts) {
    const declaredHere = field !== undefined && manifest[field] !== undefined;
    let present = declaredHere;
    for (const path of paths) if (!present && await exists(join(root, path))) present = true;
    if (present) ignored.push({ part, reason: NOT_ACTIVATED });
  }
  if (isRecord(manifest.userConfig)) ignored.push({ part: "userConfig", reason: "not prompted; ${user_config.*} values stay unresolved" });
  const pkg = await readJson(join(root, "package.json"));
  if (isRecord(pkg) && isRecord(pkg.scripts) && Object.keys(pkg.scripts).length) {
    ignored.push({ part: "package.json scripts", reason: `never run (${Object.keys(pkg.scripts).join(", ")})` });
  }

  // Governance metadata, when the bundle declares any.
  const extensions = isRecord(manifest.extensions) ? manifest.extensions : {};
  const musterExt = isRecord(extensions[MUSTER_EXTENSION]) ? extensions[MUSTER_EXTENSION] as Record<string, unknown> : {};
  const declaredRisk = [musterExt.risk, manifest.risk].find((value): value is PluginBundleRisk => value === "low" || value === "medium" || value === "high");
  const permissionsSource = Array.isArray(musterExt.permissions) ? musterExt.permissions : Array.isArray(manifest.permissions) ? manifest.permissions : [];
  const permissions = permissionsSource.filter((item): item is string => typeof item === "string");
  const flagged = servers.some((server) => server.flags.length > 0);
  const risk: PluginBundleRisk = declaredRisk === "high" ? "high" : declaredRisk === "medium" || flagged ? "medium" : declaredRisk ?? "low";
  if (!servers.length && !skills.length && !commands.length) warnings.push("The bundle contributes no MCP servers, skills or commands; nothing would be activated.");

  return {
    path: root,
    installRoot,
    format: detected.format,
    manifestPath: relative(root, detected.manifestPath),
    id,
    ...(version ? { version } : {}),
    ...(description ? { description } : {}),
    servers,
    skills,
    skillRoots,
    commands,
    ignored,
    risk,
    permissions,
    status: blockers.length ? "blocked" : "ready",
    blockers,
    warnings,
  };
}

export interface InstallPluginBundleOptions {
  readonly cwd?: string;
  /** Install only this subdirectory of the source (marketplace `git-subdir`). */
  readonly subdir?: string;
  /** A marketplace entry's own description, used when the plugin directory has no manifest (`strict: false`). */
  readonly inlineManifest?: Record<string, unknown>;
  /** The marketplace this install came from (recorded in the lock). */
  readonly marketplace?: string;
  /** Commit to record when the source itself is a folder inside a cloned repo (marketplace path entries). */
  readonly commit?: string;
  readonly allowHighRisk?: boolean;
  /** Replace an installed bundle with the same id. */
  readonly force?: boolean;
  readonly now?: Date;
}

export interface InstallPluginBundleResult {
  readonly entry: PluginBundleLockEntry;
  readonly inspection: PluginBundleInspection;
}

/** Fetch a source (local directory or git URL) into a fresh directory, without running anything in it. */
async function stageSource(source: string, into: string, subdir?: string): Promise<{ readonly source: PluginBundleSource; readonly commit?: string }> {
  if (subdir !== undefined && (subdir.startsWith("/") || subdir.split(/[\\/]/).includes(".."))) throw new Error(`Plugin subdirectory escapes its source: ${subdir}`);
  if (isGitPluginSource(source)) {
    const hash = source.indexOf("#");
    const url = hash >= 0 ? source.slice(0, hash) : source;
    const ref = hash >= 0 ? source.slice(hash + 1) || undefined : undefined;
    const checkout = `${into}.git-${randomUUID()}`;
    // No hooks (core.hooksPath), no submodules, no LFS smudge filters, no prompts.
    const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1" };
    const git = (args: string[], cwd?: string) => execFileAsync("git", ["-c", "core.hooksPath=/dev/null", "-c", "protocol.ext.allow=never", ...args], { cwd, env: gitEnv, maxBuffer: 16 * 1024 * 1024 });
    try {
      if (ref && /^[0-9a-f]{40}$/i.test(ref)) {
        await mkdir(checkout, { recursive: true });
        await git(["init", "-q"], checkout);
        await git(["fetch", "-q", "--depth", "1", "--no-tags", url, ref], checkout);
        await git(["checkout", "-q", "--detach", "FETCH_HEAD"], checkout);
      } else {
        await git(["clone", "-q", "--depth", "1", "--no-tags", "--single-branch", "--no-recurse-submodules", ...(ref ? ["--branch", ref] : []), "--", url, checkout]);
      }
      const commit = (await git(["rev-parse", "HEAD"], checkout)).stdout.trim();
      if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`Could not resolve the commit of ${url}.`);
      const from = subdir ? join(checkout, subdir) : checkout;
      if (!(await stat(from).then((info) => info.isDirectory(), () => false))) throw new Error(`Plugin subdirectory not found in ${url}: ${subdir}`);
      await copyTree(from, into);
      return { source: { type: "git", url, ...(ref ? { ref } : {}), ...(subdir ? { path: subdir } : {}) }, commit };
    } finally {
      await rm(checkout, { recursive: true, force: true });
    }
  }
  const path = subdir ? resolve(source, subdir) : resolve(source);
  if (!(await stat(path).then((info) => info.isDirectory(), () => false))) throw new Error(`Plugin source is not a directory or git URL: ${source}`);
  await copyTree(path, into);
  return { source: { type: "local", path } };
}

/** Inspect a source the way `install` would see it, without installing. */
export async function inspectPluginBundleSource(source: string, cwd = process.cwd()): Promise<PluginBundleInspection & { readonly commit?: string }> {
  if (!isGitPluginSource(source)) {
    const probe = await inspectPluginBundle(source);
    return inspectPluginBundle(source, { installRoot: join(pluginBundlesDir(cwd), probe.id) });
  }
  const scratch = await mkdtemp(join(tmpdir(), "muster-plugin-inspect-"));
  try {
    const staged = join(scratch, "bundle");
    const { commit } = await stageSource(source, staged);
    const probe = await inspectPluginBundle(staged);
    const inspection = await inspectPluginBundle(staged, { installRoot: join(pluginBundlesDir(cwd), probe.id) });
    return { ...inspection, path: source, ...(commit ? { commit } : {}) };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export async function installPluginBundle(source: string, options: InstallPluginBundleOptions = {}): Promise<InstallPluginBundleResult> {
  const cwd = options.cwd ?? process.cwd();
  const pluginsDir = pluginBundlesDir(cwd);
  await mkdir(pluginsDir, { recursive: true, mode: 0o700 });
  const staging = join(pluginsDir, `.staging-${randomUUID()}`);
  try {
    const stagedRaw = await stageSource(source, staging, options.subdir);
    const withMarket = options.marketplace ? { ...stagedRaw, source: { ...stagedRaw.source, marketplace: options.marketplace } } : stagedRaw;
    const staged = !withMarket.commit && options.commit ? { ...withMarket, commit: options.commit } : withMarket;
    if (options.inlineManifest && !(await detectPluginBundle(staging))) {
      // `strict: false` marketplace entries describe the plugin themselves.
      await mkdir(join(staging, ".claude-plugin"), { recursive: true });
      await writeFile(join(staging, ".claude-plugin", "plugin.json"), JSON.stringify(options.inlineManifest, null, 2));
    }
    const probe = await inspectPluginBundle(staging);
    const installedPath = join(pluginsDir, probe.id);
    const inspection = await inspectPluginBundle(staging, { installRoot: installedPath });
    if (inspection.status === "blocked") throw new Error(`Plugin bundle "${inspection.id}" is blocked: ${inspection.blockers.join("; ")}`);

    const config = await loadConfig(cwd);
    const policy = config.plugins;
    if (policy?.deny?.includes(inspection.id)) throw new Error(`Plugin "${inspection.id}" is denied by plugins.deny.`);
    if (policy?.allow?.length && !policy.allow.includes(inspection.id)) throw new Error(`Plugin "${inspection.id}" is not in plugins.allow.`);
    if (inspection.risk === "high" && !options.allowHighRisk) {
      throw new Error(`Plugin "${inspection.id}" declares high risk (permissions: ${inspection.permissions.join(",") || "-"}). Re-run with --allow-high-risk to install it.`);
    }
    const lock = await readPluginBundleLock(cwd);
    const previous = lock.entries[inspection.id];
    if (previous && !options.force) throw new Error(`Plugin "${inspection.id}" is already installed. Run muster plugins remove ${inspection.id} first, or pass --force to replace it.`);
    const existing = config.tools?.mcp?.servers ?? {};
    for (const server of inspection.servers) {
      const current = existing[server.name];
      if (current && current.origin?.plugin !== inspection.id) throw new Error(`MCP server "${server.name}" already exists and does not belong to plugin "${inspection.id}".`);
    }

    const digest = await digestTree(staging);
    await rm(installedPath, { recursive: true, force: true });
    await rename(staging, installedPath);

    const servers: Record<string, McpServerConfig> = withoutPluginServers(existing, inspection.id);
    for (const server of inspection.servers) servers[server.name] = server.config;
    await saveConfig(withServers(config, servers), cwd);

    const entry: PluginBundleLockEntry = {
      id: inspection.id,
      format: inspection.format,
      ...(inspection.version ? { version: inspection.version } : {}),
      source: staged.source,
      ...(staged.commit ? { commit: staged.commit } : {}),
      digest,
      installedPath,
      installedAt: (options.now ?? new Date()).toISOString(),
      mcpServers: inspection.servers.map((server) => server.name),
      skills: inspection.skills.map((skill) => skill.name),
      skillRoots: inspection.skillRoots.map((dir) => resolve(installedPath, dir)),
      commands: inspection.commands.map((command) => ({ ...command, path: resolve(installedPath, command.path) })),
      ignored: inspection.ignored,
      risk: inspection.risk,
    };
    await writePluginBundleLock(cwd, { ...lock, entries: { ...lock.entries, [entry.id]: entry } });
    return { entry, inspection };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function listPluginBundles(cwd = process.cwd()): Promise<PluginBundleLockEntry[]> {
  const lock = await readPluginBundleLock(cwd);
  return Object.values(lock.entries).sort((a, b) => a.id.localeCompare(b.id));
}

export async function removePluginBundle(id: string, cwd = process.cwd()): Promise<PluginBundleLockEntry> {
  const lock = await readPluginBundleLock(cwd);
  const entry = lock.entries[id];
  if (!entry) throw new Error(`Plugin bundle "${id}" is not installed. Run muster plugins list.`);
  const config = await loadConfig(cwd);
  const servers = withoutPluginServers(config.tools?.mcp?.servers ?? {}, id);
  await saveConfig(withServers(config, servers), cwd);
  const { [id]: _removed, ...rest } = lock.entries;
  await writePluginBundleLock(cwd, { ...lock, entries: rest });
  if (isWithin(pluginBundlesDir(cwd), entry.installedPath) && resolve(entry.installedPath) !== resolve(pluginBundlesDir(cwd))) {
    await rm(entry.installedPath, { recursive: true, force: true });
  }
  return entry;
}

export async function readPluginBundleLock(cwd = process.cwd()): Promise<PluginBundleLock> {
  try {
    return parseLock(JSON.parse(await readFile(pluginBundleLockPath(cwd), "utf8")) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyLock();
    throw error;
  }
}

/**
 * Skill directories of installed bundles, for skills.ts discovery. Sync and
 * forgiving: a missing or malformed lock means no plugin skills.
 */
export function pluginBundleSkillRoots(cwd = process.cwd()): string[] {
  let lock: PluginBundleLock;
  try {
    lock = parseLock(JSON.parse(readFileSync(pluginBundleLockPath(cwd), "utf8")) as unknown);
  } catch {
    return [];
  }
  const base = pluginBundlesDir(cwd);
  return Object.values(lock.entries)
    .sort((a, b) => a.id.localeCompare(b.id))
    .flatMap((entry) => entry.skillRoots)
    .filter((dir) => isWithin(base, dir));
}

async function writePluginBundleLock(cwd: string, lock: PluginBundleLock): Promise<void> {
  const path = pluginBundleLockPath(cwd);
  await mkdir(pluginBundlesDir(cwd), { recursive: true, mode: 0o700 });
  const sorted = Object.fromEntries(Object.entries(lock.entries).sort(([a], [b]) => a.localeCompare(b)));
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify({ schemaVersion: 1, generatedBy: "muster-plugin-bundles", entries: sorted }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(tmp, path);
}

function parseLock(raw: unknown): PluginBundleLock {
  if (!isRecord(raw) || raw.schemaVersion !== 1 || raw.generatedBy !== "muster-plugin-bundles" || !isRecord(raw.entries)) {
    throw new Error("Plugin bundle lock must have schemaVersion=1, generatedBy=muster-plugin-bundles and entries.");
  }
  return { schemaVersion: 1, generatedBy: "muster-plugin-bundles", entries: raw.entries as Record<string, PluginBundleLockEntry> };
}

function emptyLock(): PluginBundleLock {
  return { schemaVersion: 1, generatedBy: "muster-plugin-bundles", entries: {} };
}

function withoutPluginServers(servers: Readonly<Record<string, McpServerConfig>>, id: string): Record<string, McpServerConfig> {
  return Object.fromEntries(Object.entries(servers).filter(([, server]) => server.origin?.plugin !== id));
}

function withServers(config: MusterConfig, servers: Record<string, McpServerConfig>): MusterConfig {
  return { ...config, tools: { ...(config.tools ?? {}), mcp: { ...(config.tools?.mcp ?? {}), servers } } };
}

/** `{ mcpServers: {...} }` or a bare `{ name: server }` map. */
function unwrapMcpDocument(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  if (isRecord(value.mcpServers)) return value.mcpServers;
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => isRecord(entry) && (typeof entry.command === "string" || typeof entry.url === "string")));
}

function normalizeBundleServer(
  id: string,
  bundleName: string,
  raw: unknown,
  context: { readonly root: string; readonly installRoot: string; readonly blockers: string[]; readonly warnings: string[] },
): PluginBundleServer | undefined {
  const name = `${id}__${bundleName.replace(/[^A-Za-z0-9_-]/g, "-")}`;
  if (!isRecord(raw)) {
    context.warnings.push(`MCP server "${bundleName}" is not an object; skipped.`);
    return undefined;
  }
  if (raw.enabled === false || raw.disabled === true) {
    context.warnings.push(`MCP server "${bundleName}" is disabled by the bundle; skipped.`);
    return undefined;
  }
  const expandRoot = (value: string) => ROOT_VARIABLES.reduce((text, variable) => text.split(`\${${variable}}`).join(context.installRoot), value);
  const usesRoot = (value: string) => ROOT_VARIABLES.some((variable) => value.includes(`\${${variable}}`));
  const flags: string[] = [];
  const extras: Pick<McpServerConfig, "tools" | "limits"> = {
    ...(stringList(raw.enabled_tools).length || stringList(raw.disabled_tools).length
      ? { tools: { ...(stringList(raw.enabled_tools).length ? { include: stringList(raw.enabled_tools) } : {}), ...(stringList(raw.disabled_tools).length ? { exclude: stringList(raw.disabled_tools) } : {}) } }
      : {}),
    ...(typeof raw.tool_timeout_sec === "number" && raw.tool_timeout_sec > 0 ? { limits: { toolTimeoutMs: raw.tool_timeout_sec * 1000 } } : {}),
  };
  const origin = { plugin: id };
  if (typeof raw.url === "string") {
    const headers = isRecord(raw.headers) ? Object.fromEntries(Object.entries(raw.headers).filter(([, value]) => typeof value === "string").map(([key, value]) => [key, expandRoot(value as string)])) : {};
    const url = expandRoot(raw.url);
    if (!/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])([:/]|$)/.test(url)) flags.push("remote-url");
    return {
      name,
      bundleName,
      flags,
      config: { transport: { kind: "http", url, ...(Object.keys(headers).length ? { headers } : {}) }, ...extras, origin },
    };
  }
  if (typeof raw.command !== "string" || !raw.command.trim()) {
    context.warnings.push(`MCP server "${bundleName}" has neither a command nor a url; skipped.`);
    return undefined;
  }
  // Relative paths are relative to the server's cwd, which defaults to the bundle root.
  const declaredCwd = typeof raw.cwd === "string" ? raw.cwd : undefined;
  const sourceBase = resolve(context.root, declaredCwd && !usesRoot(declaredCwd) ? declaredCwd : ".");
  if (declaredCwd && !usesRoot(declaredCwd) && !isWithin(context.root, sourceBase)) context.blockers.push(`MCP server "${bundleName}" cwd points outside the bundle: ${declaredCwd}`);
  const installBase = resolve(context.installRoot, relative(context.root, sourceBase));
  const localize = (value: string, field: string): string => {
    if (usesRoot(value)) return expandRoot(value);
    if (value.startsWith("./") || value.startsWith("../")) {
      if (!isWithin(context.root, resolve(sourceBase, value))) context.blockers.push(`MCP server "${bundleName}" ${field} points outside the bundle: ${value}`);
      return resolve(installBase, value);
    }
    return value;
  };
  const command = localize(raw.command, "command");
  const args = stringList(raw.args).map((arg) => localize(arg, "argument"));
  const env: Record<string, string> = {};
  if (isRecord(raw.env)) for (const [key, value] of Object.entries(raw.env)) if (typeof value === "string") env[key] = expandRoot(value);
  // Codex `env_vars`: names to forward from the user's environment — kept as references.
  for (const key of stringList(raw.env_vars)) if (!(key in env)) env[key] = `\${${key}}`;
  const insideBundle = (value: string): boolean => usesRoot(value)
    || ((value.startsWith("./") || value.startsWith("../")) && isWithin(context.root, resolve(sourceBase, value)))
    || (isAbsolute(value) && isWithin(context.root, value));
  // A bare interpreter (`node`, `python3`, …) whose script is a bundle file runs bundle code, not code from elsewhere.
  const script = stringList(raw.args).find((arg) => !arg.startsWith("-"));
  const bundledScript = BUNDLE_INTERPRETERS.has(raw.command) && script !== undefined && insideBundle(script);
  const commandInside = insideBundle(raw.command) || bundledScript;
  if (!commandInside) flags.push("command-outside-bundle");
  return {
    name,
    bundleName,
    flags,
    config: {
      transport: {
        kind: "stdio",
        command,
        ...(args.length ? { args } : {}),
        ...(Object.keys(env).length ? { env } : {}),
        ...(declaredCwd ? { cwd: usesRoot(declaredCwd) ? expandRoot(declaredCwd) : installBase } : {}),
      },
      ...extras,
      origin,
    },
  };
}

const BUNDLE_INTERPRETERS = new Set(["node", "python", "python3", "bun", "deno", "sh", "bash"]);

function pluginIdFrom(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}

/** The `name` and `description` a SKILL.md must have for skills.ts to list it. */
function readSkillHead(raw: string): { name: string; description: string } | undefined {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match) return undefined;
  const field = (key: string) => match[1]!.split(/\r?\n/).find((line) => line.startsWith(`${key}:`))?.slice(key.length + 1).trim().replace(/^(["'])(.*)\1$/, "$2");
  const name = field("name");
  const description = field("description");
  return name && description ? { name, description } : undefined;
}

async function findSkillFiles(root: string, depth = 0): Promise<string[]> {
  if (depth > 3) return [];
  const found: string[] = [];
  let entries: import("node:fs").Dirent[] = [];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".")) continue;
    const path = join(root, entry.name);
    if (entry.isFile() && entry.name === "SKILL.md") found.push(path);
    else if (entry.isDirectory()) found.push(...await findSkillFiles(path, depth + 1));
  }
  return found;
}

/** Copy files and directories only: no `.git`, and no symlinks (they could point anywhere). */
async function copyTree(from: string, to: string): Promise<void> {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory()) await copyTree(source, target);
    else if (entry.isFile()) {
      await copyFile(source, target);
      await chmod(target, (await stat(source)).mode & 0o777);
    }
  }
}

/** sha256 over every file's relative path and content hash, in sorted order. */
async function digestTree(root: string): Promise<string> {
  const lines: string[] = [];
  const visit = async (dir: string): Promise<void> => {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) lines.push(`${relative(root, path).split(sep).join("/")}\0${createHash("sha256").update(await readFile(path)).digest("hex")}`);
    }
  };
  await visit(root);
  return `sha256:${createHash("sha256").update(lines.join("\n")).digest("hex")}`;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function isWithin(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(() => true, () => false);
}

async function isFile(path: string): Promise<boolean> {
  return lstat(path).then((info) => info.isFile(), () => false);
}

/** lstat: a symlinked directory inside a bundle is not followed. */
async function isDirectory(path: string): Promise<boolean> {
  return lstat(path).then((info) => info.isDirectory(), () => false);
}

/** `description` and `argument-hint` from a command's front matter. */
function readCommandHead(text: string): { description?: string; argumentHint?: string } {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const field = (key: string) => {
    const line = match[1]!.split(/\r?\n/).find((row) => row.startsWith(`${key}:`));
    const value = line?.slice(key.length + 1).trim().replace(/^["']|["']$/g, "");
    return value || undefined;
  };
  const description = field("description");
  const argumentHint = field("argument-hint");
  return { ...(description ? { description } : {}), ...(argumentHint ? { argumentHint } : {}) };
}

export interface InstalledPluginCommand extends PluginBundleCommand {
  readonly plugin: string;
}

/** Every installed bundle's prompt commands. */
export async function listPluginCommands(cwd = process.cwd()): Promise<InstalledPluginCommand[]> {
  const entries = await listPluginBundles(cwd);
  return entries.flatMap((entry) => (entry.commands ?? []).map((command) => ({ ...command, plugin: entry.id })));
}

export const SHELL_SNIPPET_NOTE = "(a shell snippet was here; shell snippets in plugin commands are not executed)";

/**
 * A command's prompt for one use: front matter dropped, `$ARGUMENTS` and
 * `$1`…`$9` filled, and every `` !`cmd` `` snippet replaced by a note — plugin
 * commands never run shell on the user's machine.
 */
export async function expandPluginCommand(command: PluginBundleCommand, args: string): Promise<string> {
  const text = await readFile(command.path, "utf8");
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  const positional = args.trim() ? args.trim().split(/\s+/) : [];
  return body
    .replace(/!`[^`]*`/g, SHELL_SNIPPET_NOTE)
    .replace(/\$ARGUMENTS/g, args.trim())
    .replace(/\$(\d)/g, (_, index: string) => positional[Number(index) - 1] ?? "")
    .trim();
}
