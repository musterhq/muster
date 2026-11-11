import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  aiDisclosure,
  appendCallLedger,
  CALL_DEFAULTS,
  callApprovalCard,
  callCaps,
  callTranscriptPath,
  dataDir,
  formatDuration,
  newCallLedgerId,
  readCallLedger,
  refuseCallRequest,
  resolveCallContact,
} from "@musterhq/core";
import type { CallApprovalCard, CallCaps, CallRecord, CallRequest, CallRequestOutcome, CallToolHost } from "@musterhq/core";
import { registerOwnerMessageInterceptor } from "./call-intercept.js";
import type { ChannelInbound } from "./channel-sdk.js";
import { smsInboundFromTwilio } from "./channels/sms.js";
import type { ApprovalRequest, SurfaceMessage, SurfaceReply } from "./envelope.js";
import type { GatewayConfig } from "./gateway-config.js";
import {
  parseTwilioForm,
  twiml,
  twilioCredentials,
  TwilioRestClient,
  twilioParam,
  twilioSignatureIsValid,
  WebhookReplayGuard,
} from "./twilio.js";
import type { TwilioCredentials, TwilioParams, TwimlVerb } from "./twilio.js";

/**
 * Governed outbound calls (docs/spec/clauses/25-calls-sms.md).
 *
 * Speech: Twilio <Gather input="speech"> is the STT step, a CallTurnRunner is
 * the turn, and <Say> is the TTS step (the spec 21 loop over TwiML). A
 * realtime media-stream transport can replace the TwiML transport behind the
 * same session: it would feed `heard` text in and speak `say` text out.
 */

export interface CallTranscriptLine {
  readonly at: string;
  readonly speaker: "agent" | "callee" | "owner" | "system";
  readonly text: string;
}

export interface CallTurnInput {
  readonly callId: string;
  readonly contact: string;
  readonly brief: string;
  readonly ownerName?: string;
  readonly transcript: readonly CallTranscriptLine[];
  /** What the callee just said; undefined for the opening turn. */
  readonly heard?: string;
  /** Texts the owner sent during the call, oldest first. */
  readonly steers: readonly string[];
  /** Host notes for the model (e.g. a declined tool request). */
  readonly notices: readonly string[];
}

export interface CallTurnResult {
  /** What the agent says next. */
  readonly say: string;
  /** Say it, then hang up. */
  readonly hangup?: boolean;
  /** One line for the summary, when the agent knows how the call went. */
  readonly outcome?: string;
  /** Model spend for this turn. */
  readonly usd?: number;
  /** The turn asked for something that needs approval. It is declined: approvals are not taken on a call. */
  readonly approvalRequest?: { readonly title: string; readonly request?: ApprovalRequest };
}

export type CallTurnRunner = (input: CallTurnInput) => Promise<CallTurnResult>;
export type CallApprovalSink = (card: CallApprovalCard) => Promise<"approve" | "deny">;

export interface CallManagerOptions {
  readonly cwd: string;
  readonly gateway: GatewayConfig;
  readonly fetcher?: typeof fetch;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly log?: (line: string) => void;
  /** Origin Twilio reaches this gateway at; signatures are checked against it. */
  readonly publicUrl: () => string;
  readonly turnRunner: CallTurnRunner;
  /**
   * In-process approval (a chat harness). Without it the card goes to the
   * owner's notify channel and a "y" there places the call.
   */
  readonly approve?: CallApprovalSink;
  /** Text to the owner (cards, summaries, notices). Defaults to sendToChannel on calls.notify. */
  readonly notifyOwner?: (reply: SurfaceReply) => Promise<void>;
  /** Text to a named contact (no-answer fallback). */
  readonly textContact?: (contact: string, text: string) => Promise<void>;
  /** Shared SMS ingest (allowlist, durable ingress, pairing, turn, reply). */
  readonly ingestSms?: (item: ChannelInbound) => Promise<void>;
  /** Track background work so the server can drain it. */
  readonly track?: (work: Promise<void>) => void;
  readonly now?: () => number;
  /** Longest the provider waits for a reply before the agent fills with "One moment." */
  readonly replyBudgetMs?: number;
}

export interface TwilioWebhookResult {
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
}

type CallState = "dialing" | "in-progress" | "ending" | "ended";
type EndReason = NonNullable<CallRecord["endedBy"]>;

interface PendingTurn {
  readonly index: number;
  readonly result: Promise<CallTurnResult>;
  settled?: CallTurnResult;
}

