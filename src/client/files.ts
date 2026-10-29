import * as Option from "effect/Option";
import type { Html, HtmlBuilder } from "foldkit/html";
import type { Audit } from "../shared/audit";
import { FileFlag } from "../shared/contract";
import { ancestors, has, type Index, indexOf, isFolder, isRegular, type Node, putioUrl, resolve } from "./library";
import { Message, type Model, PLAYER_ID, treeNodeId } from "./main";
import { fmt, size } from "./steps";

type H = HtmlBuilder<Message>;

const ROWS = 6;
const TREE_CAP = 300;

export const libraryIndex = (model: Model): Index | null => (model.library ? indexOf(model.library) : null);

const record = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const parse = (s: string | null): Record<string, unknown> | null => {
  if (!s) return null;
  try {
    return record(JSON.parse(s));
  } catch {
    return null;
  }
};

/** The files a `search_files` or `list_folder` result names, matched to the snapshot. */
export const toolFiles = (ix: Index, name: string, input: unknown, output: string | null): { nodes: Node[]; total: number } | null => {
  const out = parse(output);
  if (!out || !Array.isArray(out.items)) return null;
  const items = out.items.map(record);
  if (name === "search_files") {
    const nodes = items.flatMap((i) => (typeof i.path === "string" ? [resolve(ix, i.path)] : [])).filter((n) => n !== null);
    return { nodes, total: typeof out.total === "number" ? out.total : nodes.length };
  }
  if (name === "list_folder") {
    const base = String(record(input).path ?? "").replace(/\/+$/, "");
    const nodes = items.flatMap((i) => (typeof i.name === "string" ? [resolve(ix, `${base}/${i.name}`)] : [])).filter((n) => n !== null);
    return { nodes, total: typeof out.count === "number" ? out.count : nodes.length };
  }
  return null;
};

const bytes = (n: Node) => (n.size === 0 ? "empty" : size(n.size));

const parentPath = (n: Node) => n.path.slice(0, n.path.length - n.name.length - 1) || "/";

const badges = (h: H, n: Node) => [
  ...(has(n, FileFlag.junk) ? [h.span([h.Class("u-tag h-[18px]!")], ["junk"])] : []),
  ...(has(n, FileFlag.video) && !has(n, FileFlag.played) ? [h.span([h.Class("u-tag h-[18px]!")], ["unplayed"])] : []),
  ...(has(n, FileFlag.messy) ? [h.span([h.Class("u-tag h-[18px]! max-[520px]:hidden")], ["release name"])] : []),
];

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

const revealButton = (h: H, ix: Index, n: Node) =>
  h.button(
    [
      h.Type("button"),
      h.Class("hit text-[11px] text-fg-3 transition-colors duration-160 hover:text-fg"),
      h.AriaLabel(`show ${n.name} in the library tree`),
      h.OnClick(Message.RevealedFile({ id: n.id, ancestors: ancestors(ix, n.id) })),
    ],
    ["tree"],
  );

const isPlayable = (n: Node) => has(n, FileFlag.video) && isRegular(n);

/** A 16:9 tile: the put.io screenshot for videos (and the play button), the extension otherwise. */
const tile = (h: H, n: Node) => {
  const box = "relative grid h-9 w-16 flex-none place-items-center overflow-hidden border border-line bg-black";
  if (!isPlayable(n)) {
    const ext = isFolder(n) ? "dir" : (n.name.match(/\.([a-z0-9]{1,5})$/i)?.[1] ?? "file");
    return h.span([h.Class(`${box} text-[10px] tracking-[0.08em] text-fg-4 uppercase`), h.AriaHidden(true)], [ext]);
  }
  return h.button(
    [
      h.Type("button"),
      h.Class(`${box} group/tile`),
      h.AriaLabel(`play ${n.name}`),
      h.OnClick(Message.OpenedPlayer({ id: n.id, name: n.name })),
    ],
    [
      h.img([
        h.Src(`/api/files/${n.id}/thumb`),
        h.Alt(""),
        h.Loading("lazy"),
        h.Decoding("async"),
        h.Width("64"),
        h.Height("36"),
        h.Draggable(false),
        h.Class("absolute inset-0 size-full object-cover select-none"),
      ]),
      h.span(
        [
          h.Class("relative text-[11px] text-fg-strong opacity-70 transition-opacity duration-160 group-hover/tile:opacity-100 [text-shadow:0_0_4px_#000]"),
          h.AriaHidden(true),
        ],
        ["▶"],
      ),
    ],
  );
};

const fileRow = (h: H, ix: Index, n: Node, note: string | null = null) =>
  h.li(
    [h.Class("group grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 border-t border-line px-3 py-2 first:border-t-0 hover:bg-bg")],
    [
      tile(h, n),
      h.div(
        [h.Class("grid min-w-0 gap-0.5")],
        [
          h.span([h.Class("truncate text-[13px] text-fg-strong"), h.Title(n.path)], [isFolder(n) ? `${n.name}/` : n.name]),
          h.span([h.Class("flex min-w-0 items-center gap-2 text-[11px] text-fg-3")], [
            h.span([h.Class("truncate")], [note ?? parentPath(n)]),
            ...badges(h, n),
          ]),
        ],
      ),
      h.div(
        [h.Class("flex items-center gap-3")],
        [h.span([h.Class("text-[11px] text-fg-2 tabular-nums")], [bytes(n)]), revealButton(h, ix, n), putioLink(h, n)],
      ),
    ],
  );

const showMore = (h: H, key: string, open: boolean, hidden: number) =>
  hidden <= 0
    ? []
    : [
        h.button(
          [
            h.Type("button"),
            h.Class("w-full border-t border-line px-3 py-2 text-start text-[11px] text-fg-3 transition-colors duration-160 hover:text-fg"),
            h.AriaExpanded(open),
            h.OnClick(Message.ToggledStep({ key })),
          ],
          [open ? "show fewer" : `show ${fmt(hidden)} more`],
        ),
      ];

