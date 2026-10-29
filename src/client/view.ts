import * as Option from "effect/Option";
import { createKeyedLazy, type Document, type Html, type HtmlBuilder } from "foldkit/html";
import type { Audit } from "../shared/audit";
import { creditsLeft, type Folder, type LastAudit, ROOT_FOLDER } from "../shared/contract";
import { type Item, type Turn, toTurns } from "../shared/thread";
import { icon } from "./icons";
import { COMPOSER_ID, isBusy, Message, type Model, Session, THREAD_ID, targetFolder } from "./main";
import { renderMarkdown } from "./markdown";
import { auditOf, callLine, describeStep, fmt, size } from "./steps";
import { thoughtSeconds } from "./thinking";

type H = HtmlBuilder<Message>;
type ToolItem = Extract<Item, { kind: "tool" }>;
type ThinkingItem = Extract<Item, { kind: "thinking" }>;

export const STARTERS = ["Audit my library", "What did I never play?", "Find junk files", "Which duplicates do I have?"];

const COLUMN = "mx-auto grid w-full max-w-[680px] px-5";

// ---------- shell ----------

const logo = (h: H) =>
  h.span(
    [h.AriaHidden(true), h.Class("grid size-5 flex-none place-items-center rounded-md bg-fg text-[11px] font-semibold text-bg")],
    ["P"],
  );

/** Gray chrome with one inset panel; edge to edge under 761px. */
const shell = (h: H, crumb: string | null, actions: Html[], children: Html[]) =>
  h.div(
    [h.Class("grid h-dvh bg-bg text-fg")],
    [
      h.main(
        [
          h.Class(
            "relative m-2 flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl bg-panel shadow-card max-[760px]:m-0 max-[760px]:rounded-none",
          ),
        ],
        [
          h.header(
            [h.Class("flex h-11 flex-none items-center gap-2 border-b border-line ps-4 pe-3")],
            [
              logo(h),
              h.span([h.Class("font-medium")], ["puterminator"]),
              ...(crumb === null
                ? []
                : [h.span([h.Class("text-fg-4")], ["/"]), h.span([h.Class("min-w-0 truncate text-fg-3")], [crumb])]),
              h.span([h.Class("grow")], []),
              ...actions,
            ],
          ),
          ...children,
        ],
      ),
    ],
  );

// ---------- sign in ----------

const signInView = (h: H, configured: boolean) =>
  shell(h, null, [], [
    h.div(
      [h.Class(`${COLUMN} gap-4 pt-[18vh] text-center`)],
      [
        h.h1([h.Class("m-0 text-xl font-medium tracking-[-0.02em] text-balance")], ["What should I do with your put.io?"]),
        h.p(
          [h.Class("-mt-2 mb-0 text-fg-3")],
          ["I read your files, score the library and answer questions about it. This version changes nothing."],
        ),
        configured
          ? h.a(
              [
                h.Href("/auth/login"),
                h.Class(
                  "mx-auto mt-2 inline-flex h-[30px] items-center rounded-lg bg-primary px-3 font-medium text-primary-fg transition-[background-color,transform] duration-120 ease-out hover:bg-primary/85 active:scale-[0.96]",
                ),
              ],
              ["Sign in with put.io"],
            )
          : h.div(
              [h.Class("mx-auto mt-2 grid gap-1")],
              [
                h.span(
                  [h.Class("mx-auto inline-flex h-[30px] items-center rounded-lg bg-hover px-3 font-medium text-fg-4"), h.AriaDisabled(true)],
                  ["Sign in with put.io"],
                ),
                h.span([h.Class("text-[12.5px] text-fg-3")], ["Sign-in isn't configured yet. Check back soon."]),
              ],
            ),
      ],
    ),
  ]);

// ---------- steps ----------

const spinner = (h: H) => h.span([h.Class("spin"), h.AriaHidden(true)], []);

const stepBody = (h: H, id: string, children: Html[]) =>
  h.div(
    [h.Id(id), h.Class("ms-1.5 grid min-w-0 gap-0.5 border-s border-line-strong py-0.5 ps-3.5 text-fg-3")],
    children,
  );

const mono = (h: H, text: string, extra = "") =>
  h.div([h.Class(`min-w-0 truncate font-mono text-[12px] tracking-normal text-fg-2 ${extra}`), h.Title(text)], [text]);

