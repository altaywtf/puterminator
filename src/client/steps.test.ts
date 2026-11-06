import * as Option from "effect/Option";
import { describe, expect, it } from "vitest";
import { audit, search } from "./dev/fixtures";
import { auditOf, callLine, describeStep } from "./steps";

describe("describeStep", () => {
  it("summarises a scan from the audit result", () => {
    expect(describeStep("scan_library", {}, JSON.stringify(audit))).toEqual({
      title: "read the library",
      detail: "3,688 items · 1.7 TB",
      lines: ["release names   1,442 videos", "wrapper folders   318", "junk   351 files · 2.1 GB", "duplicates   12 groups"],
    });
  });

  it("names the search and lists up to six paths", () => {
    const d = describeStep("search_files", { category: "junk", query: "rarbg" }, JSON.stringify(search));
    expect(d.title).toBe('search junk "rarbg"');
    expect(d.detail).toBe("351 matches");
    expect(d.lines).toHaveLength(6);
  });

  it("lists each file's codecs, resolution and length for media info", () => {
    const info = { container: "matroska,webm", minutes: 110, kbps: 8215, video: [{ codec: "hevc", profile: "Main 10", width: 1920, height: 1080 }], audio: [{ codec: "eac3", channels: 6 }], subtitles: [], issues: [] };

    const output = {
      files: [
        { path: "/Movies/Heat.mkv", mime: "video/x-matroska", info, error: null },
        { path: "/notes.txt", mime: "text/plain", info: null, error: null },
        { path: "/Alien.mkv", mime: null, info: null, error: "put.io /files/:id → 404" },
      ],
    };

    expect(describeStep("media_info", { paths: [] }, JSON.stringify(output))).toEqual({
      title: "read media info",
      detail: "3 files",
      lines: ["Heat.mkv   video/x-matroska · hevc 1920×1080 · eac3 6ch · 110 min", "notes.txt   text/plain", "Alien.mkv   put.io /files/:id → 404"],
    });
  });

  it("keeps what it can read from a partly malformed result", () => {
    const d = describeStep("search_files", {}, '{"total":2,"items":[{"path":"/Heat.mkv"},{}]}');
    expect([d.detail, d.lines]).toEqual(["2 matches", ["/Heat.mkv"]]);
    expect(describeStep("list_folder", { path: "/Movies" }, "{}").detail).toBe("0 items");
  });

  it("shows a tool error and a non-JSON result as the failure line", () => {
    expect(describeStep("list_folder", { path: "movies" }, '{"error":"No scan yet."}')).toEqual({
      title: "couldn’t run list_folder",
      detail: null,
      lines: ["No scan yet."],
    });
    expect(describeStep("list_folder", {}, "put.io timed out").lines).toEqual(["put.io timed out"]);
  });

  it("has no detail while the tool runs", () => {
    expect(describeStep("list_folder", { path: "" }, null)).toEqual({ title: "open /", detail: null, lines: [] });
  });
});

describe("auditOf", () => {
  it("decodes only a complete audit", () => {
    expect(Option.isSome(auditOf(JSON.stringify(audit)))).toBe(true);
    expect(Option.isNone(auditOf('{"score":71}'))).toBe(true);
    expect(Option.isNone(auditOf(null))).toBe(true);
  });
});

describe("callLine", () => {
  it("omits empty input", () => {
    expect(callLine("scan_library", {})).toBe("scan_library()");
    expect(callLine("list_folder", { path: "movies" })).toBe('list_folder({"path":"movies"})');
  });
});
