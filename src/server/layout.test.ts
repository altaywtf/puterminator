import { describe, expect, it } from "vitest";
import { type LayoutResult, parseMedia, planLayout, targetPath } from "./layout";
import type { WalkedFile } from "./tree";

const NOW = Date.UTC(2026, 10, 3);

let id = 1;

const node = (path: string, over: Partial<WalkedFile> = {}): WalkedFile => {
  const name = path.slice(path.lastIndexOf("/") + 1);

  return {
    id: id++,
    parent_id: 0,
    name,
    path,
    depth: path.split("/").length - 1,
    size: 700 * 2 ** 20,
    file_type: /\.(mkv|mp4|avi)$/.test(name) ? "VIDEO" : name.includes(".") ? "FILE" : "FOLDER",
    content_type: null,
    extension: name.includes(".") ? (name.split(".").pop() ?? null) : null,
    crc32: null,
    created_at: "2026-01-01T00:00:00",
    first_accessed_at: null,
    ...over,
  };
};

const library = (...paths: Array<string | [string, Partial<WalkedFile>]>) => {
  const files = paths.map((p) => (Array.isArray(p) ? node(p[0], p[1]) : node(p)));
  const folders = new Map<string, WalkedFile>();

  for (const f of files)
    for (let dir = f.path.slice(0, f.path.lastIndexOf("/")); dir; dir = dir.slice(0, dir.lastIndexOf("/")))
      if (!folders.has(dir) && !files.some((g) => g.path === dir)) folders.set(dir, node(dir, { file_type: "FOLDER" }));

  const all = [...files, ...folders.values()];
  const idOf = new Map(all.map((f) => [f.path, f.id]));

  return all.map((f) => ({ ...f, parent_id: idOf.get(f.path.slice(0, f.path.lastIndexOf("/"))) ?? 0 }));
};

const plan = (files: WalkedFile[], movies = "/Movies", shows = "/TV Shows", within = ""): LayoutResult => {
  const out = planLayout(files, movies, shows, within, NOW);

  if ("error" in out) throw new Error(out.error);

  return out;
};

const moves = (r: LayoutResult) => r.changes.map((c) => [c.path, c.to]);

