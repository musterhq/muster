import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { profileDataDir } from "./profiles.js";

/**
 * Governed phone calls (docs/spec/clauses/25-calls-sms.md).
 *
 * The model never sees or passes a phone number: `call_contact` takes a
 * contact NAME from `calls.contacts` in .muster/gateway.json, so a prompt
 * injection cannot dial anyone else. Every call needs the owner's approval
 * (unless it is to the owner and `autoApproveOwner` is set), opens with an AI
 * disclosure, and is ended by its time and spend caps.
 */

export interface CallsRealtimeConfig {
  readonly provider: "openai" | "gemini";
  readonly apiKeyEnv?: string;
}

export interface CallsConfig {
  readonly provider?: "twilio" | "telnyx";
  readonly accountSidEnv?: string;
  readonly authTokenEnv?: string;
  /** The caller id calls and texts come from. */
  readonly from?: string;
  /** Name → E.164 number. The only numbers Muster will ever call or text. */
  readonly contacts?: Readonly<Record<string, string>>;
  /** The person the agent calls for ("Hi, this is an AI assistant calling for <ownerName>"). */
  readonly ownerName?: string;
  /** Hard time cap per call. Fractions are allowed. Defaults to 5. */
  readonly maxMinutes?: number;
  /** Hard spend cap per call (provider minutes plus model usage). Defaults to 0.5. */
  readonly maxUsdPerCall?: number;
  /** Skip the approval card for calls to the contact named "owner". Off by default. */
  readonly autoApproveOwner?: boolean;
  /** Provider list price per started minute. Defaults to 0.014 (Twilio US outbound). */
  readonly usdPerMinute?: number;
  /** Model price estimate per 1000 tokens of call turns. Defaults to 0.002. */
  readonly modelUsdPer1kTokens?: number;
  /** HTTPS origin Twilio reaches the gateway at (public URL or tunnel). Signatures are checked against it. */
  readonly publicUrl?: string;
  /** Provider REST base; defaults to https://api.twilio.com. */
  readonly apiBaseUrl?: string;
  /** Where approval cards, summaries and in-call notices go. Defaults to SMS to the contact "owner". */
  readonly notify?: { readonly channel: string; readonly peer: string };
  /** Realtime speech provider. Not implemented in this slice: calls use Gather/Say. */
  readonly realtime?: CallsRealtimeConfig;
}

export interface SmsConfig {
  readonly enabled?: boolean;
}

export interface CallSettings {
  readonly calls?: CallsConfig;
  readonly sms?: SmsConfig;
}

export const CALL_DEFAULTS = {
  maxMinutes: 5,
  maxUsdPerCall: 0.5,
  usdPerMinute: 0.014,
  modelUsdPer1kTokens: 0.002,
  apiBaseUrl: "https://api.twilio.com",
} as const;

export const CALL_CONTACT_REFUSAL = "call_contact takes a contact name from calls.contacts";

function gatewayJsonPath(cwd: string): string {
  return join(cwd, ".muster", "gateway.json");
}

/** `calls` and `sms` from .muster/gateway.json (no secrets are read). */
export function loadCallSettingsSync(cwd = process.cwd()): CallSettings {
  const path = gatewayJsonPath(cwd);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as CallSettings;
    return { calls: parsed.calls, sms: parsed.sms };
  } catch {
    return {};
  }
}

export function callsConfigured(settings: CallSettings): boolean {
  return Boolean(settings.calls?.from && settings.calls.contacts && Object.keys(settings.calls.contacts).length);
}

export interface CallCaps {
  readonly maxMinutes: number;
  readonly maxUsd: number;
}

export function callCaps(calls: CallsConfig | undefined): CallCaps {
  const minutes = calls?.maxMinutes;
  const usd = calls?.maxUsdPerCall;
  return {
    maxMinutes: typeof minutes === "number" && minutes > 0 ? minutes : CALL_DEFAULTS.maxMinutes,
    maxUsd: typeof usd === "number" && usd > 0 ? usd : CALL_DEFAULTS.maxUsdPerCall,
  };
}

/** "5 min · $0.50". */
export function formatCallCaps(caps: CallCaps): string {
  const minutes = caps.maxMinutes >= 1 ? `${Math.round(caps.maxMinutes * 10) / 10} min` : `${Math.round(caps.maxMinutes * 60)} s`;
  return `${minutes} · $${caps.maxUsd.toFixed(2)}`;
}

