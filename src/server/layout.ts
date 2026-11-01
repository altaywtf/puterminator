import { junkFinder } from "./audit";
import { type ProposeInput, sidecarsOf } from "./changes";
import type { WalkedFile } from "./tree";

const MAX_LAYOUT_CHANGES = 200;
const YEAR_CANDIDATE = /([([])?((?:19|20)\d{2})([)\]])?/g;
const BARE_YEAR = /(?<![0-9])(?:19|20)\d{2}(?![0-9])/g;
const PAREN_YEAR = /\(((?:19|20)\d{2})\)/g;
const BRACKETS = /[[\]{}()]/;
const TAGS = /\s*(?:\[[^\]]*\]|\{[^}]*\})/g;
const RELEASE = /\b(2160p|1080p|1080i|720p|576p|480p|4k|uhd|x26[45]|h\.?26[45]|hevc|avc|xvid|divx|web-?dl|webrip|web|bluray|blu-ray|brrip|bdrip|hdtv|dvdrip|hdrip|remux|proper|repack|multi|dual|limited|internal)\b/i;
const TRACKER_PREFIX = /^www\.(?:[a-z0-9-]+\.)+[a-z]{2,6}\s*-\s*/i;
const EPISODE_NAME = /^(.*?)(?:^|[\s._\-–]+)s(\d{1,2})[\s._-]?e(\d{1,3})(?:(-e?|e)(\d{1,3}))?(?=$|[\s._\-–])(.*)$/i;
const MORE_EPISODES = /^[\s._]*[-–]\s*e?\d{1,3}(?![0-9p])/i;

