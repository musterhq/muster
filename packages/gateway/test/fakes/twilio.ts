import { randomUUID } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import type { IncomingMessage } from "node:http";
import { twilioSignature } from "../../src/twilio.js";

/**
 * Fake Twilio: the REST API (Calls.json, Calls/{sid}.json, Messages.json) on a
 * local port, plus a callee that plays the TwiML Muster returns: it hears
 * <Say>, answers each <Gather> from a script, follows <Redirect>, and posts
 * signed status callbacks. Nothing here reaches a real phone network.
 */

export interface FakeTwilioRequest {
  readonly method: string;
  readonly path: string;
  readonly authorization?: string;
  readonly form: Array<[string, string]>;
}

export interface FakeCall {
  readonly sid: string;
  readonly to: string;
  readonly url: string;
  readonly statusCallback: string;
  readonly form: Array<[string, string]>;
  /** Twiml posted to Calls/{sid}.json (a goodbye from a cap). */
  updates: string[];
}

export interface PlayedWebhook {
  readonly url: string;
  readonly status: number;
  readonly body: string;
  /** Silence on the line while the provider waited for this answer. */
  readonly latencyMs: number;
}

export type CalleeStep =
  | { readonly say: string }
  /** Drop the connection after Muster answered this step, then retry it with the same idempotency token. */
  | { readonly say: string; readonly dropAndRetry: true }
  | { readonly silence: true }
  /** Stay on the line, saying nothing, until Muster ends the call through the API. */
  | { readonly hold: true };

export interface CallPlay {
  /** Every <Say> the callee heard, in order. */
  readonly heard: string[];
  readonly webhooks: PlayedWebhook[];
  readonly ended: "hangup" | "callee-hung-up" | "api";
}

function form(values: Array<[string, string]>): string {
  return new URLSearchParams(values).toString();
}

function readAll(request: IncomingMessage): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => resolvePromise(body));
    request.on("error", reject);
  });
}

/** POST a signed Twilio webhook; optionally destroy the socket as soon as the answer starts. */
export function postSigned(url: string, params: Array<[string, string]>, authToken: string, options: {
  readonly signature?: string;
  readonly idempotencyToken?: string;
  readonly drop?: boolean;
} = {}): Promise<{ status: number; body: string; latencyMs: number; dropped: boolean }> {
  const body = form(params);
  const started = Date.now();
  return new Promise((resolvePromise, reject) => {
    const target = new URL(url);
    const request = httpRequest({
      host: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "content-length": Buffer.byteLength(body),
        "x-twilio-signature": options.signature ?? twilioSignature(authToken, url, params),
        "i-twilio-idempotency-token": options.idempotencyToken ?? randomUUID(),
      },
    }, (response) => {
      const latencyMs = Date.now() - started;
      if (options.drop) {
        response.socket.destroy();
        resolvePromise({ status: response.statusCode ?? 0, body: "", latencyMs, dropped: true });
        return;
      }
      let text = "";
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => resolvePromise({ status: response.statusCode ?? 0, body: text, latencyMs, dropped: false }));
    });
    request.on("error", reject);
    request.end(body);
  });
}

type Verb = { kind: "say"; text: string } | { kind: "gather"; action: string; say?: string } | { kind: "redirect"; url: string } | { kind: "pause"; seconds: number } | { kind: "hangup" };

