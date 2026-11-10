import { tmpdir } from "node:os";
import { completeChat, findProviderPreset, parseCodexEvents, runClaudeCode, runCodex, type ProviderConfig } from "@musterhq/core";
import type { ProviderStatus, RouteKind } from "./onboarding-detect.js";

/** One route as onboarding will verify and save it. Keys are env var names only. */
export interface VerifyTarget {
  readonly id: string;
  readonly label: string;
  readonly kind: RouteKind;
  readonly baseUrl?: string;
  readonly keyEnv?: string;
  readonly model?: string;
  readonly codexProvider?: string;
}

export type VerifyOutcome =
  | { readonly ok: true; readonly ms: number; readonly model?: string }
  | { readonly ok: false; readonly error: string };

export type RouteVerifier = (target: VerifyTarget) => Promise<VerifyOutcome>;

const PROMPT = "Reply with the single word OK.";

/**
 * The route a model-step row stands for, or undefined when the row is not a
 * live route yet (self-hosted placeholder, hybrid policy).
 */
export function verifyTargetFor(id: string, label: string, detected?: ProviderStatus): VerifyTarget | undefined {
  const kind = detected?.kind ?? STATIC_KINDS[id];
  if (!kind) return undefined;
  return {
    id,
    label: detected?.label ?? label,
    kind,
    ...(detected?.baseUrl ? { baseUrl: detected.baseUrl } : {}),
    ...(detected?.keyEnv ? { keyEnv: detected.keyEnv } : kind === "openai-http" ? { keyEnv: "OPENAI_API_KEY" } : kind === "anthropic-http" ? { keyEnv: "ANTHROPIC_API_KEY" } : {}),
    ...(detected?.model ? { model: detected.model } : {}),
    ...(detected?.codexProvider ? { codexProvider: detected.codexProvider } : {}),
  };
}

const STATIC_KINDS: Record<string, RouteKind> = {
  codex: "codex",
  claude: "claude",
  openai: "openai-http",
  anthropic: "anthropic-http",
};

/** The provider entry an HTTP route is saved as — the same one verification calls. */
export function providerConfigFor(target: VerifyTarget): ProviderConfig | undefined {
  if (target.kind === "anthropic-http") {
    const preset = findProviderPreset("anthropic");
    return { id: target.id, kind: "anthropic", baseUrl: target.baseUrl ?? preset?.baseUrl ?? "https://api.anthropic.com", apiKeyEnv: target.keyEnv ?? "ANTHROPIC_API_KEY", defaultModel: target.model ?? preset?.defaultModel ?? "claude-sonnet-5", timeoutMs: 120_000 };
  }
  if (target.kind === "openai-http") {
    const preset = findProviderPreset("openai");
    return { id: target.id, kind: "openai", baseUrl: target.baseUrl ?? preset?.baseUrl ?? "https://api.openai.com/v1", apiKeyEnv: target.keyEnv ?? "OPENAI_API_KEY", defaultModel: target.model ?? preset?.defaultModel ?? "gpt-5.6", timeoutMs: 120_000 };
  }
  if (target.kind === "local-openai" && target.baseUrl && target.model) {
    return { id: target.id, kind: "openai-compatible", baseUrl: target.baseUrl, defaultModel: target.model, timeoutMs: 120_000 };
  }
  return undefined;
}

/**
 * One tiny real request per route: Codex through `codex exec` (the runtime's
 * one-shot path), Claude Code through `claude --print`, HTTP gateways through
 * the same provider client chat uses. Errors are the real ones, shortened and
 * scrubbed of any key value.
 */
