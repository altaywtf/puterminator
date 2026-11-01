import * as Option from "effect/Option";
import type { Html, HtmlBuilder } from "foldkit/html";
import { FileFlag } from "../shared/contract";
import { has, type Index, indexOf, isFolder, isRegular, type Node, putioUrl } from "./library";
import { Message, type Model, PLAYER_CLOSE_ID, PLAYER_ID, treeNodeId } from "./main";
import { bytes, isPlayable } from "./cards";
import { fmt, size } from "./steps";

type H = HtmlBuilder<Message>;

const TREE_CAP = 300;

const libraryIndex = (model: Model): Index | null => (model.library ? indexOf(model.library) : null);

const putioLink = (h: H, n: Node): Html =>
  !isRegular(n)
    ? h.span([], [])
    : h.a(
    [
      h.Href(putioUrl(n.id)),
      h.Target("_blank"),
      h.Rel("noopener noreferrer"),
      h.Class("hit text-fg-4 transition-colors duration-160 hover:text-fg"),
      h.AriaLabel(`open ${n.name} on put.io`),
      h.Title("open on put.io"),
    ],
    ["↗"],
  );

const treeRow = (h: H, model: Model, ix: Index, n: Node, prefix: string, last: boolean): Html[] => {
  const folder = isFolder(n);
  const open = folder && model.treeExpanded.includes(n.id);
  const focused = model.treeFocus === n.id;
  const note = [...(n.junk > 0 ? [`${fmt(n.junk)} junk`] : []), ...(n.unplayed > 0 && folder ? [`${fmt(n.unplayed)} unplayed`] : [])].join(", ");

  const row = h.div(
    [
      h.Id(treeNodeId(n.id)),
      h.Role("treeitem"),
      h.AriaLevel(n.depth),
      ...(folder ? [h.AriaExpanded(open)] : []),
      h.Tabindex(-1),
      h.Class(
        `group grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 px-4 outline-none hover:bg-hover focus-visible:bg-hover ${focused ? "bg-hover shadow-[inset_2px_0_0_var(--accent)]" : ""}`,
      ),
    ],
    [
      h.button(
        [
          h.Type("button"),
          h.Class("flex min-w-0 items-baseline text-start whitespace-pre"),
          h.OnClick(folder ? Message.ToggledTreeNode({ id: n.id }) : Message.RevealedFile({ id: n.id, ancestors: [] })),
        ],
        [
          h.span([h.Class("flex-none text-fg-4/60"), h.AriaHidden(true)], [`${prefix}${last ? "└─ " : "├─ "}`]),
          h.span([h.Class("flex-none text-fg-4"), h.AriaHidden(true)], [folder ? (open ? "▾ " : "▸ ") : ""]),
          h.span([h.Class(`min-w-0 truncate ${folder ? "text-fg" : has(n, FileFlag.junk) ? "text-fg-4" : "text-fg-2"}`)], [folder ? `${n.name}/` : n.name]),
          ...(note ? [h.span([h.Class("ms-2 min-w-0 shrink-[999] truncate text-fg-4 max-[480px]:hidden")], [`# ${note}`])] : []),
        ],
      ),
      h.div(
        [h.Class("flex items-baseline gap-3")],
        [
          h.span([h.Class("text-fg-3 tabular-nums")], [isRegular(n) ? bytes(n) : "shared"]),
          ...(isPlayable(n)
            ? [
                h.button(
                  [h.Type("button"), h.Class("hit text-fg-4 transition-colors duration-160 hover:text-accent"), h.AriaLabel(`play ${n.name}`), h.Title("play"), h.OnClick(Message.OpenedPlayer({ id: n.id, name: n.name }))],
                  ["▶"],
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
  const inner = `${prefix}${last ? "   " : "│  "}`;
  const allKey = `tree.${n.id}.all`;
  const shown = model.expanded.includes(allKey) ? kids : kids.slice(0, TREE_CAP);

  return [
    row,
    ...shown.flatMap((c, i) => treeRow(h, model, ix, c, inner, i === shown.length - 1 && shown.length === kids.length)),
    ...(shown.length < kids.length
      ? [
          h.button(
            [h.Type("button"), h.Class("px-4 text-start whitespace-pre text-fg-4 transition-colors duration-160 hover:text-accent"), h.OnClick(Message.ToggledStep({ key: allKey }))],
            [`${inner}└─ … ${fmt(kids.length - shown.length)} more`],
          ),
        ]
      : []),
  ];
};

/** The last scan as a tree, sizes against the largest sibling, in a drawer over the thread. */
export const treeDrawer = (h: H, model: Model) => {
  const ix = libraryIndex(model);

  if (!ix) return [];
  const open = model.treeOpen;
  const tops = ix.top.map((id) => ix.nodes.get(id)).filter((n) => n !== undefined);

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
          [h.Class("flex items-baseline gap-3 border-b border-line px-4 py-3 font-mono text-mono")],
          [
            h.span([h.Class("min-w-0 grow truncate text-fg-2")], [`$ tree ${ix.rootName}`]),
            h.span([h.Class("flex-none text-fg-4 tabular-nums")], [size(ix.total)]),
            h.button([h.Type("button"), h.Class("hit text-fg-3 hover:text-fg"), h.AriaLabel("close library"), h.OnClick(Message.ClosedTree())], ["esc"]),
          ],
        ),
        h.div(
          [h.Role("tree"), h.AriaLabel(`${ix.rootName} tree`), h.Class("min-h-0 flex-1 overflow-y-auto overscroll-contain bg-sunk py-2 font-mono text-mono leading-[1.8]")],
          tops.flatMap((n, i) => treeRow(h, model, ix, n, "", i === tops.length - 1)),
        ),
      ],
    ),
  ];
};

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
          [h.Class("pop relative grid w-full max-w-[960px] overflow-hidden rounded-xl border border-line bg-bg")],
          [
            h.div(
              [h.Class("flex items-baseline gap-3 border-b border-line px-4 py-2.5 font-mono text-mono")],
              [
                h.span([h.Class("min-w-0 grow truncate text-fg-2"), h.Title(p.name)], [`▶ ${p.name}`]),
                h.a([h.Href(putioUrl(p.id)), h.Target("_blank"), h.Rel("noopener noreferrer"), h.Class("hit text-fg-3 hover:text-fg")], ["put.io ↗"]),
                h.button([h.Type("button"), h.Id(PLAYER_CLOSE_ID), h.Class("hit text-fg-3 hover:text-fg"), h.AriaLabel("close player"), h.OnClick(Message.ClosedPlayer())], ["esc"]),
              ],
            ),
            h.div(
              [h.Class("relative aspect-video bg-black")],
              p.failed
                ? [h.p([h.Class("absolute inset-0 m-0 grid place-items-center font-mono text-mono text-fg-2")], ["couldn’t load this stream. open it on put.io"])]
                : [
                    h.video([h.Id(PLAYER_ID), h.Controls(true), h.Playsinline(true), h.Class("absolute inset-0 size-full")], []),
                    ...(p.src === null ? [h.span([h.Class("absolute inset-0 grid place-items-center font-mono text-mono text-fg-3")], ["loading…"])] : []),
                  ],
            ),
          ],
        ),
      ],
    ),
  ];
};