function decode(value: string): string {
  return value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

export function parseTwiml(xml: string): Verb[] {
  const verbs: Verb[] = [];
  const pattern = /<Say>([\s\S]*?)<\/Say>|<Gather([^>]*)>([\s\S]*?)<\/Gather>|<Gather([^>]*)\/>|<Redirect[^>]*>([\s\S]*?)<\/Redirect>|<Pause length="(\d+)"\/>|<Hangup\/>/g;
  for (const match of xml.matchAll(pattern)) {
    if (match[1] !== undefined) verbs.push({ kind: "say", text: decode(match[1]) });
    else if (match[2] !== undefined || match[4] !== undefined) {
      const attributes = match[2] ?? match[4] ?? "";
      const action = decode(/action="([^"]*)"/.exec(attributes)?.[1] ?? "");
      const say = match[3] ? /<Say>([\s\S]*?)<\/Say>/.exec(match[3])?.[1] : undefined;
      verbs.push({ kind: "gather", action, ...(say !== undefined ? { say: decode(say) } : {}) });
    } else if (match[5] !== undefined) verbs.push({ kind: "redirect", url: decode(match[5]) });
    else if (match[6] !== undefined) verbs.push({ kind: "pause", seconds: Number(match[6]) });
    else verbs.push({ kind: "hangup" });
  }
  return verbs;
}

export interface FakeTwilio {
  readonly baseUrl: string;
  readonly accountSid: string;
  readonly authToken: string;
  readonly requests: FakeTwilioRequest[];
  readonly calls: FakeCall[];
  messages(): Array<{ to: string; from: string; body: string }>;
  waitFor(predicate: () => boolean, timeoutMs?: number): Promise<void>;
  /** Play a placed call as the callee, then post the final status callback. */
  play(call: FakeCall, script: readonly CalleeStep[], options?: { readonly duration?: number }): Promise<CallPlay>;
  /** Post a signed status callback for a call. */
  status(call: FakeCall, status: string, extra?: Array<[string, string]>): Promise<{ status: number; body: string }>;
  close(): Promise<void>;
}