interface CallSession {
  readonly id: string;
  readonly contact: string;
  readonly number: string;
  readonly brief: string;
  readonly smsFallback: boolean;
  readonly caps: CallCaps;
  sid?: string;
  readonly sidReady: Promise<string | undefined>;
  resolveSid(sid: string | undefined): void;
  state: CallState;
  answeredAt?: number;
  readonly transcript: CallTranscriptLine[];
  readonly steers: string[];
  readonly notices: string[];
  modelUsd: number;
  /** Rendered TwiML per gather turn, so a provider retry gets the same answer. */
  readonly turnResponses: Map<string, Promise<string>>;
  turn?: PendingTurn;
  capTimer?: NodeJS.Timeout;
  endedBy?: EndReason;
  outcome?: string;
  silences: number;
  finalized: boolean;
}

interface PendingApproval {
  readonly card: CallApprovalCard;
  readonly request: CallRequest;
  readonly expiresAt: number;
}

const FILLERS = ["One moment.", "Still on it.", "Just a moment more."];
const MAX_WAITS = 25;
const CAP_GOODBYE = "I have to wrap up this call now. Thank you, goodbye.";
const DEFAULT_REPLY_BUDGET_MS = 1_200;

function webhookResult(status: number, body: string, contentType = "text/xml"): TwilioWebhookResult {
  return { status, contentType, body };
}

export class CallManager implements CallToolHost {
  private readonly sessions = new Map<string, CallSession>();
  private readonly guard: WebhookReplayGuard;
  private readonly replays = new Map<string, Promise<TwilioWebhookResult>>();
  private pendingApproval?: PendingApproval;
  private readonly unregister: () => void;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly counters = { processed: 0, replays: 0, rejected: 0 };

