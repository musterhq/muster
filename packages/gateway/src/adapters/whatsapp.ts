import { createRequire } from "node:module";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { isPairingChallenge } from "../envelope.js";
import type { PairingChallenge, SurfaceMessage, SurfaceReply } from "../envelope.js";
import { approvalFallbackText, renderPresentationText, sanitizePresentationForAudience } from "../presentation.js";

export type WhatsAppActivation = "mention" | "always";

export interface WhatsAppPersonalConfig {
  readonly account?: string;
  readonly activation?: WhatsAppActivation;
  /** Exact group JIDs. Empty blocks all groups; "*" allows every group. */
  readonly groups?: readonly string[];
  /** Exact participant JIDs. Empty allows every member of an allowed group. */
  readonly groupAllowFrom?: readonly string[];
  readonly sessionDir?: string;
}

export interface WhatsAppGroupPolicyInput {
  readonly groupJid: string;
  readonly participantJid: string;
  readonly groups: readonly string[];
  readonly groupAllowFrom?: readonly string[];
  readonly activation?: WhatsAppActivation;
  readonly mentionedJids?: readonly string[];
  readonly botJid?: string;
  readonly quotedParticipantJid?: string;
}

export type WhatsAppGroupPolicyDecision =
  | { readonly allowed: true; readonly activation: WhatsAppActivation }
  | { readonly allowed: false; readonly reason: "group_not_allowed" | "sender_not_allowed" | "mention_required" };

export interface WhatsAppWebMessage {
  readonly key?: {
    readonly id?: string | null;
    readonly remoteJid?: string | null;
    readonly participant?: string | null;
    readonly fromMe?: boolean | null;
  };
  readonly pushName?: string | null;
  readonly message?: WhatsAppMessageContent | null;
}

interface WhatsAppContextInfo {
  readonly stanzaId?: string | null;
  readonly participant?: string | null;
  readonly mentionedJid?: readonly string[] | null;
}

interface WhatsAppMessageContent {
  readonly conversation?: string | null;
  readonly extendedTextMessage?: { readonly text?: string | null; readonly contextInfo?: WhatsAppContextInfo | null } | null;
  readonly imageMessage?: { readonly caption?: string | null; readonly contextInfo?: WhatsAppContextInfo | null } | null;
  readonly videoMessage?: { readonly caption?: string | null; readonly contextInfo?: WhatsAppContextInfo | null } | null;
  readonly audioMessage?: {
    readonly mimetype?: string | null;
    readonly seconds?: number | null;
    readonly fileLength?: number | string | null;
    readonly ptt?: boolean | null;
    readonly contextInfo?: WhatsAppContextInfo | null;
  } | null;
  readonly ephemeralMessage?: { readonly message?: WhatsAppMessageContent | null } | null;
  readonly viewOnceMessage?: { readonly message?: WhatsAppMessageContent | null } | null;
  readonly viewOnceMessageV2?: { readonly message?: WhatsAppMessageContent | null } | null;
}

export interface WhatsAppInboundOptions {
  readonly account?: string;
  readonly botJid?: string;
  readonly groupSubject?: string;
}

export interface WhatsAppConnectionStatus {
  readonly state: "starting" | "qr" | "connecting" | "open" | "closed" | "logged_out" | "stopped";
  readonly account: string;
  readonly updatedAt: string;
  readonly cure?: string;
}

export interface WhatsAppDoctorResult {
  readonly account: string;
  readonly sessionDir: string;
  readonly sessionPresent: boolean;
  readonly credsAgeMs?: number;
  readonly connection: WhatsAppConnectionStatus["state"] | "offline_unknown";
  readonly detail: string;
}

export interface BaileysSocket {
  readonly ev: {
    on(event: string, listener: (...args: any[]) => void): void;
  };
  readonly user?: { readonly id?: string | null } | null;
  sendMessage(jid: string, content: { readonly text: string }): Promise<unknown>;
  groupMetadata(jid: string): Promise<{ readonly subject?: string | null }>;
  end(error?: Error): void;
}

