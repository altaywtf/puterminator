import { describe, expect, it } from "vitest";
import { audit, isMessyName, junkFinder, mediaKey, showOf } from "./audit";
import { buildTree, type WalkedFile } from "./tree";

let id = 1;

const file = (path: string, over: Partial<WalkedFile> = {}): WalkedFile => {
  const name = path.slice(path.lastIndexOf("/") + 1);

  return {
    id: id++,
    parent_id: 0,
    name,
    path,
    depth: path.split("/").length - 1,
    size: 700 * 2 ** 20,
    file_type: /\.(mkv|mp4|avi)$/.test(name) ? "VIDEO" : "FILE",
    extension: name.includes(".") ? name.split(".").pop()! : null,
    crc32: null,
    created_at: "2026-01-01T00:00:00",
    first_accessed_at: null,
    ...over,
  };
};

describe("naming", () => {
  it("flags scene release names and keeps clean ones", () => {
    expect(isMessyName("The.Office.S02E01.720p.HDTV.x264.mkv")).toBe(true);
    expect(isMessyName("Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.mkv")).toBe(true);
    expect(isMessyName("The Office (US) - S02E01 - The Dundies.mkv")).toBe(false);
    expect(isMessyName("Behzat Ç - S01E01.mkv")).toBe(false);
    expect(isMessyName("The Office (US) - S06E24 - The Cover-Up.mkv")).toBe(false);
    expect(isMessyName("Extended Interview-interview.mp4")).toBe(false);
    expect(isMessyName("Heat1995-GRP.mkv")).toBe(true);
    expect(isMessyName("Heat PROPER.mkv")).toBe(true);
  });

  it("leaves hyphenated titles, course files and media-server names clean", () => {
    for (const name of [
      "Spider-Man.mkv",
      "X-MEN.mkv",
      "01-introduction.mp4",
      "[Lecture 01] Introduction.mp4",
      "A Proper Job (2019).mkv",
      "Heat (1995) - 1080p.mkv",
      "Heat (1995) [imdbid-tt0113277].mkv",
      "Heat (1995) - 1080p [imdbid-tt0113277].mkv",
    ])
      expect(isMessyName(name), name).toBe(false);
  });

  it("reads underscores as separators and keeps a folder's last tag", () => {
    expect(isMessyName("Heat_1995_1080p_BluRay_x264_RARBG.mkv")).toBe(true);
    expect(isMessyName("Heat.1995.YIFY", true)).toBe(true);
  });
});

