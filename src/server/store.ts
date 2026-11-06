import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { PlanRecord } from "../shared/actions";
import { AgentState, Folder, initialAgentState, MessageParam } from "../shared/contract";
import type { WalkedFile } from "./tree";

type SqlValue = string | number | null;

export type Row = Record<string, SqlValue | ArrayBuffer | Uint8Array>;

/**
 * Synchronous SQLite, as Durable Object storage and node:sqlite both are. One statement per call.
 */
export interface Sql {
  readonly exec: (query: string, ...bindings: Array<SqlValue>) => Array<Row>;
  readonly transaction: <A>(body: () => A) => A;
}

const AGENTS_SDK_STATE_ROW_ID = "cf_state_row_id";

const decodeState = Schema.decodeUnknownOption(Schema.fromJsonString(AgentState));
const encodeState = Schema.encodeSync(Schema.fromJsonString(AgentState));
const decodeMessage = Schema.decodeUnknownOption(Schema.fromJsonString(MessageParam));
const encodeMessage = Schema.encodeSync(Schema.fromJsonString(MessageParam));

/** A plan as the server keeps it: the record the browser sees, the put.io ids it acts on, each file's folder
    id when proposed, the target folder it was made in, and whether the model has been told how its run went. */
export const StoredRecord = Schema.Struct({
  record: PlanRecord,
  ids: Schema.Record(Schema.String, Schema.Finite),
  parents: Schema.optionalKey(Schema.Record(Schema.String, Schema.Finite)),
  folder: Schema.optionalKey(Folder),
  reported: Schema.Boolean,
});

export type StoredRecord = typeof StoredRecord.Type;

const decodeRecord = Schema.decodeUnknownOption(Schema.fromJsonString(StoredRecord));
const encodeRecord = Schema.encodeSync(Schema.fromJsonString(StoredRecord));

type SqlCell = Row[string] | undefined;

const str = (v: SqlCell) => String(v);
const strOrNull = (v: SqlCell) => (v == null ? null : str(v));
const num = (v: SqlCell) => Number(v);

export const month = (now: number) => new Date(now).toISOString().slice(0, 7);

