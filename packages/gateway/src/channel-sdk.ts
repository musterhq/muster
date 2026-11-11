import type { ApprovalRequest, PairingChallenge, SurfaceArtifact, SurfaceAttachment, SurfaceMessage, SurfaceReply } from "./envelope.js";
import type { TrustedFrappeContext } from "./frappe-ingress.js";
import type { GatewayConfig } from "./gateway-config.js";
import type { ApprovalActionParser, ApprovalActionRenderContext, ApprovalActionTokens } from "./presentation.js";

/**
 * Channel SDK: the one contract every chat channel implements.
 *
 * An adapter only knows its platform: how to verify and normalize what comes
 * in, and how to send, edit and attach what goes out. Durable ingress, the
 * sender allowlist, pairing, governance and numbered approvals are applied by
 * the shared path in channel-runner.ts, never by an adapter.
 */

/** Thrown by verifyInbound; the HTTP route answers with `status`. */
export class ChannelVerificationError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "ChannelVerificationError";
  }
}

/**
 * Thrown by send when the platform definitively refused the message (an HTTP
 * error answer, not a lost connection). The durable webhook path keeps the
 * generated reply and retries delivery instead of running the turn again.
 */
export class ChannelDeliveryRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChannelDeliveryRejectedError";
  }
}

export interface ChannelCapabilities {
  /** Native buttons for approvals and actions. Without them approvals become a numbered text choice. */
  readonly buttons: boolean;
  /** A sent message can be edited (live drafts, progress). */
  readonly edit: boolean;
  /** Files can be attached natively. */
  readonly media: boolean;
  /** Replies can be threaded under the inbound message. */
  readonly threads: boolean;
  /** Longest text one message may carry; longer text is split. */
  readonly maxTextLength: number;
}

/** Where an outbound message goes. A bare string is shorthand for `{ conversationId }`. */
export interface ChannelPeer {
  /** Chat, room, channel or email thread/address, in the channel's own terms. */
  readonly conversationId: string;
  /** Message to reply to or thread under. */
  readonly replyTo?: string;
  /** The person the message is for; required for numbered approvals. */
  readonly senderId?: string;
  /** Overrides the adapter's surface id (e.g. a Slack team surface). */
  readonly surfaceId?: string;
  /** The inbound platform payload, when replying to one. */
  readonly raw?: unknown;
  /** A platform handle that must answer this item (e.g. a Discord interaction id and token). */
  readonly interaction?: unknown;
}

export interface ChannelButton {
  readonly label: string;
  readonly value: string;
  readonly style?: "primary" | "danger";
}

export interface ChannelOutbound {
  readonly text: string;
  readonly buttons?: readonly ChannelButton[];
  /** True for the 2nd..nth chunk of one long reply. */
  readonly continuation?: boolean;
}

export interface ChannelVoiceAudio {
  readonly path: string;
  readonly mime: string;
  readonly seconds?: number;
}

export interface ChannelSendResult {
  readonly messageIds: readonly string[];
}

export interface ChannelContext {
  readonly gateway: GatewayConfig;
  readonly fetcher: typeof fetch;
  readonly log: (line: string) => void;
  readonly cwd: string;
  /** Environment used to resolve `*Env` secret references. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly signal?: AbortSignal;
}

export interface ChannelInboundRequest {
  readonly body: string;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly gateway: GatewayConfig;
  /** For verifiers that fetch signing keys (Bot Framework JWKS). Only configured endpoints are fetched. */
  readonly fetcher?: typeof fetch;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Host-injected bearer verifier (Google Chat signed requests). */
  readonly bearerVerifier?: {
    verify(input: { readonly authorization: string | undefined; readonly rawBody: string; readonly payload: unknown; readonly audience: string }): boolean | Promise<boolean>;
  };
}

export interface ChannelNormalizeContext {
  readonly gateway?: GatewayConfig;
  readonly approvalActions?: ApprovalActionParser;
}