const EPISODIC =
  /(?<![a-z0-9])s\d{1,2}[\s._-]?e\d{1,4}(?![0-9])|(?<![a-z0-9])\d{1,2}x\d{2}(?![0-9])|(?<![a-z0-9])(?:e|ep|episode)[\s._-]?\d{1,4}(?![0-9])|(?<![a-z0-9])(?:s\d{1,2}|season[\s._-]?\d{1,2}|staffel[\s._-]?\d{1,2}|saison[\s._-]?\d{1,2})(?![0-9a-z])|(?:^|\s)[-–]\s*\d{1,4}(?=$|[\s.[(])/i;

const DATED = /(?<![0-9])(?:(?:19|20)\d{2}[.\-_ ]\d{1,2}[.\-_ ]\d{1,2}|\d{1,2}[.\-_ ]\d{1,2}[.\-_ ](?:19|20)\d{2})(?![0-9])/;
const RANGE = /(?:19|20)\d{2}\s*[-–]\s*(?:19|20)\d{2}/;
const ID_TAG = /\{(?:imdb|tmdb|tvdb)-[^}]+\}|\[(?:imdb|tmdb|tvdb)id-[^\]]+\]/gi;
const SPLIT = /(?:^|[\s._-])(?:part|pt|cd|disc|disk)[\s._-]*(?:\d|[a-d](?![a-z]))/i;
const PART_WORD = /^(?:part|pt|cd|disc|disk|episode|ep|chapter|vol|volume|one|two|three|four|five|i{1,3}|iv|v|vi)$/;
const DISC = /(?:^|[\s._-])(?:cd|disc|disk)[\s._-]?(\d)(?![0-9])/gi;
const EDITION = /\{edition-([^}]+)\}|\b(director'?s[\s._]cut|final[\s._]cut|extended(?:[\s._](?:cut|edition))?|theatrical(?:[\s._]cut)?|unrated|uncut|special[\s._]edition|ultimate[\s._](?:cut|edition)|remastered|imax)\b/gi;
const EXTRA = /-(trailer|featurette|deleted|deletedscene|scene|short|interview|behindthescenes|clip|other|extra)s?$/i;
const SEASON_FOLDER = /^(?:season|series|s)[\s._-]*0*(\d{1,4})$/i;
const SPECIALS = /^specials$/i;
const SEASON_PACK = /^(.+?)[\s._-]+(?:s|season[\s._-]*)(\d{1,2})(?![0-9a-z])(.*)$/i;
const MOVIE_FOLDER = /^([^()[\]{}]+?) \(((?:19|20)\d{2})\)((?:\s*(?:\{[^}]*\}|\[[^\]]*\]))*)$/;
const ILLEGAL = /[<>:"/\\|?*]/g;

type Episode = { kind: "episode"; show: string; year: string | null; season: number; first: number; last: number };

type Movie = { kind: "movie"; title: string; year: string; part: number | null; edition: string | null; ids: string };

export type Media = Episode | Movie;

type Pack = { show: string; year: string | null; season: number };

type LayoutChange = ProposeInput["changes"][number];

export type LayoutResult = {
  changes: LayoutChange[];
  skipped: Array<{ path: string; why: string }>;
  remaining: number;
};

const stemOf = (name: string) => name.replace(/\.[a-z0-9]{2,4}$/i, "");
const extOf = (name: string) => name.match(/\.([a-z0-9]{2,4})$/i)?.[1]?.toLowerCase() ?? "";
const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const parentOf = (path: string) => path.slice(0, path.lastIndexOf("/"));
const pad = (n: number) => String(n).padStart(2, "0");
const pathKey = (path: string) => path.normalize("NFC").toLowerCase();
const latestYear = () => new Date().getUTCFullYear() + 1;

const showKey = (name: string) =>
  name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(TAGS, " ")
    .replace(PAREN_YEAR, " ")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

const cleanName = (s: string) =>
  s
    .normalize("NFC")
    .replace(ILLEGAL, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/(?<![\s.]\p{L})\.+$/u, "")
    .trim();

const spaceDots = (word: string) =>
  word
    .split(".")
    .filter(Boolean)
    .reduce((out, part, i, all) => {
      const single = (s: string | undefined) => s?.length === 1 && /\p{L}/u.test(s);
      const acronym = single(part) && (single(all[i - 1]) || single(all[i + 1]));
      const glue = i === 0 || (acronym && single(all[i - 1])) ? "" : " ";

      return `${out}${glue}${part}${acronym ? "." : ""}`;
    }, "");

const spaced = (raw: string) =>
  raw
    .split(/[\s_]+/)
    .map((word) => (word.includes(".") && !/^\p{L}{1,3}\.$/u.test(word) ? spaceDots(word) : word))
    .join(" ");

const capitalized = (title: string) =>
  /\p{Lu}/u.test(title) ? title : title.replace(/(^|\s)(\p{Ll})/gu, (_, gap: string, letter: string) => `${gap}${letter.toUpperCase()}`);

const pretty = (raw: string) =>
  capitalized(
    cleanName(
      spaced(raw.replace(TAGS, " "))
        .replace(/[\s\-–]+$/, "")
        .replace(/^[\s\-–]+/, ""),
    ),
  );

const beforeRelease = (text: string) => {
  const at = text.search(RELEASE);

  return at < 0 ? text : text.slice(0, at);
};

const blank = (text: string) => text.replace(/[\s._\-–()[\]]+/g, "") === "";

const trailingYear = (lead: string) => {
  const year = lead.match(/^(.+?)(?:[\s._\-–]+[([]?|[([])((?:19|20)\d{2})[)\]]?[\s._\-–]*$/);

  return year && Number(year[2]) <= latestYear() && pretty(year[1] ?? "") ? { before: year[1] ?? "", value: year[2] ?? "" } : null;
};

const movieOf = (stem: string): Movie | null => {
  if (EPISODIC.test(stem) || DATED.test(stem) || RANGE.test(stem)) return null;

  const readings = [...stem.matchAll(YEAR_CANDIDATE)].flatMap((m): Movie[] => {
    const at = m.index;
    const end = at + m[0].length;
    const value = m[2] ?? "";
    const title = stem.slice(0, at);
    const tail = stem.slice(end);

    if (/[0-9]$/.test(title) || /^[0-9]/.test(tail) || Number(value) > latestYear()) return [];

    if (!pretty(title) || BRACKETS.test(title) || beforeRelease(title) !== title || SPLIT.test(title)) return [];

    if ([...title.matchAll(BARE_YEAR)].some((y) => y.index > 0 && !blank(title.slice(y.index + 4)))) return [];
    const head = beforeRelease(tail);
    const discs = [...head.matchAll(DISC)];

    if (SPLIT.test(tail.slice(head.length)) || discs.length > 1 || !blank(head.replace(ID_TAG, " ").replace(EDITION, " ").replace(DISC, " "))) return [];
    const edition = [...head.matchAll(EDITION)].at(0);

    return [
      {
        kind: "movie",
        title: pretty(title),
        year: value,
        part: discs[0] ? Number(discs[0][1]) : null,
        edition: edition ? pretty(edition[1] ?? edition[2] ?? "").replace(/\bdirectors\b/i, "Director's") : null,
        ids: (head.match(ID_TAG) ?? []).join(" "),
      },
    ];
  });

  return readings.length === 1 ? (readings[0] ?? null) : null;
};

const episodeParts = (stem: string) => {
  const m = stem.match(EPISODE_NAME);

  if (!m || DATED.test(stem)) return null;
  const [, lead = "", season = "", first = "", joint = "", second = "", rest = ""] = m;
  const last = second ? Number(second) : Number(first);

  if (second && (joint.toLowerCase() === "e" ? last !== Number(first) + 1 : last <= Number(first))) return null;

  if (MORE_EPISODES.test(rest) || EPISODIC.test(rest) || SPLIT.test(rest)) return null;

  return { lead, season: Number(season), first: Number(first), last };
};

const episodeOf = (stem: string, pack: Pack | null): Episode | null => {
  const parts = episodeParts(stem);

  if (!parts) return null;
  const { lead: raw, ...range } = parts;
  const lead = raw.replace(ID_TAG, " ");

  if (beforeRelease(lead) !== lead || EPISODIC.test(lead) || RANGE.test(lead)) return null;
  const year = trailingYear(lead);
  const text = year ? year.before : lead;

  if (BRACKETS.test(text)) return null;
  const own = pretty(text);

  if (!own) return pack && pack.season === range.season ? { kind: "episode", show: pack.show, year: pack.year, ...range } : null;

  if (pack && showKey(pack.show) !== showKey(own)) return null;

  return { kind: "episode", show: own, year: year?.value ?? pack?.year ?? null, ...range };
};

/** A video's identity from its own name, or null unless the whole name fits one of the shapes it knows:
    `Title.Year.<release tags>`, `Title (Year)` and `Show[.Year].S01E02[-E03]`. A bare `S01E02` takes its
    show from the season pack it sits in. */
export function parseMedia(name: string, pack: Pack | null = null): Media | null {
  if (name !== name.trim()) return null;
  const stem = stemOf(name).replace(TRACKER_PREFIX, "");

  if (EXTRA.test(stem)) return null;

  return EPISODE_NAME.test(stem) ? episodeOf(stem, pack) : movieOf(stem);
}

const packOf = (folder: string): Pack | null => {
  const m = folder.match(SEASON_PACK);
  const lead = m?.[1] ?? "";

  if (!m || EPISODIC.test(lead) || BRACKETS.test(lead) || beforeRelease(lead) !== lead || !blank(beforeRelease(m[3] ?? ""))) return null;
  const year = trailingYear(lead);
  const show = pretty(year ? year.before : lead);

  return show ? { show, year: year?.value ?? null, season: Number(m[2]) } : null;
};

const movieSuffix = (media: Movie) => `${media.part ? ` - pt${media.part}` : ""}${media.edition ? ` {edition-${media.edition}}` : ""}`;

const showLabel = (show: string, year: string | null) => cleanName(year ? `${show} (${year})` : show);
const episodeToken = (season: number, first: number, last: number) => `S${pad(season)}E${pad(first)}${last > first ? `-E${pad(last)}` : ""}`;

/** Where a video goes: the folder and file names Plex, Infuse, Jellyfin and Kodi document. */
export function targetPath(media: Media, ext: string, movies: string, shows: string) {
  if (media.kind === "movie") {
    const base = cleanName(`${media.title} (${media.year})`);
    const folder = media.ids ? `${base} ${media.ids}` : base;

    return `${movies}/${folder}/${base}${movieSuffix(media)}.${ext}`;
  }

  const label = showLabel(media.show, media.year);

  return `${shows}/${label}/Season ${pad(media.season)}/${label} - ${episodeToken(media.season, media.first, media.last)}.${ext}`;
}

const normalRoot = (path: string) => {
  const parts = path
    .split("/")
    .map((p) => p.trim())
    .filter(Boolean);

  return parts.length > 0 ? `/${parts.join("/")}` : "";
};

/**
 * A move or rename for every video under `within` that isn't where Plex, Infuse, Jellyfin and Kodi expect it,
 * at most MAX_LAYOUT_CHANGES including the subtitles that follow. It never touches a show's own folders or a
 * folder of the user's under the movies root, and skips anything it can't name with certainty.
 */
export function planLayout(snapshot: ReadonlyArray<WalkedFile>, moviesRoot: string, showsRoot: string, within: string): LayoutResult | { error: string } {
  const folderPaths = new Map(snapshot.flatMap((f) => (f.file_type === "FOLDER" ? [[pathKey(f.path), f.path]] : [])));
  const wantedMovies = normalRoot(moviesRoot);
  const wantedShows = normalRoot(showsRoot);
  const scopeInput = normalRoot(within);

  const resolve = (path: string) =>
    path
      .split("/")
      .filter(Boolean)
      .reduce((real, part) => folderPaths.get(pathKey(`${real}/${part}`)) ?? `${real}/${part}`, "");

  if (!wantedMovies || !wantedShows) return { error: "Name a folder for movies and one for shows, like '/Movies' and '/TV Shows'." };

  if (pathKey(wantedMovies) === pathKey(wantedShows)) return { error: "Movies and shows need folders of their own." };

  if (scopeInput && !folderPaths.has(pathKey(scopeInput))) return { error: `${scopeInput} isn't a folder in the snapshot.` };
  const movies = resolve(wantedMovies);
  const shows = resolve(wantedShows);
  const scope = scopeInput ? resolve(scopeInput) : "";
  const junk = junkFinder(snapshot);
  const isExtra = (f: WalkedFile) => EXTRA.test(stemOf(f.name));
  const same = (a: string, b: string) => pathKey(a) === pathKey(b);
  const isUnder = (path: string, root: string) => pathKey(path).startsWith(`${pathKey(root)}/`);
  const byParent = new Map<string, WalkedFile[]>();

  for (const f of snapshot) {
    const siblings = byParent.get(pathKey(parentOf(f.path)));

    if (siblings) siblings.push(f);
    else byParent.set(pathKey(parentOf(f.path)), [f]);
  }

  const childrenOf = (path: string) => byParent.get(pathKey(path)) ?? [];
  const realVideos = (files: ReadonlyArray<WalkedFile>) => files.filter((g) => g.file_type === "VIDEO" && !junk(g) && !isExtra(g));
  const allVideos = realVideos(snapshot).map((f) => ({ f, key: pathKey(f.path) }));

  const videosUnder = (folder: string) => {
    const prefix = `${pathKey(folder)}/`;

    return allVideos.flatMap((v) => (v.key.startsWith(prefix) ? [v.f] : []));
  };

  const occupied = new Map(snapshot.map((f) => [pathKey(f.path), f.id]));
  const videoSlots = new Map(snapshot.flatMap((f) => (f.file_type === "VIDEO" ? [[pathKey(`${parentOf(f.path)}/${stemOf(f.name)}`), f.id]] : [])));
  const isSeasonFolder = (name: string) => SEASON_FOLDER.test(name) || SPECIALS.test(name);
  const seasonNumber = (name: string) => (SPECIALS.test(name) ? 0 : Number(name.match(SEASON_FOLDER)?.[1] ?? Number.NaN));
  const underSeasonFolder = (path: string) => parentOf(path).split("/").some(isSeasonFolder);
  const isRelease = (name: string) => RELEASE.test(name) && (parseMedia(`${name}.mkv`) !== null || packOf(name) !== null);
  const movieKey = (title: string, year: string) => `${showKey(title)}|${year}`;
  const showsByKey = new Map<string, Array<{ name: string; year: string | null }>>();
  const moviesByKey = new Map<string, string>();
  const moviesByTitle = new Map<string, string>();
  const looseMovieFolders = new Map<string, string>();
  const plannedEpisodes = new Map<string, Array<{ first: number; last: number }>>();
  const plannedMovies = new Map<string, Array<number | null>>();

  for (const f of childrenOf(shows)) {
    if (f.file_type !== "FOLDER") continue;
    const year = [...f.name.matchAll(PAREN_YEAR)].at(-1)?.[1] ?? null;

    showsByKey.set(showKey(f.name), [...(showsByKey.get(showKey(f.name)) ?? []), { name: f.name, year }]);
  }

  for (const f of childrenOf(movies)) {
    const m = f.file_type === "FOLDER" ? f.name.match(MOVIE_FOLDER) : null;

    if (f.file_type === "FOLDER" && !m) looseMovieFolders.set(showKey(f.name.replace(BARE_YEAR, " ")), f.name);

    if (!m) continue;
    moviesByKey.set(movieKey(m[1] ?? "", m[2] ?? ""), f.name);
    moviesByTitle.set(showKey(m[1] ?? ""), f.name);
  }

  const videos = allVideos.flatMap((v) => (!scope || isUnder(v.f.path, scope) ? [v.f] : [])).toSorted((a, b) => b.size - a.size || a.path.localeCompare(b.path));
  const changes: LayoutChange[] = [];
  const skipped: LayoutResult["skipped"] = [];
  let budget = MAX_LAYOUT_CHANGES;
  let remaining = 0;

  const showFolderFor = (show: string, year: string | null): { name: string } | { why: string } => {
    const titled = year ? (showsByKey.get(showKey(`${show} ${year}`)) ?? []) : [];

    if (titled.length > 0) return titled.length === 1 && titled[0]?.year === null ? { name: titled[0].name } : { why: `can't tell if it belongs in ${titled[0]?.name ?? show}` };
    const key = showKey(show);
    const known = showsByKey.get(key) ?? [];
    const exact = known.find((k) => k.year === year);
    const yearless = known.find((k) => k.year === null);

    if (exact && (year || known.length === 1)) return { name: exact.name };

    if (year ? yearless : known.length > 0) return { why: `can't tell if it belongs in ${(yearless ?? known[0])?.name ?? show}` };
    const created = { name: showLabel(show, year), year };

    showsByKey.set(key, [...known, created]);

    return { name: created.name };
  };

  const seasonFor = (showPath: string, showName: string, season: number): { path: string } | { why: string } => {
    const seasons = childrenOf(showPath).filter((g) => g.file_type === "FOLDER" && isSeasonFolder(g.name));

    if (videosUnder(showPath).some((v) => !seasons.some((s) => isUnder(v.path, s.path)))) return { why: `${showName} keeps episodes outside season folders` };
    const matching = seasons.filter((s) => seasonNumber(s.name) === season);

    if (matching.length > 1) return { why: `${showName} has more than one folder for season ${season}` };

    return { path: matching[0]?.path ?? `${showPath}/Season ${pad(season)}` };
  };

  const episodesIn = (season: string, number: number) => [
    ...videosUnder(season).map((g) => {
      const e = episodeParts(stemOf(g.name));

      return e && e.season === number ? { first: e.first, last: e.last } : null;
    }),
    ...(plannedEpisodes.get(pathKey(season)) ?? []),
  ];

  const place = (f: WalkedFile, target: string) => {
    if (target === f.path) return false;
    const slot = pathKey(`${parentOf(target)}/${stemOf(nameOf(target))}`);
    const holder = occupied.get(pathKey(target)) ?? videoSlots.get(slot);

    if (holder !== undefined && holder !== f.id) {
      skipped.push({ path: f.path, why: `${nameOf(target)} is already there` });

      return false;
    }

    const subtitles = sidecarsOf(snapshot, f);
    const ownIds = new Set([f.id, ...subtitles.map((s) => s.id)]);
    const subtitleTargets = subtitles.map((s) => pathKey(`${parentOf(target)}/${stemOf(nameOf(target))}${s.name.slice(stemOf(f.name).length)}`));

    if (new Set(subtitleTargets).size < subtitleTargets.length || subtitleTargets.some((t) => !ownIds.has(occupied.get(t) ?? f.id))) {
      skipped.push({ path: f.path, why: "its subtitles would land on other files" });

      return false;
    }

    if (subtitles.length + 1 > budget) {
      remaining++;

      return false;
    }

    budget -= subtitles.length + 1;
    occupied.set(pathKey(target), f.id);
    videoSlots.set(slot, f.id);

    for (const t of subtitleTargets) occupied.set(t, f.id);

    changes.push(same(parentOf(target), parentOf(f.path)) ? { op: "rename", path: f.path, to: nameOf(target) } : { op: "move", path: f.path, to: target });

    return true;
  };

  const leave = (f: WalkedFile, why: string) => void skipped.push({ path: f.path, why });

  const fromReleaseFolder = (f: WalkedFile, parent: string) => {
    const folder = parseMedia(`${nameOf(parent)}.mkv`);
    const stem = stemOf(f.name);
    const words = showKey(beforeRelease(stem)).split(" ").filter(Boolean);

    if (folder?.kind !== "movie" || !isRelease(nameOf(parent)) || realVideos(childrenOf(parent)).length !== 1 || [scope, movies, shows, ""].some((p) => same(p, parent))) return null;
    const title = showKey(folder.title).split(" ");
    const extra = words.filter((w) => !title.includes(w));

    return ` ${words.join(" ")} `.includes(` ${title.join(" ")} `) && !/\p{Nd}/u.test(beforeRelease(stem)) && !EPISODIC.test(stem) && !extra.some((w) => PART_WORD.test(w)) ? folder : null;
  };

  for (const f of videos) {
    const ext = extOf(f.name) || "mkv";
    const parent = parentOf(f.path);
    const parentName = nameOf(parent);

    if ((isUnder(f.path, shows) && !same(parent, shows)) || underSeasonFolder(f.path)) continue;
    const pack = packOf(parentName);
    const own = parseMedia(f.name, pack);

    if (own?.kind === "episode" && [parentName, nameOf(parentOf(parent))].some((dir) => dir && !packOf(dir) && showKey(dir) === showKey(own.show))) continue;
    const movieFolder = parentName.match(MOVIE_FOLDER);

    if (movieFolder && !EPISODIC.test(f.name) && f.name.toLowerCase().startsWith(`${movieFolder[1]} (${movieFolder[2]})`.toLowerCase())) continue;
    const media = own ?? (pack ? null : fromReleaseFolder(f, parent));

    if (!media) {
      leave(f, "its name doesn't say which movie or episode it is");
      continue;
    }

    if (movieFolder && (media.kind !== "movie" || movieKey(movieFolder[1] ?? "", movieFolder[2] ?? "") !== movieKey(media.title, media.year))) {
      leave(f, `it sits in the folder of ${parentName}`);
      continue;
    }

    if (!movieFolder && isUnder(f.path, movies) && !same(parent, movies) && !(same(parentOf(parent), movies) && isRelease(parentName))) {
      leave(f, `it sits in ${parentName}, a folder of yours`);
      continue;
    }

    if (media.kind === "episode") {
      const show = showFolderFor(media.show, media.year);

      if ("why" in show) {
        leave(f, show.why);
        continue;
      }

      const season = seasonFor(`${shows}/${show.name}`, show.name, media.season);

      if ("why" in season) {
        leave(f, season.why);
        continue;
      }

      const present = episodesIn(season.path, media.season);

      if (present.some((e) => !e || (e.first <= media.last && media.first <= e.last))) {
        leave(f, present.includes(null) ? `can't tell which episodes ${nameOf(season.path)} of ${show.name} already has` : `${episodeToken(media.season, media.first, media.last)} is already in ${show.name}`);
        continue;
      }

      if (place(f, `${season.path}/${show.name.replace(TAGS, "").trim()} - ${episodeToken(media.season, media.first, media.last)}.${ext}`))
        plannedEpisodes.set(pathKey(season.path), [...(plannedEpisodes.get(pathKey(season.path)) ?? []), { first: media.first, last: media.last }]);

      continue;
    }

    const key = movieKey(media.title, media.year);
    const inPlace = movieFolder !== null && isUnder(f.path, movies);

    const lookalike = inPlace ? undefined : (moviesByTitle.get(showKey(`${media.title} ${media.year}`)) ?? looseMovieFolders.get(showKey(media.title)));

    if (lookalike) {
      leave(f, `can't tell if it's ${lookalike}`);
      continue;
    }

    const folder = inPlace ? parent : `${movies}/${moviesByKey.get(key) ?? nameOf(parentOf(targetPath(media, ext, movies, shows)))}`;
    const existing = inPlace ? [] : realVideos(childrenOf(folder)).filter((g) => g.id !== f.id);
    const arrivals = plannedMovies.get(pathKey(folder)) ?? [];

    if (existing[0]) {
      leave(f, `${nameOf(folder)} already has ${existing[0].name}`);
      continue;
    }

    if (arrivals.some((part) => !media.part || !part || part === media.part)) {
      leave(f, `another copy of ${nameOf(folder)} is in this plan`);
      continue;
    }

    if (!inPlace) moviesByKey.set(key, nameOf(folder));

    if (place(f, `${folder}/${nameOf(folder).replace(TAGS, "").trim()}${movieSuffix(media)}.${ext}`)) plannedMovies.set(pathKey(folder), [...arrivals, media.part]);
  }

  return { changes, skipped, remaining };
}
