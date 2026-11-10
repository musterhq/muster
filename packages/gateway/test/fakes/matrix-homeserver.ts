import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { setTimeout as delay } from "node:timers/promises";

/**
 * A small Matrix client-server API fake: /sync long-poll, room send, join,
 * whoami and media upload. Enough to drive the Matrix channel end to end.
 */

export interface FakeMatrixEvent {
  readonly event_id: string;
  readonly room_id: string;
  readonly sender: string;
  readonly type: string;
  readonly content: Record<string, unknown>;
  readonly origin_server_ts: number;
}

interface LogEntry {
  readonly index: number;
  readonly kind: "event" | "invite";
  readonly roomId: string;
  readonly event?: FakeMatrixEvent;
  readonly inviter?: string;
}

export interface FakeMatrixHomeserver {
  readonly url: string;
  readonly botUserId: string;
  readonly token: string;
  readonly sent: FakeMatrixEvent[];
  readonly joins: string[];
  readonly requests: Array<{ readonly method: string; readonly path: string; readonly authorization?: string }>;
  syncCount(): number;
  inject(roomId: string, sender: string, body: string, content?: Record<string, unknown>): string;
  /** Store media and return its mxc:// URI (served by the authenticated download endpoint). */
  putMedia(bytes: Uint8Array, contentType: string): string;
  invite(roomId: string, inviter: string): void;
  waitFor(predicate: () => boolean, timeoutMs?: number): Promise<void>;
  /** Wait until the client has completed `count` more sync requests. */
  waitForSyncs(count: number, timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

export async function startFakeMatrixHomeserver(options: {
  readonly botUserId?: string;
  readonly token?: string;
  readonly joinedRooms?: readonly string[];
} = {}): Promise<FakeMatrixHomeserver> {
  const botUserId = options.botUserId ?? "@muster:fake.test";
  const token = options.token ?? "fake-matrix-token";
  const joined = new Set(options.joinedRooms ?? ["!room:fake.test"]);
  const log: LogEntry[] = [];
  const sent: FakeMatrixEvent[] = [];
  const joins: string[] = [];
  const requests: FakeMatrixHomeserver["requests"] = [];
  const txns = new Map<string, string>();
  const media = new Map<string, { readonly bytes: Buffer; readonly type: string }>();
  const putMedia = (bytes: Uint8Array, type: string): string => {
    const id = `m${media.size + 1}`;
    media.set(id, { bytes: Buffer.from(bytes), type });
    return `mxc://fake.test/${id}`;
  };
  let eventCounter = 0;
  let syncs = 0;
  let waiters: Array<() => void> = [];
  const notify = () => { const current = waiters; waiters = []; for (const wake of current) wake(); };

  const appendEvent = (roomId: string, sender: string, type: string, content: Record<string, unknown>): FakeMatrixEvent => {
    eventCounter += 1;
    const event: FakeMatrixEvent = { event_id: `$e${eventCounter}:fake.test`, room_id: roomId, sender, type, content, origin_server_ts: Date.now() };
    log.push({ index: log.length + 1, kind: "event", roomId, event });
    notify();
    return event;
  };

  const syncBody = (since: number) => {
    const join: Record<string, { timeline: { events: FakeMatrixEvent[] } }> = {};
    const invite: Record<string, { invite_state: { events: unknown[] } }> = {};
    for (const entry of log.slice(since)) {
      if (entry.kind === "event" && entry.event && joined.has(entry.roomId)) {
        (join[entry.roomId] ??= { timeline: { events: [] } }).timeline.events.push(entry.event);
      }
      if (entry.kind === "invite" && !joined.has(entry.roomId)) {
        invite[entry.roomId] = { invite_state: { events: [{ type: "m.room.member", state_key: botUserId, sender: entry.inviter, content: { membership: "invite" } }] } };
      }
    }
    return { next_batch: `s${log.length}`, rooms: { join, invite } };
  };

  const json = (response: ServerResponse, status: number, payload: unknown) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(payload));
  };