/** "+15557654321" → "+1 555-765-4321"; other numbers are returned as given. */
export function formatPhoneNumber(number: string): string {
  const match = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(number);
  return match ? `+1 ${match[1]}-${match[2]}-${match[3]}` : number;
}

const E164 = /^\+[1-9]\d{6,14}$/;

export function isE164(value: string): boolean {
  return E164.test(value);
}

export type ContactResolution =
  | { readonly ok: true; readonly name: string; readonly number: string }
  | { readonly ok: false; readonly error: string };

/**
 * A contact name → its configured number. Anything that is not exactly a key
 * of calls.contacts is refused, including a raw number that happens to be on
 * the list: the model names people, it never supplies digits.
 */
export function resolveCallContact(calls: CallsConfig | undefined, contact: unknown): ContactResolution {
  const name = typeof contact === "string" ? contact.trim() : "";
  const contacts = calls?.contacts ?? {};
  const known = Object.keys(contacts);
  const refusal = `${CALL_CONTACT_REFUSAL}${known.length ? ` (${known.join(", ")})` : ""}.`;
  if (!name || !Object.prototype.hasOwnProperty.call(contacts, name)) return { ok: false, error: refusal };
  const number = contacts[name];
  if (typeof number !== "string" || !isE164(number)) return { ok: false, error: `calls.contacts.${name} is not an E.164 number.` };
  return { ok: true, name, number };
}

/** The contact name for a number, if the number is on the list. */
export function contactNameForNumber(calls: CallsConfig | undefined, number: string): string | undefined {
  for (const [name, value] of Object.entries(calls?.contacts ?? {})) if (value === number) return name;
  return undefined;
}

/** The first sentence of every call. */
export function aiDisclosure(ownerName: string | undefined): string {
  return `Hi, this is an AI assistant calling for ${ownerName?.trim() || "my owner"}.`;
}

export interface CallRequest {
  readonly contact: string;
  readonly brief: string;
  /** Text the brief to the contact when the call is not answered. */
  readonly smsFallback?: boolean;
}

export interface CallApprovalCard {
  readonly contact: string;
  readonly number: string;
  readonly brief: string;
  readonly caps: CallCaps;
  readonly smsFallback: boolean;
  /** Title, brief, cap and keys, one per line. */
  readonly text: string;
}

export function callApprovalCard(input: { readonly contact: string; readonly number: string; readonly brief: string; readonly caps: CallCaps; readonly smsFallback?: boolean }): CallApprovalCard {
  const smsFallback = input.smsFallback === true;
  const text = [
    `☎ Call ${input.contact} (${formatPhoneNumber(input.number)})?`,
    `Brief: ${input.brief}`,
    `Cap: ${formatCallCaps(input.caps)}`,
    `If no answer: ${smsFallback ? "text them the brief" : "tell you"}`,
    "y call · n cancel",
  ].join("\n");
  return { contact: input.contact, number: input.number, brief: input.brief, caps: input.caps, smsFallback, text };
}

// ---- Ledger (calls.jsonl) -----------------------------------------------------------

export type CallLedgerEntry =
  | {
    readonly kind: "call.refused";
    readonly id: string;
    readonly at: string;
    /** What the model passed, truncated. */
    readonly requested: string;
    readonly reason: string;
  }
  | {
    readonly kind: "call.declined" | "call.requested" | "call.placed";
    readonly id: string;
    readonly at: string;
    readonly contact: string;
    readonly brief?: string;
    readonly approvedBy?: "owner" | "auto-owner";
  }
  | CallRecord;

export interface CallRecord {
  readonly kind: "call.record";
  readonly id: string;
  readonly at: string;
  readonly contact: string;
  readonly provider: string;
  readonly providerCallId?: string;
  /** completed | no-answer | busy | failed | canceled, plus why it ended. */
  readonly outcome: string;
  readonly endedBy?: "callee" | "agent" | "time-cap" | "spend-cap" | "provider";
  readonly durationSeconds: number;
  readonly costUsd: number;
  readonly transcriptPath?: string;
  readonly summary?: string;
  readonly fallback?: "sms" | "owner-notified";
}

export function callsLedgerPath(cwd = process.cwd()): string {
  return join(profileDataDir(cwd), "calls.jsonl");
}

export function callTranscriptPath(cwd: string, callId: string): string {
  return join(profileDataDir(cwd), "calls", `${callId}.transcript.jsonl`);
}

