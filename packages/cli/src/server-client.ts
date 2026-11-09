import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** The saved connection to a Muster Server. The token is an API token minted with `muster-server token create`. */
export interface ServerLink {
  readonly url: string;
  readonly token: string;
  readonly user?: string;
  readonly serverVersion?: string;
  readonly connectedAt: string;
}

export type FetchLike = (url: string, init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>;

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

export class ServerError extends Error {
  constructor(message: string, readonly status?: number, readonly code?: string) {
    super(message);
    this.name = "ServerError";
  }
}

/** https only; plain http only for a server on this computer. A token never travels in clear text over a network. */
export function normalizeServerUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new ServerError("Give the server address, for example https://muster.example.com.");
  }
  if (url.username || url.password) throw new ServerError("Leave the user name and password out of the address.");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) {
    throw new ServerError("Use https://. Plain http:// is only for a server on this computer.");
  }
  return url.origin;
}

export function serverLinkPath(home = process.env.MUSTER_SERVER_LINK_HOME || homedir()): string {
  return join(home, ".muster", "server.json");
}

export async function loadServerLink(path = serverLinkPath()): Promise<ServerLink | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<ServerLink>;
    if (typeof value.url === "string" && typeof value.token === "string") return value as ServerLink;
  } catch {
    // no link yet
  }
  return undefined;
}

export async function saveServerLink(link: ServerLink, path = serverLinkPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(link, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600).catch(() => undefined);
}

export async function removeServerLink(path = serverLinkPath()): Promise<boolean> {
  const existed = (await loadServerLink(path)) !== undefined;
  await rm(path, { force: true });
  return existed;
}

const defaultFetch: FetchLike = async (url, init) => {
  const response = await fetch(url, init);
  return { status: response.status, text: () => response.text() };
};

async function timed<T>(run: (signal: AbortSignal) => Promise<T>, ms = 15_000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await run(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) throw new ServerError("The server did not answer in time.");
    throw new ServerError(`Could not reach the server: ${(error as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

/** GET /healthz: unauthenticated; proves the address is a Muster Server and reports its version. */
export async function serverHealth(url: string, fetchImpl: FetchLike = defaultFetch): Promise<{ name: string; version: string }> {
  const response = await timed((signal) => fetchImpl(`${url}/healthz`, { signal }));
  let body: { ok?: boolean; name?: string; version?: string };
  try {
    body = JSON.parse(await response.text()) as typeof body;
  } catch {
    throw new ServerError(`${url} answered HTTP ${response.status}, not a Muster Server.`);
  }
  if (!body.ok || body.name !== "Muster Server") throw new ServerError(`${url} is not a Muster Server.`);
  return { name: body.name, version: String(body.version ?? "unknown") };
}

/** The signed-in person for a token (the server's own account check). */
export async function serverWhoAmI(link: Pick<ServerLink, "url" | "token">, fetchImpl: FetchLike = defaultFetch): Promise<{ username: string; role: string }> {
  const response = await timed((signal) => fetchImpl(`${link.url}/api/auth/me`, { headers: { authorization: `Bearer ${link.token}`, accept: "application/json" }, signal }));
  if (response.status === 401) throw new ServerError("The server rejected this token. Create a new one with `muster-server token create`.", 401, "auth");
  const body = JSON.parse(await response.text()) as { ok?: boolean; user?: { username: string; role: string } };
  if (!body.ok || !body.user) throw new ServerError(`Unexpected answer from the server (HTTP ${response.status}).`, response.status);
  return body.user;
}

/** POST /rpc with the same command names the app sends; the token's role and project grants apply. */
export async function serverRpc<T = unknown>(link: Pick<ServerLink, "url" | "token">, command: string, input: Record<string, unknown> = {}, fetchImpl: FetchLike = defaultFetch): Promise<T> {
  const response = await timed((signal) => fetchImpl(`${link.url}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${link.token}` },
    body: JSON.stringify({ command, input }),
    signal,
  }));
  let body: { ok?: boolean; value?: T; error?: string; code?: string };
  try {
    body = JSON.parse(await response.text()) as typeof body;
  } catch {
    throw new ServerError(`The server answered HTTP ${response.status}, not JSON.`, response.status);
  }
  if (!body.ok) throw new ServerError(body.error ?? `Request failed (HTTP ${response.status}).`, response.status, body.code);
  return body.value as T;
}
