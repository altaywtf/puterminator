import { createAnthropic } from "@ai-sdk/anthropic";
import { AIChatAgent } from "@cloudflare/ai-chat";
import type { Connection } from "agents";
import { convertToModelMessages, createUIMessageStream, createUIMessageStreamResponse, isStepCount, streamText, tool } from "ai";
import { z } from "zod";
import { type Audit, audit, isMessyName, junkReason } from "./audit";
import type { AgentState } from "../shared/types";
import { listFolder, type WalkedFile, walk } from "./putio";


const month = (d = new Date()) => d.toISOString().slice(0, 7);
const gb = (b: number) => (b >= 2 ** 30 ? `${(b / 2 ** 30).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 2 ** 20))} MB`);

const SYSTEM = `You are Puterminator, an agent that helps one person understand and tidy their put.io library.

This version is read-only. You can scan the library, score it, list folders and search files. You cannot rename, move or delete anything yet. When the user asks for changes, describe the plan you would apply (what moves where, what goes to trash and why) and say that applying changes is coming in a later version.

How to work:
- Scan before you judge. Call scan_library when there is no snapshot, when the user asks for a fresh audit, or when the target folder changed.
- After a scan, the UI already shows the score card. Do not repeat every number. Lead with the score and the one or two problems that matter most, with real file names as examples.
- put.io only records first_accessed_at. "Never played" is knowable; "not watched recently" is not. Say so if asked about stale files.
- Be brief and concrete. Plain sentences, short lists, real paths. No marketing tone.`;

type Row = Record<string, string | number | null>;

export class Puterminator extends AIChatAgent<Env, AgentState> {
  initialState: AgentState = {
    username: null,
    folder: { id: 0, name: "Your Files" },
    credits: { month: month(), used: 0, cap: 0 },
    lastAudit: null,
  };

  maxPersistedMessages = 200;

