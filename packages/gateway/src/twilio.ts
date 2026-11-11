import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { CALL_DEFAULTS, type CallsConfig } from "@musterhq/core";
import { ChannelDeliveryRejectedError, resolveSecretEnv } from "./channel-sdk.js";

/**
 * Twilio primitives for calls and SMS: the X-Twilio-Signature check, the
 * webhook replay guard, the REST client (Calls.json, Messages.json) and
 * TwiML. No other module talks to Twilio.
 */

export type TwilioParams = ReadonlyArray<readonly [string, string]>;

export function parseTwilioForm(body: string): TwilioParams {
  return [...new URLSearchParams(body).entries()];
}

export function twilioParam(params: TwilioParams, name: string): string | undefined {
  return params.find(([key]) => key === name)?.[1];
}

/**
 * X-Twilio-Signature: base64 HMAC-SHA1 over the full URL followed by every
 * POST parameter, sorted by name, as name+value with no separators.
 */
export function twilioSignature(authToken: string, url: string, params: TwilioParams): string {
  const sorted = [...params].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const data = url + sorted.map(([key, value]) => `${key}${value}`).join("");
  return createHmac("sha1", authToken).update(Buffer.from(data, "utf8")).digest("base64");
}

export function twilioSignatureIsValid(authToken: string, url: string, params: TwilioParams, header: string | undefined): boolean {
  if (!header) return false;
  const expected = Buffer.from(twilioSignature(authToken, url, params));
  const presented = Buffer.from(header);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

/** Requests whose signed Timestamp is older (or further ahead) than this are refused. */
export const WEBHOOK_WINDOW_MS = 5 * 60_000;
/** Nonces outlive the window so a replay of an untimed request is still caught. */
const NONCE_TTL_MS = 24 * 60 * 60_000;
const MAX_NONCES = 5_000;

/**
 * Replay guard for provider webhooks: a nonce store (persisted, so a restart
 * does not reopen the window) plus a timestamp window on the signed
 * Timestamp parameter.
 */
export class WebhookReplayGuard {
  private nonces = new Map<string, number>();
  private loaded = false;
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly path: string | undefined, private readonly now: () => number = Date.now) {}

  /**
   * The signed content itself (URL plus sorted parameters). The provider's
   * idempotency header is not signed, so it is not part of the nonce: a
   * replayed request with a fresh header is still a replay.
   */
  static nonceFor(url: string, params: TwilioParams): string {
    const sorted = [...params].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return createHash("sha256").update(JSON.stringify([url, sorted])).digest("hex");
  }

  /** "stale" when the signed Timestamp parameter is outside the window. */
  checkTimestamp(params: TwilioParams): "ok" | "stale" {
    const raw = twilioParam(params, "Timestamp");
    if (raw === undefined) return "ok";
    const at = Date.parse(raw);
    if (!Number.isFinite(at)) return "stale";
    return Math.abs(this.now() - at) > WEBHOOK_WINDOW_MS ? "stale" : "ok";
  }

  /** True the first time a nonce is seen; false for a replay. */
  async firstSeen(nonce: string): Promise<boolean> {
    await this.load();
    const now = this.now();
    for (const [key, at] of this.nonces) if (now - at > NONCE_TTL_MS) this.nonces.delete(key);
    if (this.nonces.has(nonce)) return false;
    this.nonces.set(nonce, now);
    while (this.nonces.size > MAX_NONCES) this.nonces.delete(this.nonces.keys().next().value!);
    await this.persist();
    return true;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.path) return;
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as { nonces?: Array<[string, number]> };
      for (const [key, at] of parsed.nonces ?? []) if (typeof key === "string" && typeof at === "number") this.nonces.set(key, at);
    } catch {
      // No store yet.
    }
  }

  private persist(): Promise<void> {
    const path = this.path;
    if (!path) return Promise.resolve();
    const snapshot = [...this.nonces.entries()];
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temp, JSON.stringify({ nonces: snapshot }), { encoding: "utf8", mode: 0o600 });
      await rename(temp, path);
    }).catch(() => undefined);
    return this.writing;
  }
}

// ---- REST ------------------------------------------------------------------------------

