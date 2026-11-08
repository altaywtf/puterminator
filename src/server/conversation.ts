import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages";
import * as Clock from "effect/Clock";
import * as Exit from "effect/Exit";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { type AgentState, type Blocked, blockedText, ClientFrame, ContentBlock, CREDIT_TOKENS, type Credits, creditsLeft, Feedback, FEEDBACK_MAX_CHARS, feedbackText, type Folder, MessageParam, type ServerEvent, FileFlag, initialAgentState, type Library } from "../shared/contract";
import { audit, isMessyName, junkFinder } from "./audit";
import type { PlanRecord, Run } from "../shared/actions";
import { AskInput, applyChange, cleanPath, type StoredPlan, uploadedKey, validateTranslation, untranslated, folderIds, nameOf, ProposeInput, parentOf, staleChanges, undoChanges, validatePlan, validateQuestion, videoOf } from "./changes";
import { createDownloadLinks, diskUsage, downloadLinks, downloadToken, fileMedia, hlsUrl, listAll, maybeApplied, mediaInfo, type PutioError, putioLayer, stepMessage, trashEnabled } from "./putio";
import { blockedBy, outOfBudget } from "./credits";
import { type AnthropicClient, effectTool, runTurn, type TurnError } from "./runner";
import { month, type Store, type StoredRecord } from "./store";
import { buildTree, type WalkedFile } from "./tree";
import type { DownloadLinksOutput, DownloadLinksResponse, FreeSpaceOutput, LayoutOutput, ListFolderOutput, MediaInfoOutput, SearchFilesOutput } from "../shared/tools";
import { planLayout } from "./layout";
import { planFreeSpace } from "./space";
import { planSubtitles } from "./subtitles";
import type { OpenSubtitles } from "./opensubtitles";
import type { Tmdb } from "./tmdb";
import { checkSource, LanguageCode, LANGUAGES, translateSubtitle } from "./translate";

