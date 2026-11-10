import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type ModelProvider = "codex" | "claude";
export type EffortValue = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

export interface CatalogModel {
  readonly provider: ModelProvider;
  readonly value: string;
  readonly label: string;
}

export interface EffortOption {
  readonly value: EffortValue;
  readonly label: string;
  readonly hint?: string;
}

export interface ComposerCatalog {
  readonly models: readonly CatalogModel[];
  readonly efforts: readonly EffortOption[];
}

export interface ComposerPickerState {
  readonly catalog: ComposerCatalog;
  readonly activeModel: string;
  readonly modelSource: "codex config" | "session" | "app default" | "settings";
  readonly effort: EffortValue;
  readonly effortSource: "codex config" | "session" | "app default";
  readonly speed: "session" | "fast";
}

export type ComposerPickerSelection =
  | { readonly kind: "model"; readonly value: string }
  | { readonly kind: "effort"; readonly value: EffortValue }
  | { readonly kind: "speed"; readonly value: "session" | "fast" };

export interface TranscriptMessage {
  readonly role: string;
  readonly content: string;
}

export interface CodexComposerDefaults {
  readonly model?: string;
  readonly effort?: EffortValue;
  readonly modelSource: "codex config" | "app default";
  readonly effortSource: "codex config" | "app default";
}

export const CODEX_MODELS: readonly CatalogModel[] = [
  { provider: "codex", value: "gpt-5.6-sol", label: "5.6 Sol" },
  { provider: "codex", value: "gpt-5.6-terra", label: "5.6 Terra" },
  { provider: "codex", value: "gpt-5.6-luna", label: "5.6 Luna" },
  { provider: "codex", value: "gpt-5.5", label: "5.5" },
] as const;

export const CLAUDE_MODELS: readonly CatalogModel[] = [
  { provider: "claude", value: "claude-fable-5-1", label: "Fable 5.1" },
  { provider: "claude", value: "claude-opus-5-5", label: "Opus 5.5" },
  { provider: "claude", value: "claude-sonnet-5-5", label: "Sonnet 5.5" },
  { provider: "claude", value: "claude-haiku-5-5", label: "Haiku 5.5" },
] as const;

export const EFFORT_OPTIONS: readonly EffortOption[] = [
  { value: "low", label: "Light" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra High" },
  { value: "max", label: "Max" },
  { value: "ultra", label: "Ultra", hint: "Consumes usage limits faster" },
] as const;

/** Models Codex reported via `model/list` this session; they replace the built-in fallback. */
const liveCodexModels: CatalogModel[] = [];

export function rememberLiveCodexModels(models: readonly { readonly id: string; readonly label?: string }[]): void {
  liveCodexModels.length = 0;
  for (const model of models) liveCodexModels.push({ provider: "codex", value: model.id, label: model.label || model.id });
}

export function buildComposerCatalog(auth: { readonly codex: boolean; readonly claude: boolean }): ComposerCatalog {
  return {
    models: [
      ...(auth.codex ? (liveCodexModels.length ? liveCodexModels : CODEX_MODELS) : []),
      ...(auth.claude ? CLAUDE_MODELS : []),
    ],
    efforts: EFFORT_OPTIONS,
  };
}

export function modelProvider(model: string | undefined): ModelProvider | undefined {
  if (!model) return undefined;
  if (CLAUDE_MODELS.some((item) => item.value === model) || model.startsWith("claude-")) return "claude";
  if (CODEX_MODELS.some((item) => item.value === model) || liveCodexModels.some((item) => item.value === model) || model.startsWith("gpt-")) return "codex";
  return undefined;
}

/** `[model_providers.<id>]` tables in the Codex config: gateways Codex can run turns on. */
export async function readCodexModelProviders(path = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "config.toml")): Promise<string[]> {
  const text = await readFile(path, "utf8").catch(() => "");
  const ids = new Set<string>();
  for (const match of text.matchAll(/^\s*\[model_providers\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\]\s*$/gm)) {
    ids.add(match[1] ?? match[2] ?? match[3]!);
  }
  return [...ids];
}

export interface GatewayModelChoice {
  /** Codex model provider id, when the model names one (`hybrow:auto/gpt`). */
  readonly provider?: string;
  readonly model: string;
}

/**
 * `hybrow:auto/gpt` → provider `hybrow`, model `auto/gpt` when `hybrow` is a
 * configured Codex provider. Ids that merely contain a colon (`llama3.1:8b`)
 * pass through unchanged.
 */