  constructor(private readonly options: CallManagerOptions) {
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => undefined);
    this.guard = new WebhookReplayGuard(join(dataDir(options.cwd), "call-webhook-nonces.json"), this.now);
    this.unregister = registerOwnerMessageInterceptor((message) => this.interceptOwnerMessage(message));
    if (options.gateway.calls?.realtime) {
      this.log("calls: realtime speech is not available yet; calls use <Gather>/<Say>.");
    }
  }

  private get calls() {
    return this.options.gateway.calls;
  }

  private credentials(): TwilioCredentials | undefined {
    return twilioCredentials(this.calls, this.options.env ?? process.env);
  }

  private rest(): TwilioRestClient {
    const credentials = this.credentials();
    if (!credentials) throw new Error("Calls are not configured: set calls.accountSidEnv and calls.authTokenEnv and export both.");
    return new TwilioRestClient(credentials, this.options.fetcher ?? fetch);
  }

  private track(work: Promise<unknown>): void {
    const settled = work.then(() => undefined, (error: unknown) => {
      this.log(`calls: ${error instanceof Error ? error.message : String(error)}`);
    });
    this.options.track?.(settled);
  }

  /** Active (not finished) call, if any. One call at a time. */
  activeCall(): { readonly id: string; readonly contact: string; readonly state: CallState } | undefined {
    for (const session of this.sessions.values()) {
      if (session.state !== "ended") return { id: session.id, contact: session.contact, state: session.state };
    }
    return undefined;
  }

  /** Webhooks processed, answered as replays, and refused (signature or window). */
  webhookStats(): { readonly processed: number; readonly replays: number; readonly rejected: number } {
    return { ...this.counters };
  }

  transcript(callId: string): readonly CallTranscriptLine[] {
    return this.sessions.get(callId)?.transcript ?? [];
  }

  async close(): Promise<void> {
    this.unregister();
    for (const session of this.sessions.values()) if (session.capTimer) clearTimeout(session.capTimer);
  }

  // ---- Request → approval → dial ----------------------------------------------------

  async requestCall(request: CallRequest): Promise<CallRequestOutcome> {
    const { cwd } = this.options;
    const resolved = resolveCallContact(this.calls, request.contact);
    if (!resolved.ok) return refuseCallRequest(cwd, request.contact, resolved.error);
    const brief = typeof request.brief === "string" ? request.brief.trim() : "";
    if (brief.length < 8) return refuseCallRequest(cwd, request.contact, "call_contact needs a written brief: the purpose, what the agent may agree to, and when to hang up.");
    if (this.calls?.provider && this.calls.provider !== "twilio") return refuseCallRequest(cwd, request.contact, `Calls through ${this.calls.provider} are not available yet; use provider twilio.`);
    if (!this.credentials() || !this.calls?.from) return refuseCallRequest(cwd, request.contact, "Calls are not configured: set calls.from, calls.accountSidEnv and calls.authTokenEnv.");
    if (!this.calls.publicUrl && !this.calls.apiBaseUrl) {
      return refuseCallRequest(cwd, request.contact, "Set calls.publicUrl to the HTTPS address Twilio reaches this gateway at (public URL or tunnel) before placing calls.");
    }
    const active = this.activeCall();
    if (active) return refuseCallRequest(cwd, request.contact, `A call with ${active.contact} is in progress; one call at a time.`);
    if (this.pendingApproval && this.pendingApproval.expiresAt > this.now()) {
      return refuseCallRequest(cwd, request.contact, `A call to ${this.pendingApproval.card.contact} is waiting for approval.`);
    }
    const caps = callCaps(this.calls);
    const card = callApprovalCard({ contact: resolved.name, number: resolved.number, brief, caps, smsFallback: request.smsFallback });
    const normalized: CallRequest = { contact: resolved.name, brief, smsFallback: request.smsFallback === true };
    await appendCallLedger(cwd, { kind: "call.requested", id: newCallLedgerId("request"), at: new Date(this.now()).toISOString(), contact: resolved.name, brief });

    if (resolved.name === "owner" && this.calls?.autoApproveOwner === true) {
      return this.dial(normalized, resolved.number, caps, "auto-owner");
    }
    if (this.options.approve) {
      const decision = await this.options.approve(card).catch(() => "deny" as const);
      if (decision !== "approve") return this.declined(resolved.name);
      return this.dial(normalized, resolved.number, caps, "owner");
    }
    if (!this.notifyTarget()) {
      return refuseCallRequest(cwd, request.contact, "No approval channel: set calls.notify, or enable sms so the card can be texted to the owner.");
    }
    const ttlMs = Math.min(3600, Math.max(60, this.options.gateway.approvals?.ttlSeconds ?? 600)) * 1000;
    this.pendingApproval = { card, request: normalized, expiresAt: this.now() + ttlMs };
    await this.notifyOwner({ text: card.text });
    return { status: "awaiting_approval", message: `Sent the call card to the owner. Nothing is dialled until they reply y.` };
  }

  private async declined(contact: string): Promise<CallRequestOutcome> {
    await appendCallLedger(this.options.cwd, { kind: "call.declined", id: newCallLedgerId("decline"), at: new Date(this.now()).toISOString(), contact });
    return { status: "declined", message: `The owner declined the call to ${contact}. Nothing was dialled.` };
  }

  private async dial(request: CallRequest, number: string, caps: CallCaps, approvedBy: "owner" | "auto-owner"): Promise<CallRequestOutcome> {
    const id = newCallLedgerId("call");
    let resolveSid!: (sid: string | undefined) => void;
    const sidReady = new Promise<string | undefined>((resolvePromise) => { resolveSid = resolvePromise; });
    const session: CallSession = {
      id,
      contact: request.contact,
      number,
      brief: request.brief,
      smsFallback: request.smsFallback === true,
      caps,
      sidReady,
      resolveSid,
      state: "dialing",
      transcript: [],
      steers: [],
      notices: [],
      modelUsd: 0,
      turnResponses: new Map(),
      silences: 0,
      finalized: false,
    };
    // Registered before dialling: the answer webhook can arrive before Calls.json returns.
    this.sessions.set(id, session);
    const base = this.options.publicUrl().replace(/\/$/, "");
    try {
      const { sid } = await this.rest().createCall({
        to: number,
        from: this.calls!.from!,
        url: `${base}/v1/calls/twilio/voice?call=${id}`,
        statusCallback: `${base}/v1/calls/twilio/status?call=${id}`,
        timeLimitSeconds: Math.ceil(caps.maxMinutes * 60) + 15,
      });
      session.sid = sid;
      session.resolveSid(sid);
    } catch (error) {
      session.resolveSid(undefined);
      session.state = "ended";
      session.finalized = true;
      throw error;
    }
    await appendCallLedger(this.options.cwd, { kind: "call.placed", id, at: new Date(this.now()).toISOString(), contact: request.contact, brief: request.brief, approvedBy });
    return { status: "placed", callId: id, message: `Calling ${request.contact} now (${id}). The record and a summary follow when the call ends.` };
  }

  // ---- Owner channel ---------------------------------------------------------------------

  private notifyTarget(): { readonly channel: string; readonly peer: string } | undefined {
    return this.calls?.notify ?? (this.options.gateway.sms?.enabled ? { channel: "sms", peer: "owner" } : undefined);
  }

  private async notifyOwner(reply: SurfaceReply): Promise<void> {
    try {
      if (this.options.notifyOwner) {
        await this.options.notifyOwner(reply);
        return;
      }
      const target = this.notifyTarget();
      if (!target) {
        this.log(`calls: no notify channel for: ${reply.text.split("\n")[0]}`);
        return;
      }
      const { sendToChannel } = await import("./channel-runner.js");
      await sendToChannel(target.channel, target.peer, reply, {
        cwd: this.options.cwd,
        gateway: this.options.gateway,
        fetcher: this.options.fetcher,
        env: this.options.env,
        log: this.log,
      });
    } catch (error) {
      this.log(`calls: owner notice failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async textContact(contact: string, text: string): Promise<void> {
    if (this.options.textContact) return this.options.textContact(contact, text);
    const { sendToChannel } = await import("./channel-runner.js");
    await sendToChannel("sms", contact, text, { cwd: this.options.cwd, gateway: this.options.gateway, fetcher: this.options.fetcher, env: this.options.env });
  }

  /** Is this paired sender the owner on the notify channel? */
  isOwnerMessage(message: SurfaceMessage): boolean {
    const target = this.notifyTarget();
    if (!target) return false;
    if (message.surfaceId.split(":")[0] !== target.channel) return false;
    let peer = target.peer;
    if (target.channel === "sms") {
      const resolved = resolveCallContact(this.calls, target.peer);
      if (!resolved.ok) return false;
      peer = resolved.number;
    }
    return message.senderId === peer || (message.conversationId === peer && message.senderId === message.conversationId);
  }

  /** y/n on a pending card, or a steer for the call in progress. Runs after pairing. */
  async interceptOwnerMessage(message: SurfaceMessage): Promise<SurfaceReply | undefined> {
    if (!this.isOwnerMessage(message)) return undefined;
    const text = message.text.trim();
    const pending = this.pendingApproval;
    if (pending) {
      if (pending.expiresAt <= this.now()) {
        this.pendingApproval = undefined;
      } else {
        const answer = /^(y|yes|n|no)[.!]?$/i.exec(text)?.[1]?.toLowerCase();
        if (answer) {
          this.pendingApproval = undefined;
          if (answer.startsWith("n")) {
            const outcome = await this.declined(pending.card.contact);
            return { text: outcome.message };
          }
          const outcome = await this.dial(pending.request, pending.card.number, pending.card.caps, "owner").catch((error: unknown) => ({
            status: "refused" as const,
            message: `The call to ${pending.card.contact} could not be placed: ${error instanceof Error ? error.message : String(error)}`,
          }));
          return { text: outcome.message };
        }
      }
    }
    for (const session of this.sessions.values()) {
      if (session.state !== "in-progress" && session.state !== "dialing") continue;
      if (!text) return undefined;
      session.steers.push(text);
      this.addLine(session, "owner", text);
      return { text: `Passed to the call with ${session.contact}.` };
    }
    return undefined;
  }

  // ---- Webhooks --------------------------------------------------------------------------

  /**
   * POST /v1/calls/twilio/<kind>. Every request is signature-checked against
   * the public URL, then replay-checked (timestamp window plus nonce). A
   * replay gets the first answer again and changes nothing.
   */
  async handleTwilioWebhook(kind: string, pathAndQuery: string, body: string, headers: Readonly<Record<string, string | string[] | undefined>>): Promise<TwilioWebhookResult> {
    const credentials = this.credentials();
    if (!credentials) return webhookResult(503, "calls are not configured", "text/plain");
    const params = parseTwilioForm(body);
    const url = `${this.options.publicUrl().replace(/\/$/, "")}${pathAndQuery}`;
    const signature = headers["x-twilio-signature"];
    if (!twilioSignatureIsValid(credentials.authToken, url, params, typeof signature === "string" ? signature : undefined)) {
      this.counters.rejected += 1;
      this.log(`calls: refused a ${kind} webhook with a bad signature`);
      return webhookResult(403, "invalid signature", "text/plain");
    }
    if (this.guard.checkTimestamp(params) === "stale") {
      this.counters.rejected += 1;
      this.log(`calls: refused a stale ${kind} webhook`);
      return webhookResult(403, "stale request", "text/plain");
    }
    const nonce = WebhookReplayGuard.nonceFor(url, params);
    if (!(await this.guard.firstSeen(nonce))) {
      this.counters.replays += 1;
      return this.replays.get(nonce) ?? webhookResult(200, kind === "status" ? "" : twiml([]), kind === "status" ? "text/plain" : "text/xml");
    }
    this.counters.processed += 1;
    const query = new URL(pathAndQuery, "http://gateway.local").searchParams;
    const handled = this.dispatch(kind, query, params).catch((error: unknown) => {
      this.log(`calls: ${kind} webhook failed: ${error instanceof Error ? error.message : String(error)}`);
      return webhookResult(200, twiml([{ say: "Sorry, something went wrong. Goodbye." }, { hangup: true }]));
    });
    this.replays.set(nonce, handled);
    if (this.replays.size > 500) this.replays.delete(this.replays.keys().next().value!);
    return handled;
  }

  private async dispatch(kind: string, query: URLSearchParams, params: TwilioParams): Promise<TwilioWebhookResult> {
    if (kind === "sms") return this.handleSms(params);
    const session = this.sessions.get(query.get("call") ?? "");
    if (!session) return webhookResult(200, kind === "status" ? "" : twiml([{ hangup: true }]), kind === "status" ? "text/plain" : "text/xml");
    const sid = await session.sidReady;
    if (!sid || twilioParam(params, "CallSid") !== sid) {
      this.log(`calls: webhook CallSid does not match ${session.id}`);
      return webhookResult(403, "call mismatch", "text/plain");
    }
    if (kind === "status") {
      await this.handleStatus(session, params);
      return webhookResult(200, "", "text/plain");
    }
    if (session.state === "ending" || session.state === "ended") return webhookResult(200, twiml([{ hangup: true }]));
    if (kind === "voice") return webhookResult(200, await this.answer(session));
    const turn = Number(query.get("turn") ?? "0");
    if (!Number.isInteger(turn) || turn < 0) return webhookResult(400, "bad turn", "text/plain");
    if (kind === "gather") return webhookResult(200, await this.gather(session, turn, twilioParam(params, "SpeechResult") ?? ""));
    if (kind === "wait") return webhookResult(200, await this.wait(session, turn, Number(query.get("n") ?? "1")));
    return webhookResult(404, "unknown webhook", "text/plain");
  }

  private handleSms(params: TwilioParams): TwilioWebhookResult {
    const item = smsInboundFromTwilio(this.options.gateway, params);
    if (!item) return webhookResult(200, twiml([]));
    if (!this.options.gateway.sms?.enabled || !this.options.ingestSms) {
      this.log("calls: inbound SMS ignored (sms.enabled is off)");
      return webhookResult(200, twiml([]));
    }
    // Answer Twilio at once; the turn and the reply (Messages.json) follow.
    this.track(this.options.ingestSms(item));
    return webhookResult(200, twiml([]));
  }

  // ---- The call itself ---------------------------------------------------------------------

  private addLine(session: CallSession, speaker: CallTranscriptLine["speaker"], text: string): void {
    session.transcript.push({ at: new Date(this.now()).toISOString(), speaker, text });
  }

  private gatherUrl(session: CallSession, turn: number): string {
    return `${this.options.publicUrl().replace(/\/$/, "")}/v1/calls/twilio/gather?call=${session.id}&turn=${turn}`;
  }

  private waitUrl(session: CallSession, turn: number, n: number): string {
    return `${this.options.publicUrl().replace(/\/$/, "")}/v1/calls/twilio/wait?call=${session.id}&turn=${turn}&n=${n}`;
  }

  private once(session: CallSession, key: string, render: () => Promise<string>): Promise<string> {
    const existing = session.turnResponses.get(key);
    if (existing) return existing;
    const rendered = render();
    session.turnResponses.set(key, rendered);
    return rendered;
  }

  /** The callee answered: the disclosure is the first thing said, before any model output. */
  private answer(session: CallSession): Promise<string> {
    return this.once(session, "answer", async () => {
      session.state = "in-progress";
      session.answeredAt = this.now();
      const disclosure = aiDisclosure(this.calls?.ownerName);
      this.addLine(session, "agent", disclosure);
      this.scheduleCap(session);
      this.startTurn(session, 0, undefined);
      return twiml([{ say: disclosure }, ...(await this.replyVerbs(session, 0, 1))]);
    });
  }

  private gather(session: CallSession, turn: number, speech: string): Promise<string> {
    return this.once(session, `gather:${turn}`, async () => {
      const heard = speech.trim();
      if (!heard) {
        session.silences += 1;
        if (session.silences >= 2) {
          this.addLine(session, "agent", "I'll let you go. Goodbye.");
          session.endedBy ??= "agent";
          return twiml([{ say: "I'll let you go. Goodbye." }, { hangup: true }]);
        }
        this.addLine(session, "agent", "Are you still there?");
        return twiml([{ gather: { action: this.gatherUrl(session, turn + 1), say: "Are you still there?" } }]);
      }
      session.silences = 0;
      this.addLine(session, "callee", heard);
      this.startTurn(session, turn, heard);
      return twiml(await this.replyVerbs(session, turn, 1));
    });
  }

  private wait(session: CallSession, turn: number, n: number): Promise<string> {
    return this.once(session, `wait:${turn}:${n}`, async () => {
      if (n > MAX_WAITS) {
        const text = "Sorry, this is taking too long. I'll follow up another way. Goodbye.";
        this.addLine(session, "agent", text);
        session.endedBy ??= "agent";
        return twiml([{ say: text }, { hangup: true }]);
      }
      return twiml(await this.replyVerbs(session, turn, n + 1));
    });
  }

  private startTurn(session: CallSession, index: number, heard: string | undefined): void {
    if (session.turn?.index === index) return;
    const turn: PendingTurn = { index, result: this.runTurn(session, heard) };
    turn.result.then((result) => { turn.settled = result; }, () => undefined);
    session.turn = turn;
  }

  /**
   * Answer within the reply budget: the turn's words when they are ready,
   * otherwise a short filler and a redirect to wait for them, so a slow tool
   * never leaves the line silent.
   */
  private async replyVerbs(session: CallSession, index: number, nextWait: number): Promise<TwimlVerb[]> {
    const turn = session.turn;
    if (!turn || turn.index !== index) return [{ gather: { action: this.gatherUrl(session, index + 1) } }];
    const budget = this.options.replyBudgetMs ?? DEFAULT_REPLY_BUDGET_MS;
    let timer: NodeJS.Timeout | undefined;
    const result = turn.settled ?? await Promise.race([
      turn.result,
      new Promise<undefined>((resolvePromise) => { timer = setTimeout(() => resolvePromise(undefined), budget); }),
    ]).finally(() => { if (timer) clearTimeout(timer); });
    if (session.state === "ending" || session.state === "ended") return [{ hangup: true }];
    if (!result) {
      return [{ say: FILLERS[(nextWait - 1) % FILLERS.length]! }, { redirect: this.waitUrl(session, index, nextWait) }];
    }
    if (result.hangup) return [{ say: result.say }, { hangup: true }];
    return [{ gather: { action: this.gatherUrl(session, index + 1), say: result.say } }];
  }

  private spentUsd(session: CallSession): number {
    const minutes = session.answeredAt === undefined ? 0 : (this.now() - session.answeredAt) / 60_000;
    return minutes * this.usdPerMinute() + session.modelUsd;
  }

  private usdPerMinute(): number {
    const value = this.calls?.usdPerMinute;
    return typeof value === "number" && value >= 0 ? value : CALL_DEFAULTS.usdPerMinute;
  }

  /** One timer for whichever cap comes first: minutes, or dollars at the per-minute rate. */
  private scheduleCap(session: CallSession): void {
    if (session.capTimer) clearTimeout(session.capTimer);
    if (session.answeredAt === undefined || session.state !== "in-progress") return;
    const elapsed = this.now() - session.answeredAt;
    const timeLeft = session.caps.maxMinutes * 60_000 - elapsed;
    const rate = this.usdPerMinute();
    const moneyLeft = rate > 0 ? ((session.caps.maxUsd - session.modelUsd) / rate) * 60_000 - elapsed : Number.POSITIVE_INFINITY;
    const reason: EndReason = moneyLeft < timeLeft ? "spend-cap" : "time-cap";
    const delay = Math.max(0, Math.min(timeLeft, moneyLeft));
    session.capTimer = setTimeout(() => { this.track(this.endCall(session, reason)); }, delay);
    session.capTimer.unref?.();
  }

  /** Say a short goodbye and hang up through the provider API. */
  async endCall(session: CallSession, reason: EndReason): Promise<void> {
    if (session.state === "ending" || session.state === "ended") return;
    session.state = "ending";
    session.endedBy = reason;
    if (session.capTimer) clearTimeout(session.capTimer);
    this.addLine(session, "agent", CAP_GOODBYE);
    this.addLine(session, "system", `ended at the ${reason === "time-cap" ? "time" : reason === "spend-cap" ? "spend" : reason} cap`);
    const sid = await session.sidReady;
    if (sid) await this.rest().updateCall(sid, twiml([{ say: CAP_GOODBYE }, { hangup: true }]));
  }

  private async runTurn(session: CallSession, heard: string | undefined): Promise<CallTurnResult> {
    if (this.spentUsd(session) >= session.caps.maxUsd) {
      await this.endCall(session, "spend-cap");
      return { say: CAP_GOODBYE, hangup: true };
    }
    const steers = session.steers.splice(0);
    const notices = session.notices.splice(0);
    let result: CallTurnResult;
    try {
      result = await this.options.turnRunner({
        callId: session.id,
        contact: session.contact,
        brief: session.brief,
        ownerName: this.calls?.ownerName,
        transcript: [...session.transcript],
        heard,
        steers,
        notices,
      });
    } catch (error) {
      this.log(`calls: turn failed: ${error instanceof Error ? error.message : String(error)}`);
      result = { say: "Sorry, I lost my train of thought. Could you say that again?" };
    }
    session.modelUsd += Math.max(0, result.usd ?? 0);
    let say = result.say.trim();
    if (result.approvalRequest) {
      // Fail closed: nothing that needs approval runs during a call.
      const title = result.approvalRequest.title;
      session.notices.push(`Declined: ${title}. Approvals are not taken during a call; the owner was asked to approve it by text after the call.`);
      this.addLine(session, "system", `declined during the call: ${title}`);
      const notice = `During the call with ${session.contact} the agent asked to ${title}; approve it here after the call`;
      this.track(this.notifyOwner(result.approvalRequest.request ? { text: notice, approvalRequest: result.approvalRequest.request } : { text: notice }));
      if (!say) say = "I'll follow up on that after the call.";
    }
    if (!say) say = "Sorry, could you repeat that?";
    if (result.outcome) session.outcome = result.outcome;
    if (session.state === "ending" || session.state === "ended") return { ...result, say: CAP_GOODBYE, hangup: true };
    this.addLine(session, "agent", say);
    if (result.hangup) session.endedBy ??= "agent";
    if (this.spentUsd(session) >= session.caps.maxUsd) {
      await this.endCall(session, "spend-cap");
      return { ...result, say: CAP_GOODBYE, hangup: true };
    }
    this.scheduleCap(session);
    return { ...result, say };
  }

  // ---- After the call ------------------------------------------------------------------------

  private async handleStatus(session: CallSession, params: TwilioParams): Promise<void> {
    const status = twilioParam(params, "CallStatus") ?? "";
    if (!["completed", "busy", "no-answer", "failed", "canceled"].includes(status)) return;
    const duration = Number(twilioParam(params, "CallDuration") ?? "");
    await this.finalize(session, status, Number.isFinite(duration) && duration >= 0 ? duration : undefined);
  }

  private async finalize(session: CallSession, status: string, providerSeconds: number | undefined): Promise<void> {
    if (session.finalized) return;
    session.finalized = true;
    if (session.capTimer) clearTimeout(session.capTimer);
    session.state = "ended";
    const { cwd } = this.options;
    // A record is written once, even across a restart that replays the callback.
    if ((await readCallLedger(cwd)).some((entry) => entry.kind === "call.record" && entry.id === session.id)) return;
    const answered = status === "completed" && session.answeredAt !== undefined;
    const durationSeconds = providerSeconds ?? (session.answeredAt === undefined ? 0 : Math.round((this.now() - session.answeredAt) / 1000));
    const billedMinutes = answered ? Math.max(1, Math.ceil(durationSeconds / 60)) : 0;
    const costUsd = Math.round((billedMinutes * this.usdPerMinute() + session.modelUsd) * 10_000) / 10_000;
    const transcriptPath = callTranscriptPath(cwd, session.id);
    if (session.transcript.length) {
      await mkdir(dirname(transcriptPath), { recursive: true, mode: 0o700 });
      await writeFile(transcriptPath, session.transcript.map((line) => JSON.stringify(line)).join("\n") + "\n", { encoding: "utf8", mode: 0o600 });
    }
    const endedBy: EndReason = session.endedBy ?? (status === "completed" ? "callee" : "provider");
    const smsFallback = !answered && session.smsFallback && this.options.gateway.sms?.enabled === true;
    const lastAgent = [...session.transcript].reverse().find((line) => line.speaker === "agent" && line.text !== CAP_GOODBYE)?.text;
    const summary = answered
      ? [
        `☎ Call with ${session.contact}: completed in ${formatDuration(durationSeconds)}, $${costUsd.toFixed(2)}${endedBy === "time-cap" ? ", ended at the time cap" : endedBy === "spend-cap" ? ", ended at the spend cap" : ""}.`,
        `Outcome: ${session.outcome ?? lastAgent ?? "no outcome recorded"}`,
        `Transcript: ${transcriptPath}`,
      ].join("\n")
      : undefined;
    const record: CallRecord = {
      kind: "call.record",
      id: session.id,
      at: new Date(this.now()).toISOString(),
      contact: session.contact,
      provider: "twilio",
      ...(session.sid ? { providerCallId: session.sid } : {}),
      outcome: status,
      endedBy,
      durationSeconds,
      costUsd,
      ...(session.transcript.length ? { transcriptPath } : {}),
      ...(summary ? { summary } : {}),
      ...(answered ? {} : { fallback: smsFallback ? "sms" as const : "owner-notified" as const }),
    };
    await appendCallLedger(cwd, record);
    if (summary) {
      await this.notifyOwner({ text: summary });
      return;
    }
    if (smsFallback) {
      try {
        await this.textContact(session.contact, `Hi, this is an AI assistant for ${this.calls?.ownerName?.trim() || "my owner"}. ${session.brief}`);
        await this.notifyOwner({ text: `No answer from ${session.contact}; I texted them the brief.` });
        return;
      } catch (error) {
        this.log(`calls: SMS fallback failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await this.notifyOwner({ text: `No answer from ${session.contact}; want me to try later?` });
  }
}

// ---- The default turn: one governed gateway turn per utterance --------------------------------

const HANGUP_MARK = /\[hangup\]/i;
const OUTCOME_MARK = /\[outcome:\s*([^\]]{1,200})\]/i;

