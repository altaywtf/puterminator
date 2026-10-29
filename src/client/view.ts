import * as Option from "effect/Option";
import { createKeyedLazy, type Document, type Html, type HtmlBuilder } from "foldkit/html";
import type { Audit } from "../shared/audit";
import { type Credits, creditsLeft, type Folder, type LastAudit, ROOT_FOLDER } from "../shared/contract";
import { type Item, type Turn, toTurns } from "../shared/thread";
import { art, type Mood, moodOf } from "./art";
import logoUrl from "./logo.svg?inline";
import {
  COMPOSER_ID,
  FOLDER_TRIGGER_ID,
  folderOptionId,
  isBusy,
  isLocked,
  LENGTH_ERROR,
  Message,
  type Model,
  Session,
  THREAD_ID,
  targetFolder,
} from "./main";
import { auditDetails, fileList, libraryIndex, playerView, toolFiles, treeDrawer } from "./files";
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

// On-screen keyboards rarely send Shift+Enter, so on touch Enter is a newline and the button sends.
const COARSE = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

// ---------- atoms ----------

/** puterminator's own mark: colored, no frame. */
const mark = (h: H, px: number) =>
  h.img([
    h.Src(logoUrl),
    h.Alt(""),
    h.Width(`${px}`),
    h.Height(`${px}`),
    h.Draggable(false),
    h.Class("block flex-none select-none"),
    h.Style({ width: `${px}px`, height: `${px}px` }),
  ]);

const dot = (h: H, tone: "live" | "ok" | "warn" | "error" | null = null) =>
  h.span([h.Class(`u-dot ${tone ? `u-dot--${tone}` : ""}`), h.AriaHidden(true)], []);

const label = (h: H, text: string, extra = "") => h.span([h.Class(`u-label ${extra}`)], [text]);

// ---------- shell ----------

const status = (h: H, model: Model) =>
  model.connection._tag === "Connected"
    ? h.span([h.Class("flex items-center gap-2 text-[11px] text-fg-3")], [dot(h, "live"), "online"])
    : model.connection._tag === "Lost"
      ? h.span([h.Class("flex items-center gap-2 text-[11px] text-fg-3")], [dot(h, "warn"), "reconnecting"])
      : h.span([h.Class("flex items-center gap-2 text-[11px] text-fg-3")], [dot(h), "connecting"]);

/** One 56px topbar row over the content; no inset panel, no shadow. */
const frame = (h: H, topbarEnd: Html[], children: Html[], busy = false) =>
  h.div(
    [h.Class("grid h-dvh grid-rows-[auto_minmax(0,1fr)] bg-bg text-fg"), ...(busy ? [h.AriaBusy(true)] : [])],
    [
      h.header(
        [h.Class("u-topbar")],
        [
          h.div(
            [h.Class(`${COLUMN} u-topbar-row flex! gap-4`)],
            [h.span([h.Class("u-topbar-mark")], [mark(h, 24), h.span([h.Class("text-fg-strong")], ["puterminator"])]), ...topbarEnd],
          ),
        ],
      ),
      h.main([h.Class("relative flex min-h-0 min-w-0 flex-col")], children),
    ],
  );

/** Always mounted, so screen readers announce changes; streamed text itself stays out of it. */
const liveStatus = (h: H, model: Model) =>
  h.div(
    [h.Class("sr-only"), h.Role("status"), h.AriaLive("polite")],
    [
      model.connection._tag === "Lost"
        ? "connection lost. reconnecting."
        : isBusy(model)
          ? "puterminator is working."
          : model.history.length > 0
            ? "reply ready."
            : "",
    ],
  );

const shell = (h: H, model: Model, children: Html[]) =>
  frame(
    h,
    [
      h.span([h.Class("u-tag max-[420px]:hidden")], ["read-only"]),
      h.span([h.Class("grow")], []),
      ...(model.library
        ? [
            h.button(
              [
                h.Type("button"),
                h.Class(`hit text-[13px] transition-colors duration-160 hover:text-fg ${model.treeOpen ? "text-fg-strong" : "text-fg-2"}`),
                h.AriaExpanded(model.treeOpen),
                h.OnClick(Message.ToggledTree()),
              ],
              ["library"],
            ),
          ]
        : []),
      status(h, model),
      h.span([h.Class("truncate text-[13px] text-fg-3 max-[560px]:hidden")], [model.agent?.username ?? ""]),
      h.button(
        [
          h.Type("button"),
          h.Class("hit text-[13px] text-fg-2 transition-colors duration-160 hover:text-fg active:text-fg"),
          h.OnClick(Message.ClickedSignOut()),
        ],
        ["sign out"],
      ),
    ],
    [liveStatus(h, model), ...children, ...treeDrawer(h, model), ...playerView(h, model)],
  );

