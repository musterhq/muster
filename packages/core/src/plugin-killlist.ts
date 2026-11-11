/**
 * The plugin kill list: ids a marketplace (hub index) has withdrawn as known
 * bad, in a `removed.json` next to its `marketplace.json`. Every install path
 * refuses them and every load path skips them, including plugins that were
 * installed before they were listed.
 *
 * `removed.json` is a list of `{ "name": "<id>", "reason": "…" }` (or bare
 * id strings), or an object with such a list under `removed` or `plugins`.
 * Read synchronously and forgivingly: a missing or malformed file lists nothing.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { profileDataDir } from "./profiles.js";

export interface KillListEntry {
  readonly id: string;
  readonly reason: string;
  /** The marketplace whose index lists it. */
  readonly marketplace: string;
}

const REMOVED_PATHS = ["removed.json", join(".claude-plugin", "removed.json"), join(".codex-plugin", "removed.json")];

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function entriesOf(raw: unknown): Array<{ id: string; reason?: string }> {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? ((raw as Record<string, unknown>).removed ?? (raw as Record<string, unknown>).plugins) : undefined;
  if (!Array.isArray(list)) return [];
  return list.flatMap((item) => {
    if (typeof item === "string") return [{ id: item }];
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const id = typeof record.name === "string" ? record.name : typeof record.id === "string" ? record.id : undefined;
    return id ? [{ id, ...(typeof record.reason === "string" ? { reason: record.reason } : {}) }] : [];
  });
}

/** Every withdrawn plugin id across the added marketplaces. */
export function readPluginKillList(cwd = process.cwd()): Map<string, KillListEntry> {
  const killed = new Map<string, KillListEntry>();
  const registry = readJson(join(profileDataDir(cwd), "plugin-marketplaces.json")) as { marketplaces?: Array<{ name?: unknown; dir?: unknown }> } | undefined;
  for (const record of registry?.marketplaces ?? []) {
    if (typeof record.name !== "string" || typeof record.dir !== "string") continue;
    for (const relative of REMOVED_PATHS) {
      for (const entry of entriesOf(readJson(join(record.dir, relative)))) {
        const id = entry.id.trim().toLowerCase();
        if (id && !killed.has(id)) killed.set(id, { id, reason: (entry.reason ?? "withdrawn").slice(0, 300), marketplace: record.name });
      }
    }
  }
  return killed;
}

export function killListMessage(entry: KillListEntry): string {
  return `${entry.id} is on the kill list of ${entry.marketplace}: ${entry.reason}`;
}
