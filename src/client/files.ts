import * as Option from "effect/Option";
import type { Html, HtmlBuilder } from "foldkit/html";
import { FileFlag } from "../shared/contract";
import { has, type Index, indexOf, isFolder, isRegular, type Node, putioUrl } from "./library";
import { Message, type Model, PLAYER_ID, treeNodeId } from "./main";
import { bytes, isPlayable } from "./cards";
import { fmt, size } from "./steps";

type H = HtmlBuilder<Message>;

const TREE_CAP = 300;

export const libraryIndex = (model: Model): Index | null => (model.library ? indexOf(model.library) : null);

const putioLink = (h: H, n: Node): Html =>
  !isRegular(n)
    ? h.span([], [])
    : h.a(
    [
      h.Href(putioUrl(n.id)),
      h.Target("_blank"),
      h.Rel("noopener noreferrer"),
      h.Class("hit text-fg-3 transition-colors duration-160 hover:text-fg"),
      h.AriaLabel(`open ${n.name} on put.io`),
      h.Title("open on put.io"),
    ],
    ["↗"],
  );

// ---------- tree drawer ----------

const treeRow = (h: H, model: Model, ix: Index, n: Node, siblingMax: number): Html[] => {
  const folder = isFolder(n);
  const open = folder && model.treeExpanded.includes(n.id);
  const focused = model.treeFocus === n.id;
  const width = siblingMax > 0 && isRegular(n) ? Math.min(100, Math.max(2, Math.round((n.size / siblingMax) * 100))) : 0;
  const counts = [
    ...(n.junk > 0 ? [`${fmt(n.junk)} junk`] : []),
    ...(n.unplayed > 0 && folder ? [`${fmt(n.unplayed)} unplayed`] : []),
  ].join(" · ");
  const row = h.div(
    [
      h.Id(treeNodeId(n.id)),
      h.Role("treeitem"),
      h.AriaLevel(n.depth),
      ...(folder ? [h.AriaExpanded(open)] : []),
      h.Tabindex(-1),
      h.Class(
        `group relative grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 py-1.5 pe-3 outline-none hover:bg-raised focus-visible:bg-raised ${focused ? "bg-raised before:absolute before:inset-y-0 before:start-0 before:w-px before:bg-accent" : ""}`,
      ),
      h.Style({ paddingInlineStart: `${12 + (n.depth - 1) * 14}px` }),
    ],
    [
      h.button(
        [
          h.Type("button"),
          h.Class("grid min-w-0 gap-1 text-start"),
          h.OnClick(folder ? Message.ToggledTreeNode({ id: n.id }) : Message.RevealedFile({ id: n.id, ancestors: [] })),
        ],
        [
          h.span([h.Class("flex min-w-0 items-center gap-2 text-[13px]")], [
            h.span([h.Class(`w-2.5 flex-none text-fg-4 transition-transform duration-160 ${open ? "rotate-90" : ""}`), h.AriaHidden(true)], [folder ? "›" : ""]),
            h.span([h.Class(`truncate ${folder ? "text-fg-strong" : has(n, FileFlag.junk) ? "text-fg-3" : "text-fg"}`)], [n.name]),
          ]),
          h.span([h.Class("ms-[18px] block h-0.5 bg-line")], [h.i([h.Class(`block h-full ${n.junk > 0 && !folder ? "bg-fg-4" : "bg-fg-3"}`), h.Style({ width: `${width}%` })], [])]),
          ...(counts ? [h.span([h.Class("ms-[18px] truncate text-[12px] text-fg-3")], [counts])] : []),
        ],
      ),
      h.div(
        [h.Class("flex items-center gap-3")],
        [
          h.span([h.Class("text-[12px] text-fg-2 tabular-nums")], [isRegular(n) ? bytes(n) : "shared"]),
          ...(isPlayable(n)
            ? [
                h.button(
                  [
                    h.Type("button"),
                    h.Class("hit text-[12px] text-fg-3 transition-colors duration-160 hover:text-fg"),
                    h.AriaLabel(`play ${n.name}`),
                    h.OnClick(Message.OpenedPlayer({ id: n.id, name: n.name })),
                  ],
                  ["play"],
                ),
              ]
            : []),
          ...(folder && isRegular(n)
            ? [
                h.button(
                  [
                    h.Type("button"),
                    h.Class("hit text-[12px] text-fg-3 opacity-0 transition-opacity duration-160 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100 hover:text-fg"),
                    h.AriaLabel(`ask about ${n.name}`),
                    h.Title("target this folder"),
                    h.OnClick(Message.PickedFolder({ folder: { id: n.id, name: n.name.slice(0, 200) } })),
                  ],
                  ["target"],
                ),
              ]
            : []),
          putioLink(h, n),
        ],
      ),
    ],
  );
  if (!open) return [row];
  const kids = n.children.map((c) => ix.nodes.get(c)).filter((c) => c !== undefined);
  const max = kids[0]?.size ?? 0;
  return [
    row,
    ...kids.slice(0, TREE_CAP).flatMap((c) => treeRow(h, model, ix, c, max)),
    ...(kids.length > TREE_CAP
      ? [h.div([h.Class("py-1.5 text-[12px] text-fg-4"), h.Style({ paddingInlineStart: `${30 + n.depth * 14}px` })], [`+${fmt(kids.length - TREE_CAP)} more`])]
      : []),
  ];
};

