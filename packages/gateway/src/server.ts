import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, readFile, mkdir, open, realpath, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { activeProfile, closeWarmProviderTransports, createArtifactWorkspace, createEnterpriseActionReceipt, createStreamEventChannel, dataDir, estimateTokens, executeRun, extractMediaTags, getFlowRun, persistArtifact, profileWorkspaceDir, resolveAgentSkillAllowlist, resolveSkillCommand, resumeFlow, runDraftLoop, StreamRun, updateArtifactDelivery } from "@musterhq/core";
import type { ArtifactDeliveryReceipt, ArtifactResult, ArtifactWorkspace } from "@musterhq/core";
import type { DraftSink, FlowToolRegistry, MusterConfig } from "@musterhq/core";
import { dispatchCommand, gatewayAgentCatalog, gatewayCommandCatalog, parseCommand, resolveCustomCommand } from "./commands.js";
import { conversationSessionId, isPairingChallenge, parseSurfaceMessage } from "./envelope.js";
import type { PairingChallenge, SurfaceArtifact, SurfaceMessage, SurfaceReply } from "./envelope.js";
import { clearTrustedFrappePairingIdentity, clearTrustedFrappeTelegramBindings, pairingScopes, requestPairing, resolvePairing, upsertTrustedFrappePairing } from "./pairing.js";
import type { PairedIdentity, PairedSender } from "./pairing.js";
import { frappeChannelSystemContext, frappeChannelTurnContext, frappeNativeSessionPolicyKey, parseTrustedFrappeIngress, trustedFrappeProviderBoundary, trustedFrappeSystemContext, trustedFrappeTurnContext, TRUSTED_FRAPPE_ASYNC_PATH, TRUSTED_FRAPPE_ASYNC_RUNS_PATH, TRUSTED_FRAPPE_CATALOG_PATH } from "./frappe-ingress.js";
import type { TrustedFrappeContext } from "./frappe-ingress.js";
import { FrappeOAuthCoordinator } from "./frappe-oauth.js";
import type { FrappeOAuthAuthorization } from "./frappe-oauth.js";
import {
  FRAPPE_SITE_API_CREDENTIALS_PATH,
  FRAPPE_SITE_AUTHORIZE_PATH,
  FRAPPE_SITE_EXCHANGE_PATH,
  FRAPPE_SITE_VERIFY_PATH,
  FrappeSiteBindingCoordinator,
  FrappeSiteBindingError,
  type FrappeSiteBindingRecord,
} from "./frappe-connect.js";
import { FRAPPE_TELEGRAM_LINK_PATH, FrappeTelegramLinkCoordinator, openSqliteFrappeTelegramLinkCoordinator } from "./frappe-telegram-link.js";
import type { FrappeTelegramAuthority, TelegramChatType } from "./frappe-telegram-link.js";
import { frappeChannelQuickReply, frappeEvidenceQuickReply, frappePermissionContextForTurn, frappeTaskKindForIntent, isFrappeBusinessIntent } from "./frappe-channel.js";
import {
  createFrappeSupportDraft,
  createGuestFrappeSupportTicket,
  isFrappeIssueReportRequest,
  reconcileGuestFrappeSupportTicket,
  resolveFrappeSupportDestination,
  type FrappeSupportDestination,
  type FrappeSupportInvestigationEvidence,
} from "./frappe-support.js";
import { googleChatAudienceIsValid, type GatewayConfig, type GatewayGovernanceAssignment } from "./gateway-config.js";
import {
  classifyGatewayRequest,
  enforceGatewayRateLimits,
  openSqliteGatewayEnterpriseRuntime,
  recordGatewayUsage,
  resolveGatewayGovernanceAssignment,
  type GatewayEnterpriseRuntime,
} from "./enterprise-runtime.js";
import { surfaceReplyToTelegramSend, telegramCallbackQueryId, telegramUpdateToSurfaceMessage } from "./adapters/telegram.js";
import type { TelegramSendMessagePayload } from "./adapters/telegram.js";
import { slackDeliveryId, slackEventToSurfaceMessage, surfaceReplyToSlackPost } from "./adapters/slack.js";
import { runWhatsAppConnection } from "./adapters/whatsapp.js";
import { whatsAppVerifyChallenge } from "./adapters/whatsapp-cloud.js";
import type { GchatRequestVerifier } from "./adapters/gchat.js";
import { createGoogleChatRequestVerifier } from "./google-chat-verifier.js";
import { createOutboundQueue, createSlackDraftSink, createTelegramDraftSink } from "./streaming.js";
import { ChannelDeliveryRejectedError, ChannelVerificationError } from "./channel-sdk.js";
import type { ChannelAdapter, ChannelContext } from "./channel-sdk.js";
import { channelWebhookAdapter, deliverPreparedChannelReplies, serveChannelWebhook, verifyChannelWebhook, webhookPeer } from "./channel-runner.js";
import type { ApprovalDeps } from "./channel-runner.js";
import { parseSlackBody, slackChannel } from "./channels/slack.js";
import { telegramChannel } from "./channels/telegram.js";
import { deliverSpokenReply, prepareVoiceInbound, voiceEchoLine, withVoiceEcho } from "./voice-notes.js";
import type { OutboundQueue } from "./streaming.js";
import {
  createGatewayIngressFingerprint,
  createGatewaySafeResultRef,
  DurableGatewayIngress,
  type GatewayIngressIdentity,
  type GatewayIngressOwnership,
} from "./durable-ingress.js";
import { createApprovalActionCodec, pendingApprovalFromRaw, renderPresentationText, verifiedApprovalFromRaw, type ApprovalActionBinding, type ApprovalActionCodec, type ApprovalActionRenderContext, type ApprovalDecision, type SurfacePresentation } from "./presentation.js";
import { SqliteApprovalActionStore } from "./approval-store.js";
import {
  DurableGatewayIngressSpool,
  isGatewayAsyncAdapterId,
  spoolOwnerIsDeadOnThisHost,
  type GatewayAsyncAdapterId,
  type GatewayIngressSpoolEntry,
  type GatewayPreparedDelivery,
} from "./ingress-spool.js";
import {
  SqliteAsyncMessageRunStore,
  type AsyncMessageRunStore,
  type StoredAsyncMessageRun,
} from "./async-message-store.js";
import { DurableConversationLease } from "./conversation-lease.js";
import type { PendingFrappeInteraction } from "./frappe-interaction-store.js";
import {
  FRAPPE_RUN_EVENTS_PATH,
  FrappeRunEventError,
  SqliteFrappeRunEventStore,
  frappeRunCsrfProofMatches,
  validateFrappeRunEventScope,
  type AcceptedFrappeRunCommand,
  type FrappeRunCommandRequest,
  type FrappeRunEvent,
  type FrappeRunEventPermissionFilter,
  type FrappeRunEventScope,
  type FrappeRunEventStore,
} from "./frappe-run-events.js";
import {
  createGovernedFrappeMissionExecutor,
  DurableFrappeMissionBridge,
  TRUSTED_FRAPPE_MISSIONS_PATH,
  type FrappeMissionBridge,
  type FrappeMissionNodeExecutor,
  type TrustedFrappeMissionRequest,
} from "./frappe-mission-bridge.js";
import {
  createEffectfulFrappeMissionExecutor,
  createVerifiedBindingFrappeEffectTransport,
  SqliteGovernedFrappeEffectStore,
  type FrappeEffectPolicy,
  type GovernedFrappeEffectStore,
  type GovernedFrappeEffectTransport,
} from "./frappe-effect-executor.js";
import {
  createVerifiedBindingFrappeBrowserMissionExecutor,
  type FrappeBrowserAutomationPort,
} from "./frappe-browser-work-session.js";
import {
  createPlaywrightFrappeBrowserAutomationPort,
  DirectoryFrappeBrowserScreenshotEvidenceStore,
} from "./frappe-playwright-browser.js";
import {
  createFrappeWorkflowProposalResult,
  createGovernedFrappeWorkflowPlanner,
  FrappeWorkflowPlanningError,
  MAX_FRAPPE_PLANNING_REQUEST_BYTES,
  TRUSTED_FRAPPE_WORKFLOW_PROPOSALS_PATH,
  type FrappeWorkflowPlanner,
} from "./frappe-workflow-planner.js";
import { garbageCollectFrappeAskArtifacts, runIsolatedFrappeAskArtifact, type FrappeAskArtifactExecutor } from "./frappe-ask-artifact.js";
import {
  createFrappeReadPlan,
  createGovernedFrappeReadPlanner,
  FrappeReadPlanningError,
  MAX_FRAPPE_READ_PLAN_REQUEST_BYTES,
  TRUSTED_FRAPPE_READ_PLANS_PATH,
  type FrappeReadPlanner,
} from "./frappe-read-planner.js";
import {
  createFrappeAskIntent,
  createGovernedFrappeAskIntentRouter,
  FrappeAskIntentError,
  MAX_FRAPPE_ASK_INTENT_REQUEST_BYTES,
  TRUSTED_FRAPPE_ASK_INTENTS_PATH,
  type FrappeAskIntentRouter,
} from "./frappe-ask-intent.js";

/** HTTP gateway plus channel-specific polling/socket workers. */

export interface GatewayServerOptions {
  readonly config: MusterConfig;
  readonly gateway: GatewayConfig;
  readonly cwd?: string;
  /** Tool registry used when resuming gated flow runs. Defaults to `echo`. */
  readonly registry?: FlowToolRegistry;
  /** Outbound HTTP for adapter sends; injectable for tests. */
  readonly fetcher?: typeof fetch;
  readonly log?: (line: string) => void;
  /** Host-provided Google OIDC/JWT verifier. Required when gchat.verification.mode=bearer. */
  readonly gchatVerifier?: GchatRequestVerifier;
  /** Injectable distributed enterprise stores. Defaults to a durable local SQLite runtime. */
  readonly enterprise?: GatewayEnterpriseRuntime;
  /** Durable pre-execution ingress claims. Derived from enterprise.idempotencyStore by default. */
  readonly ingress?: DurableGatewayIngress;
  /** Local write-ahead payload spool for adapters acknowledged before provider work. */
  readonly ingressSpool?: DurableGatewayIngressSpool;
  readonly approvalActions?: ApprovalActionCodec;
  readonly approvalStore?: SqliteApprovalActionStore;
  /** Injectable shared async-run store. Defaults to durable local SQLite. */
  readonly messageRunStore?: AsyncMessageRunStore;
  /** Internal owner token for warm native provider processes. */
  readonly nativeTransportOwner?: string;
  /** Per-channel Frappe OAuth state and encrypted grants. Derived from gateway config by default. */
  readonly frappeOAuth?: FrappeOAuthCoordinator;
  /** Reciprocal installation-time site trust coordinator. */
  readonly frappeSiteBindings?: FrappeSiteBindingCoordinator;
  /** Frappe-issued, one-time Telegram identity links. Shared with poll workers when enabled. */
  readonly frappeTelegramLinks?: FrappeTelegramLinkCoordinator;
  /** Durable Frappe mission event projection. Defaults to a gateway-owned SQLite store. */
  readonly frappeRunEventStore?: FrappeRunEventStore;
  /** Optional live Frappe permission recheck applied to every replayed event. */
  readonly frappeRunEventCanRead?: FrappeRunEventPermissionFilter;
  /** Dispatches accepted pause/cancel/steer commands into the authoritative graph runtime. */
  readonly onFrappeRunCommand?: (command: AcceptedFrappeRunCommand) => void | Promise<void>;
  /** Server-held HMAC secret for binding Frappe CSRF tokens. Defaults to the gateway bearer secret. */
  readonly frappeRunCsrfSecret?: string;
  /** Portable graph execution bridge for first-class trusted Frappe missions. */
  readonly frappeMissionBridge?: FrappeMissionBridge;
  /** Capability-governed node executor used when the server owns the mission bridge. */
  readonly frappeMissionExecutor?: FrappeMissionNodeExecutor;
  /** Fixed-operation Frappe transport. Its presence enables typed effect nodes; absence remains read-only. */
  readonly frappeEffectTransport?: GovernedFrappeEffectTransport;
  readonly frappeEffectStore?: GovernedFrappeEffectStore;
  readonly frappeEffectPolicy?: FrappeEffectPolicy;
  /** Trusted browser transport override. Browser work remains disabled unless injected or enabled in gateway config. */
  readonly frappeBrowserAutomation?: FrappeBrowserAutomationPort;
  /** Produces inert workflow JSON; output is always strictly validated before returning. */
  readonly frappeWorkflowPlanner?: FrappeWorkflowPlanner;
  /** Produces a bounded data-only read IR; Frappe remains the independent RBAC executor. */
  readonly frappeReadPlanner?: FrappeReadPlanner;
  /** Classifies requested outcomes only. Its output carries no authority or executable data. */
  readonly frappeAskIntentRouter?: FrappeAskIntentRouter;
  /** Isolated Ask artifact executor; injectable only by the gateway host for verification. */
  readonly frappeAskArtifactExecutor?: FrappeAskArtifactExecutor;
}

export interface RunningGateway {
  readonly port: number;
  readonly server: Server;
  /** Wait until accepted background webhook work has finished. */
  waitForIdle(): Promise<void>;
  close(): Promise<void>;
}

/** Error that carries an HTTP status so adapter handlers can reject with e.g. 401. */
export class GatewayHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "GatewayHttpError";
  }
}

function defaultRegistry(): FlowToolRegistry {
  return { echo: async (args) => args };
}

const FRAPPE_SAFE_WRITE_TOOL = "frappe-federated-bridge__frappe_safe_write";

interface FrappeWriteProposal {
  readonly proposalId: string;
  readonly mutationHash: string;
  readonly site: string;
  readonly principal: string;
  readonly operation: string;
  readonly doctype: string;
  readonly fields: readonly string[];
  readonly permissionEpoch: string;
  readonly schemaRevision: string;
  readonly dataRevision: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly nonce: string;
  readonly humanSummary: string;
  readonly bindingRequirements: readonly string[];
}

function canonicalJson(value: unknown): string {
  const canonical = (input: unknown): unknown => Array.isArray(input)
    ? input.map(canonical)
    : input && typeof input === "object"
      ? Object.fromEntries(Object.entries(input as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, item]) => [key, canonical(item)]))
      : input;
  return JSON.stringify(canonical(value));
}

