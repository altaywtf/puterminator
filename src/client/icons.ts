import type { Html, HtmlBuilder } from "foldkit/html";

// 16px stroke icons from design/thread-reference.html.
const PATHS = {
  chev: ["M6 4l4 4-4 4"],
  arrowUp: ["M8 13V3M4 7l4-4 4 4"],
  folder: ["M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z"],
  history: ["M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 3v2.5H5", "M8 5.5V8l1.8 1"],
  brain: [
    "M6 3a2 2 0 0 0-2 2 2 2 0 0 0-1 3.5A2 2 0 0 0 5 12a2 2 0 0 0 3 .5V3.5A2 2 0 0 0 6 3zM10 3a2 2 0 0 1 2 2 2 2 0 0 1 1 3.5A2 2 0 0 1 11 12a2 2 0 0 1-3 .5",
  ],
  tool: ["M10 3a3 3 0 0 0-2.8 4L3 11.2 4.8 13 9 8.8A3 3 0 0 0 13 6l-1.8 1.8-1.5-.5-.5-1.5L11 4a3 3 0 0 0-1-1z"],
  alert: ["M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11z", "M8 5.5v3M8 10.5v.01"],
  check: ["M3.5 8.5l3 3 6-7"],
} as const;

export type IconName = keyof typeof PATHS | "stop";

export const icon = <M>(h: HtmlBuilder<M>, name: IconName, cls = ""): Html =>
  h.svg(
    [
      h.ViewBox("0 0 16 16"),
      h.AriaHidden(true),
      h.Class(`size-3.5 flex-none fill-none stroke-current [stroke-width:1.6] [stroke-linecap:round] [stroke-linejoin:round] ${cls}`),
    ],
    name === "stop"
      ? [h.rect([h.X("4.5"), h.Y("4.5"), h.Width("7"), h.Height("7"), h.Rx("1.5"), h.Class("fill-current stroke-none")])]
      : PATHS[name].map((d) => h.path([h.D(d)])),
  );
