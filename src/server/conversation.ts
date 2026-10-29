import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { type AgentState, ClientFrame, ContentBlock, type Credits, type Folder, MessageParam, type ServerEvent, FileFlag, type Library } from "../shared/contract";
import { audit, isMessyName, junkReason } from "./audit";
import { listAll, putioLayer, rootFolders } from "./putio";
import { type AnthropicClient, effectTool, runTurn, type TurnError, weightedTokens } from "./runner";
import { month, type Store } from "./store";
import { buildTree } from "./tree";

const SYSTEM = `You are puterminator, an agent that helps one person understand and tidy their put.io library.

Who you are:
- A retired terminator of processes. Now you terminate release tags. A calm undertaker of files: everything rots, you keep the rot tidy.
- Deadpan about the library, never about the person. At most one dry line per reply; none after an error or when the user sounds annoyed.
- The name is the only terminator joke. No catchphrases, no movie quotes.
- You sort files. You never judge taste or legality.

This version is read-only. You can scan the library, score it, list folders and search files. You cannot rename, move or delete anything yet. When the user asks for changes, describe the plan you would apply (what moves where, what goes to trash and why) and say that applying changes is coming in a later version.

How to work:
- Scan before you judge. Call scan_library when there is no snapshot, when the user asks for a fresh audit, or when the target folder changed.
- After a scan, the UI already shows the score card. Do not repeat every number. Lead with the score and the one or two problems that matter most, with real file names as examples.
- put.io only records first_accessed_at. "Never played" is knowable; "not watched recently" is not. Say so if asked about stale files.
- Each user message ends with a <context> block from the app (target folder, last scan, credits). Use it; don't quote it.

How to write:
- Hard limit: 3 lines and 40 words per reply. Longer only when the user asks for detail or a plan.
- Line one answers. The other lines are proof: at most 3 items, by size.
- Name files by their file name only, not the full path, unless two share a name or the user asks where. Wrap every file and folder name in backticks; the app turns them into links.
- No bold, no labels like "junk:", no headings, no sections, no caveats, no "+N more", no follow-up questions.
- After a scan: one line. The score card already shows the numbers; name only the biggest problem.
- All lowercase, like the app: "no." not "No.". File names and abbreviations (GB, HDR) keep their case.
- Mention read-only only when the user asks for a change. Then give the plan as at most 3 bullets.
- Duplicates: which copy to keep, and why, in one line each. A clean library gets one line, then stop.
- Errors: one line saying what failed and when to retry.
- No preamble, no recap, no offers, no exclamation marks, no emoji.

Examples of the right length:
user: find junk files
you: 351 junk files, 16 MB. mostly cover images and __MACOSX debris.
- \`Screenshot 10 - Bonus.jpg\` (2 MB)
- \`behance-1.png\` (1 MB)

user: is my library a mess?
you: no. 92/100. the only real dent is junk, and it's 16 MB.`;

const gb = (b: number) => (b >= 2 ** 30 ? `${(b / 2 ** 30).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 2 ** 20))} MB`);

const decodeFrame = Schema.decodeUnknownOption(ClientFrame);
const toMessage = Schema.decodeUnknownSync(MessageParam);
const toBlocks = Schema.decodeUnknownSync(Schema.Array(ContentBlock));
// Stored rows are Anthropic's own messages, appended verbatim; the opaque schema keeps every field.
const toAnthropic = (m: MessageParam) => m as unknown as BetaMessageParam;

const NO_CREDITS = "this month's credits are spent. they refill on the 1st.";
const BROKE = "something broke on my side. try again in a moment.";

export const errorMessage = (e: TurnError) => {
  switch (e._tag) {
    case "AnthropicRateLimited":
    case "AnthropicOverloaded":
      return "the model is busy. try again in a minute.";
    case "PutioUnauthorized":
      return "put.io signed you out. sign in again.";
    default:
      return BROKE;
  }
};

export interface AgentDeps {
  readonly store: Store;
  readonly model: string;
  readonly monthlyTokenCap: number;
  readonly anthropic: Layer.Layer<AnthropicClient>;
  /** Sends to every open socket. */
  readonly broadcast: (event: ServerEvent) => void;
  /** Keeps the host alive until the effect settles. */
  readonly background: (effect: Effect.Effect<void>) => void;
  readonly putioFetch?: typeof fetch;
  readonly partialEveryMs?: number;
}

