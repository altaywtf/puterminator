import type { Html, HtmlBuilder } from "foldkit/html";
import type { Change, Plan, Question, Run } from "../shared/actions";
import { cardHead, panel, shareBar } from "./cards";
import { Message } from "./main";
import { fmt, size } from "./steps";

// Action cards, drawn as diffs: a plan to approve, a question to answer, a run in flight and its receipt.
// Toggles reuse ToggledStep keys, so ticks and answers live in `expanded` like every other toggle.
// Nothing here writes to put.io; until write tools land, only /lab renders these.

type H = HtmlBuilder<Message>;
type Ctx = { expanded: readonly string[] };

const on = (ctx: Ctx, key: string) => ctx.expanded.includes(key);
const toggle = (key: string) => Message.ToggledStep({ key });

const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const parentOf = (path: string) => path.slice(0, path.lastIndexOf("/")) || "/";

// ---------- question ----------

const answerKey = (q: Question, id: string) => `question.${q.id}.${id}`;
const sentKey = (q: Question) => `question.${q.id}.sent`;

/** A terminal prompt, not a card: `?` and the question, then the choices under a `❯` pointer. One answer
    sends on click; several toggle `◉`/`◯` and send with enter. Answered, it folds to `✓ question › answer`. */
export const questionCard = (h: H, ctx: Ctx, q: Question, live = false): Html => {
  const chosen = q.options.filter((o) => on(ctx, answerKey(q, o.id)));
  const answered = q.multi ? on(ctx, sentKey(q)) && chosen.length > 0 : chosen.length > 0;
  const mono = "font-mono text-[13px] leading-[1.7]";
  if (answered)
    return h.p([h.Class(`m-0 flex min-w-0 gap-2 ${mono}`)], [
      h.span([h.Class("flex-none text-ok"), h.AriaHidden(true)], ["✓"]),
      h.span([h.Class("flex-none text-fg-3")], [q.prompt]),
      h.span([h.Class("flex-none text-fg-4"), h.AriaHidden(true)], ["›"]),
      h.span([h.Class("truncate text-accent")], [chosen.map((o) => o.label).join(", ")]),
    ]);
  return h.div([h.Class(`${live ? "enter" : ""} grid gap-1 ${mono}`)], [
    h.p([h.Class("m-0 flex gap-2")], [h.span([h.Class("text-accent"), h.AriaHidden(true)], ["?"]), h.span([h.Class("text-fg-strong")], [q.prompt])]),
    h.div(
      [h.Class("grid"), h.Role(q.multi ? "group" : "radiogroup"), h.AriaLabel(q.prompt)],
      q.options.map((o) => {
        const picked = on(ctx, answerKey(q, o.id));
        return h.button(
          [
            h.Type("button"),
            h.Role(q.multi ? "checkbox" : "radio"),
            h.AriaChecked(picked),
            h.Class("group -mx-2 grid grid-cols-[1rem_minmax(0,auto)_minmax(0,1fr)] items-baseline gap-x-2 rounded-md px-2 text-start transition-colors duration-160 hover:bg-hover focus-visible:bg-hover"),
            h.OnClick(toggle(answerKey(q, o.id))),
          ],
          [
            h.span([h.Class("text-accent opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"), h.AriaHidden(true)], ["❯"]),
            h.span([h.Class(`truncate ${picked ? "text-accent" : "text-fg group-hover:text-fg-strong"}`)], [`${q.multi ? (picked ? "◉ " : "◯ ") : ""}${o.label}`]),
            h.span([h.Class("truncate text-fg-4")], [o.detail ? `  ${o.detail}` : ""]),
          ],
        );
      }),
    ),
    h.div([h.Class("flex items-center gap-4 ps-6 pt-1 text-fg-4")], [
      ...(q.multi
        ? [
            h.button(
              [h.Type("button"), h.Disabled(chosen.length === 0), h.Class("hit transition-colors duration-160 enabled:text-accent enabled:hover:text-accent-bright"), h.OnClick(toggle(sentKey(q)))],
              [chosen.length === 0 ? "pick one or more" : `↵ send ${fmt(chosen.length)}`],
            ),
          ]
        : []),
      h.button([h.Type("button"), h.Class("hit transition-colors duration-160 hover:text-fg")], ["or type something else"]),
    ]),
  ]);
};

