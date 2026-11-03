import { junkFinder, stemOf } from "./audit";
import { MAX_CHANGES, nameOf, type ProposeInput, sidecarsOf } from "./changes";
import type { WalkedFile } from "./tree";

const MAX_NAME_BYTES = 255;
const YEAR_CANDIDATE = /([([])?((?:19|20)\d{2})([)\]])?/g;
const BARE_YEAR = /(?<![0-9])(?:19|20)\d{2}(?![0-9])/g;
const PAREN_YEAR = /\(((?:19|20)\d{2})\)/g;
const BRACKETS = /[[\]{}()【】「」『』〔〕（）［］]/;
const DOMAIN = /\b[a-z0-9-]{2,}\.(?:com|org|net|info|xyz|lol|ru)\b/i;
const COLLECTION = /\b(?:complete|collection|box[\s._-]?set|trilogy|anthology|quadrilogy)\b/i;
const TAGS = /\s*(?:\[[^\]]*\]|\{[^}]*\})/g;
const RELEASE = /\b(2160p|1080p|1080i|720p|576p|480p|4k|uhd|x26[45]|h\.?26[45]|hevc|avc|xvid|divx|web-?dl|webrip|web|bluray|blu-ray|brrip|bdrip|hdtv|dvdrip|hdrip|remux|proper|repack|multi|dual|limited|internal)\b/i;
const TRACKER_PREFIX = /^www\.(?:[a-z0-9]+(?:-[a-z0-9]+)*\.)+(?:com|org|net|to|me|info|io|cc|tv|ws|xyz|lol|ru|co|uk|nl|se|in)\s*-\s*/i;
const EPISODE_NAME = /^(.*?)(?:^|[\s._\-–—]+)s(\d{1,2})[\s._-]?e(\d{1,3})(?:(-e?|e)(\d{1,3}))?(?=$|[\s._\-–—])(.*)$/i;
const MORE_EPISODES = /^[\s._]*(?:[-–—&+]|and\b)\s*e?\d{1,3}(?![0-9p])/i;

