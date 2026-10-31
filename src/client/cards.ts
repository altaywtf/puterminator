import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { Html, HtmlBuilder } from "foldkit/html";
import type { Audit } from "../shared/audit";
import { FileFlag } from "../shared/contract";
import { ListFolderOutput, SearchFilesOutput } from "../shared/tools";
import { art, type Mood, moodOf, pixels } from "./art";
import { has, type Index, indexOf, isFolder, isRegular, type Node, putioUrl, resolve } from "./library";
import { Message, type Model } from "./main";
import { auditOf, fmt, size } from "./steps";

// Cards: what a finished tool call looks like in the thread. One entry per tool in CARDS; the thread
// asks toolCard and renders whatever comes back. /lab renders the same functions from fixtures.

type H = HtmlBuilder<Message>;

/** All a card reads from the app: which toggles are open and the last scan's file index. */
export type Ctx = Pick<Model, "expanded" | "library">;

const ROWS = 5;

const indexOfCtx = (ctx: Ctx): Index | null => (ctx.library ? indexOf(ctx.library) : null);

export const bytes = (n: Node) => (n.size === 0 ? "empty" : size(n.size));

const parentPath = (n: Node) => n.path.slice(0, n.path.length - n.name.length - 1) || "/";

export const isPlayable = (n: Node) => has(n, FileFlag.video) && isRegular(n);

export type Kind = "folder" | "video" | "audio" | "image" | "archive" | "subtitle" | "text" | "file";

// Pixel file icons on an 8×8 grid, drawn at 2× in the text colour.
const ICONS: Record<Kind, readonly string[]> = {
  folder: ["###.....", "########", "#......#", "#......#", "#......#", "#......#", "#......#", "########"],
  video: ["########", "#......#", "#.##...#", "#.####.#", "#.####.#", "#.##...#", "#......#", "########"],
  audio: ["..######", "..#....#", "..#....#", "..#....#", ".##...##", "###..###", "###..###", ".#....#."],
  image: ["########", "#......#", "#....#.#", "#......#", "#..#...#", "#.###..#", "########"],
  archive: ["####.###", "#..#...#", "#.#....#", "#..#...#", "#.#....#", "#..#...#", "#.##...#", "########"],
  subtitle: ["########", "#......#", "#......#", "#.##.###", "#......#", "#.####.#", "#......#", "########"],
  text: ["######..", "#....##.", "#.##..##", "#......#", "#.####.#", "#......#", "#.####.#", "########"],
  file: ["######..", "#....##.", "#.....##", "#......#", "#......#", "#......#", "#......#", "########"],
};

const EXT: Array<[Kind, RegExp]> = [
  ["video", /^(mkv|mp4|m4v|avi|mov|webm|wmv|ts|flv|mpe?g)$/],
  ["audio", /^(mp3|flac|m4a|aac|ogg|opus|wav)$/],
  ["image", /^(jpe?g|png|gif|webp|bmp|heic)$/],
  ["archive", /^(zip|rar|7z|tar|gz|bz2|xz|r\d\d)$/],
  ["subtitle", /^(srt|ass|ssa|vtt|sub|idx)$/],
  ["text", /^(txt|nfo|md|pdf|epub|docx?|log|sfv)$/],
];

/** A kind from the name alone, for paths that aren't in the snapshot (a plan's targets). */
export const kindOfName = (name: string, folder = false): Kind => {
  if (folder) return "folder";
  const ext = name.match(/\.([a-z0-9]{1,5})$/i)?.[1]?.toLowerCase() ?? "";
  return EXT.find(([, re]) => re.test(ext))?.[0] ?? "file";
};

const kindOf = (n: Node): Kind => (has(n, FileFlag.video) && !isFolder(n) ? "video" : kindOfName(n.name, isFolder(n)));

export const icon = (h: H, kind: Kind) => {
  const rows = ICONS[kind];
  return pixels(h, rows, { "#": "currentColor" }, rows.length * 2, "");
};

/** The file's icon, centred on the title's first line; a video's icon is also its play button. */
const fileIcon = (h: H, n: Node) => {
  const slot = "grid h-[22px] w-4 flex-none place-items-center text-fg-3";
  if (!isPlayable(n)) return h.span([h.Class(slot), h.AriaHidden(true)], [icon(h, kindOf(n))]);
  return h.button(
    [
      h.Type("button"),
      h.Class(`hit ${slot} transition-colors duration-160 hover:text-accent focus-visible:text-accent`),
      h.AriaLabel(`play ${n.name}`),
      h.Title("play"),
      h.OnClick(Message.OpenedPlayer({ id: n.id, name: n.name })),
    ],
    [icon(h, "video")],
  );
};

