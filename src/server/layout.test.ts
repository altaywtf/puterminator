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
    expect(parseMedia("Heat.1995.1080p.BluRay.x264-RARBG.mkv", NOW)).toMatchObject({ title: "Heat", year: "1995" });
    expect(parseMedia("Blade.Runner.2049.2017.2160p.UHD.BluRay.x265.mkv", NOW)).toMatchObject({ title: "Blade Runner 2049", year: "2017" });
    expect(parseMedia("Wonder.Woman.1984.2020.1080p.WEB-DL.mkv", NOW)).toMatchObject({ title: "Wonder Woman 1984", year: "2020" });
    expect(parseMedia("2001.A.Space.Odyssey.1968.1080p.mkv", NOW)).toMatchObject({ title: "2001 A Space Odyssey", year: "1968" });
    expect(parseMedia("1917 (2019).mkv", NOW)).toMatchObject({ title: "1917", year: "2019" });
  });

  it("finds editions and disc parts only after the year, and skips 'Part N' it can't tell from a miniseries", () => {
    expect(parseMedia("Uncut.Gems.2019.1080p.mkv", NOW)).toMatchObject({ title: "Uncut Gems", edition: null });
    expect(parseMedia("The.Final.Cut.2004.mkv", NOW)).toMatchObject({ title: "The Final Cut", edition: null });
    expect(parseMedia("Blade Runner (1982) [Final Cut].mkv", NOW)).toMatchObject({ title: "Blade Runner", edition: "Final Cut" });
    expect(parseMedia("The.Matrix.1999.CD2.avi", NOW)).toMatchObject({ title: "The Matrix", part: 2 });
    expect(parseMedia("The.Matrix.CD1.1999.DivX.avi", NOW)).toBeNull();
    expect(parseMedia("Chernobyl.2019.Part.1.1080p.mkv", NOW)).toBeNull();
  });

  it("cleans tracker prefixes and keeps acronyms, hyphens, small words and editions readable", () => {
    expect(parseMedia("www.Torrenting.com - Oppenheimer.2023.1080p.mkv", NOW)).toMatchObject({ title: "Oppenheimer" });
    expect(parseMedia("www.Torrenting.com-Spider-Man.2002.1080p.mkv", NOW)).toMatchObject({ title: "Spider-Man", year: "2002" });
    expect(parseMedia("www.Torrenting.com-The.Amazing.Spider-Man.2012.1080p.mkv", NOW)).toMatchObject({ title: "The Amazing Spider-Man", year: "2012" });
    expect(parseMedia("Back.to.the.Future.1985.1080p.mkv", NOW)).toMatchObject({ title: "Back to the Future", year: "1985" });
    expect(parseMedia("Kingdom.of.Heaven.2005.1080p.BluRay.Directors.Cut.x264-GRP.mkv", NOW)).toMatchObject({ title: "Kingdom of Heaven", edition: "Director's Cut" });
    expect(parseMedia("Escape.from.L.A.1996.1080p.mkv", NOW)).toMatchObject({ title: "Escape from L.A." });
    expect(parseMedia("S.W.A.T.2017.S05E10.1080p.WEB.mkv", NOW)).toMatchObject({ show: "S.W.A.T.", year: "2017" });
    expect(parseMedia("Mr. Nobody (2009).mkv", NOW)).toMatchObject({ title: "Mr. Nobody" });
  });

  it("takes a year up to next year as a release year, and a later number as part of the title", () => {
    expect(parseMedia("Film.2041.1080p.WEB-DL.mkv", Date.UTC(2040, 5, 1))).toMatchObject({ title: "Film", year: "2041" });
    expect(parseMedia("Heat.1995.2160p.WEB-DL.mkv", Date.UTC(1970, 0, 1))).toBeNull();
  });

  it("doesn't mistake codecs, numbered episodes, brackets or day-first dates for something else", () => {
    expect(parseMedia("Inception.2010.1080p.BluRay.DTS5.1x264-GRP.mkv", NOW)).toMatchObject({ kind: "movie", title: "Inception", year: "2010" });
    expect(parseMedia("[Judas] Hunter x Hunter (2011) - 001.mkv", NOW)).toBeNull();
    expect(parseMedia("Planet Earth II (2016) - 01 - Islands.mkv", NOW)).toBeNull();
    expect(parseMedia("Chernobyl.2019.E01.1080p.mkv", NOW)).toBeNull();
    expect(parseMedia("Heat [1995] [1080p].mkv", NOW)).toMatchObject({ title: "Heat", year: "1995" });
    expect(parseMedia("Heat (1995 Remastered) 1080p.mkv", NOW)).toMatchObject({ title: "Heat", edition: "Remastered" });
    expect(parseMedia("Tagesschau.15.01.2024.mkv", NOW)).toBeNull();
    expect(parseMedia("Show.S01E01E03.1080p.mkv", NOW)).toBeNull();
    expect(parseMedia("Show.S01E01-720p.mkv", NOW)).toMatchObject({ first: 1, last: 1 });
    expect(parseMedia("Heat (1995)-clip.mkv", NOW)).toBeNull();
    expect(parseMedia("Alien.1979.1080p.mkv ", NOW)).toBeNull();
    expect(parseMedia("Heat.1995.1080p.[2020].mkv", NOW)).toMatchObject({ title: "Heat", year: "1995" });
  });

  it("skips every name outside the shapes it knows instead of reading part of it", () => {
    for (const name of [
      "Show.2010.1x01.1080p.mkv",
      "Doctor Who 1x01-1x02.mkv",
      "Show 1x01-2x02.mkv",
      "Show.S01E01-S02E02.mkv",
      "Show.1080p.WEB-DL.S01E01.mkv",
      "Movie.2020.Part.1.1080p.mkv",
      "Heat.1995.FRENCH.1080p.mkv",
      "Heat.1995-GRP.mkv",
      "The.Matrix.1999.CD1.CD2.avi",
      "Chernobyl.2019.1080p.WEB-DL.Part.1.mkv",
      "Planet.Earth.2006.1080p.BluRay.x264.E01.mkv",
      "The.Matrix.1999.DVDRip.XviD-GRP.CD1.avi",
      "Pixar.Shorts.1984-2007.1080p.mkv",
      "Blade Runner (1982) [2007 Final Cut].mkv",
      "Godzilla (Japan 1954).mkv",
      "[REC] 2 (2009).mkv",
      "Superman [tmdbid-1924].mkv",
      "Aliens (Special Edition) (1986).mkv",
      "Apocalypse.Now.1979.Final.Cut.2019.2160p.mkv",
      "The.Daily.Show.01.15.2024.720p.mkv",
      "Neighbours.S01E2010.mkv",
      "Lost.S01E01-02-03.720p.mkv",
      "Friends.Season.1.S01E02.mkv",
      "[SubsPlease] Frieren - 05 (2023).mkv",
      "The Office (US 2005) - S01E01.mkv",
      "WWE.Raw.15th.Jan.2024.720p.WEBRip.mp4",
      "The.Daily.Show.March.14.2024.720p.mkv",
      "Band of Brothers Ep. 2 Day of Days (2001).mkv",
      "Lupin - Épisode 3 (2021).mkv",
      "Planet.Earth.II.1of6.Islands.2016.1080p.mkv",
      "庆余年.第01集.2019.1080p.mp4",
      "【高清影视之家】The.Wandering.Earth.2019.1080p.mkv",
      "Torrenting.com - Heat.1995.1080p.mkv",
      "The.Godfather.Trilogy.1972.-.1990.1080p.mkv",
      "Show.Name.S01E01.Part.One.1080p.mkv",
      "Show.S02E01-026.1080p.mkv",
      "Lost - S01E01 & 02 - Pilot.mkv",
      "Cowboy_Bebop_-_05_(1998).mkv",
    ])
      expect(parseMedia(name, NOW), name).toBeNull();
  });

  it("reads single and multi-episode files, and skips what the episode number doesn't settle", () => {
    expect(parseMedia("The.Office.US.S02E01.720p.HDTV.x264.mkv", NOW)).toEqual({ kind: "episode", show: "The Office US", year: null, season: 2, first: 1, last: 1, ids: "" });
    expect(parseMedia("Doctor.Who.2005.S01E01E02.mkv", NOW)).toMatchObject({ show: "Doctor Who", year: "2005", first: 1, last: 2 });
    expect(parseMedia("Lost.S01E01-02.720p.mkv", NOW)).toMatchObject({ first: 1, last: 2 });
    expect(parseMedia("Severance (2022) - S01E01 - Good News About Hell.mkv", NOW)).toMatchObject({ show: "Severance", year: "2022", first: 1 });
    expect(parseMedia("1923.S01E01.mkv", NOW)).toMatchObject({ show: "1923", year: null });
    expect(parseMedia("Ghost.in.the.Shell.SAC_2045.S01E01.mkv", NOW)).toMatchObject({ show: "Ghost in the Shell SAC 2045", year: null });
    expect(parseMedia("Severance — S01E02 — Half Loop.mkv", NOW)).toMatchObject({ show: "Severance", season: 1, first: 2 });
    expect(parseMedia("Doctor.Who.1963.S02E01.mkv", NOW, { show: "Doctor Who", year: "2005", season: 2 })).toBeNull();
    expect(parseMedia("S03E04.1080p.mkv", NOW, { show: "Severance", year: null, season: 3 })).toMatchObject({ show: "Severance", season: 3, first: 4 });
    expect(parseMedia("S03E04.1080p.mkv", NOW, { show: "Severance", year: null, season: 2 })).toBeNull();
    expect(parseMedia("S03E04.1080p.mkv", NOW)).toBeNull();
    expect(parseMedia("Gap.S01E01E02E04.mkv", NOW)).toBeNull();
    expect(parseMedia("Show.Name.S01E01.Part.1.mkv", NOW)).toBeNull();
    expect(parseMedia("The.Daily.Show.2024.01.15.720p.WEB.mkv", NOW)).toBeNull();
    expect(parseMedia("Heat (1995)-trailer.mkv", NOW)).toBeNull();
  });
});

