import type { Html, HtmlBuilder } from "foldkit/html";
import type { Audit } from "../shared/audit";

// Product spot art per uinaf DESIGN.md: 48 grid, stroke 1.5, square caps, currentColor,
// one slime-gradient shape per frame. A CRT with a skull on the screen; props carry the joke.

export type Mood = "asleep" | "unplugged" | "idle" | "shades" | "dust" | "mop" | "wading" | "flood" | "jar";

const CRT = ["M8 8h32v25H8z", "M12 12h24v17H12z", "M20 33v5h8v-5", "M14 41h20", "M40 12l-2.5 2 1.5 1.5-2 1.5"];
const EYES = ["M18 17h2v2h-2z", "M28 17h2v2h-2z"];
const SHUT = ["M17 18.5h4", "M27 18.5h4"];
const SHADES = ["M15.5 16.5h6v3h-6z", "M26.5 16.5h6v3h-6z", "M21.5 17.5h5"];
const FLOATING_SHADES = ["M15.5 4.5h6v3h-6z", "M26.5 4.5h6v3h-6z", "M21.5 5.5h5"];
const JAW = ["M23.5 21.5l.5-1 .5 1", "M19 24h10", "M21 24v2.5", "M24 24v2.5", "M27 24v2.5"];
const ZZZ = ["M3 5h3L3 8h3", "M7 1.5h2L7 3.5h2"];
const FLATLINE = ["M16 20.5h16"];
const CORD = ["M40 30c4 0 5 4 3 7s-1 4 2 4"];
const JAR = ["M41 34h5v7h-5z", "M40.5 34h6"];
const DUSTER = ["M42 6l-6 8", "M41 3.5l3 3", "M40 5l3 3", "M43 2.5l2 2"];
const MOP = ["M44 4L36 40", "M33 40h6"];

// One closed shape per frame, drawn in slime and outlined in currentColor.
const SLIME: Partial<Record<Mood, string>> = {
  dust: "M13 33h5c0 2-1 3-1 5a1.5 1.5 0 0 1-3 0c0-2-1-3-1-5z",
  mop: "M13 29h7v4c0 2-1 3-1 5 0 1.5 2 2 5 2.5s5 .5 5 1.5-4 1.5-9 1.5-11-.5-11-1.5 3-1 3-2.5-1-3-1-5v-4z",
  wading:
    "M12 23c3 1 6-1 9 0s6 1 9 0 5-1 6 0v6h4v4c0 2-1 3-1 5 0 2 4 2 4 3.5s-8 2.5-19 2.5-19-1-19-2.5 3-1.5 3-3.5-1-3-1-5v-4h4z",
  flood:
    "M8 13c4-2 8 1 12 0s8-2 12 0 8 1 8 1v19c0 2-1 3-1 5 0 2 4 2 4 3.5s-10 2.5-20 2.5-20-1-20-2.5 3-1.5 3-3.5-1-3-1-5z",
  jar: "M41.75 37.5h3.5v2.75h-3.5z",
};

const LINES: Record<Mood, string[]> = {
  asleep: [...CRT, ...SHUT, ...JAW, ...ZZZ],
  unplugged: [...CRT, ...FLATLINE, ...CORD],
  idle: [...CRT, ...EYES, ...JAW],
  shades: [...CRT, ...SHADES, ...JAW],
  dust: [...CRT, ...EYES, ...JAW, ...DUSTER],
  mop: [...CRT, ...EYES, ...JAW, ...MOP],
  wading: [...CRT, ...EYES, ...JAW.slice(0, 1)],
  flood: [...CRT, ...FLOATING_SHADES],
  jar: [...CRT, ...SHADES, ...JAW, ...JAR],
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

/** `uid` keeps gradient ids unique when the same mood renders twice in one document. */
export const art = <M>(h: HtmlBuilder<M>, mood: Mood, px: number, uid: string = mood): Html => {
  const slime = SLIME[mood];
  const gradient = `slime-${uid}`;
  const line = (d: string) => h.path([h.D(d)]);
  return h.svg(
    [
      h.ViewBox("0 0 48 48"),
      h.AriaHidden(true),
      h.Class("art flex-none text-fg"),
      h.Width(`${px}`),
      h.Height(`${px}`),
      h.Fill("none"),
      h.Stroke("currentColor"),
      h.StrokeWidth("1.5"),
      h.StrokeLinecap("square"),
      h.StrokeLinejoin("miter"),
    ],
    [
      ...(slime
        ? [
            h.defs(
              [],
              [
                h.linearGradient(
                  [h.Id(gradient), h.X1("0"), h.Y1("0"), h.X2("0"), h.Y2("1")],
                  // --slime-cyan → --slime-purple; stop-color can't read custom properties.
                  [h.stop([h.Offset("0"), h.StopColor("#3fffe6")], []), h.stop([h.Offset("1"), h.StopColor("#8a4bff")], [])],
                ),
              ],
            ),
          ]
        : []),
      // Slime under the face so eyes and shades stay readable on top.
      ...(slime && mood !== "jar" ? [h.path([h.D(slime), h.Fill(`url(#${gradient})`), h.StrokeWidth("1"), h.Class("slime")])] : []),
      ...LINES[mood].map(line),
      ...(slime && mood === "jar" ? [h.path([h.D(slime), h.Fill(`url(#${gradient})`), h.Stroke("none")])] : []),
    ],
  );
};
