import { createSign } from "node:crypto";
import { isPairingChallenge } from "../envelope.js";
import type { PairingChallenge, SurfaceReply } from "../envelope.js";
import {
  gchatActor,
  gchatDeliveryId,
  gchatEventToken,
  gchatEventToSurfaceMessage,
  surfaceReplyToGchatResponse,
} from "../adapters/gchat.js";
import { ChannelDeliveryRejectedError, ChannelVerificationError, headerValue, numberedApprovalRender, requireSecretEnv } from "../channel-sdk.js";
import type { ChannelAdapter, ChannelContext, ChannelDoctorCheck, ChannelPeer, ChannelSendResult } from "../channel-sdk.js";
import { googleChatAudienceIsValid } from "../gateway-config.js";
import type { GatewayConfig } from "../gateway-config.js";
import { resolveGchatFrappeIdentity } from "../gchat-frappe-identity.js";
import { resolvePairing, upsertTrustedFrappePairing } from "../pairing.js";
import type { ApprovalActionRenderContext } from "../presentation.js";

/**
 * Google Chat on the channel SDK. Without `gchat.api` the reply is the
 * synchronous webhook response (legacy behaviour). With it, the webhook is
 * acknowledged at once and the reply is created in the event's thread through
 * the Chat API, so long turns never hit Chat's response deadline.
 */

const CHAT_API = "https://chat.googleapis.com/v1";
const CHAT_SCOPE = "https://www.googleapis.com/auth/chat.bot";
const REPLY_OPTION = "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD";

interface ServiceAccountKey {
  readonly client_email: string;
  readonly private_key: string;
  readonly token_uri?: string;
}

const tokenCache = new Map<string, { readonly token: string; readonly expiresAt: number }>();

export function googleChatUsesApi(gateway: GatewayConfig): boolean {
  return Boolean(gateway.gchat?.api?.serviceAccountKeyEnv);
}

function serviceAccountKey(context: ChannelContext): ServiceAccountKey {
  const api = context.gateway.gchat?.api;
  const raw = requireSecretEnv(context.env, api?.serviceAccountKeyEnv, "Google Chat service-account key");
  let key: Partial<ServiceAccountKey>;
  try {
    key = JSON.parse(raw) as Partial<ServiceAccountKey>;
  } catch {
    throw new Error(`Google Chat service-account key in ${api?.serviceAccountKeyEnv} is not JSON.`);
  }
  if (typeof key.client_email !== "string" || typeof key.private_key !== "string") {
    throw new Error(`Google Chat service-account key in ${api?.serviceAccountKeyEnv} has no client_email/private_key.`);
  }
  return key as ServiceAccountKey;
}

/** OAuth access token for the Chat API (service-account JWT bearer grant), cached until near expiry. */
async function chatAccessToken(context: ChannelContext): Promise<string> {
  const key = serviceAccountKey(context);
  const tokenUrl = context.gateway.gchat?.api?.tokenUrl ?? key.token_uri ?? "https://oauth2.googleapis.com/token";
  const cacheKey = `${key.client_email}\0${tokenUrl}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
  const now = Math.floor(Date.now() / 1000);
  const segment = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${segment({ alg: "RS256", typ: "JWT" })}.${segment({ iss: key.client_email, scope: CHAT_SCOPE, aud: tokenUrl, iat: now, exp: now + 3600 })}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(key.private_key).toString("base64url");
  const response = await context.fetcher(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${signature}` }).toString(),
  });
  const body = await response.json().catch(() => ({})) as { access_token?: unknown; expires_in?: unknown };
  if (!response.ok || typeof body.access_token !== "string") throw new Error(`Google Chat token request failed: HTTP ${response.status}`);
  const expiresIn = typeof body.expires_in === "number" ? body.expires_in : 3600;
  tokenCache.set(cacheKey, { token: body.access_token, expiresAt: Date.now() + expiresIn * 1000 });
  return body.access_token;
}

