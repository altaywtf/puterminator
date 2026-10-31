import type { WalkedFile } from "./tree";

const RELEASE_TAG =
  /\b(2160p|1080p|720p|480p|x26[45]|h\.?26[45]|hevc|web-?dl|webrip|bluray|brrip|bdrip|hdtv|dvdrip|hdrip|aac|ac3|ddp?5\.1|10bit|yify|yts|rarbg|eztv|ettv|proper|repack)\b/i;
const BRACKET_GROUP = /\[[^\]]{2,}\]/;
const GROUP_SUFFIX = /-[A-Za-z0-9]{2,12}$/;
const JUNK_NAME = /(^|[\s._-])(sample|rarbg|www\.|torrent downloaded from)|RARBG_DO_NOT_MIRROR|^Thumbs\.db$/i;
const OS_DEBRIS = /^\._|^\.DS_Store$|^desktop\.ini$/i;
const JUNK_EXT = new Set(["nfo", "txt", "url", "exe", "lnk", "sfv", "md5", "torrent", "website", "db"]);
const IMAGE_EXT = new Set(["jpg", "jpeg", "png", "gif", "webp"]);
const MB = 2 ** 20;

export type Finding = { path: string; size: number; why: string };

export type Audit = {
  at: string;
  rootName: string;
  truncated: boolean;
  totals: { items: number; files: number; folders: number; videos: number; bytes: number };
  score: number;
  scores: { naming: number; structure: number; junk: number; duplicates: number };
  naming: { messy: number; examples: string[] };
  structure: { rootFiles: number; wrapperFolders: number; emptyFolders: number; deepest: number; examples: string[] };
  junk: { count: number; bytes: number; examples: Finding[] };
  duplicates: { groups: number; wastedBytes: number; examples: { keep: string; drop: string[]; size: number }[] };
  neverPlayed: { count: number; bytes: number; examples: Finding[] };
};

const ext = (f: WalkedFile) => (f.extension ?? f.name.split(".").pop() ?? "").toLowerCase();
const isVideo = (f: WalkedFile) => f.file_type === "VIDEO";
const isFolder = (f: WalkedFile) => f.file_type === "FOLDER";

export function isMessyName(name: string) {
  const stem = name.replace(/\.[a-z0-9]{2,4}$/i, "");
  const dotted = (stem.match(/\./g) ?? []).length >= 3 && !stem.includes(" ");
  return RELEASE_TAG.test(stem) || dotted || BRACKET_GROUP.test(stem) || (GROUP_SUFFIX.test(stem) && !stem.includes(" "));
}

/** Junk by name, plus small images that sit beside a video (posters, tracker logos). Images elsewhere are content. */
export function junkFinder(files: ReadonlyArray<WalkedFile>) {
  const withVideo = new Set(files.flatMap((f) => (isVideo(f) && f.parent_id != null ? [f.parent_id] : [])));
  return (f: WalkedFile): string | null => {
    if (isFolder(f)) return null;
    if (OS_DEBRIS.test(f.name) || f.path.includes("/__MACOSX/")) return "macOS debris";
    if (JUNK_NAME.test(f.name)) return /sample/i.test(f.name) ? "sample clip" : "tracker filler";
    const e = ext(f);
    if (JUNK_EXT.has(e)) return `.${e} file`;
    if (IMAGE_EXT.has(e) && f.size < 2 * MB && f.parent_id != null && withVideo.has(f.parent_id)) return "cover or logo image";
    if (isVideo(f) && f.size < 50 * MB && /sample|trailer/i.test(f.path)) return "sample clip";
    return null;
  };
}

/** Normalised identity for duplicate detection: title + episode or year, no release noise. */
export function mediaKey(name: string) {
  const stem = name.replace(/\.[a-z0-9]{2,4}$/i, "").toLowerCase();
  const ep = stem.match(/s(\d{1,2})e(\d{1,3})/i);
  const cut = stem.search(/s\d{1,2}e\d{1,3}|\b(19|20)\d{2}\b|2160p|1080p|720p|480p/i);
  const title = (cut > 0 ? stem.slice(0, cut) : stem).replace(/[^a-z0-9]+/g, " ").trim();
  if (!title) return null;
  if (ep) return `${title}|s${Number(ep[1])}e${Number(ep[2])}`;
  const year = stem.match(/\b(19|20)\d{2}\b/);
  return year ? `${title}|${year[0]}` : null;
}

