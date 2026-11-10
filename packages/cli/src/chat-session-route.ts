import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dataDir } from "@musterhq/core";

/** The runtime, provider and model a chat session last ran on, so reopening it starts there. */
export interface ChatSessionRoute {
  readonly runtime?: string;
  readonly provider?: string;
  readonly model?: string;
}

type RouteFile = Record<string, ChatSessionRoute & { readonly updatedAt?: string }>;

function routesPath(cwd: string): string {
  return join(dataDir(cwd), "chat-session-routes.json");
}

function readAll(cwd: string): RouteFile {
  try {
    const parsed = JSON.parse(readFileSync(routesPath(cwd), "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as RouteFile) : {};
  } catch {
    return {};
  }
}

export function readChatSessionRoute(session: string, cwd = process.cwd()): ChatSessionRoute | undefined {
  const entry = readAll(cwd)[session];
  if (!entry || (!entry.runtime && !entry.provider && !entry.model)) return undefined;
  return {
    ...(entry.runtime ? { runtime: entry.runtime } : {}),
    ...(entry.provider ? { provider: entry.provider } : {}),
    ...(entry.model ? { model: entry.model } : {}),
  };
}

/** Never throws: remembering the route is a convenience, not part of the turn. */
export function writeChatSessionRoute(session: string, route: ChatSessionRoute, cwd = process.cwd()): void {
  try {
    const all = readAll(cwd);
    all[session] = {
      ...(route.runtime ? { runtime: route.runtime } : {}),
      ...(route.provider ? { provider: route.provider } : {}),
      ...(route.model ? { model: route.model } : {}),
      updatedAt: new Date().toISOString(),
    };
    const path = routesPath(cwd);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(all, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temp, path);
  } catch {
    /* best effort */
  }
}

/** The remembered route applies only when the command line names no runtime, provider or model. */
export function sessionRouteToRestore(flags: ChatSessionRoute, stored: ChatSessionRoute | undefined): ChatSessionRoute | undefined {
  if (flags.runtime || flags.provider || flags.model) return undefined;
  return stored;
}
