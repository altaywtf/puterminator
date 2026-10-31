import type { Html, HtmlBuilder } from "foldkit/html";
import type { Audit } from "../shared/audit";

// Pixel spot art: the amber CRT skull, with props that carry the joke. One string per pixel row.
// . empty · # amber · w bright amber · o dim amber · R red eye · k ink cut into the screen · s slime

export type Mood = "asleep" | "unplugged" | "idle" | "shades" | "dust" | "mop" | "wading" | "flood" | "jar";

const FILL: Record<string, string> = {
  "#": "var(--accent)",
  w: "var(--accent-bright)",
  o: "var(--accent-dim)",
  R: "var(--eye)",
  k: "var(--bg)",
  s: "var(--slime)",
};

const CRT = [
  ".##############.",
  ".#............#.",
  ".#.##########.#.",
  ".#.#kk####kk#.#.",
  ".#.#kR####Rk#.#.",
  ".#.##########.#.",
  ".#.####kk####.#.",
  ".#.##########.#.",
  ".#.#k#k#k#k##.#.",
  ".#.##########.#.",
  ".#............#.",
  ".##############.",
  "......####......",
  "....########....",
];

type Put = [x: number, y: number, run: string];

/** Props sit relative to the CRT's top-left; the canvas grows to fit them, then trims to the ink. */
const compose = (puts: Put[]): string[] => {
  const cells = new Map<string, string>();
  for (const [x, y, run] of [...CRT.map((r, y): Put => [0, y, r]), ...puts])
    [...run].forEach((c, i) => {
      if (c !== "." && c !== " ") cells.set(`${x + i},${y}`, c);
    });
  const xy = [...cells.keys()].map((k) => k.split(",").map(Number));
  const xs = xy.map((p) => p[0] ?? 0);
  const ys = xy.map((p) => p[1] ?? 0);
  const [x0, y0] = [Math.min(...xs), Math.min(...ys)];
  return Array.from({ length: Math.max(...ys) - y0 + 1 }, (_, y) =>
    Array.from({ length: Math.max(...xs) - x0 + 1 }, (_, x) => cells.get(`${x + x0},${y + y0}`) ?? ".").join(""),
  );
};

const screenOff: Put[] = Array.from({ length: 8 }, (_, i): Put => [3, 2 + i, "oooooooooo"]);
const shades: Put[] = [
  [3, 3, "kkkkkkkkkk"],
  [4, 4, "kkk"],
  [9, 4, "kkk"],
];
const slimeFrom = (top: number): Put[] => [
  [-3, top, "ss sss  ssss sss  ss"],
  ...Array.from({ length: 13 - top }, (_, i): Put => [-3, top + 1 + i, "ssssssssssssssssssssss"]),
];

const SPRITES: Record<Mood, string[]> = {
  idle: compose([]),
  asleep: compose([[4, 3, "##"], [10, 3, "##"], [4, 4, "kk"], [10, 4, "kk"], [15, -4, "www"], [16, -3, "w"], [15, -2, "www"]]),
  unplugged: compose([...screenOff, [4, 6, "wwwwwwww"], [14, 10, "#"], [15, 11, "#"], [16, 12, "##"], [17, 13, "##"]]),
  shades: compose(shades),
  dust: compose([[16, -5, "w w"], [16, -4, "www"], [15, -3, "#"], [14, -2, "#"]]),
  mop: compose([...Array.from({ length: 17 }, (_, i): Put => [17, -3 + i, "#"]), [15, 14, "wwwww"], [15, 15, "w w w"]]),
  wading: compose(slimeFrom(11)),
  flood: compose([...shades.map(([x, y, r]): Put => [x, y - 6, r.replaceAll("k", "#")]), ...slimeFrom(5)]),
  jar: compose([...shades, [15, 9, "# #"], [15, 10, "#s#"], [15, 11, "###"]]),
};

/** The score band picks the frame; the number stays the value. */
export const moodOf = (a: Audit): Mood =>
  a.score >= 90 && a.junk.count === 0 && a.duplicates.groups === 0
    ? "jar"
    : a.score >= 90
      ? "shades"
      : a.score >= 75
        ? "dust"
        : a.score >= 50
          ? "mop"
          : a.score >= 25
            ? "wading"
            : "flood";

/** `px` is the height; the width follows the sprite, so props never shrink the face. Runs merge per row. */
export const art = <M>(h: HtmlBuilder<M>, mood: Mood, px: number): Html => {
  const rows = SPRITES[mood];
  const w = Math.max(...rows.map((r) => r.length));
  const rects: Html[] = [];
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; ) {
      const c = row[x] ?? ".";
      let end = x + 1;
      while (row[end] === c) end++;
      const fill = FILL[c];
      if (fill) rects.push(h.rect([h.X(`${x}`), h.Y(`${y}`), h.Width(`${end - x}`), h.Height("1"), h.Fill(fill)], []));
      x = end;
    }
  });
  return h.svg(
    [
      h.ViewBox(`0 0 ${w} ${rows.length}`),
      h.AriaHidden(true),
      h.Class("art pointer-events-none block flex-none select-none"),
      h.Height(`${px}`),
      h.Width(`${Math.round((px * w) / rows.length)}`),
      h.ShapeRendering("crispEdges"),
    ],
    rects,
  );
};
