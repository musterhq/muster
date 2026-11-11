import { setTimeout as delay } from "node:timers/promises";
import type { FlowToolRegistry, MusterConfig } from "@musterhq/core";
import { ingestChannelInbound, openChannelRuntime } from "../channel-runner.js";
import type { IngestDeps } from "../channel-runner.js";
import type { ChannelContext } from "../channel-sdk.js";
import type { DurableGatewayIngress } from "../durable-ingress.js";
import type { GatewayEnterpriseRuntime } from "../enterprise-runtime.js";
import type { SurfaceMessage } from "../envelope.js";
import type { GatewayConfig } from "../gateway-config.js";
import { parseSurfaceAction, VERIFIED_APPROVAL_COMMAND, verifiedApprovalRaw } from "../presentation.js";
import {
  callDiscord,
  discordBotToken,
  discordChannel,
  discordGatewayMessageToSurfaceMessage,
  respondToDiscordInteraction,
} from "./discord.js";
import type { DiscordGatewayMessage, DiscordInteractionHandle } from "./discord.js";

/**
 * Discord gateway WebSocket client (API v10, JSON encoding) and the worker
 * that feeds it into the shared channel runner. Uses Node's global WebSocket.
 *
 * Protocol: HELLO → heartbeat every heartbeat_interval (first one jittered),
 * each must be ACKed before the next or the connection is a zombie and is
 * dropped; IDENTIFY with intents on a fresh session, RESUME (session id +
 * last sequence) on reconnect; INVALID_SESSION false clears the session and
 * re-identifies; reconnects back off exponentially.
 */

export const DISCORD_GATEWAY_INTENTS = (1 << 9) | (1 << 12) | (1 << 15); // GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT

const OP_DISPATCH = 0;
const OP_HEARTBEAT = 1;
const OP_IDENTIFY = 2;
const OP_RESUME = 6;
const OP_RECONNECT = 7;
const OP_INVALID_SESSION = 9;
const OP_HELLO = 10;
const OP_HEARTBEAT_ACK = 11;

/** Close codes after which reconnecting cannot help. */
const FATAL_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
/** Close codes after which the session cannot be resumed. */
const SESSION_LOST_CLOSE_CODES = new Set([4007, 4009]);

interface GatewayPayload {
  readonly op: number;
  readonly d?: any;
  readonly s?: number | null;
  readonly t?: string | null;
}

export interface DiscordGatewayClientOptions {
  readonly url: string;
  readonly token: string;
  readonly intents?: number;
  readonly onDispatch: (type: string, data: any) => Promise<void> | void;
  readonly log?: (line: string) => void;
  readonly signal?: AbortSignal;
  readonly reconnect?: { readonly initialMs?: number; readonly maxMs?: number };
}

function withQuery(url: string): string {
  const parsed = new URL(url);
  if (!parsed.searchParams.has("v")) parsed.searchParams.set("v", "10");
  if (!parsed.searchParams.has("encoding")) parsed.searchParams.set("encoding", "json");
  return parsed.toString();
}

export class DiscordGatewayClient {
  readonly #options: DiscordGatewayClientOptions;
  #sessionId?: string;
  #resumeUrl?: string;
  #seq: number | null = null;
  #botUserId?: string;
  #dispatches: Promise<void> = Promise.resolve();

  constructor(options: DiscordGatewayClientOptions) {
    this.#options = options;
  }

