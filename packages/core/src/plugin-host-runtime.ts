/**
 * The code that runs inside a plugin's host process, before and around the
 * plugin. It is plain JavaScript passed to `node --permission … -e`, so it
 * needs no file on disk and no build step.
 *
 * Order matters: it opens the protocol channel (fd 3) and stdin first, then
 * locks the process down, then imports the plugin.
 *
 * Lockdown, on top of Node's permission model (which already refuses child
 * processes, workers, addons, WASI, the inspector and file access outside the
 * allowed folders):
 *  - module hooks refuse every networking and process builtin (`node:net`,
 *    `http`, `https`, `http2`, `tls`, `dgram`, `dns`, `child_process`,
 *    `worker_threads`, `cluster`, `module`, `inspector`, `v8`, `sqlite`,
 *    `_http_*`, `_tls_*`) for `import`, `import()`, `require` and
 *    `Module._load` alike;
 *  - `Module.registerHooks`/`Module.register` are replaced, so a plugin cannot
 *    add hooks of its own ahead of these;
 *  - `process.getBuiltinModule`, `process.binding`, `process._linkedBinding`,
 *    `process.dlopen` and `process.kill` are replaced;
 *  - the global `fetch`, `WebSocket` and `EventSource` are replaced;
 *  - the exports of the blocked modules are neutered in place, so a route not
 *    listed here still finds nothing that connects.
 * The only network a plugin has is `ctx.fetch`, which asks the parent, and the
 * parent checks the host against the manifest before connecting.
 *
 * The source must not contain backticks or dollar-brace sequences: it is a
 * template literal.
 */
