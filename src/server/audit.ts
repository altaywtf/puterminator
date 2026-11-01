import type { WalkedFile } from "./tree";

const RELEASE_TAG =
  /\b(2160p|1080p|720p|480p|x26[45]|h\.?26[45]|hevc|web-?dl|webrip|bluray|brrip|bdrip|hdtv|dvdrip|hdrip|aac|ac3|ddp?5\.1|10bit|yify|yts|rarbg|eztv|ettv)\b/i;
const SCENE_FLAG = /\b(PROPER|REPACK)\b/;
/** Jellyfin and Plex ask for these, so they are clean: `Movie (2010) - 1080p`, `[imdbid-tt1234567]`. */
const ID_TAG = /\s*\[(imdb|tmdb|tvdb)id-[^\]]+\]|\s*\{(imdb|tmdb|tvdb)-[^}]+\}/gi;
const RESOLUTION_SUFFIX = /\s+-\s+(2160p|1080p|720p|480p)$/i;
const BRACKET_GROUP = /\[[^\]]{2,}\]/;
/** `[HorribleSubs]`, `[1080p]`: one token. `[Lecture 01]` or `[Final Cut]` is a label, not release noise. */
const BRACKET_TAG = /\[[^\]\s]{2,}\]/;
const GROUP_SUFFIX = /-[A-Za-z0-9]{2,12}$/;
const JUNK_NAME = /(^|[\s._-])(rarbg|www\.|torrent downloaded from)|RARBG_DO_NOT_MIRROR|^Thumbs\.db$/i;
const SAMPLE = /^sample$|[._-]sample$|^sample[._-]/i;
const VIDEO_AD = /^(rarbg|www\.)|torrent downloaded from|RARBG_DO_NOT_MIRROR/i;
const OS_DEBRIS = /^\._|^\.DS_Store$|^desktop\.ini$|^Icon\r?$|^_+padding_file/i;
const DEBRIS_DIR = /\/(__MACOSX|\.Spotlight-V100|\.fseventsd|\.Trashes|\.pad)\//i;
const ARTWORK = /^(cover|poster|folder|fanart|banner|logo|thumb|backdrop|clearart|clearlogo|disc|landscape|screens?)\d*$|-(poster|fanart|thumb|banner|landscape|clearart|clearlogo|disc|logo)$|www\.|torrent/i;
const SUBTITLE_EXT = new Set(["srt", "sub", "idx", "ass", "ssa", "vtt"]);
const RELEASE_EXTRA_DIR = /^(samples?|subs|subtitles)$/i;
const JUNK_EXT = new Set(["nfo", "url", "lnk", "sfv", "md5", "par2", "torrent", "website"]);
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

const stemOf = (name: string) => name.replace(/\.[a-z0-9]{2,4}$/i, "");

export function isMessyName(name: string, folder = false) {
  const stem = (folder ? name : stemOf(name)).replace(ID_TAG, "").replace(RESOLUTION_SUFFIX, "");
  const spaced = stem.replace(/_/g, " ");
  const dotted = (stem.match(/\./g) ?? []).length >= 3 && !stem.includes(" ");
  const group = stem.match(GROUP_SUFFIX)?.[0].slice(1) ?? "";
  const prefix = stem.slice(0, stem.length - group.length - 1);
  const tagged = group !== "" && !stem.includes(" ") && (stem.includes(".") || (group === group.toUpperCase() && /\d/.test(prefix)));
  return RELEASE_TAG.test(spaced) || SCENE_FLAG.test(spaced) || dotted || BRACKET_TAG.test(stem) || tagged;
}