/** Icon, name and size; the reason sits under the name only when there is one. The row itself opens
    the file on put.io, and the path lives in its tooltip. */
const fileRow = (h: H, n: Node, note: string | null = null) => {
  const body = [
    h.span([h.Class("grid min-w-0")], [
      h.span([h.Class("truncate text-[14px] text-fg transition-colors duration-160 group-hover:text-fg-strong")], [isFolder(n) ? `${n.name}/` : n.name]),
      ...(note ? [h.span([h.Class("truncate text-[13px] text-fg-3")], [note])] : []),
    ]),
    h.span([h.Class("text-[13px] leading-[22px] text-fg-3 tabular-nums")], [bytes(n)]),
  ];
  const cls = "grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 no-underline";
  return h.li(
    [h.Class("group -mx-2 grid grid-cols-[16px_minmax(0,1fr)] items-start gap-x-3 rounded-lg px-2 py-2 transition-colors duration-160 hover:bg-hover")],
    [
      fileIcon(h, n),
      isRegular(n)
        ? h.a([h.Href(putioUrl(n.id)), h.Target("_blank"), h.Rel("noopener noreferrer"), h.Title(`${n.path} · open on put.io`), h.Class(cls)], body)
        : h.span([h.Class(cls), h.Title(n.path)], body),
    ],
  );
};

export const showMore = (h: H, key: string, open: boolean, hidden: number) =>
  hidden <= 0
    ? []
    : [
        h.button(
          [
            h.Type("button"),
            h.Class("hit w-fit text-start text-[13px] text-fg-3 transition-colors duration-160 hover:text-fg"),
            h.AriaExpanded(open),
            h.OnClick(Message.ToggledStep({ key })),
          ],
          [open ? "show fewer" : "show all"],
        ),
      ];

/** Files a tool returned, as rows with put.io links; the first few, then a toggle. */
const fileList = (h: H, ctx: Ctx, ix: Index, key: string, nodes: Node[], total: number) => {
  const moreKey = `files.${key}`;
  const open = ctx.expanded.includes(moreKey);
  const shown = open ? nodes : nodes.slice(0, ROWS);
  return h.keyed("div")(moreKey, [h.Class("grid min-w-0 gap-1")], [
    h.ul([h.Class("m-0 grid list-none p-0")], shown.map((n) => fileRow(h, n))),
    ...showMore(h, moreKey, open, nodes.length - ROWS),
  ]);
};

type Tab = "junk" | "duplicates" | "unplayed";

/** Junk, duplicates and never-played as up to three rows: what, how much, and the files on tap. */
/** A 2px track: how much of the whole one thing is. */
export const shareBar = (h: H, share: number, tone = "bg-accent/70") =>
  h.span([h.Class("block h-0.5 w-full overflow-hidden rounded-full bg-line"), h.AriaHidden(true)], [
    h.i([h.Class(`block h-full rounded-full ${tone}`), h.Style({ width: `${Math.min(100, Math.max(1.5, share * 100))}%` })], []),
  ]);

