import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { dirname, isAbsolute, join } from "node:path";
import { profileConfigPath, profileConfigWritePath } from "./profiles.js";
import { findProviderPreset, presetToProviderConfig } from "./providers-catalog.js";
import type { MusterConfig, ProviderConfig, TaskKind } from "./types.js";

export const CONFIG_DIR = ".muster";
export const CONFIG_FILE = "config.json";

/**
 * The model the seeded codex route runs. This exact id is what the local
 * `codex` CLI is configured with (`~/.codex/config.toml` model = "gpt-5.6-sol",
 * 2026-08-27) and is what `docs/PRODUCT_MODES.md` routes deep review to, so the
 * seed, the CLI's offered models, and the backend agree. Never seed a model the
 * CLI does not offer — see `modelHintsForProvider` in packages/cli/src/index.ts.
 */
export const DEFAULT_CODEX_MODEL = "gpt-5.6-sol";

export function defaultConfig(): MusterConfig {
  return {
    version: 1,
    providers: {
      codex: {
        id: "codex",
        kind: "codex-cli",
        defaultModel: DEFAULT_CODEX_MODEL,
        timeoutMs: 120_000
      }
    },
    runtimes: {
      native: {
        id: "native",
        enabled: true,
        provider: "codex",
        routes: {
          simple_qa: { provider: "codex", model: DEFAULT_CODEX_MODEL, reasoning: "low" },
          research: { provider: "codex", model: DEFAULT_CODEX_MODEL, reasoning: "medium" },
          architecture: { provider: "codex", model: DEFAULT_CODEX_MODEL, reasoning: "high" },
          private_analysis: { provider: "codex", model: DEFAULT_CODEX_MODEL, reasoning: "medium" }
        }
      }
    },
    routing: {
      oneRuntimePerRun: true,
      defaultRuntime: "native",
      preferLocalForSensitive: false,
      maxCostUsdPerRun: 1,
      approvalRequiredAboveUsd: 3
    },
    memory: { policy: "auto" }
  };
}

export function configPath(cwd = process.cwd()): string {
  return profileConfigPath(cwd);
}

export async function ensureDefaultConfig(cwd = process.cwd()): Promise<string> {
  const target = configPath(cwd);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await chmod(dirname(target), 0o700).catch(() => undefined);
  await excludeMusterDirFromGit(cwd).catch(() => undefined);
  try {
    await readFile(target, "utf8");
    return target;
  } catch {
    await writeJsonAtomic(target, defaultConfig());
    return target;
  }
}

export async function loadConfig(cwd = process.cwd()): Promise<MusterConfig> {
  const raw = await readFile(configPath(cwd), "utf8");
  const parsed = JSON.parse(raw) as MusterConfig;
  if (parsed.version !== 1) {
    throw new Error(`Unsupported Muster config version: ${String(parsed.version)}`);
  }
  return normalizeConfig(parsed);
}

export async function saveConfig(config: MusterConfig, cwd = process.cwd()): Promise<void> {
  // Writes always target the active profile's own config (creating it), so a
  // non-default profile's config does not leak into the shared default. Reads
  // (configPath/loadConfig) still inherit the default until a scoped config exists.
  const target = profileConfigWritePath(cwd);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await chmod(dirname(target), 0o700).catch(() => undefined);
  await writeJsonAtomic(target, config);
}

async function writeJsonAtomic(target: string, value: unknown): Promise<void> {
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(temp, 0o600).catch(() => undefined);
  await rename(temp, target);
  await chmod(target, 0o600).catch(() => undefined);
}

function normalizeConfig(config: MusterConfig): MusterConfig {
  const fallback = defaultConfig();
  const defaultRoute = fallback.runtimes.native.routes.simple_qa!;
  const rawConfig = config as Partial<MusterConfig>;
  const providers = { ...fallback.providers, ...(rawConfig.providers ?? {}) };
  let changed = false;
  if (!rawConfig.providers) changed = true;
  for (const [id, provider] of Object.entries(providers)) {
    if (isRetiredLocalModelProvider(id, provider)) {
      delete providers[id];
      changed = true;
    }
  }
  if (!providers.codex) {
    providers.codex = fallback.providers.codex;
    changed = true;
  }
  const runtimes = Object.fromEntries(
    Object.entries(rawConfig.runtimes ?? fallback.runtimes).map(([runtimeId, runtime]) => {
      const providerMissing = !providers[runtime.provider];
      const provider = providerMissing ? "codex" : runtime.provider;
      const routes = Object.fromEntries(
        Object.entries(runtime.routes).map(([taskKind, route]) => {
          if (providerMissing || !providers[route.provider] || isRetiredLocalModelName(route.model)) {
            changed = true;
            const fallbackRoute = fallback.runtimes.native.routes[taskKind as TaskKind] ?? defaultRoute;
            return [taskKind, { ...route, provider: "codex", model: fallbackRoute.model, reasoning: route.reasoning ?? fallbackRoute.reasoning }];
          }
          return [taskKind, route];
        })
      );
      if (providerMissing) changed = true;
      return [runtimeId, { ...runtime, provider, routes }];
    })
  );
  const routing = { ...fallback.routing, ...(rawConfig.routing ?? {}) };
  if (!rawConfig.runtimes || !rawConfig.routing) changed = true;
  if (routing.preferLocalForSensitive) {
    routing.preferLocalForSensitive = false;
    changed = true;
  }
  return changed ? { ...config, providers, runtimes, routing } : config;
}

