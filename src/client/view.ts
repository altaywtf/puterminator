import { CDN } from "@uinaf/design/cdn";
import * as Option from "effect/Option";
import { createKeyedLazy, type Document, type Html, type HtmlBuilder } from "foldkit/html";
import type { Audit } from "../shared/audit";
import { creditsLeft, type Folder, type LastAudit, ROOT_FOLDER } from "../shared/contract";
import { type Item, type Turn, toTurns } from "../shared/thread";
import { COMPOSER_ID, isBusy, Message, type Model, Session, THREAD_ID, targetFolder } from "./main";
import { renderMarkdown } from "./markdown";
import { auditOf, callLine, describeStep, fmt, size } from "./steps";
import { thoughtSeconds } from "./thinking";

type H = HtmlBuilder<Message>;
type ToolItem = Extract<Item, { kind: "tool" }>;
type ThinkingItem = Extract<Item, { kind: "thinking" }>;

export const STARTERS = ["audit my library", "what did i never play?", "find junk files", "which duplicates do i have?"];

// The narrow shell: 40rem of content plus the gutter.
const COLUMN = "mx-auto grid w-full max-w-[calc(40rem+40px)] px-5 max-[480px]:px-4";

// ---------- shell ----------

const mark = (h: H, px: number) =>
  h.img([
    h.Src(CDN.images.computer240),
    h.Alt(""),
    h.Width(`${px}`),
    h.Height(`${px}`),
    h.Decoding("async"),
    h.Draggable(false),
    h.Class("mark"),
    h.Style({ width: `${px}px`, height: `${px}px` }),
  ]);

const dot = (h: H, tone: "live" | "ok" | "warn" | "error" | null = null) =>
  h.span([h.Class(`u-dot ${tone ? `u-dot--${tone}` : ""}`), h.AriaHidden(true)], []);

/** One 56px topbar row over the content; no inset panel, no shadow. */
const shell = (h: H, actions: Html[], children: Html[]) =>
  h.div(
    [h.Class("grid h-dvh grid-rows-[auto_minmax(0,1fr)] bg-bg text-fg")],
    [
      h.header(
        [h.Class("u-topbar")],
        [
          h.div(
            [h.Class(`${COLUMN} u-topbar-row flex! gap-3`)],
            [
              h.span([h.Class("u-topbar-mark")], [mark(h, 20), h.span([], ["puterminator"])]),
              h.span([h.Class("grow")], []),
              ...actions,
            ],
          ),
        ],
      ),
      h.main([h.Class("relative flex min-h-0 min-w-0 flex-col")], children),
    ],
  );

// ---------- sign in ----------

const signInView = (h: H, configured: boolean) =>
  h.div(
    [h.Class("grid min-h-dvh place-items-center bg-bg p-6 text-fg")],
    [
      h.div(
        [h.Class("enter w-full max-w-[360px]")],
        [
          h.div(
            [h.Class("u-panel u-ticks grid gap-6 p-8!")],
            [
              mark(h, 64),
              h.div(
                [h.Class("grid gap-2")],
                [
                  h.h1([h.Class("m-0 text-base font-normal text-fg-strong")], ["puterminator"]),
                  h.p(
                    [h.Class("m-0 text-[13px] text-fg-2")],
                    ["reads your put.io, scores the mess and says what to fix. changes nothing."],
                  ),
                ],
              ),
              configured
                ? h.a([h.Href("/auth/login"), h.Class("u-btn u-btn--primary justify-self-start")], ["continue with put.io ↗"])
                : h.div(
                    [h.Class("grid justify-items-start gap-3")],
                    [
                      h.span([h.Class("u-btn opacity-40"), h.AriaDisabled(true)], ["continue with put.io"]),
                      h.span([h.Class("flex items-center gap-2 text-[13px] text-fg-2")], [dot(h, "warn"), "sign-in isn't wired up yet."]),
                    ],
                  ),
            ],
          ),
        ],
      ),
    ],
  );

// ---------- steps ----------

