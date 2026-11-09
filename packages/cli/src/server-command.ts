import {
  loadServerLink, normalizeServerUrl, removeServerLink, saveServerLink, serverHealth, serverRpc, serverWhoAmI,
  type FetchLike, type ServerLink,
} from "./server-client.js";

type Row = Record<string, any>;

export interface ServerCommandIo {
  readonly out: (line: string) => void;
  readonly env?: NodeJS.ProcessEnv;
  readonly readStdin?: () => Promise<string>;
  readonly fetch?: FetchLike;
  readonly linkPath?: string;
}

export const SERVER_USAGE = [
  "muster server connect <url> (--token-env VAR | --token-stdin)   # token from `muster-server token create`",
  "muster server status | disconnect",
  "muster server projects | tasks --project P [--state S] | approvals --project P [--all] | ledger [--limit N]   # read-only",
].join("\n  ");

function table(rows: readonly Row[], columns: readonly string[]): string {
  if (!rows.length) return "(none)";
  const cell = (value: unknown) => (value === null || value === undefined || value === "" ? "-" : typeof value === "object" ? JSON.stringify(value) : String(value));
  const widths = columns.map((column) => Math.min(48, Math.max(column.length, ...rows.map((row) => cell(row[column]).length))));
  const line = (values: readonly string[]) => values.map((value, index) => (value.length > widths[index]! ? `${value.slice(0, widths[index]! - 1)}…` : value.padEnd(widths[index]!))).join("  ").trimEnd();
  return [line(columns.map((column) => column.toUpperCase())), ...rows.map((row) => line(columns.map((column) => cell(row[column]))))].join("\n");
}

function flag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

export async function runServerCommand(args: readonly string[], io: ServerCommandIo): Promise<void> {
  const [sub, ...rest] = args;
  const fetchImpl = io.fetch;
  if (sub === "connect") {
    const url = normalizeServerUrl(rest[0] ?? "");
    const tokenEnv = flag(rest, "token-env");
    const token = tokenEnv ? (io.env ?? process.env)[tokenEnv]?.trim() : rest.includes("--token-stdin") ? (await io.readStdin?.())?.trim() : undefined;
    if (!token) throw new Error("Usage: muster server connect <url> (--token-env VAR | --token-stdin). Tokens are never taken from the command line.");
    const health = await serverHealth(url, fetchImpl);
    const user = await serverWhoAmI({ url, token }, fetchImpl);
    await saveServerLink({ url, token, user: user.username, serverVersion: health.version, connectedAt: new Date().toISOString() }, io.linkPath);
    io.out(`Connected to ${url} as ${user.username} (${user.role}), server ${health.version}.`);
    return;
  }
  if (sub === "disconnect") {
    io.out((await removeServerLink(io.linkPath)) ? "Disconnected. The saved token was removed from this computer (revoke it on the server with `muster-server token revoke`)." : "Not connected.");
    return;
  }
  const link = await loadServerLink(io.linkPath);
  if (!link) throw new Error("Not connected to a Muster Server. Run `muster server connect <url> --token-env VAR`.");
  if (sub === "status") {
    const [health, user] = await Promise.all([serverHealth(link.url, fetchImpl), serverWhoAmI(link, fetchImpl)]);
    io.out(`Server ${link.url} (${health.name} ${health.version})\nSigned in as ${user.username} (${user.role})\nConnected ${link.connectedAt}`);
    return;
  }
  await runRead(sub, rest, link, io);
}

async function projectRef(link: ServerLink, args: readonly string[], fetchImpl?: FetchLike): Promise<Row> {
  const list = (await serverRpc<Row[]>(link, "project.list", {}, fetchImpl)).filter((project) => !project.archived);
  const want = flag(args, "project");
  if (!want) {
    if (list.length === 1) return list[0]!;
    throw new Error(`Name the project with --project (${list.slice(0, 5).map((project) => project.name).join(", ") || "none yet"}).`);
  }
  const hit = list.find((project) => project.id === want) ?? list.find((project) => String(project.name).toLowerCase() === want.toLowerCase());
  if (!hit) throw new Error(`No project "${want}".`);
  return hit;
}

async function runRead(sub: string | undefined, args: readonly string[], link: ServerLink, io: ServerCommandIo): Promise<void> {
  const call = <T,>(command: string, input: Record<string, unknown> = {}) => serverRpc<T>(link, command, input, io.fetch);
  if (sub === "projects") {
    const list = (await call<Row[]>("project.list")).filter((project) => !project.archived);
    io.out(table(list.map((project) => ({ id: project.id, name: project.name, goal: String(project.goal ?? "").replace(/\s+/g, " ").slice(0, 60) })), ["id", "name", "goal"]));
    return;
  }
  if (sub === "tasks") {
    const project = await projectRef(link, args, io.fetch);
    const team = (await call<{ members: Row[] }>("project.members.list", { projectId: project.id })).members;
    const settings = await call<Row>("project.team.settings", { projectId: project.id });
    const work = await call<Row>("project.work", { projectId: project.id, activityLimit: 1 });
    const state = flag(args, "state");
    const prefix = String(settings.keyPrefix ?? "T");
    const rows = (work.tasks.items as Row[]).filter((task) => !state || task.state === state).map((task) => ({
      key: `${prefix}-${task.seq ?? "?"}`, state: task.state, priority: task.priority,
      assignee: task.owner?.kind === "user" ? "you" : team.find((member) => member.id === task.owner?.id)?.name ?? "", title: task.title,
    }));
    io.out(table(rows, ["key", "state", "priority", "assignee", "title"]));
    return;
  }
  if (sub === "approvals") {
    const project = await projectRef(link, args, io.fetch);
    const result = await call<{ items: Row[] }>("project.approvals.list", { projectId: project.id, includeDecided: args.includes("--all") });
    io.out(table(result.items.map((item) => ({ id: String(item.id).slice(0, 8), kind: item.kind, state: item.state, title: item.title })), ["id", "kind", "state", "title"]));
    return;
  }
  if (sub === "ledger") {
    const result = await call<{ entries: Row[]; chain: Row }>("paperclip.ledger", { limit: Number(flag(args, "limit") ?? 30) });
    const rows = result.entries.map((entry) => ({ ended: String(entry.endedAt).slice(0, 16), agent: entry.agent, model: entry.model ?? "", tokens: entry.tokens ? entry.tokens.input + entry.tokens.output : "", cost: entry.costUsd == null ? "" : `$${Number(entry.costUsd).toFixed(2)}`, outcome: entry.outcome ?? "" }));
    io.out(`${table(rows, ["ended", "agent", "model", "tokens", "cost", "outcome"])}\n\nChain ${result.chain?.ok ? "verified" : "BROKEN"} (${result.chain?.entries ?? 0} entries).`);
    return;
  }
  throw new Error(`Usage:\n  ${SERVER_USAGE}`);
}
