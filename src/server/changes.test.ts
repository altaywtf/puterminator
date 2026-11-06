import { describe, expect, it } from "vitest";
import type { Run } from "../shared/actions";
import { sidecarsOf, staleChanges, undoChanges, untranslated } from "./changes";
import type { WalkedFile } from "./tree";

const run = (changes: Run["changes"]): Run => ({ id: "p", title: "t", changes, steps: changes.map((c) => ({ change: c.id, state: "done", error: null })) });

describe("undoChanges", () => {
  it("moves each video back before its subtitles, last change first", () => {
    const back = undoChanges(
      run([
        { id: "c1", op: "move", path: "/D/a.mkv", to: "/M/A (2000)/A (2000).mkv", bytes: 0 },
        { id: "c1s1", op: "move", path: "/D/a.en.srt", to: "/M/A (2000)/A (2000).en.srt", bytes: 0 },
        { id: "c2", op: "rename", path: "/D/b.mkv", to: "B (2001).mkv", bytes: 0 },
        { id: "c2s1", op: "rename", path: "/D/b.en.srt", to: "B (2001).en.srt", bytes: 0 },
      ]),
    );

    expect(back.map((c) => c.id)).toEqual(["c2", "c2s1", "c1", "c1s1"]);
  });
});

describe("staleChanges", () => {
  const file = (id: number, path: string): WalkedFile => ({ id, parent_id: 0, name: path.slice(path.lastIndexOf("/") + 1), path, depth: 1, size: 1, file_type: "VIDEO", content_type: null, extension: "mkv", crc32: null, created_at: "", first_accessed_at: null });

  it("flags a file that moved and a destination another file took", () => {
    const changes: Run["changes"] = [
      { id: "c1", op: "rename", path: "/a.mkv", to: "x.mkv", bytes: 0 },
      { id: "c2", op: "move", path: "/b.mkv", to: "/y.mkv", bytes: 0 },
    ];

    expect(staleChanges([file(1, "/moved/a.mkv"), file(2, "/b.mkv"), file(3, "/y.mkv")], changes, { c1: 1, c2: 2 })).toEqual(["/a.mkv moved or is gone", "/y.mkv is taken"]);
  });

  it("for retry and undo, accepts a file at either end of its change, and nowhere else", () => {
    const changes: Run["changes"] = [
      { id: "c1", op: "rename", path: "/a.mkv", to: "x.mkv", bytes: 0 },
      { id: "c2", op: "move", path: "/b.mkv", to: "/d/b.mkv", bytes: 0 },
      { id: "c3", op: "move", path: "/c.mkv", to: "/d/c.mkv", bytes: 0 },
      { id: "c4", op: "restore", path: "/gone.mkv", to: null, bytes: 0 },
    ];

    const snapshot = [file(1, "/x.mkv"), file(2, "/b.mkv"), file(3, "/elsewhere/c.mkv")];

    expect(staleChanges(snapshot, changes, { c1: 1, c2: 2, c3: 3, c4: 4 }, true)).toEqual(["/c.mkv moved or is gone"]);
    expect(staleChanges(snapshot, changes, { c1: 1, c2: 2, c3: 3, c4: 4 })).toEqual(["/a.mkv moved or is gone", "/c.mkv moved or is gone"]);
  });
});

describe("sidecarsOf", () => {
  const at = (id: number, name: string, file_type = "VIDEO"): WalkedFile => ({ id, parent_id: 9, name, path: `/d/${name}`, depth: 2, size: id, file_type, content_type: null, extension: name.split(".").pop() ?? null, crc32: null, created_at: "", first_accessed_at: null });

  it("gives a subtitle to the video whose name matches its case when two differ only in case, and to neither when two match exactly", () => {
    const mkv = at(1, "Heat.1995.mkv");
    const mp4 = at(2, "heat.1995.mp4");
    const srt = at(3, "heat.1995.en.srt", "TEXT");

    expect(sidecarsOf([mkv, mp4, srt], mkv)).toEqual([]);
    expect(sidecarsOf([mkv, mp4, srt], mp4)).toEqual([srt]);
    expect(sidecarsOf([mkv, at(4, "Heat.1995.mp4"), at(5, "Heat.1995.en.srt", "TEXT")], mkv)).toEqual([]);
    expect(sidecarsOf([mkv, srt], mkv)).toEqual([srt]);
  });
});

describe("untranslated", () => {
  const at = (id: number, path: string, file_type = "VIDEO"): WalkedFile => ({ id, parent_id: 0, name: path.slice(path.lastIndexOf("/") + 1), path, depth: path.split("/").length - 1, size: 1, file_type, content_type: null, extension: "", crc32: null, created_at: "", first_accessed_at: null });

  it("counts videos with no subtitle file in that language beside them, by folder, most missing first, within the given folder", () => {
    const snapshot = [
      at(1, "/TV/Medici/S1/E1.mkv"),
      at(2, "/TV/Medici/S1/E1.tur.srt", "TEXT"),
      at(3, "/TV/Medici/S1/E2.mkv"),
      at(4, "/TV/Medici/S2/E1.mkv"),
      at(5, "/TV/Medici/S2/E2.mkv"),
      at(6, "/TV/Medici/S2/E2.TUR.srt", "TEXT"),
      at(7, "/TV/Curb/S10/E5.mkv"),
      at(8, "/TV/Curb/S10/E6.mkv"),
      at(9, "/TV/Done/E1.mkv"),
      at(10, "/TV/Done/E1.tur.srt", "TEXT"),
      at(11, "/Movies/Heat.mkv"),
    ];

    expect(untranslated(snapshot, "tur", "/TV")).toEqual({
      videos: 4,
      folders: 3,
      top: [
        { folder: "/TV/Curb/S10", videos: 2, missing: 2 },
        { folder: "/TV/Medici/S1", videos: 2, missing: 1 },
        { folder: "/TV/Medici/S2", videos: 2, missing: 1 },
      ],
    });
  });
});
