import { duplicateGroups, isMessyName, junkFinder } from "./audit";
import { MAX_CHANGES, type ProposeInput } from "./changes";
import type { WalkedFile } from "./tree";

const MAX_CHOICES = 10;
const MAX_HINTS = 10;

export type FreeSpace = {
  changes: ProposeInput["changes"];
  freed: number;
  safe: number;
  left: number;
  choices: { title: string; options: { path: string; size: number }[] }[];
  hints: { path: string; size: number; why: string }[];
};

const bySize = (a: WalkedFile, b: WalkedFile) => b.size - a.size;

const contentOf = (f: WalkedFile) => (f.crc32 ? `${f.crc32}:${f.size}` : `id:${f.id}`);

const titleOf = (versions: ReadonlyArray<WalkedFile>) => {
  const name = (versions.find((f) => !isMessyName(f.name)) ?? versions[0])?.name ?? "";

  return name.replace(/\.[^.]+$/, "");
};

export function planFreeSpace(snapshot: ReadonlyArray<WalkedFile>, target: number, rootShow = ""): FreeSpace {
  const videos = snapshot.filter((f) => f.file_type === "VIDEO");
  const junkReason = junkFinder(snapshot);
  const isJunk = (f: WalkedFile) => junkReason(f) !== null;
  const copies: WalkedFile[] = [];
  const versionGroups: WalkedFile[][] = [];

  for (const group of duplicateGroups(videos, rootShow)) {
    const byContent = new Map<string, WalkedFile[]>();

    for (const f of group.filter((v) => !isJunk(v))) byContent.set(contentOf(f), [...(byContent.get(contentOf(f)) ?? []), f]);

    const versions = [...byContent.values()].flatMap(([keep, ...rest]) => {
      if (!keep) return [];
      copies.push(...rest);

      return [keep];
    });

    if (versions.length > 1) versionGroups.push(versions);
  }

  const junk = snapshot.filter(isJunk);
  const candidates = [...new Map([...copies.sort(bySize), ...junk.sort(bySize)].map((f) => [f.id, f])).values()];
  const picked: WalkedFile[] = [];
  let freed = 0;

  for (const f of candidates) {
    if (picked.length >= MAX_CHANGES || (target > 0 && freed >= target)) break;
    picked.push(f);
    freed += f.size;
  }

  const waste = (g: ReadonlyArray<WalkedFile>) => g.slice(1).reduce((s, f) => s + f.size, 0);

  const choices = versionGroups
    .sort((a, b) => waste(b) - waste(a))
    .slice(0, MAX_CHOICES)
    .map((g) => ({ title: titleOf(g), options: g.map((f) => ({ path: f.path, size: f.size })) }));

  const skip = new Set([...candidates.map((f) => f.id), ...versionGroups.flat().map((f) => f.id)]);

  const hints = videos
    .filter((f) => !f.first_accessed_at && !skip.has(f.id))
    .sort(bySize)
    .slice(0, MAX_HINTS)
    .map((f) => ({ path: f.path, size: f.size, why: `never played, added ${f.created_at.slice(0, 10)}` }));

  return {
    changes: picked.map((f) => ({ op: "trash" as const, path: f.path, to: null })),
    freed,
    safe: candidates.reduce((a, f) => a + f.size, 0),
    left: candidates.length - picked.length,
    choices,
    hints,
  };
}
