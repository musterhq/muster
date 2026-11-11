import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { parseSurfaceMessage, type PairingChallenge, type SurfaceMessage, type SurfaceReply } from "./envelope.js";
import {
  createGatewayIngressFingerprint,
  parseGatewayIngressFingerprint,
  type GatewayIngressIdentity,
  type GatewayIngressOwnership,
} from "./durable-ingress.js";

const MAX_SPOOLED_BODY_BYTES = 1_000_000;
const MAX_PREPARED_BYTES = 2_000_000;
const ASYNC_ADAPTERS = new Set(["telegram", "slack", "whatsapp-cloud", "teams", "gchat"]);

/** Adapters that may acknowledge a webhook before the turn finishes (spooled for crash recovery). */
export type GatewayAsyncAdapterId = "telegram" | "slack" | "whatsapp-cloud" | "teams" | "gchat";

export function isGatewayAsyncAdapterId(adapterId: string): adapterId is GatewayAsyncAdapterId {
  return ASYNC_ADAPTERS.has(adapterId);
}
export type GatewayIngressSpoolState =
  | "accepted"
  | "execution-completed"
  | "send-attempted"
  | "unknown-after-send"
  | "platform-delivered";

export interface GatewayPreparedDelivery {
  readonly message: SurfaceMessage;
  readonly reply: SurfaceReply | PairingChallenge;
}

export interface GatewayIngressSpoolEntry {
  readonly schemaVersion: 2;
  readonly adapterId: GatewayAsyncAdapterId;
  readonly ownership: GatewayIngressOwnership;
  readonly body: string;
  readonly state: GatewayIngressSpoolState;
  readonly preparedDeliveries: readonly GatewayPreparedDelivery[];
  readonly receivedAt: string;
  readonly ownerHost: string;
  readonly ownerPid: number;
  readonly updatedAt: string;
  readonly integrityMac: string;
}

export interface GatewayIngressSpoolSnapshot {
  readonly entries: readonly GatewayIngressSpoolEntry[];
  readonly rejectedFiles: number;
}

/** Local write-ahead spool for channel payloads acknowledged before provider work. */
export class DurableGatewayIngressSpool {
  readonly #rootDir: string;
  readonly #integrityKey: Buffer;
  readonly #ownerHost: string;
  readonly #ownerPid: number;

  constructor(
    rootDir: string,
    integrityKey: string | Buffer,
    owner: { readonly host?: string; readonly pid?: number } = {},
  ) {
    this.#rootDir = rootDir;
    const key = Buffer.isBuffer(integrityKey) ? Buffer.from(integrityKey) : Buffer.from(integrityKey, "utf8");
    if (key.byteLength < 16) throw new Error("Gateway ingress spool integrity key must contain at least 16 bytes.");
    this.#integrityKey = key;
    this.#ownerHost = owner.host ?? hostname();
    this.#ownerPid = owner.pid ?? process.pid;
    if (!this.#ownerHost || this.#ownerHost.length > 255 || !Number.isSafeInteger(this.#ownerPid) || this.#ownerPid <= 0) {
      throw new Error("Gateway ingress spool owner identity is invalid.");
    }
  }