const toggle = (h: H, key: string, open: boolean, bodyId: string, children: Html[]) =>
  h.button(
    [
      h.Type("button"),
      h.Class("step-head"),
      h.AriaExpanded(open),
      h.AriaControls(bodyId),
      h.OnClick(Message.ToggledStep({ key })),
    ],
    [...children, icon(h, "chev", "chev")],
  );

const detailSpan = (h: H, detail: string | null) =>
  detail === null ? [] : [h.span([h.Class("min-w-0 truncate tabular-nums")], [`· ${detail}`])];

const thinkingView = (h: H, item: ThinkingItem, model: Model) => {
  const bodyId = `step-${item.key}`;
  const open = model.expanded.includes(item.key);
  if (item.streaming)
    return h.keyed("div")(item.key, [h.Class("grid gap-1")], [
      h.div([h.Class("step-head")], [spinner(h), h.span([h.Class("shimmer")], ["Thinking"])]),
    ]);
  const seconds = thoughtSeconds(model.clock, item.key);
  return h.keyed("div")(item.key, [h.Class("grid gap-1")], [
    toggle(h, item.key, open, bodyId, [
      icon(h, "brain"),
      h.span([h.Class("name text-fg-2")], [seconds === null ? "Thought for a few seconds" : `Thought for ${seconds}s`]),
    ]),
    ...(open ? [stepBody(h, bodyId, [h.div([h.Class("max-w-[62ch] whitespace-pre-wrap")], [item.text])])] : []),
  ]);
};

const toolView = (h: H, item: ToolItem, model: Model) => {
  const bodyId = `step-${item.key}`;
  const open = model.expanded.includes(item.key);
  const d = describeStep(item.name, item.input, item.output);
  const body = stepBody(h, bodyId, [mono(h, callLine(item.name, item.input)), ...d.lines.map((l) => mono(h, l, "text-fg-3"))]);
  const head =
    item.state === "running"
      ? h.div([h.Class("step-head")], [spinner(h), h.span([h.Class("shimmer")], [d.title]), ...detailSpan(h, d.detail)])
      : toggle(h, item.key, open, bodyId, [
          item.state === "error" ? icon(h, "alert", "text-danger") : icon(h, "tool"),
          h.span([h.Class("name min-w-0 truncate text-fg-2")], [d.title]),
          ...detailSpan(h, item.state === "error" && item.output === null ? "didn't finish" : d.detail),
        ]);
  const score =
    item.name === "scan_library" && item.state === "done"
      ? Option.match(auditOf(item.output), { onNone: () => [], onSome: (a) => [scoreCard(h, a)] })
      : [];
  return h.keyed("div")(item.key, [h.Class("grid min-w-0 gap-2.5")], [
    h.div([h.Class("grid min-w-0 gap-1")], [head, ...(open || item.state === "running" ? [body] : [])]),
    ...score,
  ]);
};

// ---------- score card ----------

const ring = (h: H, value: number) => {
  const c = 2 * Math.PI * 28;
  const v = Math.min(100, Math.max(0, value));
  return h.div(
    [h.Class("relative size-16"), h.Role("img"), h.AriaLabel(`Library score ${v} out of 100`)],
    [
      h.svg(
        [h.ViewBox("0 0 64 64"), h.Class("size-16 -rotate-90"), h.AriaHidden(true)],
        [
          h.circle([h.Cx("32"), h.Cy("32"), h.R("28"), h.Fill("none"), h.StrokeWidth("5"), h.Class("stroke-hover")]),
          h.circle([
            h.Cx("32"),
            h.Cy("32"),
            h.R("28"),
            h.Fill("none"),
            h.StrokeWidth("5"),
            h.StrokeLinecap("round"),
            h.StrokeDasharray(`${c}`),
            h.StrokeDashoffset(`${c * (1 - v / 100)}`),
            h.Class("stroke-fg transition-[stroke-dashoffset] duration-700 ease-out-quint"),
          ]),
        ],
      ),
      h.b([h.Class("absolute inset-0 grid place-items-center text-lg font-semibold tracking-[-0.02em] tabular-nums")], [`${v}`]),
    ],
  );
};

const bar = (h: H, label: string, value: number, note: string) =>
  h.div(
    [h.Class("grid grid-cols-[90px_1fr_28px] items-center gap-2.5 text-fg-2"), h.Title(note)],
    [
      h.span([], [label]),
      h.span(
        [h.Class("h-1 overflow-hidden rounded-full bg-hover")],
        [h.i([h.Class("grow-bar block h-full rounded-full bg-fg-2"), h.Style({ width: `${Math.min(100, Math.max(0, value))}%` })], [])],
      ),
      h.span([h.Class("text-end tabular-nums")], [`${value}`]),
    ],
  );