export const verifyRoute: RouteVerifier = async (target) => {
  const secrets = target.keyEnv && process.env[target.keyEnv] ? [process.env[target.keyEnv]!] : [];
  try {
    if (target.kind === "codex" || target.kind === "codex-provider") {
      const result = await runCodex({
        prompt: PROMPT,
        cwd: tmpdir(),
        ephemeral: true,
        sandbox: "read-only",
        approval: "never",
        reasoning: "low",
        timeoutMs: 90_000,
        ...(target.codexProvider ? { configOverrides: [`model_provider=${JSON.stringify(target.codexProvider)}`] } : {}),
        ...(target.codexProvider && target.model ? { model: target.model } : {}),
      });
      if (result.status === "completed") return { ok: true, ms: result.durationMs, ...(target.model ? { model: target.model } : {}) };
      // Codex reports the turn's own failure as a JSON event; the exit message is only a header.
      const eventError = parseCodexEvents(result.stdout).failureMessage ?? lastCodexErrorEvent(result.stdout);
      const rejected = target.codexProvider && !target.model ? rejectedModel(eventError ?? "") : undefined;
      if (rejected) return { ok: false, error: `Codex's default model ${rejected} is not served by ${target.codexProvider}` };
      return { ok: false, error: shortError(eventError || result.errorMessage || result.stderr || "codex turn failed", secrets) };
    }
    if (target.kind === "claude") {
      const result = await runClaudeCode({ prompt: PROMPT, cwd: tmpdir(), timeoutMs: 45_000 });
      if (result.status === "completed" && result.stdout.trim()) return { ok: true, ms: result.durationMs };
      return { ok: false, error: shortError(firstLine(result.stdout) || firstLine(result.stderr) || result.errorMessage || "claude returned no reply", secrets) };
    }
    const provider = providerConfigFor(target);
    if (!provider) return { ok: false, error: "no base URL or model to call" };
    if (provider.apiKeyEnv && !process.env[provider.apiKeyEnv]) return { ok: false, error: `no key — ${provider.apiKeyEnv} is not set` };
    const started = Date.now();
    const reply = await completeChat({ provider, route: { provider: provider.id, model: provider.defaultModel, maxOutputTokens: 16 }, messages: [{ role: "user", content: PROMPT }], timeoutMs: 20_000 });
    if (!reply.trim()) return { ok: false, error: "empty reply" };
    return { ok: true, ms: Date.now() - started, model: provider.defaultModel };
  } catch (error) {
    return { ok: false, error: shortError(error instanceof Error ? error.message : String(error), secrets) };
  }
};

/** "The 'gpt-6.1-terra' model is not supported …" → gpt-6.1-terra. */
function rejectedModel(message: string): string | undefined {
  const match = message.match(/['"`]([^'"`]+)['"`] model is not supported|model ['"`]([^'"`]+)['"`] (?:is not supported|does not exist|not found)|unknown model:? ['"`]?([^\s'"`]+)/i);
  return match ? (match[1] ?? match[2] ?? match[3]) : undefined;
}

function lastCodexErrorEvent(stdout: string): string | undefined {
  let message: string | undefined;
  for (const line of stdout.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const event = JSON.parse(line) as { type?: string; message?: unknown };
      if (event.type === "error" && typeof event.message === "string") message = event.message;
    } catch {
      // not an event line
    }
  }
  return message;
}

function firstLine(text: string | undefined): string {
  return (text ?? "").split("\n").map((line) => line.trim()).find(Boolean) ?? "";
}

/**
 * A failed subprocess reports "Command failed (exit 1): …" followed by its log.
 * Pick the line that says what went wrong, skipping the header and MCP-server
 * noise a CLI prints while it starts, and drop the log timestamp.
 */
function meaningfulLine(text: string): string {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const useful = lines.filter((line) => !/^Command failed\b.*:?$/.test(line) && !/rmcp|mcp/i.test(line));
  const pick = [...useful].reverse().find((line) => /error|unauthori[sz]ed|forbidden|denied|invalid|not found|expired|login|\b[45]\d\d\b/i.test(line)) ?? useful[0] ?? lines[0] ?? text.trim();
  return pick.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s+(ERROR|WARN|INFO)\s+[\w:]+:\s*/, "");
}

/** "Anthropic request failed (401): {json}" → "401 invalid x-api-key", never longer than one row, never a key. */
export function shortError(raw: string, secrets: readonly string[] = []): string {
  let text = raw;
  const http = raw.match(/\((\d{3})\):\s*([\s\S]*)$/);
  if (http) {
    let message = http[2]!.trim();
    try {
      const body = JSON.parse(message) as { error?: { message?: string } | string; message?: string };
      message = (typeof body.error === "string" ? body.error : body.error?.message) ?? body.message ?? message;
    } catch {
      // not JSON: keep the text
    }
    text = `${http[1]} ${message}`;
  }
  text = meaningfulLine(text);
  for (const secret of secrets) if (secret.length >= 6) text = text.split(secret).join("…");
  return text.length > 110 ? `${text.slice(0, 109)}…` : text;
}

export function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}