export const PLUGIN_HOST_RUNTIME = String.raw`
import Module, { registerHooks, isBuiltin, syncBuiltinESMExports } from "node:module";
import { Socket } from "node:net";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import * as netModule from "node:net";
import * as tlsModule from "node:tls";
import * as httpModule from "node:http";
import * as httpsModule from "node:https";
import * as http2Module from "node:http2";
import * as dgramModule from "node:dgram";
import * as dnsModule from "node:dns";
import * as childModule from "node:child_process";

const channel = new Socket({ fd: 3, readable: false, writable: true });
const input = process.stdin;
// Create the console streams now, while net is intact.
void process.stdout; void process.stderr;

const send = (message) => {
  let line;
  try { line = JSON.stringify(message); } catch (error) { line = JSON.stringify({ id: message.id, error: { message: "result is not JSON: " + String(error && error.message) } }); }
  channel.write(line + "\n");
};
const reportDenied = (permission, detail) => send({ method: "denied", params: { permission, detail } });

// ---- lockdown -------------------------------------------------------------
const BLOCKED = new Set(["net", "tls", "http", "https", "http2", "dgram", "dns", "child_process", "worker_threads", "cluster", "module", "inspector", "v8", "sqlite", "repl", "trace_events", "wasi"]);
const bareName = (specifier) => String(specifier).replace(/^node:/, "").split("/")[0];
const isBlocked = (specifier) => {
  const text = String(specifier);
  if (!text.startsWith("node:") && !isBuiltin(text)) return false;
  const name = bareName(text);
  return BLOCKED.has(name) || name.startsWith("_http") || name.startsWith("_tls") || name.startsWith("_stream_wrap");
};
const denyModule = (specifier) => {
  reportDenied("module:" + bareName(specifier), "blocked builtin " + specifier);
  const error = new Error("Muster plugin host: " + specifier + " is not available to plugins (use ctx.fetch for network access to declared hosts)");
  error.code = "ERR_PLUGIN_PERMISSION";
  return error;
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (isBlocked(specifier)) throw denyModule(specifier);
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (isBlocked(url)) throw denyModule(url);
    return nextLoad(url, context);
  },
});
const lock = (target, key, value) => Object.defineProperty(target, key, { value, writable: false, configurable: false, enumerable: false });
const denied = (what) => function () {
  const error = new Error("Muster plugin host: " + what + " is not available to plugins");
  error.code = "ERR_PLUGIN_PERMISSION";
  throw error;
};
lock(Module, "registerHooks", denied("module.registerHooks"));
lock(Module, "register", denied("module.register"));
const originalGetBuiltin = process.getBuiltinModule;
lock(process, "getBuiltinModule", function getBuiltinModule(id) {
  if (isBlocked(String(id).startsWith("node:") ? id : "node:" + id)) throw denyModule(id);
  return originalGetBuiltin.call(process, id);
});
for (const key of ["binding", "_linkedBinding", "dlopen"]) lock(process, key, denied("process." + key));
const originalKill = process.kill.bind(process);
lock(process, "kill", function kill(pid, signal) {
  if (Number(pid) !== process.pid) return denied("process.kill on another process")();
  return originalKill(pid, signal);
});
class DeniedSocket { constructor() { denied("WebSocket")(); } }
class DeniedEventSource { constructor() { denied("EventSource")(); } }
lock(globalThis, "fetch", denied("the global fetch (use ctx.fetch)"));
lock(globalThis, "WebSocket", DeniedSocket);
lock(globalThis, "EventSource", DeniedEventSource);
for (const mod of [netModule, tlsModule, httpModule, httpsModule, http2Module, dgramModule, dnsModule, childModule]) {
  const target = mod.default ?? mod;
  for (const key of Object.keys(target)) {
    if (typeof target[key] === "function") {
      try { target[key] = denied("this network or process API"); } catch { /* read-only export */ }
    }
  }
  if (target.promises && typeof target.promises === "object") {
    for (const key of Object.keys(target.promises)) {
      if (typeof target.promises[key] === "function") { try { target.promises[key] = denied("this network API"); } catch {} }
    }
  }
}
syncBuiltinESMExports();

// Reads of environment variables the plugin was not given are reported (once each).
const env = process.env;
// The OS adds this to every macOS process; the plugin was not given it.
delete env.__CF_USER_TEXT_ENCODING;
const askedFor = new Set();
process.env = new Proxy(env, {
  get(target, key) {
    if (typeof key === "string" && !(key in target) && !askedFor.has(key) && askedFor.size < 200) {
      askedFor.add(key);
      reportDenied("env:" + key, "read of an environment variable the plugin was not given");
    }
    return target[key];
  },
});

// ---- protocol -------------------------------------------------------------
const tools = new Map();
const commands = new Map();
const hooks = new Map();
const registrations = [];
let registering = false;
let nextRequest = 0;
const waiting = new Map();
let pluginModule;
let loadParams = {};

const request = (method, params) => new Promise((resolve, reject) => {
  const id = "c" + (++nextRequest);
  waiting.set(id, { resolve, reject });
  send({ id, method, params });
});

const NULL_BODY = new Set([101, 103, 204, 205, 304]);
async function ctxFetch(resource, init) {
  const options = init || {};
  const url = resource instanceof URL ? resource.href : (resource && typeof resource === "object" && "url" in resource) ? String(resource.url) : String(resource);
  let body;
  if (options.body !== undefined && options.body !== null) {
    if (typeof options.body === "string") body = { text: options.body };
    else if (options.body instanceof ArrayBuffer || ArrayBuffer.isView(options.body)) body = { base64: Buffer.from(options.body instanceof ArrayBuffer ? new Uint8Array(options.body) : new Uint8Array(options.body.buffer, options.body.byteOffset, options.body.byteLength)).toString("base64") };
    else if (options.body instanceof URLSearchParams) body = { text: options.body.toString(), type: "application/x-www-form-urlencoded;charset=UTF-8" };
    else throw new TypeError("ctx.fetch: body must be a string, bytes or URLSearchParams");
  }
  const headers = options.headers ? Object.fromEntries(new Headers(options.headers)) : {};
  const result = await request("fetch", { url, method: String(options.method || "GET").toUpperCase(), headers, ...(body ? { body } : {}) });
  const bytes = NULL_BODY.has(result.status) ? null : Buffer.from(result.bodyBase64 || "", "base64");
  const response = new Response(bytes, { status: result.status, statusText: result.statusText || "", headers: result.headers || [] });
  Object.defineProperty(response, "url", { value: result.url });
  return response;
}

const describeName = (value, fallback) => typeof value === "string" ? value : fallback;
function record(kind, entry) {
  if (!registering) throw new Error("ctx." + kind + "() can only be called while register(ctx) runs");
  if (registrations.length >= 200) throw new Error("a plugin may register at most 200 things");
  registrations.push(entry);
}

const ctx = Object.freeze({
  tool(def) {
    if (!def || typeof def !== "object") throw new TypeError("ctx.tool expects { name, description, inputSchema, handler }");
    const name = describeName(def.name, "");
    const handler = def.handler || def.run || def.execute;
    if (typeof handler !== "function") throw new TypeError("ctx.tool " + name + ": handler must be a function");
    record("tool", { kind: "tool", name, description: describeName(def.description, ""), ...(def.inputSchema !== undefined ? { inputSchema: def.inputSchema } : {}) });
    tools.set(name, handler);
  },
  hook(event, handler) {
    if (typeof handler !== "function") throw new TypeError("ctx.hook(event, handler): handler must be a function");
    record("hook", { kind: "hook", name: String(event), event: String(event) });
    const list = hooks.get(String(event)) || [];
    list.push(handler);
    hooks.set(String(event), list);
  },
  command(def) {
    if (!def || typeof def !== "object") throw new TypeError("ctx.command expects { name, description, run }");
    const name = describeName(def.name, "").replace(/^\//, "");
    const run = def.run || def.handler;
    if (typeof run !== "function") throw new TypeError("ctx.command " + name + ": run must be a function");
    record("command", { kind: "command", name, description: describeName(def.description, ""), ...(typeof def.usage === "string" ? { usage: def.usage } : {}) });
    commands.set(name, run);
  },
  fetch: ctxFetch,
  get config() { return loadParams.config ?? {}; },
  get pluginId() { return loadParams.pluginId; },
  get workspace() { return loadParams.workspace; },
  log(...args) { console.error(...args); },
});

async function importEntry() {
  if (!pluginModule) pluginModule = await import(pathToFileURL(loadParams.entry).href);
  return pluginModule;
}
async function runRegister() {
  const mod = await importEntry();
  const register = typeof mod.register === "function" ? mod.register : (mod.default && typeof mod.default.register === "function" ? mod.default.register : undefined);
  if (!register) throw new Error("the entry has no register export");
  registering = true;
  try { await register(ctx); } finally { registering = false; }
  return { registrations };
}

const handlers = {
  async load(params) {
    loadParams = params || {};
    if (loadParams.phase === "import") {
      const mod = await importEntry();
      return { hasRegister: typeof mod.register === "function" || Boolean(mod.default && typeof mod.default.register === "function") };
    }
    return runRegister();
  },
  async register() { return runRegister(); },
  async tool(params) {
    const handler = tools.get(params.name);
    if (!handler) throw new Error("no tool " + params.name);
    const data = await handler(params.args ?? {}, ctx);
    return { data: data === undefined ? null : data };
  },
  async hook(params) {
    for (const handler of hooks.get(params.event) || []) {
      const decision = await handler(params.payload, ctx);
      if (decision && decision.action === "block") return { action: "block", reason: decision.reason === undefined ? "" : String(decision.reason) };
    }
    return { action: "pass" };
  },
  async command(params) {
    const run = commands.get(params.name);
    if (!run) throw new Error("no command /" + params.name);
    const value = await run(params.args ?? "", ctx);
    return { text: typeof value === "string" ? value : value && typeof value.text === "string" ? value.text : value === undefined || value === null ? "" : JSON.stringify(value) };
  },
};

createInterface({ input, crlfDelay: Infinity }).on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (!message || typeof message !== "object") return;
  if (typeof message.id === "string" && waiting.has(message.id)) {
    const pending = waiting.get(message.id);
    waiting.delete(message.id);
    if (message.error) pending.reject(new Error(String(message.error.message || "request failed")));
    else pending.resolve(message.result);
    return;
  }
  const handler = handlers[message.method];
  if (typeof handler !== "function" || message.id === undefined) return;
  Promise.resolve().then(() => handler(message.params || {})).then(
    (result) => send({ id: message.id, result }),
    (error) => send({ id: message.id, error: { message: error && error.message ? String(error.message) : String(error), ...(error && error.code ? { code: String(error.code) } : {}) } }),
  );
});
input.on("end", () => process.exit(0));
send({ method: "ready" });
`;
