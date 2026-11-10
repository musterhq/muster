import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { isPairingChallenge } from "../envelope.js";
import { surfaceReplyToTelegramSend, TELEGRAM_FILE_URL_PREFIX, TELEGRAM_SURFACE_ID, telegramUpdateToSurfaceMessage } from "../adapters/telegram.js";
import { ChannelVerificationError, headerValue, numberedApprovalRender } from "../channel-sdk.js";
import type { ChannelAdapter, ChannelContext, ChannelDoctorCheck, ChannelSendResult } from "../channel-sdk.js";

const TELEGRAM_API = "https://api.telegram.org";

function constantTimeEquals(presented: string | undefined, expected: string): boolean {
  const left = Buffer.from(presented ?? "");
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function botToken(context: ChannelContext): string {
  const token = context.gateway.telegram?.botToken;
  if (!token) throw new Error("Telegram adapter not configured. Add telegram.botToken to .muster/gateway.json.");
  return token;
}

async function callTelegram(context: ChannelContext, method: string, payload: unknown): Promise<Record<string, unknown>> {
  const response = await context.fetcher(`${TELEGRAM_API}/bot${botToken(context)}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok || body.ok !== true) {
    throw new Error(`telegram ${method} failed: HTTP ${response.status}${typeof body.description === "string" ? ` ${body.description}` : ""}`);
  }
  return body;
}

function messageIdOf(body: Record<string, unknown>): string[] {
  const id = (body.result as { message_id?: unknown } | undefined)?.message_id;
  return typeof id === "number" || typeof id === "string" ? [String(id)] : [];
}

/** Telegram Bot API on the channel SDK. Mappers are the unchanged legacy ones in adapters/telegram.ts. */
export const telegramChannel: ChannelAdapter = {
  id: "telegram",
  label: "Telegram",
  capabilities: { buttons: true, edit: true, media: true, threads: false, maxTextLength: 4_096 },
  configured: (gateway) => Boolean(gateway.telegram?.botToken),
  surfaceId: () => TELEGRAM_SURFACE_ID,
  hasPlatformAuth: (gateway) => Boolean(gateway.telegram?.secretToken),
  verifyInbound({ headers, gateway }) {
    const secretToken = gateway.telegram?.secretToken;
    if (!secretToken) return;
    if (!constantTimeEquals(headerValue(headers, "x-telegram-bot-api-secret-token"), secretToken)) {
      throw new ChannelVerificationError(401, "Telegram secret token mismatch.");
    }
  },
  deliveryKey(body) {
    try {
      const payload = JSON.parse(body) as unknown;
      const updateId = typeof payload === "object" && payload !== null ? (payload as { update_id?: unknown }).update_id : undefined;
      return typeof updateId === "number" ? `telegram:${updateId}` : undefined;
    } catch {
      return undefined;
    }
  },
  normalize(payload, context) {
    const message = telegramUpdateToSurfaceMessage(payload, { approvalActions: context.approvalActions });
    return message ? [message] : [];
  },
  async send(peer, outbound, context) {
    const body = await callTelegram(context, "sendMessage", {
      chat_id: peer.conversationId,
      text: outbound.text,
      ...(outbound.buttons?.length ? {
        reply_markup: { inline_keyboard: [outbound.buttons.map((button) => ({ text: button.label, callback_data: button.value }))] },
      } : {}),
    });
    return { messageIds: messageIdOf(body) };
  },
  async edit(peer, messageId, outbound, context) {
    await callTelegram(context, "editMessageText", { chat_id: peer.conversationId, message_id: Number(messageId), text: outbound.text });
  },
  async sendMedia(peer, artifact, context) {
    const bytes = await readFile(artifact.path);
    const form = new FormData();
    form.set("chat_id", peer.conversationId);
    form.set("caption", artifact.name || basename(artifact.path));
    form.set("document", new Blob([bytes], { type: artifact.mime || "application/octet-stream" }), artifact.name || basename(artifact.path));
    const response = await context.fetcher(`${TELEGRAM_API}/bot${botToken(context)}/sendDocument`, { method: "POST", body: form });
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok || body.ok !== true) throw new Error(`telegram sendDocument failed: HTTP ${response.status}`);
    return { messageIds: messageIdOf(body) };
  },
  async downloadAttachment(attachment, context) {
    if (!attachment.url?.startsWith(TELEGRAM_FILE_URL_PREFIX)) throw new Error("telegram: attachment has no Telegram file id");
    const fileId = attachment.url.slice(TELEGRAM_FILE_URL_PREFIX.length);
    const body = await callTelegram(context, "getFile", { file_id: fileId });
    const filePath = (body.result as { file_path?: unknown } | undefined)?.file_path;
    if (typeof filePath !== "string" || !filePath) throw new Error("telegram getFile returned no file_path");
    const response = await context.fetcher(`${TELEGRAM_API}/file/bot${botToken(context)}/${filePath.split("/").map(encodeURIComponent).join("/")}`, { signal: context.signal });
    // The download URL holds the bot token; errors name only the status.
    if (!response.ok) throw new Error(`telegram file download failed: HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  },
  async sendVoice(peer, audio, context) {
    const bytes = await readFile(audio.path);
    const form = new FormData();
    form.set("chat_id", peer.conversationId);
    form.set("voice", new Blob([bytes], { type: audio.mime || "audio/ogg" }), basename(audio.path));
    if (audio.seconds) form.set("duration", String(Math.round(audio.seconds)));
    const response = await context.fetcher(`${TELEGRAM_API}/bot${botToken(context)}/sendVoice`, { method: "POST", body: form });
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok || body.ok !== true) throw new Error(`telegram sendVoice failed: HTTP ${response.status}`);
    return { messageIds: messageIdOf(body) };
  },
  renderApproval(input) {
    if (!input.actions) return numberedApprovalRender(input);
    const { runId, gateId, show } = input.request;
    const shown = typeof show === "string" ? show : JSON.stringify(show, null, 2);
    return {
      text: `${input.text ? `${input.text}\n\n` : ""}Approval required (gate "${gateId}", run ${runId}):\n${shown}`,
      buttons: [
        { label: "Approve", value: input.actions.approve, style: "primary" },
        { label: "Reject", value: input.actions.reject, style: "danger" },
      ],
    };
  },
  async deliverReply(peer, reply, context, approvalAction): Promise<ChannelSendResult | undefined> {
    // Plain text takes the shared chunked path; rich replies keep the legacy renderer.
    if (!isPairingChallenge(reply) && !reply.approvalRequest && !reply.presentation) return undefined;
    const body = await callTelegram(context, "sendMessage", surfaceReplyToTelegramSend(reply, peer.conversationId, { approvalAction }));
    return { messageIds: messageIdOf(body) };
  },
  async doctor(context, options) {
    const checks: ChannelDoctorCheck[] = [];
    const telegram = context.gateway.telegram;
    checks.push(telegram?.botToken
      ? { id: "bot_token", status: "ok", detail: "configured" }
      : { id: "bot_token", status: "fail", detail: "add telegram.botToken (muster channels setup telegram)" });
    checks.push(telegram?.secretToken
      ? { id: "webhook_secret", status: "ok", detail: "configured" }
      : { id: "webhook_secret", status: "warn", detail: "webhook requests are not authenticated; long-poll is unaffected" });
    if (options.live && telegram?.botToken) {
      try {
        const body = await callTelegram(context, "getMe", {});
        const username = (body.result as { username?: unknown } | undefined)?.username;
        checks.push({ id: "get_me", status: "ok", detail: `bot @${String(username ?? "unknown")}` });
      } catch (error) {
        checks.push({ id: "get_me", status: "fail", detail: error instanceof Error ? error.message : String(error) });
      }
    }
    return checks;
  },
};