describe("targetPath", () => {
  it("uses the folder and file names Plex, Infuse, Jellyfin and Kodi document", () => {
    expect(targetPath({ kind: "movie", title: "Heat", year: "1995", part: null, edition: null, ids: "" }, "mkv", "/Movies", "/TV Shows")).toBe("/Movies/Heat (1995)/Heat (1995).mkv");
    expect(targetPath({ kind: "movie", title: "The Matrix", year: "1999", part: 2, edition: null, ids: "" }, "avi", "/Movies", "/TV")).toBe("/Movies/The Matrix (1999)/The Matrix (1999) - pt2.avi");
    expect(targetPath({ kind: "movie", title: "Blade Runner", year: "1982", part: null, edition: "Final Cut", ids: "" }, "mkv", "/Movies", "/TV")).toBe("/Movies/Blade Runner (1982)/Blade Runner (1982) {edition-Final Cut}.mkv");
    expect(targetPath({ kind: "episode", show: "Doctor Who", year: "2005", season: 1, first: 1, last: 2, ids: "" }, "mkv", "/Movies", "/TV Shows")).toBe("/TV Shows/Doctor Who (2005)/Season 01/Doctor Who (2005) - S01E01-E02.mkv");
    expect(targetPath({ kind: "movie", title: "Mission: Impossible", year: "1996", part: null, edition: null, ids: "" }, "mkv", "/Movies", "/TV")).toBe("/Movies/Mission Impossible (1996)/Mission Impossible (1996).mkv");
  });
});

