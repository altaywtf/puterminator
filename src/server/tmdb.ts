import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type { Release } from "./opensubtitles";

const TMDB_API = "https://api.themoviedb.org/3";
const MAX_CHARACTERS = 30;

export type Facts = {
  readonly title: string;
  readonly year: number | null;
  readonly genres: ReadonlyArray<string>;
  readonly overview: string;
  readonly episode: { readonly title: string; readonly overview: string } | null;
  readonly characters: ReadonlyArray<{ readonly name: string; readonly played: "actress" | "actor" | null }>;
};

export type Tmdb = { readonly facts: (release: Release, imdbId: string | null) => Effect.Effect<Facts | null> };

const Credits = Schema.Struct({
  cast: Schema.optional(Schema.Array(Schema.Struct({ character: Schema.optional(Schema.NullOr(Schema.String)), gender: Schema.optional(Schema.NullOr(Schema.Finite)) }))),
  guest_stars: Schema.optional(Schema.Array(Schema.Struct({ character: Schema.optional(Schema.NullOr(Schema.String)), gender: Schema.optional(Schema.NullOr(Schema.Finite)) }))),
});

const Genres = Schema.optional(Schema.Array(Schema.Struct({ name: Schema.String })));

const decodeFind = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ movie_results: Schema.Array(Schema.Struct({ id: Schema.Finite })), tv_results: Schema.Array(Schema.Struct({ id: Schema.Finite })) })),
);

const decodeSearch = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ results: Schema.Array(Schema.Struct({ id: Schema.Finite, name: Schema.optional(Schema.String), title: Schema.optional(Schema.String) })) })),
);

const decodeShow = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ name: Schema.String, first_air_date: Schema.optional(Schema.NullOr(Schema.String)), overview: Schema.optional(Schema.NullOr(Schema.String)), genres: Genres })),
);

const decodeEpisode = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ name: Schema.optional(Schema.NullOr(Schema.String)), overview: Schema.optional(Schema.NullOr(Schema.String)), credits: Schema.optional(Credits) })),
);

const decodeMovie = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      title: Schema.String,
      release_date: Schema.optional(Schema.NullOr(Schema.String)),
      overview: Schema.optional(Schema.NullOr(Schema.String)),
      genres: Genres,
      credits: Schema.optional(Credits),
    }),
  ),
);

const normal = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
const yearOf = (date: string | null | undefined) => (date && /^\d{4}/.test(date) ? Number(date.slice(0, 4)) : null);

const PERFORMERS = new Map<number, "actress" | "actor">([
  [1, "actress"],
  [2, "actor"],
]);

const performerOf = (code: number | null | undefined) => (code == null ? null : (PERFORMERS.get(code) ?? null));

const charactersOf = (credits: typeof Credits.Type | undefined): Facts["characters"] => {
  const seen = new Set<string>();

  return [...(credits?.cast ?? []), ...(credits?.guest_stars ?? [])].flatMap((c) => {
    const name = (c.character ?? "").split(" / ")[0]?.replace(/\s*\((voice|uncredited)\)/gi, "").trim() ?? "";

    if (name === "" || seen.has(name) || seen.size >= MAX_CHARACTERS) return [];
    seen.add(name);

    return [{ name, played: performerOf(c.gender) }];
  });
};

export const makeTmdb = (token: Redacted.Redacted<string>, fetchImpl: typeof fetch): Tmdb => {
  const get = (path: string, query: Record<string, string> = {}) =>
    Effect.tryPromise({
      try: async (signal) => {
        const url = new URL(`${TMDB_API}${path}`);

        for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
        const res = await fetchImpl(url, { signal, headers: { Accept: "application/json", Authorization: `Bearer ${Redacted.value(token)}` } });

        return res.ok ? await res.text() : "";
      },
      catch: () => "",
    }).pipe(Effect.orElseSucceed(() => ""));

  const idOf = (release: Release, imdbId: string | null) =>
    Effect.gen(function* () {
      const tv = "season" in release;

      if (imdbId !== null) {
        const found = decodeFind(yield* get(`/find/${imdbId}`, { external_source: "imdb_id" }));
        const hit = Option.isSome(found) ? (tv ? found.value.tv_results : found.value.movie_results)[0] : undefined;

        if (hit) return hit.id;
      }

      const query = tv ? { query: release.title } : { query: release.title, year: String(release.year) };
      const results = Option.match(decodeSearch(yield* get(tv ? "/search/tv" : "/search/movie", query)), { onNone: () => [], onSome: (r) => r.results });

      return (results.find((r) => normal(r.name ?? r.title ?? "") === normal(release.title)) ?? results[0])?.id ?? null;
    });

  const facts = (release: Release, imdbId: string | null) =>
    Effect.gen(function* () {
      const id = yield* idOf(release, imdbId);

      if (id === null) return null;

      if (!("season" in release)) {
        const movie = decodeMovie(yield* get(`/movie/${id}`, { append_to_response: "credits" }));

        if (Option.isNone(movie)) return null;
        const m = movie.value;

        return { title: m.title, year: yearOf(m.release_date), genres: (m.genres ?? []).map((g) => g.name), overview: m.overview ?? "", episode: null, characters: charactersOf(m.credits) };
      }

      const show = decodeShow(yield* get(`/tv/${id}`));

      if (Option.isNone(show)) return null;
      const episode = decodeEpisode(yield* get(`/tv/${id}/season/${release.season}/episode/${release.episode}`, { append_to_response: "credits" }));
      const s = show.value;
      const e = Option.getOrNull(episode);

      return {
        title: s.name,
        year: yearOf(s.first_air_date),
        genres: (s.genres ?? []).map((g) => g.name),
        overview: s.overview ?? "",
        episode: e ? { title: e.name ?? "", overview: e.overview ?? "" } : null,
        characters: charactersOf(e?.credits),
      };
    });

  return { facts };
};