export interface ChannelInbound {
  /** Stable platform delivery id, the durable-ingress key. */
  readonly deliveryId: string;
  readonly message: SurfaceMessage;
  /**
   * The adapter's own policy admitted this sender (e.g. the WhatsApp group
   * allowlist), so the shared path skips the per-sender pairing step.
   */
  readonly preAuthorized?: boolean;
  /** Handed to the reply peer (see ChannelPeer.interaction). */
  readonly interaction?: unknown;
}

export interface ChannelInvite {
  readonly conversationId: string;
  readonly inviterId: string;
}

export interface ChannelPollResult {
  readonly items: readonly ChannelInbound[];
  readonly invites?: readonly ChannelInvite[];
  /** Opaque resume point, persisted by the runner after the batch is handled. */
  readonly cursor: string | undefined;
}

/** A long-lived inbound connection (sync long-poll, IMAP session). */
export interface ChannelPoller {
  poll(cursor: string | undefined): Promise<ChannelPollResult>;
  /** Called after an inbound item was handled (e.g. flag the mail \Seen). */
  acknowledge?(item: ChannelInbound): Promise<void>;
  close(): Promise<void>;
}

export interface ChannelDoctorCheck {
  readonly id: string;
  readonly status: "ok" | "warn" | "fail";
  readonly detail: string;
}

export interface ChannelApprovalRender {
  readonly text: string;
  readonly buttons?: readonly ChannelButton[];
}

/** What a raw webhook body asks for. */
export type ChannelWebhookInbound =
  /** Answer at once with this body and start no turn (e.g. Discord PING). */
  | { readonly kind: "respond"; readonly body: unknown }
  | { readonly kind: "ignored"; readonly reason: string }
  | { readonly kind: "messages"; readonly messages: readonly SurfaceMessage[] };

export interface ChannelWebhookTurn {
  /** Answer with this instead of running the turn. */
  readonly respond?: SurfaceReply;
  readonly trustedFrappe?: TrustedFrappeContext;
}

/**
 * Webhook behaviour of a channel, used by the shared webhook path
 * (serveChannelWebhook in channel-runner.ts) behind POST /v1/adapters/<route>.
 */
export interface ChannelWebhook {
  /** Route ids under /v1/adapters/. The first one is the durable-ingress scope. */
  readonly routes: readonly string[];
  /** Error for a request that arrives while the channel is not configured. */
  readonly notConfigured: string;
  parse(payload: unknown, context: ChannelNormalizeContext): ChannelWebhookInbound;
  /** Key for the in-process reply cache; defaults to deliveryKey. */
  cacheKey?(payload: unknown): string | undefined;
  /**
   * Acknowledge the request at once with this status and body, and answer
   * later through `send`. Undefined answers within the HTTP response.
   */
  acknowledge?(gateway: GatewayConfig, payload: unknown): { readonly status: number; readonly body: unknown } | undefined;
  /** The reply as the HTTP response body, or undefined to send it through the outbound API. */
  syncReply?(
    reply: SurfaceReply | PairingChallenge,
    message: SurfaceMessage,
    context: { readonly gateway: GatewayConfig; readonly approvalAction?: ApprovalActionRenderContext },
  ): unknown;
  /** Body for a retry that is still running or already answered. */
  busyResponse?(state: "in-flight" | "replay"): unknown;
  /** Channel-specific step before the turn (e.g. Google Chat's Frappe identity). */
  beforeTurn?(message: SurfaceMessage, payload: unknown, context: ChannelContext): Promise<ChannelWebhookTurn>;
}

