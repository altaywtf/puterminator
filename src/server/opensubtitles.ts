import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { PutioFailed } from "./putio";

const OPENSUBTITLES_API = "https://api.opensubtitles.com";
const USER_AGENT = "puterminator v1";
const TOKEN_TTL_MS = 23 * 60 * 60 * 1000;
const MAX_PAGES = 3;

export type OpenSubtitlesCredentials = {
  readonly apiKey: Redacted.Redacted<string>;
  readonly username: string;
  readonly password: Redacted.Redacted<string>;
};

export type Release = { readonly title: string; readonly season: number; readonly episode: number } | { readonly title: string; readonly year: number };

export type Candidate = { readonly fileId: number; readonly release: string; readonly hearingImpaired: boolean; readonly downloads: number };

export type OpenSubtitles = {
  readonly search: (release: Release) => Effect.Effect<ReadonlyArray<Candidate>, PutioFailed>;
  readonly download: (fileId: number) => Effect.Effect<string, PutioFailed>;
};

const words = (text: string): ReadonlyArray<string> =>
  text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .match(/[\p{L}\p{N}]+/gu) ?? [];

const titleOf = (raw: string) => raw.replace(/[._]+/g, " ").replace(/[\s([-]+$/, "").trim();

const showOf = (raw: string) => {
  const title = titleOf(raw);
  const bare = title.replace(/[\s([-]*(?:19|20)\d{2}[)\]]?$/, "").trim();

  return bare === "" ? title : bare;
};

export const parseRelease = (fileName: string): Release | null => {
  const stem = fileName.replace(/\.[^.]+$/, "");
  const episode = stem.match(/^(.+?)[\s._-]+s(\d{1,2})[\s._-]?e(\d{1,3})(?!\d)/i) ?? stem.match(/^(.+?)[\s._-]+(\d{1,2})x(\d{2,3})(?!\d)/i);

  if (episode?.[1] && episode[2] && episode[3] && showOf(episode[1])) return { title: showOf(episode[1]), season: Number(episode[2]), episode: Number(episode[3]) };
  const movie = stem.match(/^(.+)[\s._([-]+((?:19|20)\d{2})(?!\d)/);

  if (movie?.[1] && movie[2] && titleOf(movie[1])) return { title: titleOf(movie[1]), year: Number(movie[2]) };

  return null;
};

const Feature = Schema.Struct({
  title: Schema.optional(Schema.NullOr(Schema.String)),
  parent_title: Schema.optional(Schema.NullOr(Schema.String)),
  season_number: Schema.optional(Schema.NullOr(Schema.Finite)),
  episode_number: Schema.optional(Schema.NullOr(Schema.Finite)),
  year: Schema.optional(Schema.NullOr(Schema.Finite)),
});

const Attributes = Schema.Struct({
  release: Schema.optional(Schema.NullOr(Schema.String)),
  hearing_impaired: Schema.optional(Schema.NullOr(Schema.Boolean)),
  ai_translated: Schema.optional(Schema.NullOr(Schema.Boolean)),
  machine_translated: Schema.optional(Schema.NullOr(Schema.Boolean)),
  foreign_parts_only: Schema.optional(Schema.NullOr(Schema.Boolean)),
  download_count: Schema.optional(Schema.NullOr(Schema.Finite)),
  feature_details: Schema.optional(Schema.NullOr(Feature)),
  files: Schema.Array(Schema.Struct({ file_id: Schema.Finite, file_name: Schema.optional(Schema.NullOr(Schema.String)) })),
});

const decodeSearch = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ total_pages: Schema.optional(Schema.NullOr(Schema.Finite)), data: Schema.Array(Schema.Struct({ attributes: Attributes })) })));
const decodeLogin = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ token: Schema.String, base_url: Schema.optional(Schema.NullOr(Schema.String)) })));
const decodeLink = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ link: Schema.String })));
const decodeQuota = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ reset_time: Schema.optional(Schema.NullOr(Schema.String)) })));

const sameTitle = (ours: string, theirs: string | null | undefined) => {
  const a = words(ours).join("");
  const b = words(theirs ?? "").join("");

  return a !== "" && a === b;
};

const isFor = (release: Release, feature: typeof Feature.Type | null | undefined) => {
  if (!feature) return false;

  if ("season" in release) return feature.season_number === release.season && feature.episode_number === release.episode && sameTitle(release.title, feature.parent_title);

  return sameTitle(release.title, feature.title) && (feature.year == null || Math.abs(feature.year - release.year) <= 1);
};

const searchParams = (release: Release, page: number) =>
  new URLSearchParams(
    [
      ...("season" in release
        ? [
            ["episode_number", String(release.episode)],
            ["season_number", String(release.season)],
            ["type", "episode"],
          ]
        : [
            ["type", "movie"],
            ["year", String(release.year)],
          ]),
      ["foreign_parts_only", "exclude"],
      ["languages", "en"],
      ["query", release.title.toLowerCase()],
      ...(page > 1 ? [["page", String(page)]] : []),
    ].toSorted(([a = ""], [b = ""]) => a.localeCompare(b)),
  );

const SOURCES: ReadonlyArray<ReadonlyArray<string>> = [["web", "webdl", "webrip"], ["bluray", "bdrip", "brrip"], ["hdtv"], ["dvdrip", "dvd"]];
const SERVICES = new Set(["amzn", "nf", "hulu", "dsnp", "hmax", "atvp", "pcok", "pmtp", "itunes", "bbc", "iplayer"]);
const RESOLUTIONS = new Set(["2160p", "1080p", "720p", "480p"]);

