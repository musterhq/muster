import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { dataDir } from "@musterhq/core";
import type { SurfaceMessage } from "../envelope.js";
import type { GatewayConfig, GatewayEmailChannelConfig, GatewayMailServerConfig } from "../gateway-config.js";
import { isLocalHost, numberedApprovalRender, requireSecretEnv, resolveSecretEnv } from "../channel-sdk.js";
import type { ChannelAdapter, ChannelContext, ChannelDoctorCheck, ChannelInbound, ChannelPeer, ChannelPoller } from "../channel-sdk.js";
import { buildEmail, parseEmailMessage, replySubject, stripQuotedReply } from "./email-mime.js";
import type { ParsedEmail } from "./email-mime.js";
import { ImapClient } from "./imap-client.js";
import { smtpSend, smtpVerify } from "./smtp-client.js";

/**
 * Email channel: IMAP (IDLE, else polling) in, SMTP out. Threads are keyed by
 * the thread's root Message-ID; replies carry In-Reply-To and References.
 */

export { parseEmailMessage };
export type { ParsedEmail };

interface EmailRaw {
  readonly kind: "email";
  readonly from: string;
  readonly subject: string;
  readonly messageId?: string;
  readonly references: readonly string[];
  readonly uid?: number;
}

interface ThreadRecord {
  readonly to: string;
  readonly subject: string;
  readonly references: readonly string[];
  readonly lastMessageId: string;
}

function emailConfig(gateway: GatewayConfig): GatewayEmailChannelConfig {
  const config = gateway.channels?.email;
  if (!config?.address || !config.imap?.host || !config.smtp?.host) throw new Error("Email channel not configured. Run: muster channels setup email");
  return config;
}

export function emailSurfaceId(gateway: GatewayConfig): string {
  return `email:${gateway.channels?.email?.address?.toLowerCase() ?? "unconfigured"}`;
}

function threadStorePath(cwd: string): string {
  return join(dataDir(cwd), "email-threads.json");
}

async function readThreads(cwd: string): Promise<Record<string, ThreadRecord>> {
  try {
    return JSON.parse(await readFile(threadStorePath(cwd), "utf8")) as Record<string, ThreadRecord>;
  } catch {
    return {};
  }
}

async function writeThread(cwd: string, root: string, record: ThreadRecord): Promise<void> {
  const path = threadStorePath(cwd);
  const threads = await readThreads(cwd);
  threads[root] = record;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(threads, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temp, path);
}