describe("junk", () => {
  it("catches tracker filler, info files and samples", () => {
    const junkReason = junkFinder([]);
    expect(junkReason(file("/Movies/X/RARBG_DO_NOT_MIRROR.exe", { size: 100 }))).toBe("tracker filler");
    expect(junkReason(file("/Movies/X/movie.nfo", { size: 4096 }))).toBe(".nfo file");
    expect(junkReason(file("/Movies/X/Sample/x-sample.mkv", { size: 20 * 2 ** 20 }))).toBe("sample clip");
    expect(junkReason(file("/Movies/X/WWW.YTS.MX.jpg", { size: 50_000 }))).not.toBeNull();
    expect(junkReason(file("/Movies/X/Dune (2024).mkv"))).toBeNull();
  });

  it("never calls a real movie, episode or program junk", () => {
    const junkReason = junkFinder([]);
    expect(junkReason(file("/Movies/Heat.1995.1080p.BluRay.x264-RARBG/Heat.1995.1080p.BluRay.x264-RARBG.mkv"))).toBeNull();
    expect(junkReason(file("/Movies/www.UIndex.org - Dune.2021.1080p.mkv"))).toBeNull();
    expect(junkReason(file("/Movies/Free Samples (2012).mkv", { size: 30 * 2 ** 20 }))).toBeNull();
    expect(junkReason(file("/Series/Trailer Park Boys/Season 1/Trailer Park Boys - S01E01.mkv", { size: 40 * 2 ** 20 }))).toBeNull();
    expect(junkReason(file("/Software/App/setup.exe", { size: 2 * 2 ** 30 }))).toBeNull();
    expect(junkReason(file("/Courses/Habits/notes.txt", { size: 2048 }))).toBeNull();
    expect(junkReason(file("/Courses/Lab/Sample preparation.mp4", { size: 30 * 2 ** 20 }))).toBeNull();
    expect(junkReason(file("/Series/Show/Show.S01E01.x264-RARBG.mkv", { size: 40 * 2 ** 20 }))).toBeNull();
  });

  it("calls a small image junk only beside a video", () => {
    const movie = file("/Movies/Dune/Dune (2024).mkv", { parent_id: 10 });
    const poster = file("/Movies/Dune/poster.jpg", { parent_id: 10, size: 300_000 });
    const screenshot = file("/Courses/Habits/Screenshot 10.png", { parent_id: 20, size: 300_000 });
    const junkReason = junkFinder([movie, poster, screenshot]);
    expect(junkReason(poster)).toBe("cover or logo image");
    expect(junkReason(screenshot)).toBeNull();
  });

  it("leaves a course's diagrams alone, but not tracker art beside a video", () => {
    const lesson = file("/Courses/Habits/01 - Intro.mp4", { parent_id: 30 });
    const diagram = file("/Courses/Habits/diagram.png", { parent_id: 30, size: 300_000 });
    const ad = file("/Courses/Habits/www.site.com.png", { parent_id: 30, size: 30_000 });
    const study = file("/Courses/Habits/logo-study.png", { parent_id: 30, size: 300_000 });
    const exercise = file("/Courses/Habits/cover-design.png", { parent_id: 30, size: 300_000 });
    const junkReason = junkFinder([lesson, diagram, ad, study, exercise]);
    expect(junkReason(diagram)).toBeNull();
    expect(junkReason(study)).toBeNull();
    expect(junkReason(exercise)).toBeNull();
    expect(junkReason(ad)).not.toBeNull();
  });

  it("catches system debris anywhere", () => {
    const junkReason = junkFinder([]);
    expect(junkReason(file("/Movies/X/_____padding_file_0_if you see this file, please update to BitComet 0.85 or above____", { size: 4096 }))).toBe("system debris");
    expect(junkReason(file("/Drive/.Spotlight-V100/Store-V2/store.db", { size: 4096 }))).toBe("system debris");
    expect(junkReason(file("/Movies/X/x.vol00+01.par2", { size: 4096 }))).toBe(".par2 file");
    expect(junkReason(file("/Docs/x/._notes.pdf", { size: 4096 }))).toBe("system debris");
    expect(junkReason(file("/Docs/x/__MACOSX/notes.pdf", { size: 4096 }))).toBe("system debris");
    expect(junkReason(file("/Docs/.DS_Store", { size: 6148 }))).toBe("system debris");
  });
});