const sourceOf = (tokens: ReadonlyArray<string>) => SOURCES.findIndex((s) => tokens.some((t) => s.includes(t)));
const groupOf = (name: string) => name.replace(/\.[a-z0-9]{2,4}$/i, "").match(/-([a-z0-9]+)(?:\[[^\]]*\])?$/i)?.[1]?.toLowerCase() ?? null;

const affinity = (videoName: string, release: string) => {
  const ours = words(videoName.replace(/web[.\s-]?dl/gi, "webdl"));
  const theirs = words(release.replace(/web[.\s-]?dl/gi, "webdl"));
  const shared = (pick: (t: string) => boolean) => ours.some((t) => pick(t) && theirs.includes(t));
  const group = groupOf(videoName);
  let score = 0;

  if (group !== null && group === groupOf(release)) score += 8;

  if (sourceOf(ours) >= 0 && sourceOf(ours) === sourceOf(theirs)) score += 4;

  if (shared((t) => SERVICES.has(t))) score += 2;

  if (shared((t) => RESOLUTIONS.has(t))) score += 1;

  return score;
};

/** Best fit for this file first: same release group, then source, streaming service and resolution, then plain over hearing impaired, then popularity. */
export const rankCandidates = (videoName: string, candidates: ReadonlyArray<Candidate>) =>
  candidates
    .map((c) => ({ c, score: affinity(videoName, c.release) - (c.hearingImpaired ? 1 : 0) }))
    .toSorted((a, b) => b.score - a.score || b.c.downloads - a.c.downloads)
    .map(({ c }) => c);

const failed = (message: string) => new PutioFailed({ message, refused: true });

export const makeOpenSubtitles = (credentials: OpenSubtitlesCredentials, fetchImpl: typeof fetch): OpenSubtitles => {
  let session: { token: string; base: string; until: number } | null = null;
  const signingIn = Semaphore.makeUnsafe(1);

  const call = (url: string, init: RequestInit) =>
    Effect.tryPromise({
      try: async (signal) => {
        const res = await fetchImpl(url, { ...init, signal, headers: { "Api-Key": Redacted.value(credentials.apiKey), "User-Agent": USER_AGENT, Accept: "application/json", ...init.headers } });

        return { status: res.status, body: await res.text() };
      },
      catch: (e) => failed(`OpenSubtitles didn’t answer: ${e instanceof Error ? e.message : String(e)}`),
    });

  const login = signingIn.withPermit(Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;

    if (session !== null && session.until > now) return session;

    const res = yield* call(`${OPENSUBTITLES_API}/api/v1/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: credentials.username, password: Redacted.value(credentials.password) }),
    });

    const body = decodeLogin(res.body);

    if (res.status !== 200 || Option.isNone(body)) return yield* Effect.fail(failed(`OpenSubtitles sign-in failed (${res.status})`));
    session = { token: body.value.token, base: body.value.base_url ? `https://${body.value.base_url.replace(/^https?:\/\//, "")}` : OPENSUBTITLES_API, until: now + TOKEN_TTL_MS };

    return session;
  }));

  const search = (release: Release) =>
    Effect.gen(function* () {
      const found: Array<typeof Attributes.Type> = [];

      for (let page = 1, pages = 1; page <= Math.min(pages, MAX_PAGES); page++) {
        const res = yield* call(`${OPENSUBTITLES_API}/api/v1/subtitles?${searchParams(release, page).toString()}`, { method: "GET" });
        const body = decodeSearch(res.body);

        if (res.status !== 200 || Option.isNone(body)) return yield* Effect.fail(failed(`OpenSubtitles search failed (${res.status})`));
        found.push(...body.value.data.map((d) => d.attributes));
        pages = body.value.total_pages ?? 1;
      }

      return found.flatMap((a): Candidate[] => {
        const only = a.files.length === 1 ? a.files[0] : undefined;

        if (only === undefined || a.ai_translated || a.machine_translated || a.foreign_parts_only || !isFor(release, a.feature_details)) return [];

        return [{ fileId: only.file_id, release: a.release ?? only.file_name ?? "", hearingImpaired: a.hearing_impaired ?? false, downloads: a.download_count ?? 0 }];
      });
    });

  const download = (fileId: number) =>
    Effect.gen(function* () {
      const { token, base } = yield* login;

      const res = yield* call(`${base}/api/v1/download`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ file_id: fileId }),
      });

      if (res.status === 401) session = null;

      if (res.status === 406) {
        const reset = Option.flatMapNullishOr(decodeQuota(res.body), (q) => q.reset_time);

        return yield* Effect.fail(failed(`OpenSubtitles’ daily download limit is used up${Option.isSome(reset) ? `; it resets in ${reset.value}` : ""}`));
      }

      const link = decodeLink(res.body);

      if (res.status !== 200 || Option.isNone(link)) return yield* Effect.fail(failed(`OpenSubtitles download failed (${res.status})`));

      const file = yield* Effect.tryPromise({
        try: async (signal) => {
          const got = await fetchImpl(link.value.link, { signal, headers: { "User-Agent": USER_AGENT } });

          return { ok: got.ok, status: got.status, text: await got.text() };
        },
        catch: (e) => failed(`OpenSubtitles download failed: ${e instanceof Error ? e.message : String(e)}`),
      });

      if (!file.ok) return yield* Effect.fail(failed(`OpenSubtitles download failed (${file.status})`));

      return file.text;
    });

  return { search, download };
};