describe("parseMedia", () => {

  it("takes the last year before the release tags, so a year in the title stays in the title", () => {
    expect(parseMedia("Haze.1995.1080p.BluRay.x264-RIPGROVE.mkv", NOW)).toMatchObject({ title: "Haze", year: "1995" });
    expect(parseMedia("Brass.Courier.2049.2017.2160p.UHD.BluRay.x265.mkv", NOW)).toMatchObject({ title: "Brass Courier 2049", year: "2017" });
    expect(parseMedia("Winter.Widow.1984.2020.1080p.WEB-DL.mkv", NOW)).toMatchObject({ title: "Winter Widow 1984", year: "2020" });
    expect(parseMedia("2001.A.Lunar.Voyage.1968.1080p.mkv", NOW)).toMatchObject({ title: "2001 A Lunar Voyage", year: "1968" });
    expect(parseMedia("1846 (2019).mkv", NOW)).toMatchObject({ title: "1846", year: "2019" });
  });

  it("finds editions and disc parts only after the year, and skips 'Part N' it can't tell from a miniseries", () => {
    expect(parseMedia("Uncut.Opals.2019.1080p.mkv", NOW)).toMatchObject({ title: "Uncut Opals", edition: null });
    expect(parseMedia("The.Final.Cut.2004.mkv", NOW)).toMatchObject({ title: "The Final Cut", edition: null });
    expect(parseMedia("Brass Courier (1982) [Final Cut].mkv", NOW)).toMatchObject({ title: "Brass Courier", edition: "Final Cut" });
    expect(parseMedia("The.Mirrorbox.1999.CD2.avi", NOW)).toMatchObject({ title: "The Mirrorbox", part: 2 });
    expect(parseMedia("The.Mirrorbox.CD1.1999.DivX.avi", NOW)).toBeNull();
    expect(parseMedia("Chernovar.2019.Part.1.1080p.mkv", NOW)).toBeNull();
  });

  it("cleans tracker prefixes and keeps acronyms, hyphens, small words and editions readable", () => {
    expect(parseMedia("www.NoSuchTracker.com - Oberholtzer.2023.1080p.mkv", NOW)).toMatchObject({ title: "Oberholtzer" });
    expect(parseMedia("www.NoSuchTracker.com-Squid-Man.2002.1080p.mkv", NOW)).toMatchObject({ title: "Squid-Man", year: "2002" });
    expect(parseMedia("www.NoSuchTracker.com-The.Amazing.Squid-Man.2012.1080p.mkv", NOW)).toMatchObject({ title: "The Amazing Squid-Man", year: "2012" });
    expect(parseMedia("Back.to.the.Fortnight.1985.1080p.mkv", NOW)).toMatchObject({ title: "Back to the Fortnight", year: "1985" });
    expect(parseMedia("Kingdom.of.Gravel.2005.1080p.BluRay.Directors.Cut.x264-GRP.mkv", NOW)).toMatchObject({ title: "Kingdom of Gravel", edition: "Director's Cut" });
    expect(parseMedia("Exit.from.L.A.1996.1080p.mkv", NOW)).toMatchObject({ title: "Exit from L.A." });
    expect(parseMedia("S.W.A.T.2017.S05E10.1080p.WEB.mkv", NOW)).toMatchObject({ show: "S.W.A.T.", year: "2017" });
    expect(parseMedia("Mr. Nowhere (2009).mkv", NOW)).toMatchObject({ title: "Mr. Nowhere" });
  });

  it("takes a year up to next year as a release year, and a later number as part of the title", () => {
    expect(parseMedia("Film.2041.1080p.WEB-DL.mkv", Date.UTC(2040, 5, 1))).toMatchObject({ title: "Film", year: "2041" });
    expect(parseMedia("Haze.1995.2160p.WEB-DL.mkv", Date.UTC(1970, 0, 1))).toBeNull();
  });

  it("doesn't mistake codecs, numbered episodes, brackets or day-first dates for something else", () => {
    expect(parseMedia("Insomnar.2010.1080p.BluRay.DTS5.1x264-GRP.mkv", NOW)).toMatchObject({ kind: "movie", title: "Insomnar", year: "2010" });
    expect(parseMedia("[Wisp] Herder x Herder (2011) - 001.mkv", NOW)).toBeNull();
    expect(parseMedia("Planet Moss II (2016) - 01 - Islands.mkv", NOW)).toBeNull();
    expect(parseMedia("Chernovar.2019.E01.1080p.mkv", NOW)).toBeNull();
    expect(parseMedia("Haze [1995] [1080p].mkv", NOW)).toMatchObject({ title: "Haze", year: "1995" });
    expect(parseMedia("Haze (1995 Remastered) 1080p.mkv", NOW)).toMatchObject({ title: "Haze", edition: "Remastered" });
    expect(parseMedia("Abendblick.15.01.2024.mkv", NOW)).toBeNull();
    expect(parseMedia("Show.S01E01E03.1080p.mkv", NOW)).toBeNull();
    expect(parseMedia("Show.S01E01-720p.mkv", NOW)).toMatchObject({ first: 1, last: 1 });
    expect(parseMedia("Haze (1995)-clip.mkv", NOW)).toBeNull();
    expect(parseMedia("Alvex.1979.1080p.mkv ", NOW)).toBeNull();
    expect(parseMedia("Haze.1995.1080p.[2020].mkv", NOW)).toMatchObject({ title: "Haze", year: "1995" });
  });

  it("skips every name outside the shapes it knows instead of reading part of it", () => {
    for (const name of [
      "Show.2010.1x01.1080p.mkv",
      "Doctor Vale 1x01-1x02.mkv",
      "Show 1x01-2x02.mkv",
      "Show.S01E01-S02E02.mkv",
      "Show.1080p.WEB-DL.S01E01.mkv",
      "Movie.2020.Part.1.1080p.mkv",
      "Haze.1995.FRENCH.1080p.mkv",
      "Haze.1995-GRP.mkv",
      "The.Mirrorbox.1999.CD1.CD2.avi",
      "Chernovar.2019.1080p.WEB-DL.Part.1.mkv",
      "Planet.Moss.2006.1080p.BluRay.x264.E01.mkv",
      "The.Mirrorbox.1999.DVDRip.XviD-GRP.CD1.avi",
      "Pixel.Shorts.1984-2007.1080p.mkv",
      "Brass Courier (1982) [2007 Final Cut].mkv",
      "Gorgulon (Japan 1954).mkv",
      "[REC] 2 (2009).mkv",
      "Supervan [tmdbid-90002].mkv",
      "Alvexes (Special Edition) (1986).mkv",
      "Apogee.Now.1979.Final.Cut.2019.2160p.mkv",
      "The.Nightly.Desk.01.15.2024.720p.mkv",
      "Nextdoors.S01E2010.mkv",
      "Lull.S01E01-02-03.720p.mkv",
      "Flatmates.Season.1.S01E02.mkv",
      "[SubsMaybe] Fennelrow - 05 (2023).mkv",
      "The Cubicle (US 2005) - S01E01.mkv",
      "PWL.Slam.15th.Jan.2024.720p.WEBRip.mp4",
      "The.Nightly.Desk.March.14.2024.720p.mkv",
      "Band of Cousins Ep. 2 Week of Weeks (2001).mkv",
      "Lapinou - Épisode 3 (2021).mkv",
      "Planet.Moss.II.1of6.Islands.2016.1080p.mkv",
      "庆余年.第01集.2019.1080p.mp4",
      "【影视测试站】The.Drifting.Moon.2019.1080p.mkv",
      "NoSuchTracker.com - Haze.1995.1080p.mkv",
      "The.Groundskeeper.Trilogy.1972.-.1990.1080p.mkv",
      "Show.Name.S01E01.Part.One.1080p.mkv",
      "Show.S02E01-026.1080p.mkv",
      "Lull - S01E01 & 02 - Pilot.mkv",
      "Cowpoke_Bossa_-_05_(1998).mkv",
    ])
      expect(parseMedia(name, NOW), name).toBeNull();
  });

  it("reads single and multi-episode files, and skips what the episode number doesn't settle", () => {
    expect(parseMedia("The.Cubicle.US.S02E01.720p.HDTV.x264.mkv", NOW)).toEqual({ kind: "episode", show: "The Cubicle US", year: null, season: 2, first: 1, last: 1, ids: "" });
    expect(parseMedia("Doctor.Vale.2005.S01E01E02.mkv", NOW)).toMatchObject({ show: "Doctor Vale", year: "2005", first: 1, last: 2 });
    expect(parseMedia("Lull.S01E01-02.720p.mkv", NOW)).toMatchObject({ first: 1, last: 2 });
    expect(parseMedia("Sevenfold (2022) - S01E01 - Good News About Tuesday.mkv", NOW)).toMatchObject({ show: "Sevenfold", year: "2022", first: 1 });
    expect(parseMedia("1923.S01E01.mkv", NOW)).toMatchObject({ show: "1923", year: null });
    expect(parseMedia("Ghost.in.the.Kettle.SAC_2045.S01E01.mkv", NOW)).toMatchObject({ show: "Ghost in the Kettle SAC 2045", year: null });
    expect(parseMedia("Sevenfold — S01E02 — Half Circle.mkv", NOW)).toMatchObject({ show: "Sevenfold", season: 1, first: 2 });
    expect(parseMedia("Doctor.Vale.1963.S02E01.mkv", NOW, { show: "Doctor Vale", year: "2005", season: 2 })).toBeNull();
    expect(parseMedia("S03E04.1080p.mkv", NOW, { show: "Sevenfold", year: null, season: 3 })).toMatchObject({ show: "Sevenfold", season: 3, first: 4 });
    expect(parseMedia("S03E04.1080p.mkv", NOW, { show: "Sevenfold", year: null, season: 2 })).toBeNull();
    expect(parseMedia("S03E04.1080p.mkv", NOW)).toBeNull();
    expect(parseMedia("Gap.S01E01E02E04.mkv", NOW)).toBeNull();
    expect(parseMedia("Show.Name.S01E01.Part.1.mkv", NOW)).toBeNull();
    expect(parseMedia("The.Nightly.Desk.2024.01.15.720p.WEB.mkv", NOW)).toBeNull();
    expect(parseMedia("Haze (1995)-trailer.mkv", NOW)).toBeNull();
  });
});

