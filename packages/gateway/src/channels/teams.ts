import { isPairingChallenge } from "../envelope.js";
import { surfaceReplyToTeamsActivity, teamsActivityToSurfaceMessage, teamsHmacIsValid } from "../adapters/teams.js";
import { ChannelDeliveryRejectedError, ChannelVerificationError, headerValue, numberedApprovalRender, requireSecretEnv } from "../channel-sdk.js";
import type { ChannelAdapter, ChannelContext, ChannelDoctorCheck, ChannelPeer, ChannelSendResult } from "../channel-sdk.js";
import type { GatewayConfig } from "../gateway-config.js";
import { botFrameworkAccessToken, verifyBotFrameworkToken } from "./bot-framework.js";

/**
 * Microsoft Teams on the channel SDK, two modes:
 * - Bot Framework (teams.appId + teams.appPasswordEnv): JWT-verified
 *   activities are acknowledged with 202 at once; the reply is sent later to
 *   the connector with a bot token, so long turns never time out.
 * - Outgoing webhook (teams.hmacSecret): the legacy synchronous reply.
 */

export function teamsUsesBotFramework(gateway: GatewayConfig): boolean {
  return Boolean(gateway.teams?.appId && gateway.teams.appPasswordEnv);
}

function activityOf(raw: unknown): { readonly serviceUrl?: string; readonly id?: string } | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as { serviceUrl?: unknown; id?: unknown; platformPayload?: unknown };
  if (typeof record.serviceUrl === "string") return record as { serviceUrl: string; id?: string };
  return record.platformPayload ? activityOf(record.platformPayload) : undefined;
}

async function postActivity(context: ChannelContext, peer: ChannelPeer, activity: Record<string, unknown>): Promise<ChannelSendResult> {
  const teams = context.gateway.teams;
  if (!teams?.appId) throw new Error("Teams Bot Framework is not configured: set teams.appId and teams.appPasswordEnv.");
  const serviceUrl = activityOf(peer.raw)?.serviceUrl;
  if (!serviceUrl) throw new Error("Teams needs the conversation's serviceUrl; reply to an inbound activity.");
  const base = serviceUrl.replace(/\/+$/, "");
  const conversation = encodeURIComponent(peer.conversationId);
  const url = peer.replyTo
    ? `${base}/v3/conversations/${conversation}/activities/${encodeURIComponent(peer.replyTo)}`
    : `${base}/v3/conversations/${conversation}/activities`;
  const token = await botFrameworkAccessToken({
    appId: teams.appId,
    appPassword: requireSecretEnv(context.env, teams.appPasswordEnv, "Teams app password"),
    tokenUrl: teams.tokenUrl,
    fetcher: context.fetcher,
  });
  const response = await context.fetcher(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ ...activity, ...(peer.replyTo ? { replyToId: peer.replyTo } : {}) }),
  });
  const body = await response.json().catch(() => ({})) as { id?: unknown };
  if (!response.ok) throw new ChannelDeliveryRejectedError(`Teams connector rejected the reply: HTTP ${response.status}`);
  return { messageIds: typeof body.id === "string" ? [body.id] : [] };
}