export interface ChannelAdapter {
  readonly id: string;
  readonly label: string;
  readonly capabilities: ChannelCapabilities;
  /**
   * Senders are admitted by pairing alone unless channels.<id>.allowFrom is
   * set. Channels that predate the SDK keep this, so existing setups work.
   */
  readonly admitByPairing?: boolean;
  /** Present on channels that receive webhooks on /v1/adapters/<route>. */
  readonly webhook?: ChannelWebhook;
  /** True when gateway.json has what this channel needs. */
  configured(gateway: GatewayConfig): boolean;
  /** Surface id used for pairing and sessions, e.g. "telegram:bot". */
  surfaceId(gateway: GatewayConfig): string;
  /** True when inbound webhooks are authenticated by the platform itself. */
  hasPlatformAuth?(gateway: GatewayConfig): boolean;
  /** Authenticate a raw inbound webhook; throw ChannelVerificationError to reject. */
  verifyInbound?(request: ChannelInboundRequest): void | Promise<void>;
  /** Durable delivery key for a raw webhook body. */
  deliveryKey?(body: string): string | undefined;
  /** Platform payload → zero or more gateway envelopes. */
  normalize(payload: unknown, context: ChannelNormalizeContext): SurfaceMessage[];
  /** Send one message (already within maxTextLength). */
  send(peer: ChannelPeer, outbound: ChannelOutbound, context: ChannelContext): Promise<ChannelSendResult>;
  edit?(peer: ChannelPeer, messageId: string, outbound: ChannelOutbound, context: ChannelContext): Promise<void>;
  sendMedia?(peer: ChannelPeer, artifact: SurfaceArtifact, context: ChannelContext): Promise<ChannelSendResult>;
  /**
   * Fetch the bytes of an inbound attachment that carries a platform url
   * (Telegram file id, Matrix mxc://). The shared voice path calls this only
   * after its length and size checks pass.
   */
  downloadAttachment?(attachment: SurfaceAttachment, context: ChannelContext, options?: { readonly maxBytes?: number }): Promise<Uint8Array>;
  /** Send a spoken reply as a native voice message (Ogg/Opus). Without it the runner falls back to sendMedia. */
  sendVoice?(peer: ChannelPeer, audio: ChannelVoiceAudio, context: ChannelContext): Promise<ChannelSendResult>;
  /** Approval prompt: buttons when the channel has them, otherwise a numbered choice. */
  renderApproval(input: { readonly request: ApprovalRequest; readonly text?: string; readonly actions?: ApprovalActionTokens }): ChannelApprovalRender;
  /** Text sent to an unpaired sender. */
  pairingText?(code: string): string;
  /**
   * Optional rich delivery (presentations, native approval cards). Return
   * undefined to fall back to the shared text path.
   */
  deliverReply?(
    peer: ChannelPeer,
    reply: SurfaceReply | { readonly status: "pairing_required"; readonly code: string },
    context: ChannelContext,
    approvalAction?: ApprovalActionRenderContext,
  ): Promise<ChannelSendResult | undefined>;
  /** Inbound for channels that pull (long-poll, IMAP) instead of receiving webhooks. */
  openPoller?(context: ChannelContext): ChannelPoller;
  /** Join a conversation the bot was invited to (only called for allowed inviters). */
  acceptInvite?(invite: ChannelInvite, context: ChannelContext): Promise<void>;
  /** Config and (with live) connection checks. Must never print secret values. */
  doctor(context: ChannelContext, options: { readonly live: boolean }): Promise<ChannelDoctorCheck[]>;
}

export class ChannelRegistry {
  private readonly adapters = new Map<string, ChannelAdapter>();

  constructor(adapters: readonly ChannelAdapter[] = []) {
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter: ChannelAdapter): void {
    if (!/^[a-z][a-z0-9-]*$/.test(adapter.id)) throw new Error(`Invalid channel id: ${adapter.id}`);
    if (this.adapters.has(adapter.id)) throw new Error(`Channel already registered: ${adapter.id}`);
    this.adapters.set(adapter.id, adapter);
  }

  get(id: string): ChannelAdapter | undefined {
    return this.adapters.get(id);
  }

  require(id: string): ChannelAdapter {
    const adapter = this.adapters.get(id);
    if (!adapter) throw new Error(`Unknown channel: ${id}. Known channels: ${[...this.adapters.keys()].join(", ")}`);
    return adapter;
  }

