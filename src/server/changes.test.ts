import { describe, expect, it } from "vitest";
import type { Run } from "../shared/actions";
import { sidecarsOf, staleChanges, undoChanges } from "./changes";
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
  const file = (id: number, path: string): WalkedFile => ({ id, parent_id: 0, name: path.slice(path.lastIndexOf("/") + 1), path, depth: 1, size: 1, file_type: "VIDEO", extension: "mkv", crc32: null, created_at: "", first_accessed_at: null });

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
  const at = (id: number, name: string, file_type = "VIDEO"): WalkedFile => ({ id, parent_id: 9, name, path: `/d/${name}`, depth: 2, size: id, file_type, extension: name.split(".").pop() ?? null, crc32: null, created_at: "", first_accessed_at: null });

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