  async onStart() {
    this.sql`CREATE TABLE IF NOT EXISTS secrets (key TEXT PRIMARY KEY, value TEXT NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS usage (month TEXT PRIMARY KEY, tokens INTEGER NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY, parent_id INTEGER, name TEXT NOT NULL, path TEXT NOT NULL, depth INTEGER NOT NULL,
      size INTEGER NOT NULL, file_type TEXT NOT NULL, extension TEXT, crc32 TEXT, created_at TEXT NOT NULL, first_accessed_at TEXT)`;
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

  private token() {
    const row = this.sql<{ value: string }>`SELECT value FROM secrets WHERE key = 'putio_token'`[0];
    return row?.value ?? null;
  }

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

  private tools() {
    return {
      scan_library: tool({
        description:
          "Read the whole tree under the target folder from put.io, save a snapshot and score naming, structure, junk and duplicates. Takes a few seconds on big libraries.",
        inputSchema: z.object({}),
        execute: async () => {
          const token = this.token();
          if (!token) return { error: "Not signed in to put.io." };
          const { id, name } = this.state.folder;
          const res = await walk(token, id);
          this.saveSnapshot(res.files);
          const a: Audit = audit(res.files, id === 0 ? name : res.rootName, res.truncated);
          this.setState({ ...this.state, lastAudit: { at: a.at, rootName: a.rootName, score: a.score, items: a.totals.items } });
          return a;
        },
      }),
      list_folder: tool({
        description: "List the direct children of a folder from the last snapshot. Path is relative to the target folder, '' for its root.",
        inputSchema: z.object({ path: z.string().describe("e.g. '' or '/Movies'") }),
        execute: async ({ path }) => {
          const clean = path.replace(/\/+$/, "");
          const all = this.snapshot();
          if (!all.length) return { error: "No snapshot yet. Run scan_library first." };
          const depth = clean ? clean.split("/").length : 1;
          const rows = all
            .filter((f) => f.depth === depth && (clean ? f.path.startsWith(`${clean}/`) : true))
            .sort((a, b) => a.name.localeCompare(b.name));
          return {
            path: clean || "/",
            count: rows.length,
            items: rows.slice(0, 200).map((f) => ({ name: f.name, type: f.file_type, size: gb(f.size), played: !!f.first_accessed_at })),
          };
        },
      }),
      search_files: tool({
        description:
          "Search the last snapshot. Filter by name substring and/or a category: junk, never_played, messy_names, large, folders.",
        inputSchema: z.object({
          query: z.string().optional(),
          category: z.enum(["any", "junk", "never_played", "messy_names", "large", "folders"]).default("any"),
          limit: z.number().int().min(1).max(100).default(30),
        }),
        execute: async ({ query, category, limit }) => {
          let rows = this.snapshot();
          if (!rows.length) return { error: "No snapshot yet. Run scan_library first." };
          const q = query?.toLowerCase();
          if (q) rows = rows.filter((f) => f.path.toLowerCase().includes(q));
          if (category === "junk") rows = rows.filter((f) => junkReason(f));
          if (category === "never_played") rows = rows.filter((f) => f.file_type === "VIDEO" && !f.first_accessed_at);
          if (category === "messy_names") rows = rows.filter((f) => f.file_type === "VIDEO" && isMessyName(f.name));
          if (category === "folders") rows = rows.filter((f) => f.file_type === "FOLDER");
          if (category === "large" || category === "never_played") rows.sort((a, b) => b.size - a.size);
          return {
            total: rows.length,
            bytes: gb(rows.reduce((a, f) => a + (f.file_type === "FOLDER" ? 0 : f.size), 0)),
            items: rows.slice(0, limit).map((f) => ({
              path: f.path,
              type: f.file_type,
              size: gb(f.size),
              added: f.created_at.slice(0, 10),
              firstPlayed: f.first_accessed_at?.slice(0, 10) ?? null,
              junk: junkReason(f),
            })),
          };
        },
      }),
    };
  }

  async onChatMessage(_onFinish: unknown, options?: { abortSignal?: AbortSignal; body?: Record<string, unknown> }) {
    const folder = z.object({ id: z.number().int().min(0), name: z.string().max(200) }).safeParse(options?.body?.folder);
    if (folder.success && folder.data.id !== this.state.folder.id) this.setState({ ...this.state, folder: folder.data });

    const credits = this.refreshCredits();
    if (credits.used >= credits.cap) {
      return createUIMessageStreamResponse({
        stream: createUIMessageStream({
          execute: ({ writer }) => {
            writer.write({ type: "text-start", id: "cap" });
            writer.write({ type: "text-delta", id: "cap", delta: "You've used this month's credits. They refill on the 1st." });
            writer.write({ type: "text-end", id: "cap" });
          },
        }),
      });
    }

    const anthropic = createAnthropic({ apiKey: this.env.ANTHROPIC_API_KEY });
    const last = this.state.lastAudit;
    const context = [
      `Target folder: ${this.state.folder.name} (id ${this.state.folder.id}).`,
      last ? `Last scan: ${last.at.slice(0, 10)}, ${last.items} items, score ${last.score}.` : "No scan yet.",
      `Credits left this month: ${Math.max(0, Math.round((credits.cap - credits.used) / 1000))}k tokens.`,
    ].join(" ");

    const result = streamText({
      model: anthropic(this.env.MODEL),
      instructions: SYSTEM,
      // Per-turn context goes in a trailing system message so the cached prefix stays stable.
      allowSystemInMessages: true,
      messages: [...(await convertToModelMessages(this.messages)), { role: "system", content: context }],
      tools: this.tools(),
      stopWhen: isStepCount(8),
      abortSignal: options?.abortSignal,
      providerOptions: {
        anthropic: {
          thinking: { type: "adaptive", display: "summarized" },
          effort: "medium",
          cacheControl: { type: "ephemeral" },
        },
      },
      onFinish: ({ totalUsage }) => {
        this.charge((totalUsage.inputTokens ?? 0) + (totalUsage.outputTokens ?? 0));
      },
    });
    return result.toUIMessageStreamResponse({ sendReasoning: true });
  }
}
