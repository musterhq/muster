import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { SurfaceMessage } from "../envelope.js";
import type { GatewayConfig, GatewayMatrixChannelConfig } from "../gateway-config.js";
import { isLocalHost, numberedApprovalRender, requireSecretEnv, resolveSecretEnv } from "../channel-sdk.js";
import type { ChannelAdapter, ChannelContext, ChannelDoctorCheck, ChannelInbound, ChannelInvite, ChannelPoller } from "../channel-sdk.js";

/**
 * Matrix client-server API channel: /sync long-poll in, room send out.
 * End-to-end encrypted rooms are out of scope: m.room.encrypted events are
 * skipped and the doctor says so.
 */

interface MatrixEvent {
  readonly event_id?: string;
  readonly room_id?: string;
  readonly sender?: string;
  readonly type?: string;
  readonly state_key?: string;
  readonly content?: Record<string, unknown>;
}

interface MatrixSync {
  readonly next_batch?: string;
  readonly rooms?: {
    readonly join?: Record<string, { readonly timeline?: { readonly events?: readonly MatrixEvent[] } }>;
    readonly invite?: Record<string, { readonly invite_state?: { readonly events?: readonly MatrixEvent[] } }>;
  };
}

function matrixConfig(gateway: GatewayConfig): GatewayMatrixChannelConfig {
  const config = gateway.channels?.matrix;
  if (!config?.homeserverUrl || !config.userId || !config.accessTokenEnv) {
    throw new Error("Matrix channel not configured. Run: muster channels setup matrix");
  }
  return config;
}

