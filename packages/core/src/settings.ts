import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { defaultConfig } from "./config.js";
import { profileConfigPath, profileConfigWritePath } from "./profiles.js";

/**
 * The settings registry: one typed row per user-facing setting. `muster config`,
 * the `/settings` panel and chat's starting state are all generated from this
 * table, so a key cannot exist in one surface and not the others.
 *
 * A value lives at its key's dotted path in the config JSON (`chat.access` →
 * `{ "chat": { "access": … } }`). Resolution is project → global → default.
 * Secrets are never values: string settings refuse anything shaped like a key.
 */

export type SettingScope = "project" | "global";
export type SettingType = "enum" | "boolean" | "string" | "number";
export type SettingValue = string | boolean | number;
export type SettingTab = "models" | "permissions" | "appearance" | "memory";

export interface SettingOption {
  readonly value: string;
  readonly description: string;
}

export interface SettingDef {
  readonly key: string;
  readonly label: string;
  readonly tab: SettingTab;
  readonly type: SettingType;
  readonly default: SettingValue;
  readonly options?: readonly SettingOption[];
  readonly description: string;
  /** Where a plain `muster config set` writes. */
  readonly scope: SettingScope;
  /** Where the value may be saved at all. */
  readonly scopes: readonly SettingScope[];
  /** Extra check after type parsing; returns an error message or undefined. */
  readonly verify?: (value: SettingValue) => string | undefined;
  /** Shown instead of an empty string value. */
  readonly emptyLabel?: string;
}

export const SETTING_TABS: readonly { readonly id: SettingTab; readonly label: string }[] = [
  { id: "models", label: "Models" },
  { id: "permissions", label: "Permissions" },
  { id: "appearance", label: "Appearance" },
  { id: "memory", label: "Memory" },
];

const BOTH: readonly SettingScope[] = ["project", "global"];
const PROJECT_ONLY: readonly SettingScope[] = ["project"];

export const SETTINGS: readonly SettingDef[] = [
  {
    key: "models.default",
    label: "Default model",
    tab: "models",
    type: "string",
    default: "",
    emptyLabel: "follow Codex config",
    description: "Model a new chat starts on. Empty follows ~/.codex/config.toml, then the runtime route. /model still switches per session.",
    scope: "global",
    scopes: BOTH,
    verify: (value) => (String(value) === "" || /^[\w.:/@-]+$/.test(String(value)) ? undefined : "use a model id such as gpt-5.6-sol or claude-sonnet-5-5"),
  },
  {
    key: "chat.speed",
    label: "Speed",
    tab: "models",
    type: "enum",
    default: "session",
    options: [
      { value: "session", description: "full memory recall and skills on every turn" },
      { value: "fast", description: "warm native session with light context; recall and skills off" },
    ],
    description: "Fast keeps a warm session and skips memory recall and skills for quicker turns; session loads them on every turn. /speed still switches per session.",
    scope: "project",
    scopes: BOTH,
  },
  {
    key: "routing.maxCostUsdPerRun",
    label: "Budget per run (USD)",
    tab: "models",
    type: "number",
    default: 1,
    description: "Most a single run may spend before Muster stops it.",
    scope: "project",
    scopes: PROJECT_ONLY,
    verify: (value) => (Number(value) > 0 ? undefined : "must be greater than 0"),
  },
  {
    key: "chat.access",
    label: "Access",
    tab: "permissions",
    type: "enum",
    default: "auto-edit",
    options: [
      { value: "read-only", description: "reads and searches only; no edits, no commands that change anything" },
      { value: "ask", description: "asks before commands and edits (y once · a this session · n deny)" },
      { value: "auto-edit", description: "edits and runs commands inside the workspace without asking" },
      { value: "full", description: "no sandbox and never asks" },
    ],
    description: "How much a turn may do without asking. /access still changes it for one session.",
    scope: "project",
    scopes: BOTH,
  },
  {
    key: "appearance.header",
    label: "Header",
    tab: "appearance",
    type: "enum",
    default: "compact",
    options: [
      { value: "compact", description: "four quiet lines above the chat" },
      { value: "full", description: "the full launch panel with providers, skills and plugins" },
    ],
    description: "Launch header density. /header still switches per session.",
    scope: "global",
    scopes: BOTH,
  },
  {
    key: "appearance.statusBar",
    label: "Status bar",
    tab: "appearance",
    type: "boolean",
    default: true,
    description: "The row under the composer with model, access, context and cost.",
    scope: "global",
    scopes: BOTH,
  },
  {
    key: "chat.liveDiff",
    label: "Live diff",
    tab: "appearance",
    type: "boolean",
    default: true,
    description: "Stream inline file diffs into the chat while a turn edits files. /live-diff still switches per session.",
    scope: "global",
    scopes: BOTH,
  },
  {
    key: "chat.reasoningMode",
    label: "Reasoning summaries",
    tab: "appearance",
    type: "enum",
    default: "compact",
    options: [
      { value: "compact", description: "one dim row per reasoning summary" },
      { value: "full", description: "every line the provider shares" },
    ],
    description: "How much of the model's reasoning summary is painted. /reasoning compact|full still switches per session.",
    scope: "global",
    scopes: BOTH,
  },
  {
    key: "memory.policy",
    label: "Write policy",
    tab: "memory",
    type: "enum",
    default: "auto",
    options: [
      { value: "auto", description: "the agent saves durable memories freely" },
      { value: "ask", description: "every memory write needs your consent" },
      { value: "never", description: "only memories you explicitly ask for" },
    ],
    description: "When the agent may write durable memory. Enforced by the memory store, not by prompt text.",
    scope: "project",
    scopes: PROJECT_ONLY,
  },
];

