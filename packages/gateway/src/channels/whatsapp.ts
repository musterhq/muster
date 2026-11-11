import { isPairingChallenge } from "../envelope.js";
import {
  doctorWhatsApp,
  WHATSAPP_WEB_MEDIA_URL_PREFIX,
  WhatsAppConnectionManager,
  WhatsAppPairingChallengeTracker,
  whatsappSessionDir,
} from "../adapters/whatsapp.js";
import type { BaileysModule, BaileysSocket, WhatsAppWebMessage } from "../adapters/whatsapp.js";
import { numberedApprovalRender } from "../channel-sdk.js";
import type { ChannelAdapter, ChannelDoctorCheck, ChannelInbound, ChannelPoller } from "../channel-sdk.js";
import type { GatewayConfig } from "../gateway-config.js";

/**
 * Personal WhatsApp (linked device) on the channel SDK. Baileys owns the
 * socket; the group policy in adapters/whatsapp.ts (group allowlist, sender
 * allowlist, mention activation) decides which messages reach the shared
 * runner. Group messages admitted by that policy skip per-sender pairing, as
 * before. No buttons: approvals are a numbered choice.
 */

export function whatsAppAccount(gateway: GatewayConfig): string {
  return gateway.whatsapp?.account?.trim() || "default";
}

/** Keeps the last inbound audio messages so the voice path can download them. */
const MEDIA_MEMORY = 64;

export interface WhatsAppChannelOptions {
  /** Inject a Baileys-shaped module (tests use a fake linked-device socket). */
  readonly loadBaileys?: () => Promise<BaileysModule>;
}

export function createWhatsAppChannel(options: WhatsAppChannelOptions = {}): ChannelAdapter {
  const managers = new Map<string, WhatsAppConnectionManager>();
  const media = new Map<string, { readonly message: WhatsAppWebMessage; readonly baileys: BaileysModule }>();
  const pairingChallenges = new WhatsAppPairingChallengeTracker();

  function socketFor(gateway: GatewayConfig): BaileysSocket {
    const socket = managers.get(whatsAppAccount(gateway))?.socket;
    if (!socket) throw new Error("WhatsApp linked-device sending needs the running connection: start it with muster gateway start --with-whatsapp.");
    return socket;
  }

  return {
    id: "whatsapp",
    label: "WhatsApp (linked device)",
    capabilities: { buttons: false, edit: false, media: false, threads: false, maxTextLength: 4_096 },
    admitByPairing: true,
    configured: (gateway) => Boolean(gateway.whatsapp),
    surfaceId: (gateway) => `whatsapp:${whatsAppAccount(gateway)}`,
    // Inbound arrives through the poller, already mapped and policy-checked.
    normalize: () => [],
    async send(peer, outbound, context) {
      const sent = await socketFor(context.gateway).sendMessage(peer.conversationId, { text: outbound.text }) as { key?: { id?: string } } | undefined;
      return { messageIds: sent?.key?.id ? [sent.key.id] : [] };
    },
    async downloadAttachment(attachment) {
      if (!attachment.url?.startsWith(WHATSAPP_WEB_MEDIA_URL_PREFIX)) throw new Error("whatsapp: attachment has no message id");
      const entry = media.get(attachment.url.slice(WHATSAPP_WEB_MEDIA_URL_PREFIX.length));
      if (!entry) throw new Error("whatsapp: the voice note is no longer in memory");
      if (!entry.baileys.downloadMediaMessage) throw new Error("whatsapp: this Baileys build cannot download media");
      return new Uint8Array(await entry.baileys.downloadMediaMessage(entry.message, "buffer", {}));
    },
    renderApproval: numberedApprovalRender,
    pairingText: (code) => `This number is not paired with Muster yet. Ask an operator to run:\nmuster pairing approve ${code}`,
    async deliverReply(peer, reply) {
      // One pairing challenge per sender per process, not one per message.
      if (!pairingChallenges.shouldSend(peer.senderId ?? peer.conversationId, reply) && isPairingChallenge(reply)) return { messageIds: [] };
      return undefined;
    },
    openPoller(context): ChannelPoller {
      const whatsapp = context.gateway.whatsapp;
      if (!whatsapp) throw new Error("WhatsApp is not configured. Run: muster channels setup whatsapp");
      const account = whatsAppAccount(context.gateway);
      const queue: ChannelInbound[] = [];
      let wake: (() => void) | undefined;
      const stop = new AbortController();
      const manager = new WhatsAppConnectionManager({
        config: whatsapp,
        cwd: context.cwd,
        signal: AbortSignal.any([stop.signal, ...(context.signal ? [context.signal] : [])]),
        log: context.log,
        loadBaileys: options.loadBaileys,
        onMessage: async () => ({ text: "" }),
        onInbound: (message, inbound, meta) => {
          if (message.attachments?.length && inbound.key?.id) {
            media.set(inbound.key.id, { message: inbound, baileys: meta.baileys });
            while (media.size > MEDIA_MEMORY) media.delete(media.keys().next().value!);
          }
          queue.push({ deliveryId: `whatsapp:${inbound.key?.id ?? `${message.conversationId}:${Date.now()}`}`, message, preAuthorized: meta.preAuthorized });
          wake?.();
        },
      });
      managers.set(account, manager);
      const running = manager.run().catch((error: unknown) => {
        context.log(`whatsapp: ${error instanceof Error ? error.message : String(error)}`);
      }).finally(() => wake?.());
      let finished = false;
      void running.then(() => { finished = true; });
      return {
        async poll() {
          while (!queue.length && !finished && !context.signal?.aborted && !stop.signal.aborted) {
            await new Promise<void>((resolvePromise) => {
              wake = resolvePromise;
              context.signal?.addEventListener("abort", () => resolvePromise(), { once: true });
            });
            wake = undefined;
          }
          if (!queue.length && finished && !context.signal?.aborted) throw new Error("whatsapp connection ended");
          return { items: queue.splice(0), cursor: undefined };
        },
        async close() {
          stop.abort();
          manager.stop();
          wake?.();
          await running;
          if (managers.get(account) === manager) managers.delete(account);
        },
      };
    },
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
}

export const whatsAppChannel: ChannelAdapter = createWhatsAppChannel();
