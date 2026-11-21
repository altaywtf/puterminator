import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import type { Html, HtmlBuilder } from "foldkit/html";
import type { RuleRecord } from "../shared/actions";
import type { MessageParam } from "../shared/contract";
import { RuleOutput } from "../shared/tools";
import { runCard } from "./actions";
import { cardHead, panel, term } from "./cards";
import { Message, type Model } from "./main";
import { fmt, size } from "./steps";

type H = HtmlBuilder<Message>;

type Ctx = Pick<Model, "expanded" | "plans" | "rules"> & { agent?: Model["agent"] };

const decodeRuleOutput = Schema.decodeUnknownOption(Schema.fromJsonString(RuleOutput));

const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).toLowerCase();

const meta = (rule: RuleRecord) => {
  switch (rule.status) {
    case "previewed":
      return "waiting for you";
    case "running":
      return "running";
    case "paused":
      return "paused";
    case "active":
      return rule.nextAt ? `next ${when(rule.nextAt)}` : "active";
  }
};

const ruleButton = (h: H, rule: RuleRecord, label: string, action: "approve" | "pause" | "resume" | "delete", primary = false, wait: string | null = null) =>
  h.button(
    [h.Type("button"), h.Disabled(wait !== null), ...(wait ? [h.Title(wait)] : []), h.Class(`btn btn-sm${primary ? " btn-primary" : action === "delete" ? " border-transparent text-fg-2" : ""}`), h.OnClick(Message.ClickedRule({ rule: rule.id, action, preview: rule.preview.at }))],
    [label],
  );

const actionsOf = (h: H, ctx: Ctx, rule: RuleRecord) => {
  const last = rule.runs[0] === undefined ? undefined : ctx.plans[rule.runs[0]];
  const wait = last?.status === "applying" || last?.status === "undoing" ? "wait for its last run to finish" : null;

  switch (rule.status) {
    case "previewed":
      return [ruleButton(h, rule, "delete", "delete"), ruleButton(h, rule, "approve", "approve", true, wait)];
    case "active":
    case "running":
      return [ruleButton(h, rule, "delete", "delete"), ruleButton(h, rule, "pause", "pause")];
    case "paused":
      return [ruleButton(h, rule, "delete", "delete"), ruleButton(h, rule, "preview again", "resume", true)];
  }
};

const receipt = (h: H, ctx: Ctx, planId: string): Html[] => {
  const record = ctx.plans[planId];

  if (!record?.run) return [];

  return [record.undo ? runCard(h, ctx, record.undo, false, { undo: true }) : runCard(h, ctx, record.run, false, { undoable: record.status === "done" })];
};

/** A standing rule as a terminal block: what it trashes and how often, today's preview while it waits for approval,
    why it paused, and its latest runs' receipts, newest first, where undo lives. */
export const ruleCard = (h: H, ctx: Ctx, rule: RuleRecord, live = false): Html => {
  const { preview } = rule;

  const card = panel(h, "rule", live, [
    cardHead(h, rule.title, meta(rule)),
    term(h, [
      h.span([h.Class("px-3 text-fg")], [`$ every ${rule.every}: trash videos in ${rule.within.join(", ")} first opened ${fmt(rule.openedDaysAgo)}+ days ago`]),
      h.span([h.Class("px-3 text-fg-3")], [`  ${rule.protect.length > 0 ? `never ${rule.protect.join(", ")} · ` : ""}at most ${fmt(rule.cap)} a run · in ${rule.folder}`]),
      ...(rule.status === "previewed"
        ? [
            h.span([h.Class("px-3 pt-2 text-accent/60")], [preview.count === 0 ? "# nothing to trash today" : `# today: ${fmt(preview.count)} ${preview.count === 1 ? "file" : "files"}, ${size(preview.bytes)}`]),
            ...preview.sample.map((name) => h.span([h.Class("truncate bg-danger/8 px-3 text-fg")], [h.span([h.Class("text-danger"), h.AriaHidden(true)], ["- "]), name])),
            ...(preview.count > preview.sample.length ? [h.span([h.Class("px-3 text-fg-4")], [`  and ${fmt(preview.count - preview.sample.length)} more`])] : []),
          ]
        : []),
      ...(rule.why ? [h.span([h.Class("px-3 pt-2 text-warn")], [`# paused: ${rule.why}`])] : []),
    ]),
    ...(rule.status === "previewed"
      ? [h.p([h.Class("m-0 text-meta text-fg-3")], ["put.io records only the first play, so a film you rewatched still counts as old. each run goes to put.io’s trash and shows a receipt you can undo."])]
      : []),
    h.div([h.Class("flex items-center justify-end gap-2")], actionsOf(h, ctx, rule)),
  ]);

  const receipts = rule.runs.flatMap((id) => receipt(h, ctx, id));

  return receipts.length === 0 ? card : h.div([h.Class("grid gap-3")], [card, ...receipts]);
};

const proposedIn = (history: ReadonlyArray<MessageParam>) =>
  new Set(
    history.flatMap((m) =>
      Predicate.isString(m.content) ? [] : m.content.flatMap((b) => (b.type === "tool_result" && Predicate.isString(b.content) ? Option.toArray(Option.map(decodeRuleOutput(b.content), (o) => o.rule)) : [])),
    ),
  );

/** Rules proposed in an earlier thread, so a run days later still shows where the person is. */
export const rulesElsewhere = (h: H, model: Model): Html[] => {
  const here = proposedIn(model.history);

  return Object.values(model.rules)
    .filter((r) => !here.has(r.id))
    .map((r) => ruleCard(h, model, r));
};

export const proposedRuleCard = (h: H, ctx: Ctx, output: string, live: boolean): Html | null =>
  Option.match(Option.flatMapNullishOr(decodeRuleOutput(output), (o) => ctx.rules[o.rule]), { onNone: () => null, onSome: (r) => ruleCard(h, ctx, r, live) });
