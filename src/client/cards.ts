import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { Html, HtmlBuilder } from "foldkit/html";
import type { Audit } from "../shared/audit";
import { FileFlag } from "../shared/contract";
import { Plan, Question } from "../shared/actions";
import { DownloadLinksOutput, FreeSpaceOutput, LayoutOutput, ListFolderOutput, SearchFilesOutput } from "../shared/tools";
import { discardedLine, planCard, questionCard, runCard } from "./actions";
import { art, type Mood, moodOf } from "./art";
import { has, type Index, indexOf, isFolder, isRegular, type Node, putioUrl, resolve } from "./library";
import { Message, type Model } from "./main";
import { auditOf, fmt, size } from "./steps";

type H = HtmlBuilder<Message>;

/** All a card reads from the app: which toggles are open, the last scan's file index, the plans, and whether a turn is running. */
export type Ctx = Pick<Model, "expanded" | "library" | "plans"> & { agent?: Model["agent"]; links?: Model["links"] };

const ROWS = 5;

const indexOfCtx = (ctx: Ctx): Index | null => (ctx.library ? indexOf(ctx.library) : null);

export const bytes = (n: Node) => (n.size === 0 ? "empty" : size(n.size));

const parentPath = (n: Node) => n.path.slice(0, n.path.length - n.name.length - 1) || "/";

export const isPlayable = (n: Node) => has(n, FileFlag.video) && isRegular(n);

/** A sunk mono block, like terminal output; diffs, listings and the score report all sit in one.
    `last` ends the card with it, so a card with nothing under its output has no empty strip. */
export const term = (h: H, children: Html[], last = false) =>
  h.div(
    [h.Class(`-mx-5 grid overflow-x-auto border-t border-line bg-sunk py-2 font-mono text-mono leading-[1.7] max-[480px]:-mx-4 ${last ? "-mb-4" : "border-b"}`)],
    children,
  );

const nameLink = (h: H, n: Node, cls = "") => {
  const text = isFolder(n) ? `${n.name}/` : n.name;

  return isRegular(n)
    ? h.a(
        [h.Href(putioUrl(n.id)), h.Target("_blank"), h.Rel("noopener noreferrer"), h.Title(`${n.path} · open on put.io`), h.Class(`truncate no-underline transition-colors duration-160 hover:text-accent ${cls}`)],
        [text],
      )
    : h.span([h.Class(`truncate ${cls}`), h.Title(n.path)], [text]);
};

const lsRow = (h: H, n: Node, note: string | null = null) =>
  h.li([h.Class("grid grid-cols-[7ch_1.5ch_minmax(0,1fr)_auto] items-baseline gap-x-2 px-3 hover:bg-hover")], [
    h.span([h.Class("text-end text-fg-3 tabular-nums")], [bytes(n)]),
    isPlayable(n)
      ? h.button(
          [h.Type("button"), h.Class("hit text-fg-4 transition-colors duration-160 hover:text-accent focus-visible:text-accent"), h.AriaLabel(`play ${n.name}`), h.Title("play"), h.OnClick(Message.OpenedPlayer({ id: n.id, name: n.name }))],
          ["▶"],
        )
      : h.span([], []),
    nameLink(h, n, isFolder(n) ? "text-fg-2" : "text-fg"),
    h.span([h.Class("max-w-[24ch] truncate text-fg-4 max-[520px]:hidden")], [note ?? ""]),
  ]);

const showMore = (h: H, key: string, open: boolean, hidden: number) =>
  hidden <= 0
    ? []
    : [
        h.button(
          [
            h.Type("button"),
            h.Class("hit w-fit px-3 text-start text-fg-3 transition-colors duration-160 hover:text-fg"),
            h.AriaExpanded(open),
            h.OnClick(Message.ToggledStep({ key })),
          ],
          [open ? "show fewer" : `… ${fmt(hidden)} more`],
        ),
      ];

const lsList = (h: H, ctx: Ctx, key: string, rows: Array<[Node, string | null]>) => {
  const open = ctx.expanded.includes(key);

  return [
    h.ul([h.Class("m-0 grid list-none p-0")], (open ? rows : rows.slice(0, ROWS)).map(([n, note]) => lsRow(h, n, note))),
    ...showMore(h, key, open, rows.length - ROWS),
  ];
};

type Tab = "junk" | "duplicates" | "unplayed";

