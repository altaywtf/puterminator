import * as Schema from "effect/Schema";
import { AgentState, initialAgentState, MessageParam } from "../shared/contract";
import type { WalkedFile } from "./tree";

export type SqlValue = string | number | null;
export type Row = Record<string, SqlValue | ArrayBuffer | Uint8Array>;

/**
 * Synchronous SQLite, as Durable Object storage and node:sqlite both are. One statement per call.
 */
export interface Sql {
  readonly exec: (query: string, ...bindings: Array<SqlValue>) => Array<Row>;
  readonly transaction: <A>(body: () => A) => A;
}

// v1 (Agents SDK) kept AgentState as JSON in this row; reading it here keeps existing objects working.
const STATE_ROW_ID = "cf_state_row_id";

const decodeState = Schema.decodeUnknownOption(Schema.fromJsonString(AgentState));
const encodeState = Schema.encodeSync(Schema.fromJsonString(AgentState));
const decodeMessage = Schema.decodeUnknownOption(Schema.fromJsonString(MessageParam));
const encodeMessage = Schema.encodeSync(Schema.fromJsonString(MessageParam));

const str = (v: unknown) => (typeof v === "string" ? v : String(v));
const strOrNull = (v: unknown) => (v == null ? null : str(v));
const num = (v: unknown) => Number(v);

export const month = (now: number) => new Date(now).toISOString().slice(0, 7);

/** The v1 tables and the Agents SDK state row, unchanged, so adopted Durable Objects keep their data. */
export const makeStore = (sql: Sql) => {
  sql.exec("CREATE TABLE IF NOT EXISTS cf_agents_state (id TEXT PRIMARY KEY NOT NULL, state TEXT)");
  sql.exec("CREATE TABLE IF NOT EXISTS secrets (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  sql.exec("CREATE TABLE IF NOT EXISTS usage (month TEXT PRIMARY KEY, tokens INTEGER NOT NULL)");
  sql.exec("CREATE TABLE IF NOT EXISTS messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, json TEXT NOT NULL)");
  sql.exec(`CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY, parent_id INTEGER, name TEXT NOT NULL, path TEXT NOT NULL, depth INTEGER NOT NULL,
    size INTEGER NOT NULL, file_type TEXT NOT NULL, extension TEXT, crc32 TEXT, created_at TEXT NOT NULL, first_accessed_at TEXT)`);

  return {
    loadState: (now: number): AgentState => {
      const raw = sql.exec("SELECT state FROM cf_agents_state WHERE id = ?", STATE_ROW_ID)[0]?.state;
      const decoded = typeof raw === "string" ? decodeState(raw) : undefined;
      return decoded?._tag === "Some" ? decoded.value : initialAgentState(month(now));
    },
    saveState: (state: AgentState) => {
      sql.exec("INSERT OR REPLACE INTO cf_agents_state (id, state) VALUES (?, ?)", STATE_ROW_ID, encodeState(state));
    },

    token: (): string | null => strOrNull(sql.exec("SELECT value FROM secrets WHERE key = 'putio_token'")[0]?.value),
    setToken: (token: string) => {
      sql.exec("INSERT OR REPLACE INTO secrets (key, value) VALUES ('putio_token', ?)", token);
    },
    deleteToken: () => {
      sql.exec("DELETE FROM secrets WHERE key = 'putio_token'");
    },

    /** Rows that fail to decode are skipped; v1 only ever wrote valid ones. */
    history: (): Array<MessageParam> =>
      sql.exec("SELECT json FROM messages ORDER BY seq").flatMap((r) => {
        const m = decodeMessage(str(r.json));
        return m._tag === "Some" ? [m.value] : [];
      }),
    /** Append-only: thinking blocks stay valid and the cached prefix never changes. */
    append: (m: MessageParam) => {
      sql.exec("INSERT INTO messages (json) VALUES (?)", encodeMessage(m));
    },

    used: (m: string): number => num(sql.exec("SELECT tokens FROM usage WHERE month = ?", m)[0]?.tokens ?? 0),
    charge: (m: string, tokens: number) => {
      sql.exec(
        "INSERT INTO usage (month, tokens) VALUES (?, ?) ON CONFLICT(month) DO UPDATE SET tokens = tokens + excluded.tokens",
        m,
        tokens,
      );
    },

    snapshot: (): Array<WalkedFile> =>
      sql.exec("SELECT * FROM files").map((r) => ({
        id: num(r.id),
        parent_id: r.parent_id == null ? null : num(r.parent_id),
        name: str(r.name),
        path: str(r.path),
        depth: num(r.depth),
        size: num(r.size),
        file_type: str(r.file_type),
        extension: strOrNull(r.extension),
        crc32: strOrNull(r.crc32),
        created_at: str(r.created_at),
        first_accessed_at: strOrNull(r.first_accessed_at),
      })),
    saveSnapshot: (files: ReadonlyArray<WalkedFile>) =>
      sql.transaction(() => {
        sql.exec("DELETE FROM files");
        for (const f of files) {
          sql.exec(
            "INSERT INTO files VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            f.id,
            f.parent_id,
            f.name,
            f.path,
            f.depth,
            f.size,
            f.file_type,
            f.extension,
            f.crc32,
            f.created_at,
            f.first_accessed_at,
          );
        }
      }),
  };
};

export type Store = ReturnType<typeof makeStore>;
