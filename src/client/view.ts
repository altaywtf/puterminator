import { CDN } from "@uinaf/design/cdn";
import * as Option from "effect/Option";
import { createKeyedLazy, type Document, type Html, type HtmlBuilder } from "foldkit/html";
import type { Audit } from "../shared/audit";
import { type Credits, creditsLeft, type Folder, type LastAudit, ROOT_FOLDER } from "../shared/contract";
import { type Item, type Turn, toTurns } from "../shared/thread";
import { art, type Mood, moodOf } from "./art";
import { COMPOSER_ID, isBusy, Message, type Model, Session, THREAD_ID, targetFolder } from "./main";
import { renderMarkdown } from "./markdown";
import { auditOf, callLine, describeStep, fmt, size } from "./steps";
import { thoughtSeconds } from "./thinking";

type H = HtmlBuilder<Message>;
type ToolItem = Extract<Item, { kind: "tool" }>;
type ThinkingItem = Extract<Item, { kind: "thinking" }>;

export const STARTERS = ["audit my library", "what did i never play?", "find junk files", "which duplicates do i have?"];

const STARTER_NOTES: Record<string, string> = {
  "audit my library": "score naming, structure, junk and duplicates.",
  "what did i never play?": "the biggest files nobody opened.",
  "find junk files": "tracker debris, samples, .nfo files.",
  "which duplicates do i have?": "copies, and which one to keep.",
};

// The narrow shell: 40rem of content plus the gutter.
const COLUMN = "mx-auto grid w-full max-w-[calc(40rem+40px)] px-5 max-[480px]:px-4";

// ---------- atoms ----------

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

const label = (h: H, text: string, extra = "") => h.span([h.Class(`u-label ${extra}`)], [text]);

/** Segment ticks for what's left of the month's credits. */
const creditTicks = (h: H, c: Credits) => {
  const cap = Math.max(1, Math.floor(c.cap / 1000));
  const on = Math.round((creditsLeft(c) / cap) * 10);
  return h.span(
    [h.Class("u-progress"), h.Title("credits left this month")],
    [
      ...Array.from({ length: 10 }, (_, i) => h.i([h.Class("max-[560px]:hidden"), ...(i < on ? [h.DataAttribute("on", "")] : [])], [])),
      h.span([h.Class("tabular-nums")], [`${fmt(creditsLeft(c))}`]),
    ],
  );
};

// ---------- shell ----------

const status = (h: H, model: Model) =>
  model.connection._tag === "Connected"
    ? h.span([h.Class("flex items-center gap-2 text-[11px] text-fg-3")], [dot(h, "live"), "online"])
    : model.connection._tag === "Lost"
      ? h.span([h.Class("flex items-center gap-2 text-[11px] text-fg-3")], [dot(h, "warn"), "reconnecting"])
      : h.span([h.Class("flex items-center gap-2 text-[11px] text-fg-3")], [dot(h), "connecting"]);