export function findSetting(key: string): SettingDef | undefined {
  return SETTINGS.find((setting) => setting.key === key);
}

export function requireSetting(key: string): SettingDef {
  const setting = findSetting(key);
  if (!setting) {
    const near = SETTINGS.filter((candidate) => candidate.key.split(".")[0] === key.split(".")[0]).map((candidate) => candidate.key);
    throw new Error(`Unknown setting ${key}.${near.length ? ` Did you mean: ${near.join(", ")}?` : " List them with: muster config list"}`);
  }
  return setting;
}

/** The allowed values as the user types them. */
export function allowedSettingValues(setting: SettingDef): string {
  if (setting.type === "enum") return (setting.options ?? []).map((option) => option.value).join(", ");
  if (setting.type === "boolean") return "true, false";
  if (setting.type === "number") return "a number";
  return "text";
}

/** Display form: booleans read on/off, empty strings read as their emptyLabel. */
export function formatSettingValue(setting: SettingDef, value: SettingValue): string {
  if (setting.type === "boolean") return value ? "on" : "off";
  if (setting.type === "string" && value === "") return setting.emptyLabel ?? "(empty)";
  return String(value);
}

const SECRET_SHAPES = [/^sk[-_]/i, /^gh[pousr]_/, /^xox[abpr]-/, /^AIza/, /^eyJ[\w-]{10,}\./, /^(?=.*\d)(?=.*[a-zA-Z])[\w-]{32,}$/];

export function looksLikeSecret(value: string): boolean {
  const trimmed = value.trim();
  return SECRET_SHAPES.some((shape) => shape.test(trimmed));
}

/** Parse what a user typed (or a raw JSON value) into the setting's type; throws naming the allowed values. */
export function parseSettingValue(setting: SettingDef, raw: unknown): SettingValue {
  const fail = (): never => {
    throw new Error(`Invalid value ${JSON.stringify(raw)} for ${setting.key}. Allowed: ${allowedSettingValues(setting)}.`);
  };
  let value: SettingValue;
  switch (setting.type) {
    case "boolean": {
      if (typeof raw === "boolean") value = raw;
      else if (typeof raw === "string" && /^(true|on|yes|1)$/i.test(raw.trim())) value = true;
      else if (typeof raw === "string" && /^(false|off|no|0)$/i.test(raw.trim())) value = false;
      else return fail();
      break;
    }
    case "number": {
      const parsed = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : Number.NaN;
      if (!Number.isFinite(parsed)) return fail();
      value = parsed;
      break;
    }
    case "enum": {
      const text = typeof raw === "string" ? raw.trim() : undefined;
      if (!text || !(setting.options ?? []).some((option) => option.value === text)) return fail();
      value = text;
      break;
    }
    default: {
      if (typeof raw !== "string") return fail();
      if (looksLikeSecret(raw)) {
        throw new Error(`${setting.key} looks like a secret. Settings store an env-var name (for example OPENAI_API_KEY), never the key itself.`);
      }
      value = raw.trim();
    }
  }
  const problem = setting.verify?.(value);
  if (problem) throw new Error(`Invalid value ${JSON.stringify(raw)} for ${setting.key}: ${problem}.`);
  return value;
}

