/**
 * Code plugins in a running Muster process: start a host per enabled plugin,
 * apply what it registered (tools into the tool registry, hooks onto the hook
 * bus, chat commands), and undo each of those through a ledger.
 *
 * The ledger (`<plugins>/.ledger/<id>.jsonl`) is append-only: one line per
 * registration with its inverse, one line per undo. Disable, remove, the kill
 * list and a failed host all unwind through it, in the same process, with no
 * restart. `refresh()` reconciles with the lock file, so a chat notices
 * `muster plugins disable` run from another terminal.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { PLUGIN_HOOK_PREFIX, type HookBus } from "./hooks.js";
import { digestTree, markCodePluginFailed, pluginBundlesDir, readPluginBundleLock, type PluginBundleLockEntry } from "./plugin-bundles.js";
import { createPluginHost, PLUGIN_HOOK_TIMEOUT_MS, type PluginHost, type PluginRegistration } from "./plugin-host.js";
import { killListMessage, readPluginKillList } from "./plugin-killlist.js";
import { readCodePluginManifest } from "./plugin-manifest.js";
import type { ToolRegistryV2, ToolResult } from "./tool-registry.js";

/** The toolset plugin tools are registered under. */
export const PLUGIN_TOOLSET = "plugins";

/**
 * Route a host's accepted hooks onto a bus, under the id `plugin:<id>` (so a
 * block names the plugin). Returns the inverse: remove them again.
 */
export function attachPluginHooks(bus: HookBus, host: PluginHost): () => void {
  const undo = host.registrations
    .filter((entry) => entry.kind === "hook" && entry.event)
    .map((entry) => bus.on(entry.event!, (payload) => host.runHook(entry.event!, payload), {
      id: `${PLUGIN_HOOK_PREFIX}${host.id}`,
      // The host answers within its own 2 s budget (and applies failClosed); this is only a backstop.
      timeoutMs: PLUGIN_HOOK_TIMEOUT_MS + 3_000,
    }));
  return () => { for (const remove of undo) remove(); };
}

export function pluginLedgerPath(cwd: string, id: string): string {
  return join(pluginBundlesDir(cwd), ".ledger", `${id}.jsonl`);
}

export function pluginReceiptsPath(cwd: string): string {
  return join(pluginBundlesDir(cwd), ".receipts.jsonl");
}

export function pluginLogPath(cwd: string, id: string): string {
  return join(pluginBundlesDir(cwd), ".logs", `${id}.log`);
}

export interface PluginLedgerEntry {
  readonly key: string;
  readonly plugin: string;
  readonly kind: PluginRegistration["kind"];
  readonly name: string;
  /** What undoing it does, in words. */
  readonly inverse: string;
  readonly owner: { readonly pid: number; readonly label: string };
  readonly registeredAt: string;
  readonly undone: boolean;
  readonly undoneAt?: string;
  /** Why it was undone: disabled, removed, kill list, failed, stopped, or the owner exited. */
  readonly undoneBecause?: string;
}

/** The ledger folded: each registration once, with whether it has been undone. A registration whose process is gone counts as undone. */
export async function readPluginLedger(cwd: string, id: string): Promise<PluginLedgerEntry[]> {
  const text = await readFile(pluginLedgerPath(cwd, id), "utf8").catch(() => "");
  const entries = new Map<string, PluginLedgerEntry>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const key = String(record.key ?? "");
    if (record.op === "register") {
      entries.set(key, {
        key,
        plugin: id,
        kind: record.kind as PluginRegistration["kind"],
        name: String(record.name ?? ""),
        inverse: String(record.inverse ?? ""),
        owner: (record.owner ?? { pid: 0, label: "?" }) as PluginLedgerEntry["owner"],
        registeredAt: String(record.at ?? ""),
        undone: false,
      });
    } else if (record.op === "undo" && entries.has(key)) {
      entries.set(key, { ...entries.get(key)!, undone: true, undoneAt: String(record.at ?? ""), undoneBecause: String(record.because ?? "") });
    }
  }
  return [...entries.values()].map((entry) => (entry.undone || processAlive(entry.owner.pid) ? entry : { ...entry, undone: true, undoneBecause: "owner exited" }));
}