export interface TwilioCredentials {
  readonly accountSid: string;
  readonly authToken: string;
  readonly baseUrl: string;
}

export function twilioCredentials(calls: CallsConfig | undefined, env: Readonly<Record<string, string | undefined>>): TwilioCredentials | undefined {
  const accountSid = resolveSecretEnv(env, calls?.accountSidEnv);
  const authToken = resolveSecretEnv(env, calls?.authTokenEnv);
  if (!accountSid || !authToken) return undefined;
  return { accountSid, authToken, baseUrl: (calls?.apiBaseUrl ?? CALL_DEFAULTS.apiBaseUrl).replace(/\/$/, "") };
}

export class TwilioRestClient {
  constructor(private readonly credentials: TwilioCredentials, private readonly fetcher: typeof fetch) {}

  private async post(path: string, form: TwilioParams): Promise<Record<string, unknown>> {
    const { accountSid, authToken, baseUrl } = this.credentials;
    const response = await this.fetcher(`${baseUrl}/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
      },
      body: new URLSearchParams(form.map(([key, value]) => [key, value])).toString(),
    });
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) {
      throw new ChannelDeliveryRejectedError(`Twilio answered HTTP ${response.status}${typeof body.message === "string" ? `: ${body.message}` : ""}`);
    }
    return body;
  }

  async createCall(input: {
    readonly to: string;
    readonly from: string;
    readonly url: string;
    readonly statusCallback: string;
    readonly timeLimitSeconds: number;
  }): Promise<{ readonly sid: string }> {
    const body = await this.post("Calls.json", [
      ["To", input.to],
      ["From", input.from],
      ["Url", input.url],
      ["Method", "POST"],
      ["StatusCallback", input.statusCallback],
      ["StatusCallbackMethod", "POST"],
      ["StatusCallbackEvent", "initiated"],
      ["StatusCallbackEvent", "ringing"],
      ["StatusCallbackEvent", "answered"],
      ["StatusCallbackEvent", "completed"],
      // The provider's own hard stop, a few seconds after Muster's cap.
      ["TimeLimit", String(input.timeLimitSeconds)],
      ["Timeout", "30"],
    ]);
    if (typeof body.sid !== "string") throw new Error("Twilio created a call without a sid.");
    return { sid: body.sid };
  }

  /** Replace what a live call is doing (used to say goodbye and hang up at a cap). */
  async updateCall(sid: string, twiml: string): Promise<void> {
    await this.post(`Calls/${encodeURIComponent(sid)}.json`, [["Twiml", twiml]]);
  }

  async sendMessage(input: { readonly to: string; readonly from: string; readonly body: string }): Promise<{ readonly sid: string }> {
    const body = await this.post("Messages.json", [["To", input.to], ["From", input.from], ["Body", input.body]]);
    return { sid: typeof body.sid === "string" ? body.sid : "" };
  }
}

// ---- TwiML -------------------------------------------------------------------------------

export function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

export type TwimlVerb =
  | { readonly say: string }
  | { readonly play: string }
  | { readonly gather: { readonly action: string; readonly say?: string; readonly play?: string } }
  | { readonly redirect: string }
  | { readonly pause: number }
  | { readonly hangup: true };

export function twiml(verbs: readonly TwimlVerb[]): string {
  const body = verbs.map((verb) => {
    if ("say" in verb) return `<Say>${xmlEscape(verb.say)}</Say>`;
    if ("play" in verb) return `<Play>${xmlEscape(verb.play)}</Play>`;
    if ("redirect" in verb) return `<Redirect method="POST">${xmlEscape(verb.redirect)}</Redirect>`;
    if ("pause" in verb) return `<Pause length="${Math.max(1, Math.round(verb.pause))}"/>`;
    if ("hangup" in verb) return "<Hangup/>";
    const inner = verb.gather.say !== undefined ? `<Say>${xmlEscape(verb.gather.say)}</Say>` : verb.gather.play !== undefined ? `<Play>${xmlEscape(verb.gather.play)}</Play>` : "";
    return `<Gather input="speech" action="${xmlEscape(verb.gather.action)}" method="POST" speechTimeout="auto" timeout="6" actionOnEmptyResult="true">${inner}</Gather>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`;
}
