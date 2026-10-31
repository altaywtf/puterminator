import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { PutioSdkContext } from "@putdotio/sdk";
import type { Change, Plan, Question, Run } from "../shared/actions";
import { createFolder, moveFile, type PutioError, PutioFailed, renameFile, restoreFile, stepMessage, trashFile } from "./putio";
import type { WalkedFile } from "./tree";

// What the model may propose and ask, checked against the snapshot before anything is shown,
// and how one approved change becomes put.io calls.

export const MAX_CHANGES = 200;

export const ProposeInput = Schema.Struct({
  title: Schema.String.annotate({ description: "short, lowercase, e.g. 'clean up Downloads'" }),
  changes: Schema.Array(
    Schema.Struct({
      op: Schema.Literals(["trash", "rename", "move"]),
      path: Schema.String.annotate({ description: "the file or folder, as scan and search return it, e.g. '/Downloads/x.nfo'" }),
      to: Schema.NullOr(Schema.String).annotate({ description: "trash: null. rename: the new name. move: the new full path, e.g. '/Movies/Heat (1995)'" }),
    }),
  ),
});
export type ProposeInput = typeof ProposeInput.Type;

export const AskInput = Schema.Struct({
  prompt: Schema.String,
  multi: Schema.Boolean.annotate({ description: "true when several answers can apply" }),
  options: Schema.Array(Schema.Struct({ label: Schema.String, detail: Schema.NullOr(Schema.String) })),
});
export type AskInput = typeof AskInput.Type;

/** A plan as the server keeps it: what the card shows, the put.io ids it acts on, and each file's folder id
    when it was proposed, so undo can put it back. */
export type StoredPlan = { plan: Plan; ids: Record<string, number>; parents: Record<string, number> };

const clean = (path: string) => `/${path.trim().replace(/^\/+|\/+$/g, "")}`;
const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
export const parentOf = (path: string) => path.slice(0, path.lastIndexOf("/")) || "/";
const badName = (name: string) => name.trim() === "" || name.includes("/") || name.length > 255 || name === "." || name === "..";

/** Every change must name a file in the snapshot, once, and say something valid about it. Errors go back to the model. */
export const validatePlan = (snapshot: ReadonlyArray<WalkedFile>, input: ProposeInput, id: string): StoredPlan | { error: string } => {
  if (input.changes.length === 0) return { error: "A plan needs at least one change." };
  if (input.changes.length > MAX_CHANGES) return { error: `At most ${MAX_CHANGES} changes per plan; split it.` };
  const byPath = new Map(snapshot.map((f) => [f.path, f]));
  const seen = new Set<number>();
  const changes: Change[] = [];
  const ids: Record<string, number> = {};
  const parents: Record<string, number> = {};
  const problems: string[] = [];
  input.changes.forEach((c, i) => {
    const path = clean(c.path);
    const f = byPath.get(path);
    if (!f) return void problems.push(`${path}: not in the snapshot`);
    if (seen.has(f.id)) return void problems.push(`${path}: appears twice`);
    seen.add(f.id);
    let to: string | null = null;
    if (c.op === "trash") to = null;
    else if (c.op === "rename") {
      const name = (c.to ?? "").trim();
      if (badName(name)) return void problems.push(`${path}: rename needs a plain new name`);
      if (name === f.name) return void problems.push(`${path}: already named that`);
      if (byPath.has(`${parentOf(path).replace(/\/$/, "")}/${name}`)) return void problems.push(`${path}: ${name} already exists there`);
      to = name;
    } else {
      if (!c.to) return void problems.push(`${path}: move needs the new full path`);
      const target = clean(c.to);
      if (target === path) return void problems.push(`${path}: already there`);
      if (target.startsWith(`${path}/`)) return void problems.push(`${path}: can't move a folder into itself`);
      if (target.split("/").slice(1).some(badName)) return void problems.push(`${path}: bad target path`);
      if (byPath.has(target)) return void problems.push(`${target}: already exists`);
      to = target;
    }
    const changeId = `c${i + 1}`;
    ids[changeId] = f.id;
    if (f.parent_id != null) parents[changeId] = f.parent_id;
    changes.push({ id: changeId, op: c.op, path, to, bytes: c.op === "trash" ? f.size : 0 });
  });
  problems.push(...conflicts(changes));
  if (problems.length > 0) return { error: `Fix these and propose again: ${problems.slice(0, 10).join("; ")}` };
  const withSubtitles = changes.flatMap((c) => [c, ...subtitlesFor(snapshot, byPath, c, seen, ids, parents)]);
  return { plan: { id, title: input.title.trim().slice(0, 80) || "changes", changes: withSubtitles }, ids, parents };
};

