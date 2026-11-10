import { createServer } from "node:net";
import type { Server, Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

/**
 * In-process IMAP (with IDLE) and SMTP fakes over plain TCP. They speak just
 * enough of RFC 9051 / RFC 5321 to drive the email channel end to end.
 */

export interface FakeImapMessage {
  readonly uid: number;
  readonly raw: string;
  readonly flags: Set<string>;
}

export interface FakeImapServer {
  readonly port: number;
  readonly messages: FakeImapMessage[];
  readonly logins: string[];
  add(raw: string): number;
  /** Number of connections currently in IDLE. */
  idling(): number;
  close(): Promise<void>;
}

export interface FakeSmtpMessage {
  readonly from: string;
  readonly to: readonly string[];
  readonly data: string;
  readonly authUser?: string;
}

export interface FakeSmtpServer {
  readonly port: number;
  readonly messages: FakeSmtpMessage[];
  waitFor(count: number, timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  return typeof address === "object" && address ? address.port : 0;
}

function closeServer(server: Server, sockets: Set<Socket>): Promise<void> {
  for (const socket of sockets) socket.destroy();
  return new Promise((resolvePromise) => server.close(() => resolvePromise()));
}

function unquote(token: string | undefined): string {
  if (!token) return "";
  return token.startsWith("\"") ? token.slice(1, -1).replace(/\\(["\\])/g, "$1") : token;
}

function splitArgs(input: string): string[] {
  return input.match(/"(?:[^"\\]|\\.)*"|\([^)]*\)|\S+/g) ?? [];
}

function uidSet(spec: string, all: readonly FakeImapMessage[]): FakeImapMessage[] {
  const max = all.length ? all[all.length - 1].uid : 0;
  const out = new Set<FakeImapMessage>();
  for (const part of spec.split(",")) {
    const [startRaw, endRaw] = part.split(":");
    const start = startRaw === "*" ? max : Number(startRaw);
    const end = endRaw === undefined ? start : endRaw === "*" ? max : Number(endRaw);
    const low = Math.min(start, end);
    const high = Math.max(start, end);
    for (const message of all) if (message.uid >= low && message.uid <= high) out.add(message);
    // RFC 9051: "n:*" always includes the highest message even when n > max.
    if (endRaw === "*" && all.length && !all.some((message) => message.uid >= low && message.uid <= high)) out.add(all[all.length - 1]);
  }
  return [...out].sort((left, right) => left.uid - right.uid);
}

export async function startFakeImapServer(options: { readonly user?: string; readonly password?: string } = {}): Promise<FakeImapServer> {
  const user = options.user ?? "muster";
  const password = options.password ?? "imap-secret";
  const messages: FakeImapMessage[] = [];
  const logins: string[] = [];
  const sockets = new Set<Socket>();
  const idlers = new Set<(count: number) => void>();
  let nextUid = 1;

  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    let buffer = "";
    let authed = false;
    let idleTag: string | undefined;
    let idleNotify: ((count: number) => void) | undefined;
    const write = (line: string) => { if (!socket.destroyed) socket.write(`${line}\r\n`); };
    write("* OK fake IMAP ready");
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("latin1");
      let newline: number;
      while ((newline = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 2);
        if (idleTag) {
          if (line.trim().toUpperCase() === "DONE") {
            if (idleNotify) idlers.delete(idleNotify);
            write(`${idleTag} OK IDLE terminated`);
            idleTag = undefined;
            idleNotify = undefined;
          }
          continue;
        }
        const [tag, rawCommand = "", ...rest] = splitArgs(line);
        const command = rawCommand.toUpperCase();
        if (command === "CAPABILITY") {
          write("* CAPABILITY IMAP4rev1 IDLE UIDPLUS");
          write(`${tag} OK CAPABILITY completed`);
        } else if (command === "LOGIN") {
          if (unquote(rest[0]) === user && unquote(rest[1]) === password) {
            authed = true;
            logins.push(unquote(rest[0]));
            write(`${tag} OK LOGIN completed`);
          } else write(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials`);
        } else if (!authed && command !== "LOGOUT" && command !== "NOOP") {
          write(`${tag} NO not authenticated`);
        } else if (command === "SELECT" || command === "EXAMINE") {
          write(`* ${messages.length} EXISTS`);
          write("* OK [UIDVALIDITY 7] UIDs valid");
          write(`* OK [UIDNEXT ${nextUid}] Predicted next UID`);
          write(`${tag} OK [READ-WRITE] SELECT completed`);
        } else if (command === "UID" && rest[0]?.toUpperCase() === "SEARCH") {
          const spec = rest.slice(1).join(" ").replace(/^UID\s+/i, "");
          write(`* SEARCH${uidSet(spec, messages).map((message) => ` ${message.uid}`).join("")}`);
          write(`${tag} OK SEARCH completed`);
        } else if (command === "UID" && rest[0]?.toUpperCase() === "FETCH") {
          for (const message of uidSet(rest[1] ?? "", messages)) {
            const seq = messages.indexOf(message) + 1;
            const raw = Buffer.from(message.raw, "utf8");
            socket.write(`* ${seq} FETCH (UID ${message.uid} FLAGS (${[...message.flags].join(" ")}) BODY[] {${raw.length}}\r\n`);
            socket.write(raw);
            socket.write(")\r\n");
          }
          write(`${tag} OK FETCH completed`);
        } else if (command === "UID" && rest[0]?.toUpperCase() === "STORE") {
          const flags = (rest.slice(3).join(" ").match(/\\\w+/g) ?? []);
          const add = !/^-/.test(rest[2] ?? "");
          for (const message of uidSet(rest[1] ?? "", messages)) for (const flag of flags) add ? message.flags.add(flag) : message.flags.delete(flag);
          write(`${tag} OK STORE completed`);
        } else if (command === "IDLE") {
          idleTag = tag;
          idleNotify = (count) => write(`* ${count} EXISTS`);
          idlers.add(idleNotify);
          write("+ idling");
        } else if (command === "NOOP") {
          write(`${tag} OK NOOP completed`);
        } else if (command === "LOGOUT") {
          write("* BYE logging out");
          write(`${tag} OK LOGOUT completed`);
          socket.end();
        } else {
          write(`${tag} BAD unknown command`);
        }
      }
    });
  });
  const port = await listen(server);
  return {
    port,
    messages,
    logins,
    add(raw) {
      const uid = nextUid;
      nextUid += 1;
      messages.push({ uid, raw, flags: new Set() });
      for (const notify of idlers) notify(messages.length);
      return uid;
    },
    idling: () => idlers.size,
    close: () => closeServer(server, sockets),
  };
}

export async function startFakeSmtpServer(options: { readonly user?: string; readonly password?: string } = {}): Promise<FakeSmtpServer> {
  const user = options.user ?? "muster";
  const password = options.password ?? "imap-secret";
  const messages: FakeSmtpMessage[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    let buffer = "";
    let inData = false;
    let data: string[] = [];
    let from = "";
    let to: string[] = [];
    let authUser: string | undefined;
    const write = (line: string) => { if (!socket.destroyed) socket.write(`${line}\r\n`); };
    write("220 fake.test ESMTP ready");
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let newline: number;
      while ((newline = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 2);
        if (inData) {
          if (line === ".") {
            inData = false;
            messages.push({ from, to, data: data.join("\r\n"), authUser });
            data = [];
            write("250 2.0.0 queued");
          } else data.push(line.startsWith("..") ? line.slice(1) : line);
          continue;
        }
        const upper = line.toUpperCase();
        if (upper.startsWith("EHLO") || upper.startsWith("HELO")) {
          write("250-fake.test greets you");
          write("250-AUTH PLAIN LOGIN");
          write("250 8BITMIME");
        } else if (upper.startsWith("AUTH PLAIN")) {
          const decoded = Buffer.from(line.slice("AUTH PLAIN ".length).trim(), "base64").toString("utf8").split("\u0000");
          if (decoded[1] === user && decoded[2] === password) { authUser = decoded[1]; write("235 2.7.0 Authentication successful"); }
          else write("535 5.7.8 Authentication credentials invalid");
        } else if (upper.startsWith("MAIL FROM:")) {
          if (!authUser) { write("530 5.7.0 Authentication required"); continue; }
          from = line.slice(10).trim().replace(/^<|>$/g, "");
          to = [];
          write("250 2.1.0 OK");
        } else if (upper.startsWith("RCPT TO:")) {
          to.push(line.slice(8).trim().replace(/^<|>$/g, ""));
          write("250 2.1.5 OK");
        } else if (upper === "DATA") {
          inData = true;
          write("354 End data with <CR><LF>.<CR><LF>");
        } else if (upper === "QUIT") {
          write("221 2.0.0 Bye");
          socket.end();
        } else if (upper === "RSET" || upper === "NOOP") {
          write("250 OK");
        } else {
          write("502 5.5.2 Command not recognized");
        }
      }
    });
  });
  const port = await listen(server);
  return {
    port,
    messages,
    async waitFor(count, timeoutMs = 5_000) {
      const deadline = Date.now() + timeoutMs;
      while (messages.length < count) {
        if (Date.now() > deadline) throw new Error(`fake smtp: expected ${count} messages, have ${messages.length}`);
        await delay(10);
      }
    },
    close: () => closeServer(server, sockets),
  };
}

/** Build a simple RFC 5322 text mail. */
export function rawMail(input: {
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly messageId: string;
  readonly body: string;
  readonly inReplyTo?: string;
  readonly references?: string;
  readonly headers?: Readonly<Record<string, string>>;
}): string {
  const lines = [
    `From: ${input.from}`,
    `To: ${input.to}`,
    `Subject: ${input.subject}`,
    `Message-ID: ${input.messageId}`,
    `Date: ${new Date().toUTCString()}`,
    ...(input.inReplyTo ? [`In-Reply-To: ${input.inReplyTo}`] : []),
    ...(input.references ? [`References: ${input.references}`] : []),
    ...Object.entries(input.headers ?? {}).map(([name, value]) => `${name}: ${value}`),
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    input.body,
    "",
  ];
  return lines.join("\r\n");
}

/** Parse the headers of a captured SMTP DATA block (unfolded, lowercased names). */
export function mailHeaders(data: string): { readonly headers: Record<string, string>; readonly body: string } {
  const split = data.indexOf("\r\n\r\n");
  const head = data.slice(0, split).replace(/\r\n[ \t]+/g, " ");
  const headers: Record<string, string> = {};
  for (const line of head.split("\r\n")) {
    const colon = line.indexOf(":");
    if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return { headers, body: data.slice(split + 4) };
}
