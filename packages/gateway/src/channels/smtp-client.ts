import { connect as netConnect } from "node:net";
import type { Socket } from "node:net";
import { hostname } from "node:os";
import { connect as tlsConnect } from "node:tls";

/**
 * A small dependency-free SMTP submission client (RFC 5321/4954): EHLO,
 * STARTTLS, AUTH PLAIN, MAIL/RCPT/DATA. Used by the email channel.
 */

export interface SmtpOptions {
  readonly host: string;
  readonly port: number;
  readonly security: "tls" | "starttls" | "none";
  readonly user: string;
  readonly password: string;
  readonly timeoutMs?: number;
}

export class SmtpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SmtpError";
  }
}

class SmtpConnection {
  private buffer = "";
  private wake: (() => void) | undefined;
  private closedError: Error | undefined;
  extensions = new Set<string>();

  constructor(private socket: Socket, private readonly options: SmtpOptions) {
    this.attach(socket);
  }

  private attach(socket: Socket): void {
    socket.on("data", (chunk: Buffer) => { this.buffer += chunk.toString("utf8"); this.wake?.(); });
    socket.on("error", (error) => { this.closedError ??= error; this.wake?.(); });
    socket.on("close", () => { this.closedError ??= new SmtpError("SMTP connection closed"); this.wake?.(); });
  }

  async reply(): Promise<{ readonly code: number; readonly lines: readonly string[] }> {
    const lines: string[] = [];
    const deadline = Date.now() + (this.options.timeoutMs ?? 30_000);
    for (;;) {
      const end = this.buffer.indexOf("\r\n");
      if (end >= 0) {
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 2);
        lines.push(line.slice(4));
        if (line[3] !== "-") return { code: Number(line.slice(0, 3)), lines };
        continue;
      }
      if (this.closedError) throw this.closedError;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new SmtpError("SMTP server did not answer in time");
      await new Promise<void>((resolvePromise) => {
        const timer = setTimeout(done, remaining);
        const finish = () => { clearTimeout(timer); resolvePromise(); };
        function done() { finish(); }
        this.wake = finish;
      });
      this.wake = undefined;
    }
  }

  async expect(line: string | undefined, codes: readonly number[], what: string): Promise<readonly string[]> {
    if (line !== undefined) this.socket.write(`${line}\r\n`);
    const response = await this.reply();
    if (!codes.includes(response.code)) throw new SmtpError(`SMTP ${what} failed: ${response.code} ${response.lines.join(" ").slice(0, 160)}`);
    return response.lines;
  }

  async ehlo(): Promise<void> {
    const lines = await this.expect(`EHLO ${hostname().replace(/[^A-Za-z0-9.-]/g, "") || "muster"}`, [250], "EHLO");
    this.extensions = new Set(lines.slice(1).map((line) => line.split(" ")[0].toUpperCase()));
  }

  async startTls(): Promise<void> {
    await this.expect("STARTTLS", [220], "STARTTLS");
    const plain = this.socket;
    plain.removeAllListeners("data");
    plain.removeAllListeners("close");
    plain.removeAllListeners("error");
    this.buffer = "";
    this.socket = await new Promise<Socket>((resolvePromise, rejectPromise) => {
      const secure = tlsConnect({ socket: plain, servername: this.options.host });
      secure.once("secureConnect", () => resolvePromise(secure));
      secure.once("error", rejectPromise);
    });
    this.attach(this.socket);
  }

  write(data: string): void {
    this.socket.write(data);
  }

  close(): void {
    this.socket.destroy();
  }
}

async function open(options: SmtpOptions): Promise<SmtpConnection> {
  const socket = await new Promise<Socket>((resolvePromise, rejectPromise) => {
    const raw = options.security === "tls"
      ? tlsConnect({ host: options.host, port: options.port, servername: options.host })
      : netConnect({ host: options.host, port: options.port });
    const timer = setTimeout(() => { raw.destroy(); rejectPromise(new SmtpError(`SMTP connect to ${options.host}:${options.port} timed out`)); }, options.timeoutMs ?? 15_000);
    raw.once(options.security === "tls" ? "secureConnect" : "connect", () => { clearTimeout(timer); resolvePromise(raw); });
    raw.once("error", (error) => { clearTimeout(timer); rejectPromise(error); });
  });
  const connection = new SmtpConnection(socket, options);
  try {
    await connection.expect(undefined, [220], "greeting");
    await connection.ehlo();
    if (options.security === "starttls") {
      if (!connection.extensions.has("STARTTLS")) throw new SmtpError("SMTP server does not offer STARTTLS");
      await connection.startTls();
      await connection.ehlo();
    }
    const plain = Buffer.from(`\u0000${options.user}\u0000${options.password}`, "utf8").toString("base64");
    await connection.expect(`AUTH PLAIN ${plain}`, [235], "AUTH");
    return connection;
  } catch (error) {
    connection.close();
    throw error;
  }
}

/** Connect, authenticate and quit: proves the submission credentials work. */
export async function smtpVerify(options: SmtpOptions): Promise<void> {
  const connection = await open(options);
  try {
    await connection.expect("QUIT", [221], "QUIT").catch(() => undefined);
  } finally {
    connection.close();
  }
}

/** Submit one message. `data` is the full RFC 5322 message with CRLF line ends. */
export async function smtpSend(options: SmtpOptions, envelope: { readonly from: string; readonly to: readonly string[]; readonly data: string }): Promise<void> {
  if (!envelope.to.length) throw new SmtpError("SMTP message has no recipients");
  for (const address of [envelope.from, ...envelope.to]) {
    if (/[\r\n<>]/.test(address)) throw new SmtpError("SMTP address contains forbidden characters");
  }
  const connection = await open(options);
  try {
    await connection.expect(`MAIL FROM:<${envelope.from}>`, [250], "MAIL FROM");
    for (const recipient of envelope.to) await connection.expect(`RCPT TO:<${recipient}>`, [250, 251], "RCPT TO");
    await connection.expect("DATA", [354], "DATA");
    const body = envelope.data.replace(/\r?\n/g, "\r\n").split("\r\n").map((line) => (line.startsWith(".") ? `.${line}` : line)).join("\r\n");
    connection.write(`${body}${body.endsWith("\r\n") ? "" : "\r\n"}.\r\n`);
    await connection.expect(undefined, [250], "message submission");
    await connection.expect("QUIT", [221], "QUIT").catch(() => undefined);
  } finally {
    connection.close();
  }
}