/** A 2px track: how much of the whole one thing is. */
export const shareBar = (h: H, share: number, tone = "bg-accent/70") =>
  h.span([h.Class("block h-0.5 w-full overflow-hidden rounded-full bg-line"), h.AriaHidden(true)], [
    h.i([h.Class(`block h-full rounded-full ${tone}`), h.Style({ width: `${Math.min(100, Math.max(1.5, share * 100))}%` })], []),
  ]);

const blocks = (h: H, share: number, width: number, tone = "text-accent/80") => {
  const full = Math.max(share > 0 ? 1 : 0, Math.round(Math.min(1, share) * width));

  return h.span([h.Class("whitespace-pre"), h.AriaHidden(true)], [
    h.span([h.Class(tone)], ["▇".repeat(full)]),
    h.span([h.Class("text-fg-4/40")], ["░".repeat(width - full)]),
  ]);
};

const auditLines = (h: H, ctx: Ctx, ix: Index | null, key: string, a: Audit) => {
  const lines: Array<[tab: Tab, label: string, n: number, count: string, bytes: number]> = [
    ["junk", "junk", a.junk.count, `${fmt(a.junk.count)} ${a.junk.count === 1 ? "file" : "files"}`, a.junk.bytes],
    ["duplicates", "duplicates", a.duplicates.groups, `${fmt(a.duplicates.groups)} ${a.duplicates.groups === 1 ? "group" : "groups"}`, a.duplicates.wastedBytes],
    ["unplayed", "never played", a.neverPlayed.count, `${fmt(a.neverPlayed.count)} ${a.neverPlayed.count === 1 ? "file" : "files"}`, a.neverPlayed.bytes],
  ];

  const tabKey = (t: Tab) => `audit.${key}.${t}`;

  const rows = (t: Tab): Array<[Node, string | null]> => {
    if (!ix) return [];

    if (t === "duplicates")
      return a.duplicates.examples.flatMap((d): Array<[Node, string]> => {
        const keep = resolve(ix, d.keep);

        const drops = d.drop.flatMap((p): Array<[Node, string]> => {
          const n = resolve(ix, p);

          return n ? [[n, `drop · ${parentPath(n)}`]] : [];
        });

        return keep ? [[keep, `keep · ${parentPath(keep)}`], ...drops] : drops;
      });

    return (t === "junk" ? a.junk.examples : a.neverPlayed.examples).flatMap((f): Array<[Node, string]> => {
      const n = resolve(ix, f.path);

      return n ? [[n, f.why]] : [];
    });
  };

  const shown = lines.filter(([, , n]) => n > 0);

  return shown.length === 0
    ? []
    : [
        term(
          h,
          shown.flatMap(([t, label, , count, bytes]) => {
            const open = ctx.expanded.includes(tabKey(t));

            return [
              h.button(
                [
                  h.Type("button"),
                  h.AriaExpanded(open),
                  h.Class("grid grid-cols-[1.5ch_13ch_9ch_8ch_minmax(0,1fr)] items-baseline gap-x-2 px-3 text-start hover:bg-hover max-[520px]:grid-cols-[1.5ch_minmax(0,1fr)_auto_auto]"),
                  h.OnClick(Message.ToggledStep({ key: tabKey(t) })),
                ],
                [
                  h.span([h.Class("text-fg-4"), h.AriaHidden(true)], [open ? "▾" : "▸"]),
                  h.span([h.Class("truncate text-fg")], [label]),
                  h.span([h.Class("text-end text-fg-3 tabular-nums")], [count]),
                  h.span([h.Class("text-end text-fg-3 tabular-nums")], [size(bytes)]),
                  h.span([h.Class("overflow-hidden ps-2 max-[520px]:hidden")], [blocks(h, bytes / Math.max(1, a.totals.bytes), 20)]),
                ],
              ),
              ...(open ? [h.div([h.Class("grid ps-[3ch] pb-1")], lsList(h, ctx, `${tabKey(t)}.all`, rows(t)))] : []),
            ];
          }),
          true,
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
  asleep: "nothing here to score.",
  unplugged: "",
};

const CLEAN_SCORE = 90;

const scoreCard = (h: H, ctx: Ctx, a: Audit, uid: string, live: boolean) => {
  const mood = moodOf(a);

  const subs: Array<[string, number]> = [
    ["naming", a.scores.naming],
    ["structure", a.scores.structure],
    ["junk", a.scores.junk],
    ["duplicates", a.scores.duplicates],
  ];

  const worst = Math.min(...subs.map((s) => s[1]));
  const worstName = mood !== "asleep" && worst < 100 && a.score < CLEAN_SCORE ? subs.find((s) => s[1] === worst)?.[0] : undefined;
  const verdict = [MOOD_LINE[mood], ...(worstName ? [`${worstName} needs the most work.`] : []), ...(a.truncated ? ["partial scan."] : [])].join(" ");

  return h.section(
    [
      h.Class(`${live ? "enter" : ""} grid gap-4 overflow-hidden rounded-xl border border-line bg-raised px-5 pt-4 pb-4 max-[480px]:px-4`),
      h.AriaLabel("library score"),
      h.DataAttribute("testid", "score-card"),
    ],
    [
      h.div(
        [h.Class("grid grid-cols-[minmax(0,1fr)_auto] items-start gap-6")],
        [
          h.div(
            [h.Class("grid min-w-0 gap-2")],
            [
              mood === "asleep"
                ? h.span([h.Class("font-display text-[40px] leading-[0.8] font-medium text-fg-3")], ["empty"])
                : h.span(
                    [h.Class("flex items-baseline gap-2"), h.Role("img"), h.AriaLabel(`library score ${a.score} out of 100`)],
                    [
                      h.span([h.Class("font-display text-[40px] leading-[0.8] font-medium text-accent tabular-nums")], [`${a.score}`]),
                      h.span([h.Class("font-display text-[16px] leading-none text-fg-3")], ["/100"]),
                    ],
                  ),
              h.p([h.Class("m-0 max-w-[48ch] text-[14px] text-fg-2")], [verdict]),
            ],
          ),
          art(h, mood, 40),
        ],
      ),
      ...auditLines(h, ctx, indexOfCtx(ctx), uid, a),
    ],
  );
};

export const panel = (h: H, label: string, live: boolean, children: Html[]) =>
  h.section([h.Class(`${live ? "enter" : ""} grid gap-3 overflow-hidden rounded-xl border border-line bg-raised px-5 pt-3 pb-4 max-[480px]:px-4`), h.AriaLabel(label)], children);

/** A terminal window's title line: small, mono, quiet; the output below carries the weight. */
export const cardHead = (h: H, title: string, meta: string) =>
  h.div([h.Class("flex min-w-0 items-baseline justify-between gap-4 font-mono text-mono")], [
    h.span([h.Class("truncate text-fg-2")], [title]),
    h.span([h.Class("flex-none text-fg-4 tabular-nums")], [meta]),
  ]);

const duRow = (h: H, n: Node, max: number) =>
  h.li([h.Class("grid grid-cols-[7ch_16ch_minmax(0,1fr)] items-baseline gap-x-3 px-3 hover:bg-hover max-[480px]:grid-cols-[7ch_8ch_minmax(0,1fr)]")], [
    h.span([h.Class("text-end text-fg-3 tabular-nums")], [bytes(n)]),
    h.span([h.Class("overflow-hidden")], [blocks(h, max > 0 ? n.size / max : 0, 16, isFolder(n) ? "text-fg-3" : "text-accent/80")]),
    nameLink(h, n, isFolder(n) ? "text-fg" : "text-fg-2"),
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
    term(h, [
      h.ul([h.Class("m-0 grid list-none p-0")], (all ? nodes : nodes.slice(0, ROWS)).map((n) => duRow(h, n, nodes[0]?.size ?? 0))),
      ...showMore(h, moreKey, all, nodes.length - ROWS),
    ], true),
  ]);
};

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
    term(h, lsList(h, ctx, `files.${key}`, nodes.map((n): [Node, string | null] => [n, isFolder(n) ? null : parentPath(n)])), true),
  ]);
};