const EPISODIC =
  /(?<![a-z0-9])s\d{1,2}[\s._-]?e\d{1,4}(?![0-9])|(?<![a-z0-9])\d{1,2}x\d{2}(?![0-9])|(?<![\p{L}0-9])(?:e|ep|episode|[ée]pisode|folge)\.?[\s._-]*\d{1,4}(?![0-9])|(?<![a-z0-9])(?:s\d{1,2}|season[\s._-]?\d{1,2}|staffel[\s._-]?\d{1,2}|saison[\s._-]?\d{1,2})(?![0-9a-z])|(?:^|[\s_])[-–—][\s_]*\d{1,4}(?=$|[\s._[(])|(?<![a-z0-9])\d{1,2}[\s._]*of[\s._]*\d{1,2}(?![0-9])|第\s*[0-9０-９一二三四五六七八九十百]+\s*[集话話回期]/iu;

const DATED =
  /(?<![0-9])(?:(?:19|20)\d{2}[.\-_ ]\d{1,2}[.\-_ ]\d{1,2}|\d{1,2}[.\-_ ]\d{1,2}[.\-_ ](?:19|20)\d{2})(?![0-9])|(?<![a-z])(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?[\s._-]+(?:\d{1,2}(?:st|nd|rd|th)?[\s._,-]+)?(?:19|20)\d{2}(?![0-9])/i;

const RANGE = /(?:19|20)\d{2}[\s._]*[-–—][\s._]*(?:19|20)\d{2}/;
const ID_TAG = /\{(?:imdb|tmdb|tvdb)-[^}]+\}|\[(?:imdb|tmdb|tvdb)id-[^\]]+\]/gi;
const SPLIT = /(?:^|[\s._-])(?:part|pt|cd|disc|disk)[\s._-]*(?:\d|(?:[a-d]|one|two|three|four|five|six|i{1,3}|iv|v|vi)(?![a-z]))/i;
const PART_WORD = /^(?:part|pt|cd|disc|disk|episode|ep|chapter|vol|volume|one|two|three|four|five|i{1,3}|iv|v|vi)$/;
const DISC = /(?:^|[\s._-])(?:cd|disc|disk)[\s._-]?(\d)(?![0-9])/gi;
const EDITION = /\{edition-([^}]+)\}|\b(director'?s[\s._]cut|final[\s._]cut|extended(?:[\s._](?:cut|edition))?|theatrical(?:[\s._]cut)?|unrated|uncut|special[\s._]edition|ultimate[\s._](?:cut|edition)|remastered|imax)\b/gi;
const EXTRA = /-(trailer|featurette|deleted|deletedscene|scene|short|interview|behindthescenes|clip|other|extra|sample)s?$/i;
const EXTRAS_FOLDER = /^(?:samples?|extras?|featurettes?|behind the scenes|deleted scenes|trailers?|interviews?|scenes|shorts|others?|bonus)$/i;
const DISC_FOLDER = /^(?:cd|disc|disk|dvd)[\s._-]?\d{1,2}$/i;
const SEASON_FOLDER = /^(?:season|series|s|staffel|saison|temporada|stagione)[\s._-]*0*(\d{1,4})$/i;
const SPECIALS = /^specials$/i;
const SEASON_PACK = /^(.+?)[\s._-]+(?:s|season[\s._-]*)(\d{1,2})(?![0-9a-z])(.*)$/i;
const MOVIE_FOLDER = /^([^()[\]{}]+?) \(((?:19|20)\d{2})\)((?:\s*(?:\{[^}]*\}|\[[^\]]*\]))*)$/;
const ILLEGAL = /[<>:"/\\|?*]/g;

type Episode = { kind: "episode"; show: string; year: string | null; season: number; first: number; last: number; ids: string };

type Movie = { kind: "movie"; title: string; year: string; part: number | null; edition: string | null; ids: string };

export type Media = Episode | Movie;

type Pack = { show: string; year: string | null; season: number };

type LayoutChange = ProposeInput["changes"][number];

export type LayoutResult = {
  changes: LayoutChange[];
  skipped: Array<{ path: string; why: string }>;
  remaining: number;
};

const extOf = (name: string) => name.match(/\.([a-z0-9]{2,4})$/i)?.[1]?.toLowerCase() ?? "";
const parentOf = (path: string) => path.slice(0, path.lastIndexOf("/"));
const pad = (n: number) => String(n).padStart(2, "0");
const pathKey = (path: string) => path.normalize("NFC").toLowerCase();
const latestYearAt = (now: number) => new Date(now).getUTCFullYear() + 1;

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

const trailingYear = (lead: string, latest: number) => {
  const year = lead.match(/^(.+?)(?:[\s._\-–]+[([]?|[([])((?:19|20)\d{2})[)\]]?[\s._\-–]*$/);

  return year && Number(year[2]) <= latest && pretty(year[1] ?? "") ? { before: year[1] ?? "", value: year[2] ?? "" } : null;
};

const movieOf = (stem: string, latest: number): Movie | null => {
  if (EPISODIC.test(stem) || DATED.test(stem) || RANGE.test(stem)) return null;

  const readings = [...stem.matchAll(YEAR_CANDIDATE)].flatMap((m): Movie[] => {
    const at = m.index;
    const end = at + m[0].length;
    const value = m[2] ?? "";
    const title = stem.slice(0, at);
    const tail = stem.slice(end);

    if (/[0-9]$/.test(title) || /^[0-9]/.test(tail) || Number(value) > latest) return [];

    if (!pretty(title) || BRACKETS.test(title) || DOMAIN.test(title) || COLLECTION.test(title) || /\s[-–—]\s/.test(title) || beforeRelease(title) !== title || SPLIT.test(title)) return [];

    if ([...title.matchAll(BARE_YEAR)].some((y) => y.index > 0 && !blank(title.slice(y.index + 4)))) return [];
    const head = beforeRelease(tail);
    const discs = [...head.matchAll(DISC)];

    if (SPLIT.test(tail.slice(head.length)) || discs.length > 1 || !blank(head.replace(ID_TAG, " ").replace(EDITION, " ").replace(DISC, " "))) return [];
    const edition = [...tail.matchAll(EDITION)].at(0);

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

  if (second && (second.length !== first.length || (joint.toLowerCase() === "e" ? last !== Number(first) + 1 : last <= Number(first)))) return null;

  if (MORE_EPISODES.test(rest) || EPISODIC.test(rest) || SPLIT.test(rest)) return null;

  return { lead, season: Number(season), first: Number(first), last };
};

const episodeOf = (stem: string, pack: Pack | null, latest: number): Episode | null => {
  const parts = episodeParts(stem);

  if (!parts) return null;
  const { lead: raw, ...range } = parts;
  const lead = raw.replace(ID_TAG, " ");

  if (beforeRelease(lead) !== lead || EPISODIC.test(lead) || RANGE.test(lead) || DOMAIN.test(lead) || COLLECTION.test(lead)) return null;
  const year = trailingYear(lead, latest);
  const text = year ? year.before : lead;

  if (BRACKETS.test(text)) return null;
  const own = pretty(text);
  const ids = (raw.match(ID_TAG) ?? []).join(" ");

  if (!own) return pack && pack.season === range.season ? { kind: "episode", show: pack.show, year: pack.year, ...range, ids } : null;

  if (pack && (showKey(pack.show) !== showKey(own) || (pack.year && year && pack.year !== year.value))) return null;

  return { kind: "episode", show: own, year: year?.value ?? pack?.year ?? null, ...range, ids };
};

/** A video's identity from its own name, or null unless the whole name fits one of the shapes it knows:
    `Title.Year.<release tags>`, `Title (Year)` and `Show[.Year].S01E02[-E03]`. A bare `S01E02` takes its
    show from the season pack it sits in. */
export function parseMedia(name: string, now: number, pack: Pack | null = null): Media | null {
  if (name !== name.trim()) return null;
  const stem = stemOf(name).replace(TRACKER_PREFIX, "");

  if (EXTRA.test(stem)) return null;

  const latest = latestYearAt(now);

  return EPISODE_NAME.test(stem) ? episodeOf(stem, pack, latest) : movieOf(stem, latest);
}

const packOf = (folder: string, latest: number): Pack | null => {
  const m = folder.match(SEASON_PACK);
  const lead = m?.[1] ?? "";

  if (!m || EPISODIC.test(lead) || BRACKETS.test(lead) || RANGE.test(lead) || COLLECTION.test(lead) || beforeRelease(lead) !== lead || !blank(beforeRelease(m[3] ?? ""))) return null;
  const year = trailingYear(lead, latest);
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

export const isExtraVideo = (f: WalkedFile) => EXTRA.test(stemOf(f.name));

export const resolveScope = (snapshot: ReadonlyArray<WalkedFile>, within: string): { scope: string } | { error: string } => {
  const wanted = normalRoot(within);

  if (!wanted) return { scope: "" };
  const folder = snapshot.find((f) => f.file_type === "FOLDER" && pathKey(f.path) === pathKey(wanted));

  return folder ? { scope: folder.path } : { error: `${wanted} isn't a folder in the snapshot.` };
};

const normalRoot = (path: string) => {
  const parts = path
    .split("/")
    .map((p) => p.trim())
    .filter(Boolean);

  return parts.length > 0 ? `/${parts.join("/")}` : "";
};

/**
 * A move or rename for every video under `within` that isn't where Plex, Infuse, Jellyfin and Kodi expect it,
 * at most MAX_CHANGES including the subtitles that follow. It never touches a show's own folders or a
 * folder of the user's under the movies root, and skips anything it can't name with certainty.
 */
export function planLayout(snapshot: ReadonlyArray<WalkedFile>, moviesRoot: string, showsRoot: string, within: string, now: number): LayoutResult | { error: string } {
  const latest = latestYearAt(now);
  const realFolders = new Set(snapshot.flatMap((f) => (f.file_type === "FOLDER" ? [f.path] : [])));
  const folderPaths = new Map(snapshot.flatMap((f) => (f.file_type === "FOLDER" ? [[pathKey(f.path), f.path]] : [])));
  const wantedMovies = normalRoot(moviesRoot);
  const wantedShows = normalRoot(showsRoot);
  const scopeInput = normalRoot(within);

  const resolve = (path: string) =>
    path
      .split("/")
      .filter(Boolean)
      .reduce((real, part) => {
        const next = `${real}/${part}`;

        return realFolders.has(next) ? next : (folderPaths.get(pathKey(next)) ?? next);
      }, "");

  if (!wantedMovies || !wantedShows) return { error: "Name a folder for movies and one for shows, like '/Movies' and '/TV Shows'." };

  if (pathKey(wantedMovies) === pathKey(wantedShows)) return { error: "Movies and shows need folders of their own." };

  if (scopeInput && !folderPaths.has(pathKey(scopeInput))) return { error: `${scopeInput} isn't a folder in the snapshot.` };
  const movies = resolve(wantedMovies);
  const shows = resolve(wantedShows);
  const scope = scopeInput ? resolve(scopeInput) : "";
  const junk = junkFinder(snapshot);
  const same = (a: string, b: string) => pathKey(a) === pathKey(b);
  const isUnder = (path: string, root: string) => pathKey(path).startsWith(`${pathKey(root)}/`);
  const byParent = new Map<string, WalkedFile[]>();

  for (const f of snapshot) {
    const siblings = byParent.get(pathKey(parentOf(f.path)));

    if (siblings) siblings.push(f);
    else byParent.set(pathKey(parentOf(f.path)), [f]);
  }

  const childrenOf = (path: string) => byParent.get(pathKey(path)) ?? [];
  const realVideos = (files: ReadonlyArray<WalkedFile>) => files.filter((g) => g.file_type === "VIDEO" && !junk(g) && !isExtraVideo(g));
  const allVideos = realVideos(snapshot).map((f) => ({ f, key: pathKey(f.path) }));

  const videosUnder = (folder: string) => {
    const prefix = `${pathKey(folder)}/`;

    return allVideos.flatMap((v) => (v.key.startsWith(prefix) ? [v.f] : []));
  };

  const occupied = new Map(snapshot.map((f) => [pathKey(f.path), f.id]));
  const videoSlots = new Map(snapshot.flatMap((f) => (f.file_type === "VIDEO" ? [[pathKey(`${parentOf(f.path)}/${stemOf(f.name)}`), f.id]] : [])));
  const isSeasonFolder = (name: string) => SEASON_FOLDER.test(name) || SPECIALS.test(name);
  const seasonNumber = (name: string) => (SPECIALS.test(name) ? 0 : Number(name.match(SEASON_FOLDER)?.[1] ?? Number.NaN));
  const foldersOf = (path: string) => parentOf(path).split("/").filter(Boolean);
  const movieKey = (title: string, year: string) => `${showKey(title)}|${year}`;
  const folderYear = (name: string) => name.match(/[([]((?:19|20)\d{2})[)\]](?:\s*(?:\{[^}]*\}|\[[^\]]*\]))*\s*$/)?.[1] ?? null;

  const idsOf = (name: string) =>
    (name.match(ID_TAG) ?? [])
      .map((t) => t.toLowerCase().replace(/[[\]{}]/g, "").replace("id-", "-"))
      .toSorted()
      .join(" ");

  const folderIdentity = (name: string): Media | Pack | null => (RELEASE.test(name) ? (parseMedia(`${name}.mkv`, now) ?? packOf(name, latest)) : null);

  const inExtras = (path: string) => {
    const dirs = foldersOf(path);

    return dirs.some((d, i) => i > 0 && EXTRAS_FOLDER.test(d) && (MOVIE_FOLDER.test(dirs[i - 1] ?? "") || folderIdentity(dirs[i - 1] ?? "") !== null));
  };

  const matches = (folder: Media | Pack, media: Media) =>
    "kind" in folder && folder.kind === "movie" ? media.kind === "movie" && movieKey(folder.title, folder.year) === movieKey(media.title, media.year) : media.kind === "episode" && showKey(folder.show) === showKey(media.show);

  type ShowFolder = { name: string; key: string; year: string | null; ids: string };

  const showFolders: ShowFolder[] = childrenOf(shows).flatMap((f) => (f.file_type === "FOLDER" ? [{ name: f.name, key: showKey(f.name), year: folderYear(f.name), ids: idsOf(f.name) }] : []));
  const showElsewhere = new Map<string, string>();

  for (const f of snapshot) {
    if (f.file_type !== "FOLDER" || !isUnder(f.path, shows) || isSeasonFolder(f.name)) continue;
    const direct = same(parentOf(f.path), shows);
    const identity = folderIdentity(f.name);
    const key = direct ? (identity && "show" in identity ? showKey(identity.show) : null) : showKey(f.name);

    if (key && !showElsewhere.has(key)) showElsewhere.set(key, f.path);
  }

  const movieFolders = snapshot.flatMap((f) => {
    const m = f.file_type === "FOLDER" && isUnder(f.path, movies) ? f.name.match(MOVIE_FOLDER) : null;

    return m ? [{ name: f.name, path: f.path, key: movieKey(m[1] ?? "", m[2] ?? ""), title: showKey(m[1] ?? ""), ids: idsOf(f.name) }] : [];
  });

  const looseMovieFolders = new Map(childrenOf(movies).flatMap((f) => (f.file_type === "FOLDER" && !MOVIE_FOLDER.test(f.name) && !folderIdentity(f.name) ? [[showKey(f.name), f.name]] : [])));

  const copiesInMovies = videosUnder(movies).flatMap((g) => {
    const own = parseMedia(g.name, now);
    const strict = nameOf(parentOf(g.path)).match(MOVIE_FOLDER);
    const release = folderIdentity(nameOf(parentOf(g.path)));
    const media = own?.kind === "movie" ? own : release && "kind" in release && release.kind === "movie" ? release : null;
    const key = strict ? movieKey(strict[1] ?? "", strict[2] ?? "") : media ? movieKey(media.title, media.year) : null;
    const pt = / - pt(\d+)\./i.exec(g.name)?.[1];

    return key ? [{ f: g, key, part: media?.part ?? (pt ? Number(pt) : null), edition: media?.edition ?? null, ext: extOf(g.name), folder: parentOf(g.path) }] : [];
  });

  const titlesSeen = new Map([
    ...allVideos.flatMap((v): Array<[string, string]> => {
      const m = parseMedia(v.f.name, now);

      return m?.kind === "movie" ? [[showKey(m.title), v.f.name]] : [];
    }),
    ...movieFolders.map((m): [string, string] => [m.title, m.name]),
  ]);

  const videos = allVideos.flatMap((v) => (!scope || isUnder(v.f.path, scope) ? [v.f] : [])).toSorted((a, b) => b.size - a.size || a.path.localeCompare(b.path));
  const plannedEpisodes = new Map<string, Array<{ first: number; last: number }>>();
  const plannedMovies = new Map<string, Array<{ part: number | null; edition: string | null; ext: string }>>();
  const createdMovies = new Map<string, string>();
  const changes: LayoutChange[] = [];
  const skipped: LayoutResult["skipped"] = [];
  let budget = MAX_CHANGES;
  let remaining = 0;

  const showFolderFor = (show: string, year: string | null, ids: string): { name: string } | { why: string } => {
    const key = showKey(show);
    const titledKey = year ? showKey(`${show} ${year}`) : null;
    const elsewhere = showElsewhere.get(key) ?? (titledKey ? showElsewhere.get(titledKey) : undefined);

    if (elsewhere) return { why: `${show} may already be in ${elsewhere}` };
    const titled = titledKey ? showFolders.filter((k) => k.key === titledKey) : [];
    const known = showFolders.filter((k) => k.key === key);
    const exact = known.filter((k) => k.year === year);

    if (titled.length > 0) return titled.length === 1 && titled[0]?.year === null && exact.length === 0 ? { name: titled[0].name } : { why: `can't tell if it belongs in ${titled[0]?.name ?? show}` };

    if (exact.length > 1) return { why: `can't tell which of ${exact.map((k) => k.name).join(" and ")} it belongs in` };
    const match = exact[0] && (year || known.length === 1) ? exact[0] : undefined;

    if (match) return match.ids && ids && match.ids !== idsOf(ids) ? { why: `${match.name} is tagged as another show` } : { name: match.name };
    const yearless = known.find((k) => k.year === null);

    if (year ? yearless : known.length > 0) return { why: `can't tell if it belongs in ${(yearless ?? known[0])?.name ?? show}` };
    const created = { name: showLabel(show, year), key, year, ids: "" };

    showFolders.push(created);

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

    if ([nameOf(target), nameOf(parentOf(target))].some((n) => new TextEncoder().encode(n).length > MAX_NAME_BYTES)) {
      skipped.push({ path: f.path, why: "its new name would be too long" });

      return false;
    }

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

  const fromReleaseFolder = (f: WalkedFile, parent: string, folder: Media | Pack | null) => {
    if (!folder || !("kind" in folder) || folder.kind !== "movie" || realVideos(childrenOf(parent)).length !== 1 || [scope, movies, shows, ""].some((p) => same(p, parent))) return null;
    const stem = stemOf(f.name);
    const words = showKey(beforeRelease(stem)).split(" ").filter(Boolean);
    const title = showKey(folder.title).split(" ");
    const folderWords = new Set(showKey(nameOf(parent)).split(" "));
    const named = ` ${words.join(" ")} `.includes(` ${title.join(" ")} `) && words.every((w) => title.includes(w) || folderWords.has(w));

    return named && !/\p{Nd}/u.test(beforeRelease(stem)) && !EPISODIC.test(stem) && !words.some((w) => !title.includes(w) && PART_WORD.test(w)) ? folder : null;
  };

  for (const f of videos) {
    const ext = extOf(f.name) || "mkv";
    const parent = parentOf(f.path);
    const parentName = nameOf(parent);

    if ((isUnder(f.path, shows) && !same(parent, shows)) || foldersOf(f.path).some(isSeasonFolder) || inExtras(f.path)) continue;

    if (foldersOf(f.path).some((d) => DISC_FOLDER.test(d))) {
      leave(f, "it sits in a disc folder");
      continue;
    }

    const pack = packOf(parentName, latest);
    const own = parseMedia(f.name, now, pack);

    if (own?.kind === "episode" && [parentName, nameOf(parentOf(parent))].some((dir) => dir && !packOf(dir, latest) && showKey(dir) === showKey(own.show))) continue;
    const movieFolder = parentName.match(MOVIE_FOLDER);

    if (movieFolder && !EPISODIC.test(f.name) && f.name.toLowerCase().startsWith(`${movieFolder[1]} (${movieFolder[2]})`.toLowerCase())) continue;
    const folder = folderIdentity(parentName);
    const media = own ?? (pack ? null : fromReleaseFolder(f, parent, folder));

    if (!media) {
      leave(f, "its name doesn't say which movie or episode it is");
      continue;
    }

    if (movieFolder && (media.kind !== "movie" || movieKey(movieFolder[1] ?? "", movieFolder[2] ?? "") !== movieKey(media.title, media.year))) {
      leave(f, `it sits in the folder of ${parentName}`);
      continue;
    }

    if (!movieFolder && isUnder(f.path, movies) && !same(parent, movies) && !(same(parentOf(parent), movies) && folder && matches(folder, media))) {
      leave(f, `it sits in ${parentName}, a folder of yours`);
      continue;
    }

    if (folder && !matches(folder, media)) {
      leave(f, `its name and its folder's name disagree`);
      continue;
    }

    if (media.kind === "episode") {
      const show = showFolderFor(media.show, media.year, media.ids);

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
    const lookalike = inPlace ? undefined : (titlesSeen.get(showKey(`${media.title} ${media.year}`)) ?? looseMovieFolders.get(showKey(media.title)) ?? looseMovieFolders.get(showKey(`${media.title} ${media.year}`)));

    if (lookalike) {
      leave(f, `can't tell if it's ${lookalike}`);
      continue;
    }

    const sibling = (c: (typeof copiesInMovies)[number]) => inPlace && media.part !== null && c.part !== null && c.part !== media.part && same(c.folder, parent) && c.ext === ext && c.edition === media.edition;
    const copy = copiesInMovies.find((c) => c.f.id !== f.id && c.key === key && !sibling(c));

    if (copy) {
      leave(f, `another copy is at ${copy.f.path}`);
      continue;
    }

    const homes = movieFolders.filter((m) => m.key === key && same(parentOf(m.path), movies));

    if (!inPlace && homes.length > 1) {
      leave(f, `can't tell which of ${homes.map((m) => m.name).join(" and ")} it belongs in`);
      continue;
    }

    if (!inPlace && homes[0]?.ids && media.ids && homes[0].ids !== idsOf(media.ids)) {
      leave(f, `${homes[0].name} is tagged as another movie`);
      continue;
    }

    const target = inPlace ? parent : `${movies}/${homes[0]?.name ?? createdMovies.get(key) ?? nameOf(parentOf(targetPath(media, ext, movies, shows)))}`;
    const existing = inPlace ? [] : videosUnder(target).filter((g) => g.id !== f.id);
    const arrivals = plannedMovies.get(pathKey(target)) ?? [];

    if (existing[0]) {
      leave(f, `${nameOf(target)} already has ${existing[0].name}`);
      continue;
    }

    if (arrivals.some((a) => !(media.part && a.part && a.part !== media.part && a.edition === media.edition && a.ext === ext))) {
      leave(f, `another copy of ${nameOf(target)} is in this plan`);
      continue;
    }

    if (place(f, `${target}/${nameOf(target).replace(TAGS, "").trim()}${movieSuffix(media)}.${ext}`)) {
      plannedMovies.set(pathKey(target), [...arrivals, { part: media.part, edition: media.edition, ext }]);
      createdMovies.set(key, nameOf(target));
    }
  }

  return { changes, skipped, remaining };
}