// ---------- plan ----------

const offKey = (plan: Plan, c: Change) => `plan.${plan.id}.off.${c.id}`;

type Hunk = { key: string; title: string; changes: Change[] };

/** Trash and renames group by folder, like a diff's hunks; moves get one hunk of their own. */
const hunks = (plan: Plan): Hunk[] => {
  const byDir = new Map<string, Change[]>();
  for (const c of plan.changes.filter((c) => c.op !== "move")) byDir.set(parentOf(c.path), [...(byDir.get(parentOf(c.path)) ?? []), c]);
  const moves = plan.changes.filter((c) => c.op === "move");
  return [
    ...[...byDir].map(([dir, changes]): Hunk => ({ key: dir, title: dir, changes })),
    ...(moves.length > 0 ? [{ key: "moves", title: "move", changes: moves }] : []),
  ];
};

const hunkOffKey = (plan: Plan, hunk: Hunk) => `plan.${plan.id}.hunkoff.${hunk.key}`;
const lineOn = (ctx: Ctx, plan: Plan, hunk: Hunk, c: Change) => !on(ctx, hunkOffKey(plan, hunk)) && !on(ctx, offKey(plan, c));

const SIGN = { del: ["-", "bg-danger/8", "text-danger"], add: ["+", "bg-ok/8", "text-ok"] } as const;

/** One diff line. Off lines keep their place, dimmed and struck, so unticking never reflows the hunk. */
const line = (h: H, kind: "del" | "add", text: string, meta: string, active: boolean) => {
  const [sign, bg, fg] = SIGN[kind];
  return h.span(
    [h.Class(`grid grid-cols-[1.25rem_minmax(0,1fr)_auto] gap-x-2 px-3 ${active ? bg : "opacity-40"}`)],
    [
      h.span([h.Class(`select-none ${active ? fg : "text-fg-4"}`), h.AriaHidden(true)], [sign]),
      h.span([h.Class(`truncate ${active ? "text-fg" : "text-fg-3 line-through decoration-fg-4"}`)], [text]),
      h.span([h.Class("text-fg-4 tabular-nums")], [meta]),
    ],
  );
};

const diffChange = (h: H, ctx: Ctx, plan: Plan, hunk: Hunk, c: Change) => {
  const active = lineOn(ctx, plan, hunk, c);
  const name = nameOf(c.path);
  const lines =
    c.op === "trash"
      ? [line(h, "del", name, size(c.bytes), active)]
      : c.op === "rename"
        ? [line(h, "del", name, "", active), line(h, "add", c.to ?? "", "", active)]
        : [line(h, "del", `${c.path}/`, "", active), line(h, "add", `${c.to ?? ""}/`, "", active)];
  return h.button(
    [
      h.Type("button"),
      h.Role("checkbox"),
      h.AriaChecked(active),
      h.AriaLabel(`${c.op} ${name}`),
      h.Title(active ? "click to leave this out" : "click to put it back"),
      h.Class("grid w-full text-start transition-[filter] duration-160 hover:brightness-125"),
      h.OnClick(toggle(offKey(plan, c))),
    ],
    lines,
  );
};

/** The plan as a unified diff: a hunk per folder, - for what goes, + for what it becomes. Click a line
    or a hunk header to leave it out; the stat line and the apply button count what's left. */
