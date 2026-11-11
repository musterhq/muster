import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { Socket } from "node:net";

/**
 * Fake Discord for tests: the gateway WebSocket (a minimal RFC 6455 server,
 * text frames only) and the REST routes Muster calls, on one local port.
 *
 * Gateway behaviour: HELLO on connect, ACK for every heartbeat, READY after
 * IDENTIFY, and on RESUME either replays what the test queued and sends
 * RESUMED ("accept"), or answers INVALID_SESSION false ("reject").
 */

export interface GatewayFrame {
  readonly connection: number;
  readonly op: number;
  readonly d: any;
  readonly at: number;
}

export interface RestCall {
  readonly method: string;
  readonly path: string;
  readonly authorization?: string;
  readonly body: any;
}

export interface FakeDiscord {
  readonly apiBaseUrl: string;
  readonly gatewayUrl: string;
  readonly resumeUrl: string;
  readonly frames: GatewayFrame[];
  readonly rest: RestCall[];
  /** Number of WebSocket connections accepted so far. */
  connections(): number;
  /** Dispatch an event (op 0) with the next sequence number. Returns that sequence. */
  dispatch(type: string, data: unknown): number;
  /** Close the current socket without a close frame (network drop). */
  drop(): void;
  /** What a RESUME gets. With "accept", `replay` events are re-sent before RESUMED. */
  onResume(mode: "accept" | "reject", replay?: ReadonlyArray<{ readonly type: string; readonly data: unknown }>): void;
  sentMessages(channelId?: string): RestCall[];
  waitFor(condition: () => boolean, label?: string): Promise<void>;
  close(): Promise<void>;
}

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function encodeFrame(text: string, opcode = 0x1): Buffer {
  const payload = Buffer.from(text);
  const length = payload.length;
  const header = length < 126 ? Buffer.alloc(2) : length < 65_536 ? Buffer.alloc(4) : Buffer.alloc(10);
  header[0] = 0x80 | opcode;
  if (length < 126) header[1] = length;
  else if (length < 65_536) { header[1] = 126; header.writeUInt16BE(length, 2); }
  else { header[1] = 127; header.writeBigUInt64BE(BigInt(length), 2); }
  return Buffer.concat([header, payload]);
}

/** Parse complete client frames (always masked) from `buffer`; returns the rest. */
function decodeFrames(buffer: Buffer, onFrame: (opcode: number, payload: Buffer) => void): Buffer {
  let rest = buffer;
  for (;;) {
    if (rest.length < 2) return rest;
    const opcode = rest[0] & 0x0f;
    const masked = (rest[1] & 0x80) !== 0;
    let length = rest[1] & 0x7f;
    let offset = 2;
    if (length === 126) { if (rest.length < 4) return rest; length = rest.readUInt16BE(2); offset = 4; }
    else if (length === 127) { if (rest.length < 10) return rest; length = Number(rest.readBigUInt64BE(2)); offset = 10; }
    const maskLength = masked ? 4 : 0;
    if (rest.length < offset + maskLength + length) return rest;
    const mask = masked ? rest.subarray(offset, offset + 4) : undefined;
    const payload = Buffer.from(rest.subarray(offset + maskLength, offset + maskLength + length));
    if (mask) for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
    onFrame(opcode, payload);
    rest = rest.subarray(offset + maskLength + length);
  }
}

