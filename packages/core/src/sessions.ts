import { mkdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { dataDir } from "./store.js";
import { estimateTokens } from "./tokens.js";
import type { TranscriptMessage } from "./context-renderer.js";

const TRANSCRIPT_ROLES = new Set(["system", "user", "assistant", "tool"]);

/** Map stored message rows to renderer transcript messages (unknown roles → "user"). */
export function messagesToTranscript(rows: readonly MessageRow[]): TranscriptMessage[] {
  return rows.map((row) => ({
    role: (TRANSCRIPT_ROLES.has(row.role) ? row.role : "user") as TranscriptMessage["role"],
    content: row.content,
    tokens: row.tokenCount,
  }));
}

/**
 * SQLite session store + cross-session search (Hermes's cleanest subsystem,
 * ported). Uses Node's built-in node:sqlite (no dependencies); FTS5 when the
 * bundled SQLite supports it, LIKE-scoring otherwise.
 *
 * SINGLE-WRITER DISCIPLINE: open one store per process and route all writes
 * through it (the gateway in server contexts). Concurrent writers from
 * separate processes are the documented corruption cause upstream
 * (hermes-agent #5563) — do not do it.
 */

export interface SessionRow {
  readonly id: string;
  readonly title: string;
  readonly channel: string;
  readonly peer: string;
  readonly createdAt: string;
  readonly parentId?: string;
  /** Directory this conversation belongs to. null means an old/global row. */
  readonly workspaceCwd: string | null;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly costUsd: number;
}

export interface MessageRow {
  readonly id: number;
  readonly sessionId: string;
  readonly role: string;
  readonly content: string;
  readonly tokenCount: number;
  readonly createdAt: string;
}

export interface SessionSearchArgs {
  readonly query?: string;
  readonly sessionId?: string;
  readonly aroundMessageId?: number;
  readonly limit?: number;
  /** Restrict discovery/browse results to sessions created in this directory. */
  readonly workspaceCwd?: string;
}

export interface SearchHit {
  readonly sessionId: string;
  readonly title: string;
  readonly messageId: number;
  readonly snippet: string;
  readonly window: MessageRow[];
}

export type SessionSearchResult =
  | { readonly shape: "discover"; readonly hits: SearchHit[] }
  | { readonly shape: "scroll"; readonly messages: MessageRow[] }
  | { readonly shape: "read"; readonly session: SessionRow; readonly head: MessageRow[]; readonly tail: MessageRow[]; readonly omitted: number }
  | { readonly shape: "browse"; readonly sessions: SessionRow[] };

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
  };
  close(): void;
}

export interface SessionStore {
  readonly backend: "sqlite-fts5" | "sqlite-like";
  createSession(input: { channel: string; peer: string; title?: string; parentId?: string; workspaceCwd?: string | null }): SessionRow;
  /** Reuse the most recent session for (channel, peer), or create one — the conversation↔session mapping for multi-turn continuity. */
  findOrCreateSession(input: { channel: string; peer: string; title?: string; parentId?: string; workspaceCwd?: string | null }): SessionRow;
  /** `createdAt` (ISO) records when the message was written, e.g. a prompt stored after its answer arrived. */
  appendMessage(sessionId: string, role: string, content: string, createdAt?: string): MessageRow;
  addUsage(sessionId: string, tokensIn: number, tokensOut: number, costUsd?: number): void;
  setTitle(sessionId: string, title: string): void;
  setWorkspaceCwd(sessionId: string, workspaceCwd: string | null): void;
  search(args: SessionSearchArgs): SessionSearchResult;
  /** All active (non-compacted) messages for a session, oldest first — the prior turns the renderer budgets. */
  loadActiveMessages(sessionId: string): MessageRow[];
  /** Mark messages compacted-away (active = 0): they leave the rendered window but stay in searchable history. */
  deactivate(messageIds: readonly number[]): void;
  close(): void;
}

export function sessionsDbPath(cwd = process.cwd()): string {
  return join(dataDir(cwd), "sessions.db");
}