describe("duplicates", () => {
  it("matches the same episode across release names", () => {
    expect(mediaKey("The.Office.S02E01.720p.HDTV.x264.mkv")).toBe(mediaKey("The Office S02E01 1080p WEB.mkv"));
    expect(mediaKey("The.Office.S02E01.mkv")).not.toBe(mediaKey("The.Office.S02E02.mkv"));
  });

  it("keeps different shows, show years, dates, parts and extras apart", () => {
    const key = (path: string) => mediaKey(path.slice(path.lastIndexOf("/") + 1), showOf(path));
    expect(key("/Breaking Bad/Season 1/S01E01.mkv")).not.toBe(key("/The Wire/Season 1/S01E01.mkv"));
    expect(key("/Doctor Who (1963)/Doctor Who (1963) - S01E01.mkv")).not.toBe(key("/Doctor Who (2005)/Doctor Who (2005) - S01E01.mkv"));
    expect(key("/Doctor Who (2005)/Season 1/S01E01.mkv")).toBe(key("/TV/Doctor Who (2005) - S01E01 - Rose.mkv"));
    expect(key("/TDS/The.Daily.Show.2024.01.15.720p.WEB.mkv")).not.toBe(key("/TDS/The.Daily.Show.2024.01.16.720p.WEB.mkv"));
    expect(key("/Movies/Kill Bill (2003) - pt1.mkv")).not.toBe(key("/Movies/Kill Bill (2003) - pt2.mkv"));
    expect(key("/Movies/Heat (1995)/Heat (1995)-trailer.mkv")).not.toBe(key("/Movies/Heat (1995)/Heat (1995).mkv"));
    expect(key("/Movies/Blade Runner (1982) {edition-Final Cut}.mkv")).not.toBe(key("/Movies/Blade Runner (1982) {edition-Theatrical}.mkv"));
    expect(key("/Movies/Heat (1995)-part1.mkv")).not.toBe(key("/Movies/Heat (1995)-part2.mkv"));
    expect(key("/Movies/Blade Runner (1982) [Final Cut].mkv")).not.toBe(key("/Movies/Blade Runner (1982) [Theatrical].mkv"));
    expect(key("/TV/Show.S01E01.mkv")).not.toBe(key("/TV/Show.S01E01E02.mkv"));
    expect(key("/TV/Show.S01E01-part1.mkv")).not.toBe(key("/TV/Show.S01E01-part2.mkv"));
    expect(key("/Downloads/Heat.1995.1080p.BluRay.x264-GRP.mkv")).toBe(key("/Movies/Heat (1995)/Heat (1995).mkv"));
    expect(key("/Movies/1917 (2019).mkv")).toBe("1917|2019");
    expect(key("/Movies/1917 (2019) 1080p.mkv")).toBe(key("/Movies/1917 (2019).mkv"));
    expect(key("/Movies/Heat (1995) {imdb-tt0113277}.mkv")).toBe(key("/Movies/Heat (1995).mkv"));
  });

  it("finds two releases of one movie even when put.io has their checksums", () => {
    const a = audit(
      [file("/Movies/Heat.1995.1080p.BluRay.x264-GRP.mkv", { crc32: "aaaa1111", size: 2 * 2 ** 30 }), file("/Movies/Heat.1995.720p.WEB.mkv", { crc32: "bbbb2222", size: 2 ** 30 })],
      "Your Files",
      false,
    );

    expect(a.duplicates.groups).toBe(1);
  });

  it("keeps a third release in the group when two others are exact copies", () => {
    const a = audit(
      [
        file("/Movies/Heat (1995).mkv", { crc32: "aaaa1111", size: 100 * 2 ** 20 }),
        file("/Movies/Heat.1995.720p.mkv", { crc32: "bbbb2222", size: 80 * 2 ** 20 }),
        file("/Movies/Heat copy.mkv", { crc32: "aaaa1111", size: 100 * 2 ** 20 }),
      ],
      "Your Files",
      false,
    );

    expect(a.duplicates.groups).toBe(1);
    expect(a.duplicates.wastedBytes).toBe(180 * 2 ** 20);
  });

  it("finds duplicate episodes when the scanned folder is the show", () => {
    const eps = [file("/Season 1/S01E01.1080p.mkv", { size: 2 ** 30 }), file("/Season 1/S01E01.720p.mkv", { size: 2 ** 29 })];
    expect(audit(eps, "Example Show", false, new Date(), "Example Show").duplicates.groups).toBe(1);
  });

  it("keeps the well-named, played copy of identical files", () => {
    const messy = file("/Downloads/Heat.1995.1080p-GRP/Heat.1995.1080p-GRP.mkv", { crc32: "aaaa1111" });
    const clean = file("/Movies/Heat (1995)/Heat (1995).mkv", { crc32: "aaaa1111", first_accessed_at: "2026-02-01T00:00:00" });
    expect(audit([messy, clean], "Your Files", false).duplicates.examples[0]!.keep).toBe(clean.path);
  });

  it("lists a few copies per group, however many there are, and counts them all as waste", () => {
    const copies = Array.from({ length: 50 }, (_, i) => file(`/Dump/${i}/Heat (1995).mkv`, { crc32: "aaaa1111", size: 2 ** 30 }));
    const a = audit(copies, "Your Files", false);
    expect(a.duplicates.examples[0]!.drop).toHaveLength(5);
    expect(a.duplicates.wastedBytes).toBe(49 * 2 ** 30);
  });

  it("keeps the bigger copy and counts the smaller as waste", () => {
    const big = file("/Series/The.Office.S02E01.1080p.WEB.mkv", { size: 2 * 2 ** 30 });
    const small = file("/Series/The.Office.S02E01.720p.HDTV.x264.mkv", { size: 2 ** 30 });
    const a = audit([big, small], "Your Files", false);
    expect(a.duplicates.groups).toBe(1);
    expect(a.duplicates.examples[0]!.keep).toBe(big.path);
    expect(a.duplicates.wastedBytes).toBe(2 ** 30);
  });
});