/** The v1 tables and the Agents SDK state row, unchanged, so adopted Durable Objects keep their data. */
export const makeStore = (sql: Sql) => {
  sql.exec("CREATE TABLE IF NOT EXISTS cf_agents_state (id TEXT PRIMARY KEY NOT NULL, state TEXT)");
  sql.exec("CREATE TABLE IF NOT EXISTS secrets (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  sql.exec("CREATE TABLE IF NOT EXISTS usage (month TEXT PRIMARY KEY, tokens INTEGER NOT NULL)");
  sql.exec("CREATE TABLE IF NOT EXISTS pool_spend (month TEXT NOT NULL, user TEXT NOT NULL, tokens INTEGER NOT NULL, PRIMARY KEY (month, user))");
  sql.exec("CREATE TABLE IF NOT EXISTS messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, json TEXT NOT NULL)");
  sql.exec("CREATE TABLE IF NOT EXISTS archived_messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, json TEXT NOT NULL)");
  sql.exec(`CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY, parent_id INTEGER, name TEXT NOT NULL, path TEXT NOT NULL, depth INTEGER NOT NULL,
    size INTEGER NOT NULL, file_type TEXT NOT NULL, extension TEXT, crc32 TEXT, created_at TEXT NOT NULL, first_accessed_at TEXT)`);
  sql.exec("CREATE TABLE IF NOT EXISTS file_mime (id INTEGER PRIMARY KEY, content_type TEXT)");
  sql.exec("CREATE TABLE IF NOT EXISTS plans (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, json TEXT NOT NULL)");
  sql.exec("CREATE TABLE IF NOT EXISTS feedback_sent (day TEXT PRIMARY KEY, count INTEGER NOT NULL)");

  return {
    loadState: (now: number): AgentState => {
      const raw = sql.exec("SELECT state FROM cf_agents_state WHERE id = ?", AGENTS_SDK_STATE_ROW_ID)[0]?.state;

      return Option.getOrElse(decodeState(raw), () => initialAgentState(month(now)));
    },
    takeFeedbackSlot: (day: string, perDay: number): boolean => {
      const sent = Number(sql.exec("SELECT count FROM feedback_sent WHERE day = ?", day)[0]?.count ?? 0);

      if (sent >= perDay) return false;
      sql.exec("DELETE FROM feedback_sent WHERE day <> ?", day);
      sql.exec("INSERT OR REPLACE INTO feedback_sent (day, count) VALUES (?, ?)", day, sent + 1);

      return true;
    },
    returnFeedbackSlot: (day: string) => {
      sql.exec("UPDATE feedback_sent SET count = max(count - 1, 0) WHERE day = ?", day);
    },
    saveState: (state: AgentState) => {
      sql.exec("INSERT OR REPLACE INTO cf_agents_state (id, state) VALUES (?, ?)", AGENTS_SDK_STATE_ROW_ID, encodeState(state));
    },

    token: (): string | null => strOrNull(sql.exec("SELECT value FROM secrets WHERE key = 'putio_token'")[0]?.value),
    setToken: (token: string) => {
      sql.exec("INSERT OR REPLACE INTO secrets (key, value) VALUES ('putio_token', ?)", token);
    },
    deleteToken: () => {
      sql.exec("DELETE FROM secrets WHERE key IN ('putio_token', 'download_token')");
    },
    deleteUserData: (keepMonth: string) =>
      sql.transaction(() => {
        for (const table of ["messages", "archived_messages", "files", "file_mime", "plans", "cf_agents_state", "feedback_sent"]) sql.exec(`DELETE FROM ${table}`);
        sql.exec("DELETE FROM secrets WHERE key != 'session_gen'");
        sql.exec("DELETE FROM usage WHERE month != ?", keepMonth);
      }),
    secret: (key: string): string | null => strOrNull(sql.exec("SELECT value FROM secrets WHERE key = ?", key)[0]?.value),
    setSecret: (key: string, value: string) => {
      sql.exec("INSERT OR REPLACE INTO secrets (key, value) VALUES (?, ?)", key, value);
    },

    history: (): Array<MessageParam> =>
      sql.exec("SELECT json FROM messages ORDER BY seq").flatMap((r) => Option.toArray(decodeMessage(str(r.json)))),
    append: (m: MessageParam) => {
      sql.exec("INSERT INTO messages (json) VALUES (?)", encodeMessage(m));
    },

    archiveHistory: () => {
      sql.exec("INSERT INTO archived_messages (json) SELECT json FROM messages ORDER BY seq");
      sql.exec("DELETE FROM messages");
    },

    used: (m: string): number => num(sql.exec("SELECT tokens FROM usage WHERE month = ?", m)[0]?.tokens ?? 0),
    charge: (m: string, tokens: number) => {
      sql.exec(
        "INSERT INTO usage (month, tokens) VALUES (?, ?) ON CONFLICT(month) DO UPDATE SET tokens = tokens + excluded.tokens",
        m,
        tokens,
      );
    },

    poolReport: (m: string, user: string, tokens: number): number => {
      sql.exec("DELETE FROM pool_spend WHERE month < ?", m);
      sql.exec(
        "INSERT INTO pool_spend (month, user, tokens) VALUES (?, ?, ?) ON CONFLICT(month, user) DO UPDATE SET tokens = MAX(tokens, excluded.tokens)",
        m,
        user,
        tokens,
      );

      return num(sql.exec("SELECT COALESCE(SUM(tokens), 0) AS total FROM pool_spend WHERE month = ?", m)[0]?.total ?? 0);
    },

    plans: (): Array<StoredRecord> =>
      sql.exec("SELECT json FROM plans ORDER BY seq").flatMap((r) => Option.toArray(decodeRecord(str(r.json)))),
    savePlan: (p: StoredRecord) => {
      sql.exec("INSERT INTO plans (id, json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json", p.record.plan.id, encodeRecord(p));
    },

    snapshot: (): Array<WalkedFile> =>
      sql.exec("SELECT files.*, file_mime.content_type FROM files LEFT JOIN file_mime USING (id)").map((r) => ({
        id: num(r.id),
        parent_id: r.parent_id == null ? null : num(r.parent_id),
        name: str(r.name),
        path: str(r.path),
        depth: num(r.depth),
        size: num(r.size),
        file_type: str(r.file_type),
        content_type: strOrNull(r.content_type),
        extension: strOrNull(r.extension),
        crc32: strOrNull(r.crc32),
        created_at: str(r.created_at),
        first_accessed_at: strOrNull(r.first_accessed_at),
      })),
    saveSnapshot: (files: ReadonlyArray<WalkedFile>, rootId: number) =>
      sql.transaction(() => {
        sql.exec("DELETE FROM files");
        sql.exec("DELETE FROM file_mime");
        sql.exec("INSERT OR REPLACE INTO secrets (key, value) VALUES ('snapshot_root', ?)", String(rootId));

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
          sql.exec("INSERT INTO file_mime (id, content_type) VALUES (?, ?)", f.id, f.content_type);
        }
      }),
  };
};

export type Store = ReturnType<typeof makeStore>;