const scoreCard = (h: H, a: Audit) =>
  h.div(
    [h.Class("enter overflow-hidden rounded-[10px] bg-raised shadow-card"), h.DataAttribute("testid", "score-card")],
    [
      h.div(
        [h.Class("grid grid-cols-[auto_1fr] items-center gap-5 p-4")],
        [
          ring(h, a.score),
          h.div(
            [h.Class("grid min-w-0 gap-2")],
            [
              bar(h, "Naming", a.scores.naming, `${fmt(a.naming.messy)} videos keep release names`),
              bar(h, "Structure", a.scores.structure, `${fmt(a.structure.wrapperFolders)} wrapper folders`),
              bar(h, "Junk", a.scores.junk, `${fmt(a.junk.count)} junk files`),
              bar(h, "Duplicates", a.scores.duplicates, `${fmt(a.duplicates.groups)} duplicate groups`),
            ],
          ),
        ],
      ),
      h.div(
        [h.Class("flex flex-wrap gap-x-4 gap-y-1 border-t border-line bg-subtle px-3 py-2 text-fg-3 tabular-nums")],
        [
          h.span([], [`${fmt(a.totals.items)} items`]),
          h.span([], [size(a.totals.bytes)]),
          h.span([], [`${fmt(a.junk.count)} junk`]),
          h.span([], [`${fmt(a.duplicates.groups)} duplicates`]),
          h.span([], [`${fmt(a.neverPlayed.count)} never played`]),
          ...(a.truncated ? [h.span([h.Class("text-warn")], ["partial scan"])] : []),
        ],
      ),
    ],
  );

// ---------- thread ----------

const lazyMarkdown = createKeyedLazy();

const assistantView = (h: H, turn: Turn, model: Model, caretKey: string | null) =>
  h.keyed("div")(
    turn.key,
    [h.Class("grid min-w-0 gap-2.5"), h.DataAttribute("role", "assistant")],
    turn.items.map((item) => {
      switch (item.kind) {
        case "text":
          return h.keyed("div")(item.key, [h.Class("min-w-0")], [
            lazyMarkdown(item.key, renderMarkdown, [item.text, item.key === caretKey]) ?? h.span([], []),
          ]);
        case "thinking":
          return thinkingView(h, item, model);
        case "tool":
          return toolView(h, item, model);
        case "user":
          return h.span([], []);
      }
    }),
  );

const userView = (h: H, turn: Turn) =>
  h.keyed("div")(
    turn.key,
    [
      h.Class("max-w-[80%] justify-self-end rounded-xl bg-hover px-3 py-2 break-words whitespace-pre-wrap"),
      h.DataAttribute("role", "user"),
    ],
    [turn.items[0]?.kind === "user" ? turn.items[0].text : ""],
  );

const chips = (h: H, items: readonly string[], enabled: boolean) =>
  h.div(
    [h.Class("flex flex-wrap gap-1.5")],
    items.map((s) =>
      h.button(
        [
          h.Type("button"),
          h.Disabled(!enabled),
          h.Class(
            "h-7 rounded-lg bg-raised px-2.5 text-[12.5px] text-fg-2 shadow-card transition-[background-color,transform] duration-120 ease-out hover:bg-subtle hover:text-fg active:scale-[0.96] disabled:opacity-60",
          ),
          h.OnClick(Message.ClickedStarter({ text: s })),
        ],
        [s],
      ),
    ),
  );

const memoryLine = (h: H, last: LastAudit) =>
  h.p(
    [h.Class("m-0 text-center text-[12.5px] text-balance text-fg-3")],
    [
      icon(h, "history", "me-2 inline-block align-[-2.5px]"),
      `Last time, ${new Date(last.at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}: read ${fmt(last.items)} items in ${last.rootName}, score ${last.score}.`,
    ],
  );

const statusRows = (h: H, model: Model) => [
  ...(model.connection._tag === "Lost"
    ? [h.div([h.Class("step-head")], [spinner(h), h.span([], ["Connection lost. Reconnecting…"])])]
    : []),
  ...(model.error === null
    ? []
    : [
        h.div(
          [h.Class("flex items-start gap-2 text-danger"), h.Role("alert")],
          [h.span([h.Class("grid h-[20px] place-items-center")], [icon(h, "alert")]), h.span([], [model.error])],
        ),
      ]),
];

