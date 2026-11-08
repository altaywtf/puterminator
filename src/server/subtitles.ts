import { junkFinder, stemOf } from "./audit";
import { joinPath, MAX_CHANGES, nameOf, parentOf, type ProposeInput, sidecarsOf } from "./changes";
import { isExtraVideo, resolveScope } from "./layout";
import type { WalkedFile } from "./tree";

const SUBS_DIR = /^(subs?|subtitles?)$/i;
const MAX_NAME = 255;

type Proposed = ProposeInput["changes"][number];

type SubtitleTidy = {
  changes: Proposed[];
  skipped: { path: string; why: string }[];
  remaining: number;
};

const isSrt = (f: WalkedFile) => f.file_type !== "FOLDER" && /\.srt$/i.test(f.name);

export function planSubtitles(snapshot: ReadonlyArray<WalkedFile>, within: string, ownFolders: boolean): SubtitleTidy | { error: string } {
  const resolved = resolveScope(snapshot, within);

  if ("error" in resolved) return resolved;
  const { scope } = resolved;
  const inScope = (f: WalkedFile) => !scope || f.path.startsWith(`${scope}/`);
  const junkReason = junkFinder(snapshot);
  const byId = new Map(snapshot.map((f) => [f.id, f]));
  const takenPaths = new Set(snapshot.map((f) => f.path.toLowerCase()));
  const videosIn = new Map<number | null, WalkedFile[]>();

  for (const f of snapshot)
    if (f.file_type === "VIDEO" && !junkReason(f) && !isExtraVideo(f)) videosIn.set(f.parent_id, [...(videosIn.get(f.parent_id) ?? []), f]);
  const claimed = new Set([...videosIn.values()].flat().flatMap((v) => sidecarsOf(snapshot, v).map((s) => s.id)));

  const onlyVideoIn = (folderId: number | null) => {
    const here = videosIn.get(folderId) ?? [];

    return here.length === 1 ? here[0] : undefined;
  };

  const changes: Proposed[] = [];
  const skipped: SubtitleTidy["skipped"] = [];
  let remaining = 0;

  const push = (change: Proposed) => {
    if (changes.length >= MAX_CHANGES) remaining++;
    else changes.push(change);
  };

  if (ownFolders)
    for (const video of [...videosIn.values()].filter((vs) => vs.length > 1).flat().filter(inScope)) {
      const folder = joinPath(parentOf(video.path), stemOf(video.name));

      if (takenPaths.has(folder.toLowerCase())) {
        skipped.push({ path: video.path, why: `${nameOf(folder)} already exists there` });
        continue;
      }

      takenPaths.add(folder.toLowerCase());
      push({ op: "move", path: video.path, to: joinPath(folder, video.name) });
    }

  const owners = new Map<number, WalkedFile[]>();

  for (const s of snapshot.filter((f) => isSrt(f) && inScope(f) && !claimed.has(f.id))) {
    const parent = s.parent_id === null ? undefined : byId.get(s.parent_id);
    const video = onlyVideoIn(s.parent_id) ?? (parent && SUBS_DIR.test(parent.name) ? onlyVideoIn(parent.parent_id) : undefined);

    if (!video) {
      skipped.push({ path: s.path, why: "no single video it belongs to" });
      continue;
    }

    owners.set(video.id, [...(owners.get(video.id) ?? []), s]);
  }

  for (const [videoId, subs] of owners) {
    const video = byId.get(videoId);
    const [s] = subs;

    if (!video || !s) continue;
    const name = `${stemOf(video.name)}.srt`;
    const target = joinPath(parentOf(video.path), name);

    if (subs.length > 1) {
      for (const sub of subs) skipped.push({ path: sub.path, why: `one of ${subs.length} subtitles for ${video.name}` });
      continue;
    }

    if (takenPaths.has(target.toLowerCase())) {
      skipped.push({ path: s.path, why: `${video.name} already has a subtitle` });
      continue;
    }

    if (name.length > MAX_NAME) {
      skipped.push({ path: s.path, why: `${video.name} is too long a name to copy` });
      continue;
    }

    push(parentOf(s.path) === parentOf(target) ? { op: "rename", path: s.path, to: name } : { op: "move", path: s.path, to: target });
  }

  return { changes, skipped, remaining };
}