describe("targetPath", () => {
  it("uses the folder and file names Plex, Infuse, Jellyfin and Kodi document", () => {
    expect(targetPath({ kind: "movie", title: "Haze", year: "1995", part: null, edition: null, ids: "" }, "mkv", "/Movies", "/TV Shows")).toBe("/Movies/Haze (1995)/Haze (1995).mkv");
    expect(targetPath({ kind: "movie", title: "The Mirrorbox", year: "1999", part: 2, edition: null, ids: "" }, "avi", "/Movies", "/TV")).toBe("/Movies/The Mirrorbox (1999)/The Mirrorbox (1999) - pt2.avi");
    expect(targetPath({ kind: "movie", title: "Brass Courier", year: "1982", part: null, edition: "Final Cut", ids: "" }, "mkv", "/Movies", "/TV")).toBe("/Movies/Brass Courier (1982)/Brass Courier (1982) {edition-Final Cut}.mkv");
    expect(targetPath({ kind: "episode", show: "Doctor Vale", year: "2005", season: 1, first: 1, last: 2, ids: "" }, "mkv", "/Movies", "/TV Shows")).toBe("/TV Shows/Doctor Vale (2005)/Season 01/Doctor Vale (2005) - S01E01-E02.mkv");
    expect(targetPath({ kind: "movie", title: "Mandate: Improbable", year: "1996", part: null, edition: null, ids: "" }, "mkv", "/Movies", "/TV")).toBe("/Movies/Mandate Improbable (1996)/Mandate Improbable (1996).mkv");
  });
});