async function matrixApi<T>(
  context: ChannelContext,
  method: string,
  path: string,
  body?: unknown,
  extra: { readonly contentType?: string; readonly raw?: Blob; readonly signal?: AbortSignal } = {},
): Promise<T> {
  const config = matrixConfig(context.gateway);
  const token = requireSecretEnv(context.env, config.accessTokenEnv, "Matrix access token");
  const response = await context.fetcher(`${config.homeserverUrl.replace(/\/+$/, "")}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined || extra.raw ? { "content-type": extra.contentType ?? "application/json" } : {}),
    },
    body: extra.raw ? extra.raw : body === undefined ? undefined : JSON.stringify(body),
    signal: extra.signal ?? context.signal,
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(`matrix ${method} ${path.split("?")[0]} failed: HTTP ${response.status}${typeof payload.errcode === "string" ? ` ${payload.errcode}` : ""}`);
  }
  return payload as T;
}

/** Drop the quoted fallback Matrix clients prepend to replies ("> <@user> ..."). */
function stripReplyFallback(body: string): string {
  const lines = body.split("\n");
  if (!lines[0]?.startsWith("> ")) return body;
  let index = 0;
  while (index < lines.length && lines[index].startsWith(">")) index += 1;
  while (index < lines.length && !lines[index].trim()) index += 1;
  return lines.slice(index).join("\n");
}

export function matrixSurfaceId(gateway: GatewayConfig): string {
  return `matrix:${gateway.channels?.matrix?.userId ?? "unconfigured"}`;
}

function encodePath(value: string): string {
  return encodeURIComponent(value);
}

export const matrixChannel: ChannelAdapter = {
  id: "matrix",
  label: "Matrix",
  capabilities: { buttons: false, edit: true, media: true, threads: true, maxTextLength: 16_000 },
  configured: (gateway) => Boolean(gateway.channels?.matrix?.homeserverUrl && gateway.channels.matrix.userId && gateway.channels.matrix.accessTokenEnv),
  surfaceId: matrixSurfaceId,
  normalize(payload, context): SurfaceMessage[] {
    if (typeof payload !== "object" || payload === null) return [];
    const event = payload as MatrixEvent;
    const own = context.gateway?.channels?.matrix?.userId;
    if (event.type !== "m.room.message" || !event.event_id || !event.room_id || !event.sender) return [];
    if (own && event.sender === own) return [];
    const content = event.content ?? {};
    if (content.msgtype !== "m.text" && content.msgtype !== "m.emote") return [];
    const relates = content["m.relates_to"] as { rel_type?: unknown } | undefined;
    if (relates?.rel_type === "m.replace") return [];
    const body = typeof content.body === "string" ? stripReplyFallback(content.body).trim() : "";
    if (!body) return [];
    return [{
      surfaceId: context.gateway ? matrixSurfaceId(context.gateway) : "matrix:unconfigured",
      conversationId: event.room_id,
      senderId: event.sender,
      text: body,
      replyTo: event.event_id,
      raw: event,
    }];
  },
  async send(peer, outbound, context) {
    const content: Record<string, unknown> = { msgtype: "m.text", body: outbound.text };
    if (peer.replyTo && !outbound.continuation) content["m.relates_to"] = { "m.in_reply_to": { event_id: peer.replyTo } };
    const result = await matrixApi<{ event_id?: string }>(
      context,
      "PUT",
      `/_matrix/client/v3/rooms/${encodePath(peer.conversationId)}/send/m.room.message/${encodePath(`muster-${randomUUID()}`)}`,
      content,
    );
    return { messageIds: result.event_id ? [result.event_id] : [] };
  },
  async edit(peer, messageId, outbound, context) {
    await matrixApi(context, "PUT", `/_matrix/client/v3/rooms/${encodePath(peer.conversationId)}/send/m.room.message/${encodePath(`muster-${randomUUID()}`)}`, {
      msgtype: "m.text",
      body: `* ${outbound.text}`,
      "m.new_content": { msgtype: "m.text", body: outbound.text },
      "m.relates_to": { rel_type: "m.replace", event_id: messageId },
    });
  },
  async sendMedia(peer, artifact, context) {
    const bytes = await readFile(artifact.path);
    const name = artifact.name || basename(artifact.path);
    const uploaded = await matrixApi<{ content_uri?: string }>(context, "POST", `/_matrix/media/v3/upload?filename=${encodeURIComponent(name)}`, undefined, {
      raw: new Blob([bytes]),
      contentType: artifact.mime || "application/octet-stream",
    });
    if (!uploaded.content_uri) throw new Error("matrix upload returned no content_uri");
    const result = await matrixApi<{ event_id?: string }>(context, "PUT", `/_matrix/client/v3/rooms/${encodePath(peer.conversationId)}/send/m.room.message/${encodePath(`muster-${randomUUID()}`)}`, {
      msgtype: "m.file",
      body: name,
      url: uploaded.content_uri,
      info: { mimetype: artifact.mime, size: bytes.length },
    });
    return { messageIds: result.event_id ? [result.event_id] : [] };
  },
  renderApproval: numberedApprovalRender,
  openPoller(context): ChannelPoller {
    const config = matrixConfig(context.gateway);
    let warnedEncrypted = false;
    return {
      async poll(cursor) {
        if (!cursor) {
          // First start: take the current position and skip history.
          const initial = await matrixApi<MatrixSync>(context, "GET", `/_matrix/client/v3/sync?timeout=0&filter=${encodeURIComponent(JSON.stringify({ room: { timeline: { limit: 1 } } }))}`);
          return { items: [], cursor: initial.next_batch };
        }
        const timeout = Math.max(0, config.syncTimeoutMs ?? 30_000);
        const sync = await matrixApi<MatrixSync>(context, "GET", `/_matrix/client/v3/sync?since=${encodeURIComponent(cursor)}&timeout=${timeout}`);
        const items: ChannelInbound[] = [];
        for (const [roomId, room] of Object.entries(sync.rooms?.join ?? {})) {
          for (const event of room.timeline?.events ?? []) {
            if (event.type === "m.room.encrypted" && !warnedEncrypted) {
              warnedEncrypted = true;
              context.log(`matrix: room ${roomId} is end-to-end encrypted; encrypted messages are not supported and were skipped`);
            }
            for (const message of matrixChannel.normalize({ ...event, room_id: event.room_id ?? roomId }, { gateway: context.gateway })) {
              items.push({ deliveryId: `matrix:${message.replyTo}`, message });
            }
          }
        }
        const invites: ChannelInvite[] = [];
        for (const [roomId, room] of Object.entries(sync.rooms?.invite ?? {})) {
          const member = room.invite_state?.events?.find((event) => event.type === "m.room.member" && event.state_key === config.userId && event.content?.membership === "invite");
          if (member?.sender) invites.push({ conversationId: roomId, inviterId: member.sender });
        }
        return { items, invites, cursor: sync.next_batch ?? cursor };
      },
      async close() {},
    };
  },
  async acceptInvite(invite, context) {
    if (context.gateway.channels?.matrix?.autoJoin === false) return;
    await matrixApi(context, "POST", `/_matrix/client/v3/rooms/${encodePath(invite.conversationId)}/join`, {});
  },
  async doctor(context, options) {
    const checks: ChannelDoctorCheck[] = [];
    const config = context.gateway.channels?.matrix;
    if (!config?.homeserverUrl || !config.userId || !config.accessTokenEnv) {
      return [{ id: "config", status: "fail", detail: "not configured; run muster channels setup matrix" }];
    }
    let url: URL | undefined;
    try { url = new URL(config.homeserverUrl); } catch { /* reported below */ }
    checks.push(!url
      ? { id: "homeserver", status: "fail", detail: `invalid homeserver URL ${config.homeserverUrl}` }
      : url.protocol !== "https:" && !isLocalHost(url.hostname)
        ? { id: "homeserver", status: "warn", detail: `${url.origin} is not HTTPS` }
        : { id: "homeserver", status: "ok", detail: url.origin });
    checks.push(/^@[^:]+:.+$/.test(config.userId)
      ? { id: "user_id", status: "ok", detail: config.userId }
      : { id: "user_id", status: "fail", detail: `${config.userId} is not a Matrix user id (@name:server)` });
    const token = resolveSecretEnv(context.env, config.accessTokenEnv);
    checks.push(token
      ? { id: "access_token", status: "ok", detail: `from env ${config.accessTokenEnv}` }
      : { id: "access_token", status: "fail", detail: `environment variable ${config.accessTokenEnv} is not set` });
    checks.push(config.allowFrom?.length
      ? { id: "allow_from", status: "ok", detail: `${config.allowFrom.length} rule(s)` }
      : { id: "allow_from", status: "warn", detail: "allowFrom is empty; nobody can reach Muster" });
    checks.push({ id: "encryption", status: "ok", detail: "unencrypted rooms only; end-to-end encrypted rooms are not supported" });
    if (options.live && token && url) {
      try {
        const whoami = await matrixApi<{ user_id?: string }>(context, "GET", "/_matrix/client/v3/account/whoami");
        checks.push(whoami.user_id === config.userId
          ? { id: "whoami", status: "ok", detail: `token belongs to ${whoami.user_id}` }
          : { id: "whoami", status: "fail", detail: `token belongs to ${String(whoami.user_id)}, not ${config.userId}` });
      } catch (error) {
        checks.push({ id: "whoami", status: "fail", detail: error instanceof Error ? error.message : String(error) });
      }
    }
    return checks;
  },
};