const finalPath = (c: Change) => (c.op === "rename" ? `${parentOf(c.path).replace(/\/$/, "")}/${c.to}` : (c.to ?? c.path));
const within = (path: string, folder: string) => path === folder || path.startsWith(`${folder}/`);

/** Changes that undo each other: touching or landing in something the plan trashes, or two ending at one path. */
const conflicts = (changes: ReadonlyArray<Change>): string[] => {
  const trashed = changes.filter((c) => c.op === "trash").map((c) => c.path);
  const problems: string[] = [];
  const ends = new Set<string>();
  for (const c of changes) {
    const inside = trashed.find((t) => t !== c.path && within(c.path, t));
    if (inside) problems.push(`${c.path}: inside ${inside}, which this plan trashes`);
    if (c.op === "trash") continue;
    const end = finalPath(c);
    const lands = trashed.find((t) => within(end, t));
    if (lands) problems.push(`${end}: lands in ${lands}, which this plan trashes`);
    if (ends.has(end)) problems.push(`${end}: two changes end there`);
    ends.add(end);
  }
  return problems;
};

const SUBTITLE = /^((?:[._ -][a-z]{2,8})*\.(?:srt|sub|idx|ass|ssa|vtt))$/i;
const stemOf = (name: string) => name.replace(/\.[a-z0-9]{2,4}$/i, "");

/** A renamed or moved video takes its subtitles along: files beside it named after it, like `Heat.eng.srt`. */
const subtitlesFor = (
  snapshot: ReadonlyArray<WalkedFile>,
  byPath: Map<string, WalkedFile>,
  c: Change,
  seen: Set<number>,
  ids: Record<string, number>,
  parents: Record<string, number>,
): Change[] => {
  const video = byPath.get(c.path);
  if (!video || video.file_type !== "VIDEO" || c.op === "trash" || !c.to) return [];
  const stem = stemOf(video.name);
  const longer = snapshot
    .filter((f) => f.parent_id === video.parent_id && f.file_type === "VIDEO" && f.id !== video.id)
    .map((f) => stemOf(f.name))
    .filter((s) => s.length > stem.length && s.startsWith(stem));
  const target = c.op === "rename" ? `${parentOf(c.path).replace(/\/$/, "")}/${c.to}` : c.to;
  const newStem = stemOf(nameOf(target));
  const folder = parentOf(target).replace(/\/$/, "");
  return snapshot
    .filter((f) => f.parent_id === video.parent_id && f.id !== video.id && !seen.has(f.id) && f.name.startsWith(stem) && SUBTITLE.test(f.name.slice(stem.length)) && !longer.some((s) => f.name.startsWith(s)))
    .flatMap((f, k) => {
      const name = newStem + f.name.slice(stem.length);
      if (byPath.has(`${folder}/${name}`)) return [];
      seen.add(f.id);
      const id = `${c.id}s${k + 1}`;
      ids[id] = f.id;
      if (f.parent_id != null) parents[id] = f.parent_id;
      return [{ id, op: c.op, path: f.path, to: c.op === "rename" ? name : `${folder}/${name}`, bytes: 0 }];
    });
};