/** The 10px slot at the start of every step row. */
const slot = (h: H, child: Html) => h.span([h.Class("grid w-2.5 flex-none place-items-center")], [child]);
const chev = (h: H) => h.span([h.Class("chev leading-none"), h.AriaHidden(true)], ["›"]);

const stepBody = (h: H, id: string, children: Html[]) =>
  h.div([h.Id(id), h.Class("ms-1 grid min-w-0 gap-0.5 border-s border-line py-1 ps-4 text-fg-3")], children);

const mono = (h: H, text: string, extra = "") =>
  h.div([h.Class(`min-w-0 truncate text-[13px] text-fg-2 ${extra}`), h.Title(text)], [text]);

const toggle = (h: H, key: string, open: boolean, bodyId: string, children: Html[]) =>
  h.button(
    [h.Type("button"), h.Class("step-head"), h.AriaExpanded(open), h.AriaControls(bodyId), h.OnClick(Message.ToggledStep({ key }))],
    [slot(h, chev(h)), ...children],
  );

const detailSpan = (h: H, detail: string | null) =>
  detail === null ? [] : [h.span([h.Class("min-w-0 truncate text-fg-4 tabular-nums")], [`· ${detail}`])];

const liveRow = (h: H, label: string, detail: string | null = null) =>
  h.div([h.Class("step-head")], [slot(h, dot(h, "live")), h.span([h.Class("text-fg-2")], [label]), ...detailSpan(h, detail)]);

const thinkingView = (h: H, item: ThinkingItem, model: Model) => {
  const bodyId = `step-${item.key}`;
  const open = model.expanded.includes(item.key);
  if (item.streaming) return h.keyed("div")(item.key, [h.Class("grid gap-1")], [liveRow(h, "thinking")]);
  const seconds = thoughtSeconds(model.clock, item.key);
  return h.keyed("div")(item.key, [h.Class("grid gap-1")], [
    toggle(h, item.key, open, bodyId, [h.span([h.Class("name")], [seconds === null ? "thought for a few seconds" : `thought for ${seconds}s`])]),
    ...(open ? [stepBody(h, bodyId, [h.div([h.Class("max-w-[64ch] text-[13px] whitespace-pre-wrap")], [item.text])])] : []),
  ]);
};

const toolView = (h: H, item: ToolItem, model: Model) => {
  const bodyId = `step-${item.key}`;
  const open = model.expanded.includes(item.key);
  const d = describeStep(item.name, item.input, item.output);
  const body = stepBody(h, bodyId, [mono(h, callLine(item.name, item.input)), ...d.lines.map((l) => mono(h, l, "text-fg-3"))]);
  const head =
    item.state === "running"
      ? liveRow(h, d.title, d.detail)
      : toggle(h, item.key, open, bodyId, [
          ...(item.state === "error" ? [dot(h, "error")] : []),
          h.span([h.Class(`name min-w-0 truncate ${item.state === "error" ? "text-danger" : ""}`)], [d.title]),
          ...detailSpan(h, item.state === "error" && item.output === null ? "didn't finish" : d.detail),
        ]);
  const score =
    item.name === "scan_library" && item.state === "done"
      ? Option.match(auditOf(item.output), { onNone: () => [], onSome: (a) => [scoreCard(h, a)] })
      : [];
  return h.keyed("div")(item.key, [h.Class("grid min-w-0 gap-3")], [
    h.div([h.Class("grid min-w-0 gap-1")], [head, ...(open || item.state === "running" ? [body] : [])]),
    ...score,
  ]);
};

// ---------- score card ----------

/** One dry line under the number; the number stays the value. */
export const mood = (a: Audit) =>
  a.score >= 90 && a.junk.count === 0 && a.duplicates.groups === 0
    ? "no junk. no doubles. rare."
    : a.score >= 90
      ? "nothing to terminate."
      : a.score >= 75
        ? "mostly tidy. a little dust."
        : a.score >= 50
          ? "lived in."
          : a.score >= 25
            ? "needs a mop."
            : "slime all the way down.";

