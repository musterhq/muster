import { connect as netConnect } from "node:net";
import type { Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";

/**
 * A small dependency-free IMAP4rev1 client: LOGIN, SELECT, UID SEARCH/FETCH/
 * STORE and IDLE over implicit TLS, STARTTLS or (local testing) plaintext.
 * It reads one response at a time, handling {n} literals.
 */

export interface ImapConnectOptions {
  readonly host: string;
  readonly port: number;
  readonly security: "tls" | "starttls" | "none";
  readonly timeoutMs?: number;
}

interface ImapResponse {
  readonly text: string;
  readonly literals: readonly Buffer[];
}

export class ImapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImapError";
  }
}

function quote(value: string): string {
  if (/[\r\n\u0000]/.test(value) || /[^\x20-\x7e]/.test(value)) {
    throw new ImapError("IMAP LOGIN credentials must be printable ASCII.");
  }
  return `"${value.replace(/(["\\])/g, "\\$1")}"`;
}

function openSocket(options: ImapConnectOptions): Promise<Socket> {
  return new Promise((resolvePromise, rejectPromise) => {
    const socket = options.security === "tls"
      ? tlsConnect({ host: options.host, port: options.port, servername: options.host })
      : netConnect({ host: options.host, port: options.port });
    const timer = setTimeout(() => { socket.destroy(); rejectPromise(new ImapError(`IMAP connect to ${options.host}:${options.port} timed out`)); }, options.timeoutMs ?? 15_000);
    socket.once(options.security === "tls" ? "secureConnect" : "connect", () => { clearTimeout(timer); resolvePromise(socket); });
    socket.once("error", (error) => { clearTimeout(timer); rejectPromise(error); });
  });
}

export class ImapClient {
  private buffer = Buffer.alloc(0);
  private wake: (() => void) | undefined;
  private closedError: Error | undefined;
  private counter = 0;
  capabilities = new Set<string>();

  private constructor(private socket: Socket, private readonly options: ImapConnectOptions) {
    this.attach(socket);
  }

  static async connect(options: ImapConnectOptions): Promise<ImapClient> {
    const client = new ImapClient(await openSocket(options), options);
    try {
      const greeting = await client.readResponse(options.timeoutMs ?? 15_000);
      if (!/^\* (OK|PREAUTH)/i.test(greeting.text)) throw new ImapError(`IMAP server refused the connection: ${greeting.text.slice(0, 120)}`);
      await client.refreshCapabilities();
      if (options.security === "starttls") {
        if (!client.capabilities.has("STARTTLS")) throw new ImapError("IMAP server does not offer STARTTLS");
        await client.command("STARTTLS");
        await client.upgradeToTls();
        await client.refreshCapabilities();
      }
      return client;
    } catch (error) {
      client.close();
      throw error;
    }
  }