describe("planLayout", () => {
  it("files a release folder's movie and renames a misnamed one in its own folder", () => {
    const r = plan(
      library(
        ["/Downloads/Heat.1995.1080p.BluRay.x264-RARBG/Heat.1995.1080p.BluRay.x264-RARBG.mkv", { size: 9 }],
        ["/Downloads/Heat.1995.1080p.BluRay.x264-RARBG/heat-sample.mkv", { size: 1 }],
        ["/Movies/Alien (1979)/alien.1979.720p.mkv", { size: 8 }],
        ["/Courses/Intro.mp4", { size: 6 }],
      ),
    );

    expect(moves(r)).toEqual([
      ["/Downloads/Heat.1995.1080p.BluRay.x264-RARBG/Heat.1995.1080p.BluRay.x264-RARBG.mkv", "/Movies/Heat (1995)/Heat (1995).mkv"],
      ["/Movies/Alien (1979)/alien.1979.720p.mkv", "Alien (1979).mkv"],
    ]);
    expect(r.skipped.map((s) => s.path)).toEqual(["/Courses/Intro.mp4"]);
  });

  it("leaves layouts that already comply alone: ID tags, editions, versions, Specials, 'Season 1', episode titles, dated shows", () => {
    const r = plan(
      library(
        "/Movies/Inception (2010) {imdb-tt1375666}/Inception (2010) {imdb-tt1375666}.mkv",
        "/Movies/Heat (1995) [imdbid-tt0113277]/Heat (1995) [imdbid-tt0113277].mkv",
        "/Movies/Blade Runner (1982)/Blade Runner (1982) - Theatrical.mkv",
        "/Movies/Blade Runner (1982)/Blade Runner (1982) - Director's Cut.mkv",
        "/Movies/The Godfather Part 2 (1974)/The Godfather Part 2 (1974).mkv",
        "/Movies/Blade Runner 2049 (2017)/Blade Runner 2049 (2017).mkv",
        "/TV Shows/The Wire {tvdb-79126}/Season 01/The Wire - S01E01.mkv",
        "/TV Shows/Doctor Who (2005)/Specials/Doctor Who (2005) - S00E01.mkv",
        "/TV Shows/Doctor Who (2005)/Season 01/Doctor.Who.S01E01.720p.mkv",
        "/TV Shows/Severance/Season 1/Severance - S01E01 - Good News About Hell.mkv",
        "/TV Shows/The Daily Show (1996)/Season 2024/The Daily Show (1996) - 2024-03-14.mkv",
      ),
    );

    expect(r.changes).toEqual([]);
  });

  it("joins a show folder only when the name and year settle it, apostrophes and title years included", () => {
    const r = plan(
      library(
        "/TV Shows/Doctor Who (2005)/Season 01/Doctor Who (2005) - S01E01.mkv",
        "/TV Shows/Grey's Anatomy/Season 19/Grey's Anatomy - S19E01.mkv",
        "/TV Shows/Space 1999/Season 01/Space 1999 - S01E01.mkv",
        ["/Downloads/Doctor.Who.2005.S02E01.720p.mkv", { size: 9 }],
        ["/Downloads/Doctor.Who.S26E01.mkv", { size: 8 }],
        ["/Downloads/Greys.Anatomy.S20E01.1080p.mkv", { size: 7 }],
        ["/Downloads/Space.1999.S01E02.mkv", { size: 6 }],
        ["/Downloads/Battlestar.Galactica.2003.S01E01.mkv", { size: 3 }],
        ["/Downloads/Battlestar.Galactica.S01E02.mkv", { size: 2 }],
      ),
    );

    expect(moves(r).map(([, to]) => to)).toEqual([
      "/TV Shows/Doctor Who (2005)/Season 02/Doctor Who (2005) - S02E01.mkv",
      "/TV Shows/Grey's Anatomy/Season 20/Grey's Anatomy - S20E01.mkv",
      "/TV Shows/Space 1999/Season 01/Space 1999 - S01E02.mkv",
      "/TV Shows/Battlestar Galactica (2003)/Season 01/Battlestar Galactica (2003) - S01E01.mkv",
    ]);
    expect(r.skipped).toEqual([
      { path: "/Downloads/Doctor.Who.S26E01.mkv", why: "can't tell if it belongs in Doctor Who (2005)" },
      { path: "/Downloads/Battlestar.Galactica.S01E02.mkv", why: "can't tell if it belongs in Battlestar Galactica (2003)" },
    ]);
  });

  it("names bare episodes only from a show and season folder or a season pack, never from any parent folder", () => {
    const r = plan(
      library(
        ["/Downloads/S03E04.1080p.mkv", { size: 9 }],
        ["/Downloads/Breaking.Bad.S01.1080p.BluRay.x264-ROVERS/s01e01.mkv", { size: 8 }],
        ["/Downloads/Breaking.Bad.S01.1080p.BluRay.x264-ROVERS/s02e01.mkv", { size: 8 }],
        ["/TV Shows/Planet Earth (2006)/01 From Pole to Pole.mkv", { size: 7 }],
        ["/TV Shows/Planet Earth (2006)/02 Mountains.mkv", { size: 6 }],
        ["/Courses/Photography (2020)/lesson.mp4", { size: 5 }],
      ),
    );

    expect(moves(r)).toEqual([["/Downloads/Breaking.Bad.S01.1080p.BluRay.x264-ROVERS/s01e01.mkv", "/TV Shows/Breaking Bad/Season 01/Breaking Bad - S01E01.mkv"]]);
    expect(r.skipped.map((s) => s.path)).toEqual([
      "/Downloads/S03E04.1080p.mkv",
      "/Downloads/Breaking.Bad.S01.1080p.BluRay.x264-ROVERS/s02e01.mkv",
      "/Courses/Photography (2020)/lesson.mp4",
    ]);
  });

  it("skips a second copy instead of failing the plan: other extensions, case variants, an episode or movie already in place", () => {
    const r = plan(
      library(
        ["/a/Heat.1995.1080p.mkv", { size: 9 }],
        "/a/Heat.1995.1080p.srt",
        ["/b/Heat.1995.720p.mp4", { size: 3 }],
        "/b/Heat.1995.720p.srt",
        ["/Movies/Alien (1979) {imdb-tt0078748}/Alien (1979) {imdb-tt0078748}.mkv", { size: 8 }],
        ["/Downloads/Alien.1979.1080p.BluRay/Alien.1979.1080p.BluRay.mkv", { size: 7 }],
        ["/TV Shows/Severance/Season 1/Severance - S01E01.mkv", { size: 1 }],
        ["/Downloads/Severance.S01E01.1080p.mkv", { size: 6 }],
        ["/Downloads/Severance.S01E02.1080p.mkv", { size: 5 }],
      ),
    );

    expect(moves(r)).toEqual([
      ["/a/Heat.1995.1080p.mkv", "/Movies/Heat (1995)/Heat (1995).mkv"],
      ["/Downloads/Severance.S01E02.1080p.mkv", "/TV Shows/Severance/Season 1/Severance - S01E02.mkv"],
    ]);
    expect(r.skipped.map((s) => s.path)).toEqual(["/Downloads/Alien.1979.1080p.BluRay/Alien.1979.1080p.BluRay.mkv", "/Downloads/Severance.S01E01.1080p.mkv", "/b/Heat.1995.720p.mp4"]);
  });

  it("matches roots case-insensitively, rejects '/' roots and a missing scope, and only looks inside the scope", () => {
    const files = library("/Movies/Heat (1995)/Heat (1995).mkv", "/Downloads/Alien.1979.mkv", "/Other/Memento.2000.mkv");

    expect(plan(files, "/movies", "/tv shows").changes.map((c) => c.to)).toEqual(["/Movies/Alien (1979)/Alien (1979).mkv", "/Movies/Memento (2000)/Memento (2000).mkv"]);
    expect(plan(files, "/Movies", "/TV Shows", "/downloads").changes.map((c) => c.path)).toEqual(["/Downloads/Alien.1979.mkv"]);
    expect(planLayout(files, "/", "/TV Shows", "", NOW)).toHaveProperty("error");
    expect(planLayout(files, "/Movies", "/TV Shows", "/Nope", NOW)).toHaveProperty("error");
    expect(planLayout(files, "/Media", "/media/", "", NOW)).toHaveProperty("error");
    expect(plan(library("/movies/notes.txt", "/Movies/Heat (1995)/Heat (1995).mkv", "/Downloads/Alien.1979.mkv")).changes.map((c) => c.to)).toEqual(["/Movies/Alien (1979)/Alien (1979).mkv"]);
    expect(plan(library("/Media/TV Shows/Lost/Season 01/Lost - S01E01.mkv", "/Downloads/Lost.S01E02.mkv", "/Downloads/Heat.1995.mkv"), " /media/movies ", "/media/ TV Shows /").changes.map((c) => c.to)).toEqual([
      "/Media/movies/Heat (1995)/Heat (1995).mkv",
      "/Media/TV Shows/Lost/Season 01/Lost - S01E02.mkv",
    ]);
  });

  it("never moves episodes out of a show folder, flat or nested, or anything under a season folder", () => {
    const r = plan(
      library(
        "/TV Shows/Chernobyl (2019)/Chernobyl (2019) - S01E01.mkv",
        "/Downloads/Severance (2022)/Severance (2022) - S01E01 - Good News About Hell.mkv",
        "/TV Shows/Kids/Bluey/Season 01/Bluey - S01E01.mkv",
        "/Downloads/Season 1/Breaking.Bad.S01E01.720p.mkv",
        "/Movies/Sci-Fi/Alien (1979)/Alien (1979).mkv",
      ),
    );

    expect(r.changes).toEqual([]);
  });

  it("keeps remakes apart by year and skips a yearless episode when two shows share its name", () => {
    const r = plan(
      library(
        "/TV Shows/Doctor Who (2005)/Season 01/Doctor Who (2005) - S01E01.mkv",
        "/TV Shows/Battlestar Galactica (1978)/Season 01/Battlestar Galactica (1978) - S01E01.mkv",
        "/TV Shows/Battlestar Galactica (2003)/Season 01/Battlestar Galactica (2003) - S01E01.mkv",
        ["/Downloads/Doctor.Who.1963.S26E01.Battlefield.mkv", { size: 9 }],
        ["/Downloads/Battlestar.Galactica.2003.S02E05.mkv", { size: 8 }],
        ["/Downloads/Battlestar.Galactica.S03E01.mkv", { size: 7 }],
      ),
    );

    expect(moves(r).map(([, to]) => to)).toEqual([
      "/TV Shows/Doctor Who (1963)/Season 26/Doctor Who (1963) - S26E01.mkv",
      "/TV Shows/Battlestar Galactica (2003)/Season 02/Battlestar Galactica (2003) - S02E05.mkv",
    ]);
    expect(r.skipped.map((s) => s.why)).toEqual(["can't tell if it belongs in Battlestar Galactica (1978)"]);
  });

  it("names episodes in a season pack from the pack, year included, and never files a pack's lone video as a movie", () => {
    const r = plan(
      library(
        "/TV Shows/Doctor Who (2005)/Season 01/Doctor Who (2005) - S01E01.mkv",
        ["/Downloads/Doctor.Who.2005.S02.1080p.BluRay.x264/s02e01.mkv", { size: 9 }],
        ["/Downloads/Doctor.Who.2005.S03.1080p.BluRay.x264/doctor.who.e01.mkv", { size: 8 }],
      ),
    );

    expect(moves(r)).toEqual([["/Downloads/Doctor.Who.2005.S02.1080p.BluRay.x264/s02e01.mkv", "/TV Shows/Doctor Who (2005)/Season 02/Doctor Who (2005) - S02E01.mkv"]]);
    expect(r.skipped.map((s) => s.path)).toEqual(["/Downloads/Doctor.Who.2005.S03.1080p.BluRay.x264/doctor.who.e01.mkv"]);
  });

  it("joins existing movie folders whatever the punctuation, keeps one folder for case variants, and keeps ID tags", () => {
    const r = plan(
      library(
        ["/Movies/Ocean's Eleven (2001)/Oceans.Eleven.2001.1080p.BluRay.x264.mkv", { size: 9 }],
        ["/Downloads/The.Matrix.1999.CD1.avi", { size: 8 }],
        ["/Downloads/The.matrix.1999.CD2.avi", { size: 7 }],
        ["/Downloads/Inception (2010) {tmdb-27205}.mkv", { size: 6 }],
      ),
    );

    expect(moves(r).map(([, to]) => to)).toEqual([
      "Ocean's Eleven (2001).mkv",
      "/Movies/The Matrix (1999)/The Matrix (1999) - pt1.avi",
      "/Movies/The Matrix (1999)/The Matrix (1999) - pt2.avi",
      "/Movies/Inception (2010) {tmdb-27205}/Inception (2010).mkv",
    ]);
  });

  it("skips an episode already in its season folder under another name", () => {
    const r = plan(
      library(
        "/TV Shows/Severance (2022)/Season 01/Severance (2022) - S01E01 - Good News About Hell.mkv",
        "/Downloads/Severance.2022.S01E01.2160p.WEB-DL.mkv",
      ),
    );

    expect(r.changes).toEqual([]);
    expect(r.skipped[0]?.why).toBe("S01E01 is already in Severance (2022)");
  });

  it("leaves shows it can't add to safely: flat folders, episodes it can't read, ranges that overlap, in the library or the plan", () => {
    const r = plan(
      library(
        "/TV Shows/Severance/Severance - S01E01.mkv",
        "/TV Shows/Bluey/Season 01/01 - Magic Xylophone.mkv",
        "/TV Shows/Lost/Season 01/Lost - S01E01-E02.mkv",
        ["/Downloads/Severance.S01E02.mkv", { size: 9 }],
        ["/Downloads/Bluey.S01E02.mkv", { size: 8 }],
        ["/Downloads/Lost.S01E02.mkv", { size: 7 }],
        ["/Downloads/Lost.S01E03.mkv", { size: 6 }],
        ["/Downloads/Lost.S02E01E02.mkv", { size: 5 }],
        ["/Downloads/Lost.S02E02.720p.mkv", { size: 4 }],
      ),
    );

    expect(moves(r).map(([, to]) => to)).toEqual(["/TV Shows/Lost/Season 01/Lost - S01E03.mkv", "/TV Shows/Lost/Season 02/Lost - S02E01-E02.mkv"]);
    expect(r.skipped.map((s) => s.why)).toEqual([
      "Severance keeps episodes outside season folders",
      "can't tell which episodes Season 01 of Bluey already has",
      "S01E02 is already in Lost",
      "S02E02 is already in Lost",
    ]);
  });

  it("never touches anything under a show folder or a folder of the user's under the movies root", () => {
    const r = plan(
      library(
        "/TV Shows/Space 1999/Space.1999.S01E01.mkv",
        "/TV Shows/Fargo/Season 01/Fargo.2014.1080p.mkv",
        "/TV Shows/Severance.S01E01.1080p.mkv",
        "/Movies/Sci-Fi/Heat.1995.1080p.mkv",
        "/Movies/Alien (1979)/Aliens.1986.1080p.mkv",
        "/Movies/Sci-Fi/Blade Runner (1982)/blade.runner.1982.final.cut.mkv",
      ),
    );

    expect(moves(r)).toEqual([
      ["/Movies/Sci-Fi/Blade Runner (1982)/blade.runner.1982.final.cut.mkv", "Blade Runner (1982) {edition-Final Cut}.mkv"],
      ["/TV Shows/Severance.S01E01.1080p.mkv", "/TV Shows/Severance/Season 01/Severance - S01E01.mkv"],
    ]);
    expect(r.skipped).toEqual([
      { path: "/Movies/Alien (1979)/Aliens.1986.1080p.mkv", why: "it sits in the folder of Alien (1979)" },
      { path: "/Movies/Sci-Fi/Heat.1995.1080p.mkv", why: "it sits in Sci-Fi, a folder of yours" },
    ]);
  });

  it("keeps out of folders it can't vouch for: quality and genre folders, collections, a release folder's odd file, a pack's stray show", () => {
    const r = plan(
      library(
        "/Movies/4K/Heat.1995.2160p.UHD.BluRay.x265-GRP.mkv",
        "/Movies/Kids/Bluey.S01E01.1080p.WEB.mkv",
        "/Movies/Sci-Fi/Alien.1979.1080p.BluRay.x264-GRP/Alien.1979.1080p.BluRay.x264-GRP.mkv",
        "/Movies/Alien (1979) & Aliens (1986)/Alien.1979.1080p.BluRay.mkv",
        "/Downloads/Heat.1995.1080p.BluRay.x264-GRP/Collateral.mkv",
        "/Downloads/Breaking.Bad.S01.720p.BluRay.x264-ROVERS/rovers-s01e01.mkv",
      ),
    );

    expect(r.changes).toEqual([]);
    expect(r.skipped.map((s) => s.path).toSorted()).toEqual([
      "/Downloads/Breaking.Bad.S01.720p.BluRay.x264-ROVERS/rovers-s01e01.mkv",
      "/Downloads/Heat.1995.1080p.BluRay.x264-GRP/Collateral.mkv",
      "/Movies/4K/Heat.1995.2160p.UHD.BluRay.x265-GRP.mkv",
      "/Movies/Alien (1979) & Aliens (1986)/Alien.1979.1080p.BluRay.mkv",
      "/Movies/Kids/Bluey.S01E01.1080p.WEB.mkv",
      "/Movies/Sci-Fi/Alien.1979.1080p.BluRay.x264-GRP/Alien.1979.1080p.BluRay.x264-GRP.mkv",
    ]);
  });

  it("doesn't add to a show it can't read whole: a title year, two folders for a season, a pack inside, a nested copy, an accented twin", () => {
    const r = plan(
      library(
        "/TV Shows/Space 1999 (1975)/Season 01/Space 1999 (1975) - S01E01.mkv",
        "/TV Shows/Lost/Season 1/Lost - S01E01.mkv",
        "/TV Shows/Lost/Season 01/Lost - S01E02.mkv",
        "/TV Shows/Dark/Dark.S01.1080p.NF.WEB-DL/Dark.S01E02.1080p.NF.WEB-DL.mkv",
        "/TV Shows/Fargo/Season 01/Fargo.S01E01.720p.HDTV/Fargo.S01E01.720p.HDTV.mkv",
        "/TV Shows/Pokémon (1997)/Season 01/Pokémon (1997) - S01E01.mkv",
        ["/Downloads/Space.1999.S01E02.mkv", { size: 9 }],
        ["/Downloads/Lost.S01E03.mkv", { size: 8 }],
        ["/Downloads/Dark.S01E03.mkv", { size: 7 }],
        ["/Downloads/Fargo.S01E01.1080p.mkv", { size: 6 }],
        ["/Downloads/Pokemon.S02E01.mkv", { size: 5 }],
      ),
    );

    expect(r.changes).toEqual([]);
    expect(r.skipped.map((s) => s.why)).toEqual([
      "can't tell if it belongs in Space 1999 (1975)",
      "Lost has more than one folder for season 1",
      "Dark keeps episodes outside season folders",
      "S01E01 is already in Fargo",
      "can't tell if it belongs in Pokémon (1997)",
    ]);
  });

  it("doesn't start a second folder for a movie the library may already have, or stack parts onto another copy", () => {
    const r = plan(
      library(
        "/Movies/Wonder Woman 1984 (2020)/Wonder Woman 1984 (2020).mkv",
        "/Movies/Heat [1995]/poster.jpg",
        "/Movies/The Matrix (1999)/The Matrix (1999) - pt1.avi",
        "/Movies/Amélie (2001)/Amélie (2001).mkv",
        ["/Downloads/Wonder.Woman.1984.1080p.WEB-DL.mkv", { size: 9 }],
        ["/Downloads/Heat.1995.1080p.BluRay.mkv", { size: 8 }],
        ["/Downloads/The.Matrix.1999.CD2.mkv", { size: 7 }],
        ["/Downloads/Ame\u0301lie.2001.1080p.mkv", { size: 6 }],
        ["/Downloads/Saw.2004.1080p.mkv", { size: 5 }],
        ["/Downloads/Saw.2004.CD1.avi", { size: 4 }],
      ),
    );

    expect(moves(r)).toEqual([["/Downloads/Saw.2004.1080p.mkv", "/Movies/Saw (2004)/Saw (2004).mkv"]]);
    expect(r.skipped.map((s) => s.why)).toEqual([
      "can't tell if it's Wonder Woman 1984 (2020)",
      "can't tell if it's Heat [1995]",
      "another copy is at /Movies/The Matrix (1999)/The Matrix (1999) - pt1.avi",
      "another copy is at /Movies/Amélie (2001)/Amélie (2001).mkv",
      "another copy of Saw (2004) is in this plan",
    ]);
  });

  it("trusts a folder's name only when it names the same thing as the file: no collections, rival titles, pilots in packs, disc or sample folders", () => {
    const r = plan(
      library(
        "/Movies/Oscars 2024 4K/Oppenheimer.2023.2160p.UHD.BluRay.x265-GRP.mkv",
        "/Downloads/1917.2019.1080p.BluRay.x264-SPARKS/sparks-1917-1080p.mkv",
        "/Downloads/Sherlock.S01.1080p.BluRay.x264-GRP/Sherlock.Unaired.Pilot.2010.1080p.BluRay.x264-GRP.mkv",
        "/Downloads/Alien.1979.1080p.BluRay.x264-GRP/alien.resurrection.mkv",
        "/Downloads/Heat.1995.DVDRip.XviD-GRP/CD1/Heat.1995.DVDRip.XviD-GRP.avi",
        "/Downloads/Heat.1995.2160p.UHD.BluRay.REMUX-GRP/Sample/heat.1995.2160p.remux-grp.mkv",
        "/Downloads/Breaking.Bad.Complete.Season.1.1080p.BluRay/s01e01.mkv",
      ),
    );

    expect(r.changes).toEqual([]);
  });

  it("keeps out of show folders that are tagged, doubled or nested elsewhere", () => {
    const r = plan(
      library(
        "/TV Shows/Doctor Who [2005]/Season 01/Doctor Who - S01E01.mkv",
        "/TV Shows/Lost (2004)/Season 01/Lost (2004) - S01E01.mkv",
        "/TV Shows/Lost (2004) {tvdb-73739}/Season 02/Lost (2004) - S02E01.mkv",
        "/TV Shows/Kids/Bluey (2018)/Season 01/Bluey (2018) - S01E01.mkv",
        "/TV Shows/Breaking.Bad.S01.720p.BluRay.x264-DEMAND/Breaking.Bad.S01E02.720p.BluRay.x264-DEMAND.mkv",
        "/TV Shows/The Office {tvdb-73244}/Season 01/The Office - S01E01.mkv",
        ["/Downloads/Doctor.Who.S26E01.mkv", { size: 9 }],
        ["/Downloads/Lost.2004.S01E03.mkv", { size: 8 }],
        ["/Downloads/Bluey.2018.S01E02.mkv", { size: 7 }],
        ["/Downloads/Breaking.Bad.S01E03.1080p.WEB.mkv", { size: 6 }],
        ["/Downloads/The Office {tvdb-78107} - S01E02.mkv", { size: 5 }],
      ),
    );

    expect(r.changes).toEqual([]);
    expect(r.skipped.map((s) => s.path).toSorted()).toEqual([
      "/Downloads/Bluey.2018.S01E02.mkv",
      "/Downloads/Breaking.Bad.S01E03.1080p.WEB.mkv",
      "/Downloads/Doctor.Who.S26E01.mkv",
      "/Downloads/Lost.2004.S01E03.mkv",
      "/Downloads/The Office {tvdb-78107} - S01E02.mkv",
    ]);
  });

  it("keeps out of movie folders that are tagged as another film, doubled, or already hold a copy elsewhere, and reads title years across the plan", () => {
    const r = plan(
      library(
        "/Movies/Pinocchio (2022) {imdb-tt4593060}/poster.jpg",
        "/Movies/Heat (1995)/poster.jpg",
        "/Movies/Heat (1995) {imdb-tt0113277}/poster.jpg",
        "/Movies/Sci-Fi/Alien (1979)/Alien (1979).mkv",
        "/Movies/The Matrix (1999)/The Matrix (1999).mkv",
        "/Movies/The Matrix (1999)/the.matrix.1999.cd2.avi",
        ["/Downloads/Pinocchio (2022) {imdb-tt1488589}.mkv", { size: 20 }],
        ["/Downloads/Heat.1995.720p.WEB.mkv", { size: 19 }],
        ["/Downloads/Alien.1979.1080p.mkv", { size: 18 }],
        ["/Downloads/Death.Race.2000.1975.1080p.mkv", { size: 9 }],
        ["/Downloads/Death.Race.2000.720p.mkv", { size: 10 }],
        ["/Downloads/Aliens.1986.CD1.DVDRip.XviD-GRP.avi", { size: 7 }],
        ["/Downloads/Aliens.1986.Special.Edition.CD2.DVDRip.XviD-GRP.avi", { size: 6 }],
        ["/Downloads/Heat.1986.CD1.DVDRip.avi", { size: 5 }],
        ["/Downloads/Heat.1986.CD2.720p.mkv", { size: 4 }],
      ),
    );

    expect(moves(r).map(([, to]) => to)).toEqual([
      "/Movies/Death Race 2000 (1975)/Death Race 2000 (1975).mkv",
      "/Movies/Aliens (1986)/Aliens (1986) - pt1.avi",
      "/Movies/Heat (1986)/Heat (1986) - pt1.avi",
    ]);
    expect(r.skipped.map((s) => s.path)).toEqual([
      "/Movies/The Matrix (1999)/the.matrix.1999.cd2.avi",
      "/Downloads/Pinocchio (2022) {imdb-tt1488589}.mkv",
      "/Downloads/Heat.1995.720p.WEB.mkv",
      "/Downloads/Alien.1979.1080p.mkv",
      "/Downloads/Death.Race.2000.720p.mkv",
      "/Downloads/Aliens.1986.Special.Edition.CD2.DVDRip.XviD-GRP.avi",
      "/Downloads/Heat.1986.CD2.720p.mkv",
    ]);
  });

  it("skips a video whose new name would pass 255 bytes", () => {
    const r = plan(library(`/Downloads/${"Wordsmith.".repeat(26)}Tale.2019.1080p.mkv`));

    expect(r.skipped.map((s) => s.why)).toEqual(["its new name would be too long"]);
  });

  it("skips a video whose subtitles differ only in case, since both would get one name", () => {
    const r = plan(library("/Downloads/Heat.1995.1080p.mkv", ["/Downloads/Heat.1995.1080p.en.srt", { file_type: "TEXT" }], ["/Downloads/heat.1995.1080p.EN.srt", { file_type: "TEXT" }]));

    expect(r.skipped).toEqual([{ path: "/Downloads/Heat.1995.1080p.mkv", why: "its subtitles would land on other files" }]);
  });

  it("names a lone video from its release folder only when its own name says nothing", () => {
    const r = plan(
      library(
        ["/Downloads/Heat.1995.1080p.BluRay.x264-GRP/grp-heat.mkv", { size: 9 }],
        ["/Downloads/Movie.2020.1080p.WEB-DL/Movie.2020.Part.1.mkv", { size: 8 }],
        ["/Downloads/Show.S01.1080p.WEB-DL/show.mkv", { size: 7 }],
      ),
    );

    expect(moves(r)).toEqual([["/Downloads/Heat.1995.1080p.BluRay.x264-GRP/grp-heat.mkv", "/Movies/Heat (1995)/Heat (1995).mkv"]]);
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