describe("planLayout", () => {
  it("files a release folder's movie and renames a misnamed one in its own folder", () => {
    const r = plan(
      library(
        ["/Downloads/Haze.1995.1080p.BluRay.x264-RIPGROVE/Haze.1995.1080p.BluRay.x264-RIPGROVE.mkv", { size: 9 }],
        ["/Downloads/Haze.1995.1080p.BluRay.x264-RIPGROVE/haze-sample.mkv", { size: 1 }],
        ["/Movies/Alvex (1979)/alvex.1979.720p.mkv", { size: 8 }],
        ["/Courses/Intro.mp4", { size: 6 }],
      ),
    );

    expect(moves(r)).toEqual([
      ["/Downloads/Haze.1995.1080p.BluRay.x264-RIPGROVE/Haze.1995.1080p.BluRay.x264-RIPGROVE.mkv", "/Movies/Haze (1995)/Haze (1995).mkv"],
      ["/Movies/Alvex (1979)/alvex.1979.720p.mkv", "Alvex (1979).mkv"],
    ]);
    expect(r.skipped.map((s) => s.path)).toEqual(["/Courses/Intro.mp4"]);
  });

  it("leaves layouts that already comply alone: ID tags, editions, versions, Specials, 'Season 1', episode titles, dated shows", () => {
    const r = plan(
      library(
        "/Movies/Insomnar (2010) {imdb-tt9000002}/Insomnar (2010) {imdb-tt9000002}.mkv",
        "/Movies/Haze (1995) [imdbid-tt9000001]/Haze (1995) [imdbid-tt9000001].mkv",
        "/Movies/Brass Courier (1982)/Brass Courier (1982) - Theatrical.mkv",
        "/Movies/Brass Courier (1982)/Brass Courier (1982) - Director's Cut.mkv",
        "/Movies/The Groundskeeper Part 2 (1974)/The Groundskeeper Part 2 (1974).mkv",
        "/Movies/Brass Courier 2049 (2017)/Brass Courier 2049 (2017).mkv",
        "/TV Shows/The Fence {tvdb-90006}/Season 01/The Fence - S01E01.mkv",
        "/TV Shows/Doctor Vale (2005)/Specials/Doctor Vale (2005) - S00E01.mkv",
        "/TV Shows/Doctor Vale (2005)/Season 01/Doctor.Vale.S01E01.720p.mkv",
        "/TV Shows/Sevenfold/Season 1/Sevenfold - S01E01 - Good News About Tuesday.mkv",
        "/TV Shows/The Nightly Desk (1996)/Season 2024/The Nightly Desk (1996) - 2024-03-14.mkv",
      ),
    );

    expect(r.changes).toEqual([]);
  });

  it("joins a show folder only when the name and year settle it, apostrophes and title years included", () => {
    const r = plan(
      library(
        "/TV Shows/Doctor Vale (2005)/Season 01/Doctor Vale (2005) - S01E01.mkv",
        "/TV Shows/Gray's Almanac/Season 19/Gray's Almanac - S19E01.mkv",
        "/TV Shows/Station 1999/Season 01/Station 1999 - S01E01.mkv",
        ["/Downloads/Doctor.Vale.2005.S02E01.720p.mkv", { size: 9 }],
        ["/Downloads/Doctor.Vale.S26E01.mkv", { size: 8 }],
        ["/Downloads/Grays.Almanac.S20E01.1080p.mkv", { size: 7 }],
        ["/Downloads/Station.1999.S01E02.mkv", { size: 6 }],
        ["/Downloads/Bulwark.Gemini.2003.S01E01.mkv", { size: 3 }],
        ["/Downloads/Bulwark.Gemini.S01E02.mkv", { size: 2 }],
      ),
    );

    expect(moves(r).map(([, to]) => to)).toEqual([
      "/TV Shows/Doctor Vale (2005)/Season 02/Doctor Vale (2005) - S02E01.mkv",
      "/TV Shows/Gray's Almanac/Season 20/Gray's Almanac - S20E01.mkv",
      "/TV Shows/Station 1999/Season 01/Station 1999 - S01E02.mkv",
      "/TV Shows/Bulwark Gemini (2003)/Season 01/Bulwark Gemini (2003) - S01E01.mkv",
    ]);
    expect(r.skipped).toEqual([
      { path: "/Downloads/Doctor.Vale.S26E01.mkv", why: "can't tell if it belongs in Doctor Vale (2005)" },
      { path: "/Downloads/Bulwark.Gemini.S01E02.mkv", why: "can't tell if it belongs in Bulwark Gemini (2003)" },
    ]);
  });

  it("names bare episodes only from a show and season folder or a season pack, never from any parent folder", () => {
    const r = plan(
      library(
        ["/Downloads/S03E04.1080p.mkv", { size: 9 }],
        ["/Downloads/Burning.Low.S01.1080p.BluRay.x264-RAFTERS/s01e01.mkv", { size: 8 }],
        ["/Downloads/Burning.Low.S01.1080p.BluRay.x264-RAFTERS/s02e01.mkv", { size: 8 }],
        ["/TV Shows/Planet Moss (2006)/01 From Bog to Bog.mkv", { size: 7 }],
        ["/TV Shows/Planet Moss (2006)/02 Mountains.mkv", { size: 6 }],
        ["/Courses/Photography (2020)/lesson.mp4", { size: 5 }],
      ),
    );

    expect(moves(r)).toEqual([["/Downloads/Burning.Low.S01.1080p.BluRay.x264-RAFTERS/s01e01.mkv", "/TV Shows/Burning Low/Season 01/Burning Low - S01E01.mkv"]]);
    expect(r.skipped.map((s) => s.path)).toEqual([
      "/Downloads/S03E04.1080p.mkv",
      "/Downloads/Burning.Low.S01.1080p.BluRay.x264-RAFTERS/s02e01.mkv",
      "/Courses/Photography (2020)/lesson.mp4",
    ]);
  });

  it("skips a second copy instead of failing the plan: other extensions, case variants, an episode or movie already in place", () => {
    const r = plan(
      library(
        ["/a/Haze.1995.1080p.mkv", { size: 9 }],
        "/a/Haze.1995.1080p.srt",
        ["/b/Haze.1995.720p.mp4", { size: 3 }],
        "/b/Haze.1995.720p.srt",
        ["/Movies/Alvex (1979) {imdb-tt9000005}/Alvex (1979) {imdb-tt9000005}.mkv", { size: 8 }],
        ["/Downloads/Alvex.1979.1080p.BluRay/Alvex.1979.1080p.BluRay.mkv", { size: 7 }],
        ["/TV Shows/Sevenfold/Season 1/Sevenfold - S01E01.mkv", { size: 1 }],
        ["/Downloads/Sevenfold.S01E01.1080p.mkv", { size: 6 }],
        ["/Downloads/Sevenfold.S01E02.1080p.mkv", { size: 5 }],
      ),
    );

    expect(moves(r)).toEqual([
      ["/a/Haze.1995.1080p.mkv", "/Movies/Haze (1995)/Haze (1995).mkv"],
      ["/Downloads/Sevenfold.S01E02.1080p.mkv", "/TV Shows/Sevenfold/Season 1/Sevenfold - S01E02.mkv"],
    ]);
    expect(r.skipped.map((s) => s.path)).toEqual(["/Downloads/Alvex.1979.1080p.BluRay/Alvex.1979.1080p.BluRay.mkv", "/Downloads/Sevenfold.S01E01.1080p.mkv", "/b/Haze.1995.720p.mp4"]);
  });

  it("matches roots case-insensitively, rejects '/' roots and a missing scope, and only looks inside the scope", () => {
    const files = library("/Movies/Haze (1995)/Haze (1995).mkv", "/Downloads/Alvex.1979.mkv", "/Other/Memora.2000.mkv");

    expect(plan(files, "/movies", "/tv shows").changes.map((c) => c.to)).toEqual(["/Movies/Alvex (1979)/Alvex (1979).mkv", "/Movies/Memora (2000)/Memora (2000).mkv"]);
    expect(plan(files, "/Movies", "/TV Shows", "/downloads").changes.map((c) => c.path)).toEqual(["/Downloads/Alvex.1979.mkv"]);
    expect(planLayout(files, "/", "/TV Shows", "", NOW)).toHaveProperty("error");
    expect(planLayout(files, "/Movies", "/TV Shows", "/Nope", NOW)).toHaveProperty("error");
    expect(planLayout(files, "/Media", "/media/", "", NOW)).toHaveProperty("error");
    expect(plan(library("/movies/notes.txt", "/Movies/Haze (1995)/Haze (1995).mkv", "/Downloads/Alvex.1979.mkv")).changes.map((c) => c.to)).toEqual(["/Movies/Alvex (1979)/Alvex (1979).mkv"]);
    expect(plan(library("/Media/TV Shows/Lull/Season 01/Lull - S01E01.mkv", "/Downloads/Lull.S01E02.mkv", "/Downloads/Haze.1995.mkv"), " /media/movies ", "/media/ TV Shows /").changes.map((c) => c.to)).toEqual([
      "/Media/movies/Haze (1995)/Haze (1995).mkv",
      "/Media/TV Shows/Lull/Season 01/Lull - S01E02.mkv",
    ]);
  });

  it("never moves episodes out of a show folder, flat or nested, or anything under a season folder", () => {
    const r = plan(
      library(
        "/TV Shows/Chernovar (2019)/Chernovar (2019) - S01E01.mkv",
        "/Downloads/Sevenfold (2022)/Sevenfold (2022) - S01E01 - Good News About Tuesday.mkv",
        "/TV Shows/Kids/Blippo/Season 01/Blippo - S01E01.mkv",
        "/Downloads/Season 1/Burning.Low.S01E01.720p.mkv",
        "/Movies/Sci-Fi/Alvex (1979)/Alvex (1979).mkv",
      ),
    );

    expect(r.changes).toEqual([]);
  });

  it("keeps remakes apart by year and skips a yearless episode when two shows share its name", () => {
    const r = plan(
      library(
        "/TV Shows/Doctor Vale (2005)/Season 01/Doctor Vale (2005) - S01E01.mkv",
        "/TV Shows/Bulwark Gemini (1978)/Season 01/Bulwark Gemini (1978) - S01E01.mkv",
        "/TV Shows/Bulwark Gemini (2003)/Season 01/Bulwark Gemini (2003) - S01E01.mkv",
        ["/Downloads/Doctor.Vale.1963.S26E01.Bramblefield.mkv", { size: 9 }],
        ["/Downloads/Bulwark.Gemini.2003.S02E05.mkv", { size: 8 }],
        ["/Downloads/Bulwark.Gemini.S03E01.mkv", { size: 7 }],
      ),
    );

    expect(moves(r).map(([, to]) => to)).toEqual([
      "/TV Shows/Doctor Vale (1963)/Season 26/Doctor Vale (1963) - S26E01.mkv",
      "/TV Shows/Bulwark Gemini (2003)/Season 02/Bulwark Gemini (2003) - S02E05.mkv",
    ]);
    expect(r.skipped.map((s) => s.why)).toEqual(["can't tell if it belongs in Bulwark Gemini (1978)"]);
  });

  it("names episodes in a season pack from the pack, year included, and never files a pack's lone video as a movie", () => {
    const r = plan(
      library(
        "/TV Shows/Doctor Vale (2005)/Season 01/Doctor Vale (2005) - S01E01.mkv",
        ["/Downloads/Doctor.Vale.2005.S02.1080p.BluRay.x264/s02e01.mkv", { size: 9 }],
        ["/Downloads/Doctor.Vale.2005.S03.1080p.BluRay.x264/doctor.vale.e01.mkv", { size: 8 }],
      ),
    );

    expect(moves(r)).toEqual([["/Downloads/Doctor.Vale.2005.S02.1080p.BluRay.x264/s02e01.mkv", "/TV Shows/Doctor Vale (2005)/Season 02/Doctor Vale (2005) - S02E01.mkv"]]);
    expect(r.skipped.map((s) => s.path)).toEqual(["/Downloads/Doctor.Vale.2005.S03.1080p.BluRay.x264/doctor.vale.e01.mkv"]);
  });

  it("joins existing movie folders whatever the punctuation, keeps one folder for case variants, and keeps ID tags", () => {
    const r = plan(
      library(
        ["/Movies/Otter's Eleven (2001)/Otters.Eleven.2001.1080p.BluRay.x264.mkv", { size: 9 }],
        ["/Downloads/The.Mirrorbox.1999.CD1.avi", { size: 8 }],
        ["/Downloads/The.mirrorbox.1999.CD2.avi", { size: 7 }],
        ["/Downloads/Insomnar (2010) {tmdb-90001}.mkv", { size: 6 }],
      ),
    );

    expect(moves(r).map(([, to]) => to)).toEqual([
      "Otter's Eleven (2001).mkv",
      "/Movies/The Mirrorbox (1999)/The Mirrorbox (1999) - pt1.avi",
      "/Movies/The Mirrorbox (1999)/The Mirrorbox (1999) - pt2.avi",
      "/Movies/Insomnar (2010) {tmdb-90001}/Insomnar (2010).mkv",
    ]);
  });

  it("skips an episode already in its season folder under another name", () => {
    const r = plan(
      library(
        "/TV Shows/Sevenfold (2022)/Season 01/Sevenfold (2022) - S01E01 - Good News About Tuesday.mkv",
        "/Downloads/Sevenfold.2022.S01E01.2160p.WEB-DL.mkv",
      ),
    );

    expect(r.changes).toEqual([]);
    expect(r.skipped[0]?.why).toBe("S01E01 is already in Sevenfold (2022)");
  });

  it("leaves shows it can't add to safely: flat folders, episodes it can't read, ranges that overlap, in the library or the plan", () => {
    const r = plan(
      library(
        "/TV Shows/Sevenfold/Sevenfold - S01E01.mkv",
        "/TV Shows/Blippo/Season 01/01 - Magic Kazoo.mkv",
        "/TV Shows/Lull/Season 01/Lull - S01E01-E02.mkv",
        ["/Downloads/Sevenfold.S01E02.mkv", { size: 9 }],
        ["/Downloads/Blippo.S01E02.mkv", { size: 8 }],
        ["/Downloads/Lull.S01E02.mkv", { size: 7 }],
        ["/Downloads/Lull.S01E03.mkv", { size: 6 }],
        ["/Downloads/Lull.S02E01E02.mkv", { size: 5 }],
        ["/Downloads/Lull.S02E02.720p.mkv", { size: 4 }],
      ),
    );

    expect(moves(r).map(([, to]) => to)).toEqual(["/TV Shows/Lull/Season 01/Lull - S01E03.mkv", "/TV Shows/Lull/Season 02/Lull - S02E01-E02.mkv"]);
    expect(r.skipped.map((s) => s.why)).toEqual([
      "Sevenfold keeps episodes outside season folders",
      "can't tell which episodes Season 01 of Blippo already has",
      "S01E02 is already in Lull",
      "S02E02 is already in Lull",
    ]);
  });

  it("never touches anything under a show folder or a folder of the user's under the movies root", () => {
    const r = plan(
      library(
        "/TV Shows/Station 1999/Station.1999.S01E01.mkv",
        "/TV Shows/Farlow/Season 01/Farlow.2014.1080p.mkv",
        "/TV Shows/Sevenfold.S01E01.1080p.mkv",
        "/Movies/Sci-Fi/Haze.1995.1080p.mkv",
        "/Movies/Alvex (1979)/Alvexes.1986.1080p.mkv",
        "/Movies/Sci-Fi/Brass Courier (1982)/brass.courier.1982.final.cut.mkv",
      ),
    );

    expect(moves(r)).toEqual([
      ["/Movies/Sci-Fi/Brass Courier (1982)/brass.courier.1982.final.cut.mkv", "Brass Courier (1982) {edition-Final Cut}.mkv"],
      ["/TV Shows/Sevenfold.S01E01.1080p.mkv", "/TV Shows/Sevenfold/Season 01/Sevenfold - S01E01.mkv"],
    ]);
    expect(r.skipped).toEqual([
      { path: "/Movies/Alvex (1979)/Alvexes.1986.1080p.mkv", why: "it sits in the folder of Alvex (1979)" },
      { path: "/Movies/Sci-Fi/Haze.1995.1080p.mkv", why: "it sits in Sci-Fi, a folder of yours" },
    ]);
  });

  it("keeps out of folders it can't vouch for: quality and genre folders, collections, a release folder's odd file, a pack's stray show", () => {
    const r = plan(
      library(
        "/Movies/4K/Haze.1995.2160p.UHD.BluRay.x265-GRP.mkv",
        "/Movies/Kids/Blippo.S01E01.1080p.WEB.mkv",
        "/Movies/Sci-Fi/Alvex.1979.1080p.BluRay.x264-GRP/Alvex.1979.1080p.BluRay.x264-GRP.mkv",
        "/Movies/Alvex (1979) & Alvexes (1986)/Alvex.1979.1080p.BluRay.mkv",
        "/Downloads/Haze.1995.1080p.BluRay.x264-GRP/Crosswind.mkv",
        "/Downloads/Burning.Low.S01.720p.BluRay.x264-RAFTERS/rafters-s01e01.mkv",
      ),
    );

    expect(r.changes).toEqual([]);
    expect(r.skipped.map((s) => s.path).toSorted()).toEqual([
      "/Downloads/Burning.Low.S01.720p.BluRay.x264-RAFTERS/rafters-s01e01.mkv",
      "/Downloads/Haze.1995.1080p.BluRay.x264-GRP/Crosswind.mkv",
      "/Movies/4K/Haze.1995.2160p.UHD.BluRay.x265-GRP.mkv",
      "/Movies/Alvex (1979) & Alvexes (1986)/Alvex.1979.1080p.BluRay.mkv",
      "/Movies/Kids/Blippo.S01E01.1080p.WEB.mkv",
      "/Movies/Sci-Fi/Alvex.1979.1080p.BluRay.x264-GRP/Alvex.1979.1080p.BluRay.x264-GRP.mkv",
    ]);
  });

  it("doesn't add to a show it can't read whole: a title year, two folders for a season, a pack inside, a nested copy, an accented twin", () => {
    const r = plan(
      library(
        "/TV Shows/Station 1999 (1975)/Season 01/Station 1999 (1975) - S01E01.mkv",
        "/TV Shows/Lull/Season 1/Lull - S01E01.mkv",
        "/TV Shows/Lull/Season 01/Lull - S01E02.mkv",
        "/TV Shows/Dross/Dross.S01.1080p.NF.WEB-DL/Dross.S01E02.1080p.NF.WEB-DL.mkv",
        "/TV Shows/Farlow/Season 01/Farlow.S01E01.720p.HDTV/Farlow.S01E01.720p.HDTV.mkv",
        "/TV Shows/Plimérix (1997)/Season 01/Plimérix (1997) - S01E01.mkv",
        ["/Downloads/Station.1999.S01E02.mkv", { size: 9 }],
        ["/Downloads/Lull.S01E03.mkv", { size: 8 }],
        ["/Downloads/Dross.S01E03.mkv", { size: 7 }],
        ["/Downloads/Farlow.S01E01.1080p.mkv", { size: 6 }],
        ["/Downloads/Plimerix.S02E01.mkv", { size: 5 }],
      ),
    );

    expect(r.changes).toEqual([]);
    expect(r.skipped.map((s) => s.why)).toEqual([
      "can't tell if it belongs in Station 1999 (1975)",
      "Lull has more than one folder for season 1",
      "Dross keeps episodes outside season folders",
      "S01E01 is already in Farlow",
      "can't tell if it belongs in Plimérix (1997)",
    ]);
  });

  it("doesn't start a second folder for a movie the library may already have, or stack parts onto another copy", () => {
    const r = plan(
      library(
        "/Movies/Winter Widow 1984 (2020)/Winter Widow 1984 (2020).mkv",
        "/Movies/Haze [1995]/poster.jpg",
        "/Movies/The Mirrorbox (1999)/The Mirrorbox (1999) - pt1.avi",
        "/Movies/Aurélie (2001)/Aurélie (2001).mkv",
        ["/Downloads/Winter.Widow.1984.1080p.WEB-DL.mkv", { size: 9 }],
        ["/Downloads/Haze.1995.1080p.BluRay.mkv", { size: 8 }],
        ["/Downloads/The.Mirrorbox.1999.CD2.mkv", { size: 7 }],
        ["/Downloads/Aure\u0301lie.2001.1080p.mkv", { size: 6 }],
        ["/Downloads/Sump.2004.1080p.mkv", { size: 5 }],
        ["/Downloads/Sump.2004.CD1.avi", { size: 4 }],
      ),
    );

    expect(moves(r)).toEqual([["/Downloads/Sump.2004.1080p.mkv", "/Movies/Sump (2004)/Sump (2004).mkv"]]);
    expect(r.skipped.map((s) => s.why)).toEqual([
      "can't tell if it's Winter Widow 1984 (2020)",
      "can't tell if it's Haze [1995]",
      "another copy is at /Movies/The Mirrorbox (1999)/The Mirrorbox (1999) - pt1.avi",
      "another copy is at /Movies/Aurélie (2001)/Aurélie (2001).mkv",
      "another copy of Sump (2004) is in this plan",
    ]);
  });

  it("trusts a folder's name only when it names the same thing as the file: no collections, rival titles, pilots in packs, disc or sample folders", () => {
    const r = plan(
      library(
        "/Movies/Awards 2024 4K/Oberholtzer.2023.2160p.UHD.BluRay.x265-GRP.mkv",
        "/Downloads/1846.2019.1080p.BluRay.x264-FLINTS/flints-1846-1080p.mkv",
        "/Downloads/Shadwell.S01.1080p.BluRay.x264-GRP/Shadwell.Unaired.Pilot.2010.1080p.BluRay.x264-GRP.mkv",
        "/Downloads/Alvex.1979.1080p.BluRay.x264-GRP/alvex.revival.mkv",
        "/Downloads/Haze.1995.DVDRip.XviD-GRP/CD1/Haze.1995.DVDRip.XviD-GRP.avi",
        "/Downloads/Haze.1995.2160p.UHD.BluRay.REMUX-GRP/Sample/haze.1995.2160p.remux-grp.mkv",
        "/Downloads/Burning.Low.Complete.Season.1.1080p.BluRay/s01e01.mkv",
      ),
    );

    expect(r.changes).toEqual([]);
  });

  it("keeps out of show folders that are tagged, doubled or nested elsewhere", () => {
    const r = plan(
      library(
        "/TV Shows/Doctor Vale [2005]/Season 01/Doctor Vale - S01E01.mkv",
        "/TV Shows/Lull (2004)/Season 01/Lull (2004) - S01E01.mkv",
        "/TV Shows/Lull (2004) {tvdb-90005}/Season 02/Lull (2004) - S02E01.mkv",
        "/TV Shows/Kids/Blippo (2018)/Season 01/Blippo (2018) - S01E01.mkv",
        "/TV Shows/Burning.Low.S01.720p.BluRay.x264-DECREE/Burning.Low.S01E02.720p.BluRay.x264-DECREE.mkv",
        "/TV Shows/The Cubicle {tvdb-90004}/Season 01/The Cubicle - S01E01.mkv",
        ["/Downloads/Doctor.Vale.S26E01.mkv", { size: 9 }],
        ["/Downloads/Lull.2004.S01E03.mkv", { size: 8 }],
        ["/Downloads/Blippo.2018.S01E02.mkv", { size: 7 }],
        ["/Downloads/Burning.Low.S01E03.1080p.WEB.mkv", { size: 6 }],
        ["/Downloads/The Cubicle {tvdb-90003} - S01E02.mkv", { size: 5 }],
      ),
    );

    expect(r.changes).toEqual([]);
    expect(r.skipped.map((s) => s.path).toSorted()).toEqual([
      "/Downloads/Blippo.2018.S01E02.mkv",
      "/Downloads/Burning.Low.S01E03.1080p.WEB.mkv",
      "/Downloads/Doctor.Vale.S26E01.mkv",
      "/Downloads/Lull.2004.S01E03.mkv",
      "/Downloads/The Cubicle {tvdb-90003} - S01E02.mkv",
    ]);
  });

  it("keeps out of movie folders that are tagged as another film, doubled, or already hold a copy elsewhere, and reads title years across the plan", () => {
    const r = plan(
      library(
        "/Movies/Pipkin (2022) {imdb-tt9000004}/poster.jpg",
        "/Movies/Haze (1995)/poster.jpg",
        "/Movies/Haze (1995) {imdb-tt9000001}/poster.jpg",
        "/Movies/Sci-Fi/Alvex (1979)/Alvex (1979).mkv",
        "/Movies/The Mirrorbox (1999)/The Mirrorbox (1999).mkv",
        "/Movies/The Mirrorbox (1999)/the.mirrorbox.1999.cd2.avi",
        ["/Downloads/Pipkin (2022) {imdb-tt9000003}.mkv", { size: 20 }],
        ["/Downloads/Haze.1995.720p.WEB.mkv", { size: 19 }],
        ["/Downloads/Alvex.1979.1080p.mkv", { size: 18 }],
        ["/Downloads/Dust.Rally.2000.1975.1080p.mkv", { size: 9 }],
        ["/Downloads/Dust.Rally.2000.720p.mkv", { size: 10 }],
        ["/Downloads/Alvexes.1986.CD1.DVDRip.XviD-GRP.avi", { size: 7 }],
        ["/Downloads/Alvexes.1986.Special.Edition.CD2.DVDRip.XviD-GRP.avi", { size: 6 }],
        ["/Downloads/Haze.1986.CD1.DVDRip.avi", { size: 5 }],
        ["/Downloads/Haze.1986.CD2.720p.mkv", { size: 4 }],
      ),
    );

    expect(moves(r).map(([, to]) => to)).toEqual([
      "/Movies/Dust Rally 2000 (1975)/Dust Rally 2000 (1975).mkv",
      "/Movies/Alvexes (1986)/Alvexes (1986) - pt1.avi",
      "/Movies/Haze (1986)/Haze (1986) - pt1.avi",
    ]);
    expect(r.skipped.map((s) => s.path)).toEqual([
      "/Movies/The Mirrorbox (1999)/the.mirrorbox.1999.cd2.avi",
      "/Downloads/Pipkin (2022) {imdb-tt9000003}.mkv",
      "/Downloads/Haze.1995.720p.WEB.mkv",
      "/Downloads/Alvex.1979.1080p.mkv",
      "/Downloads/Dust.Rally.2000.720p.mkv",
      "/Downloads/Alvexes.1986.Special.Edition.CD2.DVDRip.XviD-GRP.avi",
      "/Downloads/Haze.1986.CD2.720p.mkv",
    ]);
  });

  it("skips a video whose new name would pass 255 bytes", () => {
    const r = plan(library(`/Downloads/${"Wordsmith.".repeat(26)}Tale.2019.1080p.mkv`));

    expect(r.skipped.map((s) => s.why)).toEqual(["its new name would be too long"]);
  });

  it("skips a video whose subtitles differ only in case, since both would get one name", () => {
    const r = plan(library("/Downloads/Haze.1995.1080p.mkv", ["/Downloads/Haze.1995.1080p.en.srt", { file_type: "TEXT" }], ["/Downloads/haze.1995.1080p.EN.srt", { file_type: "TEXT" }]));

    expect(r.skipped).toEqual([{ path: "/Downloads/Haze.1995.1080p.mkv", why: "its subtitles would land on other files" }]);
  });

  it("names a lone video from its release folder only when its own name says nothing", () => {
    const r = plan(
      library(
        ["/Downloads/Haze.1995.1080p.BluRay.x264-GRP/grp-haze.mkv", { size: 9 }],
        ["/Downloads/Movie.2020.1080p.WEB-DL/Movie.2020.Part.1.mkv", { size: 8 }],
        ["/Downloads/Show.S01.1080p.WEB-DL/show.mkv", { size: 7 }],
      ),
    );

    expect(moves(r)).toEqual([["/Downloads/Haze.1995.1080p.BluRay.x264-GRP/grp-haze.mkv", "/Movies/Haze (1995)/Haze (1995).mkv"]]);
    expect(r.skipped.map((s) => s.path)).toEqual(["/Downloads/Movie.2020.1080p.WEB-DL/Movie.2020.Part.1.mkv", "/Downloads/Show.S01.1080p.WEB-DL/show.mkv"]);
  });

  it("counts subtitles against the 200-change cap", () => {
    const files = library(...Array.from({ length: 80 }, (_, i): Array<[string, Partial<WalkedFile>]> => [
      [`/Dump/Film ${i} 2001.mkv`, { size: 1000 - i }],
      [`/Dump/Film ${i} 2001.en.srt`, {}],
      [`/Dump/Film ${i} 2001.fr.srt`, {}],
    ]).flat());

    const r = plan(files);

    expect(r.changes).toHaveLength(66);
    expect(r.remaining).toBe(14);
  });
});