  get botUserId(): string | undefined { return this.#botUserId; }

  /** Connect and keep the connection until the signal aborts or a fatal close. */
  async run(): Promise<void> {
    const initial = this.#options.reconnect?.initialMs ?? 1_000;
    const max = this.#options.reconnect?.maxMs ?? 60_000;
    let backoff = initial;
    while (!this.#options.signal?.aborted) {
      const outcome = await this.#connectOnce(() => { backoff = initial; });
      if (outcome.fatal) throw new Error(`discord gateway closed with ${outcome.code}: ${outcome.reason || "fatal"}`);
      if (this.#options.signal?.aborted) break;
      this.#options.log?.(`discord: gateway connection closed (${outcome.code}); reconnecting in ${backoff} ms${this.#sessionId ? " to resume" : ""}`);
      await delay(backoff, undefined, { signal: this.#options.signal }).catch(() => undefined);
      backoff = Math.min(backoff * 2, max);
    }
    await this.#dispatches;
  }

  #connectOnce(onReady: () => void): Promise<{ readonly code: number; readonly reason: string; readonly fatal: boolean }> {
    return new Promise((resolvePromise) => {
      const resuming = Boolean(this.#sessionId && this.#resumeUrl && this.#seq !== null);
      const socket = new WebSocket(withQuery(resuming ? this.#resumeUrl! : this.#options.url));
      let heartbeat: NodeJS.Timeout | undefined;
      let firstBeat: NodeJS.Timeout | undefined;
      let acked = true;
      let settled = false;
      const send = (payload: GatewayPayload) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
      };
      const beat = () => {
        if (!acked) {
          // No ACK since the last heartbeat: a zombie connection. Drop it and resume.
          this.#options.log?.("discord: heartbeat not acknowledged; reconnecting");
          socket.close(4000, "heartbeat timeout");
          return;
        }
        acked = false;
        send({ op: OP_HEARTBEAT, d: this.#seq });
      };
      const identify = () => send({
        op: OP_IDENTIFY,
        d: {
          token: this.#options.token,
          intents: this.#options.intents ?? DISCORD_GATEWAY_INTENTS,
          properties: { os: process.platform, browser: "muster", device: "muster" },
        },
      });
      const stopTimers = () => {
        if (heartbeat) clearInterval(heartbeat);
        if (firstBeat) clearTimeout(firstBeat);
      };
      const abort = () => socket.close(1000, "stopping");
      this.#options.signal?.addEventListener("abort", abort, { once: true });
      socket.addEventListener("message", (event) => {
        let payload: GatewayPayload;
        try {
          payload = JSON.parse(typeof event.data === "string" ? event.data : Buffer.from(event.data as ArrayBuffer).toString("utf8")) as GatewayPayload;
        } catch {
          return;
        }
        if (typeof payload.s === "number") this.#seq = payload.s;
        switch (payload.op) {
          case OP_HELLO: {
            const interval = Number(payload.d?.heartbeat_interval) || 41_250;
            firstBeat = setTimeout(() => {
              beat();
              heartbeat = setInterval(beat, interval);
            }, Math.floor(interval * Math.random()));
            if (resuming) send({ op: OP_RESUME, d: { token: this.#options.token, session_id: this.#sessionId, seq: this.#seq } });
            else identify();
            break;
          }
          case OP_HEARTBEAT_ACK:
            acked = true;
            break;
          case OP_HEARTBEAT:
            send({ op: OP_HEARTBEAT, d: this.#seq });
            break;
          case OP_RECONNECT:
            socket.close(4000, "reconnect requested");
            break;
          case OP_INVALID_SESSION: {
            const resumable = payload.d === true;
            if (!resumable) {
              this.#sessionId = undefined;
              this.#resumeUrl = undefined;
              this.#seq = null;
            }
            const wait = this.#options.reconnect?.initialMs ?? 1_000 + Math.floor(Math.random() * 4_000);
            void delay(wait, undefined, { signal: this.#options.signal }).then(() => {
              if (resumable) socket.close(4000, "resume after invalid session");
              else identify();
            }, () => undefined);
            break;
          }
          case OP_DISPATCH: {
            const type = payload.t ?? "";
            if (type === "READY") {
              this.#sessionId = payload.d?.session_id;
              this.#resumeUrl = payload.d?.resume_gateway_url;
              this.#botUserId = payload.d?.user?.id;
              onReady();
              this.#options.log?.(`discord: gateway ready as ${this.#botUserId ?? "unknown"}`);
            } else if (type === "RESUMED") {
              onReady();
              this.#options.log?.("discord: gateway session resumed");
            }
            // Dispatches are handled one at a time, in order; heartbeats keep running meanwhile.
            this.#dispatches = this.#dispatches.then(() => this.#options.onDispatch(type, payload.d)).catch((error: unknown) => {
              this.#options.log?.(`discord: handling ${type} failed: ${error instanceof Error ? error.message : String(error)}`);
            });
            break;
          }
          default:
            break;
        }
      });
      const finish = (code: number, reason: string) => {
        if (settled) return;
        settled = true;
        stopTimers();
        this.#options.signal?.removeEventListener("abort", abort);
        if (SESSION_LOST_CLOSE_CODES.has(code)) {
          this.#sessionId = undefined;
          this.#resumeUrl = undefined;
          this.#seq = null;
        }
        resolvePromise({ code, reason, fatal: FATAL_CLOSE_CODES.has(code) });
      };
      socket.addEventListener("close", (event) => finish(event.code, event.reason));
      socket.addEventListener("error", () => {
        // A close event follows; make sure we settle even if it does not.
        setTimeout(() => finish(1006, "socket error"), 0);
      });
    });
  }
}

export interface DiscordGatewayWorkerOptions {
  readonly config: MusterConfig;
  readonly gateway: GatewayConfig;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetcher?: typeof fetch;
  readonly registry?: FlowToolRegistry;
  readonly enterprise?: GatewayEnterpriseRuntime;
  readonly ingress?: DurableGatewayIngress;
  readonly signal?: AbortSignal;
  readonly log?: (line: string) => void;
  readonly reconnect?: { readonly initialMs?: number; readonly maxMs?: number };
}

interface DiscordInteraction {
  readonly id?: string;
  readonly token?: string;
  readonly type?: number;
  readonly guild_id?: string;
  readonly channel_id?: string;
  readonly member?: { readonly user?: { readonly id?: string } };
  readonly user?: { readonly id?: string };
  readonly message?: { readonly id?: string };
  readonly data?: { readonly custom_id?: string };
}

const ONLY_REQUESTER = "Only the person who asked can approve this.";

/** A button press: approvals are checked against the requester before anything runs. */
async function handleInteraction(interaction: DiscordInteraction, deps: IngestDeps, context: ChannelContext): Promise<void> {
  if (interaction.type !== 3 || !interaction.id || !interaction.token || !interaction.channel_id) return;
  const handle: DiscordInteractionHandle = { id: interaction.id, token: interaction.token, messageId: interaction.message?.id };
  const presser = interaction.member?.user?.id ?? interaction.user?.id;
  const customId = interaction.data?.custom_id;
  if (!presser || !customId) return;
  const surfaceId = `discord:${interaction.guild_id ?? "dm"}`;
  const attempt = { actorId: presser, surfaceId, conversationId: interaction.channel_id };
  const verified = deps.approvals.codec.parse(customId, attempt);
  let text: string;
  let raw: unknown = interaction;
  if (verified.ok) {
    text = VERIFIED_APPROVAL_COMMAND;
    raw = verifiedApprovalRaw(interaction, verified);
  } else if (verified.reason === "wrong_actor") {
    await respondToDiscordInteraction(context, handle, { content: ONLY_REQUESTER, ephemeral: true });
    return;
  } else if (verified.reason !== "invalid") {
    await respondToDiscordInteraction(context, handle, { content: `This approval can no longer be used (${verified.reason.replaceAll("_", " ")}).`, ephemeral: true });
    return;
  } else {
    const command = parseSurfaceAction(customId);
    if (!command) return;
    text = command;
  }
  const message: SurfaceMessage = { surfaceId, conversationId: interaction.channel_id, senderId: presser, text, replyTo: interaction.message?.id, raw };
  await ingestChannelInbound({ deliveryId: `discord:${interaction.id}`, message, interaction: handle }, deps);
}

/**
 * Run the Discord bot until the signal aborts: DMs and @mentions start turns
 * through the shared runner (durable ingress on discord:<message id>), button
 * presses resolve approvals for the requester only.
 */
export async function runDiscordGateway(options: DiscordGatewayWorkerOptions): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const log = options.log ?? ((line: string) => console.log(line));
  const env = options.env ?? process.env;
  if (!discordChannel.configured(options.gateway)) throw new Error("Discord is not configured. Run: muster channels setup discord");
  const token = discordBotToken(options.gateway, env);
  if (!token) throw new Error(`Discord bot token is not available: set the environment variable ${options.gateway.discord?.botTokenEnv ?? "(discord.botTokenEnv)"}.`);
  const context: ChannelContext = { gateway: options.gateway, cwd, fetcher: options.fetcher ?? fetch, log, env, signal: options.signal };
  const runtime = openChannelRuntime(discordChannel, context, options);
  try {
    const url = options.gateway.discord?.gatewayUrl
      ?? (await callDiscord<{ url?: string }>(context, "GET", "/gateway/bot")).url;
    if (!url) throw new Error("discord: GET /gateway/bot returned no url");
    const client: DiscordGatewayClient = new DiscordGatewayClient({
      url,
      token,
      log,
      signal: options.signal,
      reconnect: options.reconnect,
      onDispatch: async (type, data) => {
        if (type === "MESSAGE_CREATE") {
          const event = data as DiscordGatewayMessage;
          const message = discordGatewayMessageToSurfaceMessage(event, client.botUserId);
          if (message && event.id) await ingestChannelInbound({ deliveryId: `discord:${event.id}`, message }, runtime.deps);
        } else if (type === "INTERACTION_CREATE") {
          await handleInteraction(data as DiscordInteraction, runtime.deps, context);
        }
      },
    });
    log("discord: gateway worker started");
    await client.run();
  } finally {
    await runtime.close();
    log("discord: gateway worker stopped");
  }
}
