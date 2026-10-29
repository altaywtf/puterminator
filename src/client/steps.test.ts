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

it("callLine omits empty input", () => {
  expect(callLine("scan_library", {})).toBe("scan_library()");
  expect(callLine("list_folder", { path: "movies" })).toBe('list_folder({"path":"movies"})');
});