export async function startFakeTwilio(options: { readonly accountSid?: string; readonly authToken?: string } = {}): Promise<FakeTwilio> {
  const accountSid = options.accountSid ?? "AC00000000000000000000000000000025";
  const authToken = options.authToken ?? "twilio-auth-token-25";
  const requests: FakeTwilioRequest[] = [];
  const calls: FakeCall[] = [];
  const updateWaiters = new Map<string, () => void>();
  let counter = 0;
  const server = createServer((request, response) => {
    void readAll(request).then((body) => {
      const path = request.url ?? "/";
      const parsed = [...new URLSearchParams(body).entries()] as Array<[string, string]>;
      requests.push({ method: request.method ?? "GET", path, authorization: request.headers.authorization, form: parsed });
      const expected = `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`;
      if (request.headers.authorization !== expected) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ message: "Authenticate" }));
        return;
      }
      const prefix = `/2010-04-01/Accounts/${accountSid}/`;
      const get = (name: string) => parsed.find(([key]) => key === name)?.[1] ?? "";
      if (request.method === "POST" && path === `${prefix}Calls.json`) {
        counter += 1;
        const sid = `CA${String(counter).padStart(32, "0")}`;
        calls.push({ sid, to: get("To"), url: get("Url"), statusCallback: get("StatusCallback"), form: parsed, updates: [] });
        response.writeHead(201, { "content-type": "application/json" });
        response.end(JSON.stringify({ sid, status: "queued", to: get("To"), from: get("From") }));
        return;
      }
      const update = path.startsWith(`${prefix}Calls/`) && path.endsWith(".json") ? decodeURIComponent(path.slice(`${prefix}Calls/`.length, -".json".length)) : undefined;
      if (request.method === "POST" && update) {
        const call = calls.find((entry) => entry.sid === update);
        if (!call) {
          response.writeHead(404, { "content-type": "application/json" });
          response.end(JSON.stringify({ message: "no such call" }));
          return;
        }
        call.updates.push(get("Twiml"));
        updateWaiters.get(call.sid)?.();
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ sid: call.sid, status: "in-progress" }));
        return;
      }
      if (request.method === "POST" && path === `${prefix}Messages.json`) {
        counter += 1;
        response.writeHead(201, { "content-type": "application/json" });
        response.end(JSON.stringify({ sid: `SM${String(counter).padStart(32, "0")}`, status: "queued" }));
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: `fake twilio: no route ${request.method} ${path}` }));
    });
  });
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  const waitFor = async (predicate: () => boolean, timeoutMs = 10_000) => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error("fake twilio: condition not met in time");
      await new Promise((resolvePromise) => setImmediate(resolvePromise));
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
    }
  };

  const status = async (call: FakeCall, value: string, extra: Array<[string, string]> = []) => {
    const params: Array<[string, string]> = [
      ["AccountSid", accountSid],
      ["CallSid", call.sid],
      ["CallStatus", value],
      ["To", call.to],
      ["Timestamp", new Date().toUTCString()],
      ...extra,
    ];
    return postSigned(call.statusCallback, params, authToken);
  };

  const play = async (call: FakeCall, script: readonly CalleeStep[], playOptions: { readonly duration?: number } = {}): Promise<CallPlay> => {
    const heard: string[] = [];
    const webhooks: PlayedWebhook[] = [];
    const steps = [...script];
    const base: Array<[string, string]> = [["AccountSid", accountSid], ["CallSid", call.sid], ["CallStatus", "in-progress"], ["To", call.to]];
    let apiEnded = false;
    const apiEnd = new Promise<void>((resolvePromise) => updateWaiters.set(call.sid, () => { apiEnded = true; resolvePromise(); }));
    const fetchTwiml = async (url: string, params: Array<[string, string]>, drop = false): Promise<Verb[]> => {
      const token = randomUUID();
      let answer = await postSigned(url, params, authToken, { idempotencyToken: token, drop });
      if (answer.dropped) answer = await postSigned(url, params, authToken, { idempotencyToken: token });
      webhooks.push({ url, status: answer.status, body: answer.body, latencyMs: answer.latencyMs });
      return parseTwiml(answer.body);
    };
    let verbs = await fetchTwiml(call.url, base);
    let ended: CallPlay["ended"] | undefined;
    while (!ended) {
      if (apiEnded) { ended = "api"; break; }
      const verb = verbs.shift();
      if (!verb) { ended = "hangup"; break; }
      if (verb.kind === "say") heard.push(verb.text);
      else if (verb.kind === "pause") webhooks.push({ url: "pause", status: 0, body: "", latencyMs: verb.seconds * 1000 });
      else if (verb.kind === "hangup") ended = "hangup";
      else if (verb.kind === "redirect") verbs = await fetchTwiml(verb.url, base);
      else {
        if (verb.say !== undefined) heard.push(verb.say);
        const step = steps.shift();
        if (!step) { ended = "callee-hung-up"; break; }
        if ("hold" in step) { await apiEnd; ended = "api"; break; }
        const speech = "say" in step ? step.say : "";
        verbs = await fetchTwiml(verb.action, [...base, ["SpeechResult", speech], ["Confidence", "0.9"]], "dropAndRetry" in step);
      }
    }
    if (ended === "api" || apiEnded) {
      const goodbye = call.updates.at(-1) ?? "";
      for (const verb of parseTwiml(goodbye)) if (verb.kind === "say") heard.push(verb.text);
      ended = "api";
    }
    updateWaiters.delete(call.sid);
    await status(call, "completed", [["CallDuration", String(playOptions.duration ?? 42)]]);
    return { heard, webhooks, ended: ended! };
  };

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    accountSid,
    authToken,
    requests,
    calls,
    messages: () => requests
      .filter((entry) => entry.method === "POST" && entry.path.endsWith("/Messages.json"))
      .map((entry) => {
        const get = (name: string) => entry.form.find(([key]) => key === name)?.[1] ?? "";
        return { to: get("To"), from: get("From"), body: get("Body") };
      }),
    waitFor,
    play,
    status,
    close: () => new Promise<void>((resolvePromise) => { server.closeAllConnections(); server.close(() => resolvePromise()); }),
  };
}
