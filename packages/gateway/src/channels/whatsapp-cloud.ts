import { createHmac, timingSafeEqual } from "node:crypto";
import { sizeLimitMessage, VoiceLimitError } from "@musterhq/core";
import { isPairingChallenge } from "../envelope.js";
import type { SurfaceMessage } from "../envelope.js";
import { surfaceReplyToWhatsAppSend, whatsAppMessageIds, whatsAppWebhookToSurfaceMessages } from "../adapters/whatsapp-cloud.js";
import { ChannelDeliveryRejectedError, ChannelVerificationError, headerValue, numberedApprovalRender, resolveSecretEnv } from "../channel-sdk.js";
import type { ChannelAdapter, ChannelContext, ChannelDoctorCheck, ChannelSendResult } from "../channel-sdk.js";
import type { ChannelNormalizeContext } from "../channel-sdk.js";
import type { GatewayConfig } from "../gateway-config.js";

/**
 * WhatsApp Cloud API (business number) on the channel SDK: signed webhooks
 * in, Graph API /messages out, voice notes through the shared voice path.
 * Text and interactive mapping is the unchanged legacy mapper in
 * adapters/whatsapp-cloud.ts.
 */

const GRAPH = "https://graph.facebook.com";
/** Audio attachments carry this pseudo-url; the Graph token never appears in an envelope. */
export const WHATSAPP_MEDIA_URL_PREFIX = "whatsapp-media:";

export function whatsAppCloudSignatureIsValid(body: string, header: string | undefined, appSecret: string): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = Buffer.from(`sha256=${createHmac("sha256", appSecret).update(body).digest("hex")}`);
  const presented = Buffer.from(header);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

export function whatsAppCloudAccessToken(gateway: GatewayConfig, env: Readonly<Record<string, string | undefined>>): string | undefined {
  const config = gateway["whatsapp-cloud"];
  return resolveSecretEnv(env, config?.accessTokenEnv) ?? (config?.accessToken || undefined);
}

function graphBase(gateway: GatewayConfig): string {
  return `${GRAPH}/${gateway["whatsapp-cloud"]?.apiVersion ?? "v19.0"}`;
}

function requireConfig(context: ChannelContext): { readonly token: string; readonly phoneNumberId: string } {
  const config = context.gateway["whatsapp-cloud"];
  const token = whatsAppCloudAccessToken(context.gateway, context.env);
  if (!config?.phoneNumberId || !token) {
    throw new Error("WhatsApp Cloud API adapter not configured. Add whatsapp-cloud.{accessTokenEnv,verifyToken,phoneNumberId} to .muster/gateway.json.");
  }
  return { token, phoneNumberId: config.phoneNumberId };
}