export function callTurnPrompt(input: CallTurnInput): string {
  const lines = [
    `[Phone call] You are an AI assistant on a live phone call with "${input.contact}", calling on behalf of ${input.ownerName?.trim() || "the owner"}.`,
    `Your brief from the owner: ${input.brief}`,
    "Stay within the brief. Never claim to be human. Never dial, text or promise anything the brief does not allow.",
    "Reply with only the words to say next: one or two short spoken sentences.",
    "When the call's purpose is done or the brief says to hang up, end your reply with [hangup]. Put a one-line result for the owner in [outcome: …].",
  ];
  for (const steer of input.steers) lines.push(`The owner just texted you (follow it if it fits the brief): ${steer}`);
  for (const notice of input.notices) lines.push(`Note: ${notice}`);
  lines.push("Transcript so far:");
  for (const line of input.transcript.slice(-20)) lines.push(`${line.speaker}: ${line.text}`);
  lines.push(input.heard === undefined ? "The callee has just answered and heard your AI disclosure. Say why you are calling." : `The callee said: "${input.heard}"`);
  return lines.join("\n");
}

/** Parse a model reply into what to say, the hangup flag and the outcome note. */
export function parseCallReply(text: string): Pick<CallTurnResult, "say" | "hangup" | "outcome"> {
  const outcome = OUTCOME_MARK.exec(text)?.[1]?.trim();
  const hangup = HANGUP_MARK.test(text);
  const say = text.replace(OUTCOME_MARK, "").replace(HANGUP_MARK, "").replace(/\s+/g, " ").trim();
  return { say, ...(hangup ? { hangup } : {}), ...(outcome ? { outcome } : {}) };
}

