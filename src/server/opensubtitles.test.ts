import { describe, expect, it } from "vitest";
import { parseRelease } from "./opensubtitles";

describe("parseRelease", () => {
  it.each([
    ["Quiet.Harbor.S01E01.1080p.AMZN.WEB-DL.DD5.1.H.264-Kestrel.mkv", { title: "Quiet Harbor", season: 1, episode: 1 }],
    ["Lantern Street (2022) - S01E01.mkv", { title: "Lantern Street", season: 1, episode: 1 }],
    ["1886 S02E03.mkv", { title: "1886", season: 2, episode: 3 }],
    ["Orbit 2049 (2017).mkv", { title: "Orbit 2049", year: 2017 }],
    ["Orbit.2049.2017.1080p.BluRay.x264-Moth.mkv", { title: "Orbit 2049", year: 2017 }],
    ["1905.2019.1080p.WEB-DL.mkv", { title: "1905", year: 2019 }],
    ["Night Shift (1995).mkv", { title: "Night Shift", year: 1995 }],
    ["home video.mkv", null],
  ])("%s", (name, release) => {
    expect(parseRelease(name)).toEqual(release);
  });
});