describe("structure", () => {
  it("calls a release folder with its movie and a sample a wrapper", () => {
    const dir = file("/Heat.1995.1080p.BluRay.x264-GRP", { id: 50, parent_id: 0, file_type: "FOLDER", extension: null, size: 0 });
    const movie = file("/Heat.1995.1080p.BluRay.x264-GRP/Heat.1995.1080p.BluRay.x264-GRP.mkv", { parent_id: 50 });
    const sample = file("/Heat.1995.1080p.BluRay.x264-GRP/Sample/heat-sample.mkv", { parent_id: 50, size: 20 * 2 ** 20 });
    expect(audit([dir, movie, sample], "Your Files", false).structure.wrapperFolders).toBe(1);
  });

  it("does not call a release folder a wrapper when it holds other real content", () => {
    const dir = file("/Heat.1995.1080p.BluRay.x264-GRP", { id: 60, parent_id: 0, file_type: "FOLDER", extension: null, size: 0 });
    const movie = file("/Heat.1995.1080p.BluRay.x264-GRP/Heat.1995.1080p.BluRay.x264-GRP.mkv", { parent_id: 60 });
    const subs = file("/Heat.1995.1080p.BluRay.x264-GRP/Heat.1995.1080p.BluRay.x264-GRP.srt", { parent_id: 60, size: 90_000 });
    const soundtrack = file("/Heat.1995.1080p.BluRay.x264-GRP/Soundtrack.flac", { parent_id: 60, size: 300 * 2 ** 20 });
    expect(audit([dir, movie, subs], "Your Files", false).structure.wrapperFolders).toBe(1);
    expect(audit([dir, movie, subs, soundtrack], "Your Files", false).structure.wrapperFolders).toBe(0);
  });
});

describe("audit", () => {
  it("never scores lower for deleting empty folders", () => {
    const readme = file("/readme.nfo", { size: 100 });
    const empties = Array.from({ length: 9 }, (_, i) => file(`/d${i}`, { id: 900 + i, file_type: "FOLDER", extension: null, size: 0 }));
    expect(audit([readme], "Your Files", false).score).toBeGreaterThanOrEqual(audit([readme, ...empties], "Your Files", false).score);
  });

  it("scores a clean library at 100 and counts never-played videos", () => {
    const a = audit([file("/Movies/Dune (2024)/Dune (2024).mkv", { depth: 3 })], "Your Files", false);
    expect(a.score).toBe(100);
    expect(a.neverPlayed.count).toBe(1);
  });
});

describe("buildTree", () => {
  const f = (id: number, parent_id: number, name: string, file_type = "FILE") => ({
    id, parent_id, name, file_type, size: 1, extension: null, crc32: null, created_at: "2026-01-01", first_accessed_at: null,
  });

  const childrenBeforeFolders = [f(3, 2, "ep1.mkv", "VIDEO"), f(2, 1, "Season 01", "FOLDER"), f(1, 0, "Show", "FOLDER"), f(4, 0, "loose.txt")];

  it("rebuilds paths under Your Files", () => {
    const { files } = buildTree(childrenBeforeFolders, 0);
    expect(files.map((x) => x.path).sort()).toEqual(["/Show", "/Show/Season 01", "/Show/Season 01/ep1.mkv", "/loose.txt"]);
    expect(files.find((x) => x.id === 3)!.depth).toBe(3);
  });

  it("scopes to a target folder", () => {
    const { files, rootName } = buildTree(childrenBeforeFolders, 1);
    expect(rootName).toBe("Show");
    expect(files.map((x) => x.path).sort()).toEqual(["/Season 01", "/Season 01/ep1.mkv"]);
  });
});