  private attach(socket: Socket): void {
    socket.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.wake?.();
    });
    socket.on("error", (error) => { this.closedError ??= error; this.wake?.(); });
    socket.on("close", () => { this.closedError ??= new ImapError("IMAP connection closed"); this.wake?.(); });
  }

  private async upgradeToTls(): Promise<void> {
    const plain = this.socket;
    plain.removeAllListeners("data");
    plain.removeAllListeners("close");
    plain.removeAllListeners("error");
    this.buffer = Buffer.alloc(0);
    this.socket = await new Promise<Socket>((resolvePromise, rejectPromise) => {
      const secure = tlsConnect({ socket: plain, servername: this.options.host });
      secure.once("secureConnect", () => resolvePromise(secure));
      secure.once("error", rejectPromise);
    });
    this.attach(this.socket);
  }

  private async waitFor(index: () => number, timeoutMs: number, signal?: AbortSignal): Promise<number | undefined> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = index();
      if (found >= 0) return found;
      if (this.closedError) throw this.closedError;
      if (signal?.aborted) return undefined;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return undefined;
      await new Promise<void>((resolvePromise) => {
        const timer = setTimeout(done, remaining);
        const onAbort = () => done();
        signal?.addEventListener("abort", onAbort, { once: true });
        function done() {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          resolvePromise();
        }
        this.wake = done;
      });
      this.wake = undefined;
    }
  }

  /** Read one response (a line plus any literals it announces). Undefined on timeout/abort. */
  private async tryReadResponse(timeoutMs: number, signal?: AbortSignal): Promise<ImapResponse | undefined> {
    let text = "";
    const literals: Buffer[] = [];
    for (;;) {
      const end = await this.waitFor(() => this.buffer.indexOf("\r\n"), text ? 60_000 : timeoutMs, text ? undefined : signal);
      if (end === undefined) {
        if (text) throw new ImapError("IMAP response was cut off");
        return undefined;
      }
      const line = this.buffer.subarray(0, end).toString("utf8");
      this.buffer = this.buffer.subarray(end + 2);
      text += line;
      const literal = /\{(\d+)\+?\}$/.exec(line);
      if (!literal) return { text, literals };
      const size = Number(literal[1]);
      const ready = await this.waitFor(() => (this.buffer.length >= size ? 0 : -1), 60_000);
      if (ready === undefined) throw new ImapError("IMAP literal was cut off");
      literals.push(Buffer.from(this.buffer.subarray(0, size)));
      this.buffer = this.buffer.subarray(size);
    }
  }

  private async readResponse(timeoutMs = 60_000): Promise<ImapResponse> {
    const response = await this.tryReadResponse(timeoutMs);
    if (!response) throw new ImapError("IMAP server did not answer in time");
    return response;
  }

  private write(line: string): void {
    this.socket.write(`${line}\r\n`);
  }

  /** Run one tagged command; returns its untagged responses or throws on NO/BAD. */
  async command(command: string): Promise<ImapResponse[]> {
    this.counter += 1;
    const tag = `M${this.counter}`;
    this.write(`${tag} ${command}`);
    const untagged: ImapResponse[] = [];
    for (;;) {
      const response = await this.readResponse();
      if (response.text.startsWith(`${tag} `)) {
        const status = response.text.slice(tag.length + 1);
        if (!/^OK\b/i.test(status)) throw new ImapError(`IMAP ${command.split(" ")[0]} failed: ${status.slice(0, 160)}`);
        return untagged;
      }
      untagged.push(response);
    }
  }

  private async refreshCapabilities(): Promise<void> {
    const responses = await this.command("CAPABILITY");
    const line = responses.find((response) => /^\* CAPABILITY /i.test(response.text));
    this.capabilities = new Set((line?.text.slice("* CAPABILITY ".length) ?? "").toUpperCase().split(/\s+/).filter(Boolean));
  }

  async login(user: string, password: string): Promise<void> {
    await this.command(`LOGIN ${quote(user)} ${quote(password)}`);
    await this.refreshCapabilities();
  }

  async select(mailbox: string): Promise<{ readonly uidValidity: number; readonly uidNext: number; readonly exists: number }> {
    const responses = await this.command(`SELECT ${quote(mailbox)}`);
    let uidValidity = 0;
    let uidNext = 0;
    let exists = 0;
    for (const { text } of responses) {
      const validity = /\[UIDVALIDITY (\d+)\]/i.exec(text);
      if (validity) uidValidity = Number(validity[1]);
      const next = /\[UIDNEXT (\d+)\]/i.exec(text);
      if (next) uidNext = Number(next[1]);
      const count = /^\* (\d+) EXISTS/i.exec(text);
      if (count) exists = Number(count[1]);
    }
    return { uidValidity, uidNext, exists };
  }

  async uidSearchFrom(firstUid: number): Promise<number[]> {
    const responses = await this.command(`UID SEARCH UID ${Math.max(1, firstUid)}:*`);
    const uids: number[] = [];
    for (const { text } of responses) {
      if (!/^\* SEARCH/i.test(text)) continue;
      for (const token of text.slice("* SEARCH".length).trim().split(/\s+/)) if (/^\d+$/.test(token)) uids.push(Number(token));
    }
    // "n:*" also matches the highest UID when nothing is newer; filter it out.
    return uids.filter((uid) => uid >= firstUid).sort((left, right) => left - right);
  }

  async uidFetchMessage(uid: number): Promise<Buffer | undefined> {
    const responses = await this.command(`UID FETCH ${uid} (UID BODY.PEEK[])`);
    for (const response of responses) {
      if (/^\* \d+ FETCH/i.test(response.text) && new RegExp(`\\bUID ${uid}\\b`).test(response.text) && response.literals[0]) {
        return response.literals[0];
      }
    }
    return undefined;
  }

  async uidAddFlags(uid: number, flags: string): Promise<void> {
    await this.command(`UID STORE ${uid} +FLAGS.SILENT (${flags})`);
  }

  /**
   * IDLE until the server reports new mail, the timeout passes or the signal
   * aborts. Returns true when new mail was announced. Returns false at once
   * when the server has no IDLE.
   */
  async idle(timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    if (!this.capabilities.has("IDLE")) return false;
    this.counter += 1;
    const tag = `M${this.counter}`;
    this.write(`${tag} IDLE`);
    const started = await this.readResponse();
    if (!started.text.startsWith("+")) {
      if (started.text.startsWith(`${tag} `)) return false;
      throw new ImapError(`IMAP IDLE was refused: ${started.text.slice(0, 120)}`);
    }
    const deadline = Date.now() + timeoutMs;
    let announced = false;
    for (;;) {
      const response = await this.tryReadResponse(Math.max(0, deadline - Date.now()), signal);
      if (!response) break;
      if (/^\* \d+ (EXISTS|RECENT)/i.test(response.text)) { announced = true; break; }
    }
    this.write("DONE");
    for (;;) {
      const response = await this.readResponse();
      if (response.text.startsWith(`${tag} `)) break;
      if (/^\* \d+ EXISTS/i.test(response.text)) announced = true;
    }
    return announced;
  }

  async logout(): Promise<void> {
    try {
      await this.command("LOGOUT");
    } catch {
      // The server may close before the tagged OK.
    } finally {
      this.close();
    }
  }

  close(): void {
    this.socket.destroy();
  }
}