function isRetiredLocalModelProvider(id: string, provider: ProviderConfig): boolean {
  if (id === "local") return true;
  if (provider.baseUrl) {
    try {
      if (Number(new URL(provider.baseUrl).port) === 11_434) return true;
    } catch {
      // Invalid URLs are validated by explicit config commands; loading remains tolerant.
    }
  }
  return isRetiredLocalModelName(provider.defaultModel);
}

function isRetiredLocalModelName(model: string | undefined): boolean {
  return new RegExp(`^${["llama", "3"].join("")}(\\.|$)`, "i").test(model ?? "");
}

export async function addOpenAICompatibleProvider(
  input: {
    readonly id: string;
    readonly baseUrl: string;
    readonly defaultModel: string;
    readonly apiKeyEnv?: string;
  },
  cwd = process.cwd()
): Promise<MusterConfig> {
  validateProviderId(input.id);
  validateBaseUrl(input.baseUrl);
  if (!input.defaultModel.trim()) {
    throw new Error("Provider default model cannot be empty.");
  }
  const config = await loadConfig(cwd);
  const provider: ProviderConfig = {
    id: input.id,
    kind: "openai-compatible",
    baseUrl: input.baseUrl.replace(/\/$/, ""),
    defaultModel: input.defaultModel,
    apiKeyEnv: input.apiKeyEnv,
    timeoutMs: 120_000
  };
  const next: MusterConfig = {
    ...config,
    providers: {
      ...config.providers,
      [provider.id]: provider
    }
  };
  await saveConfig(next, cwd);
  return next;
}

export async function addCodexCliProvider(
  input: {
    readonly id: string;
    readonly defaultModel: string;
  },
  cwd = process.cwd()
): Promise<MusterConfig> {
  validateProviderId(input.id);
  if (!input.defaultModel.trim()) {
    throw new Error("Provider default model cannot be empty.");
  }
  const config = await loadConfig(cwd);
  const provider: ProviderConfig = {
    id: input.id,
    kind: "codex-cli",
    defaultModel: input.defaultModel,
    timeoutMs: 120_000
  };
  const next: MusterConfig = {
    ...config,
    providers: {
      ...config.providers,
      [provider.id]: provider
    }
  };
  await saveConfig(next, cwd);
  return next;
}

export async function setRuntimeProvider(
  input: {
    readonly runtimeId: string;
    readonly providerId: string;
    readonly model?: string;
  },
  cwd = process.cwd()
): Promise<MusterConfig> {
  const config = await loadConfig(cwd);
  const runtime = config.runtimes[input.runtimeId];
  if (!runtime) throw new Error(`Runtime not found: ${input.runtimeId}`);
  const provider = config.providers[input.providerId];
  if (!provider) throw new Error(`Provider not found: ${input.providerId}`);
  const model = input.model ?? provider.defaultModel;
  const next: MusterConfig = {
    ...config,
    runtimes: {
      ...config.runtimes,
      [input.runtimeId]: {
        ...runtime,
        provider: provider.id,
        routes: Object.fromEntries(
          Object.entries(runtime.routes).map(([taskKind, route]) => [
            taskKind,
            {
              ...route,
              provider: provider.id,
              model
            }
          ])
        )
      }
    }
  };
  await saveConfig(next, cwd);
  return next;
}

function validateProviderId(id: string): void {
  if (!/^[a-z][a-z0-9_-]{1,63}$/.test(id)) {
    throw new Error("Provider id must start with a letter and contain only lowercase letters, numbers, underscores, or dashes.");
  }
}

function validateBaseUrl(baseUrl: string): void {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(`Invalid provider base URL: ${baseUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Provider base URL must use http or https.");
  }
}

export async function addPresetProvider(
  presetId: string,
  overrides: { model?: string; baseUrl?: string; apiKeyEnv?: string } = {},
  cwd = process.cwd(),
): Promise<ProviderConfig> {
  const preset = findProviderPreset(presetId);
  if (!preset) {
    throw new Error(`Unknown provider preset: ${presetId}. List presets with: muster provider presets`);
  }
  const providerConfig = presetToProviderConfig(preset, overrides);
  const config = await loadConfig(cwd);
  await saveConfig({ ...config, providers: { ...config.providers, [providerConfig.id]: providerConfig } }, cwd);
  return providerConfig;
}

/**
 * Muster's state is not the user's work: in a git repository, list `.muster/`
 * in the repo-local `.git/info/exclude` (never the shared `.gitignore`), once.
 */
export async function excludeMusterDirFromGit(cwd = process.cwd()): Promise<void> {
  const gitDir = await new Promise<string | undefined>((resolve) => {
    execFile("git", ["rev-parse", "--git-common-dir"], { cwd, timeout: 2_000 }, (error, stdout) => resolve(error ? undefined : stdout.trim() || undefined));
  });
  if (!gitDir) return;
  const excludePath = join(isAbsolute(gitDir) ? gitDir : join(cwd, gitDir), "info", "exclude");
  const current = await readFile(excludePath, "utf8").catch(() => "");
  if (current.split(/\r?\n/).some((line) => line.trim() === ".muster/" || line.trim() === ".muster")) return;
  await mkdir(dirname(excludePath), { recursive: true });
  const prefix = current && !current.endsWith("\n") ? "\n" : "";
  await writeFile(excludePath, `${current}${prefix}# Muster workspace state\n.muster/\n`, "utf8");
}
