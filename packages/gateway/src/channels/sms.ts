import { contactNameForNumber, isE164, resolveCallContact } from "@musterhq/core";
import { numberedApprovalRender } from "../channel-sdk.js";
import type { ChannelAdapter, ChannelContext, ChannelDoctorCheck, ChannelInbound, ChannelPeer } from "../channel-sdk.js";
import type { SurfaceMessage } from "../envelope.js";
import type { GatewayConfig } from "../gateway-config.js";
import { twilioCredentials, TwilioRestClient, twilioParam } from "../twilio.js";
import type { TwilioParams } from "../twilio.js";

/**
 * SMS on the channel SDK (docs/spec/clauses/25-calls-sms.md#mus-spec-25-4a).
 * Inbound arrives on POST /v1/calls/twilio/sms (signature-checked by the call
 * manager) and runs through the shared ingest path. Outbound goes only to a
 * contact NAME from calls.contacts; the one exception is a reply to a number
 * that just texted in (the pairing challenge for an unknown sender), which is
 * allowed only with the handle the verified inbound carried.
 */

/** Twilio's limit for one (concatenated) message. */
export const SMS_TEXT_LIMIT = 1_600;

export const SMS_RECIPIENT_REFUSAL = "SMS goes only to contact names from calls.contacts.";

interface SmsReplyHandle { readonly number: string }

/** Handles minted for verified inbound texts; a forged peer cannot produce one. */
const verifiedReplies = new WeakSet<SmsReplyHandle>();

function replyHandle(number: string): SmsReplyHandle {
  const handle = Object.freeze({ number });
  verifiedReplies.add(handle);
  return handle;
}

export function smsSurfaceId(gateway: GatewayConfig): string {
  return `sms:${gateway.calls?.from ?? "unknown"}`;
}

/** The number one outbound text goes to, or a refusal. */
export function smsRecipient(gateway: GatewayConfig, peer: ChannelPeer): string {
  const named = resolveCallContact(gateway.calls, peer.conversationId);
  if (named.ok) return named.number;
  const handle = peer.interaction as SmsReplyHandle | undefined;
  if (isE164(peer.conversationId) && handle && verifiedReplies.has(handle) && handle.number === peer.conversationId) return handle.number;
  throw new Error(SMS_RECIPIENT_REFUSAL);
}

/** A verified Twilio inbound SMS webhook → the shared ingest item. */
export function smsInboundFromTwilio(gateway: GatewayConfig, params: TwilioParams): ChannelInbound | undefined {
  const sid = twilioParam(params, "MessageSid") ?? twilioParam(params, "SmsSid");
  const from = twilioParam(params, "From");
  if (!sid || !from || !isE164(from)) return undefined;
  const mediaCount = Number(twilioParam(params, "NumMedia") ?? "0");
  const media: string[] = [];
  for (let index = 0; index < Math.min(10, Number.isFinite(mediaCount) ? mediaCount : 0); index += 1) {
    media.push(twilioParam(params, `MediaContentType${index}`) ?? "attachment");
  }
  const body = twilioParam(params, "Body") ?? "";
  // MMS images are listed, not fetched.
  const text = [body, ...media.map((mime) => `[MMS attachment: ${mime}]`)].filter(Boolean).join("\n");
  const contact = contactNameForNumber(gateway.calls, from);
  const message: SurfaceMessage = {
    surfaceId: smsSurfaceId(gateway),
    conversationId: contact ?? from,
    senderId: from,
    text,
    raw: { provider: "twilio", messageSid: sid },
  };
  return { deliveryId: `sms:${sid}`, message, interaction: replyHandle(from) };
}

export const smsChannel: ChannelAdapter = {
  id: "sms",
  label: "SMS (Twilio)",
  capabilities: { buttons: false, edit: false, media: false, threads: false, maxTextLength: SMS_TEXT_LIMIT },
  admitByPairing: true,
  configured: (gateway) => gateway.sms?.enabled === true && Boolean(gateway.calls?.from) && (gateway.calls?.provider ?? "twilio") === "twilio",
  surfaceId: smsSurfaceId,
  hasPlatformAuth: (gateway) => Boolean(gateway.calls?.authTokenEnv),
  normalize: () => [],
  async send(peer, outbound, context: ChannelContext) {
    const to = smsRecipient(context.gateway, peer);
    const credentials = twilioCredentials(context.gateway.calls, context.env);
    const from = context.gateway.calls?.from;
    if (!credentials || !from) throw new Error("SMS is not configured: set calls.from, calls.accountSidEnv and calls.authTokenEnv.");
    const sent = await new TwilioRestClient(credentials, context.fetcher).sendMessage({ to, from, body: outbound.text });
    return { messageIds: sent.sid ? [sent.sid] : [] };
  },
  renderApproval: numberedApprovalRender,
  async doctor(context) {
    const checks: ChannelDoctorCheck[] = [];
    const calls = context.gateway.calls;
    checks.push(context.gateway.sms?.enabled ? { id: "enabled", status: "ok", detail: "sms.enabled" } : { id: "enabled", status: "fail", detail: "set sms.enabled to true" });
    checks.push(calls?.from ? { id: "from", status: "ok", detail: calls.from } : { id: "from", status: "fail", detail: "add calls.from" });
    checks.push(twilioCredentials(calls, context.env)
      ? { id: "credentials", status: "ok", detail: `env ${calls?.accountSidEnv} and ${calls?.authTokenEnv}` }
      : { id: "credentials", status: "fail", detail: "set calls.accountSidEnv and calls.authTokenEnv and export both" });
    const contacts = Object.keys(calls?.contacts ?? {});
    checks.push(contacts.length ? { id: "contacts", status: "ok", detail: contacts.join(", ") } : { id: "contacts", status: "warn", detail: "no contacts: outbound texts have nowhere to go" });
    return checks;
  },
};