export function approvalTitle(request: ApprovalRequest): string {
  const show = request.show;
  if (typeof show === "string") return show.slice(0, 120);
  if (show && typeof show === "object") {
    const record = show as Record<string, unknown>;
    for (const key of ["title", "summary", "action", "tool"]) if (typeof record[key] === "string") return String(record[key]).slice(0, 120);
  }
  return `pass gate ${request.gateId}`;
}

/**
 * The gateway's call turn: one governed turn per utterance on the surface
 * `call:<provider>`, keyed by call id so the provider session holds the call.
 */
export function gatewayCallTurnRunner(input: {
  readonly runTurn: (message: SurfaceMessage, pairing: { readonly pairingId: string; readonly surfaceId: string; readonly senderId: string; readonly approvedAt: string }) => Promise<SurfaceReply | { readonly status: "pairing_required" }>;
  readonly usdPer1kTokens?: number;
}): CallTurnRunner {
  return async (turn) => {
    const prompt = callTurnPrompt(turn);
    const message: SurfaceMessage = { surfaceId: "call:twilio", conversationId: turn.callId, senderId: `contact:${turn.contact}`, text: prompt };
    const pairingId = `pair_call_${createHash("sha256").update(turn.callId).digest("hex").slice(0, 12)}`;
    const reply = await input.runTurn(message, { pairingId, surfaceId: message.surfaceId, senderId: message.senderId, approvedAt: new Date(0).toISOString() });
    if ("status" in reply) return { say: "Sorry, I can't continue this call. Goodbye.", hangup: true };
    const rate = input.usdPer1kTokens ?? CALL_DEFAULTS.modelUsdPer1kTokens;
    const usd = ((prompt.length + reply.text.length) / 4 / 1000) * rate;
    const parsed = parseCallReply(reply.text);
    return {
      ...parsed,
      usd,
      ...(reply.approvalRequest ? { approvalRequest: { title: approvalTitle(reply.approvalRequest), request: reply.approvalRequest } } : {}),
    };
  };
}