/** The last scan as a tree, sizes against the largest sibling, in a drawer over the thread. */
export const treeDrawer = (h: H, model: Model) => {
  const ix = libraryIndex(model);
  if (!ix) return [];
  const open = model.treeOpen;
  const tops = ix.top.map((id) => ix.nodes.get(id)).filter((n) => n !== undefined);
  const max = tops.find(isRegular)?.size ?? 0;
  return [
    ...(open
      ? [
          h.button(
            [
              h.Type("button"),
              h.Tabindex(-1),
              h.AriaLabel("close library"),
              h.Class("fixed inset-0 z-20 cursor-default bg-black/60 min-[1180px]:hidden"),
              h.OnClick(Message.ClosedTree()),
            ],
            [],
          ),
        ]
      : []),
    h.aside(
      [
        h.AriaLabel("library"),
        h.AriaHidden(!open),
        ...(open ? [] : [h.Inert(true)]),
        h.Class(
          `fixed top-14 right-0 bottom-0 z-30 flex w-[420px] max-w-full flex-col border-s border-t border-line bg-bg shadow-[-16px_0_40px_rgb(0_0_0/0.35)] transition-transform duration-220 ease-snappy ${open ? "translate-x-0" : "translate-x-full"}`,
        ),
        h.OnKeyDownPreventDefault((key) => (key === "Escape" && open ? Option.some(Message.ClosedTree()) : Option.none())),
      ],
      [
        h.div(
          [h.Class("flex items-center gap-3 border-b border-line px-4 py-3")],
          [
            h.div(
              [h.Class("grid min-w-0 grow gap-0.5")],
              [h.span([h.Class("text-[12px] text-fg-3")], ["library"]), h.span([h.Class("truncate text-[13px] text-fg-strong")], [`${ix.rootName} · ${size(ix.total)}`])],
            ),
            h.button([h.Type("button"), h.Class("hit text-[13px] text-fg-2 hover:text-fg"), h.OnClick(Message.ClosedTree())], ["close"]),
          ],
        ),
        h.div([h.Role("tree"), h.AriaLabel(`${ix.rootName} tree`), h.Class("min-h-0 flex-1 overflow-y-auto overscroll-contain py-1")], tops.flatMap((n) => treeRow(h, model, ix, n, max))),
      ],
    ),
  ];
};

// ---------- player ----------

/** put.io's HLS stream in an overlay; Escape or the backdrop closes it. */
export const playerView = (h: H, model: Model) => {
  const p = model.player;
  if (!p) return [];
  return [
    h.div(
      [
        h.Class("fixed inset-0 z-40 grid place-items-center bg-black/80 p-4 max-[520px]:p-0"),
        h.Role("dialog"),
        h.AriaModal(true),
        h.AriaLabel(`playing ${p.name}`),
        h.OnKeyDownPreventDefault((key) => (key === "Escape" ? Option.some(Message.ClosedPlayer()) : Option.none())),
      ],
      [
        h.button([h.Type("button"), h.Tabindex(-1), h.AriaLabel("close player"), h.Class("absolute inset-0 cursor-default"), h.OnClick(Message.ClosedPlayer())], []),
        h.div(
          [h.Class("pop relative grid w-full max-w-[960px] overflow-hidden rounded-2xl border border-line bg-bg")],
          [
            h.div(
              [h.Class("flex items-center gap-3 border-b border-line px-4 py-2.5")],
              [
                h.span([h.Class("min-w-0 grow truncate text-[13px] text-fg-strong"), h.Title(p.name)], [p.name]),
                h.a(
                  [h.Href(putioUrl(p.id)), h.Target("_blank"), h.Rel("noopener noreferrer"), h.Class("hit text-[13px] text-fg-3 hover:text-fg")],
                  ["put.io ↗"],
                ),
                h.button([h.Type("button"), h.Class("hit text-[13px] text-fg-2 hover:text-fg"), h.OnClick(Message.ClosedPlayer())], ["close"]),
              ],
            ),
            h.div(
              [h.Class("relative aspect-video bg-black")],
              p.failed
                ? [h.p([h.Class("absolute inset-0 m-0 grid place-items-center text-[13px] text-fg-2")], ["couldn’t load this stream. open it on put.io"])]
                : [
                    h.video([h.Id(PLAYER_ID), h.Controls(true), h.Playsinline(true), h.Class("absolute inset-0 size-full")], []),
                    ...(p.src === null ? [h.span([h.Class("absolute inset-0 grid place-items-center text-[13px] text-fg-3")], ["loading…"])] : []),
                  ],
            ),
          ],
        ),
      ],
    ),
  ];
};
