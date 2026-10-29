import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { BetaMessageParam, BetaUsage } from "@anthropic-ai/sdk/resources/beta/messages";
import { Agent, type Connection, type WSMessage } from "agents";
import { z } from "zod";
import { type AgentState, ClientEvent, type ServerEvent } from "../shared/types";
import { audit, isMessyName, junkReason } from "./audit";
import { listFolder, type WalkedFile, walk } from "./putio";

const month = (d = new Date()) => d.toISOString().slice(0, 7);
const gb = (b: number) => (b >= 2 ** 30 ? `${(b / 2 ** 30).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 2 ** 20))} MB`);

const SYSTEM = `You are puterminator, an agent that helps one person understand and tidy their put.io library.

This version is read-only. You can scan the library, score it, list folders and search files. You cannot rename, move or delete anything yet. When the user asks for changes, describe the plan you would apply (what moves where, what goes to trash and why) and say that applying changes is coming in a later version.

How to work:
- Scan before you judge. Call scan_library when there is no snapshot, when the user asks for a fresh audit, or when the target folder changed.
- After a scan, the UI already shows the score card. Do not repeat every number. Lead with the score and the one or two problems that matter most, with real file names as examples.
- put.io only records first_accessed_at. "Never played" is knowable; "not watched recently" is not. Say so if asked about stale files.
- Each user message ends with a <context> block from the app (target folder, last scan, credits). Use it; don't quote it.

How to write:
- Every word earns its place. Lead with the answer. Four short lines or fewer unless the user asks for detail.
- One fact per line. Short bullets beat paragraphs. Sentences under 20 words, active voice.
- After a scan: one line with the score and the biggest problem, then at most three bullets with real paths. The score card shows the rest.
- Lists: one total line ("685 never played, 552 GB"), then the top five by size, one per line, then "+N more". Never more than five items, no grouping headers. Offer nothing; the user can ask for more.
- Mention read-only only when the user asks for a change. Then give the plan as bullets, one line each.
- Errors: one line saying what failed and when to retry. No apologies.
- No preamble, no recap, no closing questions or offers, no headings. No marketing tone.`;

/**
 * Credits are input-token equivalents at Sonnet 5.5 prices ($2 in, $10 out,
 * cache writes 1.25x, cache reads 0.1x), so the cap tracks real spend.
 */
export const weightedTokens = (u: BetaUsage) =>
  Math.round(
    u.input_tokens + (u.cache_creation_input_tokens ?? 0) * 1.25 + (u.cache_read_input_tokens ?? 0) * 0.1 + u.output_tokens * 5,
  );

type Row = Record<string, string | number | null>;

export class Puterminator extends Agent<Env, AgentState> {
  // The instance name is the put.io user id; the browser doesn't need it.
  static options = { sendIdentityOnConnect: false };

  initialState: AgentState = {
    username: null,
    folder: { id: 0, name: "Your Files" },
    credits: { month: month(), used: 0, cap: 0 },
    lastAudit: null,
    busy: false,
  };

  private abort: AbortController | null = null;

  async onStart() {
    this.sql`CREATE TABLE IF NOT EXISTS secrets (key TEXT PRIMARY KEY, value TEXT NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS usage (month TEXT PRIMARY KEY, tokens INTEGER NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, json TEXT NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY, parent_id INTEGER, name TEXT NOT NULL, path TEXT NOT NULL, depth INTEGER NOT NULL,
      size INTEGER NOT NULL, file_type TEXT NOT NULL, extension TEXT, crc32 TEXT, created_at TEXT NOT NULL, first_accessed_at TEXT)`;
    // A turn can't survive eviction; don't leave the UI spinning.
    if (this.state.busy) this.setState({ ...this.state, busy: false });
    this.refreshCredits();
  }

  // Clients only read state; every change comes from the server.
  validateStateChange(_next: AgentState, source: Connection | "server") {
    if (source !== "server") throw new Error("state is read-only");
  }

  /** Called by the Worker after OAuth. Never exposed to the browser. */
  async setAuth(token: string, username: string) {
    this.sql`INSERT OR REPLACE INTO secrets (key, value) VALUES ('putio_token', ${token})`;
    this.setState({ ...this.state, username });
  }

  async signOut() {
    this.sql`DELETE FROM secrets WHERE key = 'putio_token'`;
  }

  /** Top-level folders for the composer's target picker. */
  async rootFolders() {
    const token = this.token();
    if (!token) return [];
    const { files } = await listFolder(token, 0);
    return files.filter((f) => f.file_type === "FOLDER").map((f) => ({ id: f.id, name: f.name }));
  }

  // ---------- conversation transport ----------

  private emit(event: ServerEvent, conn?: Connection) {
    const data = JSON.stringify(event);
    if (conn) conn.send(data);
    else this.broadcast(data);
  }

