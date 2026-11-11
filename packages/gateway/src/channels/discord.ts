import { isPairingChallenge } from "../envelope.js";
import type { SurfaceMessage } from "../envelope.js";
import {
  DISCORD_PONG,
  discordInteractionToInbound,
  discordSignatureIsValid,
  surfaceReplyToDiscordInteractionResponse,
} from "../adapters/discord.js";
import { ChannelDeliveryRejectedError, ChannelVerificationError, headerValue, numberedApprovalRender, resolveSecretEnv } from "../channel-sdk.js";
import type { ChannelAdapter, ChannelContext, ChannelDoctorCheck, ChannelSendResult } from "../channel-sdk.js";
import type { GatewayConfig } from "../gateway-config.js";

/**
 * Discord on the channel SDK. Two inbound paths share this adapter:
 * - signed slash-command interactions on POST /v1/adapters/discord (answered
 *   in the HTTP response, unchanged from the legacy handler);
 * - the gateway WebSocket (channels/discord-gateway.ts) for DMs, @mentions and
 *   button presses, answered over REST.
 */

export const DISCORD_API = "https://discord.com/api/v10";

/** Button-press interactions are answered through this callback, not a new message. */
export interface DiscordInteractionHandle {
  readonly id: string;
  readonly token: string;
  readonly messageId?: string;
}

// Interaction callback types.
const CALLBACK_CHANNEL_MESSAGE = 4;
const CALLBACK_UPDATE_MESSAGE = 7;
const EPHEMERAL = 64;

export function discordBotToken(gateway: GatewayConfig, env: Readonly<Record<string, string | undefined>>): string | undefined {
  return resolveSecretEnv(env, gateway.discord?.botTokenEnv) ?? (gateway.discord?.botToken || undefined);
}

export function discordApiBase(gateway: GatewayConfig): string {
  return (gateway.discord?.apiBaseUrl ?? DISCORD_API).replace(/\/+$/, "");
}

function requireToken(context: ChannelContext): string {
  const token = discordBotToken(context.gateway, context.env);
  if (!token) {
    throw new Error(`Discord bot token is not available: set the environment variable ${context.gateway.discord?.botTokenEnv ?? "(discord.botTokenEnv not configured)"}.`);
  }
  return token;
}