/** One 56px topbar row over the content; no inset panel, no shadow. */
const shell = (h: H, model: Model, children: Html[]) =>
  h.div(
    [h.Class("grid h-dvh grid-rows-[auto_minmax(0,1fr)] bg-bg text-fg")],
    [
      h.header(
        [h.Class("u-topbar")],
        [
          h.div(
            [h.Class(`${COLUMN} u-topbar-row flex! gap-4`)],
            [
              h.span([h.Class("u-topbar-mark")], [mark(h, 20), h.span([], ["puterminator"])]),
              h.span([h.Class("u-tag max-[420px]:hidden")], ["read-only"]),
              h.span([h.Class("grow")], []),
              status(h, model),
              h.span([h.Class("truncate text-[13px] text-fg-3 max-[560px]:hidden")], [model.agent?.username ?? ""]),
              h.button(
                [h.Type("button"), h.Class("text-[13px] text-fg-2 transition-colors duration-160 hover:text-fg"), h.OnClick(Message.ClickedSignOut())],
                ["sign out"],
              ),
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
              art(h, configured ? "asleep" : "unplugged", 72),
              h.div(
                [h.Class("grid gap-2")],
                [
                  h.h1([h.Class("m-0 text-base font-normal text-fg-strong")], ["puterminator"]),
                  h.p([h.Class("m-0 text-[13px] text-fg-2")], ["reads your put.io, scores the mess and says what to fix. changes nothing."]),
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

// ---------- steps: one run log per stretch of tool work ----------

/** The 10px slot at the start of every step row. */
const slot = (h: H, child: Html) => h.span([h.Class("grid w-2.5 flex-none place-items-center")], [child]);
const chev = (h: H) => h.span([h.Class("chev leading-none"), h.AriaHidden(true)], ["›"]);

const stepBody = (h: H, id: string, children: Html[]) =>
  h.div([h.Id(id), h.Class("ms-1 mb-1 grid min-w-0 gap-0.5 border-s border-line py-1 ps-4 text-fg-3")], children);

const mono = (h: H, text: string, extra = "") =>
  h.div([h.Class(`min-w-0 truncate text-[12px] text-fg-2 ${extra}`), h.Title(text)], [text]);

const toggle = (h: H, key: string, open: boolean, bodyId: string, children: Html[]) =>
  h.button(
    [h.Type("button"), h.Class("step-head"), h.AriaExpanded(open), h.AriaControls(bodyId), h.OnClick(Message.ToggledStep({ key }))],
    [slot(h, chev(h)), ...children],
  );

const detailSpan = (h: H, detail: string | null) =>
  detail === null ? [] : [h.span([h.Class("min-w-0 truncate text-fg-4 tabular-nums")], [`· ${detail}`])];

const liveRow = (h: H, text: string, detail: string | null = null) =>
  h.div([h.Class("step-head")], [slot(h, dot(h, "live")), h.span([h.Class("text-fg")], [text]), ...detailSpan(h, detail)]);

const thinkingRow = (h: H, item: ThinkingItem, model: Model) => {
  const bodyId = `step-${item.key}`;
  const open = model.expanded.includes(item.key);
  if (item.streaming) return h.keyed("div")(item.key, [], [liveRow(h, "thinking")]);
  const seconds = thoughtSeconds(model.clock, item.key);
  return h.keyed("div")(item.key, [h.Class("grid")], [
    toggle(h, item.key, open, bodyId, [h.span([h.Class("name")], [seconds === null ? "thought for a few seconds" : `thought for ${seconds}s`])]),
    ...(open ? [stepBody(h, bodyId, [h.div([h.Class("max-w-[64ch] text-[12px] whitespace-pre-wrap")], [item.text])])] : []),
  ]);
};

const toolRow = (h: H, item: ToolItem, model: Model) => {
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
  return h.keyed("div")(item.key, [h.Class("grid min-w-0")], [head, ...(open || item.state === "running" ? [body] : [])]);
};

const runLog = (h: H, key: string, rows: Html[]) =>
  h.keyed("div")(`log.${key}`, [h.Class("grid min-w-0 border border-line bg-sunk px-3 py-1.5")], rows);

// ---------- score card ----------

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

const ticks = (h: H, value: number, worst: boolean) => {
  const on = Math.round(Math.min(100, Math.max(0, value)) / 10);
  return h.span(
    [h.Class("flex gap-[3px]"), h.AriaHidden(true)],
    Array.from({ length: 10 }, (_, i) =>
      h.i([h.Class(`grow-bar block h-1 w-full ${i < on ? (worst ? "bg-accent" : "bg-fg-2") : "bg-line"}`), h.Style({ animationDelay: `${i * 30}ms` })], []),
    ),
  );
};

const subScore = (h: H, name: string, value: number, note: string, worst: boolean) =>
  h.div(
    [h.Class("grid min-w-0 content-start gap-2 p-4!")],
    [
      h.span([h.Class("flex items-center justify-between gap-2")], [label(h, name, worst ? "u-label--accent" : ""), ...(worst ? [h.span([h.Class("text-[10px] text-fg-3")], ["worst"])] : [])]),
      h.span([h.Class("text-xl leading-none text-fg-strong tabular-nums")], [`${value}`]),
      ticks(h, value, worst),
      h.span([h.Class("truncate text-[11px] text-fg-3"), h.Title(note)], [note]),
    ],
  );

const scoreCard = (h: H, a: Audit, uid: string) => {
  const mood = moodOf(a);
  const subs: Array<[string, number, string]> = [
    ["naming", a.scores.naming, `${fmt(a.naming.messy)} release names`],
    ["structure", a.scores.structure, `${fmt(a.structure.wrapperFolders)} wrapper folders`],
    ["junk", a.scores.junk, `${fmt(a.junk.count)} files · ${size(a.junk.bytes)}`],
    ["duplicates", a.scores.duplicates, `${fmt(a.duplicates.groups)} groups · ${size(a.duplicates.wastedBytes)}`],
  ];
  const worst = Math.min(...subs.map((s) => s[1]));
  const worstName = worst < 100 ? subs.find((s) => s[1] === worst)?.[0] : undefined;
  const facts = [`${fmt(a.totals.items)} items`, size(a.totals.bytes), `${fmt(a.neverPlayed.count)} never played`];
  return h.div(
    [h.Class("enter u-ticks my-2 grid border border-line bg-bg"), h.DataAttribute("testid", "score-card")],
    [
      h.div(
        [h.Class("flex items-center gap-5 border-b border-line p-5")],
        [
          h.span([h.Class("grid size-[88px] flex-none place-items-center border border-line bg-black")], [art(h, mood, 72, uid)]),
          h.div(
            [h.Class("grid min-w-0 gap-1.5")],
            [
              label(h, `library score · ${a.rootName}`, "truncate"),
              h.div(
                [h.Class("flex items-baseline gap-1"), h.Role("img"), h.AriaLabel(`library score ${a.score} out of 100`)],
                [
                  h.span([h.Class("text-[40px] leading-none text-fg-strong tabular-nums")], [`${a.score}`]),
                  h.span([h.Class("text-[13px] text-fg-3")], ["/100"]),
                ],
              ),
              h.span([h.Class("text-[13px] text-fg-2")], [MOOD_LINE[mood]]),
            ],
          ),
        ],
      ),
      h.div(
        [h.Class("u-panel-grid grid-cols-4 border-0! max-[600px]:grid-cols-2")],
        subs.map(([n, v, note]) => subScore(h, n, v, note, n === worstName)),
      ),
      h.div(
        [h.Class("flex flex-wrap items-center gap-x-2 border-t border-line px-5 py-2.5 text-[11px] text-fg-3 tabular-nums")],
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

/** Text stays prose; consecutive steps share one run log; a scan's score card closes its log. */
const agentBody = (h: H, turn: Turn, model: Model, caretKey: string | null): Html[] => {
  const out: Html[] = [];
  let rows: Html[] = [];
  let logKey = "";
  const flush = () => {
    if (rows.length > 0) out.push(runLog(h, logKey, rows));
    rows = [];
  };
  for (const item of turn.items) {
    switch (item.kind) {
      case "text":
        flush();
        out.push(
          h.keyed("div")(item.key, [h.Class("min-w-0")], [lazyMarkdown(item.key, renderMarkdown, [item.text, item.key === caretKey]) ?? h.span([], [])]),
        );
        break;
      case "thinking":
        if (rows.length === 0) logKey = item.key;
        rows.push(thinkingRow(h, item, model));
        break;
      case "tool": {
        if (rows.length === 0) logKey = item.key;
        rows.push(toolRow(h, item, model));
        const audit = item.name === "scan_library" && item.state === "done" ? auditOf(item.output) : Option.none();
        if (Option.isSome(audit)) {
          flush();
          out.push(h.keyed("div")(`card.${item.key}`, [], [scoreCard(h, audit.value, item.key)]));
        }
        break;
      }
      case "user":
        break;
    }
  }
  flush();
  return out.length > 0 ? out : [runLog(h, `${turn.key}.wait`, [liveRow(h, "working")])];
};

const agentView = (h: H, turn: Turn, model: Model, caretKey: string | null, live: boolean) =>
  h.keyed("div")(
    turn.key,
    [h.Class("grid min-w-0 gap-3"), h.DataAttribute("role", "assistant")],
    [
      h.div(
        [h.Class("flex items-center gap-2.5")],
        [mark(h, 20), label(h, "puterminator", "text-fg-2!"), ...(live ? [h.span([h.Class("text-[11px] text-fg-4")], ["· working"])] : [])],
      ),
      h.div([h.Class("grid min-w-0 gap-3 ps-[30px] max-[480px]:ps-0")], agentBody(h, turn, model, caretKey)),
    ],
  );

const userView = (h: H, turn: Turn) =>
  h.keyed("div")(
    turn.key,
    [h.Class("grid justify-items-end gap-1.5 border-t border-line pt-6 first:border-t-0 first:pt-0"), h.DataAttribute("role", "user")],
    [
      label(h, "you"),
      h.div(
        [h.Class("max-w-[85%] rounded-xs border border-line-strong bg-raised px-4 py-2.5 break-words whitespace-pre-wrap text-fg-strong")],
        [turn.items[0]?.kind === "user" ? turn.items[0].text : ""],
      ),
    ],
  );

const followUps = (h: H, items: readonly string[], enabled: boolean) =>
  h.div(
    [h.Class("flex flex-wrap gap-2 ps-[30px] max-[480px]:ps-0")],
    items.map((s) =>
      h.button(
        [h.Type("button"), h.Disabled(!enabled), h.Class("u-btn u-btn--sm text-fg-2! disabled:opacity-40"), h.OnClick(Message.ClickedStarter({ text: s }))],
        [`${s} →`],
      ),
    ),
  );

const starterRows = (h: H, enabled: boolean) =>
  h.div(
    [h.Class("grid")],
    [
      label(h, "start with", "mb-2"),
      ...STARTERS.map((s) =>
        h.button(
          [
            h.Type("button"),
            h.Disabled(!enabled),
            h.Class(
              "group grid grid-cols-[1fr_auto] items-baseline gap-x-4 border-t border-line py-3 text-start transition-colors duration-160 last:border-b disabled:opacity-40",
            ),
            h.OnClick(Message.ClickedStarter({ text: s })),
          ],
          [
            h.span([h.Class("text-fg-strong transition-colors duration-160 group-hover:text-accent")], [s]),
            h.span([h.Class("text-[12px] text-fg-4 transition-transform duration-160 group-hover:translate-x-0.5 group-hover:text-fg-2")], ["→"]),
            h.span([h.Class("col-span-2 text-[13px] text-fg-3")], [STARTER_NOTES[s] ?? ""]),
          ],
        ),
      ),
    ],
  );

const lastScanStrip = (h: H, last: LastAudit, credits: Credits) =>
  h.div(
    [h.Class("u-panel-grid grid-cols-3 max-[480px]:grid-cols-2")],
    [
      h.div(
        [h.Class("u-stat p-4!")],
        [label(h, "last score"), h.span([h.Class("u-stat-value tabular-nums")], [`${last.score}`]), h.span([h.Class("u-stat-note")], [new Date(last.at).toLocaleDateString("en-US", { month: "short", day: "numeric" }).toLowerCase()])],
      ),
      h.div(
        [h.Class("u-stat p-4!")],
        [label(h, "items"), h.span([h.Class("u-stat-value tabular-nums")], [fmt(last.items)]), h.span([h.Class("u-stat-note truncate")], [`in ${last.rootName}`])],
      ),
      h.div(
        [h.Class("u-stat p-4! max-[480px]:hidden")],
        [label(h, "credits"), h.span([h.Class("u-stat-value tabular-nums")], [fmt(creditsLeft(credits))]), h.span([h.Class("u-stat-note")], ["left this month"])],
      ),
    ],
  );

const statusRows = (h: H, model: Model) =>
  model.error === null ? [] : [h.div([h.Class("u-notice items-center!"), h.Role("alert")], [dot(h, "error"), h.span([], [model.error])])];

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
              [h.Type("button"), h.Tabindex(-1), h.AriaLabel("close folder menu"), h.Class("fixed inset-0 z-10 cursor-default"), h.OnClick(Message.ClosedFolderMenu())],
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
                    h.Class("flex h-8 min-w-0 items-center gap-2.5 px-3 text-start text-[13px] text-fg-2 transition-colors duration-160 hover:bg-bg hover:text-fg aria-checked:text-fg"),
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
        "pointer-events-auto grid w-full gap-2 rounded-xs border border-line-strong bg-sunk pt-3 pe-2 pb-2 ps-3 transition-colors duration-160 hover:border-line-hover focus-within:border-fg-2!",
      ),
      h.OnSubmit(Message.SubmittedDraft()),
    ],
    [
      h.div(
        [h.Class("flex items-start gap-2.5")],
        [
          h.span([h.Class("pt-0.5 text-fg-4 select-none"), h.AriaHidden(true)], [">"]),
          h.label([h.For(COMPOSER_ID), h.Class("sr-only")], ["message puterminator"]),
          h.textarea([
            h.Id(COMPOSER_ID),
            h.Value(model.draft),
            h.Rows(1),
            h.Placeholder(placeholder),
            h.Autocomplete("off"),
            h.EnterKeyHint("send"),
            h.Class(
              "block max-h-[160px] min-h-[24px] w-full resize-none border-0 bg-transparent py-0.5 text-[16px] leading-normal text-fg-strong caret-accent outline-none [field-sizing:content] placeholder:text-fg-4 focus-visible:outline-none min-[761px]:text-[14px]",
            ),
            h.OnInput((value) => Message.UpdatedDraft({ value })),
            h.OnKeyDownPreventDefault((key, mods) => (key === "Enter" && !mods.shiftKey && !mods.altKey ? Option.some(Message.SubmittedDraft()) : Option.none())),
          ]),
        ],
      ),
      h.div(
        [h.Class("-ms-1.5 flex min-w-0 items-center gap-1")],
        [
          folderMenu(h, model, !floating),
          h.span([h.Class("pick cursor-default max-[400px]:hidden"), h.Title("model")], ["sonnet 5.5"]),
          h.span([h.Class("grow")], []),
          ...(model.agent ? [h.span([h.Class("pick cursor-default max-[360px]:hidden")], [creditTicks(h, model.agent.credits)])] : []),
          h.span([h.Class("u-kbd me-1 max-[760px]:hidden"), h.AriaHidden(true)], ["↵"]),
          busy
            ? h.button([h.Type("button"), h.Class("u-btn u-btn--sm"), h.OnClick(Message.ClickedStop())], [dot(h, "live"), "stop"])
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

const emptyThread = (h: H, model: Model) => {
  const busy = isBusy(model);
  const enabled = model.connection._tag === "Connected" && !busy;
  return h.div(
    [h.Id(THREAD_ID), h.Class("flex-1 overflow-y-auto overscroll-contain")],
    [
      h.div(
        [h.Class(`${COLUMN} enter gap-8 pt-[10vh] pb-16`)],
        [
          h.div(
            [h.Class("grid grid-cols-[1fr_auto] items-center gap-8 max-[520px]:grid-cols-1")],
            [
              h.div(
                [h.Class("grid gap-3")],
                [
                  h.span([h.Class("flex items-center gap-2")], [dot(h), label(h, "library agent for put.io")]),
                  h.h1([h.Class("m-0 max-w-[22ch] text-[32px] leading-[1.15] font-normal tracking-[-0.01em] text-balance text-fg-strong")], ["what should i do with your put.io?"]),
                  h.p([h.Class("m-0 max-w-[46ch] text-fg-2")], ["i read your files, score the library and answer questions. i change nothing."]),
                ],
              ),
              h.span([h.Class("u-ticks grid size-[136px] place-items-center border border-line bg-black max-[520px]:hidden")], [
                art(h, "idle", 96),
              ]),
            ],
          ),
          ...(model.agent?.lastAudit ? [lastScanStrip(h, model.agent.lastAudit, model.agent.credits)] : []),
          composer(h, model, "ask puterminator…", false),
          starterRows(h, enabled),
          ...statusRows(h, model),
        ],
      ),
    ],
  );
};

const threadPage = (h: H, model: Model) => {
  const busy = isBusy(model);
  const turns = toTurns(model.history, model.partial, busy);
  if (!model.synced) return shell(h, model, [h.div([h.Id(THREAD_ID), h.Class("flex-1")], [])]);
  if (turns.length === 0) return shell(h, model, [emptyThread(h, model)]);

  const last = turns.at(-1);
  const lastItem = last?.items.at(-1);
  const liveText = model.partial?.at(-1)?.type === "text";
  const caretKey = liveText && lastItem?.kind === "text" && lastItem.key.startsWith("live.") ? lastItem.key : null;
  const asked = new Set(turns.flatMap((t) => t.items.flatMap((i) => (i.kind === "user" ? [i.text.toLowerCase()] : []))));
  const next = STARTERS.filter((s) => !asked.has(s));
  // A sent message has no agent turn yet; show who is on it.
  const pending = busy && last?.role === "user";

  return shell(h, model, [
    h.div(
      [h.Id(THREAD_ID), h.Class("flex-1 overflow-y-auto overscroll-contain [scroll-padding-bottom:200px]")],
      [
        h.div(
          [h.Class(`${COLUMN} gap-7 pt-10 pb-[220px]`)],
          [
            ...turns.map((t) => (t.role === "user" ? userView(h, t) : agentView(h, t, model, caretKey, busy && t === last))),
            ...(pending ? [agentView(h, { key: "pending", role: "assistant", items: [] }, model, null, true)] : []),
            ...statusRows(h, model),
            ...(!busy && model.error === null && last?.role === "assistant" && next.length > 0
              ? [followUps(h, next, model.connection._tag === "Connected")]
              : []),
          ],
        ),
      ],
    ),
    h.div(
      [h.Class("pointer-events-none absolute inset-x-0 bottom-0 bg-linear-to-b from-transparent to-bg to-35% pt-10 pb-4 max-[760px]:pb-3")],
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