export function splitGatewayModel(model: string, providers: readonly string[]): GatewayModelChoice {
  const match = model.match(/^([A-Za-z0-9_-]+):(.+)$/);
  if (match && providers.includes(match[1]!)) return { provider: match[1]!, model: match[2]! };
  return { model };
}

export function modelDisplayLabel(model: string | undefined): string {
  if (!model) return "model";
  const gateway = model.match(/^([A-Za-z0-9_-]+):(.+\/.+)$/);
  if (gateway) return `${gateway[1]} · ${gateway[2]}`;
  return [...liveCodexModels, ...CODEX_MODELS, ...CLAUDE_MODELS].find((item) => item.value === model)?.label ?? model;
}

/** The runtime as the user knows it: the default `native` runtime is Codex's app-server, so it is `codex`. */
export function runtimeDisplayName(runtimeId: string | undefined): string {
  if (!runtimeId || runtimeId === "native") return "codex";
  return runtimeId;
}

export function effortDisplayLabel(value: EffortValue | undefined): string {
  return EFFORT_OPTIONS.find((item) => item.value === value)?.label ?? "Medium";
}

export function parseEffortValue(value: string | undefined): EffortValue | undefined {
  const normalized = value?.trim().toLowerCase().replace(/[ _-]+/g, " ");
  return EFFORT_OPTIONS.find((item) => item.value === normalized || item.label.toLowerCase() === normalized)?.value;
}

/** Exact `-c` value ultimately forwarded by the Codex app-server transport. */
export function buildReasoningEffortOverride(value: EffortValue): string {
  return `model_reasoning_effort=${JSON.stringify(value)}`;
}

export function formatModelStatus(model: string | undefined, effort: EffortValue | undefined): string {
  const label = modelDisplayLabel(model);
  return modelProvider(model) === "claude" ? label : `${label} · ${effortDisplayLabel(effort)}`;
}

export async function readCodexComposerDefaults(path = join(homedir(), ".codex", "config.toml")): Promise<CodexComposerDefaults> {
  const text = await readFile(path, "utf8").catch(() => "");
  const model = readTopLevelTomlString(text, "model");
  const effort = parseEffortValue(readTopLevelTomlString(text, "model_reasoning_effort"));
  return {
    model,
    effort,
    modelSource: model ? "codex config" : "app default",
    effortSource: effort ? "codex config" : "app default",
  };
}

function readTopLevelTomlString(text: string, key: string): string | undefined {
  let inTable = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    if (!line) continue;
    if (line.startsWith("[")) {
      inTable = true;
      continue;
    }
    if (inTable) continue;
    const match = line.match(new RegExp(`^${key}\\s*=\\s*(["'])(.*?)\\1\\s*$`));
    if (match) return match[2];
  }
  return undefined;
}

/**
 * Provider-neutral handoff context. The paragraph is deterministic and the
 * transcript is capped at the 30 most recent stored messages.
 */
export function buildContinuityContext(messages: readonly TranscriptMessage[], limit = 30): string {
  const recent = messages.slice(-Math.max(1, limit));
  const summary = continuitySummary(recent);
  const transcript = recent.map((message) => `${normalizeRole(message.role)}: ${cleanMessage(message.content)}`).join("\n");
  return [
    "Muster conversation continuity",
    `Summary: ${summary}`,
    "Recent transcript (oldest to newest):",
    transcript || "(no prior messages)",
    "Continue this same conversation. Do not repeat or describe this handoff unless the user asks.",
  ].join("\n\n");
}

function continuitySummary(messages: readonly TranscriptMessage[]): string {
  if (!messages.length) return "This conversation has no stored messages yet.";
  const userTurns = messages.filter((message) => normalizeRole(message.role) === "User");
  const assistantTurns = messages.filter((message) => normalizeRole(message.role) === "Assistant");
  const latestUser = [...userTurns].reverse().find((message) => cleanMessage(message.content))?.content;
  const focus = latestUser ? truncate(cleanMessage(latestUser), 220) : "the ongoing task in the transcript below";
  return `The recent context contains ${userTurns.length} user ${userTurns.length === 1 ? "turn" : "turns"} and ${assistantTurns.length} assistant ${assistantTurns.length === 1 ? "turn" : "turns"}. The latest user focus is: ${focus}`;
}

function normalizeRole(role: string): string {
  if (role.toLowerCase() === "assistant") return "Assistant";
  if (role.toLowerCase() === "user") return "User";
  return role ? role[0]!.toUpperCase() + role.slice(1).toLowerCase() : "Context";
}

function cleanMessage(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, width: number): string {
  return value.length <= width ? value : `${value.slice(0, width - 1).trimEnd()}…`;
}