export const planCard = (h: H, ctx: Ctx, plan: Plan, live = false): Html => {
  const hs = hunks(plan);
  const picked = hs.flatMap((hk) => hk.changes.filter((c) => lineOn(ctx, plan, hk, c)));
  const stat = statLine(picked);
  return panel(h, "plan", live, [
    cardHead(h, plan.title, `${fmt(hs.length)} ${hs.length === 1 ? "hunk" : "hunks"}`),
    h.div(
      [h.Class("-mx-5 grid overflow-x-auto border-y border-line bg-sunk py-2 font-mono text-[12.5px] leading-[1.7] max-[480px]:-mx-4")],
      hs.map((hk) => {
        const off = on(ctx, hunkOffKey(plan, hk));
        return h.div([h.Class("grid")], [
          h.button(
            [
              h.Type("button"),
              h.Role("checkbox"),
              h.AriaChecked(!off),
              h.Class(`truncate px-3 pt-2 text-start transition-colors duration-160 ${off ? "text-fg-4 line-through" : "text-accent/60 hover:text-accent"}`),
              h.OnClick(toggle(hunkOffKey(plan, hk))),
            ],
            [`@@ ${hk.title} @@`],
          ),
          ...hk.changes.map((c) => diffChange(h, ctx, plan, hk, c)),
        ]);
      }),
    ),
    h.div([h.Class("flex flex-wrap items-center justify-between gap-x-4 gap-y-3")], [
      h.span([h.Class("font-mono text-[12.5px] text-fg-3")], [picked.length === 0 ? "nothing to apply" : stat]),
      h.span([h.Class("flex items-center gap-2")], [
        h.button([h.Type("button"), h.Class("btn btn-sm border-transparent text-fg-2")], ["discard"]),
        h.button([h.Type("button"), h.Disabled(picked.length === 0), h.Class("btn btn-sm btn-primary")], ["apply"]),
      ]),
    ]),
  ]);
};

// ---------- run and receipt ----------

type State = Run["steps"][number]["state"];

const MARK: Record<State, [glyph: string, cls: string]> = {
  queued: ["", ""],
  running: ["›", "text-accent"],
  done: ["✓", "text-ok"],
  failed: ["✗", "text-danger"],
};

/** A diff line with a status gutter: queued lines wait dimmed, the running one is lit, failures say why. */
const runLine = (h: H, state: State, kind: "del" | "add", text: string, meta: string) => {
  const [sign, bg, fg] = SIGN[kind];
  const [glyph, glyphCls] = MARK[state];
  return h.span(
    [
      h.Class(
        `grid grid-cols-[1rem_1.25rem_minmax(0,1fr)_auto] gap-x-2 px-3 ${state === "queued" ? "opacity-40" : state === "running" ? "bg-accent/10" : state === "failed" ? "bg-danger/12" : bg}`,
      ),
    ],
    [
      h.span([h.Class(`select-none ${glyphCls}`), h.AriaHidden(true)], [glyph]),
      h.span([h.Class(`select-none ${state === "queued" ? "text-fg-4" : fg}`), h.AriaHidden(true)], [sign]),
      h.span([h.Class("truncate text-fg")], [text]),
      h.span([h.Class("text-fg-4 tabular-nums")], [meta]),
    ],
  );
};

const runChange = (h: H, c: Change, state: State, error: string | null) => {
  const name = nameOf(c.path);
  const lines =
    c.op === "trash"
      ? [runLine(h, state, "del", name, size(c.bytes))]
      : c.op === "rename"
        ? [runLine(h, state, "del", name, ""), runLine(h, state, "add", c.to ?? "", "")]
        : [runLine(h, state, "del", `${c.path}/`, ""), runLine(h, state, "add", `${c.to ?? ""}/`, "")];
  return h.div(
    [h.Class("grid"), h.AriaLabel(`${c.op} ${name}: ${state}`)],
    [...lines, ...(error ? [h.span([h.Class("truncate ps-[3.75rem] pe-3 text-danger/80")], [`# ${error}`])] : [])],
  );
};