export const validateQuestion = (input: AskInput, id: string): Question | { error: string } => {
  if (!input.prompt.trim()) return { error: "The question is empty." };
  if (input.options.length < 2 || input.options.length > 6) return { error: "Give 2 to 6 options." };
  return {
    id,
    prompt: input.prompt.trim(),
    multi: input.multi,
    options: input.options.map((o, i) => ({ id: `o${i + 1}`, label: o.label.trim(), detail: o.detail?.trim() || null })),
  };
};

/** The reverse of every step that may have reached put.io, last first. Each keeps its change id, so it acts on the same file. */
export const undoChanges = (run: Run): Change[] => {
  const done = new Set(run.steps.filter((s) => s.state === "done" || (s.state === "failed" && s.maybeApplied)).map((s) => s.change));
  return run.changes
    .filter((c) => done.has(c.id))
    .reverse()
    .map((c): Change => {
      if (c.op === "trash") return { ...c, op: "restore", to: null };
      if (c.op === "rename") return { ...c, path: `${parentOf(c.path).replace(/\/$/, "")}/${c.to ?? ""}`, to: nameOf(c.path), bytes: 0 };
      if (c.op === "move") return { ...c, path: c.to ?? c.path, to: c.path, bytes: 0 };
      return c;
    });
};

/** Folder ids by path for one run: the snapshot's folders, then `known` (undo's original folders), plus any the run creates. */
export const folderIds = (snapshot: ReadonlyArray<WalkedFile>, rootId: number, known: ReadonlyArray<[string, number]> = []) => {
  const ids = new Map<string, number>([["/", rootId]]);
  for (const f of snapshot) if (f.file_type === "FOLDER") ids.set(f.path, f.id);
  for (const [path, id] of known) ids.set(path, id);
  return ids;
};

/** A folder renamed or moved takes everything under it along. */
const repath = (folders: Map<string, number>, from: string, to: string) => {
  for (const [path, id] of [...folders]) {
    if (path !== from && !path.startsWith(`${from}/`)) continue;
    folders.delete(path);
    folders.set(to + path.slice(from.length), id);
  }
};

/** The folder at `path`, creating any missing ones on the way down. */
const ensureFolder = (folders: Map<string, number>, path: string): Effect.Effect<number, PutioError, PutioSdkContext> =>
  Effect.suspend(() => {
    const known = folders.get(path);
    if (known !== undefined) return Effect.succeed(known);
    return ensureFolder(folders, parentOf(path)).pipe(
      Effect.flatMap((parent) => createFolder(nameOf(path), parent)),
      Effect.tap((id) => Effect.sync(() => folders.set(path, id))),
    );
  });

/** One approved change as put.io calls. A move that also changes the name renames after moving. */
export const applyChange = (change: Change, fileId: number, folders: Map<string, number>): Effect.Effect<void, PutioError, PutioSdkContext> => {
  if (change.op === "trash") return trashFile(fileId).pipe(Effect.asVoid);
  if (change.op === "restore") return restoreFile(fileId).pipe(Effect.asVoid);
  if (change.op === "rename")
    return renameFile(fileId, change.to ?? "").pipe(
      Effect.tap(() => Effect.sync(() => repath(folders, change.path, `${parentOf(change.path).replace(/\/$/, "")}/${change.to ?? ""}`))),
      Effect.asVoid,
    );
  const to = change.to ?? "";
  return Effect.gen(function* () {
    const parent = yield* ensureFolder(folders, parentOf(to));
    yield* moveFile(fileId, parent);
    if (nameOf(to) !== nameOf(change.path))
      yield* renameFile(fileId, nameOf(to)).pipe(Effect.mapError((e) => new PutioFailed({ message: `moved, but the rename failed: ${stepMessage(e)}` })));
    repath(folders, change.path, to);
  });
};