  const readBody = (request: IncomingMessage) => new Promise<Buffer>((resolvePromise) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolvePromise(Buffer.concat(chunks)));
  });

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://fake");
      requests.push({ method: request.method ?? "GET", path: `${url.pathname}${url.search}`, authorization: request.headers.authorization });
      if (request.headers.authorization !== `Bearer ${token}`) {
        json(response, 401, { errcode: "M_UNKNOWN_TOKEN", error: "Unknown token" });
        return;
      }
      const body = await readBody(request);
      if (request.method === "GET" && url.pathname === "/_matrix/client/v3/account/whoami") {
        json(response, 200, { user_id: botUserId });
        return;
      }
      if (request.method === "GET" && url.pathname === "/_matrix/client/v3/sync") {
        const sinceParam = url.searchParams.get("since");
        const since = sinceParam ? Number(sinceParam.slice(1)) : 0;
        const timeout = Number(url.searchParams.get("timeout") ?? "0");
        if (sinceParam && log.length <= since && timeout > 0) {
          await Promise.race([new Promise<void>((wake) => waiters.push(wake)), delay(timeout)]);
        }
        syncs += 1;
        json(response, 200, syncBody(sinceParam ? since : 0));
        return;
      }
      const send = url.pathname.match(/^\/_matrix\/client\/v3\/rooms\/([^/]+)\/send\/([^/]+)\/([^/]+)$/);
      if (request.method === "PUT" && send) {
        const roomId = decodeURIComponent(send[1]);
        const txn = decodeURIComponent(send[3]);
        const existing = txns.get(txn);
        if (existing) { json(response, 200, { event_id: existing }); return; }
        const event = appendEvent(roomId, botUserId, decodeURIComponent(send[2]), JSON.parse(body.toString("utf8")) as Record<string, unknown>);
        txns.set(txn, event.event_id);
        sent.push(event);
        json(response, 200, { event_id: event.event_id });
        return;
      }
      const joinMatch = url.pathname.match(/^\/_matrix\/client\/v3\/(?:rooms\/([^/]+)\/join|join\/([^/]+))$/);
      if (request.method === "POST" && joinMatch) {
        const roomId = decodeURIComponent(joinMatch[1] ?? joinMatch[2]);
        joined.add(roomId);
        joins.push(roomId);
        json(response, 200, { room_id: roomId });
        return;
      }
      if (request.method === "POST" && url.pathname === "/_matrix/media/v3/upload") {
        json(response, 200, { content_uri: putMedia(body, request.headers["content-type"] ?? "application/octet-stream") });
        return;
      }
      const download = url.pathname.match(/^\/_matrix\/client\/v1\/media\/download\/fake\.test\/([^/]+)$/);
      if (request.method === "GET" && download) {
        const item = media.get(decodeURIComponent(download[1]));
        if (!item) { json(response, 404, { errcode: "M_NOT_FOUND", error: "Not found" }); return; }
        response.writeHead(200, { "content-type": item.type });
        response.end(item.bytes);
        return;
      }
      json(response, 404, { errcode: "M_UNRECOGNIZED", error: "Unrecognized request" });
    })().catch((error) => json(response, 500, { error: String(error) }));
  });
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  const waitFor = async (predicate: () => boolean, timeoutMs = 5_000) => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error("fake matrix: condition not met in time");
      await delay(10);
    }
  };

  return {
    url: `http://127.0.0.1:${port}`,
    botUserId,
    token,
    sent,
    joins,
    requests,
    syncCount: () => syncs,
    inject(roomId, sender, body, content) {
      return appendEvent(roomId, sender, content?.type === "m.room.encrypted" ? "m.room.encrypted" : "m.room.message", content ?? { msgtype: "m.text", body }).event_id;
    },
    putMedia,
    invite(roomId, inviter) {
      log.push({ index: log.length + 1, kind: "invite", roomId, inviter });
      notify();
    },
    waitFor,
    async waitForSyncs(count, timeoutMs = 5_000) {
      const target = syncs + count;
      await waitFor(() => syncs >= target, timeoutMs);
    },
    close: () => new Promise<void>((resolvePromise) => {
      notify();
      server.closeAllConnections();
      server.close(() => resolvePromise());
    }),
  };
}
