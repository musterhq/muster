import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { dataDir } from "@musterhq/core";
import type { FlowToolRegistry, MusterConfig } from "@musterhq/core";
import { SqliteApprovalActionStore } from "./approval-store.js";
import {
  chunkText,
  defaultPairingText,
  senderAllowed,
} from "./channel-sdk.js";
import type { ChannelAdapter, ChannelContext, ChannelInbound, ChannelPeer, ChannelRegistry } from "./channel-sdk.js";
import { defaultChannelRegistry } from "./channels/index.js";
import { createGatewayIngressFingerprint, DurableGatewayIngress } from "./durable-ingress.js";
import type { GatewayIngressOwnership } from "./durable-ingress.js";
import { isPairingChallenge } from "./envelope.js";
import type { PairingChallenge, SurfaceMessage, SurfaceReply } from "./envelope.js";
import { openSqliteGatewayEnterpriseRuntime } from "./enterprise-runtime.js";
import type { GatewayEnterpriseRuntime } from "./enterprise-runtime.js";
import { loadGatewayConfig } from "./gateway-config.js";
import type { GatewayConfig } from "./gateway-config.js";
import {
  createApprovalActionCodec,
  pendingApprovalSurfaceFields,
  renderPresentationText,
  sanitizePresentationForAudience,
} from "./presentation.js";
import type { ApprovalActionCodec, ApprovalActionRenderContext } from "./presentation.js";
import { completeAdapterIngress, handleSurfaceMessage } from "./server.js";
import { deliverSpokenReply, prepareVoiceInbound, withVoiceEcho } from "./voice-notes.js";

/**
 * The shared channel path. Every SDK channel's inbound goes through
 * ingestChannelInbound (allowlist → durable ingress → pairing/governance via
 * handleSurfaceMessage → reply), and every outbound goes through
 * deliverChannelReply / sendToChannel.
 */