const pct = (good: number, total: number) => (total === 0 ? 100 : Math.round((100 * good) / total));

export function audit(files: WalkedFile[], rootName: string, truncated: boolean, now = new Date()): Audit {
  const videos = files.filter(isVideo);
  const folders = files.filter(isFolder);
  const bytes = files.filter((f) => !isFolder(f)).reduce((a, f) => a + f.size, 0);

  const messy = videos.filter((f) => isMessyName(f.name));

  const childCount = new Map<number, number>();
  const childVideos = new Map<number, number>();
  for (const f of files) {
    if (f.parent_id == null) continue;
    childCount.set(f.parent_id, (childCount.get(f.parent_id) ?? 0) + 1);
    if (isVideo(f)) childVideos.set(f.parent_id, (childVideos.get(f.parent_id) ?? 0) + 1);
  }
  const emptyFolders = folders.filter((f) => !childCount.get(f.id));
  // A wrapper is a torrent-style folder holding a single video plus filler.
  const wrappers = folders.filter((f) => childVideos.get(f.id) === 1 && isMessyName(f.name));
  const rootFiles = files.filter((f) => f.depth === 1 && !isFolder(f));
  const deepest = files.reduce((a, f) => Math.max(a, f.depth), 0);

  const junkReason = junkFinder(files);
  const junk = files
    .map((f) => ({ f, why: junkReason(f) }))
    .filter((x): x is { f: WalkedFile; why: string } => x.why !== null);
  const junkBytes = junk.reduce((a, x) => a + x.f.size, 0);

  const byKey = new Map<string, WalkedFile[]>();
  for (const v of videos) {
    const k = (v.crc32 && `crc:${v.crc32}:${v.size}`) || mediaKey(v.name);
    if (!k) continue;
    byKey.set(k, [...(byKey.get(k) ?? []), v]);
  }
  const dupGroups = [...byKey.values()]
    .filter((g) => g.length > 1)
    .map((g) => [...g].sort((a, b) => b.size - a.size));
  const dupFiles = dupGroups.reduce((a, g) => a + g.length - 1, 0);
  const wasted = dupGroups.reduce((a, g) => a + g.slice(1).reduce((s, f) => s + f.size, 0), 0);

  const never = videos.filter((f) => !f.first_accessed_at).sort((a, b) => b.size - a.size);

  const scores = {
    naming: pct(videos.length - messy.length, videos.length),
    structure: pct(
      Math.max(0, files.length - rootFiles.length - wrappers.length * 3 - emptyFolders.length * 2),
      files.length,
    ),
    junk: pct(files.length - junk.length * 4, files.length),
    duplicates: pct(videos.length - dupFiles * 5, videos.length),
  };
  const clamp = (n: number) => Math.max(0, Math.min(100, n));
  for (const k of Object.keys(scores) as (keyof typeof scores)[]) scores[k] = clamp(scores[k]);
  const score = Math.round(scores.naming * 0.4 + scores.structure * 0.25 + scores.junk * 0.2 + scores.duplicates * 0.15);

  return {
    at: now.toISOString(),
    rootName,
    truncated,
    totals: { items: files.length, files: files.length - folders.length, folders: folders.length, videos: videos.length, bytes },
    score,
    scores,
    naming: { messy: messy.length, examples: messy.slice(0, 8).map((f) => f.path) },
    structure: {
      rootFiles: rootFiles.length,
      wrapperFolders: wrappers.length,
      emptyFolders: emptyFolders.length,
      deepest,
      examples: [...wrappers, ...emptyFolders].slice(0, 8).map((f) => f.path),
    },
    junk: {
      count: junk.length,
      bytes: junkBytes,
      examples: junk.slice(0, 10).map(({ f, why }) => ({ path: f.path, size: f.size, why })),
    },
    duplicates: {
      groups: dupGroups.length,
      wastedBytes: wasted,
      examples: dupGroups.slice(0, 8).map((g) => ({ keep: g[0]!.path, drop: g.slice(1).map((f) => f.path), size: g[0]!.size })),
    },
    neverPlayed: {
      count: never.length,
      bytes: never.reduce((a, f) => a + f.size, 0),
      examples: never.slice(0, 10).map((f) => ({ path: f.path, size: f.size, why: `added ${f.created_at.slice(0, 10)}` })),
    },
  };
}