const linkName = (url: string) => {
  const last = url.split("?")[0]?.split("/").pop() ?? url;

  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
};

const linksCard = (h: H, ctx: Ctx, out: DownloadLinksOutput, live: boolean): Html => {
  const entry = ctx.links?.[out.id];
  const meta = out.files === null ? "put.io is on it" : `${fmt(out.files)} ${out.files === 1 ? "file" : "files"}`;
  const ask = (label: string) => h.button([h.Type("button"), h.Class("btn btn-sm justify-self-start"), h.OnClick(Message.ClickedLinks({ id: out.id }))], [label]);

  const body =
    entry === undefined
      ? [ask("show links")]
      : Match.value(entry).pipe(
          Match.discriminatorsExhaustive("state")({
            done: ({ links }) => [
              term(h, [
                h.ul(
                  [h.Class("m-0 grid list-none p-0")],
                  links.map((url) =>
                    h.li([h.Class("flex min-w-0 items-baseline gap-2 px-3 hover:bg-hover")], [
                      h.span([h.Class("flex-none text-fg-4"), h.AriaHidden(true)], ["↓"]),
                      h.a([h.Href(url), h.Rel("noopener noreferrer"), h.Class("min-w-0 truncate text-fg no-underline transition-colors duration-160 hover:text-accent")], [linkName(url)]),
                    ]),
                  ),
                ),
              ], true),
              h.button([h.Type("button"), h.Class("btn btn-sm justify-self-start"), h.OnClick(Message.ClickedCopyLinks({ id: out.id }))], ["copy all links"]),
            ],
            loading: () => [h.p([h.Class("m-0 font-mono text-mono text-fg-3"), h.Role("status")], ["asking put.io…"])],
            failed: ({ message }) => [h.p([h.Class("m-0 font-mono text-mono text-warn"), h.Role("alert")], [message]), ask("try again")],
          }),
        );

  return panel(h, "download links", live, [cardHead(h, "download links", meta), ...body]);
};