const SYSTEM = `You are puterminator, an agent that helps one person understand and tidy their put.io library.

Who you are:
- A retired terminator of processes. Now you terminate release tags. A calm undertaker of files: everything rots, you keep the rot tidy.
- Deadpan about the library, never about the person. At most one dry line per reply; none after an error or when the user sounds annoyed.
- The name is the only terminator joke. No catchphrases, no movie quotes.
- You sort files. You never judge taste or legality.

You can scan, score, list folders, search files (by name, category or MIME type), read a file's media info and make download links; every file you name links to put.io and videos play in the app. You can also change the library, but only through a plan the user approves:
- To make the library work with Plex, Infuse, Jellyfin or Kodi, call plan_layout: it builds the whole plan itself. If the snapshot doesn't show which folders hold movies and shows, ask with ask_user, offering existing top-level folders or new 'Movies' and 'TV Shows'. Afterwards, one line on what it did and how many files it left alone.
- To fix subtitles put.io or a media server doesn't show, call plan_subtitles: it renames each stray .srt to its video's name and moves it next to the video. One line afterwards; say how many it left alone and why.
- To translate subtitles, call propose_translation with the videos or folders and the language; a folder covers every video under it, so pass a show or season folder as is. It starts from put.io's English subtitle, or one from OpenSubtitles when put.io has none; at most 30 videos at a time. It leaves out videos it can't translate; name them and say why in one line. When the videos share a folder, as a season's episodes do, offer in the same line to give each its own folder afterwards with plan_subtitles and own_folders: put.io can show one episode's subtitle on another in a shared folder.
- To find what lacks subtitles in a language, call find_untranslated, then offer to translate the folders with the most missing.
- To free up space, call plan_free_space with the amount the user wants back (0 if they gave none). It trashes exact copies and junk itself. For each choice it returns (one title in two versions), ask with ask_user which copy to keep, then propose_changes for the rest. Hints (big never-played files) are only suggestions; name them, never trash them unasked.
- To trash, rename or move anything else, call propose_changes with every change. The app shows it as a diff; the user applies, edits or discards it. You never apply anything yourself, and nothing changes until they click apply.
- Trash goes to put.io's trash, never a permanent delete. Prefer trash for junk, rename for messy release names, move for wrapper folders.
- After propose_changes, stop: at most one line, never a list of the changes; the diff shows them.
- When you need a decision you can't infer (which copy to keep, which folders to leave alone), call ask_user and stop. The answer arrives as the next user message.
- When the user hits a bug in puterminator itself, or wants something it can't do, offer once to pass it on. When they agree or ask to send feedback, call draft_feedback with a short plain write-up in their words: what happened and what they expected, or what they want. The app shows the draft; they review and send it. You never send it yourself. After draft_feedback, stop: at most one line.
- The <context> block says when a plan was applied or discarded. After an apply the snapshot is fresh; don't propose the same changes again.

How to work:
- Scan before you judge. Call scan_library when there is no snapshot, when the last scan is more than 10 minutes old, when the user asks for a fresh audit, or when the target folder changed.
- After a scan, the UI shows a score card with the score, the weakest area, and the junk, duplicate and never-played counts and sizes. Never restate those. Add only what the card cannot say: the one problem that matters most, with one or two real file names. A scan with no files has no score; say the folder is empty.
- put.io only records first_accessed_at. "Never played" is knowable; "not watched recently" is not. Say so if asked about stale files.
- Each user message ends with a <context> block from the app (target folder, last scan, credits). Use it; don't quote it.
- Asked what you can do, or greeted in an empty thread: in 3 short lines, say what you can do for this library today (score it, find and play files, make download links, plan renames, moves and trash as a diff), then end with one thing worth doing first, as a statement they can act on.

How to write:
- Hard limit: 3 lines and 40 words per reply. Longer only when the user asks for detail or a plan.
- Line one answers. The other lines are proof: at most 3 items, by size.
- Name files by their file name only, not the full path, unless two share a name or the user asks where. Wrap every file and folder name in backticks; the app turns them into links.
- No bold, no labels like "junk:", no headings, no sections, no caveats, no "+N more", no follow-up questions.
- After a scan: one line, no numbers from the card.
- All lowercase, like the app: "no." not "No.". File names and abbreviations (GB, HDR) keep their case.
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

const formatSize = (b: number) =>
  b >= 2 ** 30 ? `${(b / 2 ** 30).toFixed(1)} GB` : b >= 2 ** 20 ? `${Math.round(b / 2 ** 20)} MB` : `${Math.max(1, Math.round(b / 2 ** 10))} KB`;

const mimeOf = (f: WalkedFile) => (f.file_type === "FOLDER" ? null : f.content_type);

const byMime = (rows: ReadonlyArray<WalkedFile>) => {
  const groups = new Map<string, { count: number; bytes: number }>();

  for (const f of rows) {
    const mime = mimeOf(f);

    if (mime === null) continue;
    const g = groups.get(mime) ?? { count: 0, bytes: 0 };
    groups.set(mime, { count: g.count + 1, bytes: g.bytes + f.size });
  }

  return [...groups]
    .sort(([, a], [, b]) => b.bytes - a.bytes)
    .slice(0, 10)
    .map(([mime, g]) => ({ mime, count: g.count, bytes: formatSize(g.bytes) }));
};

type Probe = NonNullable<Effect.Success<ReturnType<typeof mediaInfo>>["media_info"]>;

const mediaSummary = (m: Probe): NonNullable<MediaInfoOutput["files"][number]["info"]> => {
  const streams = m.streams ?? [];
  const of = (type: string) => streams.filter((s) => s.codec_type === type);

  return {
    container: m.format?.name ?? null,
    minutes: m.format?.duration == null ? null : Math.round(m.format.duration / 60),
    kbps: m.format?.bit_rate == null ? null : Math.round(m.format.bit_rate / 1000),
    video: of("video").map((s) => ({ codec: s.codec_name ?? null, profile: s.profile ?? null, width: s.width ?? null, height: s.height ?? null })),
    audio: of("audio").map((s) => ({ codec: s.codec_name ?? null, channels: s.channels ?? null })),
    subtitles: of("subtitle").map((s) => s.codec_name ?? null),
    issues: [...(m.playback_issues ?? [])],
  };
};

const decodeFrame = Schema.decodeUnknownOption(ClientFrame);
const toMessage = Schema.decodeUnknownSync(MessageParam);
const toBlocks = Schema.decodeUnknownSync(Schema.Array(ContentBlock));
const isToolUse = Schema.is(Schema.Struct({ type: Schema.Literal("tool_use"), id: Schema.String }));

// SAFETY: stored rows are Anthropic's own messages, appended verbatim; the opaque schema keeps every field.
const toAnthropic = (m: MessageParam) => m as BetaMessageParam;

const POOL_DOWN = "can't check credits right now. try again in a minute.";
const POOL_TIMEOUT = "5 seconds";
const BROKE = "something broke on my side. try again in a moment.";

const errorMessage = (e: TurnError) =>
  Match.value(e).pipe(
    Match.tag("AnthropicRateLimited", "AnthropicOverloaded", () => "the model is busy. try again in a minute."),
    Match.tag("PutioUnauthorized", () => "put.io signed you out. sign in again."),
    Match.tag("AnthropicOutOfBudget", () => blockedText(outOfBudget(Date.now()))),
    Match.orElse(() => BROKE),
  );

export interface AgentDeps {
  readonly store: Store;
  readonly model: string;
  readonly monthlyCredits: number;
  readonly poolBudgetCredits: number;
  /** Records this Durable Object's month total in the shared pool and returns everyone's total; totals only grow, so a retry is harmless. */
  readonly pool: (month: string, tokens: number) => Effect.Effect<number, unknown>;
  readonly unlimitedUsers?: ReadonlyArray<string>;
  readonly anthropic: Layer.Layer<AnthropicClient>;
  /** Sends to every open socket. */
  readonly broadcast: (event: ServerEvent) => void;
  /** Closes every open socket. */
  readonly disconnect: () => void;
  /** Keeps the host alive until the effect settles. */
  readonly background: (effect: Effect.Effect<void>) => void;
  readonly putioFetch?: typeof fetch;
  /** Where translations find an English subtitle put.io lacks; null leaves those videos out. */
  readonly openSubtitles?: OpenSubtitles | null;
  /** Film and show facts that help translations; null translates without them. */
  readonly tmdb?: Tmdb | null;
  /** put.io's API origin for URLs handed to the browser; the dev fake overrides it. */
  readonly putioBase?: string;
  readonly partialEveryMs?: number;
  /** put.io restores trash in the background; wait this long before rescanning for files still missing. */
  readonly restoreRecheckMs?: number;
  /** put.io makes download links in the background; ask again this often while it works. */
  readonly linksPollMs?: number;
}

const MINUTE_MS = 60_000;
const PARALLEL_TRANSLATIONS = 3;
const SOURCE_CHECKS = 6;
const MAX_THUMBS = 500;

const describeAge = (ms: number) => {
  const minutes = Math.floor(ms / MINUTE_MS);

  if (minutes < 1) return "just now";

  if (minutes < 120) return `${minutes} minutes ago`;

  if (minutes < 48 * 60) return `${Math.floor(minutes / 60)} hours ago`;

  return `${Math.floor(minutes / (24 * 60))} days ago`;
};

/**
 * The per-user agent, free of Durable Object APIs. Build it once per activation: a turn can't
 * survive eviction, so a stored `busy` flag is cleared here.
 */
export const makeAgent = (deps: AgentDeps) =>
  Effect.gen(function* () {
    const { store, broadcast } = deps;
    let state: AgentState = store.loadState(yield* Clock.currentTimeMillis);
    const sources = { online: deps.openSubtitles ?? null, tmdb: deps.tmdb ?? null };
    const capFor = () => (state.username !== null && (deps.unlimitedUsers ?? []).includes(state.username) ? Number.MAX_SAFE_INTEGER : deps.monthlyCredits * CREDIT_TOKENS);
    const budget = deps.poolBudgetCredits * CREDIT_TOKENS;
    let poolTotal: number | null = null;
    let syncing = false;
    let dirty = false;
    let turnFiber: Fiber.Fiber<unknown, unknown> | null = null;
    const thumbs = new Map<number, string | null>();
    let streamToken: string | null = null;

    const remember = (id: number, url: string | null) => {
      thumbs.set(id, url);
      const oldest = thumbs.size > MAX_THUMBS ? thumbs.keys().next() : null;

      if (oldest && !oldest.done) thumbs.delete(oldest.value);
    };

    let running = false;
    let asked = false;
    let streamed: ReadonlyArray<{ readonly type: string; readonly text?: string }> = [];
    const calls = new Set<string>();

    const once = <R>(name: string, input: Schema.Json, run: Effect.Effect<string, PutioError, R>): Effect.Effect<string, PutioError, R> =>
      Effect.suspend(() => {
        const key = `${name}:${JSON.stringify(input)}`;

        if (calls.has(key)) return Effect.succeed(JSON.stringify({ error: "You already made this exact call this turn. Use that result." }));
        calls.add(key);

        return run;
      });

    const setState = (next: AgentState) => {
      state = next;
      store.saveState(next);
      broadcast({ type: "state", state: next });
    };

    const blockedAt = (now: number): Blocked | null => blockedBy({ now, used: store.used(month(now)), cap: capFor(), pool: poolTotal ?? budget, budget });

    const refreshCredits = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const m = month(now);
      const credits: Credits = { month: m, used: store.used(m), cap: capFor(), blocked: poolTotal === null ? null : blockedAt(now) };
      const c = state.credits;

      if (c.month !== m || c.used !== credits.used || c.cap !== credits.cap || c.blocked?.reason !== credits.blocked?.reason || c.blocked?.until !== credits.blocked?.until) setState({ ...state, credits });

      return credits;
    });

    const syncPool = Effect.gen(function* () {
      const m = month(yield* Clock.currentTimeMillis);
      const total = yield* deps.pool(m, store.used(m)).pipe(Effect.timeout(POOL_TIMEOUT), Effect.option);
      poolTotal = Option.getOrNull(total);
    });

    const pushPool: Effect.Effect<void> = Effect.gen(function* () {
      while (dirty) {
        dirty = false;
        yield* syncPool;
      }

      syncing = false;
      yield* refreshCredits;
    });

    const charge = (m: string, tokens: number) => {
      store.charge(m, tokens);
      dirty = true;

      if (syncing) return;
      syncing = true;
      deps.background(pushPool);
    };

    const spendFor = (m: string) => ({
      blocked: () => {
        if (poolTotal === null) return POOL_DOWN;
        const b = blockedAt(Date.now());

        return b === null ? null : blockedText(b);
      },
      charge: (tokens: number) => charge(m, tokens),
    });

    let last: MessageParam | null = store.history().at(-1) ?? null;

    const append = (m: MessageParam) => {
      store.append(m);
      last = m;
      broadcast({ type: "message", message: m });
    };

    const closeDanglingTools = () => {
      if (last?.role !== "assistant" || Predicate.isString(last.content)) return;
      const ids = last.content.flatMap((b) => (isToolUse(b) ? [b.id] : []));

      if (ids.length === 0) return;
      append({
        role: "user",
        content: ids.map((id) => ({ type: "tool_result", tool_use_id: id, content: "Stopped before this tool finished.", is_error: true })),
      });
    };

    const keepStreamedText = () => {
      const text = streamed.flatMap((b) => (b.type === "text" && b.text?.trim() ? [{ type: "text" as const, text: b.text }] : []));
      streamed = [];

      if (text.length > 0 && last?.role !== "assistant") append({ role: "assistant", content: text });
    };

    const signedOut = JSON.stringify({ error: "Not signed in; the user must sign in to put.io again." });
    const noSnapshot = JSON.stringify({ error: "No snapshot yet. Run scan_library first." });
    const otherFolder = JSON.stringify({ error: "The last scan is of another folder. Run scan_library first." });
    const scannedHere = () => store.secret("snapshot_root") === String(state.folder.id);

    const snapshotHere = (): Result.Result<Array<WalkedFile>, string> => {
      const all = store.snapshot();

      return !all.length ? Result.fail(noSnapshot) : scannedHere() ? Result.succeed(all) : Result.fail(otherFolder);
    };

    const library = (): Library | null => {
      const files = store.snapshot();
      const top = files.find((f) => f.depth === 1);

      if (!top || top.parent_id == null) return null;
      const junk = junkFinder(files);

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
            (junk(f) ? FileFlag.junk : 0) |
            (f.file_type === "VIDEO" && isMessyName(f.name) ? FileFlag.messy : 0),
        ]),
      };
    };

    const scanLock = yield* Semaphore.make(1);

    let epoch = 0;

    const scan = scanLock.withPermits(1)(Effect.gen(function* () {
      const started = epoch;
      const { id, name } = state.folder;
      const tree = buildTree(yield* listAll, id);
      const a = audit(tree.files, id === 0 ? name : tree.rootName, false, new Date(yield* Clock.currentTimeMillis), id === 0 ? "" : tree.rootName);

      if (started !== epoch) return a;
      store.saveSnapshot(tree.files, id);
      setState({ ...state, lastAudit: { at: a.at, rootName: a.rootName, score: a.score, items: a.totals.items } });
      const lib = library();

      if (lib) broadcast({ type: "library", library: lib });

      return a;
    }));

    const STALE_AFTER_MS = 10 * MINUTE_MS;
    let refreshing = false;
    const scanAgeMs = (now: number) => (state.lastAudit ? now - Date.parse(state.lastAudit.at) : Number.POSITIVE_INFINITY);

    const refreshStaleSnapshot = Effect.gen(function* () {
      const token = store.token();

      if (!token || refreshing || running || runFibers.size > 0) return;

      if (scannedHere() && scanAgeMs(yield* Clock.currentTimeMillis) <= STALE_AFTER_MS) return;
      refreshing = true;

      yield* scan.pipe(
        Effect.ignore,
        Effect.provide(putioLayer(token, deps.putioFetch)),
        Effect.ensuring(Effect.sync(() => (refreshing = false))),
      );
    });

    const plans = new Map(store.plans().map((p) => [p.record.plan.id, p]));
    const runFibers = new Map<string, Fiber.Fiber<unknown, unknown>>();
    const newId = () => crypto.randomUUID().replaceAll("-", "").slice(0, 12);

    const sessionGen = () => Number(store.secret("session_gen") ?? 0);

    const saveRecord = (p: StoredRecord) => {
      plans.set(p.record.plan.id, p);
      store.savePlan(p);
      broadcast({ type: "plan", record: p.record });
    };

    const current = (r: PlanRecord) => r.undo ?? r.run;
    const withCurrent = (r: PlanRecord, run: Run): PlanRecord => (r.undo ? { ...r, undo: run } : { ...r, run });

    const failUnfinished = (run: Run, error: string): Run => ({
      ...run,
      steps: run.steps.map((s) =>
        Match.value(s.state).pipe(
          Match.withReturnType<Run["steps"][number]>(),
          Match.when("running", () => ({ ...s, state: "failed", error, maybeApplied: true })),
          Match.when("queued", () => ({ ...s, state: "failed", error })),
          Match.orElse(() => s),
        ),
      ),
    });

    const runSteps = (planId: string, eitherEnd: boolean, changed: string) => {
      const token = store.token();
      const first = plans.get(planId);
      const run = first && current(first.record);

      if (!first || !run) return;
      const undoing = !!first.record.undo;

      const update = (f: (run: Run) => Run, status: StoredRecord["record"]["status"] = undoing ? "undoing" : "applying") => {
        const cur = plans.get(planId);
        const r = cur && current(cur.record);

        if (cur && r) saveRecord({ ...cur, reported: false, record: withCurrent({ ...cur.record, status }, f(r)) });
      };

      const finished = undoing ? "undone" : "done";

      const setStep = (change: string, state: Run["steps"][number]["state"], error: string | null = null, maybe = false) =>
        update((run) => ({
          ...run,
          steps: run.steps.map((s) => {
            if (s.change !== change) return s;
            const step = { change, state, error };

            return maybe || s.maybeApplied ? { ...step, maybeApplied: true } : step;
          }),
        }));

      const refused =
        !token ? "put.io signed you out; sign in again"
        : first.folder && first.folder.id !== state.folder.id ? `made in ${first.folder.name}; switch back to it first`
        : !scannedHere() ? "the last scan is of another folder; scan again first"
        : null;

      if (!token || refused) return update((r) => failUnfinished(r, refused ?? ""), finished);
      const parents = first.parents ?? {};

      const original = undoing
        ? run.changes.flatMap((c): Array<[string, number]> => {
            const id = parents[c.id];

            return c.op === "move" && c.to && id !== undefined ? [[parentOf(c.to), id]] : [];
          })
        : [];

      const changeOf = new Map(run.changes.map((c) => [c.id, c]));

      const failStep = (change: string, exit: Exit.Exit<unknown, PutioError>) => {
        const err = Exit.findErrorOption(exit);

        if (Option.isSome(err)) setStep(change, "failed", stepMessage(err.value), maybeApplied(err.value));
        else setStep(change, "failed", "didn’t finish", true);
      };

      const work = Effect.gen(function* () {
        const queued = run.steps.filter((s) => s.state === "queued");
        const checked = yield* Effect.result(scan);

        if (Result.isFailure(checked)) return update((r) => failUnfinished(r, `couldn’t check put.io first: ${stepMessage(checked.failure)}`), finished);
        const present = new Set(store.snapshot().map((f) => f.id));

        const trashed = new Set(
          queued.flatMap((s) => {
            const id = first.ids[s.change];

            return eitherEnd && s.maybeApplied && changeOf.get(s.change)?.op === "trash" && id !== undefined && !present.has(id) ? [s.change] : [];
          }),
        );

        const queuedIds = new Set(queued.flatMap((s) => (trashed.has(s.change) ? [] : [s.change])));
        const stale = staleChanges(store.snapshot(), run.changes.filter((c) => queuedIds.has(c.id)), first.ids, eitherEnd, run.changes);

        if (stale.length > 0) return update((r) => failUnfinished(r, `the library changed since this plan (${stale[0]}); ${changed}`), finished);
        const folders = folderIds(store.snapshot(), state.folder.id, original);
        const needsTrash = queued.some((s) => changeOf.get(s.change)?.op === "trash");
        const trashOn = needsTrash ? yield* trashEnabled.pipe(Effect.orElseSucceed(() => false)) : true;

        const translate = (step: (typeof queued)[number]) =>
          Effect.gen(function* () {
            const change = changeOf.get(step.change);
            const fileId = first.ids[step.change];

            if (change?.op !== "translate" || fileId === undefined) return;

            const lang = change.to?.match(/\.([a-z]{3})\.srt$/)?.[1];
            const m = month(yield* Clock.currentTimeMillis);

            if (!lang || !Schema.is(LanguageCode)(lang) || !change.to) {
              setStep(step.change, "failed", "no language in the subtitle name");

              return;
            }

            setStep(step.change, "running");
            const parentId = first.parents?.[step.change] ?? state.folder.id;
            const spend = spendFor(m);
            const done = yield* Effect.exit(translateSubtitle(fileId, change.path, parentId, nameOf(change.to), lang, spend, sources).pipe(Effect.provide(deps.anthropic)));
            yield* refreshCredits;

            if (Exit.isSuccess(done)) {
              const p = plans.get(planId);

              if (p) saveRecord({ ...p, ids: { ...p.ids, [uploadedKey(step.change)]: done.value } });
              setStep(step.change, "done");
            } else failStep(step.change, done);
          });

        if (queued.some((step) => changeOf.get(step.change)?.op === "translate")) yield* syncPool;
        yield* Effect.forEach(queued, translate, { concurrency: PARALLEL_TRANSLATIONS, discard: true });

        const failedVideos = new Set<string>();

        for (const step of queued) {
          const change = changeOf.get(step.change);
          const fileId = first.ids[step.change];

          if (!change || fileId === undefined) continue;
          const video = videoOf(change.id);

          if (video !== change.id && failedVideos.has(video)) {
            setStep(step.change, "failed", "its video didn’t move");
            continue;
          }

          if (change.op === "translate") continue;

          if (trashed.has(step.change)) {
            setStep(step.change, "done");
            continue;
          }

          if (change.op === "trash" && !trashOn) {
            setStep(step.change, "failed", "trash is off in your put.io settings, so this would delete for good");
            continue;
          }

          setStep(step.change, "running");
          const exit = yield* Effect.exit(applyChange(change, fileId, folders));

          if (Exit.isSuccess(exit)) setStep(step.change, "done");
          else {
            failedVideos.add(step.change);
            failStep(step.change, exit);
          }
        }

        yield* scan.pipe(Effect.ignore);

        const restored = new Set(
          (current(plans.get(planId)?.record ?? first.record)?.steps ?? []).flatMap((s) => {
            const id = first.ids[s.change];

            return s.state === "done" && id !== undefined && changeOf.get(s.change)?.op === "restore" ? [id] : [];
          }),
        );

        const missing = () => {
          const have = new Set(store.snapshot().map((f) => f.id));

          return [...restored].some((id) => !have.has(id));
        };

        for (let i = 0; i < 3 && missing(); i++) {
          yield* Effect.sleep(deps.restoreRecheckMs ?? 5000);
          yield* scan.pipe(Effect.ignore);
        }

        update((r) => r, finished);
      });

      deps.background(
        Effect.withFiber((fiber) => {
          runFibers.set(planId, fiber);

          return work.pipe(
            Effect.provide(putioLayer(token, deps.putioFetch)),
            Effect.catchDefect((defect) => Effect.logError("run crashed", defect)),
            Effect.ensuring(
              Effect.sync(() => {
                runFibers.delete(planId);
                const status = plans.get(planId)?.record.status;

                if (status !== "applying" && status !== "undoing") return;
                update((r) => failUnfinished(r, "stopped"), finished);
                deps.background(scan.pipe(Effect.ignore, Effect.provide(putioLayer(token, deps.putioFetch))));
              }),
            ),
          );
        }),
      );
    };

    const apply = (planId: string, exclude: ReadonlyArray<string>) => {
      const p = plans.get(planId);

      if (!p || p.record.status !== "proposed" || runFibers.size > 0) return;
      const changes = p.record.plan.changes.filter((c) => !exclude.includes(c.id) && !exclude.includes(videoOf(c.id)));

      if (changes.length === 0) return;
      const run: Run = { id: planId, title: p.record.plan.title, changes, steps: changes.map((c) => ({ change: c.id, state: "queued", error: null })) };
      saveRecord({ ...p, reported: false, record: { ...p.record, status: "applying", run } });
      runSteps(planId, false, "ask for a new one");
    };

    const retry = (planId: string) => {
      const p = plans.get(planId);
      const run = p && current(p.record);

      if (!p || !run || (p.record.status !== "done" && p.record.status !== "undone") || runFibers.size > 0) return;
      const steps = run.steps.map((s) => (s.state === "failed" ? { ...s, state: "queued" as const, error: null } : s));
      saveRecord({ ...p, reported: false, record: withCurrent({ ...p.record, status: p.record.undo ? "undoing" : "applying" }, { ...run, steps }) });
      runSteps(planId, true, p.record.undo ? "undo it by hand" : "ask for a new one");
    };

    const undo = (planId: string) => {
      const p = plans.get(planId);
      const run = p?.record.run;

      if (!p || !run || p.record.status !== "done" || runFibers.size > 0) return;
      const changes = undoChanges(run).filter((c) => p.ids[c.id] !== undefined);

      if (changes.length === 0) return;
      const back: Run = { id: planId, title: run.title, changes, steps: changes.map((c) => ({ change: c.id, state: "queued", error: null })) };
      saveRecord({ ...p, reported: false, record: { ...p.record, status: "undoing", undo: back } });
      runSteps(planId, true, "undo it by hand");
    };

    const discard = (planId: string) => {
      const p = plans.get(planId);

      if (p?.record.status === "proposed") saveRecord({ ...p, reported: false, record: { ...p.record, status: "discarded" } });
    };

    for (const p of plans.values()) {
      const run = current(p.record);

      if (run && (p.record.status === "applying" || p.record.status === "undoing"))
        saveRecord({ ...p, record: withCurrent({ ...p.record, status: p.record.undo ? "undone" : "done" }, failUnfinished(run, "interrupted")) });
    }

    const planNews = () =>
      [...plans.values()].flatMap((p) => {
        const { status } = p.record;

        if (p.reported || status === "proposed" || status === "applying" || status === "undoing") return [];
        saveRecord({ ...p, reported: true });

        if (status === "discarded") return [`The user discarded plan "${p.record.plan.title}".`];
        const steps = current(p.record)?.steps ?? [];
        const failed = steps.filter((s) => s.state === "failed");
        const verb = status === "undone" ? "undid" : "applied";

        return [
          `The user ${verb} plan "${p.record.plan.title}": ${steps.length - failed.length} done, ${failed.length} failed${failed[0]?.error ? ` (${failed[0].error})` : ""}. The snapshot was rescanned.`,
        ];
      });

    const storePlan = (out: StoredPlan) =>
      saveRecord({ record: { plan: out.plan, status: "proposed", run: null }, ids: out.ids, parents: out.parents, folder: state.folder, reported: true });

    const proposeGenerated = (
      snapshot: ReadonlyArray<WalkedFile>,
      title: string,
      result: { changes: ProposeInput["changes"]; skipped: ReadonlyArray<{ path: string; why: string }>; remaining: number },
      nothingToDo: string,
    ) => {
      const examples = result.skipped.slice(0, 5);

      if (result.changes.length === 0) return JSON.stringify({ error: `${nothingToDo} ${result.skipped.length} left alone.`, examples });
      const out = validatePlan(snapshot, { title, changes: result.changes }, newId());

      if ("error" in out) return JSON.stringify(out);
      storePlan(out);

      return JSON.stringify({ plan: out.plan.id, changes: out.plan.changes.length, skipped: result.skipped.length, remaining: result.remaining, examples } satisfies LayoutOutput);
    };

    const tools = [
      effectTool({
        name: "scan_library",
        description:
          "Read the whole tree under the target folder from put.io, save a snapshot and score naming, structure, junk and duplicates. Takes a few seconds on big libraries.",
        input: Schema.Struct({}),
        run: (input) =>
          once(
            "scan_library",
            input,
            Effect.gen(function* () {
              if (!store.token()) return signedOut;

              return JSON.stringify(yield* scan);
            }),
          ),
      }),
      effectTool({
        name: "list_folder",
        description: "List the direct children of a folder from the last snapshot. Path is relative to the target folder, '' for its root.",
        input: Schema.Struct({ path: Schema.String.annotate({ description: "e.g. '' or '/Movies'" }) }),
        run: ({ path }) =>
          once("list_folder", path, Effect.sync(() => {
            const clean = path.replace(/\/+$/, "");
            const all = snapshotHere();

            if (Result.isFailure(all)) return all.failure;
            const depth = clean ? clean.split("/").length : 1;

            const rows = all.success
              .filter((f) => f.depth === depth && (clean ? f.path.startsWith(`${clean}/`) : true))
              .sort((a, b) => a.name.localeCompare(b.name));

            return JSON.stringify({
              path: clean || "/",
              count: rows.length,
              items: rows.slice(0, 200).map((f) => ({ name: f.name, type: f.file_type, mime: mimeOf(f), size: formatSize(f.size), played: !!f.first_accessed_at })),
            } satisfies ListFolderOutput);
          })),
      }),
      effectTool({
        name: "search_files",
        description:
          "Search the last snapshot by name substring (empty string for none), MIME type substring (empty string for any) and a category: any, junk, never_played, messy_names, large, folders. byMime counts matches per MIME type, the 10 largest types.",
        input: Schema.Struct({
          query: Schema.String,
          mime: Schema.String.annotate({ description: "e.g. 'matroska', 'video/mp4' or ''" }),
          category: Schema.Literals(["any", "junk", "never_played", "messy_names", "large", "folders"]),
          limit: Schema.Finite.annotate({ description: "1 to 100" }),
        }),
        run: ({ query, mime, category, limit }) =>
          once("search_files", { query, mime, category, limit }, Effect.sync(() => {
            const here = snapshotHere();

            if (Result.isFailure(here)) return here.failure;
            let rows = here.success;
            const junkReason = junkFinder(rows);
            const q = query.trim().toLowerCase();

            if (q) rows = rows.filter((f) => f.path.toLowerCase().includes(q));
            const m = mime.trim().toLowerCase();

            if (m && !here.success.some((f) => mimeOf(f) !== null)) return JSON.stringify({ error: "This snapshot has no MIME types. Run scan_library first." });

            if (m) rows = rows.filter((f) => mimeOf(f)?.toLowerCase().includes(m));

            if (category === "junk") rows = rows.filter((f) => junkReason(f));

            if (category === "never_played") rows = rows.filter((f) => f.file_type === "VIDEO" && !f.first_accessed_at);

            if (category === "messy_names") rows = rows.filter((f) => f.file_type === "VIDEO" && isMessyName(f.name));

            if (category === "folders") rows = rows.filter((f) => f.file_type === "FOLDER");

            if (category === "large") rows = rows.filter((f) => f.file_type !== "FOLDER");

            if (category === "large" || category === "never_played") rows.sort((a, b) => b.size - a.size);

            return JSON.stringify({
              total: rows.length,
              bytes: formatSize(rows.reduce((a, f) => a + (f.file_type === "FOLDER" ? 0 : f.size), 0)),
              byMime: byMime(rows),
              items: rows.slice(0, Math.min(100, Math.max(1, Math.floor(limit)))).map((f) => ({
                path: f.path,
                type: f.file_type,
                mime: mimeOf(f),
                size: formatSize(f.size),
                added: f.created_at.slice(0, 10),
                firstPlayed: f.first_accessed_at?.slice(0, 10) ?? null,
                junk: junkReason(f),
              })),
            } satisfies SearchFilesOutput);
          })),
      }),
      effectTool({
        name: "media_info",
        description:
          "Read put.io's media info for files from the snapshot: MIME type, container, duration, bitrate, video, audio and subtitle streams, and playback issues. One put.io request per file; prefer search_files' mime filter for MIME types alone.",
        input: Schema.Struct({ paths: Schema.Array(Schema.String).annotate({ description: "1 to 20 file paths from the snapshot" }) }),
        run: ({ paths }) =>
          once("media_info", paths, Effect.gen(function* () {
            const here = snapshotHere();

            if (Result.isFailure(here)) return here.failure;

            if (!store.token()) return signedOut;

            if (paths.length === 0 || paths.length > 20) return JSON.stringify({ error: "Give 1 to 20 paths." });
            const byPath = new Map(here.success.map((f) => [f.path, f]));
            const clean = [...new Set(paths.map(cleanPath))];
            const missing = clean.filter((p) => !byPath.has(p));

            if (missing.length > 0) return JSON.stringify({ error: `Not in the snapshot: ${missing.slice(0, 5).join(", ")}` });
            const folders = clean.filter((p) => byPath.get(p)?.file_type === "FOLDER");

            if (folders.length > 0) return JSON.stringify({ error: `Folders have no media info: ${folders.slice(0, 5).join(", ")}` });
            const targets = clean.flatMap((p) => byPath.get(p) ?? []);

            const files = yield* Effect.forEach(targets, (f) =>
              mediaInfo(f.id).pipe(
                Effect.map(({ content_type, media_info }) => ({ path: f.path, mime: media_info?.mime_type ?? content_type, info: media_info ? mediaSummary(media_info) : null, error: null })),
                Effect.catchTag(["PutioFailed", "PutioRateLimited"], (e) => Effect.succeed({ path: f.path, mime: mimeOf(f), info: null, error: stepMessage(e) })),
              ),
            );

            return JSON.stringify({ files } satisfies MediaInfoOutput);
          })),
      }),
      effectTool({
        name: "propose_changes",
        description:
          "Propose trash, rename and move changes as one plan. The user sees a diff and decides; nothing changes until they apply it. Paths come from the snapshot.",
        input: ProposeInput,
        run: (input) =>
          Effect.sync(() => {
            const all = snapshotHere();

            if (Result.isFailure(all)) return all.failure;
            const out = validatePlan(all.success, input, newId());

            if ("error" in out) return JSON.stringify(out);
            storePlan(out);

            return JSON.stringify(out.plan);
          }),
      }),
      effectTool({
        name: "plan_layout",
        description:
          "Lay out videos the way Plex, Infuse, Jellyfin and Kodi expect: '<movies>/Title (Year)/Title (Year).mkv' and '<shows>/Show (Year)/Season 01/Show (Year) - S01E02.mkv'. The app works out every move and rename from the snapshot, carries subtitles along, leaves anything it can't name alone, and shows the plan as a diff. At most 200 changes per plan; run it again after an apply for the rest.",
        input: Schema.Struct({
          movies: Schema.String.annotate({ description: "folder for movies, e.g. '/Movies'" }),
          shows: Schema.String.annotate({ description: "folder for TV shows, e.g. '/TV Shows'" }),
          within: Schema.String.annotate({ description: "only videos under this folder, e.g. '/Downloads'; '' for the whole snapshot" }),
        }),
        run: ({ movies, shows, within }) =>
          Effect.gen(function* () {
            const all = snapshotHere();

            if (Result.isFailure(all)) return all.failure;
            const layout = planLayout(all.success, movies, shows, within, yield* Clock.currentTimeMillis);

            if ("error" in layout) return JSON.stringify(layout);

            return proposeGenerated(all.success, "media server layout", layout, "Nothing to move: every video it can name is already laid out.");
          }),
      }),
      effectTool({
        name: "propose_translation",
        description:
          "Propose translating the English subtitles of videos from the snapshot into one language: give videos, or folders to cover every video under them, skipping ones that already have that language; at most 30 videos in all. Each lands beside its video as '<video name>.<language>.srt', which put.io and media servers pick up. The user sees the plan and applies it; nothing is translated until they do. Each film uses a little of their monthly credits.",
        input: Schema.Struct({
          paths: Schema.Array(Schema.String).annotate({ description: "video or folder paths from the snapshot" }),
          language: LanguageCode.annotate({ description: "ISO 639-2 code of the language to translate into, e.g. 'tur'" }),
        }),
        run: ({ paths, language }) =>
          Effect.gen(function* () {
            const all = snapshotHere();

            if (Result.isFailure(all)) return all.failure;
            const out = validateTranslation(all.success, paths, language, `${LANGUAGES[language].toLowerCase()} subtitles`, newId());

            if ("error" in out) return JSON.stringify(out);
            yield* syncPool;
            const spend = spendFor(month(yield* Clock.currentTimeMillis));

            const checks = yield* Effect.forEach(
              out.plan.changes,
              (c) => checkSource(out.ids[c.id] ?? 0, c.path, spend, sources).pipe(Effect.as(null), Effect.catch((e) => Effect.succeed({ path: c.path, why: stepMessage(e) }))),
              { concurrency: SOURCE_CHECKS },
            ).pipe(Effect.provide(Layer.merge(deps.anthropic, putioLayer(store.token() ?? undefined, deps.putioFetch))));

            yield* refreshCredits;
            const cant = checks.filter(Predicate.isNotNull);
            const left = new Set(cant.map((c) => c.path));
            const changes = out.plan.changes.filter((c) => !left.has(c.path));

            if (changes.length === 0) return JSON.stringify({ error: "None of these videos can be translated.", cant_translate: cant });
            storePlan({ ...out, plan: { ...out.plan, changes } });

            return JSON.stringify({ ...out.plan, changes, already_translated: out.skipped, cant_translate: cant });
          }),
      }),
      effectTool({
        name: "find_untranslated",
        description:
          "List folders whose videos have no subtitle file in a language beside them ('<video name>.<language>.srt'), most missing first. Reads the last snapshot; subtitles put.io finds inside the video or online don't count.",
        input: Schema.Struct({
          language: LanguageCode.annotate({ description: "ISO 639-2 code, e.g. 'tur'" }),
          within: Schema.String.annotate({ description: "only under this folder, e.g. '/TV Shows'; '' for the whole snapshot" }),
        }),
        run: ({ language, within }) =>
          Effect.sync(() => {
            const all = snapshotHere();

            if (Result.isFailure(all)) return all.failure;

            return JSON.stringify(untranslated(all.success, language, within));
          }),
      }),
      effectTool({
        name: "plan_subtitles",
        description:
          "Tidy subtitles so put.io, Plex, Infuse, Jellyfin and Kodi show them. put.io lists a .srt only from the video's own folder, and matches by name when that folder holds several videos. Renames each stray .srt to its video's name, moving it out of a Subs folder if needed. Leaves alone videos with several stray subtitles or one already in place. With own_folders, also moves each video that shares a folder with other videos into its own folder named after it, subtitles included, so no episode shows another's subtitle.",
        input: Schema.Struct({
          within: Schema.String.annotate({ description: "only under this folder, e.g. '/Movies'; '' for the whole snapshot" }),
          own_folders: Schema.Boolean.annotate({ description: "true to give each video in a shared folder its own folder, e.g. '/Show/Season 01/Show - S01E02/Show - S01E02.mkv'" }),
        }),
        run: ({ within, own_folders }) =>
          Effect.sync(() => {
            const all = snapshotHere();

            if (Result.isFailure(all)) return all.failure;
            const tidy = planSubtitles(all.success, within, own_folders);

            if ("error" in tidy) return JSON.stringify(tidy);

            return proposeGenerated(all.success, "tidy subtitles", tidy, own_folders ? "Nothing to tidy: no stray subtitles or shared folders." : "No stray subtitles to fix.");
          }),
      }),
      effectTool({
        name: "plan_free_space",
        description:
          "Free up space: trash exact duplicate copies, then junk, biggest first, until the target is met. Returns the plan as a diff, the same titles kept in two versions for the user to choose between, and big never-played files as hints. Also reads put.io's disk use.",
        input: Schema.Struct({ free_gb: Schema.Finite.annotate({ description: "GB the user wants back; 0 for everything safe" }) }),
        run: ({ free_gb }) =>
          Effect.gen(function* () {
            const all = snapshotHere();

            if (Result.isFailure(all)) return all.failure;
            const token = store.token();
            const readDisk = diskUsage.pipe(Effect.timeout("3 seconds"), Effect.option, Effect.map(Option.getOrNull));
            const disk = token ? yield* readDisk.pipe(Effect.provide(putioLayer(token, deps.putioFetch))) : null;
            const target = Math.max(0, free_gb) * 1e9;
            const space = planFreeSpace(all.success, target, state.folder.id === 0 ? "" : state.folder.name);
            let plan: string | null = null;

            if (space.changes.length > 0) {
              const out = validatePlan(all.success, { title: "free up space", changes: space.changes }, newId());

              if ("error" in out) return JSON.stringify(out);
              storePlan(out);
              plan = out.plan.id;
            }

            return JSON.stringify({ plan, freed: space.freed, target, safe: space.safe, left: space.left, disk, choices: space.choices, hints: space.hints } satisfies FreeSpaceOutput);
          }),
      }),
      effectTool({
        name: "make_download_links",
        description:
          "Ask put.io for direct download links to files or folders from the snapshot; a folder gives a link per file inside. The user gets the links in a card. You never see them, so don't write or guess any URL.",
        input: Schema.Struct({ paths: Schema.Array(Schema.String).annotate({ description: "1 to 50 paths from the snapshot" }) }),
        run: ({ paths }) =>
          Effect.gen(function* () {
            const here = snapshotHere();

            if (Result.isFailure(here)) return here.failure;

            if (!store.token()) return signedOut;

            if (paths.length === 0 || paths.length > 50) return JSON.stringify({ error: "Give 1 to 50 paths." });
            const byPath = new Map(here.success.map((f) => [f.path, f.id]));
            const clean = paths.map(cleanPath);
            const missing = clean.filter((p) => !byPath.has(p));

            if (missing.length > 0) return JSON.stringify({ error: `Not in the snapshot: ${missing.slice(0, 5).join(", ")}` });
            const id = yield* createDownloadLinks([...new Set(clean.map((p) => byPath.get(p)!))]);

            for (let i = 0; i < 10; i++) {
              const job = yield* downloadLinks(id);

              if (job.status === "done") return JSON.stringify({ id, files: job.links.length } satisfies DownloadLinksOutput);

              if (job.status === "error") return JSON.stringify({ error: job.message });
              yield* Effect.sleep(deps.linksPollMs ?? 1000);
            }

            return JSON.stringify({ id, files: null } satisfies DownloadLinksOutput);
          }).pipe(Effect.catchTag(["PutioRateLimited", "PutioFailed"], (e) => Effect.succeed(JSON.stringify({ error: stepMessage(e) })))),
      }),
      effectTool({
        name: "draft_feedback",
        description:
          "Draft a bug report or feature request to puterminator's maintainer. The app shows it in a card where the user sends it as is or edits it first. Nothing is sent until they do.",
        input: Schema.Struct({
          kind: Feedback.fields.kind.annotate({ description: "bug: puterminator broke or misbehaved. idea: a feature request or suggestion." }),
          text: Schema.String.annotate({ description: `The write-up, at most ${FEEDBACK_MAX_CHARS} characters. No put.io file names unless the user gave them for the report.` }),
        }),
        run: ({ kind, text }) =>
          Effect.sync(() => {
            const draft = feedbackText(text);

            if (draft === null) return JSON.stringify({ error: `Write 1 to ${FEEDBACK_MAX_CHARS} characters.` });

            return JSON.stringify({ kind, text: draft, next: "Drafted. Stop now; the user reviews and sends it from the card." });
          }),
      }),
      effectTool({
        name: "ask_user",
        description: "Ask the user to pick between 2 to 6 options when you can't decide alone. Then stop; the answer comes as the next message.",
        input: AskInput,
        run: (input) =>
          Effect.sync(() => {
            if (asked) return JSON.stringify({ error: "You already asked this turn. Stop now; the answer arrives as the next message." });
            const q = validateQuestion(input, newId());

            if ("error" in q) return JSON.stringify(q);
            asked = true;

            return JSON.stringify({ ...q, next: "Asked. End your turn now without repeating the question; the answer arrives as the user's next message." });
          }),
      }),
    ];

    const converse = (text: string) =>
      Effect.gen(function* () {
        yield* syncPool;
        const credits = yield* refreshCredits;
        const lastAudit = state.lastAudit;
        const scanAge = lastAudit ? describeAge(scanAgeMs(yield* Clock.currentTimeMillis)) : "";

        const context = [
          `Target folder: ${state.folder.name} (id ${state.folder.id}).`,
          lastAudit
            ? `Last scan: ${scanAge}, ${lastAudit.items} items, score ${lastAudit.score}.`
            : "No scan yet.",
          `Credits left this month: ${creditsLeft(credits)}.`,
          ...planNews(),
        ].join(" ");

        closeDanglingTools();
        append({
          role: "user",
          content: [
            { type: "text", text },
            { type: "text", text: `<context>${context}</context>` },
          ],
        });

        const refusal = poolTotal === null ? POOL_DOWN : credits.blocked ? blockedText(credits.blocked) : null;

        if (refusal !== null) {
          append({ role: "assistant", content: [{ type: "text", text: refusal }] });

          return;
        }

        setState({ ...state, busy: true });
        const m = credits.month;

        const events = runTurn({
          model: deps.model,
          system: SYSTEM,
          messages: store.history().map(toAnthropic),
          tools,
          partialEveryMs: deps.partialEveryMs ?? 60,
          onUsage: (tokens) => charge(m, tokens),
          canContinue: () => !asked && poolTotal !== null && blockedAt(Date.now()) === null,
        });

        yield* Stream.runForEach(events, (event) =>
          Effect.gen(function* () {
            switch (event.type) {
              case "partial":
                streamed = event.content;
                broadcast({ type: "partial", content: toBlocks(event.content) });

                return;
              case "assistant": {
                streamed = [];
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
            if (Predicate.isTagged(e, "PutioUnauthorized")) store.deleteToken();
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
            keepStreamedText();
            turnFiber = null;
            running = false;
            broadcast({ type: "partial", content: null });

            if (state.busy) setState({ ...state, busy: false });
          }).pipe(Effect.andThen(refreshCredits)),
        ),
      );

    const start = (text: string, folder: Folder) => {
      running = true;
      asked = false;
      calls.clear();

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
      connected: () => deps.background(refreshStaleSnapshot),
      greeting: (): Array<ServerEvent> => {
        const lib = library();

        return [
          { type: "state", state },
          { type: "history", messages: store.history() },
          ...(lib ? [{ type: "library" as const, library: lib }] : []),
          ...[...plans.values()].map((p) => ({ type: "plan" as const, record: p.record })),
        ];
      },
      receive: (raw: string) =>
        Effect.gen(function* () {
          const event = decodeFrame(raw);

          if (Option.isNone(event)) return;
          const e = event.value;

          switch (e.type) {
            case "stop":
              if (turnFiber) yield* Fiber.interrupt(turnFiber);

              return;
            case "apply":
              if (!running && !state.busy) apply(e.plan, e.exclude);

              return;
            case "retry":
              if (!running && !state.busy) retry(e.plan);

              return;
            case "undo":
              if (!running && !state.busy) undo(e.plan);

              return;
            case "discard":
              discard(e.plan);

              return;
            case "newThread":
              if (running || state.busy || runFibers.size > 0) return;
              store.archiveHistory();
              last = null;

              for (const p of plans.values()) if (!p.reported) saveRecord({ ...p, reported: true });
              broadcast({ type: "history", messages: [] });

              return;
            case "stopRun": {
              const f = runFibers.get(e.plan);

              if (f) yield* Fiber.interrupt(f);

              return;
            }

            case "send":
              if (running || state.busy) return;
              start(e.text, e.folder);

              return;
          }
        }),
      setAuth: (token: string, username: string, avatarUrl: string | null) =>
        Effect.sync(() => {
          store.deleteToken();
          streamToken = null;
          store.setToken(token);
          setState({ ...state, username, avatarUrl });

          return sessionGen();
        }),
      signOut: Effect.sync(() => {
        store.deleteToken();
        store.setSecret("session_gen", String(sessionGen() + 1));
        deps.disconnect();
      }),
      deleteData: Effect.gen(function* () {
        if (running || state.busy || runFibers.size > 0) return false;
        epoch++;
        store.deleteUserData(month(yield* Clock.currentTimeMillis));
        store.setSecret("session_gen", String(sessionGen() + 1));
        plans.clear();
        thumbs.clear();
        last = null;
        state = { ...initialAgentState(state.credits.month), credits: state.credits };
        deps.disconnect();

        return true;
      }),
      sessionGen: Effect.sync(() => sessionGen()),
      thumbnail: (id: number) =>
        Effect.suspend(() => {
          const token = store.token();

          if (!token) return Effect.succeed<string | null>(null);
          const hit = thumbs.get(id);

          if (hit !== undefined) return Effect.succeed(hit);
          const started = epoch;

          return fileMedia(id).pipe(
            Effect.map((f) => f.screenshot),
            Effect.tap((url) => Effect.sync(() => started === epoch && remember(id, url))),
            Effect.catch(() => Effect.succeed<string | null>(null)),
            Effect.provide(putioLayer(token, deps.putioFetch)),
          );
        }),
      downloadLinks: (id: number) =>
        Effect.suspend(() => {
          const token = store.token();

          if (!token) return Effect.succeed<DownloadLinksResponse | null>(null);

          return downloadLinks(id).pipe(
            Effect.catch(() => Effect.succeed<DownloadLinksResponse | null>(null)),
            Effect.provide(putioLayer(token, deps.putioFetch)),
          );
        }),
      stream: (id: number) =>
        Effect.suspend(() => {
          const token = store.token();
          const isVideo = store.snapshot().some((f) => f.id === id && f.file_type === "VIDEO");

          if (!token || !isVideo) return Effect.succeed<string | null>(null);

          const fetched = downloadToken.pipe(
            Effect.tap((t) =>
              Effect.sync(() => {
                if (store.token() === token) streamToken = t;
              }),
            ),
          );

          return (streamToken ? Effect.succeed(streamToken) : fetched).pipe(
            Effect.map((t): string | null => hlsUrl(id, t, deps.putioBase)),
            Effect.catch(() => Effect.succeed<string | null>(null)),
            Effect.provide(putioLayer(token, deps.putioFetch)),
          );
        }),
    };
  });