function signFrappeWriteProposal(proposal: FrappeWriteProposal, approvedBy: string, signingKey: string): Record<string, unknown> {
  const approvedAt = new Date().toISOString();
  const unsigned = { proposal, approvedBy: approvedBy.trim().toLowerCase(), approvedAt };
  return {
    ...unsigned,
    signature: createHmac("sha256", signingKey).update(canonicalJson(unsigned)).digest("hex"),
  };
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function frappeDeskLink(site: string, doctype: string, name: string): string {
  const route = doctype.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `${site.replace(/\/$/, "")}/app/${route}/${encodeURIComponent(name)}`;
}

async function acceptPendingFrappeCreation(input: {
  readonly pending?: PendingFrappeInteraction;
  readonly authorization?: FrappeOAuthAuthorization;
  readonly guestSupportDestination?: FrappeSupportDestination;
  readonly registry?: FlowToolRegistry;
  readonly signingKey?: string;
  readonly fetcher?: typeof fetch;
  readonly clear: () => void;
  readonly update: (pending: PendingFrappeInteraction) => void;
  readonly claim: (pending: PendingFrappeInteraction, attemptId: string, nowMs: number) => PendingFrappeInteraction | undefined;
}): Promise<SurfaceReply> {
  if (!input.pending) return { text: "There is no request waiting for approval." };
  if (matchesGuestSupportDestination(input.pending, input.guestSupportDestination)) {
    return acceptPendingGuestSupportCreation({
      pending: input.pending,
      destination: input.guestSupportDestination!,
      fetcher: input.fetcher,
      clear: input.clear,
      update: input.update,
      claim: input.claim,
    });
  }
  if (!input.authorization) return { text: "Your Frappe authorization is unavailable. Reconnect with /pair, then review the request again." };
  if (input.authorization.site !== input.pending.site
      || input.authorization.identity.user.trim().toLowerCase() !== input.pending.principal.trim().toLowerCase()
      || (input.pending.connectionId && input.authorization.connectionId !== input.pending.connectionId)) {
    return { text: "The active Frappe authorization does not match the reviewed request. Nothing was sent; reconnect the exact destination and review it again." };
  }
  if (input.pending.phase === "executing" || input.pending.phase === "uncertain") {
    const reconciled = await reconcilePendingFrappeCreation(input.pending, input.authorization, input.fetcher);
    if (reconciled) {
      input.clear();
      return createdFrappeRecordReply(input.pending, reconciled);
    }
    return { text: "This request was already admitted for execution, but the destination has not returned a unique matching record yet. I will not send it again because that could create a duplicate." };
  }
  if (input.pending.operation !== "create") return { text: "This approval action currently supports new records only. Nothing was changed." };
  if (input.pending.phase !== "review" || input.pending.requiredFields.length) {
    return { text: "This request still needs information before it can be created." };
  }
  if (!input.signingKey?.trim()) return { text: "Creation approval is not configured for this deployment. Nothing was changed." };
  const safeWrite = input.registry?.[FRAPPE_SAFE_WRITE_TOOL];
  if (!safeWrite) return { text: "The governed Frappe write tool is unavailable. Nothing was changed." };
  const apiToken = input.authorization.header.replace(/^Bearer\s+/i, "").trim();
  const args = {
    operation: "create",
    doctype: input.pending.doctype,
    doc: input.pending.values,
    siteUrl: input.authorization.site,
    apiToken,
  };
  const dryRun = objectRecord(await safeWrite(args));
  const proposal = objectRecord(dryRun?.approvalProposal) as FrappeWriteProposal | undefined;
  if (dryRun?.status === "denied") return { text: "Frappe did not allow this request under your current permissions. Nothing was changed." };
  if (dryRun?.error || dryRun?.status !== "approval_required" || !proposal) {
    return { text: typeof dryRun?.error === "string" ? dryRun.error : "The request could not be verified for creation. Nothing was changed." };
  }
  if (proposal.site !== input.pending.site
      || proposal.principal.trim().toLowerCase() !== input.pending.principal.trim().toLowerCase()
      || proposal.operation !== "create"
      || proposal.doctype !== input.pending.doctype) {
    return { text: "The governed write proposal did not match the request you reviewed. Nothing was sent." };
  }
  const approvalReceipt = signFrappeWriteProposal(proposal, input.pending.principal, input.signingKey.trim());
  const admittedAt = Date.now();
  const claimed = input.claim(input.pending, proposal.proposalId, admittedAt);
  if (!claimed) return { text: "This approval is already being processed. I will not start a second write." };
  let executed: Record<string, unknown> | undefined;
  try {
    executed = objectRecord(await safeWrite({
      ...args,
      permissionEpoch: proposal.permissionEpoch,
      schemaRevision: proposal.schemaRevision,
      dataRevision: proposal.dataRevision,
      approvalReceipt,
      approvalNote: "Approved from the governed channel review.",
    }));
  } catch {
    input.update({
      ...claimed,
      phase: "uncertain",
      attemptId: proposal.proposalId,
      updatedAtMs: Date.now(),
      expiresAtMs: Math.max(claimed.expiresAtMs, Date.now() + 30 * 24 * 60 * 60_000),
    });
    return { text: "The destination did not confirm the final result. I will not send the request again because that could create a duplicate; the existing attempt must be reconciled first." };
  }
  const verification = objectRecord(executed?.verification);
  if (executed?.status !== "executed" || verification?.verified !== true) {
    input.update({
      ...claimed,
      phase: "uncertain",
      attemptId: proposal.proposalId,
      updatedAtMs: Date.now(),
      expiresAtMs: Math.max(claimed.expiresAtMs, Date.now() + 30 * 24 * 60 * 60_000),
    });
    return { text: typeof executed?.error === "string" ? executed.error : "Frappe did not verify the saved record, so I cannot report this request as created." };
  }
  const writeVerified = objectRecord(verification.fetched);
  const result = objectRecord(executed.result);
  const created = objectRecord(result?.created);
  const name = typeof writeVerified?.name === "string" ? writeVerified.name : typeof created?.name === "string" ? created.name : undefined;
  const supportHandoff = isSupportHandoff(input.pending);
  const fetched = name && input.fetcher
    ? await readFrappeRecordByName(input.pending, input.authorization, name, input.fetcher)
    : supportHandoff ? undefined : writeVerified;
  const fetchedDoctype = typeof fetched?.doctype === "string" ? fetched.doctype : undefined;
  if (!name || (fetchedDoctype && fetchedDoctype !== input.pending.doctype) || !approvedValuesMatch(input.pending.values, fetched)) {
    input.update({
      ...claimed,
      phase: "uncertain",
      attemptId: proposal.proposalId,
      updatedAtMs: Date.now(),
      expiresAtMs: Math.max(claimed.expiresAtMs, Date.now() + 30 * 24 * 60 * 60_000),
    });
    return { text: "Frappe returned a result that does not match the approved request. I will not retry or report success until the destination is reconciled." };
  }
  input.clear();
  return createdFrappeRecordReply(input.pending, name);
}

async function acceptPendingGuestSupportCreation(input: {
  readonly pending: PendingFrappeInteraction;
  readonly destination: FrappeSupportDestination;
  readonly fetcher?: typeof fetch;
  readonly clear: () => void;
  readonly update: (pending: PendingFrappeInteraction) => void;
  readonly claim: (pending: PendingFrappeInteraction, attemptId: string, nowMs: number) => PendingFrappeInteraction | undefined;
}): Promise<SurfaceReply> {
  if (input.pending.operation !== "create" || input.pending.requiredFields.length) {
    return { text: "This support request is not ready for approval. Nothing was sent." };
  }
  if (input.pending.phase === "executing" || input.pending.phase === "uncertain") {
    const reconciled = await reconcileGuestFrappeSupportTicket({ destination: input.destination, values: input.pending.values, fetcher: input.fetcher });
    if (reconciled.state === "verified") {
      input.clear();
      return createdFrappeRecordReply(input.pending, reconciled.name);
    }
    return { text: `${reconciled.reason} I will not send the ticket again because that could create a duplicate.` };
  }
  if (input.pending.phase !== "review") return { text: "This support request is not ready for approval. Nothing was sent." };
  const reference = supportRequestReference(input.pending);
  if (!reference) return { text: "The reviewed support request has no idempotency reference. Nothing was sent." };
  const claimed = input.claim(input.pending, reference, Date.now());
  if (!claimed) return { text: "This approval is already being processed. I will not start a second ticket submission." };
  const result = await createGuestFrappeSupportTicket({ destination: input.destination, values: input.pending.values, fetcher: input.fetcher });
  if (result.state === "verified") {
    input.clear();
    return createdFrappeRecordReply(input.pending, result.name);
  }
  if (result.state === "rejected") {
    input.clear();
    return { text: `${result.reason} No ticket was reported as created.` };
  }
  input.update({
    ...claimed,
    phase: "uncertain",
    attemptId: reference,
    updatedAtMs: Date.now(),
    expiresAtMs: Math.max(claimed.expiresAtMs, Date.now() + 30 * 24 * 60 * 60_000),
  });
  return { text: `${result.reason} I will not send the ticket again because that could create a duplicate; use /accept to reconcile this attempt.` };
}

function createdFrappeRecordReply(pending: PendingFrappeInteraction, name: string): SurfaceReply {
  const link = frappeDeskLink(pending.site, pending.doctype, name);
  const supportTicket = isSupportHandoff(pending);
  const presentation: SurfacePresentation = {
    kind: "status",
    title: supportTicket ? "Sent to support" : "Created",
    summary: supportTicket
      ? "The support destination created the ticket, reread it, and confirmed the approved evidence was saved."
      : `Your ${pending.doctype.toLowerCase()} was created successfully.`,
    tables: [{ id: "created-record", columns: [supportTicket ? "Ticket" : "Reference", "Open"], rows: [[name, link]] }],
  };
  return { text: renderPresentationText(presentation), presentation };
}

function isSupportHandoff(pending: PendingFrappeInteraction | undefined): boolean {
  if (!pending || (pending.doctype !== "HD Ticket" && pending.doctype !== "Issue")) return false;
  return typeof pending.values.description === "string" && /\bMUSTER-[0-9a-f-]{36}\b/i.test(pending.values.description);
}

function supportRequestReference(pending: PendingFrappeInteraction): string | undefined {
  const description = typeof pending.values.description === "string" ? pending.values.description : "";
  return description.match(/\bMUSTER-[0-9a-f-]{36}\b/i)?.[0];
}

function matchesGuestSupportDestination(
  pending: PendingFrappeInteraction,
  destination: FrappeSupportDestination | undefined,
): boolean {
  return Boolean(destination?.authMode === "guest"
    && isSupportHandoff(pending)
    && pending.site === destination.site
    && pending.doctype === destination.doctype
    && !pending.connectionId);
}

function supportReviewReply(values: Readonly<Record<string, unknown>>): SurfaceReply {
  const rows = Object.entries(values)
    .filter(([field, value]) => ["subject", "customer", "priority", "description"].includes(field) && value !== undefined && value !== null && String(value).trim())
    .map(([field, value]) => [field === "description" ? "Evidence preview" : field[0]!.toUpperCase() + field.slice(1), String(value)]);
  const presentation: SurfacePresentation = {
    kind: "form",
    title: "Review the support ticket",
    summary: "Review the ticket summary and evidence preview below. Approval is bound to this complete sanitized payload; nothing has been sent yet.",
    ...(rows.length ? { tables: [{ id: "request-preview", columns: ["Field", "Value"], rows }] } : {}),
    actions: [
      { id: "accept", label: "Approve & send to support", command: "/accept", style: "primary", kind: "confirm" },
      { id: "cancel", label: "Cancel ticket", command: "/cancel" },
    ],
  };
  return { text: renderPresentationText(presentation), presentation };
}

async function reconcilePendingFrappeCreation(
  pending: PendingFrappeInteraction,
  authorization: FrappeOAuthAuthorization | undefined,
  fetcher: typeof fetch | undefined,
): Promise<string | undefined> {
  if (!authorization || !fetcher || authorization.site !== pending.site) return undefined;
  const description = typeof pending.values.description === "string" ? pending.values.description : "";
  const reference = description.match(/\bMUSTER-[0-9a-f-]{36}\b/i)?.[0];
  if (!reference) return undefined;
  const url = new URL(`/api/resource/${encodeURIComponent(pending.doctype)}`, authorization.site);
  url.searchParams.set("fields", JSON.stringify(["name", "doctype", ...Object.keys(pending.values)]));
  url.searchParams.set("filters", JSON.stringify([[pending.doctype, "description", "like", `%${reference}%`]]));
  url.searchParams.set("limit_page_length", "2");
  let response: Response;
  try {
    response = await fetcher(url, {
      method: "GET",
      headers: { authorization: authorization.header, accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    return undefined;
  }
  if (!response.ok) return undefined;
  const payload = objectRecord(await response.json().catch(() => undefined));
  const rows = Array.isArray(payload?.data) ? payload.data.map(objectRecord).filter((row): row is Record<string, unknown> => Boolean(row)) : [];
  if (rows.length !== 1 || !approvedValuesMatch(pending.values, rows[0])) return undefined;
  return typeof rows[0].name === "string" && rows[0].name.trim() ? rows[0].name : undefined;
}

async function readFrappeRecordByName(
  pending: PendingFrappeInteraction,
  authorization: FrappeOAuthAuthorization,
  name: string,
  fetcher: typeof fetch,
): Promise<Record<string, unknown> | undefined> {
  const url = new URL(`/api/resource/${encodeURIComponent(pending.doctype)}/${encodeURIComponent(name)}`, authorization.site);
  let response: Response;
  try {
    response = await fetcher(url, {
      method: "GET",
      headers: { authorization: authorization.header, accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    return undefined;
  }
  if (!response.ok) return undefined;
  const payload = objectRecord(await response.json().catch(() => undefined));
  return objectRecord(payload?.data);
}

function approvedValuesMatch(expected: Readonly<Record<string, unknown>>, fetched: Readonly<Record<string, unknown>> | undefined): boolean {
  if (!fetched) return false;
  return Object.entries(expected).every(([key, value]) => approvedValueMatches(value, fetched[key]));
}

function approvedValueMatches(expected: unknown, actual: unknown): boolean {
  if (Array.isArray(expected)) {
    return Array.isArray(actual)
      && expected.length === actual.length
      && expected.every((value, index) => approvedValueMatches(value, actual[index]));
  }
  const expectedRecord = objectRecord(expected);
  if (expectedRecord) {
    const actualRecord = objectRecord(actual);
    return Boolean(actualRecord)
      && Object.entries(expectedRecord).every(([key, value]) => approvedValueMatches(value, actualRecord?.[key]));
  }
  return canonicalJson(actual) === canonicalJson(expected);
}

function supportInvestigationFromTrustedContext(context: TrustedFrappeContext | undefined): FrappeSupportInvestigationEvidence | undefined {
  if (!context) return undefined;
  const supplied = context.supportEvidence;
  const selectedRecord = context.doctype && context.docname
    ? { label: context.pageName?.trim() || context.docname, doctype: context.doctype, name: context.docname }
    : undefined;
  const affectedRecords = [...(supplied?.affectedRecords ?? [])];
  if (selectedRecord && !affectedRecords.some((record) => record.doctype === selectedRecord.doctype && record.name === selectedRecord.name)) {
    affectedRecords.unshift(selectedRecord);
  }
  const evidenceIds = [...(supplied?.evidenceIds ?? [])];
  if (context.ask?.requestId) evidenceIds.push(`frappe-ask:${context.ask.requestId}`);
  return {
    ...(supplied ?? {}),
    ...(supplied?.observed?.trim() ? {} : context.summary?.trim() ? { observed: context.summary.trim() } : {}),
    ...(affectedRecords.length ? { affectedRecords } : {}),
    reproduction: supplied?.reproduction?.length ? supplied.reproduction : [
      context.route?.trim()
        ? `Open the affected page at ${context.route.trim()} under the reporter's own Frappe permissions.`
        : "Open the affected record under the reporter's own Frappe permissions.",
      "Repeat the reported workflow and compare the observed result with the approved business state.",
    ],
    validation: [
      ...(supplied?.validation ?? []),
      "Frappe supplied this context after applying the reporter's live identity and permissions.",
    ],
    ...(evidenceIds.length ? { evidenceIds: [...new Set(evidenceIds)] } : {}),
  };
}

/** Per-profile workspace dirs already ensured this process — skip the mkdir syscall on the hot path. */
const ensuredWorkspaces = new Set<string>();
async function ensureWorkspaceOnce(dir: string): Promise<void> {
  if (ensuredWorkspaces.has(dir)) return;
  await mkdir(dir, { recursive: true });
  ensuredWorkspaces.add(dir);
}

/** Emit an "adapter is unauthenticated" warning at most once per adapter per process. */
const unauthenticatedWarned = new Set<string>();
function warnUnauthenticatedOnce(adapter: string, log: (line: string) => void): void {
  if (unauthenticatedWarned.has(adapter)) return;
  unauthenticatedWarned.add(adapter);
  log(`WARNING: ${adapter} webhook is UNAUTHENTICATED — no secret configured. Anyone who can reach this endpoint can forge ${adapter} events. Configure it in .muster/gateway.json.`);
}

/** Test-only: reset the once-per-process warning latch so each test observes the first warning. */
export function resetAdapterAuthWarnings(): void {
  unauthenticatedWarned.clear();
}

/**
 * The single governed entry point every surface goes through:
 * pairing check -> scoped run (pairing + user + conversation-session lanes)
 * -> per-surface token accounting. Exported so adapters and tests can call
 * it without HTTP.
 */
const idempotencyCache = new Map<string, { at: number; reply: SurfaceReply | PairingChallenge }>();
const IDEMPOTENCY_TTL_MS = 10 * 60_000;
const deliveryCache = new Map<string, { at: number; result: unknown }>();
const activeConversationRuns = new Map<string, Promise<unknown>>();
const TELEGRAM_POLL_OFFSET_FILE = "telegram-poll-offset.json";

interface AsyncMessageRunSnapshot {
  readonly runId: string;
  readonly status: StoredAsyncMessageRun["status"];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly reply?: SurfaceReply | PairingChallenge;
  /** Cumulative assistant text emitted by the provider before completion. */
  readonly partialText?: string;
  /** Cumulative provider-visible reasoning summary; never raw hidden reasoning. */
  readonly reasoningText?: string;
  readonly error?: string;
}

interface AsyncMessageArtifactDownload {
  readonly name: string;
  readonly mime: string;
  readonly bytes: Buffer;
}

const ASYNC_MESSAGE_LONG_POLL_MAX_MS = 25_000;
const ASYNC_MESSAGE_ARTIFACT_MAX_BYTES = 128 * 1024 * 1024;
const ASYNC_MESSAGE_PREVIEW_MAX_CHARS = 64 * 1024;
const ASYNC_MESSAGE_LEASE_MS = 120_000;
const ASYNC_MESSAGE_POLL_INTERVAL_MS = 50;
const ASYNC_MESSAGE_PREVIEW_FLUSH_MS = 50;
const NATIVE_SESSION_MAX_TURNS = boundedPositiveInteger(process.env.MUSTER_NATIVE_SESSION_MAX_TURNS, 12, 1, 100);
const NATIVE_SESSION_MAX_AGE_MS = boundedPositiveInteger(
  process.env.MUSTER_NATIVE_SESSION_MAX_AGE_MS,
  2 * 60 * 60_000,
  60_000,
  24 * 60 * 60_000,
);

function boundedPositiveInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) return fallback;
  return parsed;
}

interface AsyncMessageRunStream {
  readonly onDelta: (text: string) => void;
  readonly onReasoningDelta: (text: string) => void;
}

const CONVERSATION_RUN_QUEUES = new Map<string, Promise<void>>();
const DURABLE_CONVERSATION_LEASES = new WeakMap<GatewayEnterpriseRuntime, DurableConversationLease>();

async function runConversationExclusive<T>(
  conversationKey: string,
  task: () => Promise<T>,
  enterprise?: GatewayEnterpriseRuntime,
): Promise<T> {
  const previous = CONVERSATION_RUN_QUEUES.get(conversationKey)?.catch(() => undefined) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  CONVERSATION_RUN_QUEUES.set(conversationKey, current);
  await previous;
  try {
    if (!enterprise) return await task();
    let lease = DURABLE_CONVERSATION_LEASES.get(enterprise);
    if (!lease) {
      lease = new DurableConversationLease(enterprise.idempotencyStore);
      DURABLE_CONVERSATION_LEASES.set(enterprise, lease);
    }
    return await lease.run(conversationKey, task);
  } finally {
    release();
    if (CONVERSATION_RUN_QUEUES.get(conversationKey) === current) CONVERSATION_RUN_QUEUES.delete(conversationKey);
  }
}

class AsyncMessageRunRegistry {
  readonly #store: AsyncMessageRunStore;

  constructor(store: AsyncMessageRunStore) {
    this.#store = store;
  }

  async start(
    message: SurfaceMessage,
    idempotencyKey: string | undefined,
    artifactRoots: readonly string[],
    execute: (stream: AsyncMessageRunStream) => Promise<SurfaceReply | PairingChallenge>,
    authorityScope?: string,
  ): Promise<{ readonly snapshot: AsyncMessageRunSnapshot; readonly replayed: boolean; readonly conflict: boolean; readonly work?: Promise<void> }> {
    const fingerprint = `sha256:${createHash("sha256").update(JSON.stringify(message)).digest("hex")}`;
    const idempotencyScope = idempotencyKey
      ? createHash("sha256")
          .update(message.surfaceId).update("\0")
          .update(message.senderId).update("\0")
          .update(idempotencyKey).digest("hex")
      : undefined;
    const claim = await this.#store.claim({
      fingerprint,
      idempotencyScope,
      authorityScope,
      artifactRoots: artifactRoots.map((root) => resolve(root)),
      leaseMs: ASYNC_MESSAGE_LEASE_MS,
    });
    if (claim.status !== "claimed") {
      return {
        snapshot: this.#snapshot(claim.record, authorityScope ? TRUSTED_FRAPPE_ASYNC_RUNS_PATH : undefined),
        replayed: true,
        conflict: claim.status === "conflict",
      };
    }
    const ownerToken = claim.ownerToken as string;
    const runId = claim.record.runId;

    // The durable claim above is already committed. Yield once before the
    // running-state write so the HTTP 202 can flush even when SQLite is busy.
    const work = new Promise<void>((resolveWork) => setImmediate(resolveWork)).then(async () => {
      if (!await this.#store.markRunning(runId, ownerToken, Date.now(), ASYNC_MESSAGE_LEASE_MS)) return;
      let persistence = Promise.resolve();
      let leaseError: unknown;
      const pendingPreview = { partialText: "", reasoningText: "" };
      const acceptedPreviewChars = { partialText: 0, reasoningText: 0 };
      let previewTimer: ReturnType<typeof setTimeout> | undefined;
      const flushPreview = (): Promise<void> => {
        if (previewTimer) {
          clearTimeout(previewTimer);
          previewTimer = undefined;
        }
        const writes = (["partialText", "reasoningText"] as const)
          .map((field) => ({ field, text: pendingPreview[field] }))
          .filter((entry) => entry.text.length > 0);
        pendingPreview.partialText = "";
        pendingPreview.reasoningText = "";
        if (!writes.length) return persistence;
        persistence = persistence.then(async () => {
          for (const { field, text } of writes) {
            const updated = await this.#store.appendPreview(
              runId,
              ownerToken,
              field,
              text,
              ASYNC_MESSAGE_PREVIEW_MAX_CHARS,
            );
            if (!updated) throw new Error("Async message run ownership expired while streaming.");
          }
        }).catch((error) => { leaseError = error; });
        return persistence;
      };
      const appendPreview = (field: "partialText" | "reasoningText", text: string): void => {
        if (!text) return;
        const remaining = ASYNC_MESSAGE_PREVIEW_MAX_CHARS - acceptedPreviewChars[field];
        if (remaining <= 0) return;
        const boundedText = text.slice(0, remaining);
        acceptedPreviewChars[field] += boundedText.length;
        pendingPreview[field] += boundedText;
        if (!previewTimer) {
          previewTimer = setTimeout(() => { void flushPreview(); }, ASYNC_MESSAGE_PREVIEW_FLUSH_MS);
          previewTimer.unref?.();
        }
      };
      let heartbeatRunning = false;
      const heartbeat = setInterval(() => {
        if (heartbeatRunning || leaseError) return;
        heartbeatRunning = true;
        void this.#store.renew(runId, ownerToken, Date.now(), ASYNC_MESSAGE_LEASE_MS)
          .then((renewed) => { if (!renewed) leaseError = new Error("Async message run ownership expired."); })
          .catch((error) => { leaseError = error; })
          .finally(() => { heartbeatRunning = false; });
      }, Math.floor(ASYNC_MESSAGE_LEASE_MS / 4));
      heartbeat.unref?.();
      try {
        const reply = await execute({
          onDelta: (text) => appendPreview("partialText", text),
          onReasoningDelta: (text) => appendPreview("reasoningText", text),
        });
        await flushPreview();
        if (leaseError) {
          throw new Error(`Async message run lease failed: ${leaseError instanceof Error ? leaseError.message : String(leaseError)}`);
        }
        if (!await this.#store.complete(runId, ownerToken, reply)) {
          throw new Error("Async message run result could not be committed by its owning worker.");
        }
      } catch (error) {
        await flushPreview();
        await this.#store.fail(runId, ownerToken, error instanceof Error ? error.message : String(error)).catch(() => false);
      } finally {
        if (previewTimer) clearTimeout(previewTimer);
        clearInterval(heartbeat);
      }
    });
    return { snapshot: this.#snapshot(claim.record, authorityScope ? TRUSTED_FRAPPE_ASYNC_RUNS_PATH : undefined), replayed: false, conflict: false, work };
  }

  async read(runId: string, waitMs = 0, authorityScope?: string): Promise<AsyncMessageRunSnapshot | undefined> {
    const record = await this.#store.read(runId);
    if (!record) return undefined;
    if (authorityScope !== undefined && record.authorityScope !== authorityScope) return undefined;
    const boundedWait = Math.max(0, Math.min(ASYNC_MESSAGE_LONG_POLL_MAX_MS, Math.trunc(waitMs)));
    if (boundedWait && (record.status === "queued" || record.status === "running")) {
      const deadline = Date.now() + boundedWait;
      const initialPartial = record.partialText ?? "";
      const initialReasoning = record.reasoningText ?? "";
      while (Date.now() < deadline) {
        await new Promise((resolvePromise) => setTimeout(
          resolvePromise,
          Math.max(0, Math.min(ASYNC_MESSAGE_POLL_INTERVAL_MS, deadline - Date.now())),
        ));
        const current = await this.#store.read(runId);
        if (!current) return undefined;
        if (authorityScope !== undefined && current.authorityScope !== authorityScope) return undefined;
        const previewChanged = authorityScope === undefined && (
          (current.partialText ?? "") !== initialPartial
          || (current.reasoningText ?? "") !== initialReasoning
        );
        if (current.status === "completed" || current.status === "failed" || previewChanged) {
          return this.#snapshot(current, authorityScope ? TRUSTED_FRAPPE_ASYNC_RUNS_PATH : undefined);
        }
      }
    }
    return this.#snapshot(await this.#store.read(runId) ?? record, authorityScope ? TRUSTED_FRAPPE_ASYNC_RUNS_PATH : undefined);
  }

  async readArtifact(runId: string, index: number, authorityScope?: string): Promise<AsyncMessageArtifactDownload | undefined> {
    const record = await this.#store.read(runId);
    if (!record || record.status !== "completed" || !record.reply || isPairingChallenge(record.reply)) return undefined;
    if (authorityScope !== undefined && record.authorityScope !== authorityScope) return undefined;
    const artifact = record.reply.artifacts?.[index];
    if (!artifact || isHttpArtifact(artifact.path)) return undefined;
    const canonical = await realpath(artifact.path).catch(() => undefined);
    if (!canonical) return undefined;
    const roots = await Promise.all(record.artifactRoots.map((root) => realpath(root).catch(() => resolve(root))));
    if (!roots.some((root) => insideDirectory(root, canonical))) return undefined;
    const handle = await open(canonical, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW).catch(() => undefined);
    if (!handle) return undefined;
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > ASYNC_MESSAGE_ARTIFACT_MAX_BYTES) return undefined;
      if (process.platform === "linux") {
        const openedPath = await realpath(`/proc/self/fd/${handle.fd}`).catch(() => undefined);
        if (!openedPath || !roots.some((root) => insideDirectory(root, openedPath))) return undefined;
      }
      const bytes = await handle.readFile();
      if (artifact.sizeBytes !== undefined && artifact.sizeBytes !== bytes.length) return undefined;
      if (artifact.sha256 !== undefined
        && (!/^[a-f0-9]{64}$/.test(artifact.sha256) || createHash("sha256").update(bytes).digest("hex") !== artifact.sha256)) return undefined;
      return {
        name: basename(artifact.name || canonical),
        mime: artifact.mime || artifactMime(canonical),
        bytes,
      };
    } finally {
      await handle.close();
    }
  }

  #snapshot(record: StoredAsyncMessageRun, artifactBase = "/v1/messages/runs"): AsyncMessageRunSnapshot {
    const exposeProviderPreview = artifactBase !== TRUSTED_FRAPPE_ASYNC_RUNS_PATH;
    return {
      runId: record.runId,
      status: record.status,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      reply: sanitizeAsyncReply(record.runId, record.reply, artifactBase),
      ...(exposeProviderPreview && record.partialText
        ? { partialText: extractMediaTags(record.partialText).text }
        : {}),
      ...(exposeProviderPreview && record.reasoningText
        ? { reasoningText: record.reasoningText }
        : {}),
      ...(record.error
        ? { error: exposeProviderPreview
            ? record.error
            : "Muster could not complete this request. You can retry safely." }
        : {}),
    };
  }

}

function sanitizeAsyncReply(
  runId: string,
  reply: SurfaceReply | PairingChallenge | undefined,
  artifactBase = "/v1/messages/runs",
): SurfaceReply | PairingChallenge | undefined {
  if (!reply || isPairingChallenge(reply) || !reply.artifacts?.length) return reply;
  return {
    ...reply,
    artifacts: reply.artifacts.map((artifact, index) => ({
      ...artifact,
      path: isHttpArtifact(artifact.path) ? artifact.path : `${artifactBase}/${runId}/artifacts/${index}`,
    })),
  };
}

/** Duplicate deliveries (webhook retries) with the same key return the cached reply. */
export function idempotencyLookup(key: string | undefined): (SurfaceReply | PairingChallenge) | undefined {
  if (!key) return undefined;
  const hit = idempotencyCache.get(key);
  if (!hit || Date.now() - hit.at > IDEMPOTENCY_TTL_MS) return undefined;
  return hit.reply;
}

export function idempotencyStore(key: string | undefined, reply: SurfaceReply | PairingChallenge): void {
  if (!key) return;
  if (idempotencyCache.size > 1000) {
    const cutoff = Date.now() - IDEMPOTENCY_TTL_MS;
    for (const [cachedKey, value] of idempotencyCache) {
      if (value.at < cutoff) idempotencyCache.delete(cachedKey);
    }
  }
  idempotencyCache.set(key, { at: Date.now(), reply });
}

function deliveryLookup(key: string | undefined): unknown | undefined {
  if (!key) return undefined;
  const hit = deliveryCache.get(key);
  if (!hit || Date.now() - hit.at > IDEMPOTENCY_TTL_MS) return undefined;
  return hit.result;
}

function deliveryStore(key: string | undefined, result: unknown): void {
  if (!key) return;
  if (deliveryCache.size > 1000) {
    const cutoff = Date.now() - IDEMPOTENCY_TTL_MS;
    for (const [cachedKey, value] of deliveryCache) {
      if (value.at < cutoff) deliveryCache.delete(cachedKey);
    }
  }
  deliveryCache.set(key, { at: Date.now(), result });
}

const EXPLICIT_ARTIFACT_RE = /(?:\/(?:pdf|docx?|word|pptx?|slides?|xlsx?|excel)\b|\b(?:docx|pdf|pptx|xlsx)\b|\b(?:word|excel|powerpoint)\s+(?:file|document|workbook|presentation)\b)/i;
const ARTIFACT_NOUN_RE = /\b(?:artifact|attachment|document|presentation|slides?|spreadsheet|workbook|report|brief|deck)\b/i;
const ARTIFACT_CREATION_RE = /\b(?:attach|build|convert|create|draft|export|generate|give|make|need|prepare|produce|send|want|write)\b/i;
const MEMORY_REQUEST_RE = /\b(remember when|recall|look up memory|search memory|from memory|chat history|previous conversation|earlier conversation|last time|we discussed|named chat|previous session|context from before|what did (we|i) (discuss|say|decide)|my preference)\b/i;
const ARTIFACT_REF_RE = /(?:^|[\s`"'(])((?:\.\/)?artifacts\/[^\s`"')]+?\.(?:pdf|docx|xlsx|pptx|md|txt|csv|json|zip))/gi;
const LOCAL_ARTIFACT_PATH_RE = /(?:^|[\s`"'(])((?:\/home|\/Users|\/private\/tmp|\/tmp|\/var\/folders)\/[^\s`"')]+?\.(?:pdf|docx|xlsx|pptx|md|txt|csv|json|zip))/gi;

function userRequestText(text: string): string {
  const marker = "\nUser request:\n";
  const offset = text.lastIndexOf(marker);
  return (offset >= 0 ? text.slice(offset + marker.length) : text).trim();
}

function isArtifactRequest(text: string): boolean {
  const request = userRequestText(text);
  return EXPLICIT_ARTIFACT_RE.test(request)
    || (ARTIFACT_NOUN_RE.test(request) && ARTIFACT_CREATION_RE.test(request));
}

function maybeAddChannelArtifactInstructions(text: string): string {
  if (!isArtifactRequest(text) || /\bMEDIA\s*:/i.test(text)) return text;
  return [
    text,
    "",
    "Muster channel artifact delivery rules:",
    "- First satisfy the user's actual document/content request. Do not make this delivery checklist the artifact content.",
    "- If you create a file, create it under ./artifacts/ in the current workspace unless the user asks otherwise.",
    "- Prefer the installed `muster artifacts create` command for docx, xlsx, pptx, or pdf when it fits the request; otherwise create a reasonable local file directly.",
    "- End the final response with one `MEDIA:<local-path>` line for each generated file so Slack, Telegram, and other channels can verify and attach it. Remote URLs require a separately authenticated artifact host.",
    "- Keep the visible reply short and do not claim an attachment unless the MEDIA path exists.",
  ].join("\n");
}

function shouldRecallForChannel(text: string): boolean {
  return MEMORY_REQUEST_RE.test(text);
}

const ANSI_ESCAPE_RE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const LOCAL_PATH_RE = /(^|[\s("'`])(?:file:\/\/\/)?\/(?:home|Users|private|tmp|var\/folders|opt|srv)\/[^\s)"'`]+/gim;
const WINDOWS_PATH_RE = /\b[A-Za-z]:\\(?:[^\s\\]+\\)*[^\s]*/g;
const LOCAL_ENDPOINT_RE = /\b(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?(?:\/[^\s]*)?/gi;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi;
const TOKEN_QUERY_RE = /([?&](?:access_?token|token|key|secret|password)=)[^&\s]+/gi;
const ASSIGNMENT_SECRET_RE = /\b([A-Za-z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD)[A-Za-z0-9_]*)\s*=\s*[^\s]+/gi;
const SLACK_TOKEN_RE = /\bxox[a-z]-[A-Za-z0-9-]+/gi;
const MAX_CHANNEL_PROGRESS_CHARS = 1_200;

/**
 * Provider progress is user-visible. Keep the provider's exposed summary, but
 * strip host topology and secret-shaped values before it reaches a channel.
 * Hidden chain-of-thought is never available to this function.
 */
export function sanitizeChannelProgress(value: string): string {
  const sanitized = sanitizeChannelFinalText(value);
  if (sanitized.length <= MAX_CHANNEL_PROGRESS_CHARS) return sanitized;
  return `…${sanitized.slice(-(MAX_CHANNEL_PROGRESS_CHARS - 1))}`;
}

/** Last-mile channel safety: preserve the answer while removing host topology and secret-shaped values. */
export function sanitizeChannelFinalText(value: string): string {
  return value
    .replace(ANSI_ESCAPE_RE, "")
    .replace(LOCAL_PATH_RE, (_match, prefix: string) => `${prefix}the workspace`)
    .replace(WINDOWS_PATH_RE, "the workspace")
    .replace(LOCAL_ENDPOINT_RE, "the local service")
    .replace(BEARER_RE, "Bearer [redacted]")
    .replace(TOKEN_QUERY_RE, "$1[redacted]")
    .replace(ASSIGNMENT_SECRET_RE, "$1=[redacted]")
    .replace(SLACK_TOKEN_RE, "[redacted]")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function channelProgressText(providerSummary: string): string {
  const summary = sanitizeChannelProgress(providerSummary);
  return summary ? `▾ ${summary}` : "Working";
}

function artifactMime(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".pdf":
      return "application/pdf";
    case ".docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case ".pptx":
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    case ".md":
      return "text/markdown";
    case ".csv":
      return "text/csv";
    case ".txt":
      return "text/plain";
    default:
      return "application/octet-stream";
  }
}

async function readableFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return false;
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function resolveSurfaceArtifactRef(ref: string, workspaceDir: string): Promise<SurfaceArtifact | undefined> {
  if (isHttpArtifact(ref)) return undefined;
  const workspaceRoot = await realpath(workspaceDir).catch(() => resolve(workspaceDir));
  const candidate = isAbsolute(ref) ? resolve(ref) : resolve(workspaceRoot, ref);
  const canonical = await realpath(candidate).catch(() => undefined);
  if (!canonical || !insideDirectory(workspaceRoot, canonical) || !await readableFile(canonical)) return undefined;
  return { name: basename(canonical), mime: artifactMime(canonical), path: canonical };
}

function insideDirectory(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function extractArtifactPathRefs(text: string): string[] {
  const refs: string[] = [];
  for (const match of text.matchAll(ARTIFACT_REF_RE)) {
    const ref = match[1]?.replace(/[.,;:]+$/, "");
    if (ref) refs.push(ref);
  }
  for (const match of text.matchAll(LOCAL_ARTIFACT_PATH_RE)) {
    const ref = match[1]?.replace(/[.,;:]+$/, "");
    if (ref) refs.push(ref);
  }
  return [...new Set(refs)];
}

interface ChannelArtifactScope {
  readonly tenantId: string;
  readonly runId: string;
  readonly sourceChannel: string;
  readonly sourcePrompt: string;
  readonly providerId?: string;
  readonly model?: string;
  readonly tokenLedgerId?: string;
}

interface PersistedChannelArtifact {
  readonly workspace: ArtifactWorkspace;
  readonly artifactId: string;
}

const persistedChannelArtifacts = new WeakMap<SurfaceArtifact, PersistedChannelArtifact>();

async function markChannelArtifactDelivery(
  artifact: SurfaceArtifact,
  delivery: Partial<ArtifactDeliveryReceipt>,
): Promise<void> {
  const persisted = persistedChannelArtifacts.get(artifact);
  if (!persisted) return;
  await updateArtifactDelivery(persisted.workspace, persisted.artifactId, delivery);
}

async function resolveChannelArtifacts(
  text: string,
  extractedRefs: string[],
  workspaceDir: string,
  cwd: string,
  scope: ChannelArtifactScope,
): Promise<SurfaceArtifact[]> {
  const refs = [...extractedRefs, ...extractArtifactPathRefs(text)];
  const declared = (await Promise.all([...new Set(refs)].map((ref) => resolveSurfaceArtifactRef(ref, workspaceDir))))
    .filter((artifact): artifact is SurfaceArtifact => Boolean(artifact));
  const supported = declared.filter((artifact) =>
    !isHttpArtifact(artifact.path) && /\.(?:docx|xlsx|pptx|pdf)$/i.test(artifact.name)
  );
  if (!supported.length) return declared;
  const artifactWorkspace = await createArtifactWorkspace({
    rootDir: join(dataDir(cwd), "artifacts"),
    tenantId: scope.tenantId,
    runId: scope.runId,
  });
  const hardened = new Map<string, SurfaceArtifact>();
  const blocked = new Set<string>();
  for (const [index, artifact] of supported.entries()) {
    const bytes = await readFile(artifact.path);
    const format = extname(artifact.name).slice(1).toLowerCase() as ArtifactResult["format"];
    const result: ArtifactResult = {
      filename: artifact.name,
      mimeType: artifact.mime,
      format,
      bytes: bytes.length,
      base64: bytes.toString("base64"),
    };
    const persisted = await persistArtifact({
      workspace: artifactWorkspace,
      artifact: result,
      artifactId: `channel-${index + 1}-${createHash("sha256").update(artifact.name).update(bytes).digest("hex").slice(0, 12)}`,
      title: artifact.name.replace(/\.[^.]+$/, ""),
      sourceChannel: scope.sourceChannel,
      sourcePrompt: scope.sourcePrompt,
      providerId: scope.providerId,
      model: scope.model,
      providerRunId: scope.runId,
      tokenLedgerId: scope.tokenLedgerId,
      generationMode: "provider",
      delivery: { state: "local-only", channel: scope.sourceChannel, reason: "Awaiting verified channel upload." },
    });
    if (persisted.entry.verification.status !== "passed") {
      blocked.add(artifact.path);
      continue;
    }
    const hardenedArtifact = { ...artifact, path: persisted.declaration.localPath! };
    persistedChannelArtifacts.set(hardenedArtifact, { workspace: artifactWorkspace, artifactId: persisted.entry.artifactId });
    hardened.set(artifact.path, hardenedArtifact);
  }
  return declared.flatMap((artifact) => blocked.has(artifact.path) ? [] : [hardened.get(artifact.path) ?? artifact]);
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\bxox[baprs]-[A-Za-z0-9-]+/i, "Slack token"],
  [/\bxapp-[A-Za-z0-9-]+/i, "Slack app token"],
  [/\b(?:sk|sk-proj)-[A-Za-z0-9_-]{16,}/i, "API key"],
  [/\bAKIA[0-9A-Z]{16}\b/, "AWS access key"],
  [/\b(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*\S+/i, "secret assignment"],
];

interface GatewayPreflight {
  readonly reply?: SurfaceReply;
  readonly policyIds: readonly string[];
}

async function gatewayGovernancePreflight(
  message: SurfaceMessage,
  paired: PairedSender,
  assignment: GatewayGovernanceAssignment,
  agentId: string,
  gateway: Pick<GatewayConfig, "governance"> | undefined,
  enterprise: GatewayEnterpriseRuntime | undefined,
): Promise<GatewayPreflight> {
  const governance = gateway?.governance;
  if (!governance?.enabled) return { policyIds: [] };
  const validation = governance.requestValidation;
  const maxChars = validation?.maxChars ?? 16_000;
  if (message.text.length > maxChars) {
    return { reply: governanceBlock(`Request rejected by validation: message is ${message.text.length} characters, limit is ${maxChars}.`), policyIds: [] };
  }
  if (validation?.blockSecrets ?? true) {
    for (const [pattern, label] of SECRET_PATTERNS) {
      if (pattern.test(message.text)) return { reply: governanceBlock(`Request rejected by validation: possible ${label} detected. Remove secrets and use configured credentials instead.`), policyIds: [] };
    }
  }
  for (const patternSource of validation?.blockedPatterns ?? []) {
    const pattern = safeRegex(patternSource);
    if (pattern?.test(message.text)) return { reply: governanceBlock("Request rejected by validation: matched blocked policy pattern."), policyIds: [] };
  }
  if (assignment.allowedSurfaces?.length && !assignment.allowedSurfaces.includes(message.surfaceId)) {
    return { reply: governanceBlock(`Request blocked by RBAC: this user is not allowed to use surface ${message.surfaceId}.`), policyIds: [] };
  }
  const channelId = governanceChannelId(message);
  if (assignment.allowedChannels?.length && !assignment.allowedChannels.includes(channelId) && !assignment.allowedChannels.includes(message.conversationId)) {
    return { reply: governanceBlock(`Request blocked by RBAC: this user is not allowed to use channel ${channelId}.`), policyIds: [] };
  }
  if (!enterprise) {
    return { reply: governanceBlock("Enterprise governance is enabled but no atomic runtime store is available."), policyIds: [] };
  }
  const estimatedTokens = estimateTokens(message.text) + Math.max(0, Math.floor(governance.estimatedOutputTokens ?? 800));
  const rate = await enforceGatewayRateLimits({
    runtime: enterprise,
    gateway: { governance },
    message,
    paired,
    assignment,
    agentId,
    estimatedTokens,
  });
  return { ...(rate.blocked ? { reply: governanceBlock(rate.blocked) } : {}), policyIds: rate.policyIds };
}

function governanceChannelId(message: SurfaceMessage): string {
  return `${message.surfaceId}:${message.conversationId}`;
}

function safeRegex(source: string): RegExp | undefined {
  try {
    return new RegExp(source, "i");
  } catch {
    return undefined;
  }
}

function governanceBlock(text: string): SurfaceReply {
  return {
    text: [
      text,
      "No provider call was made.",
    ].join("\n"),
  };
}

async function executeVerifiedApproval(
  binding: ApprovalActionBinding,
  decision: ApprovalDecision,
  input: {
    readonly config: MusterConfig;
    readonly cwd: string;
    readonly registry?: FlowToolRegistry;
    readonly store?: SqliteApprovalActionStore;
    readonly enterprise?: GatewayEnterpriseRuntime;
    readonly executionOwner?: string;
    readonly executionClaimed?: boolean;
  },
): Promise<SurfaceReply> {
  const executionOwner = input.executionOwner ?? randomUUID();
  if (input.store && !input.executionClaimed && !input.store.claimExecution(binding.id, executionOwner, Date.now(), 15 * 60_000)) {
    return { text: "This approval is already being applied by another gateway worker." };
  }
  try {
    const paired = await resolvePairing(binding.surfaceId, binding.actorId, input.cwd);
    if (!paired) throw new Error("The approving sender is no longer paired.");
    const state = await getFlowRun(binding.runId, input.cwd);
    const gate = state.pendingGate;
    if (state.status !== "awaiting_approval" || !gate || gate.stepId !== binding.gateId) {
      throw new Error("The approval gate is no longer current.");
    }
    if (approvalRevision(binding.runId, binding.gateId, gate.show) !== binding.revision) {
      throw new Error("The approval content changed after this control was issued.");
    }
    const result = await resumeFlow(binding.runId, {
      approve: decision === "approve",
      config: input.config,
      registry: input.registry ?? defaultRegistry(),
      cwd: input.cwd,
    });
    input.store?.markExecution(binding.id, "completed", `${decision}:${result.status}`, executionOwner);
    const auditWarning = await recordApprovalReceipt(input.enterprise, binding, decision, "completed");
    return {
      text: `${decision === "approve"
        ? `Approval accepted. Run ${result.runId} is ${result.status}.`
        : `Approval rejected. Run ${result.runId} is ${result.status}.`}${auditWarning ? `\nAudit warning: ${auditWarning}` : ""}`,
      ...(result.status === "awaiting_approval" && result.gateId ? {
        approvalRequest: { runId: result.runId, gateId: result.gateId, show: result.show, options: ["approve", "reject"] as const },
      } : {}),
    };
  } catch (error) {
    input.store?.markExecution(binding.id, "failed", error instanceof Error ? error.message : String(error), executionOwner);
    const auditWarning = await recordApprovalReceipt(input.enterprise, binding, decision, "failed");
    return { text: `Approval could not be applied: ${error instanceof Error ? error.message : String(error)}${auditWarning ? `\nAudit warning: ${auditWarning}` : ""}` };
  }
}

async function recordApprovalReceipt(
  enterprise: GatewayEnterpriseRuntime | undefined,
  binding: ApprovalActionBinding,
  decision: ApprovalDecision,
  outcome: "completed" | "failed",
): Promise<string | undefined> {
  if (!enterprise) return undefined;
  try {
    const actor = [
      { kind: "channel" as const, id: `${binding.surfaceId}:${binding.conversationId}` },
      { kind: "user" as const, id: binding.actorId },
    ];
    await enterprise.receiptStore.appendReceipt(createEnterpriseActionReceipt({
      actor,
      target: actor,
      action: `approval.${decision}`,
      outcome,
      policyIds: [`gate:${binding.gateId}`],
      requestFingerprint: createHash("sha256").update(JSON.stringify([binding.runId, binding.gateId, binding.revision])).digest("hex"),
      metadata: { run_id: binding.runId, gate_id: binding.gateId, approval_id: binding.id },
    }));
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function approvalRevision(runId: string, gateId: string, show: unknown): string {
  return createHash("sha256").update(JSON.stringify([runId, gateId, show])).digest("hex");
}

async function recoverPendingApprovals(options: GatewayServerOptions, store: SqliteApprovalActionStore): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  for (;;) {
    const owner = `recovery:${process.pid}:${randomUUID()}`;
    const pendingBatch = store.claimPending(owner, Date.now(), 15 * 60_000, 100);
    if (!pendingBatch.length) return;
    for (const pending of pendingBatch) {
      const reply = await executeVerifiedApproval(pending.binding, pending.decision, {
        config: options.config,
        cwd,
        registry: options.registry,
        store,
        enterprise: options.enterprise,
        executionOwner: pending.executionOwner ?? owner,
        executionClaimed: true,
      });
      options.log?.(`approval recovery id=${pending.binding.id} result=${reply.text}`);
    }
  }
}

function pairedIdentityNeedsRefresh(
  paired: PairedIdentity,
  authorized: Omit<PairedIdentity, "provider" | "resolvedAt">,
): boolean {
  return paired.permissionHash !== authorized.permissionHash
    || paired.rolesHash !== authorized.rolesHash
    || paired.userName !== authorized.userName
    || paired.employee !== authorized.employee
    || paired.employeeName !== authorized.employeeName
    || paired.employeeStatus !== authorized.employeeStatus
    || paired.department !== authorized.department
    || paired.departmentName !== authorized.departmentName
    || paired.reportsTo !== authorized.reportsTo
    || paired.reportsToName !== authorized.reportsToName
    || paired.company !== authorized.company
    || paired.displayNamesResolvedAt !== authorized.displayNamesResolvedAt;
}

function pairedIdentityFromAuthorization(authorization: FrappeOAuthAuthorization): PairedIdentity {
  return {
    provider: "frappe",
    ...authorization.identity,
    resolvedAt: new Date().toISOString(),
  };
}

export async function handleSurfaceMessage(
  message: SurfaceMessage,
  options: Pick<GatewayServerOptions, "config" | "cwd" | "nativeTransportOwner" | "frappeOAuth" | "fetcher"> & {
    readonly gateway?: GatewayConfig;
    readonly enterprise?: GatewayEnterpriseRuntime;
    readonly approvalStore?: SqliteApprovalActionStore;
    readonly approvalActions?: ApprovalActionCodec;
    /** Tool registry used for skill commands that dispatch directly to tools. */
    readonly registry?: FlowToolRegistry;
    /**
     * Channel draft sink. When provided AND message.stream === "draft", the
     * reply is streamed as a live-edited draft through the core draft loop;
     * the returned SurfaceReply still carries the final text so callers can
     * log it, but it has already been delivered by the sink.
     */
    readonly sink?: DraftSink;
    /** Assistant text emitted by the provider, forwarded unchanged. */
    readonly onDelta?: (text: string) => void;
    /** Provider-visible reasoning summary, forwarded unchanged. */
    readonly onReasoningDelta?: (text: string) => void;
    /** Truthful host milestone for channel progress; never hidden reasoning. */
    readonly onStatus?: (text: string) => void;
    /** Present only for the bearer-authenticated Frappe integration route. */
    readonly trustedFrappe?: TrustedFrappeContext;
    /** Host-classified artifact permission. False also suppresses artifact discovery/persistence. */
    readonly allowArtifacts?: boolean;
    /** Internal channel authorization already proven before the envelope reaches the gateway. */
    readonly pairingOverride?: PairedSender;
  },
): Promise<SurfaceReply | PairingChallenge> {
  const cwd = options.cwd ?? process.cwd();
  const resolvedPairing = options.pairingOverride ?? await resolvePairing(message.surfaceId, message.senderId, cwd);
  if (!resolvedPairing) {
    const pending = await requestPairing(message.surfaceId, message.senderId, cwd);
    return { status: "pairing_required", code: pending.code };
  }
  let paired = resolvedPairing;
  if (options.trustedFrappe && paired.identity?.provider !== "frappe") {
    return { text: "This Frappe request could not be verified against a bound Frappe identity." };
  }
  const parsedCommand = parseCommand(message.text);
  if (options.trustedFrappe && parsedCommand && ["pair", "connect"].includes(parsedCommand.name)) {
    return {
      text: "Your Frappe identity is already connected through this signed session. No separate pairing is needed.",
    };
  }
  let frappeAuthorization: FrappeOAuthAuthorization | undefined;
  const profile = activeProfile(cwd);
  // muster builtin slash-commands and tool-dispatch skills are answered here
  // with NO model call; prompt-dispatch skills rewrite the prompt, and unknown
  // commands fall through to the native provider CLI.
  const sessionKey = conversationSessionId(message);
  const assignment = resolveGatewayGovernanceAssignment(options.gateway, message, paired.pairingId);
  const frappeInteractionKey = paired.identity?.provider === "frappe"
    ? pendingFrappeInteractionKey(message, paired.identity.site, paired.identity.user)
    : undefined;
  if (frappeInteractionKey && parsedCommand?.name === "cancel") {
    const pending = options.enterprise?.frappeInteractionStore.read(frappeInteractionKey);
    if (pending?.phase === "executing" || pending?.phase === "uncertain") {
      return {
        text: "This request was already admitted for execution, so it cannot be discarded safely. Use /accept to check the destination without sending it again.",
      };
    }
    options.enterprise?.frappeInteractionStore.clear(frappeInteractionKey);
    const supportHandoff = isSupportHandoff(pending);
    const presentation: SurfacePresentation = {
      kind: "status",
      title: supportHandoff ? "Ticket cancelled" : "Request cancelled",
      summary: supportHandoff
        ? "Nothing was sent to support and no record was created or changed."
        : "Nothing was created or changed.",
    };
    return { text: renderPresentationText(presentation), presentation };
  }
  const pendingApproval = pendingApprovalFromRaw(message.raw);
  if (pendingApproval) {
    if (!options.approvalActions) return { text: "Approval could not be verified: approval controls are unavailable." };
    const parsed = options.approvalActions.parse(pendingApproval.value, pendingApproval.attempt);
    if (!parsed.ok) return { text: `Approval could not be verified: ${parsed.reason.replaceAll("_", " ")}.` };
    return executeVerifiedApproval(parsed.binding, parsed.decision, {
      config: options.config,
      cwd,
      registry: options.registry,
      store: options.approvalStore,
      enterprise: options.enterprise,
    });
  }
  const verifiedApproval = verifiedApprovalFromRaw(message.raw);
  if (verifiedApproval) {
    return executeVerifiedApproval(verifiedApproval.binding, verifiedApproval.decision, {
      config: options.config,
      cwd,
      registry: options.registry,
      store: options.approvalStore,
      enterprise: options.enterprise,
    });
  }
  const dispatchBuiltin = () => dispatchCommand(message, {
    config: options.config,
    profile,
    paired,
    gateway: options.gateway,
    enterprise: options.enterprise,
    frappeOAuth: options.frappeOAuth,
    cwd,
    conversationKey: sessionKey,
    legacyConversationKey: `${message.surfaceId}:${message.conversationId}`,
  });
  // Session-mutating commands must wait for an active provider turn to finish,
  // otherwise its final session-handle save can silently undo the reset.
  const command = parsedCommand && ["new", "reset"].includes(parsedCommand.name)
    ? await runConversationExclusive(sessionKey, dispatchBuiltin, options.enterprise)
    : await dispatchBuiltin();
  if (command) return command;
  const preflight = await gatewayGovernancePreflight(message, paired, assignment, profile, options.gateway, options.enterprise);
  if (preflight.reply) {
    if (options.enterprise) {
      await recordGatewayUsage(options.enterprise, {
        message,
        paired,
        assignment,
        outcome: "blocked",
        latencyMs: 0,
        inputTokens: estimateTokens(message.text),
        action: "gateway.run",
        agentId: profile,
        policyIds: preflight.policyIds,
      });
    }
    return preflight.reply;
  }
  if (options.trustedFrappe?.fastReply) {
    if (options.enterprise) {
      await recordGatewayUsage(options.enterprise, {
        message,
        paired,
        assignment,
        outcome: "success",
        latencyMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        requestCategory: "frappe",
        action: "gateway.frappe_fast_reply",
        agentId: profile,
        policyIds: preflight.policyIds,
      });
    }
    return options.trustedFrappe.fastReply;
  }
  if (paired.identity?.provider === "frappe" && parsedCommand?.name !== "pair") {
    const quickReply = frappeChannelQuickReply(
      message.text,
      paired.identity,
      options.gateway?.frappe?.assistant,
      true,
    );
    if (quickReply) {
      if (options.enterprise) {
        await recordGatewayUsage(options.enterprise, {
          message,
          paired,
          assignment,
          outcome: "success",
          latencyMs: 0,
          inputTokens: estimateTokens(message.text),
          outputTokens: estimateTokens(quickReply.text),
          requestCategory: "frappe",
          action: "gateway.frappe_deterministic",
          agentId: profile,
          policyIds: preflight.policyIds,
        });
      }
      return quickReply;
    }
  }
  if (paired.identity?.provider === "frappe" && !options.trustedFrappe && options.frappeOAuth && !frappeAuthorization) {
    try {
      frappeAuthorization = await options.frappeOAuth.authorizationForActor({
        surfaceId: message.surfaceId,
        senderId: message.senderId,
        pairingId: paired.pairingId,
      }, paired.identity.site);
    } catch {
      return { text: "Your Frappe authorization could not be selected safely. Use /pair to reconnect this chat before accessing live records." };
    }
    if (frappeAuthorization
      && (frappeAuthorization.identity.user !== paired.identity.user || frappeAuthorization.site !== paired.identity.site)) {
      return { text: "Your paired Frappe identity no longer matches its authorization. Use /pair to reconnect before accessing live records." };
    }
    if (frappeAuthorization && pairedIdentityNeedsRefresh(paired.identity, frappeAuthorization.identity)) {
      paired = await upsertTrustedFrappePairing(message.surfaceId, message.senderId, frappeAuthorization.identity, cwd);
    }
  }
  if (frappeInteractionKey && parsedCommand && ["accept", "create"].includes(parsedCommand.name)) {
    const pendingInteraction = options.enterprise?.frappeInteractionStore.read(frappeInteractionKey);
    let guestSupportDestination: FrappeSupportDestination | undefined;
    if (options.gateway?.frappe?.support) {
      try {
        const configured = resolveFrappeSupportDestination(options.gateway.frappe.support);
        if (configured.authMode === "guest") guestSupportDestination = configured;
      } catch {
        guestSupportDestination = undefined;
      }
    }
    if (pendingInteraction && options.frappeOAuth && !matchesGuestSupportDestination(pendingInteraction, guestSupportDestination)) {
      try {
        const actor = {
          surfaceId: message.surfaceId,
          senderId: message.senderId,
          pairingId: paired.pairingId,
        };
        frappeAuthorization = pendingInteraction.connectionId
          ? await options.frappeOAuth.authorization(pendingInteraction.connectionId, actor)
          : await options.frappeOAuth.authorizationForActor(actor, pendingInteraction.site);
      } catch {
        frappeAuthorization = undefined;
      }
    }
    return acceptPendingFrappeCreation({
      pending: pendingInteraction,
      authorization: frappeAuthorization,
      guestSupportDestination,
      registry: options.registry,
      signingKey: options.gateway?.frappe?.approvalSigningKey,
      fetcher: options.fetcher,
      clear: () => options.enterprise?.frappeInteractionStore.clear(frappeInteractionKey),
      update: (pending) => options.enterprise?.frappeInteractionStore.put(pending),
      claim: (pending, attemptId, nowMs) => options.enterprise?.frappeInteractionStore.claimExecution(
        pending.key,
        pending.updatedAtMs,
        attemptId,
        nowMs,
      ),
    });
  }
  const storedFrappeInteraction = frappeInteractionKey && !parsedCommand
    ? options.enterprise?.frappeInteractionStore.read(frappeInteractionKey)
    : undefined;
  if (storedFrappeInteraction && options.frappeOAuth
      && frappeAuthorization?.site !== storedFrappeInteraction.site) {
    try {
      frappeAuthorization = await options.frappeOAuth.authorizationForActor({
        surfaceId: message.surfaceId,
        senderId: message.senderId,
        pairingId: paired.pairingId,
      }, storedFrappeInteraction.site);
    } catch {
      frappeAuthorization = undefined;
    }
  }
  const interruptsFrappeInteraction = storedFrappeInteraction
    ? isIndependentFrappeRequest(message.text, storedFrappeInteraction)
    : false;
  if (interruptsFrappeInteraction && frappeInteractionKey) {
    options.enterprise?.frappeInteractionStore.clear(frappeInteractionKey);
  }
  const frappeContinuation = storedFrappeInteraction && !interruptsFrappeInteraction
    ? continuePendingFrappeInteraction(storedFrappeInteraction, message.text)
    : undefined;
  if (paired.identity?.provider === "frappe" && frappeAuthorization) {
    options.onStatus?.(frappeContinuation ? "Checking the next required detail" : "Checking your current access");
  }
  const supportDraft = paired.identity?.provider === "frappe" && isFrappeIssueReportRequest(message.text)
      ? createFrappeSupportDraft({
        prompt: message.text,
        identity: paired.identity,
        context: options.trustedFrappe,
        config: options.gateway?.frappe?.support,
        investigation: supportInvestigationFromTrustedContext(options.trustedFrappe),
      })
    : undefined;
  if (supportDraft?.destination.authMode === "guest") {
    if (!frappeInteractionKey || !options.enterprise) {
      return { text: "Public support intake is configured, but durable approval state is unavailable. Nothing was sent." };
    }
    const nowMs = Date.now();
    options.enterprise.frappeInteractionStore.put({
      key: frappeInteractionKey,
      site: supportDraft.destination.site,
      principal: paired.identity!.user,
      surfaceId: message.surfaceId,
      conversationId: message.conversationId,
      senderId: message.senderId,
      doctype: supportDraft.destination.doctype,
      operation: "create",
      values: supportDraft.values,
      requiredFields: [],
      phase: "review",
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
      expiresAtMs: nowMs + 15 * 60_000,
    });
    return supportReviewReply(supportDraft.values);
  }
  if (supportDraft && options.frappeOAuth
      && (frappeAuthorization?.site !== supportDraft.destination.site
        || (supportDraft.destination.connectionId && frappeAuthorization.connectionId !== supportDraft.destination.connectionId))) {
    try {
      const actor = {
        surfaceId: message.surfaceId,
        senderId: message.senderId,
        pairingId: paired.pairingId,
      };
      frappeAuthorization = supportDraft.destination.connectionId
        ? await options.frappeOAuth.authorization(supportDraft.destination.connectionId, actor)
        : await options.frappeOAuth.authorizationForActor(actor, supportDraft.destination.site);
    } catch {
      frappeAuthorization = undefined;
    }
  }
  if (supportDraft && !frappeAuthorization) {
    const connectionId = supportDraft.destination.connectionId;
    const presentation: SurfacePresentation = {
      kind: "status",
      title: "Connect support once",
      summary: "The issue evidence is ready, but this channel sender has not authorized the configured Helpdesk destination.",
      notice: "Nothing was sent. Connect the support account, then repeat the request from the affected record.",
      actions: connectionId
        ? [{ id: "connect-support", label: "Connect support", command: `/pair start ${connectionId}`, style: "primary" }]
        : [{ id: "connections", label: "Review connections", command: "/pair", style: "primary" }],
    };
    return { text: renderPresentationText(presentation), presentation };
  }
  const turnIdentity = frappeAuthorization
    ? pairedIdentityFromAuthorization(frappeAuthorization)
    : paired.identity;
  const frappeTurnContext = paired.identity?.provider === "frappe" && frappeAuthorization
    ? await frappePermissionContextForTurn({
        prompt: supportDraft ? `create ${supportDraft.destination.doctype}` : frappeContinuation?.prompt ?? message.text,
        surfaceId: message.surfaceId,
        identity: turnIdentity!,
        authorization: frappeAuthorization,
        registry: options.registry,
        ...(supportDraft
          ? { continuation: { doctype: supportDraft.destination.doctype, operation: "create" as const, values: supportDraft.values } }
          : frappeContinuation ? { continuation: frappeContinuation.continuation } : {}),
      })
    : undefined;
  if (frappeInteractionKey && frappeTurnContext?.pendingInteraction && options.enterprise) {
    const nowMs = Date.now();
    options.enterprise.frappeInteractionStore.put({
      key: frappeInteractionKey,
      site: frappeAuthorization?.site ?? paired.identity!.site,
      principal: frappeAuthorization?.identity.user ?? paired.identity!.user,
      surfaceId: message.surfaceId,
      conversationId: message.conversationId,
      senderId: message.senderId,
      ...(supportDraft?.destination.connectionId ? { connectionId: supportDraft.destination.connectionId } : {}),
      doctype: frappeTurnContext.pendingInteraction.doctype,
      operation: frappeTurnContext.pendingInteraction.operation,
      values: frappeTurnContext.pendingInteraction.values,
      requiredFields: frappeTurnContext.pendingInteraction.requiredFields,
      phase: frappeTurnContext.pendingInteraction.requiredFields.length ? "collecting" : "review",
      createdAtMs: storedFrappeInteraction?.createdAtMs ?? nowMs,
      updatedAtMs: nowMs,
      expiresAtMs: nowMs + 15 * 60_000,
    });
  }
  const evidenceReply = frappeTurnContext ? frappeEvidenceQuickReply(frappeTurnContext) : undefined;
  if (evidenceReply) {
    if (options.enterprise) {
      await recordGatewayUsage(options.enterprise, {
        message,
        paired,
        assignment,
        outcome: "success",
        latencyMs: frappeTurnContext?.elapsedMs ?? 0,
        inputTokens: estimateTokens(message.text),
        outputTokens: estimateTokens(evidenceReply.text),
        requestCategory: "frappe",
        action: "gateway.frappe_evidence_reply",
        agentId: profile,
        policyIds: preflight.policyIds,
      });
    }
    return evidenceReply;
  }
  if (frappeTurnContext) {
    options.onStatus?.(frappeTurnContext.source === "live_frappe"
      ? "Reading the information you can access"
      : "Checking the current workflow");
  }
  const frappeTaskKind = frappeTaskKindForIntent(frappeTurnContext?.intent, message.text);
  const governedFrappeTurn = paired.identity?.provider === "frappe"
    && Boolean(options.trustedFrappe || isFrappeBusinessIntent(frappeTurnContext?.intent));
  const trustedProviderBoundary = options.trustedFrappe
    ? trustedFrappeProviderBoundary(
        Object.keys(options.config.tools?.mcp?.servers ?? {}),
        options.gateway?.frappe?.providerTools?.denyInherited ?? [],
      )
    : undefined;
  const inheritedToolDeny = governedFrappeTurn
    ? trustedProviderBoundary?.inheritedToolDeny ?? options.gateway?.frappe?.providerTools?.denyInherited ?? []
    : [];
  const nativeSessionPolicyKey = paired.identity?.provider === "frappe"
    ? frappeNativeSessionPolicyKey(
        paired.identity,
        options.gateway?.frappe?.assistant,
        Boolean(frappeAuthorization || options.trustedFrappe),
        inheritedToolDeny,
      )
    : undefined;
  const customCommand = resolveCustomCommand(message, options.gateway);
  let runText = customCommand?.prompt ?? (options.allowArtifacts === false ? message.text : maybeAddChannelArtifactInstructions(message.text));
  if (parsedCommand && !customCommand) {
    const skillCommand = await resolveSkillCommand(parsedCommand.name, parsedCommand.args, cwd, {
      skillAllowlist: resolveAgentSkillAllowlist(options.config, profile),
      discovery: options.config.skills?.load,
    });
    if (skillCommand?.dispatch === "tool") {
      const tool = options.registry?.[skillCommand.tool];
      if (!tool) return { text: `Skill command /${parsedCommand.name} is unavailable: tool "${skillCommand.tool}" is not registered.` };
      const output = await tool(skillCommand.args);
      return { text: typeof output === "string" ? output : JSON.stringify(output, null, 2) };
    }
    if (skillCommand?.dispatch === "prompt") {
      runText = skillCommand.prompt;
    }
  }
  // Native provider CLIs (codex/claude) execute in the PROFILE WORKSPACE, never
  // the muster install root — closes the cwd-escape and isolates per profile.
  const workspaceDir = profileWorkspaceDir(cwd, profile);
  await ensureWorkspaceOnce(workspaceDir);
  const startedAt = Date.now();
  const streaming = options.sink !== undefined && message.stream === "draft";
  const channel = streaming ? createStreamEventChannel() : undefined;
  const streamRun = channel ? new StreamRun({ onEvent: channel.push }) : undefined;
  const draftLoop = streaming && channel && options.sink
    ? runDraftLoop(channel.events, options.sink)
    : undefined;
  try {
    if (paired.identity?.provider === "frappe") options.onStatus?.("Preparing your answer");
    const outcome = await runConversationExclusive(sessionKey, () => executeRun(options.config, {
      prompt: runText,
      ...(frappeTaskKind ? { taskKind: frappeTaskKind } : {}),
      cwd,
      workspaceDir,
      skipRecall: !shouldRecallForChannel(message.text),
      conversationKey: sessionKey,
      // Trusted Frappe turns already carry fresh, permission-filtered context.
      // One-shot transport avoids a stale/hung provider thread retaining an
      // earlier permission epoch and has materially lower tail latency here.
      nativeTransport: options.trustedFrappe ? "exec" : "warm",
      nativeSessionKeepAlive: !options.trustedFrappe,
      nativeSessionMaxTurns: NATIVE_SESSION_MAX_TURNS,
      nativeSessionMaxAgeMs: NATIVE_SESSION_MAX_AGE_MS,
      nativeTransportOwner: options.nativeTransportOwner,
      agentId: profile,
      ...(process.env.MUSTER_CODEX_HOME ? { codexHome: process.env.MUSTER_CODEX_HOME } : {}),
      ...(inheritedToolDeny.length
        ? { inheritedToolDeny }
        : {}),
      ...(nativeSessionPolicyKey ? { nativeSessionPolicyKey } : {}),
      surfaceId: message.surfaceId,
      scopes: [
        ...pairingScopes(paired),
        { kind: "session", id: sessionKey },
      ],
      onDelta: streamRun || options.onDelta ? (text) => {
        if (streamRun?.state === "streaming") streamRun.pushDelta(text);
        options.onDelta?.(text);
      } : undefined,
      onReasoningDelta: options.onReasoningDelta,
      ...(options.trustedFrappe
        ? {
            systemContext: trustedFrappeSystemContext(
              paired.identity!,
              options.trustedFrappe,
              options.gateway?.frappe?.assistant,
            ),
            turnContext: trustedFrappeTurnContext(options.trustedFrappe),
            nativeSandbox: trustedProviderBoundary!.nativeSandbox,
            nativeNetworkAccess: trustedProviderBoundary!.nativeNetworkAccess,
            skipSkillSelection: trustedProviderBoundary!.skipSkillSelection,
          }
        : paired.identity?.provider === "frappe"
          ? {
              systemContext: frappeChannelSystemContext(
                paired.identity,
                options.gateway?.frappe?.assistant,
                Boolean(frappeAuthorization),
              ),
              ...(frappeTurnContext?.context
                ? { turnContext: frappeChannelTurnContext(frappeTurnContext.context) }
                : {}),
            }
          : {}),
    }), options.enterprise);
    if (outcome.episode.outcome?.kind !== "completed") {
      throw new Error(outcome.episode.outcome?.detail ?? "Run failed");
    }
    const extracted = extractMediaTags(outcome.episode.responseText);
    const artifactRequested = options.allowArtifacts !== false && isArtifactRequest(message.text);
    const artifacts = options.allowArtifacts === false ? [] : await resolveChannelArtifacts(
      outcome.episode.responseText,
      extracted.media.map((item) => item.ref),
      workspaceDir,
      cwd,
      {
        tenantId: assignment.tenantId ?? (paired.identity?.provider === "frappe" ? paired.identity.site : paired.pairingId),
        runId: outcome.tokens.runId,
        sourceChannel: message.surfaceId,
        sourcePrompt: message.text,
        providerId: outcome.tokens.provider,
        model: outcome.tokens.model,
        tokenLedgerId: outcome.tokens.runId,
      },
    );
    const safeProviderText = sanitizeChannelFinalText(extracted.text);
    const finalText = artifactRequested && !artifacts.length
      ? `${safeProviderText}\n\nArtifact delivery failed: the provider did not declare a verifiable file path for this run.`
      : safeProviderText;
    // finalize() is the only emitter of the final event (OpenClaw #33492).
    streamRun?.finalize(finalText);
    if (options.enterprise) {
      await recordGatewayUsage(options.enterprise, {
        message,
        paired,
        assignment,
        outcome: "success",
        latencyMs: outcome.timings?.totalMs ?? Date.now() - startedAt,
        tokens: outcome.tokens,
        requestCategory: classifyGatewayRequest(message.text),
        action: "gateway.run",
        agentId: profile,
        policyIds: preflight.policyIds,
      });
    }
    return {
      text: finalText,
      ...(artifacts.length
        ? { artifacts }
        : {}),
    };
  } catch (error) {
    if (options.enterprise) {
      await recordGatewayUsage(options.enterprise, {
        message,
        paired,
        assignment,
        outcome: "error",
        latencyMs: Date.now() - startedAt,
        inputTokens: estimateTokens(message.text),
        requestCategory: classifyGatewayRequest(message.text),
        action: "gateway.run",
        agentId: profile,
        policyIds: preflight.policyIds,
      });
    }
    throw error;
  } finally {
    channel?.close();
    if (draftLoop) await draftLoop;
  }
}

function pendingFrappeInteractionKey(
  message: Pick<SurfaceMessage, "surfaceId" | "conversationId" | "senderId">,
  site: string,
  principal: string,
): string {
  return createHash("sha256")
    .update(site).update("\0")
    .update(principal).update("\0")
    .update(message.surfaceId).update("\0")
    .update(message.conversationId).update("\0")
    .update(message.senderId)
    .digest("hex");
}

function continuePendingFrappeInteraction(
  pending: PendingFrappeInteraction,
  response: string,
): {
  readonly prompt: string;
  readonly continuation: {
    readonly doctype: string;
    readonly operation: PendingFrappeInteraction["operation"];
    readonly values: Readonly<Record<string, unknown>>;
  };
} | undefined {
  if (pending.phase !== "collecting") return undefined;
  const field = pending.requiredFields[0];
  const value = response.trim();
  if (!field || !value || value.length > 4_000) return undefined;
  return {
    prompt: `${pending.operation} ${pending.doctype}`,
    continuation: {
      doctype: pending.doctype,
      operation: pending.operation,
      values: { ...pending.values, [field.fieldname]: value },
    },
  };
}

function isIndependentFrappeRequest(response: string, pending: PendingFrappeInteraction): boolean {
  if (pending.phase !== "collecting") return false;
  const value = response.trim();
  if (!value) return false;
  const expected = pending.requiredFields[0];
  if (expected?.options?.some((option) => option.localeCompare(value, undefined, { sensitivity: "accent" }) === 0)) return false;
  if (/[?]$/.test(value)) return true;
  return /^(?:how|what|when|where|who|which|show|list|check|tell|is|are|was|were|do|does|did|can|could|would|create|open|raise|apply|submit|approve|reject|cancel)\b/i.test(value);
}

async function readBody(request: IncomingMessage, limitBytes = 1_000_000): Promise<string> {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > limitBytes) throw new GatewayHttpError(413, "Request body too large.");
  }
  return body;
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

function sendOAuthPage(response: ServerResponse, status: number, title: string, message: string): void {
  const escape = (value: string): string => value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
  const body = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><style>body{margin:0;background:#081311;color:#e8fffb;font:16px/1.55 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh}.panel{max-width:560px;padding:32px;border:1px solid #3fc7b5;background:#0d1d1a}h1{margin:0 0 12px;color:#6ee7d5;font-size:26px}p{margin:0;color:#c8d8d5}</style></head><body><main class="panel"><h1>${escape(title)}</h1><p>${escape(message)}</p></main></body></html>`;
  response.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(body) });
  response.end(body);
}

function bearerTokenMatches(request: IncomingMessage, expected: string): boolean {
  const header = request.headers.authorization ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  return headerEquals(presented, expected);
}

function singleRequestHeader(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return (Array.isArray(value) ? value[0] : value)?.trim() || undefined;
}

function parseJsonRecord(body: string, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new GatewayHttpError(400, `${label} must be valid JSON.`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new GatewayHttpError(400, `${label} must be a JSON object.`);
  return value as Record<string, unknown>;
}

function frappeRunEventHttpStatus(error: FrappeRunEventError): number {
  switch (error.code) {
    case "forbidden": return 403;
    case "conflict": return 409;
    case "cursor_expired": return 410;
    case "permission_filter_failed": return 503;
    default: return 400;
  }
}

function frappeRunScopeFromUnknown(value: unknown): FrappeRunEventScope {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new GatewayHttpError(400, "Frappe run event scope must be an object.");
  return validateFrappeRunEventScope(value as FrappeRunEventScope);
}

function authenticatedFrappeRunScope(
  request: IncomingMessage,
  secret: string,
): { readonly scope: FrappeRunEventScope; readonly csrfToken: string } {
  const tenantId = singleRequestHeader(request, "x-frappe-tenant-id");
  const userId = singleRequestHeader(request, "x-frappe-user-id");
  if (!tenantId || !userId) throw new FrappeRunEventError("forbidden", "Frappe run authority headers are required.");
  const siteId = singleRequestHeader(request, "x-frappe-site-id");
  const scope = validateFrappeRunEventScope({
    tenantId,
    ...(siteId ? { siteId } : {}),
    userId,
  });
  const csrfToken = singleRequestHeader(request, "x-frappe-csrf-token");
  const csrfProof = singleRequestHeader(request, "x-muster-csrf-proof");
  if (!csrfToken || !frappeRunCsrfProofMatches(csrfProof, secret, csrfToken, scope)) {
    throw new FrappeRunEventError("forbidden", "Frappe run authority proof is invalid.");
  }
  return Object.freeze({ scope, csrfToken });
}

function trustedFrappeBindingRoute(pathname: string): boolean {
  return pathname === TRUSTED_FRAPPE_CATALOG_PATH
    || pathname === FRAPPE_TELEGRAM_LINK_PATH
    || pathname === TRUSTED_FRAPPE_ASYNC_PATH
    || pathname.startsWith(`${TRUSTED_FRAPPE_ASYNC_RUNS_PATH}/`)
    || pathname === TRUSTED_FRAPPE_WORKFLOW_PROPOSALS_PATH
    || pathname === TRUSTED_FRAPPE_READ_PLANS_PATH
    || pathname === TRUSTED_FRAPPE_ASK_INTENTS_PATH
    || pathname === TRUSTED_FRAPPE_MISSIONS_PATH
    || pathname.startsWith(`${TRUSTED_FRAPPE_MISSIONS_PATH}/`)
    || pathname === FRAPPE_RUN_EVENTS_PATH
    || pathname.startsWith(`${FRAPPE_RUN_EVENTS_PATH}/`);
}

function frappeAsyncAuthorityScope(scope: FrappeRunEventScope): string {
  return createHash("sha256").update(JSON.stringify([
    scope.tenantId,
    scope.siteId ?? "",
    scope.userId.trim().toLowerCase(),
  ])).digest("hex");
}

function assertSiteBindingScope(binding: FrappeSiteBindingRecord | undefined, scope: FrappeRunEventScope): void {
  if (!binding) return;
  if (scope.tenantId !== binding.tenantId || scope.siteId !== binding.siteUuid) {
    throw new FrappeRunEventError("forbidden", "Frappe run authority does not match the authenticated site binding.");
  }
}

/** Constant-time string compare for header secrets (returns false on undefined/length mismatch). */
function headerEquals(presented: string | undefined, expected: string): boolean {
  const left = Buffer.from(presented ?? "");
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

interface AdapterContext {
  readonly config: MusterConfig;
  readonly gateway: GatewayConfig;
  readonly cwd: string;
  readonly fetcher: typeof fetch;
  readonly log: (line: string) => void;
  /** Inbound request headers (lowercased), for adapters that verify signatures. */
  readonly headers: Record<string, string | string[] | undefined>;
  /** Shared per-chat outbound queue (retry_after backoff) for draft streaming. */
  readonly queue: OutboundQueue;
  readonly registry?: FlowToolRegistry;
  readonly gchatVerifier?: GchatRequestVerifier;
  readonly enterprise?: GatewayEnterpriseRuntime;
  readonly approvalActions?: ApprovalActionCodec;
  readonly approvalStore?: SqliteApprovalActionStore;
  readonly frappeOAuth?: FrappeOAuthCoordinator;
  readonly frappeTelegramLinks?: FrappeTelegramLinkCoordinator;
  /** The HTTP route already verified the platform signature against the raw body. */
  readonly platformVerified?: boolean;
  /** Durable execution/delivery checkpoints for adapters acknowledged before work completes. */
  readonly durableDelivery?: DurableAdapterDeliveryHooks;
}

interface DurableAdapterDeliveryHooks {
  checkpoint(preparedDeliveries: readonly GatewayPreparedDelivery[]): Promise<void>;
  begin(): Promise<void>;
  delivered(): Promise<void>;
}

function approvalRenderContext(
  reply: SurfaceReply | PairingChallenge,
  message: SurfaceMessage | undefined,
  context: AdapterContext,
): ApprovalActionRenderContext | undefined {
  if (!message || isPairingChallenge(reply) || !reply.approvalRequest || !context.approvalActions) return undefined;
  const ttlSeconds = Math.min(3600, Math.max(60, context.gateway.approvals?.ttlSeconds ?? 600));
  return {
    codec: context.approvalActions,
    actorId: message.senderId,
    surfaceId: message.surfaceId,
    conversationId: message.conversationId,
    runId: reply.approvalRequest.runId,
    gateId: reply.approvalRequest.gateId,
    revision: approvalRevision(reply.approvalRequest.runId, reply.approvalRequest.gateId, reply.approvalRequest.show),
    expiresAt: Date.now() + ttlSeconds * 1000,
  };
}

function conversationLane(message: Pick<SurfaceMessage, "surfaceId" | "conversationId" | "senderId">): string {
  return conversationSessionId(message);
}

async function withConversationLane<T>(
  message: SurfaceMessage,
  context: AdapterContext,
  busyMode: "queue" | "reject",
  task: () => Promise<T>,
): Promise<T | SurfaceReply> {
  const key = conversationLane(message);
  const active = activeConversationRuns.get(key);
  if (active && busyMode === "reject") {
    return {
      text: "I’m still working on the previous request in this chat. Send /status to check the connection, or wait for the current run to finish before sending the next instruction.",
    };
  }
  const run = (async () => {
    if (active && busyMode === "queue") await active.catch(() => undefined);
    return task();
  })();
  activeConversationRuns.set(key, run);
  const clearLane = () => {
    if (activeConversationRuns.get(key) === run) activeConversationRuns.delete(key);
  };
  void run.then(clearLane, clearLane);
  try {
    return await run;
  } catch (error) {
    context.log(`channel run failed for ${key}: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

export interface TelegramTypingHandle {
  pulse(): void;
  stop(): void;
}

function noopTelegramTyping(): TelegramTypingHandle {
  return { pulse: () => undefined, stop: () => undefined };
}

export function startTelegramTyping(options: {
  readonly botToken: string;
  readonly chatId: string;
  readonly fetcher: typeof fetch;
  readonly log: (line: string) => void;
  readonly apiBase?: string;
}): TelegramTypingHandle {
  let stopped = false;
  let inFlight = false;
  let pending = false;
  const apiBase = options.apiBase ?? "https://api.telegram.org";
  const tick = (): void => {
    if (stopped) return;
    if (inFlight) {
      pending = true;
      return;
    }
    inFlight = true;
    pending = false;
    void options.fetcher(`${apiBase}/bot${options.botToken}/sendChatAction`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: options.chatId, action: "typing" }),
    }).then((response) => {
      if (!response.ok) options.log(`telegram sendChatAction failed: HTTP ${response.status}`);
    }).catch((error) => options.log(`telegram sendChatAction failed: ${error instanceof Error ? error.message : String(error)}`)).finally(() => {
      inFlight = false;
      if (pending && !stopped) tick();
    });
  };
  tick();
  const timer = setInterval(tick, 2000);
  return {
    pulse: tick,
    stop: () => {
      stopped = true;
      pending = false;
      clearInterval(timer);
    },
  };
}

async function sendTelegramPayload(botToken: string, payload: unknown, context: AdapterContext, method = "sendMessage"): Promise<unknown> {
  const response = await context.fetcher(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok && body.ok === undefined) body.ok = false;
  if (!response.ok || body.ok === false) context.log(`telegram ${method} failed: HTTP ${response.status}${typeof body.description === "string" ? ` ${body.description}` : ""}`);
  return body;
}

function isHttpArtifact(ref: string): boolean {
  return /^https?:\/\//i.test(ref);
}

function artifactCaption(artifact: SurfaceArtifact): string {
  return artifact.name || basename(artifact.path);
}

function telegramPollOffsetPath(cwd: string): string {
  return join(cwd, ".muster", TELEGRAM_POLL_OFFSET_FILE);
}

async function loadTelegramPollOffset(cwd: string): Promise<number> {
  try {
    const parsed = JSON.parse(await readFile(telegramPollOffsetPath(cwd), "utf8")) as { nextOffset?: unknown };
    return typeof parsed.nextOffset === "number" && Number.isFinite(parsed.nextOffset) && parsed.nextOffset > 0
      ? Math.floor(parsed.nextOffset)
      : 0;
  } catch {
    return 0;
  }
}

async function saveTelegramPollOffset(cwd: string, nextOffset: number): Promise<void> {
  if (!Number.isFinite(nextOffset) || nextOffset <= 0) return;
  await mkdir(join(cwd, ".muster"), { recursive: true, mode: 0o700 });
  await writeFile(telegramPollOffsetPath(cwd), `${JSON.stringify({ nextOffset: Math.floor(nextOffset), updatedAt: new Date().toISOString() }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

async function sendTelegramArtifact(botToken: string, artifact: SurfaceArtifact, chatId: string, context: AdapterContext): Promise<void> {
  if (isHttpArtifact(artifact.path)) {
    await sendTelegramPayload(botToken, { chat_id: chatId, text: `Artifact: ${artifactCaption(artifact)}\n${artifact.path}` }, context);
    return;
  }
  try {
    const bytes = await readFile(artifact.path);
    const form = new FormData();
    form.set("chat_id", chatId);
    form.set("caption", artifactCaption(artifact));
    form.set("document", new Blob([bytes], { type: artifact.mime || "application/octet-stream" }), artifactCaption(artifact));
    const response = await context.fetcher(`https://api.telegram.org/bot${botToken}/sendDocument`, { method: "POST", body: form });
    const body = await response.json().catch(() => ({})) as { ok?: boolean; description?: string; result?: { message_id?: number } };
    if (!response.ok || body.ok !== true || typeof body.result?.message_id !== "number") {
      throw new Error(`HTTP ${response.status}${body.description ? ` ${body.description}` : ""}; Telegram did not return an accepted message id`);
    }
    await markChannelArtifactDelivery(artifact, {
      state: "uploaded",
      channel: "telegram",
      target: chatId,
      providerMessageId: String(body.result.message_id),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    context.log(`telegram artifact delivery failed for ${artifact.path}: ${detail}`);
    await markChannelArtifactDelivery(artifact, { state: "failed", channel: "telegram", target: chatId, reason: detail })
      .catch((receiptError) => context.log(`telegram artifact receipt failed: ${receiptError instanceof Error ? receiptError.message : String(receiptError)}`));
    await sendTelegramPayload(botToken, {
      chat_id: chatId,
      text: `I created ${artifactCaption(artifact)}, but this gateway could not attach it. Check the artifact delivery receipt and retry.`,
    }, context);
  }
}

async function deliverTelegramReply(botToken: string, reply: SurfaceReply | PairingChallenge, chatId: string, context: AdapterContext, source?: SurfaceMessage): Promise<void> {
  const delivered = await sendTelegramPayload(botToken, surfaceReplyToTelegramSend(reply, chatId, { approvalAction: approvalRenderContext(reply, source, context) }), context);
  if (!channelApiSucceeded(delivered)) throw new DefinitivePlatformDeliveryError("Telegram did not acknowledge the final reply.");
  if (!isPairingChallenge(reply)) {
    for (const artifact of reply.artifacts ?? []) await sendTelegramArtifact(botToken, artifact, chatId, context);
  }
}

async function deliverTelegramArtifactsOnly(botToken: string, reply: SurfaceReply, chatId: string, context: AdapterContext): Promise<void> {
  for (const artifact of reply.artifacts ?? []) await sendTelegramArtifact(botToken, artifact, chatId, context);
}

interface ChannelProgressHandle {
  /** Provider-exposed reasoning summary delta. Hidden reasoning is never forwarded. */
  update(delta: string): void;
  /** Replace the placeholder with a truthful host lifecycle milestone. */
  set(status: string): void;
  stop(
    finalText?: string,
    finalOptions?: Pick<TelegramSendMessagePayload, "parse_mode" | "reply_markup">,
  ): Promise<"updated" | "none">;
}

function noopProgress(): ChannelProgressHandle {
  return { update: () => undefined, set: () => undefined, stop: async () => "none" };
}

function channelApiSucceeded(result: unknown): boolean {
  return typeof result === "object" && result !== null && (result as { ok?: unknown }).ok === true;
}

async function startTelegramProgress(
  botToken: string,
  message: SurfaceMessage,
  context: AdapterContext,
  onRendered: () => void = () => undefined,
): Promise<ChannelProgressHandle> {
  if (context.gateway.telegram?.thinking !== "progress") return noopProgress();
  let providerSummary = "";
  let statusSummary = "";
  let writeChain = Promise.resolve();
  let lastRendered = channelProgressText(providerSummary);
  const response = await sendTelegramPayload(botToken, {
    chat_id: message.conversationId,
    text: channelProgressText(providerSummary),
  }, context);
  const messageId = typeof response === "object" && response
    ? (response as { result?: { message_id?: unknown } }).result?.message_id
    : undefined;
  if (typeof messageId !== "number") return noopProgress();
  let stopped = false;
  const queueUpdate = (): void => {
    if (stopped) return;
    const text = channelProgressText(providerSummary || statusSummary);
    if (text === lastRendered) return;
    lastRendered = text;
    writeChain = writeChain.then(async () => {
      if (stopped) return;
      await sendTelegramPayload(botToken, {
        chat_id: message.conversationId,
        message_id: messageId,
        text,
      }, context, "editMessageText");
      onRendered();
    });
  };
  return {
    update: (delta) => {
      if (stopped || !delta) return;
      providerSummary = `${providerSummary}${delta}`.slice(-4_800);
      queueUpdate();
    },
    set: (status) => {
      if (stopped || providerSummary || !status.trim()) return;
      statusSummary = status.trim();
      queueUpdate();
    },
    stop: async (finalText?: string, finalOptions = {}) => {
      stopped = true;
      await writeChain;
      if (finalText) {
        const result = await sendTelegramPayload(botToken, {
          chat_id: message.conversationId,
          message_id: messageId,
          text: finalText,
          ...finalOptions,
        }, context, "editMessageText");
        return channelApiSucceeded(result) ? "updated" : "none";
      }
      return "none";
    },
  };
}

async function sendSlackPayload(botToken: string, payload: unknown, context: AdapterContext, method = "chat.postMessage"): Promise<unknown> {
  const response = await context.fetcher(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${botToken}` },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({})) as { ok?: boolean; error?: string };
  if (!response.ok && body.ok === undefined) body.ok = false;
  if (!response.ok || body.ok === false) context.log(`slack ${method} failed: HTTP ${response.status}${body.error ? ` ${body.error}` : ""}`);
  return body;
}

async function sendSlackFormPayload(botToken: string, fields: Record<string, string>, context: AdapterContext, method: string): Promise<Record<string, unknown>> {
  const response = await context.fetcher(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Bearer ${botToken}`,
    },
    body: new URLSearchParams(fields).toString(),
  });
  const body = await response.json().catch(() => ({})) as Record<string, unknown> & { ok?: boolean; error?: string };
  if (!response.ok || body.ok === false) context.log(`slack ${method} failed: HTTP ${response.status}${body.error ? ` ${body.error}` : ""}`);
  return body;
}

function slackUploadFailureMessage(error: string | undefined, artifact: SurfaceArtifact): string {
  if (error === "missing_scope") {
    return `Slack could not attach ${artifactCaption(artifact)} because the Muster Slack app is missing the files:write scope. Add files:write, reinstall the Slack app, then retry.`;
  }
  return `Slack could not attach ${artifactCaption(artifact)}${error ? ` (${error})` : ""}.`;
}

async function uploadSlackArtifact(botToken: string, artifact: SurfaceArtifact, channel: string, threadTs: string | undefined, context: AdapterContext): Promise<{ ok: true } | { ok: false; detail: string }> {
  if (isHttpArtifact(artifact.path)) return { ok: false, detail: `• ${artifactCaption(artifact)}: ${artifact.path}` };
  const failed = async (detail: string): Promise<{ ok: false; detail: string }> => {
    await markChannelArtifactDelivery(artifact, { state: "failed", channel: "slack", target: channel, reason: detail })
      .catch((error) => context.log(`slack artifact receipt failed: ${error instanceof Error ? error.message : String(error)}`));
    return { ok: false, detail };
  };
  let bytes: Buffer;
  try {
    bytes = await readFile(artifact.path);
  } catch (error) {
    return failed(`• ${artifactCaption(artifact)} could not be read from its scoped artifact workspace: ${error instanceof Error ? error.message : String(error)}`);
  }
  const filename = artifactCaption(artifact);
  const uploadUrlResponse = await sendSlackFormPayload(botToken, {
    filename,
    length: String(bytes.byteLength),
  }, context, "files.getUploadURLExternal");
  if (uploadUrlResponse.ok === false || typeof uploadUrlResponse.upload_url !== "string" || typeof uploadUrlResponse.file_id !== "string") {
    return failed(slackUploadFailureMessage(typeof uploadUrlResponse.error === "string" ? uploadUrlResponse.error : undefined, artifact));
  }
  const uploadBody = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const uploadResponse = await context.fetcher(uploadUrlResponse.upload_url, {
    method: "POST",
    headers: { "content-type": artifact.mime || "application/octet-stream" },
    body: uploadBody,
  });
  if (!uploadResponse.ok) {
    return failed(`Slack upload failed for ${filename}: HTTP ${uploadResponse.status}.`);
  }
  const completeResponse = await sendSlackFormPayload(botToken, {
    channel_id: channel,
    initial_comment: `Artifact from this run: ${filename}`,
    ...(threadTs ? { thread_ts: threadTs } : {}),
    files: JSON.stringify([{ id: uploadUrlResponse.file_id, title: filename }]),
  }, context, "files.completeUploadExternal");
  if (completeResponse.ok !== true) {
    return failed(slackUploadFailureMessage(typeof completeResponse.error === "string" ? completeResponse.error : undefined, artifact));
  }
  try {
    await markChannelArtifactDelivery(artifact, {
      state: "uploaded",
      channel: "slack",
      target: channel,
      providerMessageId: uploadUrlResponse.file_id,
    });
  } catch (error) {
    context.log(`Slack uploaded ${filename}, but its delivery receipt could not be persisted: ${error instanceof Error ? error.message : String(error)}`);
    return { ok: true };
  }
  return { ok: true };
}

async function deliverSlackArtifacts(botToken: string, reply: SurfaceReply, channel: string, threadTs: string | undefined, context: AdapterContext): Promise<void> {
  const artifacts = reply.artifacts ?? [];
  if (!artifacts.length) return;
  const failures: string[] = [];
  for (const artifact of artifacts) {
    const result = await uploadSlackArtifact(botToken, artifact, channel, threadTs, context);
    if (!result.ok) failures.push(result.detail);
  }
  if (!failures.length) return;
  await sendSlackPayload(botToken, {
    channel,
    thread_ts: threadTs,
    text: [
      "Some artifacts could not be attached directly:",
      ...failures,
      "",
      "If this is a Slack scope issue, add files:write to the app, reinstall it in the workspace, and retry.",
    ].join("\n"),
  }, context);
}

async function deliverSlackReply(botToken: string, reply: SurfaceReply | PairingChallenge, channel: string, threadTs: string | undefined, context: AdapterContext, source?: SurfaceMessage): Promise<void> {
  const delivered = await sendSlackPayload(botToken, surfaceReplyToSlackPost(reply, channel, threadTs, { approvalAction: approvalRenderContext(reply, source, context) }), context);
  if (!channelApiSucceeded(delivered)) throw new DefinitivePlatformDeliveryError("Slack did not acknowledge the final reply.");
  if (!isPairingChallenge(reply)) await deliverSlackArtifacts(botToken, reply, channel, threadTs, context);
}

async function startSlackProgress(botToken: string, message: SurfaceMessage, context: AdapterContext): Promise<ChannelProgressHandle> {
  if (context.gateway.slack?.status !== "message" && context.gateway.slack?.thinking !== "progress") return noopProgress();
  let providerSummary = "";
  let statusSummary = "";
  let writeChain = Promise.resolve();
  const text = "Working";
  let lastRendered = text;
  const response = await sendSlackPayload(botToken, {
    channel: message.conversationId,
    thread_ts: message.replyTo,
    text,
  }, context);
  const ts = typeof response === "object" && response ? (response as { ts?: unknown }).ts : undefined;
  if (typeof ts !== "string") return noopProgress();
  let stopped = false;
  const queueUpdate = (): void => {
    if (stopped) return;
    const text = channelProgressText(providerSummary || statusSummary);
    if (text === lastRendered) return;
    lastRendered = text;
    writeChain = writeChain.then(async () => {
      if (stopped) return;
      await sendSlackPayload(botToken, {
        channel: message.conversationId,
        ts,
        text,
      }, context, "chat.update");
    });
  };
  return {
    update: (delta) => {
      if (stopped || !delta || context.gateway.slack?.thinking !== "progress") return;
      providerSummary = `${providerSummary}${delta}`.slice(-4_800);
      queueUpdate();
    },
    set: (status) => {
      if (stopped || providerSummary || !status.trim()) return;
      statusSummary = status.trim();
      queueUpdate();
    },
    stop: async (finalText?: string) => {
      stopped = true;
      await writeChain;
      if (finalText) {
        const result = await sendSlackPayload(botToken, {
          channel: message.conversationId,
          ts,
          text: finalText,
        }, context, "chat.update");
        return channelApiSucceeded(result) ? "updated" : "none";
      }
      return "none";
    },
  };
}

/**
 * Telegram webhook: update JSON in, sendMessage out. The adapter module is a
 * pure mapper; only this thin handler touches the network. Processing is
 * synchronous (reply is sent before the webhook is acked) — Telegram retries
 * on timeout, which is acceptable for slice 1. When telegram.secretToken is
 * configured, the X-Telegram-Bot-Api-Secret-Token header must match it
 * (constant-time) or the webhook is rejected with 401; otherwise we warn once
 * that the Telegram webhook is unauthenticated.
 */
async function frappeTelegramOnboardingReply(
  message: SurfaceMessage,
  update: unknown,
  context: AdapterContext,
): Promise<SurfaceReply | undefined> {
  const config = context.gateway.frappe?.telegramLinking;
  if (!config?.enabled) return undefined;
  const coordinator = context.frappeTelegramLinks;
  const botId = telegramBotId(context.gateway.telegram?.botToken);
  if (!coordinator || !botId) {
    return { text: "Frappe Telegram linking is unavailable. Ask an administrator to verify the Muster gateway configuration." };
  }
  const updateId = telegramUpdateId(update);
  if (updateId === undefined || !coordinator.claimTelegramUpdate(botId, updateId)) {
    return { text: "This Telegram update cannot be used for identity linking. Start a new link from Frappe." };
  }

  const paired = await resolvePairing(message.surfaceId, message.senderId, context.cwd);
  const identity = paired?.identity?.provider === "frappe" ? paired.identity : undefined;
  const channelLink = identity?.telegramLink;
  if (identity && channelLink && identity.permissionHash) {
    const registeredTenant = config.tenants.find((tenant) => tenant.id === channelLink.tenantId
      && normalizedHttpsOrigin(tenant.site) === normalizedHttpsOrigin(identity.site));
    const currentBindingValid = channelLink.botId === botId
      && Boolean(registeredTenant)
      && channelLink.scopes.every((scope) => registeredTenant!.allowedScopes.includes(scope));
    if (!currentBindingValid) {
      await clearTrustedFrappePairingIdentity(message.surfaceId, message.senderId, context.cwd);
      return { text: "Your Frappe Telegram link is no longer active. Open Muster in Frappe and create a new Telegram link." };
    }
    const active = coordinator.resolveActive(channelLink.linkId, {
      site: identity.site,
      user: identity.user,
      tenantId: channelLink.tenantId,
      botId: channelLink.botId,
      scopes: channelLink.scopes,
      permissionEpoch: identity.permissionHash,
    });
    if (active.ok && active.value.telegramUserId === message.senderId && active.value.telegramChatId === message.conversationId) return undefined;
    await clearTrustedFrappePairingIdentity(message.surfaceId, message.senderId, context.cwd);
    return { text: "Your Frappe Telegram link is no longer active. Open Muster in Frappe and create a new Telegram link." };
  }

  const token = telegramStartToken(message.text);
  if (!token) {
    return { text: "Connect this chat from Muster inside Frappe. Operator pairing is disabled for this trusted Frappe Telegram bot." };
  }
  const chatType = telegramChatType(update);
  if (!chatType) return { text: "This Telegram identity link is unavailable. Start a new link from Frappe." };
  const redeemed = coordinator.redeemFromTelegram({
    token,
    botId,
    telegramUserId: message.senderId,
    telegramChatId: message.conversationId,
    chatType,
  });
  return redeemed.ok
    ? { text: "Telegram identity observed. Return to Muster in Frappe, verify this Telegram account, and confirm the link." }
    : { text: redeemed.message };
}

function telegramBotId(botToken: string | undefined): string | undefined {
  const id = botToken?.split(":", 1)[0];
  return id && /^[1-9][0-9]{0,18}$/.test(id) ? id : undefined;
}

function telegramStartToken(text: string): string | undefined {
  const match = text.trim().match(/^\/start(?:@[A-Za-z0-9_]{5,32})?\s+([A-Za-z0-9_-]{43})$/);
  return match?.[1];
}

function telegramUpdateId(update: unknown): string | undefined {
  if (!update || typeof update !== "object") return undefined;
  const value = (update as { update_id?: unknown }).update_id;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? String(value) : undefined;
}

function telegramChatType(update: unknown): TelegramChatType | undefined {
  if (!update || typeof update !== "object") return undefined;
  const typed = update as {
    message?: { chat?: { type?: unknown } };
    callback_query?: { message?: { chat?: { type?: unknown } } };
  };
  const value = typed.message?.chat?.type ?? typed.callback_query?.message?.chat?.type;
  return value === "private" || value === "group" || value === "supergroup" || value === "channel" ? value : undefined;
}

async function handleTelegramWebhook(body: string, context: AdapterContext): Promise<unknown> {
  const botToken = context.gateway.telegram?.botToken;
  if (!botToken) throw new Error("Telegram adapter not configured. Add telegram.botToken to .muster/gateway.json.");
  const secretToken = context.gateway.telegram?.secretToken;
  if (secretToken && !context.platformVerified) {
    await verifyWithChannelSdk(telegramChannel, body, context.headers, context.gateway);
  } else if (!secretToken && !context.platformVerified) {
    warnUnauthenticatedOnce("telegram", context.log);
  }
  const payload = JSON.parse(body);
  const callbackQueryId = telegramCallbackQueryId(payload);
  if (callbackQueryId) await sendTelegramPayload(botToken, { callback_query_id: callbackQueryId }, context, "answerCallbackQuery");
  const deliveryKey = adapterDeliveryKey("telegram", body);
  const cached = deliveryLookup(deliveryKey);
  if (cached !== undefined) return cached;
  let mapped = telegramUpdateToSurfaceMessage(payload, { approvalActions: context.approvalActions });
  if (!mapped) return { ok: true, ignored: "not a text message update" };
  const onboardingReply = await frappeTelegramOnboardingReply(mapped, payload, context);
  if (onboardingReply) {
    if (context.durableDelivery) {
      await context.durableDelivery.checkpoint([{ message: mapped, reply: onboardingReply }]);
      await context.durableDelivery.begin();
    }
    await deliverTelegramReply(botToken, onboardingReply, mapped.conversationId, context, mapped);
    if (context.durableDelivery) await context.durableDelivery.delivered();
    const result = { ok: true, onboarding: true };
    deliveryStore(deliveryKey, result);
    return result;
  }
  // Shared voice path: audio becomes the prompt, or the user hears why not.
  const telegramChannelContext = {
    gateway: context.gateway,
    cwd: context.cwd,
    fetcher: context.fetcher,
    log: context.log,
    env: process.env,
  };
  const voiceStep = await prepareVoiceInbound(mapped, {
    config: context.config,
    cwd: context.cwd,
    log: context.log,
    download: (attachment) => telegramChannel.downloadAttachment!(attachment, telegramChannelContext),
  });
  if (voiceStep.kind === "refuse") {
    const refusal: SurfaceReply = { text: voiceStep.text };
    if (context.durableDelivery) {
      // Durable checkpoints need a non-empty text; a caption-less voice note has none.
      await context.durableDelivery.checkpoint([{ message: { ...mapped, text: mapped.text.trim() || "[voice note]" }, reply: refusal }]);
      await context.durableDelivery.begin();
    }
    await deliverTelegramReply(botToken, refusal, mapped.conversationId, context, mapped);
    if (context.durableDelivery) await context.durableDelivery.delivered();
    const result = { ok: true, voice: "refused" };
    deliveryStore(deliveryKey, result);
    return result;
  }
  mapped = voiceStep.message;
  const speakTelegramReply = async (source: SurfaceMessage, reply: SurfaceReply | PairingChallenge) => {
    await deliverSpokenReply({
      config: context.config,
      cwd: context.cwd,
      message: source,
      reply,
      log: context.log,
      send: (audio) => telegramChannel.sendVoice!({ conversationId: source.conversationId }, audio, telegramChannelContext),
    });
  };
  if (context.gateway.telegram?.stream === "draft") {
    const message: SurfaceMessage = { ...mapped, stream: "draft" };
    // A streamed reply cannot be prefixed, so the echo of what was heard goes first.
    if (message.voice) await sendTelegramPayload(botToken, { chat_id: message.conversationId, text: voiceEchoLine(message.voice.transcript) }, context);
    const channelSink = createTelegramDraftSink({
      botToken,
      chatId: message.conversationId,
      fetcher: context.fetcher,
      queue: context.queue,
    });
    let durableDraftDelivered = false;
    const sink: DraftSink = context.durableDelivery ? {
      ...channelSink,
      finalize: async (text) => {
        await context.durableDelivery?.checkpoint([{ message, reply: { text } }]);
        await context.durableDelivery?.begin();
        await channelSink.finalize(text);
        await context.durableDelivery?.delivered();
        durableDraftDelivered = true;
      },
    } : channelSink;
    let typing = noopTelegramTyping();
    let reply: SurfaceReply | PairingChallenge;
    let progress = noopProgress();
    try {
      progress = await startTelegramProgress(botToken, message, context, () => typing.pulse());
      // Telegram clears chat actions when the bot sends a message. Start the
      // keepalive after the progress placeholder so the native header remains
      // visibly active throughout the provider run.
      typing = context.gateway.telegram?.status !== "off"
        ? startTelegramTyping({ botToken, chatId: message.conversationId, fetcher: context.fetcher, log: context.log })
        : noopTelegramTyping();
      reply = await withConversationLane(message, context, context.gateway.telegram?.busy ?? "queue", () => handleSurfaceMessage(message, {
        ...context,
        sink,
        onReasoningDelta: (delta) => progress.update(delta),
        onStatus: (status) => progress.set(status),
      }));
      await progress.stop(isPairingChallenge(reply) ? undefined : "✓ Done");
    } catch (error) {
      try {
        await progress.stop("! Failed");
      } finally {
        typing.stop();
      }
      throw error;
    }
    try {
      // A streamed reply was already delivered draft-by-draft by the sink;
      // pairing challenges fall through to the normal buffered send below.
      if (!isPairingChallenge(reply) && durableDraftDelivered) {
        for (const artifact of reply.artifacts ?? []) await sendTelegramArtifact(botToken, artifact, message.conversationId, context);
        await speakTelegramReply(message, reply);
        const result = { ok: true, streamed: true };
        deliveryStore(deliveryKey, result);
        return result;
      }
      if (context.durableDelivery && !durableDraftDelivered) {
        await context.durableDelivery.checkpoint([{ message, reply }]);
        await context.durableDelivery.begin();
      }
      await deliverTelegramReply(botToken, reply, message.conversationId, context, message);
      if (context.durableDelivery && !durableDraftDelivered) await context.durableDelivery.delivered();
      await speakTelegramReply(message, reply);
      const result = { ok: true };
      deliveryStore(deliveryKey, result);
      return result;
    } finally {
      typing.stop();
    }
  }
  const message = mapped;
  let typing = noopTelegramTyping();
  let reply: SurfaceReply | PairingChallenge;
  let progress = noopProgress();
  let progressFinal: "updated" | "none" = "none";
  let durableDeliveryBegan = false;
  try {
    progress = await startTelegramProgress(botToken, message, context, () => typing.pulse());
    typing = context.gateway.telegram?.status !== "off"
      ? startTelegramTyping({ botToken, chatId: message.conversationId, fetcher: context.fetcher, log: context.log })
      : noopTelegramTyping();
    reply = await withConversationLane(message, context, context.gateway.telegram?.busy ?? "queue", () => handleSurfaceMessage(message, {
      ...context,
      onReasoningDelta: (delta) => progress.update(delta),
      onStatus: (status) => progress.set(status),
    }));
    reply = withVoiceEcho(reply, message);
    if (context.durableDelivery) await context.durableDelivery.checkpoint([{ message, reply }]);
    if (context.durableDelivery && !isPairingChallenge(reply) && !reply.approvalRequest) {
      await context.durableDelivery.begin();
      durableDeliveryBegan = true;
    }
    if (!isPairingChallenge(reply) && !reply.approvalRequest) {
      const finalPayload = surfaceReplyToTelegramSend(reply, message.conversationId, {
        approvalAction: approvalRenderContext(reply, message, context),
      });
      progressFinal = await progress.stop(finalPayload.text, {
        ...(finalPayload.parse_mode ? { parse_mode: finalPayload.parse_mode } : {}),
        ...(finalPayload.reply_markup ? { reply_markup: finalPayload.reply_markup } : {}),
      });
    }
  } catch (error) {
    try {
      await progress.stop("! Failed");
    } finally {
      typing.stop();
    }
    throw error;
  }
  try {
    if (context.durableDelivery && !durableDeliveryBegan) await context.durableDelivery.begin();
    if (isPairingChallenge(reply) || reply.approvalRequest || progressFinal !== "updated") {
      await deliverTelegramReply(botToken, reply, message.conversationId, context, message);
    } else {
      await deliverTelegramArtifactsOnly(botToken, reply, message.conversationId, context);
    }
    if (context.durableDelivery) await context.durableDelivery.delivered();
    await speakTelegramReply(message, reply);
    const result = { ok: true };
    deliveryStore(deliveryKey, result);
    return result;
  } finally {
    typing.stop();
  }
}

export interface TelegramPollOptions {
  readonly config: MusterConfig;
  readonly gateway: GatewayConfig;
  readonly cwd?: string;
  readonly fetcher?: typeof fetch;
  /** Shared Frappe OAuth coordinator used by the HTTP callback and channel worker. */
  readonly frappeOAuth?: FrappeOAuthCoordinator;
  readonly frappeTelegramLinks?: FrappeTelegramLinkCoordinator;
  readonly registry?: FlowToolRegistry;
  readonly enterprise?: GatewayEnterpriseRuntime;
  readonly ingress?: DurableGatewayIngress;
  readonly ingressSpool?: DurableGatewayIngressSpool;
  readonly approvalActions?: ApprovalActionCodec;
  readonly approvalStore?: SqliteApprovalActionStore;
  readonly log?: (line: string) => void;
  /** Abort to stop the loop. */
  readonly signal?: AbortSignal;
  /** Long-poll timeout in seconds (Telegram holds the request open). Default 25. */
  readonly pollTimeoutSec?: number;
  /** Bound the number of getUpdates iterations (mainly for tests). Default unbounded. */
  readonly maxIterations?: number;
}

function pollDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

/**
 * Long-poll Telegram getUpdates and feed each text update through the SAME
 * governed handleSurfaceMessage path as the webhook (pairing, scoped run,
 * per-surface accounting). No public URL / webhook needed — telegram only
 * allows getUpdates when no webhook is set, so we deleteWebhook first.
 */
export async function pollTelegram(options: TelegramPollOptions): Promise<void> {
  const botToken = options.gateway.telegram?.botToken;
  if (!botToken) throw new Error("Telegram adapter not configured. Add telegram.botToken to .muster/gateway.json.");
  const fetcher = options.fetcher ?? fetch;
  const log = options.log ?? ((line: string) => console.log(line));
  const cwd = options.cwd ?? process.cwd();
  const timeout = options.pollTimeoutSec ?? 25;
  const ownsApprovalStore = options.approvalStore === undefined;
  const approvalStore = options.approvalStore ?? new SqliteApprovalActionStore(join(dataDir(cwd), "enterprise-control-plane.db"));
  const approvalActions = options.approvalActions ?? createApprovalActionCodec({
    secret: createHash("sha256").update(`muster-approval:${options.gateway.token}`).digest(),
    store: approvalStore,
  });
  const ownsEnterpriseRuntime = options.enterprise === undefined;
  const enterprise = options.enterprise ?? openSqliteGatewayEnterpriseRuntime(cwd);
  const ownsFrappeTelegramLinks = options.frappeTelegramLinks === undefined && options.gateway.frappe?.telegramLinking?.enabled === true;
  const frappeTelegramLinks = options.frappeTelegramLinks
    ?? (ownsFrappeTelegramLinks ? openSqliteFrappeTelegramLinkCoordinator(join(dataDir(cwd), "frappe-telegram-links.db")) : undefined);
  const ingress = options.ingress ?? new DurableGatewayIngress(enterprise.idempotencyStore, { defaultLeaseMs: 15 * 60_000 });
  const ingressSpool = options.ingressSpool ?? new DurableGatewayIngressSpool(
    join(dataDir(cwd), "gateway-ingress-spool"),
    createHash("sha256").update(`muster-ingress-spool:${options.gateway.token}`).digest(),
  );
  const queue = createOutboundQueue();
  await recoverIngressSpool({
    ...options,
    cwd,
    enterprise,
    ingress,
    ingressSpool,
    approvalActions,
    approvalStore,
    frappeTelegramLinks,
  }, queue, ingressSpool);
  const base = `https://api.telegram.org/bot${botToken}`;
  const telegramCommands = gatewayCommandCatalog(options.gateway)
    .map((entry) => ({
      command: entry.name.replaceAll("-", "_").slice(0, 32),
      description: entry.description.trim().slice(0, 256),
    }))
    .filter((entry, index, entries) => /^[a-z][a-z0-9_]{0,31}$/.test(entry.command)
      && entry.description.length > 0
      && entries.findIndex((candidate) => candidate.command === entry.command) === index)
    .slice(0, 100);
  try {
    const published = await fetcher(`${base}/setMyCommands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commands: telegramCommands }),
    });
    if (!published.ok) log(`telegram setMyCommands HTTP ${published.status}`);
  } catch (error) {
    log(`telegram setMyCommands error: ${error instanceof Error ? error.message : String(error)}`);
  }
  // getUpdates is rejected while a webhook is set; clear it first (best-effort).
  try { await fetcher(`${base}/deleteWebhook`, { method: "POST" }); } catch { /* best-effort */ }
  log("telegram long-poll started");
  let persistedOffset = await loadTelegramPollOffset(cwd);
  let offset = persistedOffset;
  let iterations = 0;
  const max = options.maxIterations ?? Number.POSITIVE_INFINITY;
  while (!options.signal?.aborted && iterations < max) {
    iterations += 1;
    let updates: Array<Record<string, unknown>>;
    try {
      const res = await fetcher(`${base}/getUpdates?offset=${offset}&timeout=${timeout}`, { signal: options.signal });
      if (!res.ok) { log(`telegram getUpdates HTTP ${res.status}`); await pollDelay(2000, options.signal); continue; }
      const data = (await res.json()) as { result?: Array<Record<string, unknown>> };
      updates = data.result ?? [];
    } catch (error) {
      if (options.signal?.aborted) break;
      log(`telegram getUpdates error: ${error instanceof Error ? error.message : String(error)}`);
      await pollDelay(2000, options.signal);
      continue;
    }
    for (const update of updates) {
      const updateId = typeof update.update_id === "number" ? update.update_id : 0;
      if (updateId > 0 && updateId < persistedOffset) {
        offset = Math.max(offset, persistedOffset);
        continue;
      }
      const body = JSON.stringify(update);
      const deliveryId = adapterDeliveryKey("telegram", body);
      if (!deliveryId) {
        log("telegram update has no durable update id; it was not acknowledged");
        break;
      }
      const identity: GatewayIngressIdentity = {
        scope: "adapter:telegram",
        deliveryId,
        fingerprint: createGatewayIngressFingerprint(["telegram", deliveryId, body]),
      };
      try {
        const claim = await ingress.claim(identity);
        if (claim.status === "conflict") {
          log(`telegram update ${updateId} conflicts with a prior durable fingerprint; quarantining by offset`);
        } else if (claim.status === "replay" || claim.status === "in-flight") {
          await acknowledgeTelegramReplay(body, effectiveAdapterContext({ ...options, enterprise, approvalActions, approvalStore, frappeTelegramLinks }, {}, queue, cwd, true));
        } else {
          if (!claim.claimToken) throw new Error("Telegram ingress claim did not return its generation token.");
          const ownership: GatewayIngressOwnership = { ...identity, claimToken: claim.claimToken };
          await ingress.transition({ ...ownership, to: "running" });
          try {
            await ingressSpool.put({ adapterId: "telegram", ownership, body });
          } catch (error) {
            await ingress.fail(ownership).catch(() => undefined);
            throw error;
          }
          if (updateId > 0 && updateId + 1 > persistedOffset) {
            persistedOffset = updateId + 1;
            await saveTelegramPollOffset(cwd, persistedOffset);
            offset = persistedOffset;
          }
          const context = effectiveAdapterContext({ ...options, enterprise, approvalActions, approvalStore, frappeTelegramLinks }, {}, queue, cwd, true);
          await runAcceptedDurableAdapter({
            adapterId: "telegram",
            body,
            ownership,
            leaseExpiresAt: claim.leaseExpiresAt,
            ingress,
            spool: ingressSpool,
            context,
          });
        }
        if (updateId > 0 && updateId + 1 > persistedOffset) {
          persistedOffset = updateId + 1;
          await saveTelegramPollOffset(cwd, persistedOffset);
          offset = persistedOffset;
        }
      } catch (error) {
        log(`telegram update handling failed: ${error instanceof Error ? error.message : String(error)}`);
        offset = persistedOffset;
        break;
      }
    }
  }
  if (ownsApprovalStore) approvalStore.close();
  if (ownsFrappeTelegramLinks) frappeTelegramLinks?.close();
  if (ownsEnterpriseRuntime) await enterprise.close?.();
  log("telegram long-poll stopped");
}

/**
 * Slack Events API webhook: handles url_verification challenges, ignores bot
 * echoes, and posts replies via chat.postMessage (approval requests render as
 * Block Kit buttons). Synchronous processing; see slice-1 caveat above. When
 * slack.signingSecret is configured the X-Slack-Signature / -Request-Timestamp
 * headers are verified against the RAW body (before any JSON parsing) and a
 * mismatch (or a >5-min-old timestamp) is rejected with 401. If no signing
 * secret is configured we warn once that Slack is unauthenticated.
 */
async function handleSlackWebhook(body: string, context: AdapterContext): Promise<unknown> {
  const botToken = context.gateway.slack?.botToken;
  if (!botToken) throw new Error("Slack adapter not configured. Add slack.botToken to .muster/gateway.json.");
  const signingSecret = context.gateway.slack?.signingSecret;
  if (signingSecret && !context.platformVerified) {
    await verifyWithChannelSdk(slackChannel, body, context.headers, context.gateway);
  } else if (!signingSecret) {
    warnUnauthenticatedOnce("slack", context.log);
  }
  const payload = parseSlackWebhookBody(body);
  const deliveryId = slackDeliveryId(payload);
  const deliveryKey = deliveryId ? `slack:${deliveryId}` : undefined;
  const cached = deliveryLookup(deliveryKey);
  if (cached !== undefined) return cached;
  return handleSlackPayload(payload, context, botToken, deliveryKey);
}

function parseSlackWebhookBody(body: string): unknown {
  return parseSlackBody(body);
}

/** Run an SDK adapter's inbound verification, mapping its rejection onto the HTTP error. */
async function verifyWithChannelSdk(
  adapter: ChannelAdapter,
  body: string,
  headers: AdapterContext["headers"],
  gateway: GatewayConfig,
): Promise<void> {
  try {
    await adapter.verifyInbound?.({ body, headers, gateway });
  } catch (error) {
    if (error instanceof ChannelVerificationError) throw new GatewayHttpError(error.status, error.message);
    throw error;
  }
}

async function handleSlackPayload(payload: unknown, context: AdapterContext, botToken: string, deliveryKey?: string): Promise<unknown> {
  const inbound = slackEventToSurfaceMessage(payload, { approvalActions: context.approvalActions });
  if (inbound.kind === "url_verification") return { challenge: inbound.challenge };
  if (inbound.kind === "ignored") return { ok: true, ignored: inbound.reason };
  if (context.gateway.slack?.stream === "draft") {
    const message: SurfaceMessage = { ...inbound.message, stream: "draft" };
    const channelSink = createSlackDraftSink({
      botToken,
      channel: message.conversationId,
      threadTs: message.replyTo,
      fetcher: context.fetcher,
      queue: context.queue,
    });
    let durableDraftDelivered = false;
    const sink: DraftSink = context.durableDelivery ? {
      ...channelSink,
      finalize: async (text) => {
        await context.durableDelivery?.checkpoint([{ message, reply: { text } }]);
        await context.durableDelivery?.begin();
        await channelSink.finalize(text);
        await context.durableDelivery?.delivered();
        durableDraftDelivered = true;
      },
    } : channelSink;
    const progress = await startSlackProgress(botToken, message, context);
    let reply: SurfaceReply | PairingChallenge;
    try {
      reply = await withConversationLane(message, context, context.gateway.slack?.busy ?? "queue", () => handleSurfaceMessage(message, {
        ...context,
        sink,
        onReasoningDelta: (delta) => progress.update(delta),
        onStatus: (status) => progress.set(status),
      }));
      await progress.stop(isPairingChallenge(reply) ? undefined : "✓ Done");
    } catch (error) {
      await progress.stop("! Failed");
      throw error;
    }
    if (!isPairingChallenge(reply) && durableDraftDelivered) {
      await deliverSlackArtifacts(botToken, reply, message.conversationId, message.replyTo, context);
      const result = { ok: true, streamed: true };
      deliveryStore(deliveryKey, result);
      return result;
    }
    if (context.durableDelivery && !durableDraftDelivered) {
      await context.durableDelivery.checkpoint([{ message, reply }]);
      await context.durableDelivery.begin();
    }
    await deliverSlackReply(botToken, reply, message.conversationId, message.replyTo, context, message);
    if (context.durableDelivery && !durableDraftDelivered) await context.durableDelivery.delivered();
    return { ok: true };
  }
  const progress = await startSlackProgress(botToken, inbound.message, context);
  let reply: SurfaceReply | PairingChallenge;
  let progressFinal: "updated" | "none" = "none";
  let durableDeliveryBegan = false;
  try {
    reply = await withConversationLane(inbound.message, context, context.gateway.slack?.busy ?? "queue", () => handleSurfaceMessage(inbound.message, {
      ...context,
      onReasoningDelta: (delta) => progress.update(delta),
      onStatus: (status) => progress.set(status),
    }));
    if (context.durableDelivery) await context.durableDelivery.checkpoint([{ message: inbound.message, reply }]);
    if (context.durableDelivery && !isPairingChallenge(reply) && !reply.approvalRequest) {
      await context.durableDelivery.begin();
      durableDeliveryBegan = true;
    }
    progressFinal = await progress.stop(!isPairingChallenge(reply) && !reply.approvalRequest ? reply.text : undefined);
  } catch (error) {
    await progress.stop("! Failed");
    throw error;
  }
  if (context.durableDelivery && !durableDeliveryBegan) await context.durableDelivery.begin();
  if (isPairingChallenge(reply) || reply.approvalRequest || progressFinal !== "updated") {
    await deliverSlackReply(botToken, reply, inbound.message.conversationId, inbound.message.replyTo, context, inbound.message);
  } else {
    await deliverSlackArtifacts(botToken, reply, inbound.message.conversationId, inbound.message.replyTo, context);
  }
  if (context.durableDelivery) await context.durableDelivery.delivered();
  const result = { ok: true };
  deliveryStore(deliveryKey, result);
  return result;
}

interface SlackSocketOptions {
  readonly config: MusterConfig;
  readonly gateway: GatewayConfig;
  readonly cwd?: string;
  readonly fetcher?: typeof fetch;
  readonly registry?: FlowToolRegistry;
  /** Shared Frappe OAuth coordinator used by /pair and permission-bound runs. */
  readonly frappeOAuth?: FrappeOAuthCoordinator;
  readonly enterprise?: GatewayEnterpriseRuntime;
  readonly ingress?: DurableGatewayIngress;
  readonly ingressSpool?: DurableGatewayIngressSpool;
  readonly approvalActions?: ApprovalActionCodec;
  readonly approvalStore?: SqliteApprovalActionStore;
  readonly log?: (line: string) => void;
  readonly signal?: AbortSignal;
  readonly reconnectDelayMs?: number;
  readonly maxConnections?: number;
  readonly webSocketFactory?: (url: string) => SlackSocketLike;
}

interface SlackSocketLike {
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}

interface SlackSocketEnvelope {
  readonly envelope_id?: string;
  readonly type?: string;
  readonly payload?: unknown;
}

function makeSlackSocket(url: string): SlackSocketLike {
  const Constructor = globalThis.WebSocket as unknown as (new (socketUrl: string) => SlackSocketLike) | undefined;
  if (!Constructor) throw new Error("Slack Socket Mode requires Node's global WebSocket support.");
  return new Constructor(url);
}

function socketReady(socket: SlackSocketLike, signal?: AbortSignal): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    socket.onopen = () => resolvePromise();
    socket.onerror = (event) => reject(new Error(`Slack socket open failed: ${String(event)}`));
    signal?.addEventListener("abort", () => reject(new Error("Slack socket open aborted")), { once: true });
  });
}

function socketClosed(socket: SlackSocketLike, signal?: AbortSignal): Promise<void> {
  return new Promise((resolvePromise) => {
    const close = (): void => resolvePromise();
    socket.onclose = close;
    socket.onerror = close;
    signal?.addEventListener("abort", () => {
      try { socket.close(); } catch { /* ignore close races */ }
      resolvePromise();
    }, { once: true });
  });
}

function parseSlackSocketEnvelope(data: unknown): SlackSocketEnvelope | undefined {
  const text = typeof data === "string" ? data : data instanceof Buffer ? data.toString("utf8") : undefined;
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text) as SlackSocketEnvelope;
    return typeof parsed === "object" && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function openSlackSocketUrl(appToken: string, fetcher: typeof fetch): Promise<string> {
  const response = await fetcher("https://slack.com/api/apps.connections.open", {
    method: "POST",
    headers: { authorization: `Bearer ${appToken}`, "content-type": "application/x-www-form-urlencoded" },
    body: "",
  });
  const body = await response.json().catch(() => ({})) as { ok?: boolean; url?: string; error?: string };
  if (!response.ok || body.ok === false || !body.url) {
    throw new Error(`Slack Socket Mode connection failed${body.error ? `: ${body.error}` : `: HTTP ${response.status}`}`);
  }
  return body.url;
}

/** Slack Socket Mode loop. It avoids public HTTPS URLs and uses the same governed Slack payload path as Events API. */
export async function pollSlackSocket(options: SlackSocketOptions): Promise<void> {
  const botToken = options.gateway.slack?.botToken;
  const appToken = options.gateway.slack?.appToken;
  if (!botToken) throw new Error("Slack adapter not configured. Add slack.botToken to .muster/gateway.json.");
  if (!appToken) throw new Error("Slack Socket Mode app token missing. Run: muster channels ready slack --app-token-env SLACK_APP_TOKEN");
  const fetcher = options.fetcher ?? fetch;
  const log = options.log ?? ((line: string) => console.log(line));
  const cwd = options.cwd ?? process.cwd();
  const ownsApprovalStore = options.approvalStore === undefined;
  const approvalStore = options.approvalStore ?? new SqliteApprovalActionStore(join(dataDir(cwd), "enterprise-control-plane.db"));
  const approvalActions = options.approvalActions ?? createApprovalActionCodec({
    secret: createHash("sha256").update(`muster-approval:${options.gateway.token}`).digest(),
    store: approvalStore,
  });
  const ownsEnterpriseRuntime = options.enterprise === undefined;
  const enterprise = options.enterprise ?? openSqliteGatewayEnterpriseRuntime(cwd);
  const ingress = options.ingress ?? new DurableGatewayIngress(enterprise.idempotencyStore, { defaultLeaseMs: 15 * 60_000 });
  const ingressSpool = options.ingressSpool ?? new DurableGatewayIngressSpool(
    join(dataDir(cwd), "gateway-ingress-spool"),
    createHash("sha256").update(`muster-ingress-spool:${options.gateway.token}`).digest(),
  );
  const reconnectDelayMs = options.reconnectDelayMs ?? 2000;
  const maxConnections = options.maxConnections ?? Number.POSITIVE_INFINITY;
  const queue = createOutboundQueue();
  await recoverIngressSpool({
    ...options,
    cwd,
    enterprise,
    ingress,
    ingressSpool,
    approvalActions,
    approvalStore,
  }, queue, ingressSpool);
  const activePayloads = new Set<Promise<void>>();
  let connections = 0;
  while (!options.signal?.aborted && connections < maxConnections) {
    connections += 1;
    let socket: SlackSocketLike | undefined;
    try {
      const url = await openSlackSocketUrl(appToken, fetcher);
      socket = (options.webSocketFactory ?? makeSlackSocket)(url);
      await socketReady(socket, options.signal);
      log("slack socket-mode connected");
      socket.onmessage = (event) => {
        const envelope = parseSlackSocketEnvelope(event.data);
        if (!envelope) {
          log("slack socket-mode ignored malformed envelope");
          return;
        }
        if (envelope.type !== "events_api") {
          if (envelope.envelope_id) socket?.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
          return;
        }
        if (!envelope.envelope_id) {
          log("slack socket-mode events_api envelope has no envelope_id; it was not acknowledged");
          return;
        }
        const task = (async () => {
          const body = JSON.stringify(envelope.payload);
          const deliveryId = `slack-socket:${envelope.envelope_id}`;
          const identity: GatewayIngressIdentity = {
            scope: "adapter:slack",
            deliveryId,
            fingerprint: createGatewayIngressFingerprint(["slack", deliveryId, body]),
          };
          const claim = await ingress.claim(identity);
          if (claim.status === "conflict") {
            log(`slack socket-mode ${deliveryId} conflicts with a prior durable fingerprint`);
            socket?.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
            return;
          }
          if (claim.status === "replay" || claim.status === "in-flight") {
            socket?.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
            return;
          }
          if (!claim.claimToken) throw new Error("Slack ingress claim did not return its generation token.");
          const ownership: GatewayIngressOwnership = { ...identity, claimToken: claim.claimToken };
          await ingress.transition({ ...ownership, to: "running" });
          try {
            await ingressSpool.put({ adapterId: "slack", ownership, body });
          } catch (error) {
            await ingress.fail(ownership).catch(() => undefined);
            throw error;
          }
          socket?.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
          const context = effectiveAdapterContext({ ...options, enterprise, approvalActions, approvalStore }, {}, queue, cwd, true);
          await runAcceptedDurableAdapter({
            adapterId: "slack",
            body,
            ownership,
            leaseExpiresAt: claim.leaseExpiresAt,
            ingress,
            spool: ingressSpool,
            context,
          });
        })().catch((error) => {
          log(`slack socket-mode payload failed: ${error instanceof Error ? error.message : String(error)}`);
        });
        trackBackgroundTask(activePayloads, task);
      };
      await socketClosed(socket, options.signal);
      if (!options.signal?.aborted) log("slack socket-mode disconnected; reconnecting");
    } catch (error) {
      if (options.signal?.aborted) break;
      log(`slack socket-mode error: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      try { socket?.close(); } catch { /* ignore close races */ }
    }
    if (!options.signal?.aborted && connections < maxConnections) await pollDelay(reconnectDelayMs, options.signal);
  }
  await waitForBackgroundTasks(activePayloads);
  if (ownsApprovalStore) approvalStore.close();
  if (ownsEnterpriseRuntime) await enterprise.close?.();
  log("slack socket-mode stopped");
}

export interface WhatsAppSocketOptions extends GatewayServerOptions {
  readonly signal?: AbortSignal;
}

/** Linked-device WhatsApp worker; Baileys owns the socket, Muster owns policy and the governed envelope. */
export async function pollWhatsApp(options: WhatsAppSocketOptions): Promise<void> {
  const whatsapp = options.gateway.whatsapp;
  if (!whatsapp) throw new Error("WhatsApp is not configured. Run: muster channels setup whatsapp");
  const cwd = options.cwd ?? process.cwd();
  const log = options.log ?? ((line: string) => console.log(line));
  const ownsApprovalStore = options.approvalStore === undefined;
  const approvalStore = options.approvalStore ?? new SqliteApprovalActionStore(join(dataDir(cwd), "enterprise-control-plane.db"));
  const approvalActions = options.approvalActions ?? createApprovalActionCodec({
    secret: createHash("sha256").update(`muster-approval:${options.gateway.token}`).digest(),
    store: approvalStore,
  });
  const ownsEnterpriseRuntime = options.enterprise === undefined;
  const enterprise = options.enterprise ?? openSqliteGatewayEnterpriseRuntime(cwd);
  const queue = createOutboundQueue();
  const context = effectiveAdapterContext({ ...options, enterprise, approvalActions, approvalStore }, {}, queue, cwd, true);
  try {
    await runWhatsAppConnection({
      config: whatsapp,
      cwd,
      signal: options.signal,
      log,
      onMessage: (message) => handleSurfaceMessage(message, {
        ...context,
        ...(message.conversationId.endsWith("@g.us") ? {
          pairingOverride: {
            pairingId: `pair_whatsapp_group_${createHash("sha256").update(`${message.surfaceId}\0${message.senderId}`).digest("hex").slice(0, 12)}`,
            surfaceId: message.surfaceId,
            senderId: message.senderId,
            approvedAt: new Date(0).toISOString(),
          },
        } : {}),
      }),
    });
  } finally {
    if (ownsApprovalStore) approvalStore.close();
    if (ownsEnterpriseRuntime) await enterprise.close?.();
  }
}

type AdapterHandler = (body: string, context: AdapterContext) => Promise<unknown>;

/** Telegram and Slack keep their streaming handlers; every other route is served by its SDK adapter. */
function adapterHandler(adapterId: string): AdapterHandler | undefined {
  if (adapterId === "telegram") return handleTelegramWebhook;
  if (adapterId === "slack") return handleSlackWebhook;
  const adapter = channelWebhookAdapter(adapterId);
  return adapter ? (body, context) => serveSdkChannelWebhook(adapter, body, context) : undefined;
}

/** The canonical route id (the durable-ingress scope) for /v1/adapters/<route>. */
function canonicalAdapterRoute(route: string): string {
  return channelWebhookAdapter(route)?.webhook?.routes[0] ?? route;
}

function sdkChannelContext(context: AdapterContext): ChannelContext {
  return { gateway: context.gateway, cwd: context.cwd, fetcher: context.fetcher, log: context.log, env: process.env };
}

function sdkApprovalDeps(context: AdapterContext): ApprovalDeps | undefined {
  return context.approvalActions
    ? { codec: context.approvalActions, ttlSeconds: Math.min(3600, Math.max(60, context.gateway.approvals?.ttlSeconds ?? 600)) }
    : undefined;
}

function serveSdkChannelWebhook(adapter: ChannelAdapter, body: string, context: AdapterContext): Promise<unknown> {
  return serveChannelWebhook(adapter, body, {
    context: sdkChannelContext(context),
    config: context.config,
    headers: context.headers,
    platformVerified: context.platformVerified === true,
    approvals: sdkApprovalDeps(context),
    bearerVerifier: context.gchatVerifier,
    runTurn: (message, extra) => handleSurfaceMessage(message, { ...context, ...extra }),
    replyCache: { lookup: deliveryLookup, store: deliveryStore },
    durable: context.durableDelivery,
  }).catch((error: unknown) => {
    if (error instanceof ChannelVerificationError) throw new GatewayHttpError(error.status, error.message);
    throw error;
  });
}

function adapterDeliveryKey(adapterId: string, body: string): string | undefined {
  if (adapterId === "telegram") return telegramChannel.deliveryKey?.(body);
  if (adapterId === "slack") return slackChannel.deliveryKey?.(body);
  return channelWebhookAdapter(adapterId)?.deliveryKey?.(body);
}

function adapterInFlightAcknowledgement(adapterId: string): unknown {
  return channelWebhookAdapter(adapterId)?.webhook?.busyResponse?.("in-flight") ?? { ok: true, accepted: true };
}

function adapterReplayAcknowledgement(adapterId: string): unknown {
  return channelWebhookAdapter(adapterId)?.webhook?.busyResponse?.("replay") ?? { ok: true, replayed: true };
}

function effectiveAdapterContext(
  options: GatewayServerOptions,
  headers: AdapterContext["headers"],
  queue: OutboundQueue,
  cwd: string,
  platformVerified = false,
  durableDelivery?: DurableAdapterDeliveryHooks,
): AdapterContext {
  return {
    config: options.config,
    gateway: options.gateway,
    cwd,
    fetcher: options.fetcher ?? fetch,
    log: options.log ?? (() => {}),
    headers,
    queue,
    registry: options.registry,
    gchatVerifier: options.gchatVerifier,
    enterprise: options.enterprise,
    approvalActions: options.approvalActions,
    approvalStore: options.approvalStore,
    frappeOAuth: options.frappeOAuth,
    frappeTelegramLinks: options.frappeTelegramLinks,
    platformVerified,
    durableDelivery,
  };
}

async function acknowledgeTelegramReplay(body: string, context: AdapterContext): Promise<void> {
  const callbackQueryId = telegramCallbackQueryId(JSON.parse(body));
  const botToken = context.gateway.telegram?.botToken;
  if (callbackQueryId && botToken) {
    await sendTelegramPayload(botToken, { callback_query_id: callbackQueryId }, context, "answerCallbackQuery");
  }
}

async function verifyAdapterPlatformRequest(
  adapterId: string,
  body: string,
  headers: AdapterContext["headers"],
  options: GatewayServerOptions,
): Promise<void> {
  if (adapterId === "telegram") await verifyWithChannelSdk(telegramChannel, body, headers, options.gateway);
  if (adapterId === "slack") await verifyWithChannelSdk(slackChannel, body, headers, options.gateway);
  const sdk = adapterId === "telegram" || adapterId === "slack" ? undefined : channelWebhookAdapter(adapterId);
  if (sdk) {
    try {
      await verifyChannelWebhook(sdk, { body, headers, gateway: options.gateway, fetcher: options.fetcher ?? fetch, env: process.env, bearerVerifier: options.gchatVerifier });
    } catch (error) {
      if (error instanceof ChannelVerificationError) throw new GatewayHttpError(error.status, error.message);
      throw error;
    }
  }
}

/** The immediate answer for adapters that acknowledge first and reply later; undefined runs in the request. */
function adapterAcknowledgement(adapterId: string, body: string, ingress: GatewayIngressIdentity | undefined, gateway: GatewayConfig): { readonly status: number; readonly body: unknown } | undefined {
  if (!ingress) return undefined;
  if (adapterId === "telegram") return { status: 200, body: { ok: true, accepted: true } };
  if (adapterId === "slack") {
    const payload = parseSlackWebhookBody(body) as { type?: unknown };
    return payload?.type === "url_verification" ? undefined : { status: 200, body: { ok: true, accepted: true } };
  }
  const adapter = channelWebhookAdapter(adapterId);
  if (!adapter?.webhook?.acknowledge) return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return undefined;
  }
  return adapter.webhook.acknowledge(gateway, payload);
}

function isAsyncAdapterId(adapterId: string): adapterId is GatewayAsyncAdapterId {
  return isGatewayAsyncAdapterId(adapterId);
}

class PostDeliveryPersistenceError extends Error {
  constructor(readonly cause: unknown) {
    super(`Platform delivery completed, but durable completion is pending: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "PostDeliveryPersistenceError";
  }
}

class DefinitivePlatformDeliveryError extends ChannelDeliveryRejectedError {
  constructor(message: string) {
    super(message);
    this.name = "DefinitivePlatformDeliveryError";
  }
}

async function advanceAdapterIngressToDelivering(
  ingress: DurableGatewayIngress,
  ownership: GatewayIngressOwnership,
): Promise<void> {
  for (let guard = 0; guard < 8; guard += 1) {
    const lifecycle = await ingress.readLifecycle(ownership);
    if (!lifecycle) throw new Error("Gateway ingress lifecycle disappeared before delivery.");
    if (lifecycle.state === "delivering") return;
    if (lifecycle.state === "delivered" || lifecycle.state === "unknown") {
      throw new Error(`Gateway ingress is already terminal as ${lifecycle.state}.`);
    }
    const to = lifecycle.state === "accepted"
      ? "running"
      : lifecycle.state === "running"
        ? "generated"
        : lifecycle.state === "generated"
          ? "delivering"
          : lifecycle.lastOperationalState === "generated" || lifecycle.lastOperationalState === "delivering"
            ? "delivering"
            : "running";
    await ingress.transition({ ...ownership, to });
  }
  throw new Error("Gateway ingress could not advance to delivering state.");
}

async function advanceAdapterIngressToGenerated(
  ingress: DurableGatewayIngress,
  ownership: GatewayIngressOwnership,
): Promise<void> {
  for (let guard = 0; guard < 6; guard += 1) {
    const lifecycle = await ingress.readLifecycle(ownership);
    if (!lifecycle) throw new Error("Gateway ingress lifecycle disappeared before execution checkpointing.");
    if (lifecycle.state === "generated") return;
    if (lifecycle.state === "delivering" || lifecycle.state === "delivered" || lifecycle.state === "unknown") {
      throw new Error(`Gateway ingress cannot checkpoint generated output from ${lifecycle.state}.`);
    }
    const to = lifecycle.state === "accepted" || lifecycle.state === "failed" ? "running" : "generated";
    await ingress.transition({ ...ownership, to });
  }
  throw new Error("Gateway ingress could not advance to generated state.");
}

async function notifyBackgroundFailure(adapterId: string, body: string, context: AdapterContext): Promise<void> {
  const text = "This request failed before completion. Nothing is being claimed as complete; retry it or use /status to inspect the connection.";
  if (adapterId === "telegram" && context.gateway.telegram?.botToken) {
    const message = telegramUpdateToSurfaceMessage(JSON.parse(body), { approvalActions: context.approvalActions });
    if (message) await sendTelegramPayload(context.gateway.telegram.botToken, { chat_id: message.conversationId, text }, context);
    return;
  }
  if (adapterId === "slack" && context.gateway.slack?.botToken) {
    const inbound = slackEventToSurfaceMessage(parseSlackWebhookBody(body), { approvalActions: context.approvalActions });
    if (inbound.kind === "message") {
      await sendSlackPayload(context.gateway.slack.botToken, {
        channel: inbound.message.conversationId,
        thread_ts: inbound.message.replyTo,
        text,
      }, context);
    }
    return;
  }
  const adapter = channelWebhookAdapter(adapterId);
  if (!adapter?.webhook) return;
  const inbound = adapter.webhook.parse(JSON.parse(body), { gateway: context.gateway });
  const message = inbound.kind === "messages" ? inbound.messages[0] : undefined;
  if (message) await adapter.send(webhookPeer(message), { text }, sdkChannelContext(context));
}

export async function completeAdapterIngress(
  ingress: DurableGatewayIngress,
  ownership: GatewayIngressOwnership,
  finalState: "delivered" | "unknown" = "delivered",
): Promise<void> {
  for (let guard = 0; guard < 8; guard += 1) {
    const lifecycle = await ingress.readLifecycle(ownership);
    if (!lifecycle) throw new Error("Gateway ingress lifecycle disappeared before completion.");
    if (lifecycle.state === finalState) break;
    if (lifecycle.state === "delivered" || lifecycle.state === "unknown") {
      throw new Error(`Gateway ingress is already terminal as ${lifecycle.state}, not ${finalState}.`);
    }
    const to = lifecycle.state === "delivering" ? finalState : undefined;
    if (!to) {
      await advanceAdapterIngressToDelivering(ingress, ownership);
      continue;
    }
    await ingress.transition({ ...ownership, to });
  }
  const terminal = await ingress.readLifecycle(ownership);
  if (terminal?.state !== finalState) throw new Error(`Gateway ingress did not reach terminal ${finalState} state.`);
  await ingress.complete({
    ...ownership,
    resultRef: createGatewaySafeResultRef("delivery", ownership.fingerprint.slice("sha256:".length, "sha256:".length + 32)),
  });
}

interface DurableAdapterDeliveryController {
  readonly hooks: DurableAdapterDeliveryHooks;
  readonly attempted: () => boolean;
  readonly delivered: () => boolean;
  finishWithoutDelivery(): Promise<void>;
  rejectDelivery(): Promise<void>;
  markUnknown(): Promise<void>;
}

function createDurableAdapterDeliveryController(
  ingress: DurableGatewayIngress,
  spool: DurableGatewayIngressSpool,
  ownership: GatewayIngressOwnership,
): DurableAdapterDeliveryController {
  let checkpointed = false;
  let attempted = false;
  let delivered = false;
  return {
    hooks: {
      checkpoint: async (preparedDeliveries) => {
        await spool.markExecutionCompleted(ownership, preparedDeliveries);
        checkpointed = true;
        await advanceAdapterIngressToGenerated(ingress, ownership);
      },
      begin: async () => {
        if (!checkpointed) throw new Error("Durable adapter delivery began before execution was checkpointed.");
        await spool.markSendAttempted(ownership);
        attempted = true;
        await ingress.transition({ ...ownership, to: "delivering" });
      },
      delivered: async () => {
        if (!attempted) throw new Error("Durable adapter delivery completed before its send attempt was recorded.");
        await spool.markPlatformDelivered(ownership);
        delivered = true;
        await ingress.transition({ ...ownership, to: "delivered" });
      },
    },
    attempted: () => attempted,
    delivered: () => delivered,
    finishWithoutDelivery: async () => {
      if (checkpointed || attempted) return;
      await spool.markPlatformDelivered(ownership);
      delivered = true;
      await completeAdapterIngress(ingress, ownership, "delivered");
    },
    rejectDelivery: async () => {
      await spool.markDeliveryRejected(ownership);
      attempted = false;
      await ingress.fail(ownership);
    },
    markUnknown: async () => {
      await spool.markUnknownAfterSend(ownership);
      await completeAdapterIngress(ingress, ownership, "unknown");
    },
  };
}

async function withIngressLease<T>(
  ingress: DurableGatewayIngress,
  ownership: GatewayIngressOwnership,
  initialLeaseExpiresAt: string,
  work: () => Promise<T>,
): Promise<T> {
  let stopped = false;
  let renewalFailure: unknown;
  const remaining = Math.max(300, Date.parse(initialLeaseExpiresAt) - Date.now());
  const intervalMs = Math.max(100, Math.min(60_000, Math.floor(remaining / 3)));
  let timer: NodeJS.Timeout | undefined;
  const renew = async (): Promise<void> => {
    if (stopped) return;
    try {
      await ingress.renew(ownership);
    } catch (error) {
      renewalFailure = error;
      return;
    }
    if (!stopped) {
      timer = setTimeout(() => { void renew(); }, intervalMs);
      timer.unref?.();
    }
  };
  timer = setTimeout(() => { void renew(); }, intervalMs);
  timer.unref?.();
  try {
    const result = await work();
    if (renewalFailure) throw new Error(`Gateway ingress lease renewal failed: ${renewalFailure instanceof Error ? renewalFailure.message : String(renewalFailure)}`);
    return result;
  } finally {
    stopped = true;
    if (timer) clearTimeout(timer);
  }
}

async function runAcceptedDurableAdapter(input: {
  readonly adapterId: GatewayAsyncAdapterId;
  readonly body: string;
  readonly ownership: GatewayIngressOwnership;
  readonly leaseExpiresAt: string;
  readonly ingress: DurableGatewayIngress;
  readonly spool: DurableGatewayIngressSpool;
  readonly context: AdapterContext;
}): Promise<unknown> {
  const handler = adapterHandler(input.adapterId);
  if (!handler) throw new Error(`No adapter handler is registered for ${input.adapterId}.`);
  const controller = createDurableAdapterDeliveryController(input.ingress, input.spool, input.ownership);
  const context = { ...input.context, durableDelivery: controller.hooks };
  return withIngressLease(input.ingress, input.ownership, input.leaseExpiresAt, async () => {
    try {
      const result = await handler(input.body, context);
      await controller.finishWithoutDelivery();
      await completeAdapterIngress(input.ingress, input.ownership, "delivered");
      await input.spool.remove(input.ownership);
      return result;
    } catch (error) {
      if (error instanceof ChannelDeliveryRejectedError && controller.attempted() && !controller.delivered()) {
        await controller.rejectDelivery();
        throw error;
      }
      if (controller.attempted() && !controller.delivered()) {
        await controller.markUnknown();
        throw new PostDeliveryPersistenceError(error);
      }
      if (controller.delivered()) throw new PostDeliveryPersistenceError(error);
      await input.ingress.fail(input.ownership).catch(() => undefined);
      throw error;
    }
  });
}

async function resumeClaimedDurableAdapter(input: {
  readonly entry: GatewayIngressSpoolEntry;
  readonly ownership: GatewayIngressOwnership;
  readonly leaseExpiresAt: string;
  readonly ingress: DurableGatewayIngress;
  readonly spool: DurableGatewayIngressSpool;
  readonly context: AdapterContext;
}): Promise<void> {
  if (input.entry.state === "accepted") {
    await runAcceptedDurableAdapter({
      adapterId: input.entry.adapterId,
      body: input.entry.body,
      ownership: input.ownership,
      leaseExpiresAt: input.leaseExpiresAt,
      ingress: input.ingress,
      spool: input.spool,
      context: input.context,
    });
    return;
  }
  await withIngressLease(input.ingress, input.ownership, input.leaseExpiresAt, async () => {
    if (input.entry.state === "platform-delivered") {
      await completeAdapterIngress(input.ingress, input.ownership, "delivered");
      await input.spool.remove(input.ownership);
      return;
    }
    if (input.entry.state === "send-attempted" || input.entry.state === "unknown-after-send") {
      if (input.entry.state === "send-attempted") await input.spool.markUnknownAfterSend(input.ownership);
      await completeAdapterIngress(input.ingress, input.ownership, "unknown");
      return;
    }
    await advanceAdapterIngressToDelivering(input.ingress, input.ownership);
    await input.spool.markSendAttempted(input.ownership);
    try {
      await deliverPreparedAdapter(input.entry.adapterId, input.entry.preparedDeliveries, input.context);
      await input.spool.markPlatformDelivered(input.ownership);
      await completeAdapterIngress(input.ingress, input.ownership, "delivered");
      await input.spool.remove(input.ownership);
    } catch (error) {
      if (error instanceof ChannelDeliveryRejectedError) {
        await input.spool.markDeliveryRejected(input.ownership);
        await input.ingress.fail(input.ownership);
        throw error;
      }
      await input.spool.markUnknownAfterSend(input.ownership);
      await completeAdapterIngress(input.ingress, input.ownership, "unknown");
      throw new PostDeliveryPersistenceError(error);
    }
  });
}

function trackBackgroundTask(tasks: Set<Promise<void>>, work: Promise<void>): void {
  tasks.add(work);
  void work.then(
    () => tasks.delete(work),
    () => tasks.delete(work),
  );
}

async function waitForBackgroundTasks(tasks: ReadonlySet<Promise<void>>, timeoutMs?: number): Promise<void> {
  const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
  while (tasks.size) {
    if (deadline === undefined) {
      await Promise.allSettled([...tasks]);
      continue;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`Gateway background drain exceeded ${timeoutMs}ms with ${tasks.size} task(s) still active.`);
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.allSettled([...tasks]),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Gateway background drain exceeded ${timeoutMs}ms.`)), remaining); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

async function deliverPreparedAdapter(
  adapterId: GatewayAsyncAdapterId,
  preparedDeliveries: readonly GatewayPreparedDelivery[],
  context: AdapterContext,
): Promise<void> {
  if (adapterId === "telegram") {
    const botToken = context.gateway.telegram?.botToken;
    if (!botToken) throw new Error("Telegram bot token is unavailable during durable delivery recovery.");
    for (const { message, reply } of preparedDeliveries) {
      await deliverTelegramReply(botToken, reply, message.conversationId, context, message);
    }
    return;
  }
  if (adapterId === "slack") {
    const botToken = context.gateway.slack?.botToken;
    if (!botToken) throw new Error("Slack bot token is unavailable during durable delivery recovery.");
    for (const { message, reply } of preparedDeliveries) {
      await deliverSlackReply(botToken, reply, message.conversationId, message.replyTo, context, message);
    }
    return;
  }
  const adapter = channelWebhookAdapter(adapterId);
  if (!adapter) throw new Error(`No channel adapter can deliver recovered ${adapterId} replies.`);
  await deliverPreparedChannelReplies(adapter, preparedDeliveries, sdkChannelContext(context), sdkApprovalDeps(context));
}

async function recoverIngressSpool(
  options: GatewayServerOptions,
  queue: OutboundQueue,
  spool: DurableGatewayIngressSpool,
): Promise<void> {
  const ingress = options.ingress;
  if (!ingress) return;
  const log = options.log ?? (() => {});
  const cwd = options.cwd ?? process.cwd();
  const snapshot = await spool.snapshot();
  if (snapshot.rejectedFiles) log(`gateway ingress spool quarantined ${snapshot.rejectedFiles} invalid file(s)`);
  for (const originalEntry of snapshot.entries) {
    try {
      if (originalEntry.state === "unknown-after-send") {
        log(`gateway ingress spool ${originalEntry.adapterId} is unknown-after-send; preserved for operator reconciliation`);
        continue;
      }
      const handler = adapterHandler(originalEntry.adapterId);
      if (!handler) {
        log(`gateway ingress spool has no handler for ${originalEntry.adapterId}; preserving payload`);
        continue;
      }
      let entry = originalEntry;
      let claim = await ingress.claim(entry.ownership);
      if (claim.status === "replay") {
        if (entry.state === "platform-delivered") await spool.remove(entry.ownership);
        else log(`gateway ingress spool ${entry.adapterId} replay retained because delivery evidence is ${entry.state}`);
        continue;
      }
      if (claim.status === "conflict") {
        log(`gateway ingress spool ${entry.adapterId} conflicts with durable ingress; preserving payload for inspection`);
        continue;
      }
      let ownership = entry.ownership;
      let leaseExpiresAt = claim.leaseExpiresAt;
      if (claim.status === "claimed") {
        if (!claim.claimToken) throw new Error("Gateway ingress claim did not return its generation token.");
        ownership = { ...entry.ownership, claimToken: claim.claimToken };
        if (ownership.claimToken !== entry.ownership.claimToken) entry = await spool.reassignOwnership(entry.ownership, ownership);
      } else if (claim.status === "in-flight") {
        if (!spoolOwnerIsDeadOnThisHost(entry)) {
          log(`gateway ingress spool ${entry.adapterId} remains owned by a live or remote process; recovery deferred`);
          continue;
        }
        if (entry.state === "platform-delivered" || entry.state === "send-attempted") {
          ownership = entry.ownership;
        } else {
          await ingress.fail(entry.ownership).catch(() => undefined);
          claim = await ingress.claim(entry.ownership);
          if (claim.status !== "claimed" || !claim.claimToken) {
            log(`gateway ingress spool ${entry.adapterId} could not reclaim its dead owner state (${claim.status})`);
            continue;
          }
          leaseExpiresAt = claim.leaseExpiresAt;
          ownership = { ...entry.ownership, claimToken: claim.claimToken };
          entry = await spool.reassignOwnership(entry.ownership, ownership);
        }
      }

      await withIngressLease(ingress, ownership, leaseExpiresAt, async () => {
        if (entry.state === "platform-delivered") {
          await completeAdapterIngress(ingress, ownership, "delivered");
          await spool.remove(ownership);
          log(`gateway ingress spool finalized previously delivered ${entry.adapterId} payload`);
          return;
        }
        if (entry.state === "send-attempted") {
          await spool.markUnknownAfterSend(ownership);
          await completeAdapterIngress(ingress, ownership, "unknown");
          log(`gateway ingress spool marked ${entry.adapterId} unknown-after-send; no duplicate delivery was attempted`);
          return;
        }
        const context = effectiveAdapterContext(options, {}, queue, cwd, true);
        if (entry.state === "execution-completed") {
          await advanceAdapterIngressToDelivering(ingress, ownership);
          await spool.markSendAttempted(ownership);
          try {
            await deliverPreparedAdapter(entry.adapterId, entry.preparedDeliveries, context);
            await spool.markPlatformDelivered(ownership);
            await completeAdapterIngress(ingress, ownership, "delivered");
            await spool.remove(ownership);
            log(`gateway ingress spool delivered checkpointed ${entry.adapterId} result without rerunning the provider`);
          } catch (error) {
            if (error instanceof ChannelDeliveryRejectedError) {
              await spool.markDeliveryRejected(ownership);
              await ingress.fail(ownership);
              throw error;
            }
            await spool.markUnknownAfterSend(ownership);
            await completeAdapterIngress(ingress, ownership, "unknown");
            throw new PostDeliveryPersistenceError(error);
          }
          return;
        }

        const controller = createDurableAdapterDeliveryController(ingress, spool, ownership);
        const durableContext = { ...context, durableDelivery: controller.hooks };
        try {
          await handler(entry.body, durableContext);
          await controller.finishWithoutDelivery();
          await completeAdapterIngress(ingress, ownership, "delivered");
          await spool.remove(ownership);
          log(`gateway ingress spool recovered ${entry.adapterId} payload`);
        } catch (error) {
          if (error instanceof ChannelDeliveryRejectedError && controller.attempted() && !controller.delivered()) {
            await controller.rejectDelivery();
            throw error;
          }
          if (controller.attempted() && !controller.delivered()) {
            await controller.markUnknown();
            throw new PostDeliveryPersistenceError(error);
          }
          await ingress.fail(ownership).catch(() => undefined);
          await notifyBackgroundFailure(entry.adapterId, entry.body, durableContext).catch((deliveryError) => {
            log(`gateway ingress spool failure notice failed: ${deliveryError instanceof Error ? deliveryError.message : String(deliveryError)}`);
          });
          throw error;
        }
      });
    } catch (error) {
      log(`gateway ingress spool ${originalEntry.adapterId} recovery failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function frappeTelegramAuthorityFromRequest(
  payload: Record<string, unknown>,
  gateway: GatewayConfig,
): FrappeTelegramAuthority {
  const linking = gateway.frappe?.telegramLinking;
  const botId = telegramBotId(gateway.telegram?.botToken);
  if (!linking?.enabled || !botId) throw new GatewayHttpError(503, "Frappe Telegram linking is not configured.");
  const tenantId = typeof payload.tenantId === "string" ? payload.tenantId.trim() : "";
  const site = typeof payload.site === "string" ? payload.site.trim() : "";
  const user = typeof payload.user === "string" ? payload.user.trim().toLowerCase() : "";
  const permissionEpoch = typeof payload.permissionEpoch === "string" ? payload.permissionEpoch.trim() : "";
  const scopes = Array.isArray(payload.scopes) ? payload.scopes.filter((scope): scope is string => typeof scope === "string") : [];
  const tenant = linking.tenants.find((entry) => entry.id === tenantId);
  if (!tenant || normalizedHttpsOrigin(tenant.site) !== normalizedHttpsOrigin(site)) {
    throw new GatewayHttpError(403, "Frappe Telegram tenant binding is not authorized.");
  }
  const allowed = new Set(tenant.allowedScopes);
  if (!scopes.length || scopes.some((scope) => !allowed.has(scope))) {
    throw new GatewayHttpError(403, "Frappe Telegram scopes are not authorized for this tenant.");
  }
  if (!user || !permissionEpoch) throw new GatewayHttpError(400, "Frappe Telegram user and permission epoch are required.");
  return { site: normalizedHttpsOrigin(site), user, tenantId, botId, scopes, permissionEpoch };
}

function normalizedHttpsOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new GatewayHttpError(400, "Frappe site must be a valid HTTPS origin."); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new GatewayHttpError(400, "Frappe site must be a valid HTTPS origin.");
  }
  return url.origin;
}

function frappeTelegramIdentityFromRequest(
  raw: unknown,
  authority: FrappeTelegramAuthority,
  linkId: string,
): Omit<PairedIdentity, "provider" | "resolvedAt"> & { readonly resolvedAt?: string } {
  const identity = objectRecord(raw);
  if (!identity) throw new GatewayHttpError(400, "A permission-checked Frappe identity is required.");
  const site = typeof identity.site === "string" ? normalizedHttpsOrigin(identity.site) : "";
  const user = typeof identity.user === "string" ? identity.user.trim().toLowerCase() : "";
  const permissionHash = typeof identity.permissionHash === "string" ? identity.permissionHash.trim() : "";
  const roles = Array.isArray(identity.roles)
    ? identity.roles.filter((role): role is string => typeof role === "string" && Boolean(role.trim())).map((role) => role.trim())
    : [];
  if (site !== authority.site || user !== authority.user || permissionHash !== authority.permissionEpoch || !roles.length) {
    throw new GatewayHttpError(403, "Frappe identity does not match the issued Telegram authority.");
  }
  const optional = (key: "userName" | "employee" | "employeeName" | "employeeStatus" | "reportsTo" | "reportsToName" | "department" | "departmentName" | "company" | "displayNamesResolvedAt" | "rolesHash") => {
    const value = identity[key];
    return typeof value === "string" && value.trim() ? { [key]: value.trim() } : {};
  };
  return {
    site,
    user,
    roles,
    permissionHash,
    authMode: "frappe_session",
    telegramLink: { linkId, tenantId: authority.tenantId, botId: authority.botId, scopes: [...authority.scopes] },
    ...optional("userName"),
    ...optional("employee"),
    ...optional("employeeName"),
    ...optional("employeeStatus"),
    ...optional("reportsTo"),
    ...optional("reportsToName"),
    ...optional("department"),
    ...optional("departmentName"),
    ...optional("company"),
    ...optional("displayNamesResolvedAt"),
    ...optional("rolesHash"),
  };
}

async function handleFrappeTelegramLinkRpc(
  payload: Record<string, unknown>,
  options: GatewayServerOptions,
  cwd: string,
): Promise<{ readonly status: number; readonly body: unknown }> {
  const coordinator = options.frappeTelegramLinks;
  const linking = options.gateway.frappe?.telegramLinking;
  if (!coordinator || !linking?.enabled) throw new GatewayHttpError(503, "Frappe Telegram linking is not configured.");
  const action = typeof payload.action === "string" ? payload.action : "issue";
  if (action === "rebind") {
    const tenantId = typeof payload.tenantId === "string" ? payload.tenantId.trim() : "";
    const site = typeof payload.site === "string" ? normalizedHttpsOrigin(payload.site) : "";
    const tenant = linking.tenants.find((entry) => entry.id === tenantId && normalizedHttpsOrigin(entry.site) === site);
    if (!tenant) throw new GatewayHttpError(403, "Frappe Telegram tenant binding is not authorized.");
    const botId = telegramBotId(options.gateway.telegram?.botToken);
    const invalidated = coordinator.invalidateForRebind({ site, tenantId, botId });
    const identitiesCleared = await clearTrustedFrappeTelegramBindings(site, tenantId, botId, cwd);
    return { status: 200, body: { ok: true, invalidated, identitiesCleared } };
  }
  const authority = frappeTelegramAuthorityFromRequest(payload, options.gateway);
  if (action === "issue") {
    const allowedChatTypes = Array.isArray(payload.allowedChatTypes)
      ? payload.allowedChatTypes.filter((value): value is TelegramChatType => value === "private" || value === "group" || value === "supergroup" || value === "channel")
      : ["private" as const];
    const started = coordinator.issue({
      ...authority,
      allowedChatTypes,
      ...(typeof payload.ttlMs === "number" ? { ttlMs: payload.ttlMs } : {}),
    });
    if (!/^[A-Za-z0-9_]{5,32}$/.test(linking.botUsername)) throw new GatewayHttpError(503, "Telegram bot username is invalid.");
    return {
      status: 201,
      body: {
        ok: true,
        linkId: started.linkId,
        expiresAt: started.expiresAt,
        startUrl: `https://t.me/${linking.botUsername}?start=${started.token}`,
      },
    };
  }
  const linkId = typeof payload.linkId === "string" ? payload.linkId.trim() : "";
  if (!linkId) throw new GatewayHttpError(400, "Telegram linkId is required.");
  if (action === "confirm") {
    const identity = frappeTelegramIdentityFromRequest(payload.identity, authority, linkId);
    const confirmed = coordinator.confirm({ ...authority, linkId });
    if (!confirmed.ok) throw new GatewayHttpError(403, confirmed.message);
    const paired = await upsertTrustedFrappePairing("telegram:bot", confirmed.value.telegramUserId, identity, cwd);
    return {
      status: 200,
      body: {
        ok: true,
        linkId,
        pairingId: paired.pairingId,
        telegramUserId: confirmed.value.telegramUserId,
        telegramChatId: confirmed.value.telegramChatId,
        chatType: confirmed.value.chatType,
      },
    };
  }
  if (action === "revoke") {
    const active = coordinator.resolveActive(linkId, authority);
    const revoked = coordinator.revoke({ linkId, site: authority.site, user: authority.user, tenantId: authority.tenantId });
    if (!revoked.ok) throw new GatewayHttpError(403, revoked.message);
    if (active.ok) await clearTrustedFrappePairingIdentity("telegram:bot", active.value.telegramUserId, cwd);
    return { status: 200, body: { ok: true, linkId, revokedAt: revoked.value.revokedAt } };
  }
  throw new GatewayHttpError(400, "Unsupported Frappe Telegram link action.");
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  options: GatewayServerOptions,
  queue: OutboundQueue,
  backgroundTasks: Set<Promise<void>>,
  messageRuns: AsyncMessageRunRegistry,
): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const url = new URL(request.url ?? "/", "http://gateway.local");

  if (request.method === "GET" && url.pathname === "/v1/health") {
    sendJson(response, 200, { ok: true, service: "muster-gateway" });
    return;
  }

  if (request.method === "GET" && url.pathname === FRAPPE_SITE_AUTHORIZE_PATH) {
    if (!options.frappeSiteBindings) throw new GatewayHttpError(503, "Frappe site binding is unavailable.");
    const location = options.frappeSiteBindings.authorize(url);
    response.writeHead(302, { location, "cache-control": "no-store", "referrer-policy": "no-referrer" });
    response.end();
    return;
  }

  if (request.method === "POST" && url.pathname === FRAPPE_SITE_EXCHANGE_PATH) {
    if (!options.frappeSiteBindings) throw new GatewayHttpError(503, "Frappe site binding is unavailable.");
    const payload = parseJsonRecord(await readBody(request, 64_000), "Frappe site OAuth exchange");
    response.setHeader("cache-control", "private, no-store");
    sendJson(response, 200, await options.frappeSiteBindings.exchange(payload));
    return;
  }

  if (request.method === "POST" && url.pathname === FRAPPE_SITE_API_CREDENTIALS_PATH) {
    if (!options.frappeSiteBindings) throw new GatewayHttpError(503, "Frappe site binding is unavailable.");
    const payload = parseJsonRecord(await readBody(request, 64_000), "Frappe site API credential exchange");
    response.setHeader("cache-control", "private, no-store");
    sendJson(response, 200, await options.frappeSiteBindings.exchangeApiCredentials(payload));
    return;
  }

  if (request.method === "POST" && url.pathname === FRAPPE_SITE_VERIFY_PATH) {
    if (!options.frappeSiteBindings) throw new GatewayHttpError(503, "Frappe site binding is unavailable.");
    const token = bearerFromRequest(request);
    const payload = parseJsonRecord(await readBody(request, 64_000), "Frappe site reciprocal verification");
    response.setHeader("cache-control", "private, no-store");
    sendJson(response, 200, options.frappeSiteBindings.verify(token, payload));
    return;
  }

  if (request.method === "GET" && ["/frappe2/oauth/callback", "/v1/frappe/oauth/callback"].includes(url.pathname)) {
    if (!options.frappeOAuth) {
      sendOAuthPage(response, 404, "Pairing unavailable", "This Muster gateway has no Frappe OAuth connection configured.");
      return;
    }
    let completed: Awaited<ReturnType<FrappeOAuthCoordinator["completeCallback"]>> | undefined;
    try {
      completed = await options.frappeOAuth.completeCallback(request.url ?? url.pathname);
      const current = await resolvePairing(completed.surfaceId, completed.senderId, cwd);
      if (!current || current.pairingId !== completed.pairingId) throw new Error("The channel pairing changed before Frappe authorization completed.");
      await upsertTrustedFrappePairing(completed.surfaceId, completed.senderId, completed.identity, cwd);
      sendOAuthPage(response, 200, "Frappe paired", `Signed in as ${completed.identity.employeeName ?? completed.identity.user}. Return to the chat and use /whoami to verify your scope.`);
    } catch (error) {
      if (completed) {
        await options.frappeOAuth.disconnect(completed.connectionId, {
          surfaceId: completed.surfaceId,
          senderId: completed.senderId,
          pairingId: completed.pairingId,
        }).catch(() => undefined);
      }
      options.log?.(`Frappe OAuth callback failed: ${error instanceof Error ? error.message : String(error)}`);
      sendOAuthPage(response, 400, "Pairing did not complete", "The authorization was denied, expired, or already used. Return to the chat and run /pair again.");
    }
    return;
  }

  // WhatsApp Cloud API GET verification handshake (hub.challenge echo).
  if (request.method === "GET" && url.pathname === "/v1/adapters/whatsapp-cloud") {
    const verifyToken = options.gateway["whatsapp-cloud"]?.verifyToken;
    if (!verifyToken) {
      sendJson(response, 500, { error: "WhatsApp adapter not configured. Add whatsapp.verifyToken to .muster/gateway.json." });
      return;
    }
    const challenge = whatsAppVerifyChallenge({
      mode: url.searchParams.get("hub.mode") ?? undefined,
      verifyToken: url.searchParams.get("hub.verify_token") ?? undefined,
      challenge: url.searchParams.get("hub.challenge") ?? undefined,
    }, verifyToken);
    if (challenge === undefined) {
      sendJson(response, 403, { error: "WhatsApp verification failed: mode or verify token mismatch." });
      return;
    }
    response.writeHead(200, { "content-type": "text/plain" });
    response.end(challenge);
    return;
  }

  const adapterMatch = url.pathname.match(/^\/v1\/adapters\/([a-z0-9-]+)$/);
  if (request.method === "POST" && adapterMatch) {
    const adapterId = canonicalAdapterRoute(adapterMatch[1]);
    const handler = adapterHandler(adapterId);
    if (!handler) {
      sendJson(response, 404, { error: `Unknown adapter: ${adapterId}` });
      return;
    }
    if (!adapterHasPlatformAuth(adapterId, options.gateway) && !bearerTokenMatches(request, options.gateway.token)) {
      sendJson(response, 401, { error: `Unauthorized ${adapterId} adapter webhook. Configure platform signature verification or send Authorization: Bearer <gateway token>.` });
      return;
    }
    const body = await readBody(request);
    await verifyAdapterPlatformRequest(adapterId, body, request.headers, options);
    const deliveryId = adapterDeliveryKey(adapterId, body);
    const ingressIdentity = deliveryId && options.ingress ? {
      scope: `adapter:${adapterId}`,
      deliveryId,
      fingerprint: createGatewayIngressFingerprint([adapterId, deliveryId, body]),
    } : undefined;
    let ingressOwnership: GatewayIngressOwnership | undefined;
    let ingressLeaseExpiresAt: string | undefined;
    let existingSpoolEntry: GatewayIngressSpoolEntry | undefined;
    if (ingressIdentity && options.ingress) {
      const claim = await options.ingress.claim(ingressIdentity);
      if (claim.status === "conflict") {
        sendJson(response, 409, { error: "Conflicting delivery fingerprint." });
        return;
      }
      if (claim.status === "in-flight") {
        if (adapterId === "telegram") await acknowledgeTelegramReplay(body, effectiveAdapterContext(options, request.headers, queue, cwd));
        sendJson(response, 200, adapterInFlightAcknowledgement(adapterId));
        return;
      }
      if (claim.status === "replay") {
        if (adapterId === "telegram") await acknowledgeTelegramReplay(body, effectiveAdapterContext(options, request.headers, queue, cwd));
        sendJson(response, 200, deliveryLookup(deliveryId) ?? adapterReplayAcknowledgement(adapterId));
        return;
      }
      if (!claim.claimToken) throw new Error("Gateway ingress claim did not return its generation token.");
      ingressOwnership = { ...ingressIdentity, claimToken: claim.claimToken };
      ingressLeaseExpiresAt = claim.leaseExpiresAt;
      if (isAsyncAdapterId(adapterId) && options.ingressSpool) {
        const existing = await options.ingressSpool.find(ingressIdentity);
        if (existing) existingSpoolEntry = await options.ingressSpool.reassignOwnership(existing.ownership, ingressOwnership);
      }
      if (!existingSpoolEntry) await options.ingress.transition({ ...ingressOwnership, to: "running" });
    }
    const acknowledgement = adapterAcknowledgement(adapterId, body, ingressIdentity, options.gateway);
    const runAfterAcknowledgement = acknowledgement !== undefined;
    let spooled = false;
    let controller: DurableAdapterDeliveryController | undefined;
    if (runAfterAcknowledgement && ingressOwnership && options.ingress && options.ingressSpool && isAsyncAdapterId(adapterId) && !existingSpoolEntry) {
      try {
        await options.ingressSpool.put({ adapterId, ownership: ingressOwnership, body });
        spooled = true;
        controller = createDurableAdapterDeliveryController(options.ingress, options.ingressSpool, ingressOwnership);
      } catch (error) {
        await options.ingress.fail(ingressOwnership).catch(() => undefined);
        throw error;
      }
    }
    const context = effectiveAdapterContext(
      options,
      request.headers,
      queue,
      cwd,
      adapterHasPlatformAuth(adapterId, options.gateway),
      controller?.hooks,
    );
    const processAdapter = async (): Promise<unknown> => {
      if (existingSpoolEntry && ingressOwnership && ingressLeaseExpiresAt && options.ingress && options.ingressSpool) {
        await resumeClaimedDurableAdapter({
          entry: existingSpoolEntry,
          ownership: ingressOwnership,
          leaseExpiresAt: ingressLeaseExpiresAt,
          ingress: options.ingress,
          spool: options.ingressSpool,
          context,
        });
        return { ok: true, resumed: true };
      }
      const work = async (): Promise<unknown> => {
        try {
          const result = await handler(body, context);
          if (controller) await controller.finishWithoutDelivery();
          if (ingressOwnership && options.ingress) await completeAdapterIngress(options.ingress, ingressOwnership, "delivered");
          if (spooled && ingressOwnership && options.ingressSpool) await options.ingressSpool.remove(ingressOwnership);
          return result;
        } catch (error) {
          if (error instanceof ChannelDeliveryRejectedError && controller?.attempted() && !controller.delivered()) {
            await controller.rejectDelivery();
            throw error;
          }
          if (controller?.attempted() && !controller.delivered()) {
            await controller.markUnknown();
            throw new PostDeliveryPersistenceError(error);
          }
          if (controller?.delivered()) throw new PostDeliveryPersistenceError(error);
          if (ingressOwnership && options.ingress) await options.ingress.fail(ingressOwnership).catch(() => undefined);
          throw error;
        }
      };
      return ingressOwnership && ingressLeaseExpiresAt && options.ingress
        ? withIngressLease(options.ingress, ingressOwnership, ingressLeaseExpiresAt, work)
        : work();
    };
    if (acknowledgement) {
      sendJson(response, acknowledgement.status, acknowledgement.body);
      // Claim and spool are durable at this point. Defer execution by one
      // event-loop turn so platform acknowledgements are not held behind the
      // first synchronous SQLite transition in the background workflow.
      const task = new Promise<void>((resolveTask) => setImmediate(resolveTask)).then(processAdapter).then(() => undefined).catch(async (error) => {
        context.log(`background ${adapterId} delivery failed: ${error instanceof Error ? error.message : String(error)}`);
        if (error instanceof PostDeliveryPersistenceError) return;
        await notifyBackgroundFailure(adapterId, body, context).catch((deliveryError) => {
          context.log(`background ${adapterId} failure notice failed: ${deliveryError instanceof Error ? deliveryError.message : String(deliveryError)}`);
        });
      });
      trackBackgroundTask(backgroundTasks, task);
      return;
    }
    const result = await processAdapter();
    sendJson(response, 200, result ?? { ok: true });
    return;
  }

  // Everything below requires either the deployment bearer or a verified,
  // exact-site binding bearer on the narrow trusted Frappe routes.
  const deploymentBearer = bearerTokenMatches(request, options.gateway.token);
  let siteBinding: FrappeSiteBindingRecord | undefined;
  if (!deploymentBearer && options.frappeSiteBindings && trustedFrappeBindingRoute(url.pathname)) {
    try { siteBinding = options.frappeSiteBindings.authorization(bearerFromRequest(request)); } catch { /* uniform 401 below */ }
  }
  const productionSiteRoute = options.gateway.security?.deployment === "production"
    && trustedFrappeBindingRoute(url.pathname);
  // A deployment-wide operator bearer is not site authority. Production
  // planning, mission, run-event, and Frappe-link routes must authenticate the
  // exact reciprocal site binding and its separate HMAC secret.
  if ((!deploymentBearer && !siteBinding) || (productionSiteRoute && !siteBinding)) {
    sendJson(response, 401, { error: "Unauthorized. Send Authorization: Bearer <gateway token>." });
    return;
  }
  const frappeAuthoritySecret = siteBinding?.secrets.hmacSecret ?? options.frappeRunCsrfSecret ?? options.gateway.token;

  if (request.method === "POST" && url.pathname === TRUSTED_FRAPPE_WORKFLOW_PROPOSALS_PATH) {
    const { scope } = authenticatedFrappeRunScope(request, frappeAuthoritySecret);
    assertSiteBindingScope(siteBinding, scope);
    const idempotencyKey = singleRequestHeader(request, "idempotency-key");
    if (!idempotencyKey || idempotencyKey.length > 140) {
      throw new GatewayHttpError(400, "Idempotency-Key is required for trusted Frappe workflow planning.");
    }
    const payload = parseJsonRecord(
      await readBody(request, MAX_FRAPPE_PLANNING_REQUEST_BYTES),
      "Trusted Frappe workflow planning request",
    );
    try {
      const planned = await createFrappeWorkflowProposalResult(payload, scope, options.frappeWorkflowPlanner);
      response.setHeader("cache-control", "private, no-store");
      sendJson(response, 200, {
        schemaVersion: 1,
        requestId: payload.requestId,
        status: "proposed",
        proposal: planned.proposal,
        graph: planned.graph,
        ...(planned.runMetadata ? { run: planned.runMetadata } : {}),
      });
    } catch (error) {
      if (error instanceof FrappeWorkflowPlanningError) {
        throw new GatewayHttpError(error.code === "capability_escalation" ? 403 : 400, error.message);
      }
      throw error;
    }
    return;
  }

  if (request.method === "POST" && url.pathname === TRUSTED_FRAPPE_READ_PLANS_PATH) {
    const { scope } = authenticatedFrappeRunScope(request, frappeAuthoritySecret);
    assertSiteBindingScope(siteBinding, scope);
    const idempotencyKey = singleRequestHeader(request, "idempotency-key");
    if (!idempotencyKey || idempotencyKey.length > 140) {
      throw new GatewayHttpError(400, "Idempotency-Key is required for trusted Frappe read planning.");
    }
    const payload = parseJsonRecord(
      await readBody(request, MAX_FRAPPE_READ_PLAN_REQUEST_BYTES),
      "Trusted Frappe read planning request",
    );
    try {
      const plan = await createFrappeReadPlan(payload, scope, options.frappeReadPlanner!);
      response.setHeader("cache-control", "private, no-store");
      sendJson(response, 200, { schemaVersion: 1, requestId: payload.requestId, status: "planned", plan });
    } catch (error) {
      if (error instanceof FrappeReadPlanningError) throw new GatewayHttpError(400, error.message);
      throw error;
    }
    return;
  }

  if (request.method === "POST" && url.pathname === TRUSTED_FRAPPE_ASK_INTENTS_PATH) {
    const { scope } = authenticatedFrappeRunScope(request, frappeAuthoritySecret);
    assertSiteBindingScope(siteBinding, scope);
    const idempotencyKey = singleRequestHeader(request, "idempotency-key");
    if (!idempotencyKey || idempotencyKey.length > 140) {
      throw new GatewayHttpError(400, "Idempotency-Key is required for trusted Frappe Ask routing.");
    }
    const payload = parseJsonRecord(
      await readBody(request, MAX_FRAPPE_ASK_INTENT_REQUEST_BYTES),
      "Trusted Frappe Ask intent request",
    );
    try {
      const intent = await createFrappeAskIntent(payload, scope, options.frappeAskIntentRouter!);
      response.setHeader("cache-control", "private, no-store");
      sendJson(response, 200, { schemaVersion: 1, requestId: payload.requestId, status: "classified", intent });
    } catch (error) {
      if (error instanceof FrappeAskIntentError) throw new GatewayHttpError(400, error.message);
      throw error;
    }
    return;
  }

  if (request.method === "POST" && url.pathname === FRAPPE_TELEGRAM_LINK_PATH) {
    let payload: Record<string, unknown>;
    try {
      payload = objectRecord(JSON.parse(await readBody(request))) ?? {};
    } catch {
      sendJson(response, 400, { error: "Frappe Telegram link request must be valid JSON." });
      return;
    }
    const result = await handleFrappeTelegramLinkRpc(payload, options, cwd);
    response.setHeader("cache-control", "private, no-store");
    sendJson(response, result.status, result.body);
    return;
  }

  if (request.method === "POST" && url.pathname === TRUSTED_FRAPPE_MISSIONS_PATH) {
    if (!options.frappeMissionBridge) throw new GatewayHttpError(503, "Trusted Frappe mission execution is unavailable.");
    const { scope } = authenticatedFrappeRunScope(request, frappeAuthoritySecret);
    assertSiteBindingScope(siteBinding, scope);
    const root = parseJsonRecord(await readBody(request), "Trusted Frappe mission request");
    const mission = root as unknown as TrustedFrappeMissionRequest;
    const idempotencyKey = singleRequestHeader(request, "idempotency-key");
    if (!idempotencyKey) throw new GatewayHttpError(400, "Idempotency-Key is required for trusted Frappe mission submission.");
    if (typeof mission.idempotencyKey !== "string" || !headerEquals(idempotencyKey, mission.idempotencyKey)) {
      throw new GatewayHttpError(409, "Idempotency-Key must match the trusted Frappe mission envelope.");
    }
    const submitted = await options.frappeMissionBridge.submit(mission, scope);
    response.setHeader("location", submitted.pollPath);
    response.setHeader("retry-after", "1");
    response.setHeader("cache-control", "private, no-store");
    sendJson(response, submitted.replayed ? 200 : 202, submitted);
    return;
  }

  const frappeMissionStatusMatch = url.pathname.match(new RegExp(`^${TRUSTED_FRAPPE_MISSIONS_PATH}/([^/]+)$`));
  if (request.method === "GET" && frappeMissionStatusMatch) {
    if (!options.frappeMissionBridge) throw new GatewayHttpError(503, "Trusted Frappe mission status is unavailable.");
    const { scope } = authenticatedFrappeRunScope(request, frappeAuthoritySecret);
    assertSiteBindingScope(siteBinding, scope);
    let missionId: string;
    try {
      missionId = decodeURIComponent(frappeMissionStatusMatch[1]);
    } catch {
      throw new GatewayHttpError(400, "Trusted Frappe mission path is invalid.");
    }
    const snapshot = await options.frappeMissionBridge.status(scope, missionId);
    if (!snapshot) {
      sendJson(response, 404, { error: "Mission was not found in the authenticated Frappe authority lane." });
      return;
    }
    response.setHeader("cache-control", "private, no-store");
    sendJson(response, 200, snapshot);
    return;
  }

  if (request.method === "POST" && url.pathname === FRAPPE_RUN_EVENTS_PATH) {
    if (!options.frappeRunEventStore) throw new GatewayHttpError(503, "Frappe run event storage is unavailable.");
    const authority = authenticatedFrappeRunScope(request, frappeAuthoritySecret);
    assertSiteBindingScope(siteBinding, authority.scope);
    const root = parseJsonRecord(await readBody(request), "Frappe run event append request");
    const scope = frappeRunScopeFromUnknown(root.scope);
    if (scope.tenantId !== authority.scope.tenantId || scope.siteId !== authority.scope.siteId || scope.userId !== authority.scope.userId) {
      throw new FrappeRunEventError("forbidden", "Frappe run append scope does not match the authenticated authority.");
    }
    if (!root.event || typeof root.event !== "object" || Array.isArray(root.event)) {
      throw new GatewayHttpError(400, "Frappe run event append request requires an event object.");
    }
    const event = root.event as FrappeRunEvent;
    const idempotencyKey = singleRequestHeader(request, "idempotency-key");
    if (!idempotencyKey) throw new GatewayHttpError(400, "Idempotency-Key is required for Frappe run event append.");
    if (typeof event.id !== "string" || !headerEquals(idempotencyKey, event.id)) {
      throw new GatewayHttpError(409, "Idempotency-Key must match the run event id.");
    }
    const result = await options.frappeRunEventStore.append({ scope, event });
    response.setHeader("cache-control", "private, no-store");
    sendJson(response, result.status === "appended" ? 201 : 200, result);
    return;
  }

  if (request.method === "GET" && url.pathname === FRAPPE_RUN_EVENTS_PATH) {
    if (!options.frappeRunEventStore) throw new GatewayHttpError(503, "Frappe run event storage is unavailable.");
    const { scope } = authenticatedFrappeRunScope(request, frappeAuthoritySecret);
    assertSiteBindingScope(siteBinding, scope);
    const limitValue = url.searchParams.get("limit");
    const limit = limitValue === null ? undefined : Number(limitValue);
    const page = await options.frappeRunEventStore.replay({
      scope,
      ...(url.searchParams.get("missionId") ? { missionId: url.searchParams.get("missionId")! } : {}),
      ...(url.searchParams.get("cursor") ? { cursor: url.searchParams.get("cursor")! } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(options.frappeRunEventCanRead ? { canRead: options.frappeRunEventCanRead } : {}),
    });
    response.setHeader("cache-control", "private, no-store");
    sendJson(response, 200, page);
    return;
  }

  const frappeRunCommandMatch = url.pathname.match(new RegExp(`^${FRAPPE_RUN_EVENTS_PATH}/missions/([^/]+)/commands$`));
  if (request.method === "POST" && frappeRunCommandMatch) {
    if (!options.frappeRunEventStore) throw new GatewayHttpError(503, "Frappe run event storage is unavailable.");
    if (!options.onFrappeRunCommand) throw new GatewayHttpError(503, "Frappe run control dispatch is unavailable.");
    const root = parseJsonRecord(await readBody(request), "Frappe run command request");
    const command = root as unknown as FrappeRunCommandRequest;
    let pathMissionId: string;
    try {
      pathMissionId = decodeURIComponent(frappeRunCommandMatch[1]);
    } catch {
      throw new GatewayHttpError(400, "Frappe run command mission path is invalid.");
    }
    if (command.missionId !== pathMissionId) throw new GatewayHttpError(409, "Run command mission does not match the request path.");
    const idempotencyKey = singleRequestHeader(request, "idempotency-key");
    if (!idempotencyKey) throw new GatewayHttpError(400, "Idempotency-Key is required for Frappe run control.");
    if (typeof command.idempotencyKey !== "string" || !headerEquals(idempotencyKey, command.idempotencyKey)) {
      throw new GatewayHttpError(409, "Idempotency-Key must match the run command envelope.");
    }
    const { scope, csrfToken } = authenticatedFrappeRunScope(request, frappeAuthoritySecret);
    assertSiteBindingScope(siteBinding, scope);
    const claimed = await options.frappeRunEventStore.claimCommand(command, {
      method: request.method,
      authenticatedScope: scope,
      expectedCsrfToken: csrfToken,
    });
    if (claimed.status === "conflict") {
      sendJson(response, 409, { error: "Idempotency-Key or command id was already used for different run control.", commandId: claimed.command.commandId });
      return;
    }
    // Dispatch both first delivery and replay. The graph runtime deduplicates by
    // the persisted command id/key, so a prior transient dispatch failure heals.
    await options.onFrappeRunCommand(claimed.command);
    response.setHeader("cache-control", "private, no-store");
    sendJson(response, claimed.status === "claimed" ? 202 : 200, { ...claimed, dispatched: true });
    return;
  }

  if (request.method === "POST" && url.pathname === "/v1/messages") {
    const body = await readBody(request);
    let message: SurfaceMessage;
    try {
      message = parseSurfaceMessage(JSON.parse(body));
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
      return;
    }
    const reply = await handleSurfaceMessage(message, { config: options.config, gateway: options.gateway, enterprise: options.enterprise, approvalStore: options.approvalStore, cwd, registry: options.registry, frappeOAuth: options.frappeOAuth, fetcher: options.fetcher });
    sendJson(response, 200, reply);
    return;
  }

  if (request.method === "POST" && url.pathname === TRUSTED_FRAPPE_ASYNC_PATH) {
    const { scope } = authenticatedFrappeRunScope(request, frappeAuthoritySecret);
    assertSiteBindingScope(siteBinding, scope);
    const body = await readBody(request);
    let ingress: ReturnType<typeof parseTrustedFrappeIngress>;
    try {
      ingress = parseTrustedFrappeIngress(JSON.parse(body));
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
      return;
    }
    if (siteBinding && normalizedHttpsOrigin(ingress.identity.site) !== siteBinding.siteOrigin) {
      sendJson(response, 403, { error: "Trusted Frappe identity site does not match the authenticated site binding." });
      return;
    }
    if (ingress.identity.user.trim().toLowerCase() !== scope.userId.trim().toLowerCase()) {
      sendJson(response, 403, { error: "Trusted Frappe identity user does not match the authenticated authority lane." });
      return;
    }
    const paired = await upsertTrustedFrappePairing(
      ingress.message.surfaceId,
      ingress.message.senderId,
      ingress.identity,
      cwd,
    );
    if (paired.identity?.provider !== "frappe") {
      sendJson(response, 500, { error: "Trusted Frappe identity could not be bound." });
      return;
    }
    const contextFingerprint = createHash("sha256")
      .update(JSON.stringify({ identity: ingress.identity, context: ingress.context }))
      .digest("hex");
    const message: SurfaceMessage = {
      ...ingress.message,
      pairingId: paired.pairingId,
      raw: { integration: "frappe", contextFingerprint },
    };
    const rawIdempotencyKey = request.headers["idempotency-key"];
    const idempotencyKey = (Array.isArray(rawIdempotencyKey) ? rawIdempotencyKey[0] : rawIdempotencyKey)?.trim();
    if (idempotencyKey && idempotencyKey.length > 200) {
      sendJson(response, 400, { error: "Idempotency-Key must contain at most 200 characters." });
      return;
    }
    const authorityScope = frappeAsyncAuthorityScope(scope);
    const isolatedArtifact = ingress.context.ask?.requestedOutcomes.includes("artifact") === true;
    // The opaque directory is allocated in the durable artifact store, but is
    // not created unless this idempotency claim owns execution. It is the sole
    // artifact root for the run and remains bound to authorityScope in SQLite.
    const isolatedArtifactRoot = join(dataDir(cwd), "artifacts", "frappe-ask", randomUUID());
    const artifactRoots = isolatedArtifact ? [isolatedArtifactRoot] : [];
    const started = await messageRuns.start(message, idempotencyKey, artifactRoots, (stream) => isolatedArtifact
      ? (options.frappeAskArtifactExecutor ?? runIsolatedFrappeAskArtifact)({
          config: options.config,
          prompt: message.text,
          evidence: ingress.context.summary,
          authority: scope,
          durableRoot: isolatedArtifactRoot,
          configuredMcpServers: Object.keys(options.config.tools?.mcp?.servers ?? {}),
          policyDeniedServers: options.gateway?.frappe?.providerTools?.denyInherited ?? [],
          nativeTransportOwner: options.nativeTransportOwner,
          // Stream only provider-visible progress, never the raw JSON manifest.
          onReasoningDelta: stream.onReasoningDelta,
        })
      : handleSurfaceMessage(message, {
          config: options.config,
          gateway: options.gateway,
          enterprise: options.enterprise,
          approvalStore: options.approvalStore,
          cwd,
          registry: options.registry,
          frappeOAuth: options.frappeOAuth,
          fetcher: options.fetcher,
          trustedFrappe: ingress.context,
          allowArtifacts: false,
          onDelta: stream.onDelta,
          onReasoningDelta: stream.onReasoningDelta,
        }), authorityScope);
    if (started.conflict) {
      sendJson(response, 409, { error: "Idempotency-Key was already used for a different Frappe request.", runId: started.snapshot.runId });
      return;
    }
    if (started.work) trackBackgroundTask(backgroundTasks, started.work);
    response.setHeader("location", `${TRUSTED_FRAPPE_ASYNC_RUNS_PATH}/${started.snapshot.runId}`);
    response.setHeader("retry-after", "1");
    sendJson(response, started.replayed ? 200 : 202, {
      ...started.snapshot,
      replayed: started.replayed,
      pollUrl: `${TRUSTED_FRAPPE_ASYNC_RUNS_PATH}/${started.snapshot.runId}`,
      pairingId: paired.pairingId,
    });
    return;
  }

  const trustedFrappeAsyncRunMatch = url.pathname.match(new RegExp(`^${TRUSTED_FRAPPE_ASYNC_RUNS_PATH}/(msg_[A-Za-z0-9-]+)$`));
  if (request.method === "GET" && trustedFrappeAsyncRunMatch) {
    const { scope } = authenticatedFrappeRunScope(request, frappeAuthoritySecret);
    assertSiteBindingScope(siteBinding, scope);
    const waitMs = Number(url.searchParams.get("waitMs") ?? 0);
    const snapshot = await messageRuns.read(
      trustedFrappeAsyncRunMatch[1],
      Number.isFinite(waitMs) ? waitMs : 0,
      frappeAsyncAuthorityScope(scope),
    );
    if (!snapshot) {
      sendJson(response, 404, { error: "Message run was not found in the authenticated Frappe authority lane." });
      return;
    }
    response.setHeader("cache-control", "private, no-store");
    if (snapshot.status === "queued" || snapshot.status === "running") response.setHeader("retry-after", "1");
    sendJson(response, 200, snapshot);
    return;
  }

  const trustedFrappeAsyncArtifactMatch = url.pathname.match(new RegExp(`^${TRUSTED_FRAPPE_ASYNC_RUNS_PATH}/(msg_[A-Za-z0-9-]+)/artifacts/(\\d+)$`));
  if (request.method === "GET" && trustedFrappeAsyncArtifactMatch) {
    const { scope } = authenticatedFrappeRunScope(request, frappeAuthoritySecret);
    assertSiteBindingScope(siteBinding, scope);
    const artifact = await messageRuns.readArtifact(
      trustedFrappeAsyncArtifactMatch[1],
      Number(trustedFrappeAsyncArtifactMatch[2]),
      frappeAsyncAuthorityScope(scope),
    );
    if (!artifact) {
      sendJson(response, 404, { error: "Run artifact was not found in the authenticated Frappe authority lane." });
      return;
    }
    const fallbackName = artifact.name.replace(/[^\x20-\x7E]+/g, "_").replace(/["\\]/g, "_") || "artifact";
    response.writeHead(200, {
      "cache-control": "private, no-store",
      "content-disposition": `attachment; filename="${fallbackName}"; filename*=UTF-8''${encodeURIComponent(artifact.name)}`,
      "content-length": String(artifact.bytes.length),
      "content-type": artifact.mime || "application/octet-stream",
    });
    response.end(artifact.bytes);
    return;
  }

  if (request.method === "POST" && url.pathname === "/v1/messages/async") {
    const body = await readBody(request);
    let message: SurfaceMessage;
    try {
      message = parseSurfaceMessage(JSON.parse(body));
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
      return;
    }
    const rawIdempotencyKey = request.headers["idempotency-key"];
    const idempotencyKey = (Array.isArray(rawIdempotencyKey) ? rawIdempotencyKey[0] : rawIdempotencyKey)?.trim();
    if (idempotencyKey && idempotencyKey.length > 200) {
      sendJson(response, 400, { error: "Idempotency-Key must contain at most 200 characters." });
      return;
    }
    const artifactRoots = [
      profileWorkspaceDir(cwd, activeProfile(cwd)),
      join(dataDir(cwd), "artifacts"),
    ];
    const started = await messageRuns.start(message, idempotencyKey, artifactRoots, (stream) => handleSurfaceMessage(message, {
      config: options.config,
      gateway: options.gateway,
      enterprise: options.enterprise,
      approvalStore: options.approvalStore,
      cwd,
      registry: options.registry,
      frappeOAuth: options.frappeOAuth,
      fetcher: options.fetcher,
      onDelta: stream.onDelta,
      onReasoningDelta: stream.onReasoningDelta,
    }));
    if (started.conflict) {
      sendJson(response, 409, { error: "Idempotency-Key was already used for a different message.", runId: started.snapshot.runId });
      return;
    }
    if (started.work) trackBackgroundTask(backgroundTasks, started.work);
    response.setHeader("location", `/v1/messages/runs/${started.snapshot.runId}`);
    response.setHeader("retry-after", "2");
    sendJson(response, started.replayed ? 200 : 202, {
      ...started.snapshot,
      replayed: started.replayed,
      pollUrl: `/v1/messages/runs/${started.snapshot.runId}`,
    });
    return;
  }

  const asyncMessageRunMatch = url.pathname.match(/^\/v1\/messages\/runs\/(msg_[A-Za-z0-9-]+)$/);
  if (request.method === "GET" && asyncMessageRunMatch) {
    const waitMs = Number(url.searchParams.get("waitMs") ?? 0);
    const snapshot = await messageRuns.read(asyncMessageRunMatch[1], Number.isFinite(waitMs) ? waitMs : 0);
    if (!snapshot) {
      sendJson(response, 404, { error: "Message run not found or expired." });
      return;
    }
    if (snapshot.status === "queued" || snapshot.status === "running") response.setHeader("retry-after", "2");
    sendJson(response, 200, snapshot);
    return;
  }

  const asyncMessageArtifactMatch = url.pathname.match(/^\/v1\/messages\/runs\/(msg_[A-Za-z0-9-]+)\/artifacts\/(\d+)$/);
  if (request.method === "GET" && asyncMessageArtifactMatch) {
    const artifact = await messageRuns.readArtifact(asyncMessageArtifactMatch[1], Number(asyncMessageArtifactMatch[2]));
    if (!artifact) {
      sendJson(response, 404, { error: "Run artifact not found, expired, or outside its verified workspace." });
      return;
    }
    const fallbackName = artifact.name.replace(/[^\x20-\x7E]+/g, "_").replace(/["\\]/g, "_") || "artifact";
    response.writeHead(200, {
      "cache-control": "private, no-store",
      "content-disposition": `attachment; filename="${fallbackName}"; filename*=UTF-8''${encodeURIComponent(artifact.name)}`,
      "content-length": String(artifact.bytes.length),
      "content-type": artifact.mime || "application/octet-stream",
    });
    response.end(artifact.bytes);
    return;
  }

  if (request.method === "GET" && (url.pathname === "/v1/catalog" || url.pathname === TRUSTED_FRAPPE_CATALOG_PATH)) {
    const skills = Object.entries(options.config.skills?.entries ?? {})
      .filter(([, entry]) => entry.enabled !== false)
      .map(([name]) => ({ name, label: name, description: "Available governed Muster skill" }));
    const mcpServers = Object.keys(options.config.tools?.mcp?.servers ?? {})
      .map((name) => ({ name, label: name, description: "Configured governed MCP server" }));
    sendJson(response, 200, {
      // This HTTP catalog is consumed by the trusted Frappe surface. Channel
      // adapters publish their own catalog and retain /pair for OAuth identity.
      commands: gatewayCommandCatalog(options.gateway).filter((entry) => !["pair", "connect"].includes(entry.name)),
      personas: gatewayAgentCatalog(options.config),
      // Only display metadata is published. Transport commands, URLs, headers,
      // environment, OAuth material, tool schemas, and secrets stay private.
      skills,
      mcp_servers: mcpServers,
      source: "muster_native_http",
    });
    return;
  }

  const flowMatch = url.pathname.match(/^\/v1\/flows\/([A-Za-z0-9_-]+)\/(approve|reject)$/);
  if (request.method === "POST" && flowMatch) {
    const [, runId, action] = flowMatch;
    const result = await resumeFlow(runId, {
      approve: action === "approve",
      config: options.config,
      registry: options.registry ?? defaultRegistry(),
      cwd,
    });
    sendJson(response, 200, {
      runId: result.runId,
      flowId: result.flowId,
      status: result.status,
      gateId: result.gateId,
      show: result.show,
      error: result.error,
    });
    return;
  }

  sendJson(response, 404, { error: `No route: ${request.method} ${url.pathname}` });
}

function adapterHasPlatformAuth(adapterId: string, gateway: GatewayConfig): boolean {
  if (adapterId === "telegram") return telegramChannel.hasPlatformAuth?.(gateway) ?? false;
  if (adapterId === "slack") return slackChannel.hasPlatformAuth?.(gateway) ?? false;
  return channelWebhookAdapter(adapterId)?.hasPlatformAuth?.(gateway) ?? false;
}

export function startGatewayServer(options: GatewayServerOptions, port = 0): Promise<RunningGateway> {
  const log = options.log ?? (() => {});
  const startupErrors = gatewayStartupErrors(options.gateway);
  if (startupErrors.length) throw new Error(`Gateway production security check failed: ${startupErrors.join("; ")}`);
  const cwd = options.cwd ?? process.cwd();
  const ownsEnterpriseRuntime = options.enterprise === undefined;
  const enterprise = options.enterprise ?? openSqliteGatewayEnterpriseRuntime(cwd);
  const gchatVerifier = options.gchatVerifier
    ?? (options.gateway.gchat?.verification?.mode === "bearer"
      ? createGoogleChatRequestVerifier({ fetcher: options.fetcher })
      : undefined);
  const ingress = options.ingress ?? new DurableGatewayIngress(enterprise.idempotencyStore, { defaultLeaseMs: 15 * 60_000 });
  const ingressSpool = options.ingressSpool ?? new DurableGatewayIngressSpool(
    join(dataDir(cwd), "gateway-ingress-spool"),
    createHash("sha256").update(`muster-ingress-spool:${options.gateway.token}`).digest(),
  );
  const ownsApprovalStore = options.approvalStore === undefined;
  const approvalStore = options.approvalStore ?? new SqliteApprovalActionStore(join(dataDir(cwd), "enterprise-control-plane.db"));
  const approvalActions = options.approvalActions ?? createApprovalActionCodec({
    secret: createHash("sha256").update(`muster-approval:${options.gateway.token}`).digest(),
    store: approvalStore,
  });
  const ownsMessageRunStore = options.messageRunStore === undefined;
  const messageRunStore = options.messageRunStore ?? new SqliteAsyncMessageRunStore(
    join(dataDir(cwd), "gateway-message-runs.db"),
  );
  const ownsFrappeRunEventStore = options.frappeRunEventStore === undefined;
  const frappeRunEventStore = options.frappeRunEventStore ?? new SqliteFrappeRunEventStore(
    join(dataDir(cwd), "frappe-run-events.db"),
  );
  const nativeTransportOwner = options.nativeTransportOwner ?? `gateway:${randomUUID()}`;
  const missionWorkspaceDir = profileWorkspaceDir(cwd, activeProfile(cwd));
  const frappeSiteBindings = options.frappeSiteBindings ?? new FrappeSiteBindingCoordinator({
    fetcher: options.fetcher,
    storePath: join(dataDir(cwd), "frappe-site-bindings.v1.enc.json"),
    encryptionSecret: options.gateway.token,
  });
  const readOnlyFrappeMissionExecutor = createGovernedFrappeMissionExecutor({
    config: options.config,
    cwd,
    workspaceDir: missionWorkspaceDir,
    nativeTransportOwner,
    inheritedToolDeny: [
      ...Object.keys(options.config.tools?.mcp?.servers ?? {}),
      ...(options.gateway.frappe?.providerTools?.denyInherited ?? []),
    ],
  });
  const frappeEffectTransport = options.frappeEffectTransport ?? createVerifiedBindingFrappeEffectTransport({
    bindings: frappeSiteBindings,
    fetcher: options.fetcher,
  });
  const ownsFrappeEffectStore = options.frappeEffectStore === undefined;
  const frappeEffectStore = options.frappeEffectStore
    ?? new SqliteGovernedFrappeEffectStore(join(dataDir(cwd), "governed-frappe-effects.db"));
  const effectfulFrappeMissionExecutor = options.frappeMissionExecutor
    ?? createEffectfulFrappeMissionExecutor({
      transport: frappeEffectTransport,
      store: frappeEffectStore,
      fallback: readOnlyFrappeMissionExecutor,
      policy: options.frappeEffectPolicy,
    });
  const browserConfig = options.gateway.frappe?.browserAutomation;
  const ownsFrappeBrowserAutomation = options.frappeBrowserAutomation === undefined && browserConfig?.enabled === true;
  const frappeBrowserAutomation = options.frappeBrowserAutomation
    ?? (browserConfig?.enabled === true
      ? createPlaywrightFrappeBrowserAutomationPort({
        evidence: new DirectoryFrappeBrowserScreenshotEvidenceStore(join(dataDir(cwd), "frappe-browser-evidence")),
        headless: browserConfig.headless,
        executablePath: browserConfig.executablePath,
        launchTimeoutMs: browserConfig.launchTimeoutMs,
        actionTimeoutMs: browserConfig.actionTimeoutMs,
      })
      : undefined);
  const frappeMissionExecutor = frappeBrowserAutomation
    ? createVerifiedBindingFrappeBrowserMissionExecutor({
      bindings: frappeSiteBindings,
      browser: frappeBrowserAutomation,
      fallback: effectfulFrappeMissionExecutor,
      maxActionsPerNode: browserConfig?.maxActionsPerNode,
      fetcher: options.fetcher,
    })
    : effectfulFrappeMissionExecutor;
  const ownsFrappeMissionBridge = options.frappeMissionBridge === undefined;
  const frappeMissionBridge = options.frappeMissionBridge
    ?? new DurableFrappeMissionBridge({ store: frappeRunEventStore, executeNode: frappeMissionExecutor });
  const frappeOAuthConnections = options.gateway.frappe?.oauth?.connections ?? [];
  const frappeOAuth = options.frappeOAuth ?? (frappeOAuthConnections.length
    ? new FrappeOAuthCoordinator({ connections: frappeOAuthConnections, cwd, fetcher: options.fetcher })
    : undefined);
  const ownsFrappeTelegramLinks = options.frappeTelegramLinks === undefined && options.gateway.frappe?.telegramLinking?.enabled === true;
  const frappeTelegramLinks = options.frappeTelegramLinks
    ?? (ownsFrappeTelegramLinks ? openSqliteFrappeTelegramLinkCoordinator(join(dataDir(cwd), "frappe-telegram-links.db")) : undefined);
  const effectiveOptions: GatewayServerOptions = {
    ...options,
    fetcher: options.fetcher ?? fetch,
    enterprise,
    gchatVerifier,
    ingress,
    ingressSpool,
    approvalStore,
    approvalActions,
    messageRunStore,
    frappeRunEventStore,
    frappeMissionBridge,
    frappeWorkflowPlanner: options.frappeWorkflowPlanner ?? createGovernedFrappeWorkflowPlanner({
      config: options.config,
      cwd,
      workspaceDir: missionWorkspaceDir,
      nativeTransportOwner,
      inheritedToolDeny: [
        ...Object.keys(options.config.tools?.mcp?.servers ?? {}),
        ...(options.gateway.frappe?.providerTools?.denyInherited ?? []),
      ],
    }),
    frappeReadPlanner: options.frappeReadPlanner ?? createGovernedFrappeReadPlanner({
      config: options.config,
      cwd,
      workspaceDir: missionWorkspaceDir,
      nativeTransportOwner,
      inheritedToolDeny: [
        ...Object.keys(options.config.tools?.mcp?.servers ?? {}),
        ...(options.gateway.frappe?.providerTools?.denyInherited ?? []),
      ],
    }),
    frappeAskIntentRouter: options.frappeAskIntentRouter ?? createGovernedFrappeAskIntentRouter({
      config: options.config,
      cwd,
      workspaceDir: missionWorkspaceDir,
      nativeTransportOwner,
      inheritedToolDeny: [
        ...Object.keys(options.config.tools?.mcp?.servers ?? {}),
        ...(options.gateway.frappe?.providerTools?.denyInherited ?? []),
      ],
    }),
    onFrappeRunCommand: options.onFrappeRunCommand
      ?? (frappeMissionBridge ? (command) => frappeMissionBridge.control(command) : undefined),
    nativeTransportOwner,
    frappeOAuth,
    frappeSiteBindings,
    frappeTelegramLinks,
  };
  // One outbound queue per gateway: chat keys share retry_after backoff state.
  const queue = createOutboundQueue();
  const backgroundTasks = new Set<Promise<void>>();
  const messageRuns = new AsyncMessageRunRegistry(messageRunStore);
  const frappeAskArtifactRoot = join(dataDir(cwd), "artifacts", "frappe-ask");
  const collectExpiredAskArtifacts = async (): Promise<void> => {
    const referencedRoots = await messageRunStore.listArtifactRoots(Date.now());
    await garbageCollectFrappeAskArtifacts({
      rootDir: frappeAskArtifactRoot,
      referencedRoots,
      minimumAgeMs: 60 * 60_000,
      maxEntries: 1_000,
    });
  };
  const artifactGcTimer = setInterval(() => {
    void collectExpiredAskArtifacts().catch((error) => log(`artifact GC failed closed: ${error instanceof Error ? error.message : String(error)}`));
  }, 15 * 60_000);
  artifactGcTimer.unref?.();
  const server = createServer((request, response) => {
    route(request, response, effectiveOptions, queue, backgroundTasks, messageRuns).catch((error) => {
      const detail = error instanceof Error ? error.message : String(error);
      const status = error instanceof GatewayHttpError
        ? error.status
        : error instanceof FrappeSiteBindingError
          ? error.status
        : error instanceof FrappeRunEventError
          ? frappeRunEventHttpStatus(error)
          : 500;
      log(`error ${request.method} ${request.url}: ${detail}`);
      if (!response.headersSent) sendJson(response, status, { error: detail });
      else response.end();
    });
  });
  return new Promise((resolvePromise, rejectPromise) => {
    let started = false;
    let cleaned = false;
    const cleanupOwnedResources = async (): Promise<void> => {
      if (cleaned) return;
      cleaned = true;
      if (server.listening) {
        await new Promise<void>((done) => server.close(() => done()));
      }
      clearInterval(artifactGcTimer);
      closeWarmProviderTransports(nativeTransportOwner);
      if (ownsMessageRunStore) await messageRunStore.close?.();
      if (ownsFrappeMissionBridge) await frappeMissionBridge?.close();
      if (ownsFrappeBrowserAutomation) await frappeBrowserAutomation?.close?.();
      if (ownsFrappeEffectStore) frappeEffectStore?.close();
      if (ownsFrappeRunEventStore) await frappeRunEventStore.close?.();
      if (ownsFrappeTelegramLinks) frappeTelegramLinks?.close();
      if (ownsApprovalStore) approvalStore.close();
      if (ownsEnterpriseRuntime) await enterprise.close?.();
    };
    const failStartup = (error: unknown): void => {
      if (started) return;
      void cleanupOwnedResources().then(
        () => rejectPromise(error),
        (cleanupError) => rejectPromise(new AggregateError([error, cleanupError], "Gateway startup and cleanup failed")),
      );
    };
    server.once("error", failStartup);
    collectExpiredAskArtifacts()
      .then(() => recoverPendingApprovals(effectiveOptions, approvalStore))
      .then(() => recoverIngressSpool(effectiveOptions, queue, ingressSpool))
      .then(() => server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const boundPort = typeof address === "object" && address ? address.port : port;
      started = true;
      log(`muster gateway listening on http://127.0.0.1:${boundPort}`);
      log(`enterprise ledger backend=${enterprise.backend}${enterprise.backend === "sqlite" ? " (durable local; inject an external store for multi-host deployment)" : ""}`);
      resolvePromise({
        port: boundPort,
        server,
        waitForIdle: () => waitForBackgroundTasks(backgroundTasks),
        close: async () => {
          try {
            await new Promise<void>((done, fail) => server.close((error) => (error ? fail(error) : done())));
            await waitForBackgroundTasks(backgroundTasks, 30_000);
          } finally {
            await cleanupOwnedResources();
          }
        },
      });
    })).catch(failStartup);
  });
}

function bearerFromRequest(request: IncomingMessage): string {
  const header = request.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) throw new FrappeSiteBindingError(401, "Frappe site binding bearer is required.");
  return token;
}

export function gatewayStartupErrors(gateway: GatewayConfig): readonly string[] {
  if (gateway.security?.deployment !== "production") return [];
  const errors: string[] = [];
  if (gateway.token.length < 32) errors.push("gateway bearer token must contain at least 32 characters");
  if (gateway.telegram?.botToken && !gateway.telegram.secretToken) errors.push("Telegram secretToken is required");
  if (gateway.frappe?.telegramLinking?.enabled) {
    const linking = gateway.frappe.telegramLinking;
    if (!gateway.telegram?.botToken || !telegramBotId(gateway.telegram.botToken)) errors.push("Frappe Telegram linking requires a Telegram bot token with a numeric bot id");
    if (!/^[A-Za-z0-9_]{5,32}$/.test(linking.botUsername)) errors.push("Frappe Telegram linking requires a valid botUsername");
    if (!linking.tenants.length) errors.push("Frappe Telegram linking requires at least one trusted tenant");
    const tenantIds = new Set<string>();
    for (const tenant of linking.tenants) {
      if (!tenant.id.trim() || tenantIds.has(tenant.id)) errors.push("Frappe Telegram tenant ids must be non-empty and unique");
      tenantIds.add(tenant.id);
      try { normalizedHttpsOrigin(tenant.site); } catch { errors.push(`Frappe Telegram tenant ${tenant.id || "<empty>"} requires a valid HTTPS site origin`); }
      if (!tenant.allowedScopes.length) errors.push(`Frappe Telegram tenant ${tenant.id || "<empty>"} requires at least one allowed scope`);
    }
  }
  if (gateway.frappe?.support) {
    try {
      const support = resolveFrappeSupportDestination(gateway.frappe.support);
      if (support.authMode === "oauth" && support.connectionId && !gateway.frappe.oauth?.connections.some((connection) => connection.id === support.connectionId)) {
        errors.push(`Frappe support connection ${support.connectionId} is not configured under frappe.oauth.connections`);
      }
    } catch {
      errors.push("Frappe support site must be a canonical HTTPS origin and use a supported ticket type");
    }
  }
  if (gateway.slack?.botToken) {
    const mode = gateway.slack.mode ?? (gateway.slack.appToken ? "socket" : "http");
    if (mode === "socket" && !gateway.slack.appToken) errors.push("Slack Socket Mode appToken is required");
    if (mode === "http" && !gateway.slack.signingSecret) errors.push("Slack HTTP signingSecret is required");
  }
  if (gateway.discord?.botToken && !gateway.discord.publicKey) errors.push("Discord publicKey is required");
  if (gateway["whatsapp-cloud"] && (!gateway["whatsapp-cloud"].appSecret || !gateway["whatsapp-cloud"].verifyToken)) errors.push("WhatsApp Cloud API appSecret and verifyToken are required");
  if (gateway.gchat) {
    const modern = gateway.gchat.verification?.mode === "bearer" && googleChatAudienceIsValid(gateway.gchat.verification.audience);
    const allowedLegacy = gateway.security.allowLegacyGchatToken && Boolean(gateway.gchat.verificationToken);
    if (!modern && !allowedLegacy) errors.push("Google Chat signed bearer verification requires a Cloud project number or the exact HTTPS /v1/adapters/gchat audience URL");
  }
  if (gateway.teams && !gateway.teams.hmacSecret) errors.push("Teams request verification is required");
  const ttl = gateway.approvals?.ttlSeconds;
  if (ttl !== undefined && (!Number.isSafeInteger(ttl) || ttl < 60 || ttl > 3600)) errors.push("approval ttlSeconds must be between 60 and 3600");
  return errors;
}