export const teamsChannel: ChannelAdapter = {
  id: "teams",
  label: "Microsoft Teams",
  capabilities: { buttons: true, edit: false, media: false, threads: true, maxTextLength: 28_000 },
  admitByPairing: true,
  configured: (gateway) => Boolean(gateway.teams),
  surfaceId: () => "teams:tenant",
  hasPlatformAuth: (gateway) => Boolean(gateway.teams?.hmacSecret) || teamsUsesBotFramework(gateway),
  async verifyInbound({ body, headers, gateway, fetcher }) {
    const teams = gateway.teams;
    if (!teams) return;
    const authorization = headerValue(headers, "authorization");
    if (teamsUsesBotFramework(gateway) && !(teams.hmacSecret && authorization?.startsWith("HMAC "))) {
      let serviceUrl: string | undefined;
      try {
        serviceUrl = activityOf(JSON.parse(body))?.serviceUrl;
      } catch {
        throw new ChannelVerificationError(400, "Teams activity is not JSON.");
      }
      const valid = await verifyBotFrameworkToken({
        authorization,
        appId: teams.appId!,
        serviceUrl,
        openIdConfigUrl: teams.openIdConfigUrl,
        issuer: teams.issuer,
        fetcher: fetcher ?? fetch,
      });
      if (!valid) throw new ChannelVerificationError(401, "Teams Bot Framework token verification failed.");
      return;
    }
    if (teams.hmacSecret && !teamsHmacIsValid(body, authorization, teams.hmacSecret)) {
      throw new ChannelVerificationError(401, "Teams HMAC signature mismatch.");
    }
  },
  deliveryKey(body) {
    try {
      const id = (JSON.parse(body) as { id?: unknown } | null)?.id;
      return typeof id === "string" && id ? `teams:${id}` : undefined;
    } catch {
      return undefined;
    }
  },
  normalize(payload, context) {
    const inbound = teamsActivityToSurfaceMessage(payload, { approvalActions: context.approvalActions });
    return inbound.kind === "message" ? [inbound.message] : [];
  },
  async send(peer, outbound, context) {
    return postActivity(context, peer, {
      type: "message",
      text: outbound.text,
      ...(outbound.buttons?.length ? {
        attachments: [{
          contentType: "application/vnd.microsoft.card.adaptive",
          content: {
            type: "AdaptiveCard",
            version: "1.5",
            body: [{ type: "TextBlock", text: outbound.text, wrap: true }],
            actions: outbound.buttons.map((button) => ({
              type: "Action.Submit",
              title: button.label,
              data: { musterAction: button.value },
              ...(button.style === "primary" ? { style: "positive" } : button.style === "danger" ? { style: "destructive" } : {}),
            })),
          },
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
    // Rich replies (adaptive cards) keep the legacy renderer; plain text takes the shared chunked path.
    if (!isPairingChallenge(reply) && !reply.approvalRequest && !reply.presentation) return undefined;
    return postActivity(context, peer, { ...surfaceReplyToTeamsActivity(reply, { approvalAction }) });
  },
  webhook: {
    routes: ["teams"],
    notConfigured: "Teams adapter not configured. Add a teams section to .muster/gateway.json.",
    parse(payload, context) {
      const inbound = teamsActivityToSurfaceMessage(payload, { approvalActions: context.approvalActions });
      return inbound.kind === "ignored" ? inbound : { kind: "messages", messages: [inbound.message] };
    },
    acknowledge: (gateway) => (teamsUsesBotFramework(gateway) ? { status: 202, body: {} } : undefined),
    syncReply: (reply, _message, { gateway, approvalAction }) => (teamsUsesBotFramework(gateway) ? undefined : surfaceReplyToTeamsActivity(reply, { approvalAction })),
    busyResponse: (state) => ({ type: "message", text: state === "in-flight" ? "This request is already processing." : "This request was already handled." }),
  },
  async doctor(context, options) {
    const checks: ChannelDoctorCheck[] = [];
    const teams = context.gateway.teams;
    if (!teams) return [{ id: "config", status: "fail", detail: "add a teams section (muster channels setup teams)" }];
    if (teamsUsesBotFramework(context.gateway)) {
      checks.push({ id: "mode", status: "ok", detail: `Bot Framework app ${teams.appId}` });
      try {
        const password = requireSecretEnv(context.env, teams.appPasswordEnv, "Teams app password");
        checks.push({ id: "app_password", status: "ok", detail: `env ${teams.appPasswordEnv}` });
        if (options.live) {
          await botFrameworkAccessToken({ appId: teams.appId!, appPassword: password, tokenUrl: teams.tokenUrl, fetcher: context.fetcher });
          checks.push({ id: "bot_token", status: "ok", detail: "token issued" });
        }
      } catch (error) {
        checks.push({ id: "app_password", status: "fail", detail: error instanceof Error ? error.message : String(error) });
      }
    } else {
      checks.push(teams.hmacSecret
        ? { id: "mode", status: "ok", detail: "outgoing webhook (HMAC); replies must finish within Teams' 5 s window" }
        : { id: "mode", status: "fail", detail: "set teams.appId + teams.appPasswordEnv (Bot Framework) or teams.hmacSecret" });
    }
    return checks;
  },
};
