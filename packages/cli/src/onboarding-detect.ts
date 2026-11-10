import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { readCodexModelProviders } from "./model-catalog.js";

/** How a route is reached; decides how it is verified and saved. */
export type RouteKind = "codex" | "claude" | "codex-provider" | "anthropic-http" | "openai-http" | "local-openai";

/** What onboarding learned about one model route on this machine. */
export interface ProviderStatus {
  /** Short status pill shown in the route row (14 columns): logged in, key ref, no key, running… */
  readonly badge: string;
  /** True when the route can be used right now without further setup. */
  readonly ready: boolean;
  readonly kind?: RouteKind;
  /** Row label for routes that only exist because they were detected. */
  readonly label?: string;
  /** Row detail: where it was found. Names env vars, never their values. */
  readonly detail?: string;
  readonly baseUrl?: string;
  /** Name of the env var holding the key — a reference, never the value. */
  readonly keyEnv?: string;
  readonly model?: string;
  /** For `codex-provider` routes: the `[model_providers.<id>]` id. */
  readonly codexProvider?: string;
}

export type DetectedProviders = Readonly<Record<string, ProviderStatus>>;

type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

export interface DetectEnvironment {
  readonly env?: NodeJS.ProcessEnv;
  readonly home?: string;
  /** Resolves the version string, or undefined when the command is missing. */
  readonly run?: (command: string) => Promise<string | undefined>;
  readonly exists?: (path: string) => boolean;
  /** Probes local model servers. Defaults to global fetch. */
  readonly fetch?: FetchLike;
  /** Per-probe budget for local servers. */
  readonly probeTimeoutMs?: number;
}

function defaultRun(command: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(command, ["--version"], { timeout: 2000 }, (error, stdout, stderr) => {
      if (error) resolve(undefined);
      else resolve((stdout || stderr).trim() || "installed");
    });
  });
}

/** Host only: a base URL can carry credentials in its path or query, so the screen shows just the host. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "custom URL";
  }
}

/**
 * Read-only look at the machine: installed CLIs and their login files, gateway
 * env vars, Codex model-provider tables, and model servers on localhost. It
 * records which env var holds a key, never the key itself.
 */