export async function appendCallLedger(cwd: string, entry: CallLedgerEntry): Promise<void> {
  const path = callsLedgerPath(cwd);
  await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
  await appendFile(path, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
}

export async function readCallLedger(cwd = process.cwd()): Promise<CallLedgerEntry[]> {
  const raw = await readFile(callsLedgerPath(cwd), "utf8").catch(() => "");
  const entries: CallLedgerEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as CallLedgerEntry);
    } catch {
      // A torn last line never hides the rest of the ledger.
    }
  }
  return entries;
}

export function formatDuration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  return `${Math.floor(whole / 60)}m ${String(whole % 60).padStart(2, "0")}s`;
}

/** `muster calls list`. */
export function formatCallRecordsTable(entries: readonly CallLedgerEntry[]): string {
  const records = entries.filter((entry): entry is CallRecord => entry.kind === "call.record");
  if (!records.length) return "No calls yet.\n";
  const rows = records.map((record) => [
    record.id,
    record.at.slice(0, 16).replace("T", " "),
    record.contact,
    record.outcome,
    formatDuration(record.durationSeconds),
    `$${record.costUsd.toFixed(2)}`,
    record.fallback ?? "-",
  ].join("\t"));
  return `${["id", "when", "contact", "outcome", "duration", "cost", "fallback"].join("\t")}\n${rows.join("\n")}\n`;
}

// ---- The call_contact tool ----------------------------------------------------------

export interface CallRequestOutcome {
  readonly status: "placed" | "declined" | "awaiting_approval" | "refused";
  readonly callId?: string;
  readonly message: string;
}

/**
 * Who places calls for the tool. In the gateway this is the call manager
 * (approval card, then the provider API); `muster mcp serve` uses the
 * running gateway over HTTP.
 */
export interface CallToolHost {
  requestCall(request: CallRequest): Promise<CallRequestOutcome>;
}

export function newCallLedgerId(prefix = "call"): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

/** Refuse a request before any host sees it, and write the refusal to the ledger. */
export async function refuseCallRequest(cwd: string, requested: unknown, reason: string): Promise<CallRequestOutcome> {
  await appendCallLedger(cwd, {
    kind: "call.refused",
    id: newCallLedgerId("refusal"),
    at: new Date().toISOString(),
    requested: String(requested ?? "").slice(0, 80),
    reason,
  }).catch(() => undefined);
  return { status: "refused", message: reason };
}

/** Validate a call request against config. Returns the refusal, or undefined when it may go to the host. */
export async function screenCallRequest(cwd: string, settings: CallSettings, args: { readonly contact?: unknown; readonly brief?: unknown }): Promise<CallRequestOutcome | undefined> {
  if (!callsConfigured(settings)) return refuseCallRequest(cwd, args.contact, "Calls are not configured: add calls.from and calls.contacts to .muster/gateway.json.");
  const resolved = resolveCallContact(settings.calls, args.contact);
  if (!resolved.ok) return refuseCallRequest(cwd, args.contact, resolved.error);
  const brief = typeof args.brief === "string" ? args.brief.trim() : "";
  if (brief.length < 8) return refuseCallRequest(cwd, args.contact, "call_contact needs a written brief: the purpose, what the agent may agree to, and when to hang up.");
  if (brief.length > 1000) return refuseCallRequest(cwd, args.contact, "The brief is longer than 1000 characters.");
  return undefined;
}

/** Default host for `muster mcp serve`: the running gateway on this machine. */
export function gatewayCallToolHost(cwd: string, fetcher: typeof fetch = fetch): CallToolHost {
  return {
    async requestCall(request) {
      const raw = JSON.parse(readFileSync(gatewayJsonPath(cwd), "utf8")) as { token?: string; port?: number };
      const response = await fetcher(`http://127.0.0.1:${raw.port ?? 7460}/v1/calls`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${raw.token ?? ""}` },
        body: JSON.stringify(request),
      }).catch((error: unknown) => {
        throw new Error(`The Muster gateway is not reachable (${error instanceof Error ? error.message : String(error)}); start it with: muster gateway start`);
      });
      const body = await response.json().catch(() => ({})) as Partial<CallRequestOutcome> & { error?: string };
      if (!response.ok && !body.status) throw new Error(body.error ?? `gateway answered HTTP ${response.status}`);
      return { status: body.status ?? "refused", callId: body.callId, message: body.message ?? body.error ?? "" };
    },
  };
}
