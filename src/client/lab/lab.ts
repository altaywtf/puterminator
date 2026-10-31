import { Schema } from "effect";
import { Runtime } from "foldkit";
import type { Document, Html, HtmlBuilder } from "foldkit/html";
import { PlanRecord } from "../../shared/actions";
import { Library } from "../../shared/contract";
import { planCard, questionCard, runCard } from "../actions";
import { toolCard } from "../cards";
import { Message } from "../main";
import { audits, folders, library, plans, questions, runs, searches } from "./fixtures";

// Dev-only gallery: every tool card, in every fixture state, through the same toolCard the thread uses.
// Served by `pnpm lab` (vite) at /lab.html; `vite build` only builds index.html, so this never ships.

const Model = Schema.Struct({ expanded: Schema.Array(Schema.String), library: Library, plans: Schema.Record(Schema.String, PlanRecord) });
type Model = typeof Model.Type;
type H = HtmlBuilder<Message>;

const update = (model: Model, message: Message) =>
  message._tag === "ToggledStep"
    ? { model: { ...model, expanded: model.expanded.includes(message.key) ? model.expanded.filter((k) => k !== message.key) : [...model.expanded, message.key] } }
    : { model };

const CASES: Array<{ tool: string; group: string; name: string; output: string }> = [
  ...audits.map(([name, a]) => ({ tool: "scan_library", group: "score", name, output: JSON.stringify(a) })),
  ...folders.map(([name, o]) => ({ tool: "list_folder", group: "folder", name, output: JSON.stringify(o) })),
  ...searches.map(([name, o]) => ({ tool: "search_files", group: "search", name, output: JSON.stringify(o) })),
];

const specimen = (h: H, model: Model, c: (typeof CASES)[number], i: number): Html =>
  h.div(
    [h.Class("grid gap-2")],
    [
      h.span([h.Class("text-[13px] text-fg-3")], [`${c.tool} · ${c.name}`]),
      toolCard(h, model, { name: c.tool, key: `lab${i}`, output: c.output }, false) ??
        h.p([h.Class("m-0 rounded-2xl border border-dashed border-line p-5 text-[13px] text-fg-4")], ["no card: the thread shows only the step line"]),
    ],
  );

const labelled = (h: H, label: string, card: Html) => h.div([h.Class("grid gap-2")], [h.span([h.Class("text-[13px] text-fg-3")], [label]), card]);

const section = (h: H, title: string, children: Html[]) =>
  h.section([h.Class("grid gap-8")], [h.h2([h.Class("m-0 border-b border-line pb-2 text-[13px] font-normal text-fg-3")], [title]), ...children]);

const actionSections = (h: H, model: Model) => [
  section(h, "plan", plans.map(([name, p]) => labelled(h, `propose_changes · ${name}`, planCard(h, model, p)))),
  section(h, "question", questions.map(([name, q]) => labelled(h, `ask_user · ${name}`, questionCard(h, model, q)))),
  section(h, "run", runs.map(([name, r]) => labelled(h, `apply · ${name}`, runCard(h, model, r)))),
];

const view = (model: Model, h: H): Document => ({
  title: "puterminator lab",
  body: h.main(
    [h.Class("h-dvh overflow-y-auto bg-bg text-fg")],
    [
      h.div(
        [h.Class("mx-auto grid w-full max-w-[calc(46rem+40px)] gap-12 px-5 py-12")],
        [
          h.h1([h.Class("m-0 font-display text-[28px] font-medium text-accent")], ["lab"]),
          ...actionSections(h, model),
          ...["score", "folder", "search"].map((group) =>
            h.section(
              [h.Class("grid gap-8")],
              [
                h.h2([h.Class("m-0 border-b border-line pb-2 text-[13px] font-normal text-fg-3")], [group]),
                ...CASES.flatMap((c, i) => (c.group === group ? [specimen(h, model, c, i)] : [])),
              ],
            ),
          ),
        ],
      ),
    ],
  ),
});

Runtime.run(
  Runtime.makeApplication({
    Model,
    // Fixture toggles (unticked rows, open groups, answers) start the lab in each state.
    init: () => ({ model: { expanded: [...plans, ...questions, ...runs].flatMap(([, , keys]) => keys), library, plans: {} } }),
    update,
    view,
    container: document.getElementById("root"),
  }),
);