const bar = (h: H, label: string, value: number, note: string) => {
  const v = Math.min(100, Math.max(0, value));
  return h.div(
    [h.Class("grid grid-cols-[88px_1fr_24px] items-center gap-3 text-[13px]"), h.Title(note)],
    [
      h.span([h.Class("text-fg-2")], [label]),
      h.span([h.Class("h-0.5 bg-line")], [h.i([h.Class("grow-bar block h-full bg-accent"), h.Style({ width: `${v}%` })], [])]),
      h.span([h.Class("text-end text-fg tabular-nums")], [`${v}`]),
    ],
  );
};

const scoreCard = (h: H, a: Audit) => {
  const facts = [
    `${fmt(a.totals.items)} items`,
    size(a.totals.bytes),
    `${fmt(a.junk.count)} junk`,
    `${fmt(a.duplicates.groups)} duplicates`,
    `${fmt(a.neverPlayed.count)} never played`,
  ];
  return h.div(
    [h.Class("enter u-panel u-ticks my-1 grid gap-5"), h.DataAttribute("testid", "score-card")],
    [
      h.div(
        [h.Class("grid grid-cols-[minmax(0,auto)_1fr] items-end gap-x-10 gap-y-5 max-[520px]:grid-cols-1")],
        [
          h.div(
            [h.Class("grid gap-2")],
            [
              h.span([h.Class("u-label")], ["library score"]),
              h.div(
                [h.Class("flex items-baseline gap-1"), h.Role("img"), h.AriaLabel(`library score ${a.score} out of 100`)],
                [
                  h.span([h.Class("text-[40px] leading-none text-fg-strong tabular-nums")], [`${a.score}`]),
                  h.span([h.Class("text-[13px] text-fg-3")], ["/100"]),
                ],
              ),
              h.span([h.Class("text-[13px] text-fg-2")], [mood(a)]),
            ],
          ),
          h.div(
            [h.Class("grid gap-2.5")],
            [
              bar(h, "naming", a.scores.naming, `${fmt(a.naming.messy)} videos keep release names`),
              bar(h, "structure", a.scores.structure, `${fmt(a.structure.wrapperFolders)} wrapper folders`),
              bar(h, "junk", a.scores.junk, `${fmt(a.junk.count)} junk files`),
              bar(h, "duplicates", a.scores.duplicates, `${fmt(a.duplicates.groups)} duplicate groups`),
            ],
          ),
        ],
      ),
      h.div(
        [h.Class("flex flex-wrap items-center gap-x-2 border-t border-line pt-3 text-[11px] text-fg-3 tabular-nums")],
        [
          ...facts.flatMap((f, i) => (i === 0 ? [h.span([], [f])] : [h.span([h.Class("text-fg-4")], ["·"]), h.span([], [f])])),
          ...(a.truncated
            ? [h.span([h.Class("ms-auto flex items-center gap-2 text-fg-2"), h.Title("too big to read in one go")], [dot(h, "warn"), "partial scan"])]
            : []),
        ],
      ),
    ],
  );
};

// ---------- thread ----------

const lazyMarkdown = createKeyedLazy();

