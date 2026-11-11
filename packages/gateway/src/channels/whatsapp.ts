import { doctorWhatsApp, whatsappSessionDir } from "../adapters/whatsapp.js";
import { numberedApprovalRender } from "../channel-sdk.js";
import type { ChannelAdapter, ChannelDoctorCheck } from "../channel-sdk.js";
import type { GatewayConfig } from "../gateway-config.js";

/**
 * Personal WhatsApp (linked device) on the channel SDK. Baileys owns the
 * socket; the group policy in adapters/whatsapp.ts decides which messages
 * reach the shared runner. No buttons: approvals are a numbered choice.
 */

export function whatsAppAccount(gateway: GatewayConfig): string {
  return gateway.whatsapp?.account?.trim() || "default";
}

export const whatsAppChannel: ChannelAdapter = {
  id: "whatsapp",
  label: "WhatsApp (linked device)",
  capabilities: { buttons: false, edit: false, media: false, threads: false, maxTextLength: 4_096 },
  admitByPairing: true,
  configured: (gateway) => Boolean(gateway.whatsapp),
  surfaceId: (gateway) => `whatsapp:${whatsAppAccount(gateway)}`,
  normalize: () => [],
  async send() {
    throw new Error("WhatsApp linked-device sending needs the running connection: start it with muster gateway start --with-whatsapp.");
  },
  renderApproval: numberedApprovalRender,
  async doctor(context) {
    const checks: ChannelDoctorCheck[] = [];
    const whatsapp = context.gateway.whatsapp;
    if (!whatsapp) return [{ id: "config", status: "fail", detail: "run: muster channels setup whatsapp" }];
    const doctor = await doctorWhatsApp(whatsapp);
    checks.push({ id: "session", status: doctor.sessionPresent ? "ok" : "fail", detail: `${whatsappSessionDir(whatsapp)}: ${doctor.detail}` });
    checks.push({ id: "groups", status: "ok", detail: `activation=${whatsapp.activation ?? "mention"} groups=${whatsapp.groups?.join(",") || "none"}` });
    return checks;
  },
};