export async function startFakeDiscord(options: { readonly botUserId: string; readonly token: string; readonly heartbeatIntervalMs?: number }): Promise<FakeDiscord> {
  const frames: GatewayFrame[] = [];
  const rest: RestCall[] = [];
  const sockets = new Set<Socket>();
  let current: Socket | undefined;
  let connectionCount = 0;
  let seq = 0;
  let sessionCount = 0;
  let resumeMode: "accept" | "reject" = "accept";
  let replay: ReadonlyArray<{ readonly type: string; readonly data: unknown }> = [];
  let messageCount = 0;
  const waiters = new Set<() => void>();
  const notify = () => { for (const waiter of waiters) waiter(); };
  let port = 0;

  const sendTo = (socket: Socket | undefined, payload: unknown) => {
    if (socket && !socket.destroyed) socket.write(encodeFrame(JSON.stringify(payload)));
  };
  const dispatchTo = (socket: Socket | undefined, type: string, data: unknown): number => {
    seq += 1;
    sendTo(socket, { op: 0, t: type, s: seq, d: data });
    return seq;
  };

  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      const path = (request.url ?? "").replace(/^\/api\/v10/, "");
      const call: RestCall = { method: request.method ?? "GET", path, authorization: request.headers.authorization, body: raw ? JSON.parse(raw) : undefined };
      rest.push(call);
      notify();
      const json = (status: number, body: unknown) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); };
      if (call.authorization !== `Bot ${options.token}`) return json(401, { message: "401: Unauthorized" });
      if (call.method === "GET" && path === "/gateway/bot") return json(200, { url: `ws://127.0.0.1:${port}/gateway`, shards: 1 });
      if (call.method === "GET" && path === "/users/@me") return json(200, { id: options.botUserId, username: "muster" });
      const channel = /^\/channels\/([^/]+)\/messages$/.exec(path);
      if (call.method === "POST" && channel) { messageCount += 1; return json(200, { id: `out-${messageCount}`, channel_id: channel[1] }); }
      if (call.method === "PATCH" && /^\/channels\/[^/]+\/messages\/[^/]+$/.test(path)) return json(200, { id: path.split("/").at(-1) });
      if (call.method === "POST" && /^\/interactions\/[^/]+\/[^/]+\/callback$/.test(path)) { response.writeHead(204); response.end(); return; }
      json(404, { message: "Unknown route" });
    });
  });

  server.on("upgrade", (request, socket: Socket) => {
    const key = request.headers["sec-websocket-key"];
    if (typeof key !== "string") { socket.destroy(); return; }
    const accept = createHash("sha1").update(key + GUID).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    connectionCount += 1;
    const connection = connectionCount;
    sockets.add(socket);
    current = socket;
    socket.on("close", () => { sockets.delete(socket); if (current === socket) current = undefined; notify(); });
    socket.on("error", () => undefined);
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = decodeFrames(Buffer.concat([buffer, chunk]), (opcode, payload) => {
        if (opcode === 0x8) { socket.end(encodeFrame("", 0x8)); return; }
        if (opcode === 0x9) { socket.write(encodeFrame(payload.toString(), 0xa)); return; }
        if (opcode !== 0x1) return;
        const frame = JSON.parse(payload.toString()) as { op: number; d: any };
        frames.push({ connection, op: frame.op, d: frame.d, at: Date.now() });
        if (frame.op === 1) sendTo(socket, { op: 11 });
        if (frame.op === 2) {
          sessionCount += 1;
          seq = 0;
          dispatchTo(socket, "READY", {
            v: 10,
            session_id: `session-${sessionCount}`,
            resume_gateway_url: `ws://127.0.0.1:${port}/resume`,
            user: { id: options.botUserId, username: "muster", bot: true },
            guilds: [],
          });
        }
        if (frame.op === 6) {
          if (resumeMode === "reject") sendTo(socket, { op: 9, d: false });
          else {
            for (const event of replay) dispatchTo(socket, event.type, event.data);
            dispatchTo(socket, "RESUMED", null);
          }
        }
        notify();
      });
    });
    sendTo(socket, { op: 10, d: { heartbeat_interval: options.heartbeatIntervalMs ?? 50 } });
    notify();
  });

  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  port = typeof address === "object" && address ? address.port : 0;

  return {
    apiBaseUrl: `http://127.0.0.1:${port}/api/v10`,
    gatewayUrl: `ws://127.0.0.1:${port}/gateway`,
    resumeUrl: `ws://127.0.0.1:${port}/resume`,
    frames,
    rest,
    connections: () => connectionCount,
    dispatch: (type, data) => dispatchTo(current, type, data),
    drop: () => current?.destroy(),
    onResume(mode, events = []) {
      resumeMode = mode;
      replay = events;
    },
    sentMessages: (channelId) => rest.filter((call) => call.method === "POST" && /^\/channels\/[^/]+\/messages$/.test(call.path) && (!channelId || call.path === `/channels/${channelId}/messages`)),
    waitFor(condition, label = "condition") {
      if (condition()) return Promise.resolve();
      return new Promise<void>((resolvePromise, rejectPromise) => {
        // Re-checked on every fake event and every 10 ms (for conditions outside the fake).
        const poll = setInterval(() => check(), 10);
        const timer = setTimeout(() => { clearInterval(poll); waiters.delete(check); rejectPromise(new Error(`fake discord: timed out waiting for ${label}`)); }, 10_000);
        const check = () => {
          if (!condition()) return;
          clearTimeout(timer);
          clearInterval(poll);
          waiters.delete(check);
          resolvePromise();
        };
        waiters.add(check);
      });
    },
    close: () => new Promise<void>((resolvePromise) => {
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections();
      server.close(() => resolvePromise());
    }),
  };
}
