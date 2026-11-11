/**
 * A code plugin's host: one Node child process per plugin, started under
 * Node's permission model, speaking newline-delimited JSON-RPC (parent →
 * child on stdin, child → parent on fd 3, so whatever the plugin prints on
 * stdout or stderr only reaches a log).
 *
 * The parent is the trust boundary. It decides which registrations are
 * accepted (against the manifest's permissions), brokers every network
 * request (`ctx.fetch` asks the parent, which checks the host before
 * connecting and re-checks each redirect), passes only PATH, HOME and the
 * declared `env:` names, and writes a `plugin.denied` receipt for each
 * refusal. A plugin that crashes is restarted (at most 3 times in 60 s, then
 * it is marked failed); a call that outlives its budget kills and restarts
 * the host. The CLI process never shares memory with plugin code.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { appendFile, mkdir, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { Readable } from "node:stream";
import type { HookDecision, HookName } from "./hooks.js";
import { netPermissionCovers, parsedPermissions, PLUGIN_HOOK_EVENTS, type CodePluginManifest } from "./plugin-manifest.js";
import { PLUGIN_HOST_RUNTIME } from "./plugin-host-runtime.js";
import type { ToolResult } from "./tool-registry.js";

export const PLUGIN_DEFAULT_TIMEOUT_MS = 30_000;
export const PLUGIN_HOOK_TIMEOUT_MS = 2_000;
const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 60_000;
const MAX_LINE_BYTES = 16 * 1024 * 1024;
const MAX_FETCH_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const MAX_LOG_BYTES = 64 * 1024;
const MAX_RECEIPTS_PER_PROCESS = 100;
/** Headers the broker sets itself. */
const HOP_HEADERS = new Set(["host", "connection", "content-length", "transfer-encoding", "keep-alive", "upgrade", "proxy-connection", "te", "trailer"]);

const RESTRICTED = (() => {
  const list = new BlockList();
  for (const [network, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4]] as const) list.addSubnet(network, prefix, "ipv4");
  for (const [network, prefix] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]] as const) list.addSubnet(network, prefix, "ipv6");
  return list;
})();

/** Loopback, private, link-local, unspecified (and multicast/reserved) addresses, including IPv4-mapped IPv6. */
export function isRestrictedAddress(address: string): boolean {
  const mapped = address.toLowerCase().match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return RESTRICTED.check(mapped[1]!, "ipv4");
  const family = isIP(address);
  if (family === 4) return RESTRICTED.check(address, "ipv4");
  if (family === 6) return RESTRICTED.check(address, "ipv6");
  return true;
}
const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const COMMAND_PATTERN = /^[a-z0-9][a-z0-9-]{0,40}$/;
/** Workspace entries no plugin permission ever reaches. */
const PROTECTED_WORKSPACE_ENTRIES = new Set([".muster", ".git"]);

export interface PluginRegistration {
  readonly kind: "tool" | "hook" | "command";
  /** Tool or command name; the event for hooks. */
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: Record<string, unknown>;
  readonly usage?: string;
  readonly event?: HookName;
}

export interface PluginRefusal {
  readonly kind: string;
  readonly name: string;
  readonly reason: string;
  /** The permission it would have needed, when that is why. */
  readonly permission?: string;
}

export interface PluginLoadResult {
  readonly registrations: readonly PluginRegistration[];
  readonly refused: readonly PluginRefusal[];
  readonly warnings: readonly string[];
}

export interface PluginHostOptions {
  readonly root: string;
  readonly manifest: CodePluginManifest;
  /** The folder `fs:` permissions are relative to; also the host's cwd. */
  readonly workspace: string;
  /** Where `plugin.denied` receipts are appended (JSONL). */
  readonly receiptsPath?: string;
  /** Where the plugin's stdout/stderr are appended. */
  readonly logPath?: string;
  /** The environment declared `env:` names are read from (default process.env). */
  readonly env?: NodeJS.ProcessEnv;
  readonly config?: Record<string, unknown>;
  readonly timeoutMs?: number;
  readonly hookTimeoutMs?: number;
  /** Names owned by Muster that a plugin may not take. */
  readonly reservedTools?: Iterable<string>;
  readonly reservedCommands?: Iterable<string>;
  /** How the broker resolves a host before checking it (default: the system resolver). */
  readonly resolveHost?: (hostname: string) => Promise<ReadonlyArray<{ readonly address: string; readonly family: number }>>;
  readonly nodePath?: string;
  /**
   * "validate" starts a throwaway host with no permissions at all: no env,
   * no network, read access to the plugin folder and the workspace (a temp
   * folder), write access to the workspace only.
   */
  readonly mode?: "run" | "validate";
  readonly maxRestarts?: number;
  readonly restartWindowMs?: number;
  readonly onFailed?: (reason: string) => void;
  readonly onLog?: (line: string) => void;
}