/** Files a tool returned, as rows with put.io links; the first few, then a toggle. */
export const fileList = (h: H, model: Model, ix: Index, key: string, nodes: Node[], total: number) => {
  const moreKey = `files.${key}`;
  const open = model.expanded.includes(moreKey);
  const shown = open ? nodes : nodes.slice(0, ROWS);
  return h.keyed("div")(moreKey, [h.Class("grid min-w-0 border border-line bg-sunk")], [
    h.div(
      [h.Class("flex items-center justify-between border-b border-line px-3 py-1.5")],
      [
        h.span([h.Class("u-label")], [`${fmt(total)} ${total === 1 ? "file" : "files"}`]),
        ...(total > nodes.length ? [h.span([h.Class("text-[11px] text-fg-4")], [`showing ${fmt(nodes.length)}`])] : []),
      ],
    ),
    h.ul([h.Class("m-0 grid list-none p-0")], shown.map((n) => fileRow(h, ix, n))),
    ...showMore(h, moreKey, open, nodes.length - ROWS),
  ]);
};

type Tab = "junk" | "duplicates" | "unplayed";

/** Junk, duplicate and never-played examples from a scan, behind pills in the score card. */
export const auditDetails = (h: H, model: Model, ix: Index | null, key: string, a: Audit) => {
  const tabs: Array<[Tab, string, number]> = [
    ["junk", "junk", a.junk.count],
    ["duplicates", "duplicates", a.duplicates.groups],
    ["unplayed", "never played", a.neverPlayed.count],
  ];
  const tabKey = (t: Tab) => `audit.${key}.${t}`;
  const open = tabs.filter(([t, , n]) => n > 0 && model.expanded.includes(tabKey(t)));
  const body = (t: Tab): Html[] => {
    if (!ix) return [h.p([h.Class("m-0 px-3 py-2 text-[11px] text-fg-3")], ["scan again to get links for these files."])];
    if (t === "duplicates")
      return a.duplicates.examples.map((d) => {
        const keep = resolve(ix, d.keep);
        const drops = d.drop.map((p) => resolve(ix, p));
        return h.li([h.Class("grid border-t border-line first:border-t-0")], [
          ...(keep ? [fileRow(h, ix, keep, `keep · ${parentPath(keep)}`)] : []),
          ...drops.flatMap((n) => (n ? [fileRow(h, ix, n, `drop · ${parentPath(n)}`)] : [])),
        ]);
      });
    const list = t === "junk" ? a.junk.examples : a.neverPlayed.examples;
    return list.flatMap((f) => {
      const n = resolve(ix, f.path);
      return n ? [fileRow(h, ix, n, `${f.why} · ${parentPath(n)}`)] : [];
    });
  };
  return [
    h.div(
      [h.Class("flex flex-wrap items-center gap-2 border-t border-line px-5 py-3")],
      tabs.map(([t, name, n]) =>
        h.button(
          [
            h.Type("button"),
            h.Class("u-pill disabled:opacity-40"),
            h.Disabled(n === 0),
            h.AriaPressed(String(model.expanded.includes(tabKey(t)))),
            h.OnClick(Message.ToggledStep({ key: tabKey(t) })),
          ],
          [`${name} · ${fmt(n)}`],
        ),
      ),
    ),
    ...open.map(([t, name]) =>
      h.div([h.Class("border-t border-line bg-sunk")], [
        h.span([h.Class("u-label block px-3 pt-2")], [name]),
        h.ul([h.Class("m-0 grid list-none p-0")], body(t)),
      ]),
    ),
  ];
};

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
          ...(counts ? [h.span([h.Class("ms-[18px] truncate text-[11px] text-fg-3")], [counts])] : []),
        ],
      ),
      h.div(
        [h.Class("flex items-center gap-3")],
        [
          h.span([h.Class("text-[11px] text-fg-2 tabular-nums")], [isRegular(n) ? bytes(n) : "shared"]),
          ...(isPlayable(n)
            ? [
                h.button(
                  [
                    h.Type("button"),
                    h.Class("hit text-[11px] text-fg-3 transition-colors duration-160 hover:text-fg"),
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
                    h.Class("hit text-[11px] text-fg-3 opacity-0 transition-opacity duration-160 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100 hover:text-fg"),
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
      ? [h.div([h.Class("py-1.5 text-[11px] text-fg-4"), h.Style({ paddingInlineStart: `${30 + n.depth * 14}px` })], [`+${fmt(kids.length - TREE_CAP)} more`])]
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
          `fixed top-[57px] right-0 bottom-0 z-30 flex w-[420px] max-w-full flex-col border-s border-line bg-bg transition-transform duration-220 ease-snappy ${open ? "translate-x-0" : "translate-x-full"}`,
        ),
        h.OnKeyDownPreventDefault((key) => (key === "Escape" && open ? Option.some(Message.ClosedTree()) : Option.none())),
      ],
      [
        h.div(
          [h.Class("flex items-center gap-3 border-b border-line px-4 py-3")],
          [
            h.div(
              [h.Class("grid min-w-0 grow gap-0.5")],
              [h.span([h.Class("u-label")], ["library"]), h.span([h.Class("truncate text-[13px] text-fg-strong")], [`${ix.rootName} · ${size(ix.total)}`])],
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
          [h.Class("pop relative grid w-full max-w-[960px] border border-line bg-bg")],
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
                ? [h.p([h.Class("absolute inset-0 m-0 grid place-items-center text-[13px] text-fg-2")], ["couldn’t load this stream. try it on put.io."])]
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