/** `$MUSTER_CONFIG_HOME/config.json`, else `~/.muster/config.json`. */
export function globalConfigPath(): string {
  const dir = process.env.MUSTER_CONFIG_HOME || join(process.env.HOME || homedir(), ".muster");
  return join(dir, "config.json");
}

export function settingsPaths(cwd = process.cwd()): { readonly project: string; readonly global: string } {
  return { project: profileConfigPath(cwd), global: globalConfigPath() };
}

type Json = Record<string, unknown>;

function readJson(path: string): Json | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Json) : undefined;
  } catch {
    return undefined;
  }
}

function writeJson(path: string, value: Json): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try { chmodSync(temp, 0o600); } catch { /* best effort */ }
  renameSync(temp, path);
}

function getPath(object: Json | undefined, key: string): unknown {
  let cursor: unknown = object;
  for (const part of key.split(".")) {
    if (!cursor || typeof cursor !== "object") return undefined;
    cursor = (cursor as Json)[part];
  }
  return cursor;
}

function setPath(object: Json, key: string, value: unknown): Json {
  const [head, ...rest] = key.split(".");
  if (!head) return object;
  if (!rest.length) {
    const next = { ...object };
    if (value === undefined) delete next[head];
    else next[head] = value;
    return next;
  }
  const child = object[head];
  const updated = setPath(child && typeof child === "object" && !Array.isArray(child) ? (child as Json) : {}, rest.join("."), value);
  const next = { ...object };
  if (Object.keys(updated).length === 0) delete next[head];
  else next[head] = updated;
  return next;
}

export interface ResolvedSetting {
  readonly key: string;
  readonly setting: SettingDef;
  readonly value: SettingValue;
  readonly source: SettingScope | "default";
  /** True when the effective value differs from the registry default. */
  readonly changed: boolean;
  /** Raw values per file, when present and valid. */
  readonly project?: SettingValue;
  readonly global?: SettingValue;
}

function validStored(setting: SettingDef, raw: unknown): SettingValue | undefined {
  if (raw === undefined) return undefined;
  try {
    return parseSettingValue(setting, raw);
  } catch {
    return undefined;
  }
}

/** Every setting's effective value. Invalid stored values fall through to the next layer (validate reports them). */
export function resolveSettings(cwd = process.cwd()): ResolvedSetting[] {
  const paths = settingsPaths(cwd);
  const project = readJson(paths.project);
  const global = paths.global === paths.project ? undefined : readJson(paths.global);
  return SETTINGS.map((setting) => {
    const projectValue = validStored(setting, getPath(project, setting.key));
    const globalValue = setting.scopes.includes("global") ? validStored(setting, getPath(global, setting.key)) : undefined;
    const value = projectValue ?? globalValue ?? setting.default;
    const source = projectValue !== undefined ? "project" : globalValue !== undefined ? "global" : "default";
    return {
      key: setting.key,
      setting,
      value,
      source,
      changed: value !== setting.default,
      ...(projectValue !== undefined ? { project: projectValue } : {}),
      ...(globalValue !== undefined ? { global: globalValue } : {}),
    };
  });
}

export function resolveSetting(key: string, cwd = process.cwd()): ResolvedSetting {
  requireSetting(key);
  return resolveSettings(cwd).find((row) => row.key === key)!;
}

/** Effective values keyed by setting key — what chat reads at start. */
export function settingValues(cwd = process.cwd()): Readonly<Record<string, ResolvedSetting>> {
  return Object.fromEntries(resolveSettings(cwd).map((row) => [row.key, row]));
}