export type PluginHostStatus = "idle" | "running" | "failed" | "stopped";

export interface PluginHost {
  readonly id: string;
  readonly pid: number | undefined;
  readonly status: PluginHostStatus;
  readonly failure: string | undefined;
  readonly registrations: readonly PluginRegistration[];
  /** The last lines the plugin printed. */
  readonly log: string;
  start(): Promise<PluginLoadResult>;
  /** validate mode: import the entry only (no register), to observe side effects. */
  importOnly(): Promise<{ readonly hasRegister: boolean }>;
  /** validate mode: call register after importOnly, accepting nothing. */
  registerOnly(): Promise<readonly PluginRegistration[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  runHook(event: HookName, payload: unknown): Promise<HookDecision<unknown>>;
  runCommand(name: string, args: string): Promise<{ readonly ok: true; readonly text: string } | { readonly ok: false; readonly error: string }>;
  stop(): Promise<void>;
}

type Failure = { readonly kind: "timeout"; readonly ms: number } | { readonly kind: "exit"; readonly description: string } | { readonly kind: "remote"; readonly message: string } | { readonly kind: "stopped" };

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (failure: Failure) => void;
  readonly timer: NodeJS.Timeout;
}

const liveChildren = new Set<ChildProcess>();
let exitHookInstalled = false;
function trackChild(child: ChildProcess): void {
  liveChildren.add(child);
  child.once("exit", () => liveChildren.delete(child));
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    // Plugin hosts never outlive the process that started them.
    process.once("exit", () => { for (const entry of liveChildren) entry.kill("SIGKILL"); });
  }
}