  async onConnect(conn: Connection) {
    this.emit({ type: "history", messages: this.history() }, conn);
  }

  async onMessage(_conn: Connection, raw: WSMessage) {
    if (typeof raw !== "string") return;
    let event: ClientEvent;
    try {
      event = ClientEvent.parse(JSON.parse(raw));
    } catch {
      return;
    }
    if (event.type === "stop") this.abort?.abort();
    if (event.type === "send" && !this.state.busy) {
      if (event.folder.id !== this.state.folder.id) this.setState({ ...this.state, folder: event.folder });
      this.ctx.waitUntil(this.turn(event.text));
    }
  }

  private history(): BetaMessageParam[] {
    return this.sql<{ json: string }>`SELECT json FROM messages ORDER BY seq`.map((r) => JSON.parse(r.json) as BetaMessageParam);
  }

  /** History is append-only: thinking blocks stay valid and the cached prefix never changes. */
  private append(m: BetaMessageParam) {
    this.sql`INSERT INTO messages (json) VALUES (${JSON.stringify(m)})`;
    this.emit({ type: "message", message: m });
  }

  // ---------- the turn ----------

  private async turn(text: string) {
    const credits = this.refreshCredits();
    const last = this.state.lastAudit;
    const context = [
      `Target folder: ${this.state.folder.name} (id ${this.state.folder.id}).`,
      last ? `Last scan: ${last.at.slice(0, 10)}, ${last.items} items, score ${last.score}.` : "No scan yet.",
      `Credits left this month: ${Math.max(0, Math.floor((credits.cap - credits.used) / 1000))}.`,
    ].join(" ");
    this.append({
      role: "user",
      content: [
        { type: "text", text },
        { type: "text", text: `<context>${context}</context>` },
      ],
    });

    if (credits.used >= credits.cap) {
      this.append({ role: "assistant", content: [{ type: "text", text: "You've used this month's credits. They refill on the 1st." }] });
      return;
    }

    this.setState({ ...this.state, busy: true });
    const abort = new AbortController();
    this.abort = abort;
    // Only the Worker secret; never a token or profile picked up from the environment.
    const client = new Anthropic({ apiKey: this.env.ANTHROPIC_API_KEY, authToken: null, credentials: null });
    const runner = client.beta.messages.toolRunner(
      {
        model: this.env.MODEL,
        max_tokens: 16000,
        stream: true,
        max_iterations: 8,
        thread: false,
        system: SYSTEM,
        messages: this.history(),
        tools: this.tools(),
        thinking: { type: "adaptive", display: "summarized" },
        output_config: { effort: "medium" },
        cache_control: { type: "ephemeral" },
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      },
      { signal: abort.signal },
    );

    try {
      for await (const stream of runner) {
        let sent = 0;
        stream.on("streamEvent", (_e, snapshot) => {
          if (Date.now() - sent < 60) return;
          sent = Date.now();
          this.emit({ type: "partial", content: snapshot.content });
        });
        const message = await stream.finalMessage();
        this.charge(weightedTokens(message.usage));
        this.append({ role: "assistant", content: message.content });
        this.emit({ type: "partial", content: null });
        if (message.stop_reason === "refusal") break;
        // Cached by the runner, so the next iteration reuses these results instead of running tools again.
        const results = await runner.generateToolResponse();
        if (results) this.append(results);
      }
    } catch (err) {
      if (!abort.signal.aborted) {
        console.error("turn failed", err);
        this.emit({ type: "error", message: "Something broke on my side. Try again in a moment." });
      }
    } finally {
      this.abort = null;
      this.emit({ type: "partial", content: null });
      this.setState({ ...this.state, busy: false });
    }
  }

  // ---------- credits ----------

  private cap() {
    return Number(this.env.MONTHLY_TOKEN_CAP) || 1_000_000;
  }

  private refreshCredits() {
    const m = month();
    const used = this.sql<{ tokens: number }>`SELECT tokens FROM usage WHERE month = ${m}`[0]?.tokens ?? 0;
    const credits = { month: m, used, cap: this.cap() };
    const c = this.state.credits;
    if (c.month !== m || c.used !== used || c.cap !== credits.cap) this.setState({ ...this.state, credits });
    return credits;
  }

  private charge(tokens: number) {
    const m = month();
    this.sql`INSERT INTO usage (month, tokens) VALUES (${m}, ${tokens})
      ON CONFLICT(month) DO UPDATE SET tokens = tokens + ${tokens}`;
    this.refreshCredits();
  }

  // ---------- put.io snapshot ----------

  private token() {
    const row = this.sql<{ value: string }>`SELECT value FROM secrets WHERE key = 'putio_token'`[0];
    return row?.value ?? null;
  }