function scopePath(scope: SettingScope, cwd: string): string {
  return scope === "global" ? globalConfigPath() : profileConfigWritePath(cwd);
}

function checkScope(setting: SettingDef, scope: SettingScope): void {
  if (!setting.scopes.includes(scope)) {
    throw new Error(`${setting.key} is ${setting.scopes.join("/")}-only; it cannot be saved ${scope === "global" ? "globally" : "in the project"}.`);
  }
}

export interface SettingWrite {
  readonly key: string;
  readonly value: SettingValue;
  readonly scope: SettingScope;
  readonly path: string;
}

/** Validate then save one value. Throws (and writes nothing) on a bad value or scope. */
export function setSetting(key: string, raw: unknown, options: { cwd?: string; scope?: SettingScope } = {}): SettingWrite {
  const setting = requireSetting(key);
  const cwd = options.cwd ?? process.cwd();
  const scope = options.scope ?? setting.scope;
  checkScope(setting, scope);
  const value = parseSettingValue(setting, raw);
  const path = scopePath(scope, cwd);
  const base = readJson(path) ?? (scope === "project" ? (defaultConfig() as unknown as Json) : { version: 1 });
  writeJson(path, setPath(base, key, value));
  return { key, value, scope, path };
}

/** Remove a value from one scope so the next layer shows through. */
export function resetSetting(key: string, options: { cwd?: string; scope?: SettingScope } = {}): SettingWrite {
  const setting = requireSetting(key);
  const cwd = options.cwd ?? process.cwd();
  const scope = options.scope ?? setting.scope;
  const path = scopePath(scope, cwd);
  const current = readJson(path);
  if (current && getPath(current, key) !== undefined) writeJson(path, setPath(current, key, undefined));
  return { key, value: resolveSetting(key, cwd).value, scope, path };
}

export interface SettingIssue {
  readonly file: string;
  readonly key: string;
  readonly message: string;
  /** A warning is a value Muster ignores (it never fails `validate`); an error is a value it cannot use. */
  readonly severity?: "error" | "warning";
}

/** Why a settings file cannot be read as an object: the parser's own message (with its line), or the wrong shape. */
function jsonFileProblem(path: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    return `is not valid JSON: ${error instanceof Error ? error.message : String(error)}`;
  }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? undefined : "is not a JSON object";
}

const REGISTRY_ROOTS = new Set(["chat", "appearance", "models"]);

/** Hand-edit check over both files: bad values, wrong scope, unknown keys under registry-owned roots, secrets. */
export function validateSettingsFiles(cwd = process.cwd()): SettingIssue[] {
  const paths = settingsPaths(cwd);
  const issues: SettingIssue[] = [];
  const files: Array<[SettingScope, string]> = [["project", paths.project]];
  if (paths.global !== paths.project) files.push(["global", paths.global]);
  for (const [scope, file] of files) {
    if (!existsSync(file)) continue;
    const json = readJson(file);
    if (!json) {
      issues.push({ file, key: "(file)", message: jsonFileProblem(file) ?? "is not a JSON object", severity: "error" });
      continue;
    }
    for (const setting of SETTINGS) {
      const raw = getPath(json, setting.key);
      if (raw === undefined) continue;
      if (!setting.scopes.includes(scope)) {
        issues.push({ file, key: setting.key, message: `is ${setting.scopes.join("/")}-only and is ignored in the ${scope} file (remove it, or set it in the ${setting.scopes[0]} file)`, severity: "warning" });
        continue;
      }
      try {
        parseSettingValue(setting, raw);
      } catch (error) {
        issues.push({ file, key: setting.key, message: error instanceof Error ? error.message : String(error) });
      }
    }
    for (const root of REGISTRY_ROOTS) {
      const section = json[root];
      if (!section || typeof section !== "object") continue;
      for (const leaf of Object.keys(section as Json)) {
        const key = `${root}.${leaf}`;
        if (!findSetting(key)) issues.push({ file, key, message: `Unknown setting ${key}` });
      }
    }
  }
  return issues;
}