/**
 * The per-user agent, free of Durable Object APIs. Build it once per activation: a turn can't
 * survive eviction, so a stored `busy` flag is cleared here.
 */
export const makeAgent = (deps: AgentDeps) =>
  Effect.gen(function* () {
    const { store, broadcast } = deps;
    let state: AgentState = store.loadState(yield* Clock.currentTimeMillis);
    let turnFiber: Fiber.Fiber<unknown, unknown> | null = null;
    let running = false;

    const setState = (next: AgentState) => {
      state = next;
      store.saveState(next);
      broadcast({ type: "state", state: next });
    };

    const refreshCredits = Effect.gen(function* () {
      const m = month(yield* Clock.currentTimeMillis);
      const credits: Credits = { month: m, used: store.used(m), cap: deps.monthlyTokenCap };
      const c = state.credits;
      if (c.month !== m || c.used !== credits.used || c.cap !== credits.cap) setState({ ...state, credits });
      return credits;
    });

    let last: MessageParam | null = store.history().at(-1) ?? null;
    const append = (m: MessageParam) => {
      store.append(m);
      last = m;
      broadcast({ type: "message", message: m });
    };

    // A stopped, failed or evicted turn can leave a tool_use without its result, which the API rejects next turn.
    const closeDanglingTools = () => {
      if (last?.role !== "assistant" || typeof last.content === "string") return;
      const ids = last.content.flatMap((b) => (b.type === "tool_use" && typeof b.id === "string" ? [b.id] : []));
      if (ids.length === 0) return;
      append({
        role: "user",
        content: ids.map((id) => ({ type: "tool_result", tool_use_id: id, content: "Stopped before this tool finished.", is_error: true })),
      });
    };

    const noSnapshot = JSON.stringify({ error: "No snapshot yet. Run scan_library first." });

    /** The snapshot as the browser's file index; null before the first scan. */
    const library = (): Library | null => {
      const files = store.snapshot();
      const top = files.find((f) => f.depth === 1);
      if (!top || top.parent_id == null) return null;
      return {
        rootId: top.parent_id,
        rootName: state.lastAudit?.rootName ?? state.folder.name,
        files: files.map((f) => [
          f.id,
          f.parent_id ?? top.parent_id ?? 0,
          f.name,
          f.size,
          (f.file_type === "FOLDER" ? FileFlag.folder : 0) |
            (f.file_type === "VIDEO" ? FileFlag.video : 0) |
            (f.first_accessed_at ? FileFlag.played : 0) |
            (junkReason(f) ? FileFlag.junk : 0) |
            (f.file_type === "VIDEO" && isMessyName(f.name) ? FileFlag.messy : 0),
        ]),
      };
    };

    // Inputs have no optional or default fields and no numeric bounds, so they stay valid under strict tool use.
    const tools = [
      effectTool({
        name: "scan_library",
        description:
          "Read the whole tree under the target folder from put.io, save a snapshot and score naming, structure, junk and duplicates. Takes a few seconds on big libraries.",
        input: Schema.Struct({}),
        run: () =>
          Effect.gen(function* () {
            if (!store.token()) return JSON.stringify({ error: "Not signed in to put.io." });
            const { id, name } = state.folder;
            const tree = buildTree(yield* listAll, id);
            store.saveSnapshot(tree.files);
            const a = audit(tree.files, id === 0 ? name : tree.rootName, false, new Date(yield* Clock.currentTimeMillis));
            setState({ ...state, lastAudit: { at: a.at, rootName: a.rootName, score: a.score, items: a.totals.items } });
            const lib = library();
            if (lib) broadcast({ type: "library", library: lib });
            return JSON.stringify(a);
          }),
      }),
      effectTool({
        name: "list_folder",
        description: "List the direct children of a folder from the last snapshot. Path is relative to the target folder, '' for its root.",
        input: Schema.Struct({ path: Schema.String.annotate({ description: "e.g. '' or '/Movies'" }) }),
        run: ({ path }) =>
          Effect.sync(() => {
            const clean = path.replace(/\/+$/, "");
            const all = store.snapshot();
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
          }),
      }),
      effectTool({
        name: "search_files",
        description:
          "Search the last snapshot by name substring (empty string for none) and a category: any, junk, never_played, messy_names, large, folders.",
        input: Schema.Struct({
          query: Schema.String,
          category: Schema.Literals(["any", "junk", "never_played", "messy_names", "large", "folders"]),
          limit: Schema.Finite.annotate({ description: "1 to 100" }),
        }),
        run: ({ query, category, limit }) =>
          Effect.sync(() => {
            let rows = store.snapshot();
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
          }),
      }),
    ];

    const converse = (text: string) =>
      Effect.gen(function* () {
        const credits = yield* refreshCredits;
        const lastAudit = state.lastAudit;
        const context = [
          `Target folder: ${state.folder.name} (id ${state.folder.id}).`,
          lastAudit
            ? `Last scan: ${lastAudit.at.slice(0, 10)}, ${lastAudit.items} items, score ${lastAudit.score}.`
            : "No scan yet.",
          `Credits left this month: ${Math.max(0, Math.floor((credits.cap - credits.used) / 1000))}.`,
        ].join(" ");
        closeDanglingTools();
        append({
          role: "user",
          content: [
            { type: "text", text },
            { type: "text", text: `<context>${context}</context>` },
          ],
        });
        if (credits.used >= credits.cap) {
          append({ role: "assistant", content: [{ type: "text", text: NO_CREDITS }] });
          return;
        }

        setState({ ...state, busy: true });
        const events = runTurn({
          model: deps.model,
          system: SYSTEM,
          messages: store.history().map(toAnthropic),
          tools,
          partialEveryMs: deps.partialEveryMs ?? 60,
        });
        yield* Stream.runForEach(events, (event) =>
          Effect.gen(function* () {
            switch (event.type) {
              case "partial":
                broadcast({ type: "partial", content: toBlocks(event.content) });
                return;
              case "assistant": {
                const m = month(yield* Clock.currentTimeMillis);
                store.charge(m, weightedTokens(event.message.usage));
                yield* refreshCredits;
                append(toMessage({ role: "assistant", content: event.message.content }));
                broadcast({ type: "partial", content: null });
                return;
              }
              case "tool_results":
                append(toMessage(event.message));
                return;
            }
          }),
        ).pipe(Effect.provide(Layer.merge(deps.anthropic, putioLayer(store.token() ?? undefined, deps.putioFetch))));
      });

    const turn = (text: string) =>
      converse(text).pipe(
        Effect.catch((e: TurnError) =>
          Effect.gen(function* () {
            if (e._tag === "PutioUnauthorized") store.deleteToken();
            else yield* Effect.logError("turn failed", e);
            broadcast({ type: "error", message: errorMessage(e) });
          }),
        ),
        Effect.catchDefect((defect) =>
          Effect.gen(function* () {
            yield* Effect.logError("turn crashed", defect);
            broadcast({ type: "error", message: BROKE });
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            closeDanglingTools();
            turnFiber = null;
            running = false;
            broadcast({ type: "partial", content: null });
            if (state.busy) setState({ ...state, busy: false });
          }),
        ),
      );

    const start = (text: string, folder: Folder) => {
      running = true;
      if (folder.id !== state.folder.id) setState({ ...state, folder });
      deps.background(
        Effect.withFiber((fiber) => {
          turnFiber = fiber;
          return turn(text);
        }),
      );
    };

    if (state.busy) setState({ ...state, busy: false });
    yield* refreshCredits;

    return {
      state: () => state,
      /** First frames for a new socket. The instance name never goes out. */
      greeting: (): Array<ServerEvent> => {
        const lib = library();
        return [
          { type: "state", state },
          { type: "history", messages: store.history() },
          ...(lib ? [{ type: "library" as const, library: lib }] : []),
        ];
      },
      /** One browser frame. Frames that fail to decode are dropped. */
      receive: (raw: string) =>
        Effect.gen(function* () {
          const event = decodeFrame(raw);
          if (Option.isNone(event)) return;
          if (event.value.type === "stop") {
            if (turnFiber) yield* Fiber.interrupt(turnFiber);
            return;
          }
          if (running || state.busy) return;
          start(event.value.text, event.value.folder);
        }),
      /** Called by the Worker after OAuth. Never reachable from the browser. */
      setAuth: (token: string, username: string) =>
        Effect.sync(() => {
          store.setToken(token);
          setState({ ...state, username });
        }),
      signOut: Effect.sync(() => store.deleteToken()),
      rootFolders: Effect.suspend(() => {
        const token = store.token();
        if (!token) return Effect.succeed<Array<Folder>>([]);
        return rootFolders.pipe(Effect.provide(putioLayer(token, deps.putioFetch)));
      }),
    };
  });

export type Agent = Effect.Success<ReturnType<typeof makeAgent>>;