function asEmailRaw(value: unknown): EmailRaw | undefined {
  return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "email" ? value as EmailRaw : undefined;
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function mailServer(server: GatewayMailServerConfig, context: ChannelContext, what: string) {
  return {
    host: server.host,
    port: server.port,
    security: server.security,
    user: server.user,
    password: requireSecretEnv(context.env, server.passwordEnv, `${what} password`),
  };
}

async function resolveRecipient(peer: ChannelPeer, context: ChannelContext): Promise<{ to: string; subject: string; inReplyTo?: string; references: string[]; root?: string }> {
  const raw = asEmailRaw(peer.raw);
  if (raw) {
    const references = dedupe([...raw.references, ...(raw.messageId ? [raw.messageId] : [])]);
    return { to: raw.from, subject: replySubject(raw.subject), inReplyTo: raw.messageId, references, root: peer.conversationId };
  }
  if (/^<[^<>\s]+>$/.test(peer.conversationId)) {
    const thread = (await readThreads(context.cwd))[peer.conversationId];
    if (!thread) throw new Error(`Unknown email thread ${peer.conversationId}; send to an address instead.`);
    return { to: thread.to, subject: replySubject(thread.subject), inReplyTo: thread.lastMessageId, references: [...thread.references], root: peer.conversationId };
  }
  if (/^[^\s<>@]+@[^\s<>@]+$/.test(peer.conversationId)) {
    return { to: peer.conversationId.toLowerCase(), subject: "Message from Muster", references: [] };
  }
  throw new Error(`Email peer must be an address or a thread id, got ${peer.conversationId}`);
}

export const emailChannel: ChannelAdapter = {
  id: "email",
  label: "Email",
  capabilities: { buttons: false, edit: false, media: false, threads: true, maxTextLength: 100_000 },
  configured: (gateway) => Boolean(gateway.channels?.email?.address && gateway.channels.email.imap?.host && gateway.channels.email.smtp?.host),
  surfaceId: emailSurfaceId,
  normalize(payload, context): SurfaceMessage[] {
    const parsed = payload as ParsedEmail;
    if (!parsed || typeof parsed !== "object" || typeof parsed.text !== "string") return [];
    const own = context.gateway?.channels?.email?.address?.toLowerCase();
    if (!parsed.from || parsed.from === own) return [];
    if (parsed.autoSubmitted && parsed.autoSubmitted !== "no") return [];
    if (parsed.precedence && ["bulk", "junk", "list", "auto_reply"].includes(parsed.precedence)) return [];
    if (parsed.listId) return [];
    const body = stripQuotedReply(parsed.text);
    if (!body) return [];
    const isReply = Boolean(parsed.inReplyTo || parsed.references.length);
    const text = !isReply && parsed.subject.trim() && !body.startsWith("/") ? `${parsed.subject.trim()}\n\n${body}` : body;
    const raw: EmailRaw = { kind: "email", from: parsed.from, subject: parsed.subject, messageId: parsed.messageId, references: parsed.references };
    return [{
      surfaceId: context.gateway ? emailSurfaceId(context.gateway) : "email:unconfigured",
      conversationId: parsed.references[0] ?? parsed.inReplyTo ?? parsed.messageId ?? `<${parsed.from}>`,
      senderId: parsed.from,
      text,
      replyTo: parsed.messageId,
      raw,
    }];
  },
  async send(peer, outbound, context) {
    const config = emailConfig(context.gateway);
    const target = await resolveRecipient(peer, context);
    const domain = config.address.split("@")[1] ?? "muster.local";
    const messageId = `<${randomUUID()}@${domain}>`;
    const data = buildEmail({
      from: config.address,
      fromName: config.displayName ?? "Muster",
      to: target.to,
      subject: target.subject,
      messageId,
      inReplyTo: target.inReplyTo,
      references: target.references,
      text: outbound.text,
    });
    await smtpSend(mailServer(config.smtp, context, "SMTP"), { from: config.address, to: [target.to], data });
    await writeThread(context.cwd, target.root ?? messageId, {
      to: target.to,
      subject: target.subject.replace(/^re:\s*/i, ""),
      references: dedupe([...target.references, messageId]),
      lastMessageId: messageId,
    });
    return { messageIds: [messageId] };
  },
  renderApproval: numberedApprovalRender,
  openPoller(context): ChannelPoller {
    const config = emailConfig(context.gateway);
    let client: ImapClient | undefined;
    let uidNext = 0;
    let uidValidity = 0;
    const connect = async (): Promise<ImapClient> => {
      if (client) return client;
      const server = mailServer(config.imap, context, "IMAP");
      const next = await ImapClient.connect({ host: server.host, port: server.port, security: server.security });
      try {
        await next.login(server.user, server.password);
        const selected = await next.select(config.imap.mailbox ?? "INBOX");
        uidNext = selected.uidNext;
        uidValidity = selected.uidValidity;
      } catch (error) {
        next.close();
        throw error;
      }
      client = next;
      return next;
    };
    return {
      async poll(cursor) {
        try {
          const imap = await connect();
          const [validityText, lastText] = (cursor ?? "").split(":");
          if (!cursor || Number(validityText) !== uidValidity) {
            // First start (or the mailbox was rebuilt): skip mail that is already there.
            let last = Math.max(0, uidNext - 1);
            if (!uidNext) last = Math.max(0, ...(await imap.uidSearchFrom(1)));
            return { items: [], cursor: `${uidValidity}:${last}` };
          }
          const last = Number(lastText) || 0;
          const uids = await imap.uidSearchFrom(last + 1);
          if (!uids.length) {
            const announced = await imap.idle(config.idleTimeoutMs ?? 25 * 60_000, context.signal);
            if (!announced && !imap.capabilities.has("IDLE")) {
              await delay(config.pollIntervalMs ?? 60_000, undefined, { signal: context.signal }).catch(() => undefined);
            }
            return { items: [], cursor: cursor };
          }
          const items: ChannelInbound[] = [];
          let newest = last;
          for (const uid of uids) {
            const raw = await imap.uidFetchMessage(uid);
            newest = uid;
            if (!raw) continue;
            const parsed = parseEmailMessage(raw);
            for (const message of emailChannel.normalize(parsed, { gateway: context.gateway })) {
              items.push({
                deliveryId: `email:${parsed.messageId ?? `${uidValidity}:${uid}`}`,
                message: { ...message, raw: { ...(message.raw as EmailRaw), uid } },
              });
            }
          }
          return { items, cursor: `${uidValidity}:${newest}` };
        } catch (error) {
          client?.close();
          client = undefined;
          throw error;
        }
      },
      async acknowledge(item) {
        const uid = asEmailRaw(item.message.raw)?.uid;
        if (client && uid) await client.uidAddFlags(uid, "\\Seen");
      },
      async close() {
        await client?.logout();
        client = undefined;
      },
    };
  },
  async doctor(context, options) {
    const config = context.gateway.channels?.email;
    if (!config?.address || !config.imap?.host || !config.smtp?.host) {
      return [{ id: "config", status: "fail", detail: "not configured; run muster channels setup email" }];
    }
    const checks: ChannelDoctorCheck[] = [{ id: "address", status: /^[^\s@]+@[^\s@]+$/.test(config.address) ? "ok" : "fail", detail: config.address }];
    for (const [name, server] of [["imap", config.imap], ["smtp", config.smtp]] as const) {
      checks.push(server.security === "none" && !isLocalHost(server.host)
        ? { id: `${name}_security`, status: "warn", detail: `${server.host}:${server.port} is plaintext; use tls or starttls` }
        : { id: `${name}_security`, status: "ok", detail: `${server.host}:${server.port} ${server.security}` });
      checks.push(resolveSecretEnv(context.env, server.passwordEnv)
        ? { id: `${name}_password`, status: "ok", detail: `from env ${server.passwordEnv}` }
        : { id: `${name}_password`, status: "fail", detail: `environment variable ${server.passwordEnv} is not set` });
    }
    checks.push(config.allowFrom?.length
      ? { id: "allow_from", status: "ok", detail: `${config.allowFrom.length} rule(s)` }
      : { id: "allow_from", status: "warn", detail: "allowFrom is empty; nobody can reach Muster" });
    if (options.live) {
      if (resolveSecretEnv(context.env, config.imap.passwordEnv)) {
        try {
          const server = mailServer(config.imap, context, "IMAP");
          const imap = await ImapClient.connect({ host: server.host, port: server.port, security: server.security });
          try {
            await imap.login(server.user, server.password);
            const selected = await imap.select(config.imap.mailbox ?? "INBOX");
            checks.push({ id: "imap_login", status: "ok", detail: `${config.imap.mailbox ?? "INBOX"} has ${selected.exists} message(s); IDLE ${imap.capabilities.has("IDLE") ? "available" : "unavailable, polling"}` });
          } finally {
            await imap.logout();
          }
        } catch (error) {
          checks.push({ id: "imap_login", status: "fail", detail: error instanceof Error ? error.message : String(error) });
        }
      }
      if (resolveSecretEnv(context.env, config.smtp.passwordEnv)) {
        try {
          await smtpVerify(mailServer(config.smtp, context, "SMTP"));
          checks.push({ id: "smtp_auth", status: "ok", detail: `${config.smtp.host}:${config.smtp.port} accepted the credentials` });
        } catch (error) {
          checks.push({ id: "smtp_auth", status: "fail", detail: error instanceof Error ? error.message : String(error) });
        }
      }
    }
    return checks;
  },
};