function processAlive(pid: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface PluginRuntimeOptions {
  /** Workspace and profile the plugins belong to. */
  readonly cwd?: string;
  /** Plugin tools are registered here (toolset "plugins"); none when absent. */
  readonly registry?: ToolRegistryV2;
  /** Plugin hooks are added here; none when absent. */
  readonly hooks?: HookBus;
  /** Chat command names plugins may not take (built-ins). */
  readonly reservedCommands?: Iterable<string>;
  readonly env?: NodeJS.ProcessEnv;
  /** Recorded in the ledger: which process registered what ("chat", "mcp"). */
  readonly owner?: string;
}

export interface PluginRuntimeCommand {
  readonly plugin: string;
  readonly name: string;
  readonly description?: string;
  readonly usage?: string;
}

export interface PluginRuntimeRefresh {
  /** Lines to show the user; each one is returned only once per runtime. */
  readonly warnings: readonly string[];
}

export interface PluginRuntime {
  refresh(): Promise<PluginRuntimeRefresh>;
  commands(): PluginRuntimeCommand[];
  toolNames(): string[];
  host(id: string): PluginHost | undefined;
  runCommand(name: string, args: string): Promise<{ readonly ok: true; readonly text: string } | { readonly ok: false; readonly error: string }>;
  callTool(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  stop(): Promise<void>;
}

interface LoadedPlugin {
  readonly host: PluginHost;
  readonly digest: string;
  readonly undo: Array<{ readonly key: string; readonly run: () => void }>;
}

export function createPluginRuntime(options: PluginRuntimeOptions = {}): PluginRuntime {
  const cwd = options.cwd ?? process.cwd();
  const owner = { pid: process.pid, label: options.owner ?? "muster" };
  const reservedCommands = new Set(options.reservedCommands ?? []);
  const loaded = new Map<string, LoadedPlugin>();
  const commands = new Map<string, { readonly plugin: string; readonly registration: PluginRegistration; readonly host: PluginHost }>();
  const tools = new Map<string, PluginHost>();
  const told = new Set<string>();
  let sequence = 0;
  let chain: Promise<unknown> = Promise.resolve();

  const ledger = (id: string, record: Record<string, unknown>): void => {
    try {
      const path = pluginLedgerPath(cwd, id);
      mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
      appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`, { encoding: "utf8", mode: 0o600 });
    } catch {
      // The ledger is a record; a write failure never blocks an unwind.
    }
  };

  const unload = async (id: string, because: string): Promise<void> => {
    const plugin = loaded.get(id);
    if (!plugin) return;
    loaded.delete(id);
    for (const step of [...plugin.undo].reverse()) {
      try { step.run(); } catch { /* already gone */ }
      ledger(id, { op: "undo", key: step.key, because });
    }
    await plugin.host.stop();
  };

  const apply = (id: string, host: PluginHost, warnings: string[]): LoadedPlugin["undo"] => {
    const undo: LoadedPlugin["undo"] = [];
    const record = (registration: PluginRegistration, inverse: string, run: () => void): void => {
      const key = `${owner.pid}-${Date.now().toString(36)}-${++sequence}`;
      ledger(id, { op: "register", key, kind: registration.kind, name: registration.name, inverse, owner });
      undo.push({ key, run });
    };
    for (const registration of host.registrations) {
      if (registration.kind === "tool" && options.registry) {
        const registry = options.registry;
        try {
          registry.register({
            name: registration.name,
            toolset: PLUGIN_TOOLSET,
            description: registration.description ?? `${registration.name} (plugin ${id})`,
            inputSchema: registration.inputSchema,
            handler: (args: Record<string, unknown>) => host.callTool(registration.name, args),
          });
        } catch {
          warnings.push(`plugin ${id}: tool ${registration.name} refused: another tool already has that name`);
          continue;
        }
        tools.set(registration.name, host);
        record(registration, `unregister tool ${registration.name}`, () => { registry.unregister(registration.name); tools.delete(registration.name); });
      } else if (registration.kind === "hook" && options.hooks && registration.event) {
        const remove = options.hooks.on(registration.event, (payload) => host.runHook(registration.event!, payload), { id: `${PLUGIN_HOOK_PREFIX}${id}`, timeoutMs: PLUGIN_HOOK_TIMEOUT_MS + 3_000 });
        record(registration, `remove ${registration.event} hook ${PLUGIN_HOOK_PREFIX}${id}`, remove);
      } else if (registration.kind === "command") {
        if (commands.has(registration.name)) {
          warnings.push(`plugin ${id}: command ${registration.name} refused: plugin ${commands.get(registration.name)!.plugin} already has /${registration.name}`);
          continue;
        }
        commands.set(registration.name, { plugin: id, registration, host });
        record(registration, `remove chat command /${registration.name}`, () => {
          if (commands.get(registration.name)?.host === host) commands.delete(registration.name);
        });
      }
    }
    return undo;
  };

  const load = async (entry: PluginBundleLockEntry, config: Awaited<ReturnType<typeof loadConfig>> | undefined, warnings: string[]): Promise<void> => {
    const id = entry.id;
    const code = entry.code!;
    // Pinned: the files must be exactly what was installed (and approved).
    const digest = await digestTree(entry.installedPath).catch(() => "missing");
    if (digest !== entry.digest) {
      warnings.push(`plugin ${id} not loaded: its files changed since install (reinstall it with muster plugins install --force)`);
      return;
    }
    const report = await readCodePluginManifest(entry.installedPath);
    if (!report.manifest) {
      warnings.push(`plugin ${id} not loaded: ${report.errors.map((error) => `${error.field} ${error.message}`).join("; ")}`);
      return;
    }
    const host = createPluginHost({
      root: entry.installedPath,
      // The permissions approved at install are the ones enforced.
      manifest: { ...report.manifest, permissions: code.permissions, ...(code.timeoutMs !== undefined ? { timeoutMs: code.timeoutMs } : {}), ...(code.failClosed !== undefined ? { failClosed: code.failClosed } : {}) },
      workspace: cwd,
      receiptsPath: pluginReceiptsPath(cwd),
      logPath: pluginLogPath(cwd, id),
      ...(options.env ? { env: options.env } : {}),
      ...(config?.plugins?.entries?.[id]?.config ? { config: config.plugins.entries[id]!.config as Record<string, unknown> } : {}),
      reservedTools: (options.registry?.list() ?? []).filter((tool) => tool.toolset !== PLUGIN_TOOLSET).map((tool) => tool.name),
      reservedCommands,
      onFailed: (reason) => {
        // Recorded before the unwind, so the next refresh does not load it again.
        chain = chain.then(async () => {
          await markCodePluginFailed(id, reason, cwd);
          await unload(id, "failed");
        }).catch(() => undefined);
      },
    });
    try {
      const result = await host.start();
      warnings.push(...result.warnings);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await markCodePluginFailed(id, reason, cwd);
      warnings.push(`plugin ${id} failed to start: ${reason}`);
      return;
    }
    loaded.set(id, { host, digest, undo: apply(id, host, warnings) });
  };

  const reconcile = async (): Promise<PluginRuntimeRefresh> => {
    const warnings: string[] = [];
    const lock = await readPluginBundleLock(cwd).catch(() => undefined);
    const entries = lock?.entries ?? {};
    const killed = readPluginKillList(cwd);
    const config = await loadConfig(cwd).catch(() => undefined);
    for (const [id, plugin] of [...loaded]) {
      const entry = entries[id];
      const because = !entry?.code ? "removed"
        : !entry.code.enabled ? "disabled"
          : entry.code.failed ? "failed"
            : killed.has(id) ? "kill list"
              : config?.plugins?.deny?.includes(id) ? "denied"
                : entry.digest !== plugin.digest ? "reinstalled"
                  : plugin.host.status === "failed" ? "failed" : undefined;
      if (because) await unload(id, because);
    }
    for (const entry of Object.values(entries).sort((a, b) => a.id.localeCompare(b.id))) {
      if (!entry.code?.enabled || entry.code.failed || loaded.has(entry.id)) continue;
      const withdrawn = killed.get(entry.id);
      if (withdrawn) {
        warnings.push(`plugin ${entry.id} not loaded: ${killListMessage(withdrawn)}`);
        continue;
      }
      if (config?.plugins?.deny?.includes(entry.id)) {
        warnings.push(`plugin ${entry.id} not loaded: denied by plugins.deny`);
        continue;
      }
      await load(entry, config, warnings);
    }
    const fresh = warnings.filter((line) => !told.has(line));
    for (const line of fresh) told.add(line);
    return { warnings: fresh };
  };

  return {
    refresh() {
      const run = chain.then(reconcile, reconcile);
      chain = run.catch(() => undefined);
      return run;
    },
    commands() {
      return [...commands.values()].map(({ plugin, registration }) => ({
        plugin,
        name: registration.name,
        ...(registration.description ? { description: registration.description } : {}),
        ...(registration.usage ? { usage: registration.usage } : {}),
      }));
    },
    toolNames() {
      return [...tools.keys()];
    },
    host(id) {
      return loaded.get(id)?.host;
    },
    async runCommand(name, args) {
      const command = commands.get(name);
      if (!command) return { ok: false, error: `No plugin command /${name}` };
      return command.host.runCommand(name, args);
    },
    async callTool(name, args) {
      const host = tools.get(name);
      if (!host) return { ok: false, error: `No plugin tool ${name}` };
      return host.callTool(name, args);
    },
    async stop() {
      await chain.catch(() => undefined);
      for (const id of [...loaded.keys()]) await unload(id, "stopped");
    },
  };
}