const decodeListFolder = Schema.decodeUnknownOption(Schema.fromJsonString(ListFolderOutput));
const decodeSearchFiles = Schema.decodeUnknownOption(Schema.fromJsonString(SearchFilesOutput));
const decodePlan = Schema.decodeUnknownOption(Schema.fromJsonString(Plan));
const decodeQuestion = Schema.decodeUnknownOption(Schema.fromJsonString(Question));
const decodeLinks = Schema.decodeUnknownOption(Schema.fromJsonString(DownloadLinksOutput));
const decodeLayout = Schema.decodeUnknownOption(Schema.fromJsonString(LayoutOutput));
const decodeFreeSpace = Schema.decodeUnknownOption(Schema.fromJsonString(FreeSpaceOutput));

type Card = (h: H, ctx: Ctx, key: string, output: string, live: boolean, settled: boolean) => Html | null;

const planOrRun = (h: H, ctx: Ctx, plan: Plan, live: boolean): Html => {
  const record = ctx.plans[plan.id];

  if (record?.status === "discarded") return discardedLine(h, plan);

  if (record?.undo) return runCard(h, ctx, record.undo, live, { undo: true });

  if (record?.run) return runCard(h, ctx, record.run, live, { undoable: record.status === "done" });

  return planCard(h, ctx, plan, live);
};

const proposedPlanCard: Card = (h, ctx, _key, output, live) =>
  Option.match(decodePlan(output), { onNone: () => null, onSome: (p) => planOrRun(h, ctx, p, live) });

const generatedPlanCard: Card = (h, ctx, _key, output, live) =>
  Option.match(Option.flatMapNullishOr(decodeLayout(output), (o) => ctx.plans[o.plan]), { onNone: () => null, onSome: (r) => planOrRun(h, ctx, r.plan, live) });

const CARDS = {
  scan_library: (h, ctx, key, output, live) => Option.match(auditOf(output), { onNone: () => null, onSome: (a) => scoreCard(h, ctx, a, key, live) }),
  list_folder: (h, ctx, key, output, live) => Option.match(decodeListFolder(output), { onNone: () => null, onSome: (o) => folderCard(h, ctx, key, o, live) }),
  search_files: (h, ctx, key, output, live) => Option.match(decodeSearchFiles(output), { onNone: () => null, onSome: (o) => searchCard(h, ctx, key, o, live) }),
  propose_changes: proposedPlanCard,
  propose_translation: proposedPlanCard,
  plan_layout: generatedPlanCard,
  plan_subtitles: generatedPlanCard,
  plan_free_space: (h, ctx, _key, output, live) =>
    Option.match(Option.flatMapNullishOr(decodeFreeSpace(output), (o) => (o.plan === null ? null : ctx.plans[o.plan])), {
      onNone: () => null,
      onSome: (r) => planOrRun(h, ctx, r.plan, live),
    }),
  make_download_links: (h, ctx, _key, output, live) => Option.match(decodeLinks(output), { onNone: () => null, onSome: (o) => linksCard(h, ctx, o, live) }),
  ask_user: (h, ctx, _key, output, live, settled) => Option.match(decodeQuestion(output), { onNone: () => null, onSome: (q) => questionCard(h, ctx, q, live, settled) }),
} satisfies Record<string, Card>;

const hasCard = (name: string): name is keyof typeof CARDS => Object.hasOwn(CARDS, name);

/** The card for a finished tool call, or null when the tool has none or its output doesn't decode. */
export const toolCard = (h: H, ctx: Ctx, tool: { name: string; key: string; output: string | null }, live: boolean, settled = false): Html | null => {
  return hasCard(tool.name) && tool.output !== null ? CARDS[tool.name](h, ctx, tool.key, tool.output, live, settled) : null;
};