const auditDetails = (h: H, ctx: Ctx, ix: Index | null, key: string, a: Audit) => {
  const tabs: Array<[Tab, string, number, number]> = [
    ["junk", `${fmt(a.junk.count)} junk ${a.junk.count === 1 ? "file" : "files"}`, a.junk.count, a.junk.bytes],
    ["duplicates", `${fmt(a.duplicates.groups)} duplicate ${a.duplicates.groups === 1 ? "group" : "groups"}`, a.duplicates.groups, a.duplicates.wastedBytes],
    ["unplayed", `${fmt(a.neverPlayed.count)} never played`, a.neverPlayed.count, a.neverPlayed.bytes],
  ];
  const tabKey = (t: Tab) => `audit.${key}.${t}`;
  const body = (t: Tab): Html[] => {
    if (!ix) return [h.p([h.Class("m-0 py-1 text-[13px] text-fg-3")], ["scan again to get links for these files"])];
    if (t === "duplicates")
      return a.duplicates.examples.map((d) => {
        const keep = resolve(ix, d.keep);
        const drops = d.drop.map((p) => resolve(ix, p));
        return h.li([h.Class("grid")], [
          ...(keep ? [fileRow(h, keep, `keep · ${parentPath(keep)}`)] : []),
          ...drops.flatMap((n) => (n ? [fileRow(h, n, `drop · ${parentPath(n)}`)] : [])),
        ]);
      });
    const list = t === "junk" ? a.junk.examples : a.neverPlayed.examples;
    return list.flatMap((f) => {
      const n = resolve(ix, f.path);
      return n ? [fileRow(h, n, f.why)] : [];
    });
  };
  const rows = tabs.filter(([, , n]) => n > 0);
  return rows.length === 0
    ? []
    : [
        h.div(
          [h.Class("grid border-t border-line pt-2")],
          rows.flatMap(([t, phrase, , bytes]) => {
            const on = ctx.expanded.includes(tabKey(t));
            return [
              h.button(
                [
                  h.Type("button"),
                  h.Class("group -mx-2 grid grid-cols-[minmax(0,1fr)_auto_12px] items-center gap-x-3 rounded-lg px-2 py-2 text-start transition-colors duration-160 hover:bg-hover"),
                  h.AriaExpanded(on),
                  h.OnClick(Message.ToggledStep({ key: tabKey(t) })),
                ],
                [
                  h.span([h.Class("grid min-w-0 gap-1.5")], [h.span([h.Class("truncate text-[14px] text-fg")], [phrase]), shareBar(h, bytes / Math.max(1, a.totals.bytes))]),
                  h.span([h.Class("text-[13px] text-fg-3 tabular-nums")], [size(bytes)]),
                  h.span([h.Class(`text-fg-4 transition-transform duration-160 ${on ? "rotate-90" : ""}`), h.AriaHidden(true)], ["›"]),
                ],
              ),
              ...(on
                ? (() => {
                    const items = body(t);
                    const allKey = `${tabKey(t)}.all`;
                    const all = ctx.expanded.includes(allKey);
                    return [
                      h.ul([h.Class("m-0 grid list-none p-0 ps-2"), h.AriaLabel(phrase)], all ? items : items.slice(0, ROWS)),
                      ...showMore(h, allKey, all, items.length - ROWS).map((b) => h.div([h.Class("mb-1 ps-2")], [b])),
                    ];
                  })()
                : []),
            ];
          }),
        ),
      ];
};

const MOOD_LINE: Record<Mood, string> = {
  jar: "no junk. no doubles. rare.",
  shades: "nothing to terminate.",
  dust: "mostly tidy. a little dust.",
  mop: "lived in.",
  wading: "needs a mop.",
  flood: "slime all the way down.",
  idle: "",
  asleep: "",
  unplugged: "",
};

const scoreCard = (h: H, ctx: Ctx, a: Audit, uid: string, live: boolean) => {
  const mood = moodOf(a);
  const subs: Array<[string, number]> = [
    ["naming", a.scores.naming],
    ["structure", a.scores.structure],
    ["junk", a.scores.junk],
    ["duplicates", a.scores.duplicates],
  ];
  const worst = Math.min(...subs.map((s) => s[1]));
  const worstName = worst < 100 ? subs.find((s) => s[1] === worst)?.[0] : undefined;
  const verdict = [MOOD_LINE[mood], ...(worstName ? [`${worstName} needs the most work.`] : []), ...(a.truncated ? ["partial scan."] : [])].join(" ");
  return h.section(
    [
      h.Class(`${live ? "enter" : ""} grid gap-5 rounded-2xl border border-line bg-raised p-6 max-[480px]:p-5`),
      h.AriaLabel("library score"),
      h.DataAttribute("testid", "score-card"),
    ],
    [
      // Number and verdict share one left edge; the mascot sits top-right, the same height as the number.
      h.div(
        [h.Class("grid grid-cols-[minmax(0,1fr)_auto] items-start gap-6")],
        [
          h.div(
            [h.Class("grid min-w-0 gap-3")],
            [
              h.span(
                [h.Class("flex items-baseline gap-2"), h.Role("img"), h.AriaLabel(`library score ${a.score} out of 100`)],
                [
                  h.span([h.Class("font-display text-[64px] leading-[0.8] font-medium text-accent tabular-nums")], [`${a.score}`]),
                  h.span([h.Class("font-display text-[20px] leading-none text-fg-3")], ["/100"]),
                ],
              ),
              h.p([h.Class("m-0 max-w-[40ch] text-[15px] text-fg-2")], [verdict]),
            ],
          ),
          art(h, mood, 52),
        ],
      ),
      ...auditDetails(h, ctx, indexOfCtx(ctx), uid, a),
    ],
  );
};


// ---------- folder ----------

export const panel = (h: H, label: string, live: boolean, children: Html[]) =>
  h.section([h.Class(`${live ? "enter" : ""} grid gap-3 rounded-2xl border border-line bg-raised p-5 max-[480px]:p-4`), h.AriaLabel(label)], children);