export function createPluginHost(options: PluginHostOptions): PluginHost {
  const manifest = options.manifest;
  const id = manifest.id;
  const validate = options.mode === "validate";
  const permissions = validate ? [] : manifest.permissions;
  const parsed = parsedPermissions(permissions);
  const timeoutMs = manifest.timeoutMs ?? options.timeoutMs ?? PLUGIN_DEFAULT_TIMEOUT_MS;
  const hookTimeoutMs = options.hookTimeoutMs ?? PLUGIN_HOOK_TIMEOUT_MS;
  const sourceEnv = options.env ?? process.env;
  const declaredEnv = new Set(parsed.flatMap((permission) => (permission.kind === "env" ? [permission.name] : [])));
  const reservedTools = new Set(options.reservedTools ?? []);
  const reservedCommands = new Set(options.reservedCommands ?? []);
  const resolveHost = options.resolveHost ?? ((hostname: string) => dnsLookup(hostname, { all: true, verbatim: true }));
  const maxRestarts = options.maxRestarts ?? MAX_RESTARTS;
  const restartWindowMs = options.restartWindowMs ?? RESTART_WINDOW_MS;

  let child: ChildProcess | undefined;
  let status: PluginHostStatus = "idle";
  let failure: string | undefined;
  let registrations: PluginRegistration[] = [];
  let sequence = 0;
  const pending = new Map<number, Pending>();
  const restarts: number[] = [];
  let recovering: { readonly child: ChildProcess; readonly outcome: Promise<string> } | undefined;
  let logTail = "";
  let receiptsWritten = 0;
  let booting: Promise<PluginLoadResult> | undefined;

  const appendLog = (text: string): void => {
    logTail = (logTail + text).slice(-MAX_LOG_BYTES);
    for (const line of text.split("\n").filter(Boolean)) options.onLog?.(line);
    if (options.logPath) void mkdir(dirname(options.logPath), { recursive: true, mode: 0o700 }).then(() => appendFile(options.logPath!, text, { mode: 0o600 })).catch(() => undefined);
  };

  // Receipts are written in order, and every call waits for them before it returns.
  let receipts: Promise<void> = Promise.resolve();
  const receipt = (entry: Record<string, unknown>): Promise<void> => {
    if (!options.receiptsPath || receiptsWritten >= MAX_RECEIPTS_PER_PROCESS) return receipts;
    receiptsWritten += 1;
    const line = `${JSON.stringify({ at: new Date().toISOString(), plugin: id, ...entry })}\n`;
    receipts = receipts.then(async () => {
      try {
        await mkdir(dirname(options.receiptsPath!), { recursive: true, mode: 0o700 });
        await appendFile(options.receiptsPath!, line, { encoding: "utf8", mode: 0o600 });
      } catch {
        // A receipt that cannot be written never breaks the plugin call.
      }
    });
    return receipts;
  };

  /** Keep the CLI alive only while it waits on the plugin. */
  const updateRef = (): void => {
    if (!child) return;
    const streams = [child.stdin, child.stdout, child.stderr, child.stdio[3]] as Array<{ ref?: () => void; unref?: () => void } | null | undefined>;
    if (pending.size || booting) {
      child.ref();
      for (const stream of streams) stream?.ref?.();
    } else {
      child.unref();
      for (const stream of streams) stream?.unref?.();
    }
  };

  const send = (target: ChildProcess, message: Record<string, unknown>): void => {
    try {
      target.stdin?.write(`${JSON.stringify(message)}\n`);
    } catch {
      // The exit handler settles whatever was waiting.
    }
  };

  const allowPaths = async (): Promise<{ read: string[]; write: string[] }> => {
    const both = async (path: string): Promise<string[]> => [...new Set([resolve(path), await realpath(path).catch(() => resolve(path))])];
    const read = [...await both(options.root)];
    const write: string[] = [];
    const workspace = resolve(options.workspace);
    if (validate) {
      read.push(...await both(workspace));
      write.push(...await both(workspace));
      return { read, write };
    }
    // Muster's own state (.muster: the lock that records approved permissions,
    // config, tokens) and .git are never granted, even for "the whole workspace".
    // Node's permission model has no deny list, so the whole workspace means each
    // of its top-level entries except those, as they exist when the host starts.
    const topLevel = async (): Promise<string[]> => (await readdir(workspace).catch(() => [] as string[]))
      .filter((name) => !PROTECTED_WORKSPACE_ENTRIES.has(name))
      .map((name) => resolve(workspace, name));
    for (const permission of parsed) {
      if (permission.kind !== "fs") continue;
      const target = permission.path ? resolve(workspace, permission.path) : workspace;
      const rel = relative(workspace, target);
      if (rel.startsWith("..") || isAbsolute(rel)) continue;
      if (rel && PROTECTED_WORKSPACE_ENTRIES.has(rel.split(/[\\/]/)[0]!)) continue;
      const targets = rel ? [target] : await topLevel();
      for (const path of targets) {
        // Writing a file you cannot read back is never what a plugin means.
        read.push(...await both(path));
        if (permission.mode === "write") write.push(...await both(path));
      }
    }
    return { read: [...new Set(read)], write: [...new Set(write)] };
  };

  const childEnv = (): Record<string, string> => {
    const env: Record<string, string> = {};
    for (const key of ["PATH", "HOME"]) if (sourceEnv[key] !== undefined) env[key] = sourceEnv[key]!;
    for (const key of declaredEnv) if (sourceEnv[key] !== undefined) env[key] = sourceEnv[key]!;
    return env;
  };

  const handleDenied = (params: Record<string, unknown>): void => {
    const permission = typeof params.permission === "string" ? params.permission.slice(0, 200) : "";
    const detail = typeof params.detail === "string" ? params.detail.slice(0, 300) : undefined;
    if (permission.startsWith("env:")) {
      const name = permission.slice(4);
      // Only a variable the user has and the plugin did not declare was withheld.
      if (declaredEnv.has(name) || sourceEnv[name] === undefined || name === "PATH" || name === "HOME") return;
      void receipt({ type: "plugin.denied", permission, detail: "environment variable withheld (not declared)" });
      return;
    }
    if (permission.startsWith("module:")) void receipt({ type: "plugin.denied", permission, ...(detail ? { detail } : {}) });
  };

  /**
   * The network a plugin has. For each hop: the URL's host must be declared;
   * it is resolved here, every address is checked (loopback, private,
   * link-local and unspecified addresses are refused unless the permission
   * names that host literally: an IP, `localhost` or `*.localhost`), and the
   * connection is pinned to the checked address, so a DNS answer that changes
   * between the check and the connect reaches nothing else.
   */
  const brokerFetch = async (params: Record<string, unknown>): Promise<Record<string, unknown>> => {
    let url: URL;
    try {
      url = new URL(String(params.url));
    } catch {
      throw new Error(`ctx.fetch: not a URL: ${String(params.url).slice(0, 200)}`);
    }
    let method = typeof params.method === "string" ? params.method.toUpperCase() : "GET";
    const headers = params.headers && typeof params.headers === "object" ? Object.fromEntries(Object.entries(params.headers as Record<string, unknown>).filter(([key, value]) => typeof value === "string" && !HOP_HEADERS.has(key.toLowerCase()))) as Record<string, string> : {};
    const rawBody = params.body as { text?: unknown; base64?: unknown; type?: unknown } | undefined;
    let body: Buffer | undefined = typeof rawBody?.text === "string" ? Buffer.from(rawBody.text, "utf8") : typeof rawBody?.base64 === "string" ? Buffer.from(rawBody.base64, "base64") : undefined;
    if (typeof rawBody?.type === "string" && !Object.keys(headers).some((key) => key.toLowerCase() === "content-type")) headers["content-type"] = rawBody.type;
    if (body && body.byteLength > MAX_FETCH_BYTES) throw new Error("ctx.fetch: request body is larger than 10 MB");
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`ctx.fetch refused: only http and https URLs (${url.protocol})`);
      const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
      const covering = netPermissionCovers(permissions, url);
      if (!covering) {
        await receipt({ type: "plugin.denied", permission: `net:${host}`, detail: `ctx.fetch ${method} ${url.origin}` });
        throw new Error(`ctx.fetch refused: ${host}${url.port ? `:${url.port}` : ""} is not declared in the plugin's permissions (add "net:${host}")`);
      }
      const pinned = await checkedAddress(host);
      const response = await pinnedRequest(url, pinned, method, headers, body);
      const location = response.headers.location;
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && typeof location === "string") {
        response.resume();
        url = new URL(location, url);
        if (response.statusCode === 303 || ((response.statusCode === 301 || response.statusCode === 302) && method === "POST")) {
          method = "GET";
          body = undefined;
        }
        continue;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of response as AsyncIterable<Buffer>) {
        size += chunk.byteLength;
        if (size > MAX_FETCH_BYTES) {
          response.destroy();
          throw new Error("ctx.fetch: response is larger than 10 MB");
        }
        chunks.push(chunk);
      }
      const pairs: Array<[string, string]> = [];
      for (let index = 0; index + 1 < response.rawHeaders.length; index += 2) pairs.push([response.rawHeaders[index]!, response.rawHeaders[index + 1]!]);
      return { status: response.statusCode ?? 0, statusText: response.statusMessage ?? "", headers: pairs, url: url.href, bodyBase64: Buffer.concat(chunks).toString("base64") };
    }
    throw new Error(`ctx.fetch: more than ${MAX_REDIRECTS} redirects`);
  };

  /** Resolve once and check every answer; the first is the one the connection is pinned to. */
  const checkedAddress = async (host: string): Promise<{ readonly address: string; readonly family: 4 | 6 }> => {
    const literal = isIP(host);
    const answers = literal ? [{ address: host, family: literal }] : await resolveHost(host).catch((error: unknown) => {
      throw new Error(`ctx.fetch: could not resolve ${host}: ${error instanceof Error ? error.message : String(error)}`);
    });
    if (!answers.length) throw new Error(`ctx.fetch: ${host} has no address`);
    // A permission that names the local host itself means it.
    const namedLiterally = literal !== 0 || host === "localhost" || host.endsWith(".localhost");
    for (const answer of answers) {
      if (!namedLiterally && isRestrictedAddress(answer.address)) {
        await receipt({ type: "plugin.denied", permission: `net:${host}`, detail: `${host} resolves to a private address ${answer.address}` });
        throw new Error(`ctx.fetch refused: ${host} resolves to a private address ${answer.address} (only a permission naming that address or localhost may reach it)`);
      }
    }
    const first = answers[0]!;
    return { address: first.address, family: first.family === 6 ? 6 : 4 };
  };

  const pinnedRequest = (url: URL, pinned: { readonly address: string; readonly family: 4 | 6 }, method: string, headers: Record<string, string>, body: Buffer | undefined): Promise<IncomingMessage> => {
    // The socket asks this, never the resolver: it gets only the checked address.
    const lookup: LookupFunction = (_hostname, lookupOptions, callback) => {
      if ((lookupOptions as { all?: boolean }).all) (callback as unknown as (error: null, addresses: Array<{ address: string; family: number }>) => void)(null, [{ address: pinned.address, family: pinned.family }]);
      else callback(null, pinned.address, pinned.family);
    };
    const request = url.protocol === "https:" ? httpsRequest : httpRequest;
    return new Promise((resolveResponse, rejectResponse) => {
      const outgoing = request(url, { method, headers, lookup, agent: false, timeout: timeoutMs, ...(url.protocol === "https:" ? { servername: isIP(url.hostname) ? undefined : url.hostname } : {}) }, resolveResponse);
      outgoing.on("timeout", () => outgoing.destroy(new Error(`ctx.fetch: no response from ${url.host} within ${timeoutMs}ms`)));
      outgoing.on("error", (error) => rejectResponse(new Error(`ctx.fetch ${url.origin}: ${error.message}`)));
      outgoing.end(body);
    });
  };

  // Lines the child sent that are not on the whitelist, counted into one receipt per burst.
  let ignored = 0;
  let ignoredSample = "";
  let ignoredFlush: NodeJS.Timeout | undefined;
  const ignore = (line: string): void => {
    ignored += 1;
    if (!ignoredSample) ignoredSample = line.slice(0, 200);
    ignoredFlush ??= setTimeout(flushIgnored, 0);
  };
  const flushIgnored = (): void => {
    if (ignoredFlush) clearTimeout(ignoredFlush);
    ignoredFlush = undefined;
    if (!ignored) return;
    void receipt({ type: "plugin.protocol_ignored", count: ignored, detail: `lines from the plugin that were not a reply to a request Muster sent, nor ready, denied or fetch; sample: ${ignoredSample}` });
    ignored = 0;
    ignoredSample = "";
  };

  /**
   * The child may only send: ready, denied, fetch requests, and replies to
   * requests the parent sent and has not answered yet. A plugin can write
   * fd 3 itself, so everything else is ignored and counted.
   */
  const onMessage = (target: ChildProcess, message: Record<string, unknown>, line: string): void => {
    if (target !== child) return;
    const messageId = message.id;
    const isReply = typeof messageId === "number" && message.method === undefined && ("result" in message || "error" in message);
    if (isReply) {
      const entry = pending.get(messageId);
      if (!entry) return ignore(line);
      pending.delete(messageId);
      clearTimeout(entry.timer);
      updateRef();
      const error = message.error as { message?: unknown } | undefined;
      if (error) entry.reject({ kind: "remote", message: typeof error.message === "string" ? error.message.slice(0, 2_000) : "plugin error" });
      else entry.resolve(message.result);
      return;
    }
    if (typeof messageId === "string" && /^c\d{1,12}$/.test(messageId) && message.method === "fetch") {
      brokerFetch((message.params ?? {}) as Record<string, unknown>).then(
        (result) => send(target, { id: messageId, result }),
        (error: unknown) => send(target, { id: messageId, error: { message: error instanceof Error ? error.message : String(error) } }),
      );
      return;
    }
    if (messageId === undefined && message.method === "denied" && message.params && typeof message.params === "object") return handleDenied(message.params as Record<string, unknown>);
    if (messageId === undefined && message.method === "ready") return;
    ignore(line);
  };

  const spawnChild = async (): Promise<ChildProcess> => {
    const paths = await allowPaths();
    const args = [
      "--permission",
      ...paths.read.map((path) => `--allow-fs-read=${path}`),
      ...paths.write.map((path) => `--allow-fs-write=${path}`),
      "--max-old-space-size=512",
      "--no-warnings",
      "--input-type=module",
      "-e",
      PLUGIN_HOST_RUNTIME,
    ];
    const workspace = resolve(options.workspace);
    const proc = spawn(options.nodePath ?? process.execPath, args, {
      cwd: workspace,
      env: childEnv(),
      stdio: ["pipe", "pipe", "pipe", "pipe"],
      detached: false,
    });
    trackChild(proc);
    proc.stdout?.on("data", (chunk: Buffer) => appendLog(chunk.toString("utf8")));
    proc.stderr?.on("data", (chunk: Buffer) => appendLog(chunk.toString("utf8")));
    proc.stdin?.on("error", () => undefined);
    const channel = proc.stdio[3] as Readable | null;
    let buffer = "";
    channel?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (buffer.length > MAX_LINE_BYTES) {
        appendLog(`[muster] plugin ${id} sent a protocol line over 16 MB; stopping it\n`);
        buffer = "";
        proc.kill("SIGKILL");
        return;
      }
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!line.trim()) continue;
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          if (proc === child) ignore(line);
          continue;
        }
        if (message && typeof message === "object" && !Array.isArray(message)) onMessage(proc, message as Record<string, unknown>, line);
        else if (proc === child) ignore(line);
      }
    });
    channel?.on("error", () => undefined);
    proc.once("exit", (code, signal) => {
      if (proc !== child) return;
      const description = signal ? `signal ${signal}` : `exit ${code ?? "?"}`;
      const waiting = [...pending.values()];
      pending.clear();
      for (const entry of waiting) {
        clearTimeout(entry.timer);
        entry.reject(status === "stopped" ? { kind: "stopped" } : { kind: "exit", description });
      }
      if (status === "running" && !waiting.length) void recover(`crashed (${description})`, proc);
    });
    return proc;
  };

  const call = (method: string, params: Record<string, unknown>, ms: number): Promise<unknown> => {
    const target = child;
    if (!target || target.exitCode !== null || target.signalCode !== null) return Promise.reject({ kind: "exit", description: "not running" } satisfies Failure);
    return new Promise<unknown>((resolveCall, rejectCall) => {
      const messageId = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(messageId);
        updateRef();
        rejectCall({ kind: "timeout", ms } satisfies Failure);
      }, ms);
      pending.set(messageId, { resolve: resolveCall, reject: rejectCall, timer });
      updateRef();
      send(target, { jsonrpc: "2.0", id: messageId, method, params });
    });
  };

  const accept = async (raw: unknown): Promise<PluginLoadResult> => {
    const list = Array.isArray((raw as { registrations?: unknown })?.registrations) ? (raw as { registrations: unknown[] }).registrations.slice(0, 200) : [];
    const accepted: PluginRegistration[] = [];
    const refused: PluginRefusal[] = [];
    const warnings: string[] = [];
    const has = (permission: string) => permissions.includes(permission);
    const refuse = async (refusal: PluginRefusal): Promise<void> => {
      refused.push(refusal);
      warnings.push(`plugin ${id}: ${refusal.kind} ${refusal.name} refused: ${refusal.reason}`);
      await receipt(refusal.permission
        ? { type: "plugin.denied", permission: refusal.permission, kind: refusal.kind, name: refusal.name, detail: refusal.reason }
        : { type: "plugin.refused", kind: refusal.kind, name: refusal.name, detail: refusal.reason });
    };
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const entry = item as Record<string, unknown>;
      const kind = String(entry.kind);
      const name = typeof entry.name === "string" ? entry.name.slice(0, 80) : "";
      const description = typeof entry.description === "string" ? entry.description.slice(0, 500) : undefined;
      if (kind === "tool") {
        if (!has("tools")) { await refuse({ kind, name, permission: "tools", reason: "needs permission tools (not declared)" }); continue; }
        if (!NAME_PATTERN.test(name)) { await refuse({ kind, name, reason: "a tool name must be letters, digits, _ or - (at most 64)" }); continue; }
        if (reservedTools.has(name)) { await refuse({ kind, name, reason: `${name} is a Muster tool` }); continue; }
        if (accepted.some((other) => other.kind === "tool" && other.name === name)) { await refuse({ kind, name, reason: "registered twice" }); continue; }
        const schema = entry.inputSchema;
        if (!schema || typeof schema !== "object" || Array.isArray(schema)) { await refuse({ kind, name, reason: "a tool needs an inputSchema object" }); continue; }
        accepted.push({ kind: "tool", name, ...(description !== undefined ? { description } : {}), inputSchema: schema as Record<string, unknown> });
      } else if (kind === "hook") {
        const event = name as HookName;
        if (!(PLUGIN_HOOK_EVENTS as readonly string[]).includes(event)) { await refuse({ kind, name, reason: `unknown hook event ${name}` }); continue; }
        if (!has(`hooks:${event}`)) { await refuse({ kind, name, permission: `hooks:${event}`, reason: `needs permission hooks:${event} (not declared)` }); continue; }
        if (!accepted.some((other) => other.kind === "hook" && other.name === event)) accepted.push({ kind: "hook", name: event, event });
      } else if (kind === "command") {
        const commandName = name.replace(/^\//, "");
        if (!has("commands")) { await refuse({ kind, name: commandName, permission: "commands", reason: "needs permission commands (not declared)" }); continue; }
        if (!COMMAND_PATTERN.test(commandName)) { await refuse({ kind, name: commandName, reason: "a command name must be lowercase letters, digits or - (at most 41)" }); continue; }
        if (reservedCommands.has(commandName)) { await refuse({ kind, name: commandName, reason: `/${commandName} is a built-in command` }); continue; }
        if (accepted.some((other) => other.kind === "command" && other.name === commandName)) { await refuse({ kind, name: commandName, reason: "registered twice" }); continue; }
        accepted.push({ kind: "command", name: commandName, ...(description !== undefined ? { description } : {}), ...(typeof entry.usage === "string" ? { usage: entry.usage.slice(0, 120) } : {}) });
      }
    }
    return { registrations: accepted, refused, warnings };
  };

  const boot = async (): Promise<PluginLoadResult> => {
    const proc = await spawnChild();
    child = proc;
    status = "running";
    const loaded = await call("load", { entry: resolve(options.root, manifest.entry), pluginId: id, config: options.config ?? {}, workspace: resolve(options.workspace) }, Math.max(timeoutMs, 10_000))
      .catch(async (reason: Failure) => {
        const text = describeFailure(reason);
        proc.kill("SIGKILL");
        throw new Error(`plugin ${id} did not load: ${text}${logTail.trim() ? ` — ${logTail.trim().split("\n").slice(-3).join(" | ").slice(0, 400)}` : ""}`);
      });
    const result = await accept(loaded);
    await receipts;
    registrations = [...result.registrations];
    updateRef();
    return result;
  };

  const describeFailure = (reason: Failure): string => {
    switch (reason.kind) {
      case "timeout": return `timed out after ${reason.ms}ms`;
      case "exit": return `crashed (${reason.description})`;
      case "remote": return reason.message;
      case "stopped": return "stopped";
    }
  };

  /** Kill a broken host and start a new one, unless it has broken too often. Once per child. */
  const recover = (reason: string, proc: ChildProcess): Promise<string> => {
    if (recovering?.child === proc) return recovering.outcome;
    const outcome = (async () => {
      if (proc.exitCode === null && proc.signalCode === null) {
        proc.kill("SIGKILL");
        await new Promise<void>((done) => proc.once("exit", () => done()));
      }
      if (status === "stopped") return "stopped";
      const now = Date.now();
      while (restarts.length && now - restarts[0]! > restartWindowMs) restarts.shift();
      if (restarts.length >= maxRestarts) {
        status = "failed";
        failure = `${reason}; restarted ${restarts.length} times in ${Math.round(restartWindowMs / 1000)}s, so it was stopped`;
        child = undefined;
        appendLog(`[muster] plugin ${id} failed: ${failure}\n`);
        try { options.onFailed?.(failure); } catch { /* reporting only */ }
        return "marked failed";
      }
      restarts.push(now);
      appendLog(`[muster] plugin ${id} ${reason}; restarting\n`);
      try {
        booting = boot();
        await booting;
        return "restarted";
      } catch (error) {
        status = "failed";
        failure = `${reason}; the restart failed: ${error instanceof Error ? error.message : String(error)}`;
        try { options.onFailed?.(failure); } catch { /* reporting only */ }
        return "marked failed";
      } finally {
        booting = undefined;
        updateRef();
      }
    })();
    recovering = { child: proc, outcome };
    return outcome;
  };

  /** Call into the plugin; a crash or timeout becomes an error string and a restart. */
  const invoke = async (method: string, params: Record<string, unknown>, ms: number, what: string): Promise<unknown> => {
    if (status === "failed") throw new Error(`plugin ${id} failed: ${failure ?? "unknown"}`);
    if (status === "stopped" || status === "idle") throw new Error(`plugin ${id} is not running`);
    if (booting) await booting.catch(() => undefined);
    if (recovering) await recovering.outcome;
    const proc = child;
    if (!proc || status !== "running") throw new Error(`plugin ${id} failed: ${failure ?? "not running"}`);
    try {
      const result = await call(method, params, ms);
      flushIgnored();
      await receipts;
      return result;
    } catch (reason) {
      await receipts;
      const failed = reason as Failure;
      if (failed.kind === "remote") throw new Error(failed.message);
      if (failed.kind === "stopped") throw new Error(`plugin ${id} was stopped`);
      if (failed.kind === "timeout") {
        const outcome = await recover(`${what} timed out after ${failed.ms}ms`, proc);
        throw new Error(`plugin ${id}: ${what} timed out after ${failed.ms}ms; ${outcome}`);
      }
      const outcome = await recover(`crashed (${failed.description})`, proc);
      throw new Error(`plugin ${id} crashed (${failed.description}); ${outcome}`);
    }
  };

  const has = (kind: PluginRegistration["kind"], name: string) => registrations.some((entry) => entry.kind === kind && entry.name === name);

  return {
    id,
    get pid() { return child?.pid; },
    get status() { return status; },
    get failure() { return failure; },
    get registrations() { return registrations; },
    get log() { return logTail; },
    async start() {
      if (status === "running") return { registrations, refused: [], warnings: [] };
      if (status === "failed") throw new Error(`plugin ${id} failed: ${failure}`);
      if (validate) throw new Error("a validation host is driven with importOnly and registerOnly");
      booting = boot();
      try {
        return await booting;
      } catch (error) {
        status = "failed";
        failure = error instanceof Error ? error.message : String(error);
        child = undefined;
        throw error;
      } finally {
        booting = undefined;
        updateRef();
      }
    },
    async importOnly() {
      const proc = await spawnChild();
      child = proc;
      status = "running";
      const result = await call("load", { entry: resolve(options.root, manifest.entry), pluginId: id, config: {}, workspace: resolve(options.workspace), phase: "import" }, Math.max(timeoutMs, 10_000))
        .catch((reason: Failure) => { throw new Error(describeFailure(reason)); });
      return { hasRegister: Boolean((result as { hasRegister?: unknown })?.hasRegister) };
    },
    async registerOnly() {
      const result = await call("register", {}, Math.max(timeoutMs, 10_000)).catch((reason: Failure) => { throw new Error(describeFailure(reason)); });
      const list = Array.isArray((result as { registrations?: unknown })?.registrations) ? (result as { registrations: PluginRegistration[] }).registrations : [];
      return list.slice(0, 200);
    },
    async callTool(name, args) {
      if (!has("tool", name)) return { ok: false, error: `plugin ${id} has no tool ${name}` };
      try {
        const result = await invoke("tool", { name, args }, timeoutMs, `tool ${name}`);
        return { ok: true, data: (result as { data?: unknown })?.data ?? null };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    async runHook(event, payload) {
      if (!has("hook", event)) return { action: "pass" };
      try {
        const result = await invoke("hook", { event, payload }, hookTimeoutMs, `hook ${event}`) as { action?: unknown; reason?: unknown };
        if (result?.action === "block") return { action: "block", reason: typeof result.reason === "string" && result.reason ? result.reason.slice(0, 500) : `blocked by plugin ${id}` };
        return { action: "pass" };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        appendLog(`[muster] plugin ${id} hook ${event} failed: ${message}\n`);
        await receipt({ type: "plugin.hook_failed", event, detail: message.slice(0, 300), failClosed: manifest.failClosed === true });
        return manifest.failClosed ? { action: "block", reason: `plugin ${id} hook failed (fail closed): ${message}` } : { action: "pass", reason: message };
      }
    },
    async runCommand(name, args) {
      if (!has("command", name)) return { ok: false, error: `plugin ${id} has no command /${name}` };
      try {
        const result = await invoke("command", { name, args }, timeoutMs, `command /${name}`) as { text?: unknown };
        return { ok: true, text: typeof result?.text === "string" ? result.text.slice(0, 100_000) : "" };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    async stop() {
      status = "stopped";
      const proc = child;
      child = undefined;
      registrations = [];
      if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
      const exited = new Promise<void>((done) => proc.once("exit", () => done()));
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject({ kind: "stopped" });
      }
      pending.clear();
      proc.stdin?.end();
      const timer = setTimeout(() => proc.kill("SIGKILL"), 1_000);
      proc.kill("SIGTERM");
      await exited;
      clearTimeout(timer);
    },
  };
}