const assistantView = (h: H, turn: Turn, model: Model, caretKey: string | null) =>
  h.keyed("div")(
    turn.key,
    [h.Class("grid min-w-0 grid-cols-[20px_minmax(0,1fr)] gap-x-3"), h.DataAttribute("role", "assistant")],
    [
      h.span([h.Class("pt-0.5")], [mark(h, 20)]),
      h.div(
        [h.Class("grid min-w-0 gap-3")],
        turn.items.length === 0 ? [liveRow(h, "working")] : turn.items.map((item) => {
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
      ),
    ],
  );

const userView = (h: H, turn: Turn) =>
  h.keyed("div")(
    turn.key,
    [h.Class("mt-4 grid grid-cols-[20px_minmax(0,1fr)] gap-x-3 first:mt-0"), h.DataAttribute("role", "user")],
    [
      h.span([h.Class("text-end text-fg-4"), h.AriaHidden(true)], [">"]),
      h.div([h.Class("break-words whitespace-pre-wrap text-fg-strong")], [turn.items[0]?.kind === "user" ? turn.items[0].text : ""]),
    ],
  );

const chips = (h: H, items: readonly string[], enabled: boolean, indent: boolean) =>
  h.div(
    [h.Class(`flex flex-wrap gap-2 ${indent ? "ps-8" : ""}`)],
    items.map((s) =>
      h.button(
        [h.Type("button"), h.Disabled(!enabled), h.Class("u-btn u-btn--sm disabled:opacity-40"), h.OnClick(Message.ClickedStarter({ text: s }))],
        [s],
      ),
    ),
  );

const memoryLine = (h: H, last: LastAudit) =>
  h.p(
    [h.Class("m-0 flex flex-wrap gap-x-2 text-[11px] text-fg-3 tabular-nums")],
    [
      h.span([h.Class("u-label")], ["last time"]),
      h.span([], [new Date(last.at).toLocaleDateString("en-US", { month: "short", day: "numeric" }).toLowerCase()]),
      h.span([h.Class("text-fg-4")], ["·"]),
      h.span([], [`${fmt(last.items)} items in ${last.rootName}`]),
      h.span([h.Class("text-fg-4")], ["·"]),
      h.span([], [`score ${last.score}`]),
    ],
  );

const statusRows = (h: H, model: Model) => [
  ...(model.connection._tag === "Lost"
    ? [h.div([h.Class("u-notice items-center!")], [dot(h, "warn"), h.span([], ["connection lost. reconnecting…"])])]
    : []),
  ...(model.error === null
    ? []
    : [h.div([h.Class("u-notice items-center!"), h.Role("alert")], [dot(h, "error"), h.span([], [model.error])])]),
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
          h.Class("pick max-w-[220px] min-w-0"),
          h.AriaHasPopup("menu"),
          h.AriaExpanded(model.menuOpen),
          h.AriaLabel(`target folder: ${target.name}`),
          h.Title("target folder"),
          h.OnClick(Message.ToggledFolderMenu()),
        ],
        [h.span([h.Class("text-fg-4")], ["/"]), h.span([h.Class("truncate")], [target.name])],
      ),
      ...(model.menuOpen
        ? [
            h.button(
              [
                h.Type("button"),
                h.Tabindex(-1),
                h.AriaLabel("close folder menu"),
                h.Class("fixed inset-0 z-10 cursor-default"),
                h.OnClick(Message.ClosedFolderMenu()),
              ],
              [],
            ),
            h.div(
              [
                h.Role("menu"),
                h.AriaLabel("target folder"),
                h.Class(
                  `enter absolute start-0 z-20 grid max-h-72 w-max max-w-[min(300px,calc(100vw-48px))] min-w-52 overflow-y-auto border border-line bg-raised py-1 ${below ? "top-full mt-1" : "bottom-full mb-1"}`,
                ),
              ],
              options.map((f) =>
                h.button(
                  [
                    h.Type("button"),
                    h.Role("menuitemradio"),
                    h.AriaChecked(f.id === target.id),
                    h.Class(
                      "flex h-8 min-w-0 items-center gap-2.5 px-3 text-start text-[13px] text-fg-2 transition-colors duration-160 hover:bg-bg hover:text-fg aria-checked:text-fg",
                    ),
                    h.OnClick(Message.PickedFolder({ folder: f })),
                  ],
                  [
                    h.span([h.Class(`size-1.5 flex-none rounded-full ${f.id === target.id ? "bg-accent" : ""}`), h.AriaHidden(true)], []),
                    h.span([h.Class("grow truncate")], [f.name]),
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
        "pointer-events-auto grid w-full gap-2 rounded-xs border border-line bg-sunk pt-2.5 pe-2 pb-2 ps-3 transition-colors duration-160 hover:border-line-strong focus-within:border-line-hover!",
      ),
      h.OnSubmit(Message.SubmittedDraft()),
    ],
    [
      h.label([h.For(COMPOSER_ID), h.Class("sr-only")], ["message puterminator"]),
      h.textarea([
        h.Id(COMPOSER_ID),
        h.Value(model.draft),
        h.Rows(1),
        h.Placeholder(placeholder),
        h.Autocomplete("off"),
        h.EnterKeyHint("send"),
        h.Class(
          "block max-h-[140px] min-h-[22px] w-full resize-none border-0 bg-transparent py-0.5 text-[16px] leading-normal text-fg-strong caret-accent outline-none [field-sizing:content] placeholder:text-fg-4 focus-visible:outline-none min-[761px]:text-[14px]",
        ),
        h.OnInput((value) => Message.UpdatedDraft({ value })),
        h.OnKeyDownPreventDefault((key, mods) =>
          key === "Enter" && !mods.shiftKey && !mods.altKey ? Option.some(Message.SubmittedDraft()) : Option.none(),
        ),
      ]),
      h.div(
        [h.Class("-ms-1.5 flex min-w-0 items-center gap-1")],
        [
          folderMenu(h, model, !floating),
          h.span([h.Class("pick cursor-default max-[400px]:hidden"), h.Title("model")], ["sonnet 5.5"]),
          h.span([h.Class("grow")], []),
          h.span(
            [h.Class("pick cursor-default tabular-nums"), h.Title("credits left this month")],
            [`${fmt(model.agent ? creditsLeft(model.agent.credits) : 0)} credits`],
          ),
          busy
            ? h.button([h.Type("button"), h.Class("u-btn u-btn--sm"), h.OnClick(Message.ClickedStop())], ["stop"])
            : h.button(
                [h.Type("submit"), h.Disabled(!canSend), h.Class("u-btn u-btn--sm u-btn--primary disabled:opacity-40 disabled:active:scale-100")],
                ["send"],
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
  const actions = [
    h.span([h.Class("truncate text-[13px] text-fg-3 max-[480px]:hidden")], [model.agent?.username ?? ""]),
    h.button(
      [h.Type("button"), h.Class("text-[13px] text-fg-2 transition-colors duration-160 hover:text-fg"), h.OnClick(Message.ClickedSignOut())],
      ["sign out"],
    ),
  ];

  if (turns.length === 0)
    return shell(h, actions, [
      h.div(
        [h.Id(THREAD_ID), h.Class("flex-1 overflow-y-auto overscroll-contain")],
        [
          h.div(
            [h.Class(`${COLUMN} enter gap-6 pt-[12vh] pb-10`)],
            [
              mark(h, 64),
              h.div(
                [h.Class("grid gap-2")],
                [
                  h.h1([h.Class("m-0 text-2xl font-normal tracking-[-0.01em] text-balance text-fg-strong")], ["what should i do with your put.io?"]),
                  h.p([h.Class("m-0 text-fg-2")], ["i read your files, score the library and answer questions. i change nothing."]),
                ],
              ),
              ...(model.agent?.lastAudit ? [memoryLine(h, model.agent.lastAudit)] : []),
              h.div(
                [h.Class("grid gap-3")],
                [composer(h, model, "ask puterminator…", false), chips(h, STARTERS, model.connection._tag === "Connected" && !busy, false)],
              ),
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
  const asked = new Set(turns.flatMap((t) => t.items.flatMap((i) => (i.kind === "user" ? [i.text.toLowerCase()] : []))));
  const followUps = STARTERS.filter((s) => !asked.has(s));

  return shell(h, actions, [
    h.div(
      [h.Id(THREAD_ID), h.Class("flex-1 overflow-y-auto overscroll-contain [scroll-padding-bottom:180px]")],
      [
        h.div(
          [h.Class(`${COLUMN} gap-5 pt-8 pb-[200px]`)],
          [
            ...turns.map((t) => (t.role === "user" ? userView(h, t) : assistantView(h, t, model, caretKey))),
            ...(working ? [h.div([h.Class("ps-8")], [liveRow(h, "working")])] : []),
            ...statusRows(h, model),
            ...(!busy && model.error === null && last?.role === "assistant" && followUps.length > 0
              ? [chips(h, followUps, model.connection._tag === "Connected", true)]
              : []),
          ],
        ),
      ],
    ),
    h.div(
      [h.Class("pointer-events-none absolute inset-x-0 bottom-0 bg-linear-to-b from-transparent to-bg to-40% pt-8 pb-4 max-[760px]:pb-3")],
      [h.div([h.Class(COLUMN)], [composer(h, model, "reply…", true)])],
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