export const cardHead = (h: H, title: string, meta: string) =>
  h.div([h.Class("flex min-w-0 items-baseline justify-between gap-4")], [
    h.span([h.Class("truncate text-[15px] text-fg-strong")], [title]),
    h.span([h.Class("flex-none text-[13px] text-fg-3 tabular-nums")], [meta]),
  ]);

/** A child of the listed folder: name over a bar sized against the biggest sibling. */
const sizeRow = (h: H, n: Node, max: number) =>
  h.li([h.Class("group -mx-2 grid grid-cols-[16px_minmax(0,1fr)] items-start gap-x-3 rounded-lg px-2 py-2 transition-colors duration-160 hover:bg-hover")], [
    h.span([h.Class("grid h-[22px] w-4 place-items-center text-fg-3"), h.AriaHidden(true)], [icon(h, kindOf(n))]),
    h.a(
      [
        h.Href(putioUrl(n.id)),
        h.Target("_blank"),
        h.Rel("noopener noreferrer"),
        h.Title(`${n.path} · open on put.io`),
        h.Class("grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 gap-y-1.5 no-underline"),
      ],
      [
        h.span([h.Class("truncate text-[14px] text-fg transition-colors duration-160 group-hover:text-fg-strong")], [isFolder(n) ? `${n.name}/` : n.name]),
        h.span([h.Class("text-[13px] leading-[22px] text-fg-3 tabular-nums")], [bytes(n)]),
        h.span([h.Class("col-span-2")], [shareBar(h, max > 0 ? n.size / max : 0, isFolder(n) ? "bg-fg-3" : "bg-accent/70")]),
      ],
    ),
  ]);

const folderCard = (h: H, ctx: Ctx, key: string, out: ListFolderOutput, live: boolean): Html | null => {
  const ix = indexOfCtx(ctx);
  if (!ix) return null;
  const base = out.path === "/" ? "" : out.path;
  const folder = base ? resolve(ix, base) : null;
  const nodes = out.items.flatMap((i) => {
    const n = resolve(ix, `${base}/${i.name}`);
    return n ? [n] : [];
  });
  if (nodes.length === 0) return null;
  nodes.sort((a, b) => b.size - a.size);
  const total = folder ? folder.size : ix.total;
  const moreKey = `folder.${key}`;
  const all = ctx.expanded.includes(moreKey);
  return panel(h, "folder", live, [
    cardHead(h, folder ? `${folder.name}/` : ix.rootName, `${fmt(out.count)} ${out.count === 1 ? "item" : "items"} · ${size(total)}`),
    h.ul([h.Class("m-0 grid list-none p-0")], (all ? nodes : nodes.slice(0, ROWS)).map((n) => sizeRow(h, n, nodes[0]?.size ?? 0))),
    ...showMore(h, moreKey, all, nodes.length - ROWS),
  ]);
};

// ---------- search ----------

const searchCard = (h: H, ctx: Ctx, key: string, out: SearchFilesOutput, live: boolean): Html | null => {
  const ix = indexOfCtx(ctx);
  if (!ix) return null;
  const nodes = out.items.flatMap((i) => {
    const n = resolve(ix, i.path);
    return n ? [n] : [];
  });
  if (nodes.length === 0) return null;
  return panel(h, "files", live, [
    cardHead(h, `${fmt(out.total)} ${out.total === 1 ? "file" : "files"}`, out.bytes),
    fileList(h, ctx, ix, key, nodes, out.total),
  ]);
};

// ---------- registry ----------

const decodeListFolder = Schema.decodeUnknownOption(Schema.fromJsonString(ListFolderOutput));
const decodeSearchFiles = Schema.decodeUnknownOption(Schema.fromJsonString(SearchFilesOutput));

type Card = (h: H, ctx: Ctx, key: string, output: string, live: boolean) => Html | null;

const CARDS: Record<string, Card> = {
  scan_library: (h, ctx, key, output, live) => Option.match(auditOf(output), { onNone: () => null, onSome: (a) => scoreCard(h, ctx, a, key, live) }),
  list_folder: (h, ctx, key, output, live) => Option.match(decodeListFolder(output), { onNone: () => null, onSome: (o) => folderCard(h, ctx, key, o, live) }),
  search_files: (h, ctx, key, output, live) => Option.match(decodeSearchFiles(output), { onNone: () => null, onSome: (o) => searchCard(h, ctx, key, o, live) }),
};

/** The card for a finished tool call, or null when the tool has none or its output doesn't decode. */
export const toolCard = (h: H, ctx: Ctx, tool: { name: string; key: string; output: string | null }, live: boolean): Html | null => {
  const card = CARDS[tool.name];
  return card && tool.output !== null ? card(h, ctx, tool.key, tool.output, live) : null;
};