export async function detectProviders(environment: DetectEnvironment = {}): Promise<DetectedProviders> {
  const env = environment.env ?? process.env;
  const home = environment.home ?? homedir();
  const run = environment.run ?? defaultRun;
  const exists = environment.exists ?? existsSync;
  const codexHome = env.CODEX_HOME || join(home, ".codex");
  const timeoutMs = environment.probeTimeoutMs ?? 400;
  const doFetch: FetchLike = environment.fetch ?? ((url, init) => fetch(url, init));
  const ollamaBase = normalizeOllamaHost(env.OLLAMA_HOST) ?? "http://127.0.0.1:11434";
  const lmStudioBase = (env.MUSTER_LMSTUDIO_URL || "http://127.0.0.1:1234").replace(/\/$/, "");

  const [codex, claude, codexProviders, ollamaModels, lmStudioModels] = await Promise.all([
    run(env.MUSTER_CODEX_COMMAND || "codex"),
    run("claude"),
    readCodexModelProviders(join(codexHome, "config.toml")).catch(() => [] as string[]),
    probeModels(doFetch, `${ollamaBase}/api/tags`, timeoutMs, (body) => (body as { models?: Array<{ name?: string }> }).models?.map((model) => model.name ?? "")),
    probeModels(doFetch, `${lmStudioBase}/v1/models`, timeoutMs, (body) => (body as { data?: Array<{ id?: string }> }).data?.map((model) => model.id ?? "")),
  ]);

  const result: Record<string, ProviderStatus> = {};
  if (codex === undefined) result.codex = { badge: "not installed", ready: false, kind: "codex", label: "Codex" };
  else if (exists(join(codexHome, "auth.json"))) result.codex = { badge: "logged in", ready: true, kind: "codex", label: "Codex" };
  else result.codex = { badge: "needs login", ready: false, kind: "codex", label: "Codex" };

  if (claude === undefined) result.claude = { badge: "not installed", ready: false, kind: "claude", label: "Claude Code" };
  else if (env.CLAUDE_CODE_OAUTH_TOKEN || exists(join(home, ".claude", ".credentials.json")) || exists(join(home, ".claude.json"))) result.claude = { badge: "logged in", ready: true, kind: "claude", label: "Claude Code" };
  else result.claude = { badge: "needs login", ready: false, kind: "claude", label: "Claude Code" };

  const anthropicKeyEnv = env.ANTHROPIC_AUTH_TOKEN ? "ANTHROPIC_AUTH_TOKEN" : env.ANTHROPIC_API_KEY ? "ANTHROPIC_API_KEY" : undefined;
  const anthropicModel = env.ANTHROPIC_MODEL || env.ANTHROPIC_DEFAULT_SONNET_MODEL || undefined;
  if (env.ANTHROPIC_BASE_URL) {
    const baseUrl = env.ANTHROPIC_BASE_URL.replace(/\/$/, "");
    result["anthropic-proxy"] = {
      badge: anthropicKeyEnv ? "key ref" : "no key",
      ready: Boolean(anthropicKeyEnv),
      kind: "anthropic-http",
      label: "Anthropic-compatible proxy",
      detail: [`env ANTHROPIC_BASE_URL (${hostOf(baseUrl)})`, anthropicKeyEnv ? `key ${anthropicKeyEnv}` : "set ANTHROPIC_AUTH_TOKEN", anthropicModel].filter(Boolean).join(" · "),
      baseUrl,
      ...(anthropicKeyEnv ? { keyEnv: anthropicKeyEnv } : {}),
      ...(anthropicModel ? { model: anthropicModel } : {}),
    };
    // The key in the env belongs to the proxy; the direct API row does not reuse it.
    result.anthropic = { badge: "no key", ready: false, kind: "anthropic-http", label: "Anthropic API" };
  } else {
    result.anthropic = env.ANTHROPIC_API_KEY
      ? { badge: "key ref", ready: true, kind: "anthropic-http", label: "Anthropic API", detail: "key ANTHROPIC_API_KEY", keyEnv: "ANTHROPIC_API_KEY", ...(anthropicModel ? { model: anthropicModel } : {}) }
      : { badge: "no key", ready: false, kind: "anthropic-http", label: "Anthropic API" };
  }

  const openaiBase = env.OPENAI_BASE_URL?.replace(/\/$/, "");
  result.openai = env.OPENAI_API_KEY
    ? {
      badge: "key ref",
      ready: true,
      kind: "openai-http",
      label: "OpenAI API",
      detail: [openaiBase ? `env OPENAI_BASE_URL (${hostOf(openaiBase)})` : undefined, "key OPENAI_API_KEY", env.OPENAI_MODEL].filter(Boolean).join(" · "),
      keyEnv: "OPENAI_API_KEY",
      ...(openaiBase ? { baseUrl: openaiBase } : {}),
      ...(env.OPENAI_MODEL ? { model: env.OPENAI_MODEL } : {}),
    }
    : { badge: "no key", ready: false, kind: "openai-http", label: "OpenAI API", ...(openaiBase ? { baseUrl: openaiBase } : {}) };

  const hints = await readCodexProviderHints(join(codexHome, "config.toml"));
  const envRouteModels = [result["anthropic-proxy"], result.openai].filter((route): route is ProviderStatus => Boolean(route?.baseUrl && route.model));
  for (const id of codexProviders) {
    // Codex's global `model` is often one only OpenAI serves; verify a gateway
    // with a model it is known to serve: a Codex profile for this provider,
    // else the model of an env route on the same gateway host.
    const baseUrl = hints.baseUrls[id];
    const model = hints.profileModels[id]
      ?? (baseUrl ? envRouteModels.find((route) => sameHost(route.baseUrl!, baseUrl))?.model : undefined);
    result[`codex-provider:${id}`] = {
      ...(model ? { model } : {}),
      badge: codex === undefined ? "needs codex" : "codex config",
      ready: codex !== undefined,
      kind: "codex-provider",
      label: `Codex provider ${id}`,
      detail: `[model_providers.${id}] in $CODEX_HOME/config.toml · runs through Codex`,
      codexProvider: id,
    };
  }
  if (ollamaModels?.length) {
    result.ollama = { badge: "running", ready: true, kind: "local-openai", label: "Ollama (local)", detail: `${ollamaModels.length} model${ollamaModels.length === 1 ? "" : "s"} at ${hostOf(ollamaBase)} · Space to add`, baseUrl: `${ollamaBase}/v1`, model: ollamaModels[0] };
  }
  if (lmStudioModels?.length) {
    result.lmstudio = { badge: "running", ready: true, kind: "local-openai", label: "LM Studio (local)", detail: `${lmStudioModels.length} model${lmStudioModels.length === 1 ? "" : "s"} at ${hostOf(lmStudioBase)} · Space to add`, baseUrl: `${lmStudioBase}/v1`, model: lmStudioModels[0] };
  }
  return result;
}