export interface BaileysModule {
  readonly default: (options: Record<string, unknown>) => BaileysSocket;
  /** Media download for inbound voice notes. */
  readonly downloadMediaMessage?: (message: WhatsAppWebMessage, type: "buffer", options: Record<string, unknown>) => Promise<Uint8Array>;
  readonly useMultiFileAuthState: (directory: string) => Promise<{ readonly state: unknown; readonly saveCreds: () => Promise<void> }>;
  readonly fetchLatestBaileysVersion?: () => Promise<{ readonly version: readonly number[] }>;
}

export interface WhatsAppConnectionManagerOptions {
  readonly config: WhatsAppPersonalConfig;
  readonly cwd?: string;
  readonly signal?: AbortSignal;
  readonly log?: (line: string) => void;
  readonly onQr?: (payload: string) => void;
  readonly onMessage: (message: SurfaceMessage) => Promise<SurfaceReply | PairingChallenge>;
  /**
   * Hand admitted messages to the channel SDK instead of answering here.
   * `preAuthorized` is true when the group policy (not pairing) admitted it.
   */
  readonly onInbound?: (message: SurfaceMessage, inbound: WhatsAppWebMessage, meta: { readonly preAuthorized: boolean; readonly socket: BaileysSocket; readonly baileys: BaileysModule }) => void;
  readonly loadBaileys?: () => Promise<BaileysModule>;
  readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

const require = createRequire(import.meta.url);
const LOGIN_CURE = "run: muster channels login whatsapp";
const DEFAULT_ACCOUNT = "default";
const CONNECTION_FILE = "connection.json";

export const WHATSAPP_PERSONAL_WARNING = "warning: unofficial protocol; Meta ToS gray zone; the linked number can be banned — recommend a dedicated number.";

function canonicalJid(value: string | undefined): string {
  if (!value) return "";
  const [user = "", server = ""] = value.trim().toLowerCase().split("@");
  return server ? `${user.split(":")[0]}@${server}` : value.trim().toLowerCase();
}

function jidMatches(left: string | undefined, right: string | undefined): boolean {
  return Boolean(left && right && canonicalJid(left) === canonicalJid(right));
}

export function isWhatsAppGroupJid(jid: string | undefined): boolean {
  return Boolean(jid?.toLowerCase().endsWith("@g.us"));
}

export function whatsappGroupAllowed(groupJid: string, groups: readonly string[]): boolean {
  return groups.includes("*") || groups.some((candidate) => jidMatches(candidate, groupJid));
}

export function whatsappGroupSenderAllowed(participantJid: string, groupAllowFrom: readonly string[] = []): boolean {
  return groupAllowFrom.length === 0 || groupAllowFrom.includes("*") || groupAllowFrom.some((candidate) => jidMatches(candidate, participantJid));
}

export function whatsappGroupActivated(input: Pick<WhatsAppGroupPolicyInput, "activation" | "mentionedJids" | "botJid" | "quotedParticipantJid">): boolean {
  if ((input.activation ?? "mention") === "always") return true;
  return Boolean(
    input.mentionedJids?.some((jid) => jidMatches(jid, input.botJid)) ||
    jidMatches(input.quotedParticipantJid, input.botJid)
  );
}

/** OpenClaw ordering: group registry, then sender authorization, then activation. */
export function evaluateWhatsAppGroupPolicy(input: WhatsAppGroupPolicyInput): WhatsAppGroupPolicyDecision {
  if (!whatsappGroupAllowed(input.groupJid, input.groups)) return { allowed: false, reason: "group_not_allowed" };
  if (!whatsappGroupSenderAllowed(input.participantJid, input.groupAllowFrom)) return { allowed: false, reason: "sender_not_allowed" };
  const activation = input.activation ?? "mention";
  if (!whatsappGroupActivated(input)) return { allowed: false, reason: "mention_required" };
  return { allowed: true, activation };
}

function unwrapMessage(content: WhatsAppMessageContent | null | undefined): WhatsAppMessageContent | undefined {
  return content?.ephemeralMessage?.message ?? content?.viewOnceMessage?.message ?? content?.viewOnceMessageV2?.message ?? content ?? undefined;
}

function messageText(content: WhatsAppMessageContent | null | undefined): string | undefined {
  const message = unwrapMessage(content);
  const text = message?.conversation ?? message?.extendedTextMessage?.text ?? message?.imageMessage?.caption ?? message?.videoMessage?.caption;
  return typeof text === "string" && text.trim() ? text : undefined;
}

function contextInfo(content: WhatsAppMessageContent | null | undefined): WhatsAppContextInfo | undefined {
  const message = unwrapMessage(content);
  return message?.extendedTextMessage?.contextInfo ?? message?.imageMessage?.contextInfo ?? message?.videoMessage?.contextInfo ?? message?.audioMessage?.contextInfo ?? undefined;
}

/** Pure Baileys-message mapper. Group participant JIDs become senderId/actorId downstream. */
export function whatsAppWebMessageToSurfaceMessage(message: WhatsAppWebMessage, options: WhatsAppInboundOptions = {}): SurfaceMessage | undefined {
  const conversationId = message.key?.remoteJid ?? undefined;
  const text = messageText(message.message);
  if (!conversationId || !text || message.key?.fromMe) return undefined;
  const group = isWhatsAppGroupJid(conversationId);
  const senderId = group ? message.key?.participant ?? undefined : conversationId;
  if (!senderId) return undefined;
  const context = contextInfo(message.message);
  const displayMetadata = group && options.groupSubject ? { groupSubject: options.groupSubject } : undefined;
  return {
    surfaceId: `whatsapp:${options.account?.trim() || DEFAULT_ACCOUNT}`,
    conversationId,
    senderId,
    text,
    replyTo: context?.stanzaId ?? message.key?.id ?? undefined,
    raw: { message, ...(displayMetadata ? { displayMetadata } : {}) },
  };
}

/** Audio attachments carry this pseudo-url; the channel downloads them through Baileys. */
export const WHATSAPP_WEB_MEDIA_URL_PREFIX = "whatsapp-web:";

/** A voice note (or other audio) as an envelope attachment for the shared voice path. */
export function whatsAppWebAudioToSurfaceMessage(message: WhatsAppWebMessage, options: WhatsAppInboundOptions = {}): SurfaceMessage | undefined {
  const conversationId = message.key?.remoteJid ?? undefined;
  const audio = unwrapMessage(message.message)?.audioMessage;
  if (!conversationId || !audio || !message.key?.id || message.key.fromMe) return undefined;
  const group = isWhatsAppGroupJid(conversationId);
  const senderId = group ? message.key.participant ?? undefined : conversationId;
  if (!senderId) return undefined;
  const size = typeof audio.fileLength === "string" ? Number(audio.fileLength) : audio.fileLength ?? undefined;
  return {
    surfaceId: `whatsapp:${options.account?.trim() || DEFAULT_ACCOUNT}`,
    conversationId,
    senderId,
    text: "",
    attachments: [{
      name: audio.ptt ? "voice-note.ogg" : "audio.ogg",
      mime: audio.mimetype?.split(";")[0]?.trim() || "audio/ogg",
      url: `${WHATSAPP_WEB_MEDIA_URL_PREFIX}${message.key.id}`,
      ...(typeof audio.seconds === "number" ? { seconds: audio.seconds } : {}),
      ...(typeof size === "number" && Number.isFinite(size) ? { sizeBytes: size } : {}),
    }],
    replyTo: message.key.id,
    raw: { message, ...(group && options.groupSubject ? { displayMetadata: { groupSubject: options.groupSubject } } : {}) },
  };
}

export function whatsAppMessagePolicyInput(message: WhatsAppWebMessage, options: { readonly groups: readonly string[]; readonly groupAllowFrom?: readonly string[]; readonly activation?: WhatsAppActivation; readonly botJid?: string }): WhatsAppGroupPolicyInput | undefined {
  const groupJid = message.key?.remoteJid ?? undefined;
  const participantJid = message.key?.participant ?? undefined;
  if (!groupJid || !participantJid || !isWhatsAppGroupJid(groupJid)) return undefined;
  const context = contextInfo(message.message);
  return {
    groupJid,
    participantJid,
    groups: options.groups,
    groupAllowFrom: options.groupAllowFrom,
    activation: options.activation,
    mentionedJids: context?.mentionedJid ?? undefined,
    botJid: options.botJid,
    quotedParticipantJid: context?.participant ?? undefined,
  };
}

export function surfaceReplyToWhatsAppText(reply: SurfaceReply | PairingChallenge): string {
  if (isPairingChallenge(reply)) {
    return `This number is not paired with Muster yet. Ask an operator to run:\nmuster pairing approve ${reply.code}`;
  }
  if (reply.presentation) return renderPresentationText(sanitizePresentationForAudience(reply.presentation), { maxRowsPerTable: 5, maxCellWidth: 18 });
  if (reply.approvalRequest) {
    const shown = typeof reply.approvalRequest.show === "string" ? reply.approvalRequest.show : JSON.stringify(reply.approvalRequest.show, null, 2);
    return `${reply.text ? `${reply.text}\n\n` : ""}Approval required (gate "${reply.approvalRequest.gateId}", run ${reply.approvalRequest.runId}):\n${shown}\n\n${approvalFallbackText(false)}`;
  }
  return reply.text;
}

/** Ensures an unknown DM receives one challenge per process, not one per message. */
export class WhatsAppPairingChallengeTracker {
  readonly #challenged = new Set<string>();