const diffBlock = (h: H, children: Html[]) =>
  h.div([h.Class("-mx-5 grid overflow-x-auto border-y border-line bg-sunk py-2 font-mono text-[12.5px] leading-[1.7] max-[480px]:-mx-4")], children);

const statLine = (changes: readonly Change[]) => {
  const n = (op: Change["op"]) => changes.filter((c) => c.op === op).length;
  const freed = changes.filter((c) => c.op === "trash").reduce((a, c) => a + c.bytes, 0);
  return [
    `${fmt(changes.length)} ${changes.length === 1 ? "change" : "changes"}`,
    ...(n("trash") > 0 ? [`${fmt(n("trash"))} deleted`] : []),
    ...(n("rename") > 0 ? [`${fmt(n("rename"))} renamed`] : []),
    ...(n("move") > 0 ? [`${fmt(n("move"))} moved`] : []),
    ...(freed > 0 ? [`${size(freed)} freed`] : []),
  ].join(", ");
};

/** Running: the plan's diff with a status per line. Finished: a commit line, failures, and the diff on tap. */
export const runCard = (h: H, ctx: Ctx, run: Run, live = false): Html => {
  const step = new Map(run.steps.map((s) => [s.change, s]));
  const stateOf = (c: Change): State => step.get(c.id)?.state ?? "queued";
  const settled = run.steps.filter((s) => s.state === "done" || s.state === "failed").length;
  const finished = settled === run.steps.length;
  const failed = run.changes.filter((c) => stateOf(c) === "failed");
  const done = run.changes.filter((c) => stateOf(c) === "done");
  const hunkLines = (filter: (c: Change) => boolean) =>
    hunks(run).flatMap((hk) => {
      const cs = hk.changes.filter(filter);
      return cs.length === 0
        ? []
        : [
            h.span([h.Class("truncate px-3 pt-2 text-accent/60")], [`@@ ${hk.title} @@`]),
            ...cs.map((c) => runChange(h, c, stateOf(c), step.get(c.id)?.error ?? null)),
          ];
    });

  if (!finished)
    return panel(h, "applying changes", live, [
      cardHead(h, run.title, `${fmt(settled)}/${fmt(run.steps.length)}`),
      shareBar(h, settled / Math.max(1, run.steps.length)),
      diffBlock(h, hunkLines(() => true)),
      h.div([h.Class("flex items-center justify-between gap-4")], [
        h.span([h.Class("font-mono text-[12.5px] text-fg-3")], [`applying… ${fmt(done.length)} done${failed.length > 0 ? `, ${fmt(failed.length)} failed` : ""}`]),
        h.button([h.Type("button"), h.Class("btn btn-sm")], ["stop"]),
      ]),
    ]);

  const openKey = `run.${run.id}.diff`;
  const open = on(ctx, openKey);
  return panel(h, "receipt", live, [
    h.p([h.Class("m-0 font-mono text-[12.5px] leading-[1.7] text-fg-2")], [
      h.span([h.Class("text-accent")], [`[${run.title}] `]),
      statLine(done),
    ]),
    ...(failed.length > 0 ? [diffBlock(h, hunkLines((c) => stateOf(c) === "failed"))] : []),
    ...(open ? [diffBlock(h, hunkLines((c) => stateOf(c) === "done"))] : []),
    h.div([h.Class("flex items-center justify-between gap-4")], [
      h.button(
        [h.Type("button"), h.AriaExpanded(open), h.Class("hit font-mono text-[12.5px] text-fg-3 transition-colors duration-160 hover:text-fg"), h.OnClick(toggle(openKey))],
        [open ? "hide diff" : "show diff"],
      ),
      h.span([h.Class("flex items-center gap-2")], [
        ...(failed.length > 0 ? [h.button([h.Type("button"), h.Class("btn btn-sm border-transparent text-fg-2")], [`retry ${fmt(failed.length)}`])] : []),
        h.button([h.Type("button"), h.Class("btn btn-sm")], ["undo"]),
      ]),
    ]),
  ]);
};
