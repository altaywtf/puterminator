import { describe, expect, it } from "vitest";
import { audit, isMessyName, junkFinder, mediaKey } from "./audit";
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
  });
});

describe("junk", () => {
  it("catches tracker filler, info files and samples", () => {
    const junkReason = junkFinder([]);
    expect(junkReason(file("/Movies/X/RARBG_DO_NOT_MIRROR.exe"))).toBe("tracker filler");
    expect(junkReason(file("/Movies/X/movie.nfo"))).toBe(".nfo file");
    expect(junkReason(file("/Movies/X/Sample/x-sample.mkv", { size: 20 * 2 ** 20 }))).toBe("sample clip");
    expect(junkReason(file("/Movies/X/WWW.YTS.MX.jpg", { size: 50_000 }))).not.toBeNull();
    expect(junkReason(file("/Movies/X/Dune (2024).mkv"))).toBeNull();
  });

  it("calls a small image junk only beside a video", () => {
    const movie = file("/Movies/Dune/Dune (2024).mkv", { parent_id: 10 });
    const poster = file("/Movies/Dune/poster.jpg", { parent_id: 10, size: 300_000 });
    const screenshot = file("/Courses/Habits/Screenshot 10.png", { parent_id: 20, size: 300_000 });
    const junkReason = junkFinder([movie, poster, screenshot]);
    expect(junkReason(poster)).toBe("cover or logo image");
    expect(junkReason(screenshot)).toBeNull();
  });

  it("catches macOS debris anywhere", () => {
    const junkReason = junkFinder([]);
    expect(junkReason(file("/Docs/x/._notes.pdf", { size: 4096 }))).toBe("macOS debris");
    expect(junkReason(file("/Docs/x/__MACOSX/notes.pdf", { size: 4096 }))).toBe("macOS debris");
    expect(junkReason(file("/Docs/.DS_Store", { size: 6148 }))).toBe("macOS debris");
  });
});

describe("duplicates", () => {
  it("matches the same episode across release names", () => {
    expect(mediaKey("The.Office.S02E01.720p.HDTV.x264.mkv")).toBe(mediaKey("The Office S02E01 1080p WEB.mkv"));
    expect(mediaKey("The.Office.S02E01.mkv")).not.toBe(mediaKey("The.Office.S02E02.mkv"));
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

describe("audit", () => {
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
  // put.io's parent_id=-1 listing is flat and unordered: children can come before their folders.
  const flat = [f(3, 2, "ep1.mkv", "VIDEO"), f(2, 1, "Season 01", "FOLDER"), f(1, 0, "Show", "FOLDER"), f(4, 0, "loose.txt")];

  it("rebuilds paths under Your Files", () => {
    const { files } = buildTree(flat, 0);
    expect(files.map((x) => x.path).sort()).toEqual(["/Show", "/Show/Season 01", "/Show/Season 01/ep1.mkv", "/loose.txt"]);
    expect(files.find((x) => x.id === 3)!.depth).toBe(3);
  });

  it("scopes to a target folder", () => {
    const { files, rootName } = buildTree(flat, 1);
    expect(rootName).toBe("Show");
    expect(files.map((x) => x.path).sort()).toEqual(["/Season 01", "/Season 01/ep1.mkv"]);
  });
});