  private snapshot(): WalkedFile[] {
    return this.sql<Row>`SELECT * FROM files`.map((r) => ({
      id: Number(r.id),
      parent_id: r.parent_id == null ? null : Number(r.parent_id),
      name: String(r.name),
      path: String(r.path),
      depth: Number(r.depth),
      size: Number(r.size),
      file_type: String(r.file_type),
      extension: r.extension == null ? null : String(r.extension),
      crc32: r.crc32 == null ? null : String(r.crc32),
      created_at: String(r.created_at),
      first_accessed_at: r.first_accessed_at == null ? null : String(r.first_accessed_at),
    }));
  }

  private saveSnapshot(files: WalkedFile[]) {
    this.ctx.storage.transactionSync(() => {
      this.sql`DELETE FROM files`;
      for (const f of files) {
        this.sql`INSERT INTO files VALUES (${f.id}, ${f.parent_id}, ${f.name}, ${f.path}, ${f.depth}, ${f.size},
          ${f.file_type}, ${f.extension}, ${f.crc32}, ${f.created_at}, ${f.first_accessed_at})`;
      }
    });
  }

  // Inputs have no optional or default fields, so the schemas stay valid under strict tool use.
  private tools() {
    const noSnapshot = JSON.stringify({ error: "No snapshot yet. Run scan_library first." });
    return [
      betaZodTool({
        name: "scan_library",
        description:
          "Read the whole tree under the target folder from put.io, save a snapshot and score naming, structure, junk and duplicates. Takes a few seconds on big libraries.",
        inputSchema: z.object({}),
        strict: true,
        run: async () => {
          const token = this.token();
          if (!token) return JSON.stringify({ error: "Not signed in to put.io." });
          const { id, name } = this.state.folder;
          const res = await walk(token, id);
          this.saveSnapshot(res.files);
          const a = audit(res.files, id === 0 ? name : res.rootName, res.truncated);
          this.setState({ ...this.state, lastAudit: { at: a.at, rootName: a.rootName, score: a.score, items: a.totals.items } });
          return JSON.stringify(a);
        },
      }),
      betaZodTool({
        name: "list_folder",
        description: "List the direct children of a folder from the last snapshot. Path is relative to the target folder, '' for its root.",
        inputSchema: z.object({ path: z.string().describe("e.g. '' or '/Movies'") }),
        strict: true,
        run: async ({ path }) => {
          const clean = path.replace(/\/+$/, "");
          const all = this.snapshot();
          if (!all.length) return noSnapshot;
          const depth = clean ? clean.split("/").length : 1;
          const rows = all
            .filter((f) => f.depth === depth && (clean ? f.path.startsWith(`${clean}/`) : true))
            .sort((a, b) => a.name.localeCompare(b.name));
          return JSON.stringify({
            path: clean || "/",
            count: rows.length,
            items: rows.slice(0, 200).map((f) => ({ name: f.name, type: f.file_type, size: gb(f.size), played: !!f.first_accessed_at })),
          });
        },
      }),
      betaZodTool({
        name: "search_files",
        description:
          "Search the last snapshot by name substring (empty string for none) and a category: any, junk, never_played, messy_names, large, folders.",
        inputSchema: z.object({
          query: z.string(),
          category: z.enum(["any", "junk", "never_played", "messy_names", "large", "folders"]),
          limit: z.number().describe("1 to 100"),
        }),
        strict: true,
        run: async ({ query, category, limit }) => {
          let rows = this.snapshot();
          if (!rows.length) return noSnapshot;
          const q = query.trim().toLowerCase();
          if (q) rows = rows.filter((f) => f.path.toLowerCase().includes(q));
          if (category === "junk") rows = rows.filter((f) => junkReason(f));
          if (category === "never_played") rows = rows.filter((f) => f.file_type === "VIDEO" && !f.first_accessed_at);
          if (category === "messy_names") rows = rows.filter((f) => f.file_type === "VIDEO" && isMessyName(f.name));
          if (category === "folders") rows = rows.filter((f) => f.file_type === "FOLDER");
          if (category === "large" || category === "never_played") rows.sort((a, b) => b.size - a.size);
          return JSON.stringify({
            total: rows.length,
            bytes: gb(rows.reduce((a, f) => a + (f.file_type === "FOLDER" ? 0 : f.size), 0)),
            items: rows.slice(0, Math.min(100, Math.max(1, Math.floor(limit)))).map((f) => ({
              path: f.path,
              type: f.file_type,
              size: gb(f.size),
              added: f.created_at.slice(0, 10),
              firstPlayed: f.first_accessed_at?.slice(0, 10) ?? null,
              junk: junkReason(f),
            })),
          });
        },
      }),
    ];
  }
}