async function postMessage(context: ChannelContext, payload: unknown): Promise<ChannelSendResult> {
  const { token, phoneNumberId } = requireConfig(context);
  const response = await context.fetcher(`${graphBase(context.gateway)}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({})) as { error?: { message?: string }; messages?: Array<{ id?: string }> };
  if (!response.ok || body.error) {
    throw new ChannelDeliveryRejectedError(`WhatsApp did not acknowledge the reply: HTTP ${response.status}${body.error?.message ? ` ${body.error.message}` : ""}`);
  }
  return { messageIds: (body.messages ?? []).flatMap((message) => (message.id ? [message.id] : [])) };
}

interface CloudMessage {
  readonly from?: string;
  readonly id?: string;
  readonly type?: string;
  readonly audio?: { readonly id?: string; readonly mime_type?: string; readonly voice?: boolean };
  readonly context?: { readonly id?: string };
}

interface CloudWebhook {
  readonly object?: string;
  readonly entry?: ReadonlyArray<{
    readonly changes?: ReadonlyArray<{
      readonly field?: string;
      readonly value?: { readonly metadata?: { readonly phone_number_id?: string }; readonly messages?: readonly CloudMessage[] };
    }>;
  }>;
}

/** Legacy text/interactive mapping per message, plus audio messages as attachments for the voice path. */
export function whatsAppCloudToSurfaceMessages(payload: unknown, context: ChannelNormalizeContext): SurfaceMessage[] {
  if (typeof payload !== "object" || payload === null) return [];
  const webhook = payload as CloudWebhook;
  if (webhook.object !== "whatsapp_business_account") return [];
  const messages: SurfaceMessage[] = [];
  for (const entry of webhook.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "messages" || !change.value) continue;
      const phoneNumberId = change.value.metadata?.phone_number_id ?? "unknown-number";
      for (const message of change.value.messages ?? []) {
        if (message.type === "audio") {
          if (!message.from || !message.audio?.id) continue;
          messages.push({
            surfaceId: `whatsapp-cloud:${phoneNumberId}`,
            conversationId: message.from,
            senderId: message.from,
            text: "",
            attachments: [{
              name: message.audio.voice ? "voice-note.ogg" : "audio",
              mime: message.audio.mime_type?.split(";")[0]?.trim() || "audio/ogg",
              url: `${WHATSAPP_MEDIA_URL_PREFIX}${message.audio.id}`,
            }],
            replyTo: message.context?.id,
            raw: payload,
          });
          continue;
        }
        const single = { ...webhook, entry: [{ ...entry, changes: [{ ...change, value: { ...change.value, messages: [message] } }] }] };
        messages.push(...whatsAppWebhookToSurfaceMessages(single, { approvalActions: context.approvalActions }).map((mapped) => ({ ...mapped, raw: mapped.raw === single ? payload : mapped.raw })));
      }
    }
  }
  return messages;
}

export const whatsAppCloudChannel: ChannelAdapter = {
  id: "whatsapp-cloud",
  label: "WhatsApp Cloud API",
  capabilities: { buttons: true, edit: false, media: false, threads: false, maxTextLength: 4_096 },
  admitByPairing: true,
  configured: (gateway) => Boolean(gateway["whatsapp-cloud"]?.phoneNumberId && (gateway["whatsapp-cloud"].accessToken || gateway["whatsapp-cloud"].accessTokenEnv)),
  surfaceId: (gateway) => `whatsapp-cloud:${gateway["whatsapp-cloud"]?.phoneNumberId ?? "unknown-number"}`,
  hasPlatformAuth: (gateway) => Boolean(gateway["whatsapp-cloud"]?.appSecret),
  verifyInbound({ body, headers, gateway }) {
    const appSecret = gateway["whatsapp-cloud"]?.appSecret;
    if (!appSecret) return;
    if (!whatsAppCloudSignatureIsValid(body, headerValue(headers, "x-hub-signature-256"), appSecret)) {
      throw new ChannelVerificationError(401, "WhatsApp signature verification failed.");
    }
  },
  deliveryKey(body) {
    try {
      const ids = whatsAppMessageIds(JSON.parse(body));
      return ids.length ? `whatsapp-cloud:${ids.join(",")}` : undefined;
    } catch {
      return undefined;
    }
  },
  normalize: (payload, context) => whatsAppCloudToSurfaceMessages(payload, context),
  async send(peer, outbound, context) {
    if (outbound.buttons?.length) {
      return postMessage(context, {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: peer.conversationId,
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: outbound.text.slice(0, 1024) },
          action: { buttons: outbound.buttons.slice(0, 3).map((button) => ({ type: "reply", reply: { id: button.value, title: button.label.slice(0, 20) } })) },
        },
      });
    }
    return postMessage(context, { messaging_product: "whatsapp", recipient_type: "individual", to: peer.conversationId, type: "text", text: { body: outbound.text } });
  },
  async downloadAttachment(attachment, context, options) {
    if (!attachment.url?.startsWith(WHATSAPP_MEDIA_URL_PREFIX)) throw new Error("whatsapp-cloud: attachment has no media id");
    const mediaId = attachment.url.slice(WHATSAPP_MEDIA_URL_PREFIX.length);
    const { token } = requireConfig(context);
    const meta = await context.fetcher(`${graphBase(context.gateway)}/${encodeURIComponent(mediaId)}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: context.signal,
    });
    if (!meta.ok) throw new Error(`whatsapp-cloud media lookup failed: HTTP ${meta.status}`);
    const info = await meta.json() as { url?: unknown; file_size?: unknown };
    if (typeof info.url !== "string" || !info.url) throw new Error("whatsapp-cloud media lookup returned no url");
    // Size check on Meta's metadata, before any bytes are fetched.
    if (typeof info.file_size === "number" && options?.maxBytes !== undefined && info.file_size > options.maxBytes) {
      throw new VoiceLimitError(sizeLimitMessage(info.file_size, options.maxBytes), "bytes");
    }
    const media = await context.fetcher(info.url, { headers: { authorization: `Bearer ${token}` }, signal: context.signal });
    if (!media.ok) throw new Error(`whatsapp-cloud media download failed: HTTP ${media.status}`);
    return new Uint8Array(await media.arrayBuffer());
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
  async deliverReply(peer, reply, context, approvalAction) {
    // Plain text takes the shared chunked path; rich replies keep the legacy interactive renderer.
    if (!isPairingChallenge(reply) && !reply.approvalRequest && !reply.presentation) return undefined;
    return postMessage(context, surfaceReplyToWhatsAppSend(reply, peer.conversationId, { approvalAction }));
  },
  webhook: {
    routes: ["whatsapp-cloud"],
    notConfigured: "WhatsApp Cloud API adapter not configured. Add whatsapp-cloud.{accessToken,verifyToken,phoneNumberId} to .muster/gateway.json.",
    parse(payload, context) {
      const messages = whatsAppCloudToSurfaceMessages(payload, context);
      return messages.length ? { kind: "messages", messages } : { kind: "ignored", reason: "no text messages in notification" };
    },
    acknowledge: () => ({ status: 200, body: { ok: true, accepted: true } }),
    busyResponse: (state) => (state === "in-flight" ? { ok: true, accepted: true } : { ok: true, replayed: true }),
  },
  async doctor(context, options) {
    const checks: ChannelDoctorCheck[] = [];
    const config = context.gateway["whatsapp-cloud"];
    const token = whatsAppCloudAccessToken(context.gateway, context.env);
    checks.push(token
      ? { id: "access_token", status: config?.accessTokenEnv ? "ok" : "warn", detail: config?.accessTokenEnv ? `env ${config.accessTokenEnv}` : "stored inline in gateway.json; move it to accessTokenEnv" }
      : { id: "access_token", status: "fail", detail: config?.accessTokenEnv ? `set the environment variable ${config.accessTokenEnv}` : "add whatsapp-cloud.accessTokenEnv" });
    checks.push(config?.phoneNumberId
      ? { id: "phone_number_id", status: "ok", detail: config.phoneNumberId }
      : { id: "phone_number_id", status: "fail", detail: "add whatsapp-cloud.phoneNumberId" });
    checks.push(config?.appSecret
      ? { id: "app_secret", status: "ok", detail: "X-Hub-Signature-256 is verified" }
      : { id: "app_secret", status: "warn", detail: "webhooks are not signature-verified" });
    if (options.live && token && config?.phoneNumberId) {
      try {
        const response = await context.fetcher(`${graphBase(context.gateway)}/${config.phoneNumberId}`, { headers: { authorization: `Bearer ${token}` } });
        checks.push({ id: "graph", status: response.ok ? "ok" : "fail", detail: `GET phone number: HTTP ${response.status}` });
      } catch (error) {
        checks.push({ id: "graph", status: "fail", detail: error instanceof Error ? error.message : String(error) });
      }
    }
    return checks;
  },
};