export interface ChannelRuntimeOptions {
  readonly gateway?: GatewayConfig;
  readonly cwd?: string;
  readonly fetcher?: typeof fetch;
  readonly log?: (line: string) => void;
  /** Where `*Env` secret references are resolved. Defaults to process.env. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly channels?: ChannelRegistry;
  readonly signal?: AbortSignal;
}

interface ApprovalDeps {
  readonly codec: ApprovalActionCodec;
  readonly ttlSeconds: number;
}

export function channelCursorPath(cwd: string, channelId: string): string {
  return join(dataDir(cwd), "channel-cursors", `${channelId}.json`);
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temp, path);
}

async function loadCursor(cwd: string, channelId: string): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await readFile(channelCursorPath(cwd, channelId), "utf8")) as { cursor?: unknown };
    return typeof parsed.cursor === "string" ? parsed.cursor : undefined;
  } catch {
    return undefined;
  }
}

async function saveCursor(cwd: string, channelId: string, cursor: string): Promise<void> {
  await writeJsonAtomic(channelCursorPath(cwd, channelId), { cursor, updatedAt: new Date().toISOString() });
}

// ---- Numbered approvals (channels without buttons) ---------------------------------

interface NumberedChoice {
  readonly key: string;
  readonly approve: string;
  readonly reject: string;
  readonly expiresAt: number;
}

function numberedChoicesPath(cwd: string): string {
  return join(dataDir(cwd), "channel-approval-choices.json");
}

function choiceKey(surfaceId: string, conversationId: string, actorId: string): string {
  return createHash("sha256").update(JSON.stringify([surfaceId, conversationId, actorId])).digest("hex");
}

async function readChoices(cwd: string): Promise<NumberedChoice[]> {
  try {
    const parsed = JSON.parse(await readFile(numberedChoicesPath(cwd), "utf8")) as { choices?: NumberedChoice[] };
    return (parsed.choices ?? []).filter((choice) => choice.expiresAt > Date.now());
  } catch {
    return [];
  }
}

async function rememberChoice(cwd: string, choice: NumberedChoice): Promise<void> {
  const choices = (await readChoices(cwd)).filter((entry) => entry.key !== choice.key);
  await writeJsonAtomic(numberedChoicesPath(cwd), { choices: [...choices, choice] });
}

async function takeChoice(cwd: string, key: string): Promise<NumberedChoice | undefined> {
  const choices = await readChoices(cwd);
  const found = choices.find((entry) => entry.key === key);
  if (found) await writeJsonAtomic(numberedChoicesPath(cwd), { choices: choices.filter((entry) => entry !== found) });
  return found;
}

function approvalRevision(runId: string, gateId: string, show: unknown): string {
  return createHash("sha256").update(JSON.stringify([runId, gateId, show])).digest("hex");
}

function approvalActionContext(reply: SurfaceReply, surfaceId: string, peer: ChannelPeer, approvals: ApprovalDeps | undefined): ApprovalActionRenderContext | undefined {
  if (!reply.approvalRequest || !approvals || !peer.senderId) return undefined;
  const { runId, gateId, show } = reply.approvalRequest;
  return {
    codec: approvals.codec,
    actorId: peer.senderId,
    surfaceId,
    conversationId: peer.conversationId,
    runId,
    gateId,
    revision: approvalRevision(runId, gateId, show),
    expiresAt: Date.now() + approvals.ttlSeconds * 1000,
  };
}

function approvalDeps(gateway: GatewayConfig, store: SqliteApprovalActionStore): ApprovalDeps {
  return {
    codec: createApprovalActionCodec({
      // Same derivation as the webhook routes and pollTelegram, so tokens verify everywhere.
      secret: createHash("sha256").update(`muster-approval:${gateway.token}`).digest(),
      store,
    }),
    ttlSeconds: Math.min(3600, Math.max(60, gateway.approvals?.ttlSeconds ?? 600)),
  };
}

// ---- Outbound -----------------------------------------------------------------------

function toPeer(peer: string | ChannelPeer): ChannelPeer {
  return typeof peer === "string" ? { conversationId: peer } : peer;
}

/** Deliver a gateway reply (or pairing challenge) through one channel adapter. */
export async function deliverChannelReply(
  adapter: ChannelAdapter,
  peer: ChannelPeer,
  reply: SurfaceReply | PairingChallenge,
  context: ChannelContext,
  approvals?: ApprovalDeps,
): Promise<{ readonly messageIds: readonly string[] }> {
  const surfaceId = peer.surfaceId ?? adapter.surfaceId(context.gateway);
  const approvalAction = isPairingChallenge(reply) ? undefined : approvalActionContext(reply, surfaceId, peer, approvals);
  if (adapter.deliverReply) {
    const rich = await adapter.deliverReply(peer, reply, context, approvalAction);
    if (rich) return rich;
  }
  let text: string;
  let buttons: ReturnType<ChannelAdapter["renderApproval"]>["buttons"];
  if (isPairingChallenge(reply)) {
    text = adapter.pairingText?.(reply.code) ?? defaultPairingText(reply.code);
  } else if (reply.approvalRequest) {
    const actions = approvalAction
      ? approvalAction.codec.issue(approvalAction, adapter.capabilities.buttons ? 64 : undefined)
      : undefined;
    const rendered = adapter.renderApproval({ request: reply.approvalRequest, text: reply.text || undefined, actions });
    text = rendered.text;
    buttons = rendered.buttons;
    if (actions && !adapter.capabilities.buttons && approvalAction) {
      await rememberChoice(context.cwd, {
        key: choiceKey(surfaceId, peer.conversationId, approvalAction.actorId),
        approve: actions.approve,
        reject: actions.reject,
        expiresAt: approvalAction.expiresAt,
      });
    }
  } else if (reply.presentation) {
    text = renderPresentationText(sanitizePresentationForAudience(reply.presentation));
  } else {
    text = reply.text;
  }
  const messageIds: string[] = [];
  const chunks = chunkText(text || " ", adapter.capabilities.maxTextLength);
  for (let index = 0; index < chunks.length; index += 1) {
    const last = index === chunks.length - 1;
    const sent = await adapter.send(peer, { text: chunks[index], buttons: last ? buttons : undefined, continuation: index > 0 }, context);
    messageIds.push(...sent.messageIds);
  }
  if (!isPairingChallenge(reply)) {
    for (const artifact of reply.artifacts ?? []) {
      if (adapter.capabilities.media && adapter.sendMedia) {
        try {
          messageIds.push(...(await adapter.sendMedia(peer, artifact, context)).messageIds);
          continue;
        } catch (error) {
          context.log(`${adapter.id}: attaching ${artifact.name} failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      messageIds.push(...(await adapter.send(peer, { text: `Artifact: ${artifact.name}\n${artifact.path}`, continuation: true }, context)).messageIds);
    }
  }
  return { messageIds };
}

export interface SendToChannelOptions extends ChannelRuntimeOptions {}

/**
 * The outbound API for other subsystems (automations' `channel:<id>`
 * delivery, scheduled reports): send a text or a full reply to one peer.
 * Integration note: automations (PR #170, not on main yet) deliver
 * `channel:<id>` results with `sendToChannel(id, peer, resultText, { cwd })`.
 */
export async function sendToChannel(
  channelId: string,
  peer: string | ChannelPeer,
  message: string | SurfaceReply,
  options: SendToChannelOptions = {},
): Promise<{ readonly channelId: string; readonly messageIds: readonly string[] }> {
  const registry = options.channels ?? defaultChannelRegistry();
  const adapter = registry.get(channelId);
  if (!adapter) throw new Error(`Unknown channel: ${channelId}`);
  const cwd = options.cwd ?? process.cwd();
  const gateway = options.gateway ?? await loadGatewayConfig(cwd);
  if (!adapter.configured(gateway)) throw new Error(`Channel ${channelId} is not configured. Run: muster channels setup ${channelId}`);
  const context: ChannelContext = {
    gateway,
    cwd,
    fetcher: options.fetcher ?? fetch,
    log: options.log ?? (() => undefined),
    env: options.env ?? process.env,
    signal: options.signal,
  };
  const reply: SurfaceReply = typeof message === "string" ? { text: message } : message;
  let store: SqliteApprovalActionStore | undefined;
  try {
    if (reply.approvalRequest) store = new SqliteApprovalActionStore(join(dataDir(cwd), "enterprise-control-plane.db"));
    const result = await deliverChannelReply(adapter, toPeer(peer), reply, context, store ? approvalDeps(gateway, store) : undefined);
    return { channelId, messageIds: result.messageIds };
  } finally {
    store?.close();
  }
}

// ---- Inbound ------------------------------------------------------------------------

export interface ChannelWorkerOptions extends ChannelRuntimeOptions {
  readonly channelId: string;
  readonly config: MusterConfig;
  readonly gateway: GatewayConfig;
  /** Tool registry used when a numbered approval resumes a flow run. */
  readonly registry?: FlowToolRegistry;
  readonly enterprise?: GatewayEnterpriseRuntime;
  readonly ingress?: DurableGatewayIngress;
  /** Stop after this many poll cycles (tests). */
  readonly maxIterations?: number;
}

interface IngestDeps {
  readonly adapter: ChannelAdapter;
  readonly context: ChannelContext;
  readonly config: MusterConfig;
  readonly registry?: FlowToolRegistry;
  readonly enterprise: GatewayEnterpriseRuntime;
  readonly ingress: DurableGatewayIngress;
  readonly approvalStore: SqliteApprovalActionStore;
  readonly approvals: ApprovalDeps;
}

const NUMBERED_REPLY = /^\s*(1|2|approve|reject)\s*[.!]?\s*$/i;

async function applyNumberedChoice(message: SurfaceMessage, deps: IngestDeps): Promise<SurfaceMessage> {
  const match = NUMBERED_REPLY.exec(message.text);
  if (!match) return message;
  const choice = await takeChoice(deps.context.cwd, choiceKey(message.surfaceId, message.conversationId, message.senderId));
  if (!choice) return message;
  const approve = match[1] === "1" || match[1].toLowerCase() === "approve";
  const fields = pendingApprovalSurfaceFields(deps.approvals.codec, approve ? choice.approve : choice.reject, {
    actorId: message.senderId,
    surfaceId: message.surfaceId,
    conversationId: message.conversationId,
  }, message.raw);
  return fields ? { ...message, text: fields.text, raw: fields.raw } : message;
}

/** One inbound item through the shared path. Returns what happened, for logs and tests. */
export async function ingestChannelInbound(item: ChannelInbound, deps: IngestDeps): Promise<"ignored" | "replayed" | "handled"> {
  const { adapter, context } = deps;
  const allowFrom = context.gateway.channels?.[adapter.id]?.allowFrom;
  if (!senderAllowed(allowFrom, item.message.senderId)) {
    context.log(`${adapter.id}: ignored a message from a sender outside allowFrom`);
    return "ignored";
  }
  const identity = {
    scope: `adapter:${adapter.id}`,
    deliveryId: item.deliveryId,
    fingerprint: createGatewayIngressFingerprint([adapter.id, item.deliveryId, item.message.conversationId, item.message.senderId, item.message.text]),
  };
  const claim = await deps.ingress.claim(identity);
  if (claim.status !== "claimed") {
    context.log(`${adapter.id}: delivery ${item.deliveryId} already ${claim.status}; not answering again`);
    return "replayed";
  }
  if (!claim.claimToken) throw new Error("Channel ingress claim did not return its generation token.");
  const ownership: GatewayIngressOwnership = { ...identity, claimToken: claim.claimToken };
  await deps.ingress.transition({ ...ownership, to: "running" });
  let delivering = false;
  try {
    const chosen = await applyNumberedChoice(item.message, deps);
    const peer: ChannelPeer = {
      conversationId: chosen.conversationId,
      replyTo: chosen.replyTo,
      senderId: chosen.senderId,
      surfaceId: chosen.surfaceId,
      raw: item.message.raw,
    };
    // Shared voice path: adapters only expose audio; transcription happens here.
    const voiceStep = await prepareVoiceInbound(chosen, {
      config: deps.config,
      cwd: context.cwd,
      env: process.env,
      log: context.log,
      download: adapter.downloadAttachment ? (attachment) => adapter.downloadAttachment!(attachment, context) : undefined,
    });
    if (voiceStep.kind === "refuse") {
      delivering = true;
      await deliverChannelReply(adapter, peer, { text: voiceStep.text }, context, deps.approvals);
      await completeAdapterIngress(deps.ingress, ownership, "delivered");
      return "handled";
    }
    const message = voiceStep.message;
    const answered = await handleSurfaceMessage(message, {
      config: deps.config,
      cwd: context.cwd,
      gateway: context.gateway,
      enterprise: deps.enterprise,
      approvalStore: deps.approvalStore,
      approvalActions: deps.approvals.codec,
      registry: deps.registry,
      fetcher: context.fetcher,
    });
    const reply = withVoiceEcho(answered, message);
    delivering = true;
    await deliverChannelReply(adapter, peer, reply, context, deps.approvals);
    await completeAdapterIngress(deps.ingress, ownership, "delivered");
    await deliverSpokenReply({
      config: deps.config,
      cwd: context.cwd,
      message,
      reply,
      log: context.log,
      send: async (audio) => {
        if (adapter.sendVoice) return adapter.sendVoice(peer, audio, context);
        if (adapter.capabilities.media && adapter.sendMedia) return adapter.sendMedia(peer, { name: "voice-reply.ogg", mime: audio.mime, path: audio.path }, context);
        throw new Error(`${adapter.id} cannot send audio`);
      },
    });
    return "handled";
  } catch (error) {
    if (delivering) await completeAdapterIngress(deps.ingress, ownership, "unknown").catch(() => undefined);
    else await deps.ingress.fail(ownership).catch(() => undefined);
    throw error;
  }
}

/**
 * Run one pull-based SDK channel (Matrix sync, IMAP) until the signal aborts:
 * poll → accept allowed invites → ingest each item → acknowledge → save cursor.
 * The cursor is saved only after its batch is handled; durable ingress makes a
 * redelivered batch safe.
 */
export async function runChannelWorker(options: ChannelWorkerOptions): Promise<void> {
  const registry = options.channels ?? defaultChannelRegistry();
  const adapter = registry.get(options.channelId);
  if (!adapter) throw new Error(`Unknown channel: ${options.channelId}`);
  if (!adapter.openPoller) throw new Error(`Channel ${adapter.id} receives webhooks; it has no worker.`);
  if (!adapter.configured(options.gateway)) throw new Error(`Channel ${adapter.id} is not configured. Run: muster channels setup ${adapter.id}`);
  const cwd = options.cwd ?? process.cwd();
  const log = options.log ?? ((line: string) => console.log(line));
  const context: ChannelContext = {
    gateway: options.gateway,
    cwd,
    fetcher: options.fetcher ?? fetch,
    log,
    env: options.env ?? process.env,
    signal: options.signal,
  };
  const ownsEnterprise = options.enterprise === undefined;
  const enterprise = options.enterprise ?? openSqliteGatewayEnterpriseRuntime(cwd);
  const ingress = options.ingress ?? new DurableGatewayIngress(enterprise.idempotencyStore, { defaultLeaseMs: 15 * 60_000 });
  const approvalStore = new SqliteApprovalActionStore(join(dataDir(cwd), "enterprise-control-plane.db"));
  const deps: IngestDeps = {
    adapter,
    context,
    config: options.config,
    registry: options.registry,
    enterprise,
    ingress,
    approvalStore,
    approvals: approvalDeps(options.gateway, approvalStore),
  };
  const poller = adapter.openPoller(context);
  let cursor = await loadCursor(cwd, adapter.id);
  let iterations = 0;
  let backoffMs = 1_000;
  log(`${adapter.id}: channel worker started`);
  try {
    while (!options.signal?.aborted && iterations < (options.maxIterations ?? Number.POSITIVE_INFINITY)) {
      iterations += 1;
      try {
        const batch = await poller.poll(cursor);
        for (const invite of batch.invites ?? []) {
          if (!senderAllowed(options.gateway.channels?.[adapter.id]?.allowFrom, invite.inviterId)) {
            log(`${adapter.id}: ignored an invite from a sender outside allowFrom`);
            continue;
          }
          await adapter.acceptInvite?.(invite, context);
          log(`${adapter.id}: joined ${invite.conversationId}`);
        }
        for (const item of batch.items) {
          const outcome = await ingestChannelInbound(item, deps);
          if (outcome !== "ignored") await poller.acknowledge?.(item);
        }
        if (batch.cursor && batch.cursor !== cursor) {
          cursor = batch.cursor;
          await saveCursor(cwd, adapter.id, cursor);
        }
        backoffMs = 1_000;
      } catch (error) {
        if (options.signal?.aborted) break;
        log(`${adapter.id}: ${error instanceof Error ? error.message : String(error)}; retrying in ${Math.round(backoffMs / 1000)}s`);
        await delay(backoffMs, undefined, { signal: options.signal }).catch(() => undefined);
        backoffMs = Math.min(backoffMs * 2, 60_000);
      }
    }
  } finally {
    await poller.close().catch(() => undefined);
    approvalStore.close();
    if (ownsEnterprise) await enterprise.close?.();
    log(`${adapter.id}: channel worker stopped`);
  }
}

// ---- Doctor -------------------------------------------------------------------------

export async function runChannelDoctor(channelId: string, options: ChannelRuntimeOptions & { readonly live?: boolean } = {}) {
  const registry = options.channels ?? defaultChannelRegistry();
  const adapter = registry.get(channelId);
  if (!adapter) throw new Error(`Unknown channel: ${channelId}`);
  const cwd = options.cwd ?? process.cwd();
  const gateway = options.gateway ?? await loadGatewayConfig(cwd);
  const checks = await adapter.doctor({
    gateway,
    cwd,
    fetcher: options.fetcher ?? fetch,
    log: options.log ?? (() => undefined),
    env: options.env ?? process.env,
    signal: options.signal,
  }, { live: options.live === true });
  const status = checks.some((check) => check.status === "fail") ? "fail" : checks.some((check) => check.status === "warn") ? "warn" : "ok";
  return { channelId, status, checks } as const;
}
