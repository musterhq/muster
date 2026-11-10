import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { isPairingChallenge } from "../envelope.js";
import { slackDeliveryId, slackEventToSurfaceMessage, slackSignatureIsValid, surfaceReplyToSlackPost } from "../adapters/slack.js";
import { ChannelVerificationError, headerValue, numberedApprovalRender } from "../channel-sdk.js";
import type { ChannelAdapter, ChannelContext, ChannelDoctorCheck, ChannelSendResult } from "../channel-sdk.js";

const SLACK_API = "https://slack.com/api";

/** Slack sends JSON events, or form-encoded interactivity/slash payloads. */
export function parseSlackBody(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    const fields = Object.fromEntries(new URLSearchParams(body));
    if (typeof fields.payload === "string") return JSON.parse(fields.payload);
    return fields;
  }
}

function botToken(context: ChannelContext): string {
  const token = context.gateway.slack?.botToken;
  if (!token) throw new Error("Slack adapter not configured. Add slack.botToken to .muster/gateway.json.");
  return token;
}

async function callSlack(context: ChannelContext, method: string, payload: unknown): Promise<Record<string, unknown>> {
  const response = await context.fetcher(`${SLACK_API}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${botToken(context)}` },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok || body.ok !== true) {
    throw new Error(`slack ${method} failed: HTTP ${response.status}${typeof body.error === "string" ? ` ${body.error}` : ""}`);
  }
  return body;
}

function tsOf(body: Record<string, unknown>): string[] {
  return typeof body.ts === "string" ? [body.ts] : [];
}

/** Slack (Events API / Socket Mode) on the channel SDK. Mappers are the unchanged legacy ones in adapters/slack.ts. */
export const slackChannel: ChannelAdapter = {
  id: "slack",
  label: "Slack",
  capabilities: { buttons: true, edit: true, media: true, threads: true, maxTextLength: 4_000 },
  configured: (gateway) => Boolean(gateway.slack?.botToken),
  surfaceId: () => "slack:unknown-team",
  hasPlatformAuth: (gateway) => Boolean(gateway.slack?.signingSecret),
  verifyInbound({ body, headers, gateway }) {
    const signingSecret = gateway.slack?.signingSecret;
    if (!signingSecret) return;
    if (!slackSignatureIsValid(headerValue(headers, "x-slack-request-timestamp"), body, headerValue(headers, "x-slack-signature"), signingSecret)) {
      throw new ChannelVerificationError(401, "Slack signature verification failed.");
    }
  },
  deliveryKey(body) {
    let payload: unknown;
    try {
      payload = parseSlackBody(body);
    } catch {
      return undefined;
    }
    const id = slackDeliveryId(payload);
    return id ? `slack:${id}` : undefined;
  },
  normalize(payload, context) {
    const inbound = slackEventToSurfaceMessage(payload, { approvalActions: context.approvalActions });
    return inbound.kind === "message" ? [inbound.message] : [];
  },
  async send(peer, outbound, context) {
    const body = await callSlack(context, "chat.postMessage", {
      channel: peer.conversationId,
      ...(peer.replyTo ? { thread_ts: peer.replyTo } : {}),
      text: outbound.text,
      ...(outbound.buttons?.length ? {
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: outbound.text.slice(0, 3_000) } },
          { type: "actions", elements: outbound.buttons.map((button, index) => ({
            type: "button",
            text: { type: "plain_text", text: button.label.slice(0, 75) },
            action_id: `muster_action_${index}`,
            value: button.value,
            ...(button.style ? { style: button.style } : {}),
          })) },
        ],
      } : {}),
    });
    return { messageIds: tsOf(body) };
  },
  async edit(peer, messageId, outbound, context) {
    await callSlack(context, "chat.update", { channel: peer.conversationId, ts: messageId, text: outbound.text });
  },
  async sendMedia(peer, artifact, context) {
    const bytes = await readFile(artifact.path);
    const name = artifact.name || basename(artifact.path);
    const ticket = await context.fetcher(`${SLACK_API}/files.getUploadURLExternal`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Bearer ${botToken(context)}` },
      body: new URLSearchParams({ filename: name, length: String(bytes.length) }).toString(),
    }).then((response) => response.json()) as { ok?: boolean; upload_url?: string; file_id?: string; error?: string };
    if (!ticket.ok || !ticket.upload_url || !ticket.file_id) throw new Error(`slack files.getUploadURLExternal failed${ticket.error ? `: ${ticket.error}` : ""}`);
    const uploaded = await context.fetcher(ticket.upload_url, { method: "POST", body: bytes });
    if (!uploaded.ok) throw new Error(`slack file upload failed: HTTP ${uploaded.status}`);
    await callSlack(context, "files.completeUploadExternal", {
      files: [{ id: ticket.file_id, title: name }],
      channel_id: peer.conversationId,
      ...(peer.replyTo ? { thread_ts: peer.replyTo } : {}),
    });
    return { messageIds: [ticket.file_id] };
  },
  renderApproval(input) {
    if (!input.actions) return numberedApprovalRender(input);
    const { runId, gateId, show } = input.request;
    const shown = typeof show === "string" ? show : JSON.stringify(show, null, 2);
    return {
      text: `${input.text ? `${input.text}\n\n` : ""}Approval required (gate \`${gateId}\`, run \`${runId}\`):\n\`\`\`${shown}\`\`\``,
      buttons: [
        { label: "Approve", value: input.actions.approve, style: "primary" },
        { label: "Reject", value: input.actions.reject, style: "danger" },
      ],
    };
  },
  async deliverReply(peer, reply, context, approvalAction): Promise<ChannelSendResult | undefined> {
    if (!isPairingChallenge(reply) && !reply.approvalRequest && !reply.presentation) return undefined;
    const body = await callSlack(context, "chat.postMessage", surfaceReplyToSlackPost(reply, peer.conversationId, peer.replyTo, { approvalAction }));
    return { messageIds: tsOf(body) };
  },
  async doctor(context, options) {
    const checks: ChannelDoctorCheck[] = [];
    const slack = context.gateway.slack;
    checks.push(slack?.botToken
      ? { id: "bot_token", status: "ok", detail: "configured" }
      : { id: "bot_token", status: "fail", detail: "add slack.botToken (muster channels setup slack)" });
    if ((slack?.mode ?? "socket") === "socket") {
      checks.push(slack?.appToken
        ? { id: "app_token", status: "ok", detail: "socket mode" }
        : { id: "app_token", status: "fail", detail: "socket mode needs slack.appToken" });
    } else {
      checks.push(slack?.signingSecret
        ? { id: "signing_secret", status: "ok", detail: "configured" }
        : { id: "signing_secret", status: "warn", detail: "HTTP events are not signature-verified" });
    }
    if (options.live && slack?.botToken) {
      try {
        const body = await callSlack(context, "auth.test", {});
        checks.push({ id: "auth_test", status: "ok", detail: `team ${String(body.team ?? "unknown")}` });
      } catch (error) {
        checks.push({ id: "auth_test", status: "fail", detail: error instanceof Error ? error.message : String(error) });
      }
    }
    return checks;
  },
};