// ---------- composer ----------

const folderMenu = (h: H, model: Model, below: boolean) => {
  const target = targetFolder(model);
  const options: Folder[] = [ROOT_FOLDER, ...model.folders.filter((f) => f.id !== ROOT_FOLDER.id)];
  return h.div(
    [
      h.Class("relative min-w-0"),
      h.OnKeyDownPreventDefault((key) => (key === "Escape" && model.menuOpen ? Option.some(Message.ClosedFolderMenu()) : Option.none())),
    ],
    [
      h.button(
        [
          h.Type("button"),
          h.Class("pick max-w-[200px] min-w-0"),
          h.AriaHasPopup("menu"),
          h.AriaExpanded(model.menuOpen),
          h.AriaLabel(`Target folder: ${target.name}`),
          h.Title("Target folder"),
          h.OnClick(Message.ToggledFolderMenu()),
        ],
        [icon(h, "folder"), h.span([h.Class("truncate")], [target.name]), icon(h, "chev", "size-3 rotate-90")],
      ),
      ...(model.menuOpen
        ? [
            h.button(
              [
                h.Type("button"),
                h.Tabindex(-1),
                h.AriaLabel("Close folder menu"),
                h.Class("fixed inset-0 z-10 cursor-default"),
                h.OnClick(Message.ClosedFolderMenu()),
              ],
              [],
            ),
            h.div(
              [
                h.Role("menu"),
                h.AriaLabel("Target folder"),
                h.Class(
                  `enter absolute start-0 z-20 grid max-h-72 w-max max-w-[min(280px,calc(100vw-48px))] min-w-48 overflow-y-auto rounded-lg bg-raised p-1 shadow-float ${below ? "top-full mt-1" : "bottom-full mb-1"}`,
                ),
              ],
              options.map((f) =>
                h.button(
                  [
                    h.Type("button"),
                    h.Role("menuitemradio"),
                    h.AriaChecked(f.id === target.id),
                    h.Class("flex h-7 min-w-0 items-center gap-2 rounded-md px-2 text-start text-fg-2 hover:bg-hover hover:text-fg"),
                    h.OnClick(Message.PickedFolder({ folder: f })),
                  ],
                  [
                    icon(h, "folder"),
                    h.span([h.Class("grow truncate")], [f.name]),
                    ...(f.id === target.id ? [icon(h, "check", "text-fg")] : []),
                  ],
                ),
              ),
            ),
          ]
        : []),
    ],
  );
};

const composer = (h: H, model: Model, placeholder: string, floating: boolean) => {
  const busy = isBusy(model);
  const connected = model.connection._tag === "Connected";
  const canSend = connected && model.draft.trim().length > 0;
  return h.form(
    [
      h.Class(
        "pointer-events-auto mx-auto grid w-full max-w-[680px] gap-1.5 rounded-xl bg-raised pt-2.5 pe-2.5 pb-2 ps-3.5 shadow-float",
      ),
      h.OnSubmit(Message.SubmittedDraft()),
    ],
    [
      h.label([h.For(COMPOSER_ID), h.Class("sr-only")], ["Message puterminator"]),
      h.textarea([
        h.Id(COMPOSER_ID),
        h.Value(model.draft),
        h.Rows(1),
        h.Placeholder(placeholder),
        h.Autocomplete("off"),
        h.EnterKeyHint("send"),
        h.Class(
          "block max-h-[140px] min-h-[22px] w-full resize-none border-0 bg-transparent py-0.5 text-[16px] leading-normal outline-none [field-sizing:content] placeholder:text-fg-3 focus-visible:outline-none min-[761px]:text-[13.5px]",
        ),
        h.OnInput((value) => Message.UpdatedDraft({ value })),
        h.OnKeyDownPreventDefault((key, mods) =>
          key === "Enter" && !mods.shiftKey && !mods.altKey ? Option.some(Message.SubmittedDraft()) : Option.none(),
        ),
      ]),
      h.div(
        [h.Class("flex min-w-0 items-center gap-1")],
        [
          h.span([h.Class("pick max-[340px]:hidden"), h.Title("Model")], ["Sonnet 5.5"]),
          folderMenu(h, model, !floating),
          h.span([h.Class("grow")], []),
          h.span(
            [h.Class("pick tabular-nums"), h.Title("Credits left this month")],
            [`${fmt(model.agent ? creditsLeft(model.agent.credits) : 0)} credits`],
          ),
          busy
            ? h.button(
                [
                  h.Type("button"),
                  h.AriaLabel("Stop"),
                  h.Class(
                    "relative grid size-7 flex-none place-items-center rounded-full bg-fg text-panel transition-transform duration-120 ease-out active:scale-[0.94]",
                  ),
                  h.OnClick(Message.ClickedStop()),
                ],
                [icon(h, "stop")],
              )
            : h.button(
                [
                  h.Type("submit"),
                  h.AriaLabel("Send"),
                  h.Disabled(!canSend),
                  h.Class(
                    "relative grid size-7 flex-none place-items-center rounded-full bg-fg text-panel transition-[transform,background-color] duration-120 ease-out active:scale-[0.94] disabled:bg-line-strong disabled:text-fg-3 disabled:active:scale-100",
                  ),
                ],
                [icon(h, "arrowUp", "[stroke-width:2]")],
              ),
        ],
      ),
    ],
  );
};