/** Junk by name, plus small images that sit beside a video (posters, tracker logos). Images elsewhere are content. */
export function junkFinder(files: ReadonlyArray<WalkedFile>) {
  const withVideo = new Set(files.flatMap((f) => (isVideo(f) && f.parent_id != null ? [f.parent_id] : [])));
  return (f: WalkedFile): string | null => {
    if (isFolder(f)) return null;
    if (OS_DEBRIS.test(f.name) || DEBRIS_DIR.test(f.path)) return "system debris";
    if (isVideo(f)) {
      if (f.size >= 50 * MB) return null;
      if (SAMPLE.test(stemOf(f.name)) || /\/sample\//i.test(f.path)) return "sample clip";
      return VIDEO_AD.test(f.name) ? "tracker filler" : null;
    }
    if (JUNK_NAME.test(f.name) && f.size < 2 * MB) return "tracker filler";
    const e = ext(f);
    if (JUNK_EXT.has(e)) return `.${e} file`;
    if (IMAGE_EXT.has(e) && f.size < 2 * MB && f.parent_id != null && withVideo.has(f.parent_id) && ARTWORK.test(stemOf(f.name))) return "cover or logo image";
    return null;
  };
}

const NOISE = new RegExp(`${RELEASE_TAG.source}|\\b(web|remux|hdr|dts|atmos|truehd)\\b`, "gi");
const words = (s: string) => s.replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const PART = /\b(?:part|pt|cd|disc|disk)[\s._-]*(\d{1,2})\b/i;
const EDITION = /\{edition-([^}]+)\}|\b(director'?s cut|final cut|extended(?: cut| edition)?|theatrical(?: cut)?|unrated|uncut|special edition|ultimate (?:cut|edition)|remastered|imax)\b/i;
const PLEX_EXTRA = /-(trailer|featurette|deleted|scene|short|interview|behindthescenes|other|extra)s?$/i;
const SEASON_DIR = /^(season|series|s)\s*\d+$|^specials$/i;

/** The show a bare `S01E01.mkv` belongs to: the nearest folder above it that isn't a season folder. */
export const showOf = (path: string) =>
  path.split("/").slice(1, -1).reverse().find((d) => !SEASON_DIR.test(d.trim())) ?? "";

/** Normalised identity for duplicate detection: title (and year) + episode, or title + year + whatever
    tells cuts and parts apart, with release noise dropped. `show` names a file that starts at its episode. */
export function mediaKey(name: string, show = "") {
  const stem = stemOf(name).replace(ID_TAG, "").toLowerCase();
  const ep = stem.match(/s(\d{1,2})((?:[\s._-]?e\d{1,3})+)/i);
  const part = stem.match(PART)?.[1];
  const edition = stem.match(EDITION);
  const extras = `${part ? `|part ${Number(part)}` : ""}${edition ? `|${words(edition[1] ?? edition[2] ?? "")}` : ""}`;
  // A year in parentheses is the release year; otherwise the first one after the title, so `1917 (2019)` keeps its title.
  const paren = stem.match(/\(((?:19|20)\d{2})\)/);
  const bare = [...stem.matchAll(/\b(?:19|20)\d{2}\b/g)].find((m) => m.index > 0);
  const year = paren ? { at: paren.index! + 1, value: paren[1]! } : bare ? { at: bare.index, value: bare[0] } : null;
  const marks = [stem.search(/s\d{1,2}e\d{1,3}/i), year?.at ?? -1, stem.search(/2160p|1080p|720p|480p/i)].filter((i) => i >= 0);
  const cut = marks.length > 0 ? Math.min(...marks) : -1;
  const title = words(cut > 0 ? stem.slice(0, cut) : cut === 0 ? show.toLowerCase().replace(/\((19|20)\d{2}\)/, "") : stem);
  if (!title) return null;
  if (ep) {
    const showYear = year && year.at < ep.index! ? year.value : (show.match(/\b(19|20)\d{2}\b/)?.[0] ?? null);
    const episodes = [...ep[2]!.matchAll(/\d+/g)].map((m) => Number(m[0])).join("e");
    return `${title}${showYear ? `|${showYear}` : ""}|s${Number(ep[1])}e${episodes}${extras}`;
  }
  if (!year) return null;
  const after = stem.slice(year.at + 4).replace(PART, " ").replace(EDITION, " ");
  const rest = words((PLEX_EXTRA.test(after) ? after : after.replace(GROUP_SUFFIX, "")).replace(BRACKET_GROUP, " ").replace(NOISE, " "));
  return `${title}|${year.value}${rest ? `|${rest}` : ""}${extras}`;
}

const pct = (good: number, total: number) => (total === 0 ? 100 : Math.round((100 * good) / total));

/** `rootShow` names the show when the scanned folder is one, so its bare `S01E01` files still have a title. */
export function audit(files: WalkedFile[], rootName: string, truncated: boolean, now = new Date(), rootShow = ""): Audit {
  const videos = files.filter(isVideo);
  const folders = files.filter(isFolder);
  const bytes = files.filter((f) => !isFolder(f)).reduce((a, f) => a + f.size, 0);

  const messy = videos.filter((f) => isMessyName(f.name));
  const junkReason = junkFinder(files);

  const children = new Map<number, WalkedFile[]>();
  for (const f of files) if (f.parent_id != null) children.set(f.parent_id, [...(children.get(f.parent_id) ?? []), f]);
  const emptyFolders = folders.filter((f) => !children.get(f.id)?.length);
  const releaseExtra = (f: WalkedFile) =>
    isFolder(f) ? RELEASE_EXTRA_DIR.test(f.name) : !!junkReason(f) || SUBTITLE_EXT.has(ext(f));
  // A wrapper is a torrent-style folder holding a single real video plus only filler, samples and subtitles.
  const wrappers = folders.filter((f) => {
    const kids = children.get(f.id) ?? [];
    const real = kids.filter((k) => isVideo(k) && !junkReason(k));
    return real.length === 1 && kids.every((k) => k === real[0] || releaseExtra(k)) && isMessyName(f.name, true);
  });
  const rootFiles = files.filter((f) => f.depth === 1 && !isFolder(f));
  const deepest = files.reduce((a, f) => Math.max(a, f.depth), 0);

  const junk = files
    .map((f) => ({ f, why: junkReason(f) }))
    .filter((x): x is { f: WalkedFile; why: string } => x.why !== null);
  const junkBytes = junk.reduce((a, x) => a + x.f.size, 0);

  const crcOf = (v: WalkedFile) => (v.crc32 ? `crc:${v.crc32}:${v.size}` : null);
  // One group per set of videos linked by an identical checksum or the same title, so an exact copy
  // never splits a third release off its group.
  const link = new Map<WalkedFile, WalkedFile>();
  const find = (v: WalkedFile): WalkedFile => {
    const up = link.get(v) ?? v;
    return up === v ? v : find(up);
  };
  const firstWith = new Map<string, WalkedFile>();
  for (const v of videos) {
    for (const k of [crcOf(v), mediaKey(v.name, showOf(v.path) || rootShow)]) {
      if (!k) continue;
      const seen = firstWith.get(k);
      if (seen) link.set(find(v), find(seen));
      else firstWith.set(k, v);
    }
  }
  const byKey = new Map<WalkedFile, WalkedFile[]>();
  for (const v of videos) byKey.set(find(v), [...(byKey.get(find(v)) ?? []), v]);
  const keepFirst = (a: WalkedFile, b: WalkedFile) =>
    b.size - a.size ||
    Number(isMessyName(a.name)) - Number(isMessyName(b.name)) ||
    Number(b.first_accessed_at != null) - Number(a.first_accessed_at != null) ||
    a.depth - b.depth;
  const dupGroups = [...byKey.values()].filter((g) => g.length > 1).map((g) => [...g].sort(keepFirst));
  const dupFiles = dupGroups.reduce((a, g) => a + g.length - 1, 0);
  const wasted = dupGroups.reduce((a, g) => a + g.slice(1).reduce((s, f) => s + f.size, 0), 0);

  const never = videos.filter((f) => !f.first_accessed_at).sort((a, b) => b.size - a.size);

  const scores = {
    naming: pct(videos.length - messy.length, videos.length),
    structure: pct(
      Math.max(0, files.length - rootFiles.length - wrappers.length * 3 - emptyFolders.length * 2),
      files.length,
    ),
    junk: pct(files.length - folders.length - junk.length * 4, files.length - folders.length),
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
      examples: dupGroups.slice(0, 8).map((g) => ({ keep: g[0]!.path, drop: g.slice(1, 6).map((f) => f.path), size: g[0]!.size })),
    },
    neverPlayed: {
      count: never.length,
      bytes: never.reduce((a, f) => a + f.size, 0),
      examples: never.slice(0, 10).map((f) => ({ path: f.path, size: f.size, why: `added ${f.created_at.slice(0, 10)}` })),
    },
  };
}
