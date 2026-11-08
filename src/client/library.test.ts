import { describe, expect, it } from "vitest";
import { FileFlag, type Library } from "../shared/contract";
import { indexOf, isRegular, resolve } from "./library";

const { folder, video, played, junk } = FileFlag;

const lib: Library = {
  rootId: 0,
  rootName: "Your Files",
  files: [
    [1, 0, "Movies", 3000, folder],
    [2, 1, "Haze.mkv", 2000, video],
    [3, 1, "sample.mkv", 10, video | junk],
    [4, 0, "Shows", 5000, folder],
    [5, 4, "S01", 5000, folder],
    [6, 5, "Pilot.mkv", 4000, video | played],
    [7, 5, "Haze.mkv", 900, video],
  ],
};

describe("library index", () => {
  const ix = indexOf(lib);

  it("rebuilds paths from parent ids and sorts siblings by size", () => {
    expect(ix.nodes.get(6)?.path).toBe("/Shows/S01/Pilot.mkv");
    expect(ix.top).toEqual([4, 1]);
    expect(ix.nodes.get(1)?.children).toEqual([2, 3]);
    expect(ix.total).toBe(8000);
  });

  it("rolls folder sizes up from children when the listing reports 0", () => {
    const zero = indexOf({ rootId: 0, rootName: "x", files: [[1, 0, "A", 0, folder], [2, 1, "a.mkv", 70, video], [3, 0, "b.mkv", 50, video]] });
    expect(zero.nodes.get(1)?.size).toBe(70);
    expect(zero.top).toEqual([1, 3]);
  });

  it("rolls junk and never-played counts up to folders", () => {
    expect([ix.nodes.get(1)?.junk, ix.nodes.get(1)?.unplayed]).toEqual([1, 2]);
    expect([ix.nodes.get(4)?.junk, ix.nodes.get(4)?.unplayed]).toEqual([0, 1]);
  });

  it("resolves paths with or without the leading slash, and only unique file names", () => {
    expect(resolve(ix, "/Shows/S01/Pilot.mkv")?.id).toBe(6);
    expect(resolve(ix, "Movies/sample.mkv")?.id).toBe(3);
    expect(resolve(ix, "Pilot.mkv")?.id).toBe(6);
    expect(resolve(ix, "Haze.mkv")).toBeNull();
    expect(resolve(ix, "nope.mkv")).toBeNull();
  });

  it("marks put.io's negative-id special folders as not regular", () => {
    const special = indexOf({ rootId: 0, rootName: "x", files: [[-2, 0, "Items shared with you", 0, folder]] });
    expect(isRegular(special.nodes.get(-2)!)).toBe(false);
    expect(isRegular(ix.nodes.get(1)!)).toBe(true);
    const mixed = indexOf({ rootId: 0, rootName: "x", files: [[-2, 0, "shared", 9e15, folder], [1, 0, "a.mkv", 5, video]] });
    expect(mixed.top).toEqual([1, -2]);
    expect(mixed.total).toBe(5);
  });
});