function sameHost(a: string, b: string): boolean {
  try {
    return new URL(a).host === new URL(b).host;
  } catch {
    return false;
  }
}

/** `[model_providers.<id>] base_url` and `[profiles.*]` model per provider, from the Codex config. */
export async function readCodexProviderHints(path: string): Promise<{ baseUrls: Record<string, string>; profileModels: Record<string, string> }> {
  const text = await readFile(path, "utf8").catch(() => "");
  const baseUrls: Record<string, string> = {};
  const profiles: Record<string, { provider?: string; model?: string }> = {};
  let section: { kind: "provider" | "profile"; id: string } | undefined;
  const unquote = (value: string): string => value.trim().replace(/^(["'])(.*)\1$/, "$2");
  for (const line of text.split(/\r?\n/)) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (header) {
      const parts = header[1]!.trim().match(/^(model_providers|profiles)\.("[^"]+"|'[^']+'|[A-Za-z0-9_-]+)$/);
      section = parts ? { kind: parts[1] === "profiles" ? "profile" : "provider", id: unquote(parts[2]!) } : undefined;
      continue;
    }
    if (!section) continue;
    const pair = line.match(/^\s*([A-Za-z_]+)\s*=\s*(.+?)\s*(#.*)?$/);
    if (!pair) continue;
    const value = unquote(pair[2]!);
    if (section.kind === "provider" && pair[1] === "base_url") baseUrls[section.id] = value;
    if (section.kind === "profile" && (pair[1] === "model" || pair[1] === "model_provider")) {
      const profile = (profiles[section.id] ??= {});
      if (pair[1] === "model") profile.model = value;
      else profile.provider = value;
    }
  }
  const profileModels: Record<string, string> = {};
  for (const profile of Object.values(profiles)) {
    if (profile.provider && profile.model && !profileModels[profile.provider]) profileModels[profile.provider] = profile.model;
  }
  return { baseUrls, profileModels };
}

function normalizeOllamaHost(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const withScheme = /^https?:\/\//.test(value) ? value : `http://${value}`;
  return withScheme.replace(/\/$/, "");
}

/**
 * One GET with a hard budget. The timer races the request as well as aborting
 * it, so a fetch that ignores its signal still cannot hold detection up.
 */
async function probeModels(doFetch: FetchLike, url: string, timeoutMs: number, pick: (body: unknown) => string[] | undefined): Promise<string[] | undefined> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(undefined);
    }, timeoutMs);
  });
  const request = (async () => {
    try {
      const response = await doFetch(url, { signal: controller.signal });
      if (!response.ok) return undefined;
      return pick(await response.json())?.filter(Boolean);
    } catch {
      return undefined;
    }
  })();
  try {
    return await Promise.race([request, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