/** The shell's frame while /api/me resolves, so the swap to sign-in or the thread keeps its shape. */
const loadingView = (h: H) => h.div([h.Class("h-dvh bg-bg"), h.AriaBusy(true)], [h.span([h.Class("sr-only"), h.Role("status")], ["loading"])]);

// ---------- sign in ----------

type SignIn = "ready" | "unconfigured" | "failed";

const signInAction = (h: H, kind: SignIn) =>
  kind === "ready"
    ? h.a([h.Href("/auth/login"), h.Class("u-btn u-btn--primary justify-self-start")], ["continue with put.io ↗"])
    : kind === "unconfigured"
      ? h.div(
          [h.Class("grid justify-items-start gap-3")],
          [
            h.button([h.Type("button"), h.Disabled(true), h.Class("u-btn")], ["continue with put.io"]),
            h.span([h.Class("flex items-center gap-2 text-[13px] text-fg-2")], [dot(h, "warn"), "sign-in isn’t wired up yet."]),
          ],
        )
      : h.div(
          [h.Class("grid justify-items-start gap-3")],
          [
            h.span([h.Class("flex items-center gap-2 text-[13px] text-fg-2"), h.Role("alert")], [dot(h, "error"), "couldn’t reach puterminator."]),
            h.button([h.Type("button"), h.Class("u-btn"), h.OnClick(Message.ClickedRetryMe())], ["try again"]),
          ],
        );