  shouldSend(senderJid: string, reply: SurfaceReply | PairingChallenge): boolean {
    const sender = canonicalJid(senderJid);
    if (!isPairingChallenge(reply)) {
      this.#challenged.delete(sender);
      return true;
    }
    if (this.#challenged.has(sender)) return false;
    this.#challenged.add(sender);
    return true;
  }
}

export function whatsappSessionDir(config: WhatsAppPersonalConfig = {}, home = homedir()): string {
  const account = config.account?.trim() || DEFAULT_ACCOUNT;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(account)) throw new Error("WhatsApp account must use letters, numbers, dots, underscores, or hyphens.");
  if (config.sessionDir?.trim()) {
    const configured = config.sessionDir.trim();
    if (configured === "~") return home;
    if (configured.startsWith("~/")) return join(home, configured.slice(2));
    return isAbsolute(configured) ? configured : resolve(configured);
  }
  return join(home, ".muster", "whatsapp", account);
}

export async function prepareWhatsAppAuthState(config: WhatsAppPersonalConfig = {}, options: { readonly home?: string; readonly loadBaileys?: () => Promise<BaileysModule> } = {}): Promise<{ readonly directory: string; readonly state: unknown; readonly saveCreds: () => Promise<void> }> {
  const directory = whatsappSessionDir(config, options.home ?? homedir());
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const baileys = await (options.loadBaileys ?? loadBaileysModule)();
  const auth = await baileys.useMultiFileAuthState(directory);
  return { directory, ...auth };
}

async function writeConnectionStatus(directory: string, status: WhatsAppConnectionStatus): Promise<void> {
  await writeFile(join(directory, CONNECTION_FILE), `${JSON.stringify(status, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

export async function doctorWhatsApp(config: WhatsAppPersonalConfig = {}, options: { readonly home?: string; readonly now?: number } = {}): Promise<WhatsAppDoctorResult> {
  const account = config.account?.trim() || DEFAULT_ACCOUNT;
  const directory = whatsappSessionDir(config, options.home ?? homedir());
  const creds = await stat(join(directory, "creds.json")).catch(() => undefined);
  const status = await readFile(join(directory, CONNECTION_FILE), "utf8")
    .then((raw) => JSON.parse(raw) as WhatsAppConnectionStatus)
    .catch(() => undefined);
  const connection = status?.state ?? (creds ? "offline_unknown" : "logged_out");
  const detail = !creds
    ? `session missing; ${LOGIN_CURE}`
    : status?.state === "logged_out"
      ? `logged out; ${LOGIN_CURE}`
      : status
        ? `last recorded connection state: ${status.state}`
        : "credentials are present; connection state is unavailable while the gateway is offline";
  return {
    account,
    sessionDir: directory,
    sessionPresent: Boolean(creds),
    ...(creds ? { credsAgeMs: Math.max(0, (options.now ?? Date.now()) - creds.mtimeMs) } : {}),
    connection,
    detail,
  };
}

function silentLogger(): Record<string, unknown> {
  const logger: Record<string, unknown> = {};
  for (const level of ["trace", "debug", "info", "warn", "error", "fatal"]) logger[level] = () => undefined;
  logger.child = () => logger;
  return logger;
}

async function loadBaileysModule(): Promise<BaileysModule> {
  const moduleName = "@whiskeysockets/baileys";
  return await import(moduleName) as BaileysModule;
}

function disconnectStatusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const candidate = error as { readonly output?: { readonly statusCode?: unknown }; readonly statusCode?: unknown };
  return typeof candidate.output?.statusCode === "number"
    ? candidate.output.statusCode
    : typeof candidate.statusCode === "number" ? candidate.statusCode : undefined;
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolvePromise) => {
    const timer = setTimeout(resolvePromise, milliseconds);
    signal?.addEventListener("abort", () => { clearTimeout(timer); resolvePromise(); }, { once: true });
  });
}

export class WhatsAppConnectionManager {
  readonly #options: WhatsAppConnectionManagerOptions;
  readonly #pairingChallenges = new WhatsAppPairingChallengeTracker();
  #socket?: BaileysSocket;
  #stopped = false;
  #pendingCreds: Promise<void> = Promise.resolve();
  #readyResolve?: () => void;
  #readyReject?: (error: Error) => void;
  readonly #ready: Promise<void>;

  constructor(options: WhatsAppConnectionManagerOptions) {
    this.#options = options;
    this.#ready = new Promise<void>((resolvePromise, rejectPromise) => {
      this.#readyResolve = resolvePromise;
      this.#readyReject = rejectPromise;
    });
  }

  waitUntilReady(): Promise<void> { return this.#ready; }

  /** The current linked-device socket, while connected. */
  get socket(): BaileysSocket | undefined { return this.#socket; }

  stop(): void {
    this.#stopped = true;
    this.#socket?.end(new Error("Muster WhatsApp connection stopped."));
  }

  async run(): Promise<void> {
    const account = this.#options.config.account?.trim() || DEFAULT_ACCOUNT;
    const loadBaileys = this.#options.loadBaileys ?? loadBaileysModule;
    const auth = await prepareWhatsAppAuthState(this.#options.config, { loadBaileys });
    let attempt = 0;
    await writeConnectionStatus(auth.directory, { state: "starting", account, updatedAt: new Date().toISOString() });
    while (!this.#stopped && !this.#options.signal?.aborted) {
      const result = await this.#connectOnce(loadBaileys, auth);
      if (result === "logged_out") {
        const error = new Error(`WhatsApp linked device is logged out; ${LOGIN_CURE}`);
        this.#readyReject?.(error);
        this.#options.log?.(error.message);
        return;
      }
      if (this.#stopped || this.#options.signal?.aborted) break;
      attempt += 1;
      const delay = Math.min(30_000, 1_000 * 2 ** Math.min(attempt - 1, 5));
      this.#options.log?.(`whatsapp connection closed; reconnecting in ${delay}ms`);
      await (this.#options.sleep ?? abortableDelay)(delay, this.#options.signal);
    }
    await writeConnectionStatus(auth.directory, { state: "stopped", account, updatedAt: new Date().toISOString() });
  }

  async #connectOnce(loadBaileys: () => Promise<BaileysModule>, auth: { readonly directory: string; readonly state: unknown; readonly saveCreds: () => Promise<void> }): Promise<"closed" | "logged_out"> {
    const account = this.#options.config.account?.trim() || DEFAULT_ACCOUNT;
    const baileys = await loadBaileys();
    const version = await baileys.fetchLatestBaileysVersion?.().then((value) => value.version).catch(() => undefined);
    const socket = baileys.default({ auth: auth.state, printQRInTerminal: false, markOnlineOnConnect: false, syncFullHistory: false, logger: silentLogger(), ...(version ? { version } : {}) });
    this.#socket = socket;
    socket.ev.on("creds.update", () => {
      this.#pendingCreds = this.#pendingCreds.then(auth.saveCreds);
    });
    socket.ev.on("messages.upsert", (event: { readonly type?: string; readonly messages?: readonly WhatsAppWebMessage[] }) => {
      if (event.type !== "notify") return;
      for (const message of event.messages ?? []) void this.#handleInbound(socket, message, baileys);
    });
    return await new Promise<"closed" | "logged_out">((resolvePromise) => {
      socket.ev.on("connection.update", (update: { readonly connection?: string; readonly qr?: string; readonly lastDisconnect?: { readonly error?: unknown } }) => {
        if (update.qr) {
          this.#options.onQr?.(update.qr);
          void writeConnectionStatus(auth.directory, { state: "qr", account, updatedAt: new Date().toISOString() });
        }
        if (update.connection === "connecting") void writeConnectionStatus(auth.directory, { state: "connecting", account, updatedAt: new Date().toISOString() });
        if (update.connection === "open") {
          void writeConnectionStatus(auth.directory, { state: "open", account, updatedAt: new Date().toISOString() });
          void this.#pendingCreds.then(() => this.#readyResolve?.(), (error: unknown) => this.#readyReject?.(error instanceof Error ? error : new Error(String(error))));
          this.#options.log?.(`whatsapp connected account=${account}`);
        }
        if (update.connection === "close") {
          const loggedOut = disconnectStatusCode(update.lastDisconnect?.error) === 401;
          void writeConnectionStatus(auth.directory, {
            state: loggedOut ? "logged_out" : "closed",
            account,
            updatedAt: new Date().toISOString(),
            ...(loggedOut ? { cure: LOGIN_CURE } : {}),
          });
          resolvePromise(loggedOut ? "logged_out" : "closed");
        }
      });
    });
  }

  async #handleInbound(socket: BaileysSocket, inbound: WhatsAppWebMessage, baileys: BaileysModule): Promise<void> {
    const remoteJid = inbound.key?.remoteJid ?? undefined;
    if (!remoteJid || inbound.key?.fromMe) return;
    const botJid = socket.user?.id ?? undefined;
    let groupSubject: string | undefined;
    if (isWhatsAppGroupJid(remoteJid)) {
      const policyInput = whatsAppMessagePolicyInput(inbound, {
        groups: this.#options.config.groups ?? [],
        groupAllowFrom: this.#options.config.groupAllowFrom,
        activation: this.#options.config.activation,
        botJid,
      });
      if (!policyInput || !evaluateWhatsAppGroupPolicy(policyInput).allowed) return;
      groupSubject = await socket.groupMetadata(remoteJid).then((metadata) => metadata.subject ?? undefined).catch(() => undefined);
    }
    if (this.#options.onInbound) {
      const message = whatsAppWebMessageToSurfaceMessage(inbound, { account: this.#options.config.account, botJid, groupSubject })
        ?? whatsAppWebAudioToSurfaceMessage(inbound, { account: this.#options.config.account, groupSubject });
      if (message) this.#options.onInbound(message, inbound, { preAuthorized: isWhatsAppGroupJid(remoteJid), socket, baileys });
      return;
    }
    const message = whatsAppWebMessageToSurfaceMessage(inbound, { account: this.#options.config.account, botJid, groupSubject });
    if (!message) return;
    const reply = await this.#options.onMessage(message);
    if (!this.#pairingChallenges.shouldSend(message.senderId, reply)) return;
    await socket.sendMessage(message.conversationId, { text: surfaceReplyToWhatsAppText(reply) });
  }
}

export async function runWhatsAppConnection(options: WhatsAppConnectionManagerOptions): Promise<void> {
  await new WhatsAppConnectionManager(options).run();
}

export interface WhatsAppLoginOptions {
  readonly config: WhatsAppPersonalConfig;
  readonly onQr: (payload: string) => void;
  readonly log?: (line: string) => void;
  readonly loadBaileys?: () => Promise<BaileysModule>;
  readonly signal?: AbortSignal;
}

export async function loginWhatsApp(options: WhatsAppLoginOptions): Promise<void> {
  const manager = new WhatsAppConnectionManager({
    ...options,
    onMessage: async () => ({ text: "WhatsApp linked-device login is still in progress." }),
  });
  const running = manager.run();
  try {
    await manager.waitUntilReady();
  } finally {
    manager.stop();
    await running.catch((error) => {
      if (!(error instanceof Error) || !error.message.includes("stopped")) throw error;
    });
  }
}

export function renderWhatsAppQr(payload: string, isTTY: boolean): string {
  if (!isTTY) return `WhatsApp QR payload: ${payload}\nOpen WhatsApp → Linked devices → Link a device, then render this payload as a QR code on a trusted screen.`;
  const qrcode = require("qrcode-terminal") as { generate(value: string, options: { readonly small: boolean }, callback: (rendered: string) => void): void };
  let rendered = "";
  qrcode.generate(payload, { small: true }, (value) => { rendered = value; });
  return rendered;
}