// ---------- page ----------

const threadPage = (h: H, model: Model) => {
  const busy = isBusy(model);
  const turns = toTurns(model.history, model.partial, busy);
  const target = targetFolder(model);
  const actions = [
    h.span([h.Class("truncate text-fg-3 max-[480px]:hidden")], [model.agent?.username ?? ""]),
    h.button([h.Type("button"), h.Class("pick"), h.OnClick(Message.ClickedSignOut())], ["Sign out"]),
  ];

  if (turns.length === 0)
    return shell(h, target.name, actions, [
      h.div(
        [h.Id(THREAD_ID), h.Class("flex-1 overflow-y-auto overscroll-contain")],
        [
          h.div(
            [h.Class(`${COLUMN} gap-[18px] pt-[14vh] pb-10`)],
            [
              h.h1([h.Class("m-0 text-center text-xl font-medium tracking-[-0.02em] text-balance")], ["What should I do with your put.io?"]),
              h.p(
                [h.Class("-mt-2.5 mb-0 text-center text-fg-3")],
                ["I read your files, score the library and answer questions. This version changes nothing."],
              ),
              ...(model.agent?.lastAudit ? [memoryLine(h, model.agent.lastAudit)] : []),
              composer(h, model, "Ask puterminator…", false),
              chips(h, STARTERS, model.connection._tag === "Connected" && !busy),
              ...statusRows(h, model),
            ],
          ),
        ],
      ),
    ]);

  const last = turns.at(-1);
  const lastItem = last?.items.at(-1);
  const liveText = model.partial?.at(-1)?.type === "text";
  const caretKey = liveText && lastItem?.kind === "text" && lastItem.key.startsWith("live.") ? lastItem.key : null;
  const running = last?.items.some((i) => (i.kind === "tool" && i.state === "running") || (i.kind === "thinking" && i.streaming));
  const working = busy && model.partial === null && !running;
  const asked = new Set(turns.flatMap((t) => t.items.flatMap((i) => (i.kind === "user" ? [i.text] : []))));
  const followUps = STARTERS.filter((s) => !asked.has(s));

  return shell(h, target.name, actions, [
    h.div(
      [h.Id(THREAD_ID), h.Class("flex-1 overflow-y-auto overscroll-contain [scroll-padding-bottom:180px]")],
      [
        h.div(
          [h.Class(`${COLUMN} gap-[18px] pt-7 pb-[200px]`)],
          [
            ...turns.map((t) => (t.role === "user" ? userView(h, t) : assistantView(h, t, model, caretKey))),
            ...(working ? [h.div([h.Class("step-head")], [spinner(h), h.span([h.Class("shimmer")], ["Working"])])] : []),
            ...statusRows(h, model),
            ...(!busy && model.error === null && last?.role === "assistant" && followUps.length > 0
              ? [chips(h, followUps, model.connection._tag === "Connected")]
              : []),
          ],
        ),
      ],
    ),
    h.div(
      [
        h.Class(
          "pointer-events-none absolute inset-x-0 bottom-0 bg-linear-to-b from-transparent to-panel to-40% px-5 pb-4 max-[760px]:px-4 max-[760px]:pb-3",
        ),
      ],
      [composer(h, model, "Reply…", true)],
    ),
  ]);
};

export const view = (model: Model, h: H): Document => ({
  title: "puterminator",
  body: Session.match(model.session, {
    Loading: () => h.div([h.Class("h-dvh bg-bg")], []),
    SignedOut: ({ configured }) => signInView(h, configured),
    SignedIn: () => threadPage(h, model),
  }),
});