const signInView = (h: H, kind: SignIn) =>
  h.div(
    [h.Class("grid min-h-dvh place-items-center bg-bg p-6 text-fg")],
    [
      h.div(
        [h.Class("enter w-full max-w-[360px]")],
        [
          h.div(
            [h.Class("u-panel u-ticks grid gap-6 p-8!")],
            [
              art(h, kind === "ready" ? "asleep" : "unplugged", 72),
              h.div(
                [h.Class("grid gap-2")],
                [
                  h.h1([h.Class("m-0 text-base font-normal text-fg-strong")], ["puterminator"]),
                  h.p([h.Class("m-0 text-[13px] text-fg-2")], ["reads your put.io, scores the mess and says what to fix. changes nothing."]),
                ],
              ),
              signInAction(h, kind),
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
    [h.Type("button"), h.Class("step-head hit"), h.AriaExpanded(open), ...(open ? [h.AriaControls(bodyId)] : []), h.OnClick(Message.ToggledStep({ key }))],
    [slot(h, chev(h)), ...children],
  );

const detailSpan = (h: H, detail: string | null) =>
  detail === null ? [] : [h.span([h.Class("min-w-0 truncate text-fg-4 tabular-nums")], [`· ${detail}`])];

const liveRow = (h: H, text: string, detail: string | null = null) =>
  h.div([h.Class("step-head")], [slot(h, dot(h, "live")), h.span([h.Class("text-fg")], [text]), ...detailSpan(h, detail)]);

const thinkingRow = (h: H, item: ThinkingItem, model: Model) => {
  const bodyId = `step-${item.key}`;
  const open = model.expanded.includes(item.key);
  if (item.streaming) return h.keyed("div")(item.key, [h.Class("enter-soft")], [liveRow(h, "thinking")]);
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
          ...detailSpan(h, item.state === "error" && item.output === null ? "didn’t finish" : d.detail),
        ]);
  return h.keyed("div")(item.key, [h.Class(`grid min-w-0 ${item.state === "running" ? "enter-soft" : ""}`)], [head, ...(open || item.state === "running" ? [body] : [])]);
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
      h.i([h.Class(`grow-bar block h-1 w-full ${i < on ? (worst ? "bg-accent" : "bg-fg-2") : "bg-line"}`), h.Style({ animationDelay: `${i * 12}ms` })], []),
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

const scoreCard = (h: H, model: Model, a: Audit, uid: string, live: boolean) => {
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
    [h.Class(`${live ? "enter live" : ""} u-ticks my-2 grid border border-line bg-bg`), h.DataAttribute("testid", "score-card")],
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
      ...auditDetails(h, model, libraryIndex(model), uid, a),
    ],
  );
};

// ---------- thread ----------

const lazyMarkdown = createKeyedLazy();

/** Text stays prose; consecutive steps share one run log; a scan's score card closes its log. */
const agentBody = (h: H, turn: Turn, model: Model, caretKey: string | null, live: boolean): Html[] => {
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
          h.keyed("div")(item.key, [h.Class("min-w-0")], [lazyMarkdown(item.key, renderMarkdown, [item.text, item.key === caretKey, model.library]) ?? h.span([], [])]),
        );
        break;
      case "thinking":
        if (rows.length === 0) logKey = item.key;
        rows.push(thinkingRow(h, item, model));
        break;
      case "tool": {
        if (rows.length === 0) logKey = item.key;
        rows.push(toolRow(h, item, model));
        const ix = libraryIndex(model);
        const listed = ix && item.state === "done" ? toolFiles(ix, item.name, item.input, item.output) : null;
        if (ix && listed && listed.nodes.length > 0) {
          flush();
          out.push(fileList(h, model, ix, item.key, listed.nodes, listed.total));
        }
        const audit = item.name === "scan_library" && item.state === "done" ? auditOf(item.output) : Option.none();
        if (Option.isSome(audit)) {
          flush();
          out.push(h.keyed("div")(`card.${item.key}`, [], [scoreCard(h, model, audit.value, item.key, live)]));
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
  h.keyed("article")(
    turn.key,
    [h.Class("grid min-w-0 gap-3"), h.DataAttribute("role", "assistant"), h.AriaLabel("puterminator")],
    [
      h.div(
        [h.Class("flex items-center gap-2.5")],
        [mark(h, 20), label(h, "puterminator", "text-fg-2!"), ...(live ? [h.span([h.Class("text-[11px] text-fg-4")], ["· working"])] : [])],
      ),
      h.div([h.Class("grid min-w-0 gap-3 ps-[30px] max-[480px]:ps-0")], agentBody(h, turn, model, caretKey, live)),
    ],
  );

const userView = (h: H, turn: Turn, live: boolean) =>
  h.keyed("article")(
    turn.key,
    [
      h.Class(`grid justify-items-end gap-1.5 border-t border-line pt-6 first:border-t-0 first:pt-0 ${live ? "enter-soft" : ""}`),
      h.DataAttribute("role", "user"),
      h.AriaLabel("you"),
    ],
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
    [h.Class("flex flex-wrap gap-x-2 gap-y-3 ps-[30px] pointer-coarse:gap-y-4 max-[480px]:ps-0")],
    items.map((s) =>
      h.button(
        [h.Type("button"), h.Disabled(!enabled), h.Class("hit u-btn u-btn--sm text-fg-2! disabled:opacity-40"), h.OnClick(Message.ClickedStarter({ text: s }))],
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
              "group grid grid-cols-[1fr_auto] items-baseline gap-x-4 border-t border-line py-3 text-start transition-colors duration-160 last:border-b active:bg-raised disabled:opacity-40",
            ),
            h.OnClick(Message.ClickedStarter({ text: s })),
          ],
          [
            h.span([h.Class("text-fg-strong transition-colors duration-160 group-hover:text-accent group-active:text-accent")], [s]),
            h.span([h.Class("text-[12px] text-fg-4 transition-transform duration-160 group-hover:text-fg-2 motion-safe:group-hover:translate-x-0.5")], ["→"]),
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

/** Shown once a retry has failed too, so a single blip stays in the topbar. */
const connectionNotice = (h: H, model: Model) =>
  model.attempts < 2
    ? []
    : [
        h.div(
          [h.Class("u-notice items-center!"), h.Role("status")],
          [
            dot(h, "warn"),
            h.span([h.Class("grow")], ["can’t reach the agent. retrying…"]),
            ...(model.connection._tag === "Lost"
              ? [h.button([h.Type("button"), h.Class("hit u-btn u-btn--sm"), h.OnClick(Message.RetriedConnect({ attempts: model.attempts }))], ["retry now"])]
              : []),
          ],
        ),
      ];

// The length error renders in the composer, next to the field it is about.
const statusRows = (h: H, model: Model) => [
  ...connectionNotice(h, model),
  ...(model.error === null || model.error === LENGTH_ERROR
    ? []
    : [h.div([h.Class("u-notice items-center!"), h.Role("alert")], [dot(h, "error"), h.span([], [model.error])])]),
];

// ---------- composer ----------

const folderMenu = (h: H, model: Model, below: boolean) => {
  const target = targetFolder(model);
  const options: Folder[] = [ROOT_FOLDER, ...model.folders.filter((f) => f.id !== ROOT_FOLDER.id)];
  // The target can be a nested folder the list doesn't hold; then the first option takes focus.
  const active = Math.max(0, options.findIndex((f) => f.id === target.id));
  const last = options.length - 1;
  // Arrow keys move between items in place; no model state needed for a roving focus.
  const moveFrom = (i: number) => (key: string) => {
    const to = key === "ArrowDown" ? (i + 1) % options.length : key === "ArrowUp" ? (i + last) % options.length : key === "Home" ? 0 : key === "End" ? last : null;
    return to === null ? Option.none() : Option.some({ focusSelector: `#${folderOptionId(to)}`, message: Message.CompletedEffect() });
  };
  return h.div(
    [
      h.Class("relative min-w-0"),
      h.OnKeyDownPreventDefault((key) => (key === "Escape" && model.menuOpen ? Option.some(Message.ClosedFolderMenu()) : Option.none())),
    ],
    [
      h.button(
        [
          h.Id(FOLDER_TRIGGER_ID),
          h.Type("button"),
          h.Class("pick hit max-w-[220px] min-w-0"),
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
                h.OnKeyDown((key) => (key === "Tab" ? Message.LeftFolderMenu() : Message.CompletedEffect())),
                h.Class(
                  `pop absolute start-0 z-20 grid max-h-72 w-max max-w-[min(300px,calc(100vw-48px))] min-w-52 overflow-y-auto overscroll-contain border border-line bg-raised py-1 ${below ? "top-full mt-1 origin-top-left" : "bottom-full mb-1 origin-bottom-left"}`,
                ),
              ],
              options.map((f, i) =>
                h.button(
                  [
                    h.Id(folderOptionId(i)),
                    h.Type("button"),
                    h.Role("menuitemradio"),
                    h.AriaChecked(f.id === target.id),
                    h.Tabindex(i === active ? 0 : -1),
                    h.Class(
                      "flex h-8 min-w-0 items-center gap-2.5 px-3 text-start text-[13px] text-fg-2 transition-colors duration-160 hover:bg-bg hover:text-fg focus-visible:bg-bg focus-visible:text-fg focus-visible:outline-offset-[-1px] active:bg-bg active:text-fg aria-checked:text-fg",
                    ),
                    h.OnKeyDownFocus(moveFrom(i)),
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
  const canSend = connected && !model.sending && model.draft.trim().length > 0;
  const tooLong = model.error === LENGTH_ERROR;
  const errorId = `${COMPOSER_ID}-error`;
  const sep = h.span([h.Class("text-fg-4 max-[400px]:hidden"), h.AriaHidden(true)], ["·"]);
  return h.form(
    [
      h.Class(
        `pointer-events-auto grid w-full gap-3 rounded-xs border bg-raised px-4 pt-3.5 pb-3 transition-colors duration-160 ${tooLong ? "border-danger/60!" : "border-line-strong hover:border-line-hover focus-within:border-fg-3!"}`,
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
        h.EnterKeyHint(COARSE ? "enter" : "send"),
        ...(tooLong ? [h.AriaInvalid(true), h.AriaDescribedBy(errorId)] : []),
        h.Class(
          "block max-h-[160px] min-h-[24px] w-full resize-none border-0 bg-transparent p-0 text-[16px] leading-normal text-fg-strong caret-accent outline-none [field-sizing:content] placeholder:text-fg-3 focus-visible:outline-none pointer-fine:text-[14px]",
        ),
        h.OnInput((value) => Message.UpdatedDraft({ value })),
        h.OnKeyDownPreventDefault((key, mods) => (key === "Enter" && !COARSE && !mods.shiftKey && !mods.altKey ? Option.some(Message.SubmittedDraft()) : Option.none())),
      ]),
      ...(tooLong
        ? [h.p([h.Id(errorId), h.Class("m-0 flex items-center gap-2 text-[12px] text-fg-2"), h.Role("alert")], [dot(h, "error"), LENGTH_ERROR])]
        : []),
      h.div(
        [h.Class("flex min-w-0 items-center gap-2 text-[11px] text-fg-3")],
        [
          h.span([h.Class("-ms-1.5")], [folderMenu(h, model, !floating)]),
          sep,
          h.span([h.Class("max-[400px]:hidden"), h.Title("model")], ["sonnet 5.5"]),
          h.span([h.Class("grow")], []),
          ...(model.agent
            ? [h.span([h.Class("tabular-nums max-[360px]:hidden"), h.Title("credits left this month")], [`${fmt(creditsLeft(model.agent.credits))} credits`])]
            : []),
          // Keyed so send and stop are separate elements: focus and a second click never carry over.
          busy
            ? h.keyed("button")(
                "stop",
                [
                  h.Type("button"),
                  h.Disabled(model.stopping),
                  h.AriaLabel(model.stopping ? "stopping reply" : "stop reply"),
                  h.Class("hit u-btn u-btn--sm"),
                  h.OnClick(Message.ClickedStop()),
                ],
                [dot(h, "live"), model.stopping ? "stopping…" : "stop"],
              )
            : h.keyed("button")(
                "send",
                [h.Type("submit"), h.Disabled(!canSend), h.Class("hit u-btn u-btn--sm u-btn--primary disabled:opacity-30 disabled:active:scale-100")],
                ["send"],
              ),
        ],
      ),
    ],
  );
};

// ---------- page ----------

const emptyThread = (h: H, model: Model) => {
  const enabled = model.connection._tag === "Connected" && !isLocked(model);
  return h.div(
    [h.Id(THREAD_ID), h.Class("flex-1 overflow-y-auto overscroll-contain")],
    [
      h.div(
        [h.Class(`${COLUMN} enter gap-8 pt-[10svh] pb-16`)],
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
              h.span([h.Class("u-ticks pointer-events-none grid size-[136px] place-items-center border border-line bg-black select-none max-[520px]:hidden")], [
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
  if (!model.synced)
    return shell(h, model, [h.div([h.Id(THREAD_ID), h.Class("flex-1 overflow-y-auto")], [h.div([h.Class(`${COLUMN} pt-[10svh]`)], connectionNotice(h, model))])]);
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
      [h.Id(THREAD_ID), h.Class("flex-1 overflow-y-auto overscroll-contain [scroll-padding-bottom:56px]")],
      [
        h.div(
          [h.Class(`${COLUMN} gap-7 pt-10 pb-14`)],
          [
            ...turns.map((t) => (t.role === "user" ? userView(h, t, busy && (t === last || t === turns.at(-2))) : agentView(h, t, model, caretKey, busy && t === last))),
            ...(pending ? [agentView(h, { key: "pending", role: "assistant", items: [] }, model, null, true)] : []),
            ...statusRows(h, model),
            ...(!busy && model.error === null && last?.role === "assistant" && next.length > 0
              ? [followUps(h, next, model.connection._tag === "Connected" && !model.sending)]
              : []),
          ],
        ),
      ],
    ),
    // A flex row, not an overlay: the scroller shrinks as the draft grows. -mt-10 lets the fade overlap it.
    h.div(
      [h.Class("pointer-events-none relative -mt-10 flex-none bg-linear-to-b from-transparent to-bg to-35% pt-10 pb-[max(16px,env(safe-area-inset-bottom))]")],
      [h.div([h.Class(COLUMN)], [composer(h, model, "reply…", true)])],
    ),
  ]);
};

export const view = (model: Model, h: H): Document => ({
  title: "puterminator",
  body: Session.match(model.session, {
    Loading: () => loadingView(h),
    SignedOut: ({ configured }) => signInView(h, configured ? "ready" : "unconfigured"),
    Failed: () => signInView(h, "failed"),
    SignedIn: () => threadPage(h, model),
  }),
});
