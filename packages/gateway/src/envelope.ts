/**
 * Surface gateway envelope (docs/SURFACE_GATEWAY_SPEC.md): the ONE contract
 * every surface adapter translates to and from. The harness never learns a
 * channel API; it only sees SurfaceMessage in and SurfaceReply out.
 */

export interface SurfaceAttachment {
  readonly name: string;
  readonly mime: string;
  /** Exactly one of url or bytes (base64) should be present. */
  readonly url?: string;
  readonly bytes?: string;
  /** Audio length when the platform reports it (voice notes); checked before download. */
  readonly seconds?: number;
  /** File size when the platform reports it; checked before download. */
  readonly sizeBytes?: number;
}

/** Set by the shared voice path when the prompt came from speech. */
export interface SurfaceVoiceMarker {
  readonly seconds?: number;
  readonly transcript: string;
}

export interface SurfaceMessage {
  /** e.g. "slack:T024BE7LD", "telegram:bot", "web:app-7" */
  readonly surfaceId: string;
  /** channel / thread / DM id, surface-native */
  readonly conversationId: string;
  /** surface-native sender id */
  readonly senderId: string;
  /** resolved Muster identity (set after pairing) */
  readonly pairingId?: string;
  readonly text: string;
  readonly attachments?: readonly SurfaceAttachment[];
  /** Present when `text` is the transcript of a voice note (docs/spec/clauses/21-voice.md). */
  readonly voice?: SurfaceVoiceMarker;
  readonly replyTo?: string;
  /**
   * Delivery mode for the reply: "off" (default) answers with one buffered
   * message; "draft" streams a live-edited draft via the surface's DraftSink
   * (packages/core/src/stream.ts runDraftLoop) where the adapter supports it.
   */
  readonly stream?: "off" | "draft";
  /** original payload; never parsed by core */
  readonly raw?: unknown;
}

export interface SurfaceArtifact {
  readonly name: string;
  readonly mime: string;
  readonly path: string;
  /** Optional host-verified integrity binding for durable run artifacts. */
  readonly sizeBytes?: number;
  readonly sha256?: string;
}

export interface ApprovalRequest {
  readonly runId: string;
  readonly gateId: string;
  readonly show: unknown;
  readonly options: readonly ["approve", "reject"];
}

export interface SurfaceReply {
  readonly text: string;
  readonly artifacts?: readonly SurfaceArtifact[];
  readonly approvalRequest?: ApprovalRequest;
  /** Optional rich interaction; text remains the canonical accessible fallback. */
  readonly presentation?: import("./presentation.js").SurfacePresentation;
}

/** Returned instead of a reply when the sender has not been paired yet. */
export interface PairingChallenge {
  readonly status: "pairing_required";
  readonly code: string;
}

export function isPairingChallenge(value: SurfaceReply | PairingChallenge): value is PairingChallenge {
  return (value as PairingChallenge).status === "pairing_required";
}

/**
 * Provider session lane. Group conversations are split by sender so one user
 * cannot inherit another user's provider history. Callers without a sender id
 * retain the legacy conversation-only key for migration/inspection tooling.
 */
export function conversationSessionId(
  message: Pick<SurfaceMessage, "surfaceId" | "conversationId"> & Partial<Pick<SurfaceMessage, "senderId">>,
): string {
  const conversation = `${message.surfaceId}:${message.conversationId}`;
  return message.senderId ? `${conversation}:sender:${message.senderId}` : conversation;
}

export function parseSurfaceMessage(value: unknown): SurfaceMessage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Surface message must be a JSON object.");
  }
  const message = value as Partial<SurfaceMessage> & Record<string, unknown>;
  for (const field of ["surfaceId", "conversationId", "senderId", "text"] as const) {
    if (typeof message[field] !== "string" || !message[field]!.trim()) {
      throw new Error(`Surface message requires a non-empty string "${field}".`);
    }
  }
  if (message.pairingId !== undefined && typeof message.pairingId !== "string") {
    throw new Error('Surface message "pairingId" must be a string when present.');
  }
  if (message.replyTo !== undefined && typeof message.replyTo !== "string") {
    throw new Error('Surface message "replyTo" must be a string when present.');
  }
  if (message.stream !== undefined && message.stream !== "off" && message.stream !== "draft") {
    throw new Error('Surface message "stream" must be "off" or "draft" when present.');
  }
  if (message.attachments !== undefined) {
    if (!Array.isArray(message.attachments)) {
      throw new Error('Surface message "attachments" must be an array when present.');
    }
    for (const attachment of message.attachments) {
      if (
        typeof attachment !== "object" || attachment === null ||
        typeof (attachment as SurfaceAttachment).name !== "string" ||
        typeof (attachment as SurfaceAttachment).mime !== "string"
      ) {
        throw new Error("Each attachment requires string name and mime.");
      }
    }
  }
  return {
    surfaceId: message.surfaceId as string,
    conversationId: message.conversationId as string,
    senderId: message.senderId as string,
    pairingId: message.pairingId,
    text: message.text as string,
    attachments: message.attachments as SurfaceAttachment[] | undefined,
    replyTo: message.replyTo,
    stream: message.stream,
    raw: message.raw,
  };
}