/** One REST call. Errors name the route and status, never the token. */
export async function callDiscord<T = Record<string, unknown>>(
  context: ChannelContext,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await context.fetcher(`${discordApiBase(context.gateway)}${path}`, {
    method,
    headers: {
      authorization: `Bot ${requireToken(context)}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: context.signal,
  });
  const text = await response.text();
  const parsed = (text ? JSON.parse(text) : {}) as T & { message?: unknown };
  if (!response.ok) {
    const route = path.replace(/\/interactions\/[^/]+\/[^/]+/, "/interactions/{id}/{token}");
    throw new ChannelDeliveryRejectedError(`discord ${method} ${route} failed: HTTP ${response.status}${typeof parsed.message === "string" ? ` ${parsed.message}` : ""}`);
  }
  return parsed;
}

function buttonComponents(buttons: readonly { readonly label: string; readonly value: string; readonly style?: "primary" | "danger" }[]) {
  return [{
    type: 1,
    components: buttons.slice(0, 5).map((button) => ({
      type: 2,
      style: button.style === "danger" ? 4 : button.style === "primary" ? 3 : 2,
      label: button.label.slice(0, 80),
      custom_id: button.value,
    })),
  }];
}

interface DiscordGatewayAuthor {
  readonly id?: string;
  readonly bot?: boolean;
}

export interface DiscordGatewayMessage {
  readonly id?: string;
  readonly channel_id?: string;
  readonly guild_id?: string;
  readonly content?: string;
  readonly author?: DiscordGatewayAuthor;
  readonly mentions?: ReadonlyArray<{ readonly id?: string }>;
  readonly webhook_id?: string;
}

/**
 * MESSAGE_CREATE → envelope. DMs always; guild messages only when they
 * mention the bot. Bots (including Muster itself) and webhooks are ignored.
 */
export function discordGatewayMessageToSurfaceMessage(event: DiscordGatewayMessage, botUserId: string | undefined): SurfaceMessage | undefined {
  const author = event.author;
  if (!event.id || !event.channel_id || !author?.id) return undefined;
  if (author.bot || event.webhook_id || (botUserId && author.id === botUserId)) return undefined;
  const content = event.content ?? "";
  if (event.guild_id) {
    if (!botUserId) return undefined;
    const mentioned = event.mentions?.some((mention) => mention.id === botUserId)
      || content.includes(`<@${botUserId}>`)
      || content.includes(`<@!${botUserId}>`);
    if (!mentioned) return undefined;
  }
  const text = botUserId ? content.replaceAll(`<@${botUserId}>`, "").replaceAll(`<@!${botUserId}>`, "").trim() : content.trim();
  if (!text) return undefined;
  return {
    surfaceId: `discord:${event.guild_id ?? "dm"}`,
    conversationId: event.channel_id,
    senderId: author.id,
    text,
    replyTo: event.id,
    raw: event,
  };
}

function interactionHandle(value: unknown): DiscordInteractionHandle | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const handle = value as Partial<DiscordInteractionHandle>;
  return typeof handle.id === "string" && typeof handle.token === "string" ? handle as DiscordInteractionHandle : undefined;
}

/** Answer a button press: replace the pressed message, or (ephemeral) tell only the presser. */
export async function respondToDiscordInteraction(
  context: ChannelContext,
  handle: DiscordInteractionHandle,
  response: { readonly content: string; readonly ephemeral?: boolean },
): Promise<void> {
  await callDiscord(context, "POST", `/interactions/${encodeURIComponent(handle.id)}/${encodeURIComponent(handle.token)}/callback`, response.ephemeral
    ? { type: CALLBACK_CHANNEL_MESSAGE, data: { content: response.content.slice(0, 2000), flags: EPHEMERAL } }
    : { type: CALLBACK_UPDATE_MESSAGE, data: { content: response.content.slice(0, 2000), components: [] } });
}

export const discordChannel: ChannelAdapter = {
  id: "discord",
  label: "Discord",
  capabilities: { buttons: true, edit: true, media: false, threads: true, maxTextLength: 2_000 },
  admitByPairing: true,
  configured: (gateway) => Boolean(gateway.discord?.botToken || gateway.discord?.botTokenEnv),
  surfaceId: () => "discord:dm",
  hasPlatformAuth: (gateway) => Boolean(gateway.discord?.publicKey),
  verifyInbound({ body, headers, gateway }) {
    const publicKey = gateway.discord?.publicKey;
    if (!publicKey) return;
    if (!discordSignatureIsValid(body, headerValue(headers, "x-signature-ed25519"), headerValue(headers, "x-signature-timestamp"), publicKey)) {
      throw new ChannelVerificationError(401, "Discord ed25519 signature verification failed.");
    }
  },
  deliveryKey(body) {
    try {
      const id = (JSON.parse(body) as { id?: unknown } | null)?.id;
      return typeof id === "string" && id ? `discord:${id}` : undefined;
    } catch {
      return undefined;
    }
  },
  normalize(payload, context) {
    const inbound = discordInteractionToInbound(payload, { approvalActions: context.approvalActions });
    return inbound.kind === "message" ? [inbound.message] : [];
  },
  async send(peer, outbound, context) {
    const sent = await callDiscord<{ id?: string }>(context, "POST", `/channels/${encodeURIComponent(peer.conversationId)}/messages`, {
      content: outbound.text,
      allowed_mentions: { parse: [] },
      ...(peer.replyTo && !outbound.continuation ? { message_reference: { message_id: peer.replyTo, fail_if_not_exists: false } } : {}),
      ...(outbound.buttons?.length ? { components: buttonComponents(outbound.buttons) } : {}),
    });
    return { messageIds: sent.id ? [sent.id] : [] };
  },
  async edit(peer, messageId, outbound, context) {
    await callDiscord(context, "PATCH", `/channels/${encodeURIComponent(peer.conversationId)}/messages/${encodeURIComponent(messageId)}`, {
      content: outbound.text,
      ...(outbound.buttons ? { components: outbound.buttons.length ? buttonComponents(outbound.buttons) : [] } : {}),
    });
  },
  renderApproval(input) {
    if (!input.actions) return numberedApprovalRender(input);
    const { runId, gateId, show } = input.request;
    const shown = typeof show === "string" ? show : JSON.stringify(show, null, 2);
    return {
      text: `${input.text ? `${input.text}\n\n` : ""}Approval required (gate \`${gateId}\`, run \`${runId}\`):\n\`\`\`${shown}\`\`\``,
      buttons: [
        { label: "Approve", value: input.actions.approve, style: "primary" },
        { label: "Deny", value: input.actions.reject, style: "danger" },
      ],
    };
  },
  async deliverReply(peer, reply, context): Promise<ChannelSendResult | undefined> {
    // A button press is answered by editing the pressed message to show the decision.
    const handle = interactionHandle(peer.interaction);
    if (!handle) return undefined;
    const text = isPairingChallenge(reply)
      ? `This sender is not paired with Muster yet. Ask an operator to run: \`muster pairing approve ${reply.code}\``
      : reply.text || "Done.";
    await respondToDiscordInteraction(context, handle, { content: text, ephemeral: isPairingChallenge(reply) });
    return { messageIds: handle.messageId ? [handle.messageId] : [] };
  },
  webhook: {
    routes: ["discord"],
    notConfigured: "Discord adapter not configured. Add discord.botToken to .muster/gateway.json.",
    parse(payload, context) {
      const inbound = discordInteractionToInbound(payload, { approvalActions: context.approvalActions });
      if (inbound.kind === "pong") return { kind: "respond", body: DISCORD_PONG };
      if (inbound.kind === "ignored") return inbound;
      return { kind: "messages", messages: [inbound.message] };
    },
    syncReply: (reply, _message, { approvalAction }) => surfaceReplyToDiscordInteractionResponse(reply, { approvalAction }),
    busyResponse: () => ({ type: 5 }),
  },
  async doctor(context, options) {
    const checks: ChannelDoctorCheck[] = [];
    const discord = context.gateway.discord;
    const token = discordBotToken(context.gateway, context.env);
    if (discord?.botTokenEnv) {
      checks.push(token
        ? { id: "bot_token", status: "ok", detail: `env ${discord.botTokenEnv}` }
        : { id: "bot_token", status: "fail", detail: `set the environment variable ${discord.botTokenEnv}` });
    } else {
      checks.push(discord?.botToken
        ? { id: "bot_token", status: "warn", detail: "stored inline in gateway.json; move it to discord.botTokenEnv" }
        : { id: "bot_token", status: "fail", detail: "add discord.botTokenEnv (muster channels setup discord)" });
    }
    checks.push(discord?.publicKey
      ? { id: "interactions", status: "ok", detail: "slash commands are ed25519-verified" }
      : { id: "interactions", status: "warn", detail: "no publicKey: slash-command webhooks need the gateway bearer token" });
    if (options.live && token) {
      try {
        const me = await callDiscord<{ username?: string }>(context, "GET", "/users/@me");
        checks.push({ id: "users_me", status: "ok", detail: `bot ${String(me.username ?? "unknown")}` });
      } catch (error) {
        checks.push({ id: "users_me", status: "fail", detail: error instanceof Error ? error.message : String(error) });
      }
    }
    return checks;
  },
};