function normalizeWorkspaceCwd(cwd: string): string {
  const absolute = resolve(cwd);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

export function openSessionStore(cwd = process.cwd()): SessionStore {
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: new (path: string) => SqliteDatabase };
  mkdirSync(dataDir(cwd), { recursive: true });
  const db = new DatabaseSync(sessionsDbPath(cwd));
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', channel TEXT NOT NULL,
      peer TEXT NOT NULL, created_at TEXT NOT NULL, parent_id TEXT,
      tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
      role TEXT NOT NULL, content TEXT NOT NULL, token_count INTEGER NOT NULL,
      created_at TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);
  `);
  const sessionColumns = db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name?: unknown }>;
  if (!sessionColumns.some((column) => column.name === "workspace_cwd")) {
    // Additive rollout: older rows remain NULL/global until new sessions are made.
    db.exec("ALTER TABLE sessions ADD COLUMN workspace_cwd TEXT");
  }
  let backend: SessionStore["backend"] = "sqlite-like";
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(content, content='messages', content_rowid='id');
      CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
      END;
    `);
    backend = "sqlite-fts5";
  } catch {
    // FTS5 not compiled in; LIKE scoring below covers it.
  }

  const toSession = (row: Record<string, unknown>): SessionRow => ({
    id: String(row.id), title: String(row.title), channel: String(row.channel), peer: String(row.peer),
    createdAt: String(row.created_at), parentId: row.parent_id ? String(row.parent_id) : undefined,
    workspaceCwd: typeof row.workspace_cwd === "string" && row.workspace_cwd ? String(row.workspace_cwd) : null,
    tokensIn: Number(row.tokens_in), tokensOut: Number(row.tokens_out), costUsd: Number(row.cost_usd),
  });
  const toMessage = (row: Record<string, unknown>): MessageRow => ({
    id: Number(row.id), sessionId: String(row.session_id), role: String(row.role),
    content: String(row.content), tokenCount: Number(row.token_count), createdAt: String(row.created_at),
  });

  const windowAround = (sessionId: string, messageId: number, span = 5): MessageRow[] =>
    (db.prepare("SELECT * FROM messages WHERE session_id = ? AND id BETWEEN ? AND ? AND active = 1 ORDER BY id")
      .all(sessionId, messageId - span, messageId + span) as Record<string, unknown>[]).map(toMessage);

  const storeWorkspaceCwd = normalizeWorkspaceCwd(cwd);
  const makeSession = (input: { channel: string; peer: string; title?: string; parentId?: string; workspaceCwd?: string | null }): SessionRow => {
    const workspaceCwd = input.workspaceCwd === null ? null : normalizeWorkspaceCwd(input.workspaceCwd ?? storeWorkspaceCwd);
    const row: SessionRow = {
      id: `sess_${randomUUID().slice(0, 12)}`, title: input.title ?? "", channel: input.channel,
      peer: input.peer, createdAt: new Date().toISOString(), parentId: input.parentId,
      workspaceCwd,
      tokensIn: 0, tokensOut: 0, costUsd: 0,
    };
    db.prepare("INSERT INTO sessions (id, title, channel, peer, created_at, parent_id, workspace_cwd) VALUES (?,?,?,?,?,?,?)")
      .run(row.id, row.title, row.channel, row.peer, row.createdAt, row.parentId ?? null, row.workspaceCwd);
    return row;
  };

  return {
    backend,
    createSession: makeSession,
    findOrCreateSession(input) {
      // The conversation↔session mapping: reuse the most recent session for this
      // (channel, peer) so a multi-turn chat accumulates ONE transcript instead
      // of a fresh session per turn. Foundation of the renderer's prior-turn load.
      const workspaceCwd = input.workspaceCwd === null ? null : normalizeWorkspaceCwd(input.workspaceCwd ?? storeWorkspaceCwd);
      const rows = workspaceCwd === null
        ? db.prepare("SELECT * FROM sessions WHERE channel = ? AND peer = ? AND workspace_cwd IS NULL ORDER BY created_at DESC LIMIT 1")
            .all(input.channel, input.peer) as Record<string, unknown>[]
        : db.prepare("SELECT * FROM sessions WHERE channel = ? AND peer = ? AND workspace_cwd = ? ORDER BY created_at DESC LIMIT 1")
            .all(input.channel, input.peer, workspaceCwd) as Record<string, unknown>[];
      return rows.length ? toSession(rows[0]) : makeSession(input);
    },
    appendMessage(sessionId, role, content, at) {
      const createdAt = at ?? new Date().toISOString();
      const tokenCount = estimateTokens(content);
      const result = db.prepare("INSERT INTO messages (session_id, role, content, token_count, created_at) VALUES (?,?,?,?,?)")
        .run(sessionId, role, content, tokenCount, createdAt) as { lastInsertRowid: number | bigint };
      return { id: Number(result.lastInsertRowid), sessionId, role, content, tokenCount, createdAt };
    },
    addUsage(sessionId, tokensIn, tokensOut, costUsd = 0) {
      db.prepare("UPDATE sessions SET tokens_in = tokens_in + ?, tokens_out = tokens_out + ?, cost_usd = cost_usd + ? WHERE id = ?")
        .run(tokensIn, tokensOut, costUsd, sessionId);
    },
    setTitle(sessionId, title) {
      db.prepare("UPDATE sessions SET title = ? WHERE id = ?").run(title.slice(0, 80), sessionId);
    },
    setWorkspaceCwd(sessionId, workspaceCwd) {
      db.prepare("UPDATE sessions SET workspace_cwd = ? WHERE id = ?").run(workspaceCwd ? normalizeWorkspaceCwd(workspaceCwd) : null, sessionId);
    },
    loadActiveMessages(sessionId) {
      return (db.prepare("SELECT * FROM messages WHERE session_id = ? AND active = 1 ORDER BY id")
        .all(sessionId) as Record<string, unknown>[]).map(toMessage);
    },
    deactivate(messageIds) {
      if (!messageIds.length) return;
      const stmt = db.prepare("UPDATE messages SET active = 0 WHERE id = ?");
      for (const id of messageIds) stmt.run(id);
    },
    search(args) {
      const limit = args.limit ?? 10;
      if (args.sessionId && args.aroundMessageId !== undefined) {
        return { shape: "scroll", messages: windowAround(args.sessionId, args.aroundMessageId) };
      }
      if (args.sessionId) {
        const session = db.prepare("SELECT * FROM sessions WHERE id = ?").get(args.sessionId) as Record<string, unknown> | undefined;
        if (!session) throw new Error(`Session not found: ${args.sessionId}`);
        const all = (db.prepare("SELECT * FROM messages WHERE session_id = ? AND active = 1 ORDER BY id").all(args.sessionId) as Record<string, unknown>[]).map(toMessage);
        const head = all.slice(0, 20);
        const tail = all.length > 30 ? all.slice(-10) : all.slice(head.length);
        return { shape: "read", session: toSession(session), head, tail, omitted: Math.max(0, all.length - head.length - tail.length) };
      }
      if (args.query) {
        const rows = backend === "sqlite-fts5"
          ? db.prepare("SELECT m.* FROM messages_fts f JOIN messages m ON m.id = f.rowid WHERE messages_fts MATCH ? AND m.active = 1 ORDER BY rank LIMIT ?")
              .all(ftsQuery(args.query), limit * 3) as Record<string, unknown>[]
          : db.prepare("SELECT * FROM messages WHERE content LIKE ? AND active = 1 ORDER BY id DESC LIMIT ?")
              .all(`%${args.query}%`, limit * 3) as Record<string, unknown>[];
        const seen = new Set<string>();
        const hits: SearchHit[] = [];
        for (const raw of rows.map(toMessage)) {
          if (seen.has(raw.sessionId)) continue;
          const session = db.prepare("SELECT * FROM sessions WHERE id = ?").get(raw.sessionId) as Record<string, unknown> | undefined;
          if (args.workspaceCwd && (!session || toSession(session).workspaceCwd !== normalizeWorkspaceCwd(args.workspaceCwd))) continue;
          seen.add(raw.sessionId);
          hits.push({
            sessionId: raw.sessionId,
            title: session ? String(session.title) : "",
            messageId: raw.id,
            snippet: snippetAround(raw.content, args.query),
            window: windowAround(raw.sessionId, raw.id),
          });
          if (hits.length >= limit) break;
        }
        return { shape: "discover", hits };
      }
      const rows = args.workspaceCwd
        ? db.prepare("SELECT * FROM sessions WHERE workspace_cwd = ? ORDER BY created_at DESC LIMIT ?").all(normalizeWorkspaceCwd(args.workspaceCwd), limit)
        : db.prepare("SELECT * FROM sessions ORDER BY created_at DESC LIMIT ?").all(limit);
      const sessions = (rows as Record<string, unknown>[]).map(toSession);
      return { shape: "browse", sessions };
    },
    close() {
      db.close();
    },
  };
}

function ftsQuery(query: string): string {
  const terms = query.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return terms.map((term) => `"${term}"`).join(" ") || '""';
}

function snippetAround(content: string, query: string, span = 80): string {
  const index = content.toLowerCase().indexOf(query.toLowerCase().split(/\s+/)[0] ?? "");
  const start = Math.max(0, index - span);
  const snippet = content.slice(start, start + span * 2).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${snippet}${start + span * 2 < content.length ? "…" : ""}`;
}