async function createMessage(context: ChannelContext, peer: ChannelPeer, message: Record<string, unknown>): Promise<ChannelSendResult> {
  const base = (context.gateway.gchat?.api?.baseUrl ?? CHAT_API).replace(/\/+$/, "");
  if (!/^spaces\/[^/]+$/.test(peer.conversationId)) throw new Error(`Google Chat space must look like spaces/<id>, got ${peer.conversationId}`);
  const token = await chatAccessToken(context);
  const response = await context.fetcher(`${base}/${peer.conversationId}/messages?messageReplyOption=${REPLY_OPTION}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ ...message, ...(peer.replyTo ? { thread: { name: peer.replyTo } } : {}) }),
  });
  const body = await response.json().catch(() => ({})) as { name?: unknown; error?: { message?: string } };
  if (!response.ok) {
    throw new ChannelDeliveryRejectedError(`Google Chat messages.create failed: HTTP ${response.status}${body.error?.message ? ` ${body.error.message}` : ""}`);
  }
  return { messageIds: typeof body.name === "string" ? [body.name] : [] };
}

function syncResponse(reply: SurfaceReply | PairingChallenge, threadName: string | undefined, approvalAction: ApprovalActionRenderContext | undefined) {
  return surfaceReplyToGchatResponse(reply, threadName, { approvalAction });
}

export const googleChatChannel: ChannelAdapter = {
  id: "googlechat",
  label: "Google Chat",
  capabilities: { buttons: true, edit: false, media: false, threads: true, maxTextLength: 4_096 },
  admitByPairing: true,
  configured: (gateway) => Boolean(gateway.gchat),
  surfaceId: () => "gchat:app",
  hasPlatformAuth: (gateway) => Boolean(gateway.gchat?.verificationToken || googleChatAudienceIsValid(gateway.gchat?.verification?.audience)),
  async verifyInbound({ body, headers, gateway, bearerVerifier }) {
    const gchat = gateway.gchat;
    if (!gchat) return;
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      throw new ChannelVerificationError(400, "Google Chat event is not JSON.");
    }
    if (gchat.verification?.mode === "bearer") {
      const valid = bearerVerifier && await bearerVerifier.verify({
        authorization: headerValue(headers, "authorization"),
        rawBody: body,
        payload,
        audience: gchat.verification.audience,
      });
      if (!valid) throw new ChannelVerificationError(401, "Google Chat bearer verification failed.");
    } else if (gchat.verificationToken && gchatEventToken(payload) !== gchat.verificationToken) {
      throw new ChannelVerificationError(401, "Google Chat verification token mismatch.");
    }
  },
  deliveryKey(body) {
    try {
      const message = (JSON.parse(body) as { message?: { name?: unknown } } | null)?.message;
      return typeof message?.name === "string" && message.name ? `gchat:${message.name}` : undefined;
    } catch {
      return undefined;
    }
  },
  normalize(payload, context) {
    const inbound = gchatEventToSurfaceMessage(payload, { commands: context.gateway?.gchat?.commands, approvalActions: context.approvalActions });
    return inbound.kind === "message" ? [inbound.message] : [];
  },
  async send(peer, outbound, context) {
    return createMessage(context, peer, {
      text: outbound.text,
      ...(outbound.buttons?.length ? {
        cardsV2: [{
          cardId: "muster-actions",
          card: { sections: [{ widgets: [{ buttonList: { buttons: outbound.buttons.map((button) => ({
            text: button.label.slice(0, 40),
            onClick: { action: { function: "muster_approval", parameters: [{ key: "command", value: button.value }] } },
          })) } }] }] },
        }],
      } : {}),
    });
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
    // Rich replies keep the legacy card renderer; plain text takes the shared chunked path.
    if (!isPairingChallenge(reply) && !reply.approvalRequest && !reply.presentation) return undefined;
    const { thread: _thread, actionResponse: _dialog, ...message } = syncResponse(reply, peer.replyTo, approvalAction);
    return createMessage(context, peer, message as Record<string, unknown>);
  },
  webhook: {
    routes: ["gchat", "googlechat"],
    notConfigured: "Google Chat adapter not configured. Add a gchat section to .muster/gateway.json.",
    parse(payload, context) {
      const inbound = gchatEventToSurfaceMessage(payload, { commands: context.gateway?.gchat?.commands, approvalActions: context.approvalActions });
      return inbound.kind === "ignored" ? inbound : { kind: "messages", messages: [inbound.message] };
    },
    cacheKey(payload) {
      const id = gchatDeliveryId(payload);
      return id ? `gchat:${id}` : undefined;
    },
    acknowledge: (gateway) => (googleChatUsesApi(gateway) ? { status: 200, body: {} } : undefined),
    syncReply: (reply, message, { gateway, approvalAction }) => (googleChatUsesApi(gateway) ? undefined : syncResponse(reply, message.replyTo, approvalAction)),
    busyResponse: (state) => ({ text: state === "in-flight" ? "This request is already processing." : "This request was already handled." }),
    async beforeTurn(message, payload, context) {
      const identityConfig = context.gateway.gchat?.frappeIdentity;
      if (!identityConfig) return {};
      const actor = gchatActor(payload);
      const existing = await resolvePairing(message.surfaceId, message.senderId, context.cwd);
      const cacheTtlMs = Math.max(0, Math.min(5 * 60_000, Math.trunc(identityConfig.cacheTtlMs ?? 60_000)));
      const identityIsFresh = existing?.identity?.provider === "frappe"
        && Number.isFinite(Date.parse(existing.identity.resolvedAt))
        && Date.now() - Date.parse(existing.identity.resolvedAt) <= cacheTtlMs;
      if (!identityIsFresh) {
        const resolved = await resolveGchatFrappeIdentity(actor, identityConfig, context.fetcher);
        if (!resolved.ok) {
          if (resolved.detail) context.log(`[gchat] Frappe identity resolution failed: ${resolved.detail}`);
          return { respond: { text: resolved.reason } };
        }
        await upsertTrustedFrappePairing(message.surfaceId, message.senderId, resolved.identity, context.cwd);
      }
      return {
        trustedFrappe: {
          pageType: "Google Chat",
          summary: "The sender identity was resolved by Frappe. No business record rows were attached to this turn.",
        },
      };
    },
  },
  async doctor(context, options) {
    const checks: ChannelDoctorCheck[] = [];
    const gchat = context.gateway.gchat;
    if (!gchat) return [{ id: "config", status: "fail", detail: "add a gchat section (muster channels setup gchat)" }];
    checks.push(gchat.verification?.mode === "bearer" && googleChatAudienceIsValid(gchat.verification.audience)
      ? { id: "verification", status: "ok", detail: `bearer audience ${gchat.verification.audience}` }
      : gchat.verificationToken
        ? { id: "verification", status: "warn", detail: "legacy payload token" }
        : { id: "verification", status: "fail", detail: "set gchat.verification.audience" });
    if (gchat.api) {
      try {
        serviceAccountKey(context);
        checks.push({ id: "chat_api", status: "ok", detail: `service-account key from env ${gchat.api.serviceAccountKeyEnv}` });
        if (options.live) {
          await chatAccessToken(context);
          checks.push({ id: "chat_token", status: "ok", detail: "access token issued" });
        }
      } catch (error) {
        checks.push({ id: "chat_api", status: "fail", detail: error instanceof Error ? error.message : String(error) });
      }
    } else {
      checks.push({ id: "chat_api", status: "warn", detail: "replies are synchronous webhook responses; set gchat.api.serviceAccountKeyEnv to answer long turns in-thread" });
    }
    return checks;
  },
};