  list(): readonly ChannelAdapter[] {
    return [...this.adapters.values()];
  }
}

/**
 * Split text into pieces no longer than `limit`, preferring paragraph, line
 * and word boundaries. Separators stay with the earlier piece, so joining the
 * pieces gives back the original text exactly.
 */
export function chunkText(text: string, limit: number): string[] {
  if (limit <= 0) throw new Error("chunk limit must be positive");
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    let cut = window.lastIndexOf("\n\n") + 2;
    if (cut < limit / 2) cut = window.lastIndexOf("\n") + 1;
    if (cut < limit / 2) cut = window.lastIndexOf(" ") + 1;
    if (cut < limit / 2) cut = limit;
    // Never split a surrogate pair.
    const code = rest.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/**
 * Allowlist match: exact id (case-insensitive), "*" for anyone, or a
 * "*suffix" wildcard such as "*@example.com" or "*:example.org".
 */
export function senderAllowed(allowFrom: readonly string[] | undefined, senderId: string): boolean {
  if (!allowFrom?.length) return false;
  const sender = senderId.trim().toLowerCase();
  return allowFrom.some((rule) => {
    const pattern = rule.trim().toLowerCase();
    if (!pattern) return false;
    if (pattern === "*") return true;
    if (pattern.startsWith("*")) return sender.endsWith(pattern.slice(1));
    return sender === pattern;
  });
}

/** Resolve an env-var secret reference. Returns undefined when unset or empty. */
export function resolveSecretEnv(env: Readonly<Record<string, string | undefined>>, name: string | undefined): string | undefined {
  if (!name) return undefined;
  const value = env[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function requireSecretEnv(env: Readonly<Record<string, string | undefined>>, name: string | undefined, what: string): string {
  const value = resolveSecretEnv(env, name);
  if (!value) throw new Error(`${what} is not available: set the environment variable ${name ?? "(not configured)"}.`);
  return value;
}

export function headerValue(headers: ChannelInboundRequest["headers"], name: string): string | undefined {
  const value = headers[name];
  return typeof value === "string" ? value : undefined;
}

export const NUMBERED_APPROVAL_PROMPT = "Reply 1 to approve or 2 to reject.";

/** Text approval for channels without buttons. */
export function numberedApprovalRender(input: { readonly request: ApprovalRequest; readonly text?: string; readonly actions?: ApprovalActionTokens }): ChannelApprovalRender {
  const { runId, gateId, show } = input.request;
  const shown = typeof show === "string" ? show : JSON.stringify(show, null, 2);
  const lead = input.text ? `${input.text}\n\n` : "";
  const footer = input.actions
    ? NUMBERED_APPROVAL_PROMPT
    : "Approval controls are unavailable in this message. Ask an operator to reopen the approval.";
  return { text: `${lead}Approval required (gate "${gateId}", run ${runId}):\n${shown}\n\n${footer}` };
}

export function defaultPairingText(code: string): string {
  return `This conversation is not paired with Muster yet. Ask an operator to run:\nmuster pairing approve ${code}`;
}

export function isLocalHost(host: string): boolean {
  const value = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return value === "localhost" || value === "::1" || value.startsWith("127.");
}

/** `muster channels list`: one row per registered channel, with whether gateway.json configures it. */
export function channelRegistryTable(registry: ChannelRegistry, gateway: GatewayConfig): string {
  const yes = (value: boolean) => (value ? "yes" : "no");
  const rows = registry.list().map((adapter) => [
    adapter.id,
    adapter.label,
    yes(adapter.capabilities.buttons),
    yes(adapter.capabilities.edit),
    String(adapter.capabilities.maxTextLength),
    adapter.configured(gateway) ? "configured" : "not configured",
  ].join("\t"));
  return `${["channel", "label", "buttons", "edit", "max_text", "status"].join("\t")}\n${rows.join("\n")}\n`;
}