  async put(input: {
    readonly adapterId: GatewayAsyncAdapterId;
    readonly ownership: GatewayIngressOwnership;
    readonly body: string;
  }): Promise<GatewayIngressSpoolEntry> {
    const now = new Date().toISOString();
    const entry = this.#seal({
      schemaVersion: 2,
      adapterId: input.adapterId,
      ownership: input.ownership,
      body: input.body,
      state: "accepted",
      preparedDeliveries: [],
      receivedAt: now,
      ownerHost: this.#ownerHost,
      ownerPid: this.#ownerPid,
      updatedAt: now,
    });
    await this.#write(entry);
    return entry;
  }

  async markExecutionCompleted(
    ownership: GatewayIngressOwnership,
    preparedDeliveries: readonly GatewayPreparedDelivery[],
  ): Promise<GatewayIngressSpoolEntry> {
    const current = await this.#read(ownership);
    assertState(current, ["accepted", "execution-completed"]);
    return this.#update(current, "execution-completed", preparedDeliveries);
  }

  async markSendAttempted(ownership: GatewayIngressOwnership): Promise<GatewayIngressSpoolEntry> {
    const current = await this.#read(ownership);
    assertState(current, ["execution-completed", "send-attempted"]);
    return this.#update(current, "send-attempted", current.preparedDeliveries);
  }

  async markUnknownAfterSend(ownership: GatewayIngressOwnership): Promise<GatewayIngressSpoolEntry> {
    const current = await this.#read(ownership);
    assertState(current, ["send-attempted", "unknown-after-send"]);
    return this.#update(current, "unknown-after-send", current.preparedDeliveries);
  }

  async markDeliveryRejected(ownership: GatewayIngressOwnership): Promise<GatewayIngressSpoolEntry> {
    const current = await this.#read(ownership);
    assertState(current, ["send-attempted"]);
    return this.#update(current, "execution-completed", current.preparedDeliveries);
  }

  async markPlatformDelivered(ownership: GatewayIngressOwnership): Promise<GatewayIngressSpoolEntry> {
    const current = await this.#read(ownership);
    assertState(current, ["accepted", "execution-completed", "send-attempted", "platform-delivered"]);
    return this.#update(current, "platform-delivered", current.preparedDeliveries);
  }

  async reassignOwnership(
    previous: GatewayIngressOwnership,
    next: GatewayIngressOwnership,
  ): Promise<GatewayIngressSpoolEntry> {
    const current = await this.#read(previous);
    if (current.ownership.claimToken !== previous.claimToken) throw new Error("Gateway spool ownership generation changed.");
    const updated = this.#seal({
      ...current,
      ownership: next,
      ownerHost: this.#ownerHost,
      ownerPid: this.#ownerPid,
      updatedAt: new Date().toISOString(),
      integrityMac: undefined,
    });
    await this.#write(updated);
    return updated;
  }

  async remove(identity: GatewayIngressIdentity): Promise<void> {
    await unlink(this.#path(identity)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }

  async find(identity: GatewayIngressIdentity): Promise<GatewayIngressSpoolEntry | undefined> {
    try {
      return await this.#read(identity);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async snapshot(): Promise<GatewayIngressSpoolSnapshot> {
    await this.#ensureRoot();
    const entries: GatewayIngressSpoolEntry[] = [];
    let rejectedFiles = 0;
    for (const item of await readdir(this.#rootDir, { withFileTypes: true })) {
      if (!item.isFile() || !item.name.endsWith(".json")) continue;
      const path = join(this.#rootDir, item.name);
      try {
        const entry = this.#validate(JSON.parse(await readFile(path, "utf8")));
        if (spoolFilename(entry.ownership) !== item.name) throw new Error("Spool filename does not match its delivery identity.");
        entries.push(entry);
      } catch {
        rejectedFiles += 1;
        await rename(path, `${path}.rejected-${Date.now()}-${randomUUID()}`).catch(() => undefined);
      }
    }
    entries.sort((left, right) => left.receivedAt.localeCompare(right.receivedAt));
    return { entries, rejectedFiles };
  }

  async #update(
    current: GatewayIngressSpoolEntry,
    state: GatewayIngressSpoolState,
    preparedDeliveries: readonly GatewayPreparedDelivery[],
  ): Promise<GatewayIngressSpoolEntry> {
    const updated = this.#seal({
      ...current,
      state,
      preparedDeliveries,
      updatedAt: new Date().toISOString(),
      integrityMac: undefined,
    });
    await this.#write(updated);
    return updated;
  }

  async #read(identity: GatewayIngressIdentity): Promise<GatewayIngressSpoolEntry> {
    return this.#validate(JSON.parse(await readFile(this.#path(identity), "utf8")));
  }

  async #write(entry: GatewayIngressSpoolEntry): Promise<void> {
    await this.#ensureRoot();
    const target = this.#path(entry.ownership);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, target);
    await chmod(target, 0o600).catch(() => undefined);
  }

  async #ensureRoot(): Promise<void> {
    await mkdir(this.#rootDir, { recursive: true, mode: 0o700 });
    await chmod(this.#rootDir, 0o700).catch(() => undefined);
  }

  #path(identity: GatewayIngressIdentity): string {
    return join(this.#rootDir, spoolFilename(identity));
  }

  #seal(value: Omit<GatewayIngressSpoolEntry, "integrityMac"> & { readonly integrityMac?: undefined }): GatewayIngressSpoolEntry {
    const normalized = normalizeEntry(value);
    return Object.freeze({ ...normalized, integrityMac: entryMac(normalized, this.#integrityKey) });
  }

  #validate(value: unknown): GatewayIngressSpoolEntry {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Spool entry must be an object.");
    const candidate = value as Partial<GatewayIngressSpoolEntry>;
    const normalized = normalizeEntry(candidate);
    if (typeof candidate.integrityMac !== "string" || !macEquals(candidate.integrityMac, entryMac(normalized, this.#integrityKey))) {
      throw new Error("Spool entry integrity check failed.");
    }
    return Object.freeze({ ...normalized, integrityMac: candidate.integrityMac });
  }
}

export function spoolOwnerIsDeadOnThisHost(entry: GatewayIngressSpoolEntry): boolean {
  if (entry.ownerHost !== hostname()) return false;
  if (entry.ownerPid === process.pid) return false;
  try {
    process.kill(entry.ownerPid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

function spoolFilename(identity: GatewayIngressIdentity): string {
  return `${createHash("sha256").update(identity.scope).update("\0").update(identity.deliveryId).digest("hex")}.json`;
}

function normalizeEntry(value: Partial<GatewayIngressSpoolEntry>): Omit<GatewayIngressSpoolEntry, "integrityMac"> {
  if (value.schemaVersion !== 2) throw new Error("Unsupported spool schema version.");
  if (typeof value.adapterId !== "string" || !ASYNC_ADAPTERS.has(value.adapterId)) throw new Error("Unsupported spool adapter.");
  if (typeof value.body !== "string" || Buffer.byteLength(value.body, "utf8") > MAX_SPOOLED_BODY_BYTES) throw new Error("Spool body is invalid or too large.");
  if (!["accepted", "execution-completed", "send-attempted", "unknown-after-send", "platform-delivered"].includes(String(value.state))) {
    throw new Error("Spool state is invalid.");
  }
  if (!validTimestamp(value.receivedAt) || !validTimestamp(value.updatedAt)) throw new Error("Spool timestamps are invalid.");
  if (typeof value.ownerHost !== "string" || !value.ownerHost || value.ownerHost.length > 255) throw new Error("Spool owner host is invalid.");
  if (!Number.isSafeInteger(value.ownerPid) || (value.ownerPid as number) <= 0) throw new Error("Spool owner pid is invalid.");
  const ownership = value.ownership;
  if (!ownership || typeof ownership.scope !== "string" || !ownership.scope || ownership.scope.length > 512) throw new Error("Spool scope is invalid.");
  if (typeof ownership.deliveryId !== "string" || !ownership.deliveryId || ownership.deliveryId.length > 512) throw new Error("Spool delivery id is invalid.");
  if (typeof ownership.claimToken !== "string" || !ownership.claimToken || ownership.claimToken.length > 256) throw new Error("Spool claim token is invalid.");
  const fingerprint = parseGatewayIngressFingerprint(ownership.fingerprint);
  const expectedFingerprint = createGatewayIngressFingerprint([value.adapterId, ownership.deliveryId, value.body]);
  if (fingerprint !== expectedFingerprint) throw new Error("Spool body does not match its ingress fingerprint.");
  const preparedDeliveries = normalizePrepared(value.preparedDeliveries ?? []);
  if (!["accepted", "platform-delivered"].includes(String(value.state)) && preparedDeliveries.length === 0) {
    throw new Error("Spool execution state requires a prepared delivery.");
  }
  return Object.freeze({
    schemaVersion: 2,
    adapterId: value.adapterId as GatewayAsyncAdapterId,
    ownership: Object.freeze({ scope: ownership.scope, deliveryId: ownership.deliveryId, fingerprint, claimToken: ownership.claimToken }),
    body: value.body,
    state: value.state as GatewayIngressSpoolState,
    preparedDeliveries,
    receivedAt: value.receivedAt as string,
    ownerHost: value.ownerHost,
    ownerPid: value.ownerPid as number,
    updatedAt: value.updatedAt as string,
  });
}

function normalizePrepared(value: readonly GatewayPreparedDelivery[]): readonly GatewayPreparedDelivery[] {
  if (!Array.isArray(value) || value.length > 32) throw new Error("Spool prepared deliveries are invalid.");
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_PREPARED_BYTES) throw new Error("Spool prepared deliveries are too large.");
  return Object.freeze(value.map((item) => {
    if (typeof item !== "object" || item === null) throw new Error("Spool prepared delivery is invalid.");
    const parsed = item as Partial<GatewayPreparedDelivery>;
    const message = parseSurfaceMessage(parsed.message);
    const reply = parsed.reply;
    if (typeof reply !== "object" || reply === null) throw new Error("Spool prepared reply is invalid.");
    if ((reply as PairingChallenge).status === "pairing_required") {
      if (typeof (reply as PairingChallenge).code !== "string" || !(reply as PairingChallenge).code) throw new Error("Spool pairing challenge is invalid.");
    } else if (typeof (reply as SurfaceReply).text !== "string") {
      throw new Error("Spool surface reply is invalid.");
    }
    return Object.freeze({ message: Object.freeze({ ...message, raw: undefined }), reply: Object.freeze({ ...reply }) });
  }));
}

function entryMac(entry: Omit<GatewayIngressSpoolEntry, "integrityMac">, key: Buffer): string {
  return createHmac("sha256", key).update(JSON.stringify(entry)).digest("hex");
}

function macEquals(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(left) || left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function assertState(entry: GatewayIngressSpoolEntry, allowed: readonly GatewayIngressSpoolState[]): void {
  if (!allowed.includes(entry.state)) throw new Error(`Illegal gateway spool transition from ${entry.state}.`);
}

function validTimestamp(value: unknown): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
