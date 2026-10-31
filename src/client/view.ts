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

// The reading column: 46rem of content plus the gutter.
const COLUMN = "mx-auto grid w-full max-w-[calc(46rem+40px)] px-5 max-[480px]:px-4";

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
    h.Class("block flex-none select-none [image-rendering:pixelated]"),
    h.Style({ width: `${px}px`, height: `${px}px` }),
  ]);

const dot = (h: H, tone: "live" | "ok" | "warn" | "error" | null = null) =>
  h.span([h.Class(`dot ${tone ? `dot-${tone}` : ""}`), h.AriaHidden(true)], []);

/** Lowercase meta text. */
const label = (h: H, text: string, extra = "") => h.span([h.Class(`text-[13px] text-fg-3 ${extra}`)], [text]);

// ---------- shell ----------

const status = (h: H, model: Model) =>
  model.connection._tag === "Connected"
    ? h.span([h.Class("flex items-center gap-2 text-[13px] text-fg-3 max-[480px]:sr-only")], [dot(h, "live"), "online"])
    : model.connection._tag === "Lost"
      ? h.span([h.Class("flex items-center gap-2 text-[13px] text-fg-3 max-[480px]:sr-only")], [dot(h, "warn"), "reconnecting"])
      : h.span([h.Class("flex items-center gap-2 text-[13px] text-fg-3 max-[480px]:sr-only")], [dot(h), "connecting"]);

/** One 56px topbar row over the content; no inset panel, no shadow. */
const frame = (h: H, topbarEnd: Html[], children: Html[], busy = false) =>
  h.div(
    [h.Class("grid h-dvh grid-rows-[auto_minmax(0,1fr)] bg-bg text-fg"), ...(busy ? [h.AriaBusy(true)] : [])],
    [
      h.header(
        [h.Class("flex-none")],
        [
          h.div(
            [h.Class(`${COLUMN} flex! h-14 items-center gap-4`)],
            [
              h.span([h.Class("flex items-center gap-2.5 font-display text-[16px] text-accent")], [mark(h, 22), "puterminator"]),
              ...topbarEnd,
            ],
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

/** put.io's avatar, loaded straight from put.io; the initial stands in when there is none or it fails. */
const avatar = (h: H, username: string, url: string | null) =>
  url
    ? h.img([
        h.Src(url),
        h.Alt(""),
        h.Width("24"),
        h.Height("24"),
        h.Referrerpolicy("no-referrer"),
        h.Draggable(false),
        h.OnError(Message.FailedAvatar()),
        h.Class("block size-6 flex-none rounded-full bg-raised object-cover select-none"),
      ])
    : h.span(
        [h.Class("grid size-6 flex-none place-items-center rounded-full bg-raised text-[12px] font-medium text-fg-2 select-none"), h.AriaHidden(true)],
        [username.slice(0, 1)],
      );

const account = (h: H, username: string, url: string | null) =>
  h.span([h.Class("flex min-w-0 items-center gap-2"), h.Title(`signed in as ${username}`)], [
    avatar(h, username, url),
    h.span([h.Class("truncate text-[13px] text-fg-3 max-[560px]:sr-only")], [username]),
  ]);

const shell = (h: H, model: Model, children: Html[]) =>
  frame(
    h,
    [
      h.span([h.Class("grow")], []),
      status(h, model),
      ...(model.agent?.username ? [account(h, model.agent.username, model.avatarFailed ? null : (model.agent.avatarUrl ?? null))] : []),
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
    ? h.a([h.Href("/auth/login"), h.Class("btn btn-primary justify-self-start")], ["continue with put.io ↗"])
    : kind === "unconfigured"
      ? h.div(
          [h.Class("grid justify-items-start gap-3")],
          [
            h.button([h.Type("button"), h.Disabled(true), h.Class("btn")], ["continue with put.io"]),
            h.span([h.Class("flex items-center gap-2 text-[13px] text-fg-2")], [dot(h, "warn"), "sign-in isn’t wired up yet."]),
          ],
        )
      : h.div(
          [h.Class("grid justify-items-start gap-3")],
          [
            h.span([h.Class("flex items-center gap-2 text-[13px] text-fg-2"), h.Role("alert")], [dot(h, "error"), "couldn’t reach puterminator."]),
            h.button([h.Type("button"), h.Class("btn"), h.OnClick(Message.ClickedRetryMe())], ["try again"]),
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
            [h.Class("grid gap-6 rounded-2xl border border-line bg-raised p-8")],
            [
              art(h, kind === "ready" ? "asleep" : "unplugged", 64),
              h.div(
                [h.Class("grid gap-2")],
                [
                  h.h1([h.Class("m-0 font-display text-[22px] font-medium text-accent")], ["puterminator"]),
                  h.p([h.Class("m-0 text-fg-2")], ["terminates the mess in your put.io."]),
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
  h.div([h.Class(`min-w-0 truncate font-mono text-[12px] text-fg-2 ${extra}`), h.Title(text)], [text]);

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

const runLog = (h: H, key: string, rows: Html[]) => h.keyed("div")(`log.${key}`, [h.Class("grid min-w-0")], rows);

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

/** One thin bar per subscore; the worst one is the only accent on the card. */
const bar = (h: H, value: number, worst: boolean) =>
  h.span([h.Class("block h-1 w-full overflow-hidden rounded-full bg-line"), h.AriaHidden(true)], [
    h.i([h.Class(`grow-bar block h-full rounded-full ${worst ? "bg-accent" : "bg-fg-3"}`), h.Style({ width: `${Math.min(100, Math.max(0, value))}%` })], []),
  ]);

const subScore = (h: H, name: string, value: number, worst: boolean) =>
  h.div(
    [h.Class("grid min-w-0 content-start gap-1.5")],
    [
      h.span([h.Class("flex items-baseline justify-between gap-2")], [
        label(h, name, worst ? "text-accent!" : ""),
        h.span([h.Class("text-[14px] font-medium text-fg-strong tabular-nums")], [`${value}`]),
      ]),
      bar(h, value, worst),
    ],
  );

const scoreCard = (h: H, model: Model, a: Audit, uid: string, live: boolean) => {
  const mood = moodOf(a);
  const subs: Array<[string, number]> = [
    ["naming", a.scores.naming],
    ["structure", a.scores.structure],
    ["junk", a.scores.junk],
    ["duplicates", a.scores.duplicates],
  ];
  const worst = Math.min(...subs.map((s) => s[1]));
  const worstName = worst < 100 ? subs.find((s) => s[1] === worst)?.[0] : undefined;
  const facts = [`${fmt(a.totals.items)} items`, size(a.totals.bytes)];
  return h.section(
    [
      h.Class(`${live ? "enter live" : ""} my-1 grid gap-6 rounded-2xl border border-line bg-raised p-6 max-[480px]:p-4`),
      h.AriaLabel("library score"),
      h.DataAttribute("testid", "score-card"),
    ],
    [
      h.div(
        [h.Class("flex items-center gap-5")],
        [
          art(h, mood, 72),
          h.div(
            [h.Class("grid min-w-0 gap-1")],
            [
              label(h, `library score · ${a.rootName}`, "truncate"),
              h.div(
                [h.Class("flex items-baseline gap-3")],
                [
                  h.span(
                    [h.Class("flex items-baseline gap-1.5"), h.Role("img"), h.AriaLabel(`library score ${a.score} out of 100`)],
                    [h.span([h.Class("font-display text-[56px] leading-none font-medium text-accent tabular-nums")], [`${a.score}`]), h.span([h.Class("text-[14px] text-fg-3")], ["/100"])],
                  ),
                  h.span([h.Class("text-[15px] text-fg")], [MOOD_LINE[mood]]),
                ],
              ),
            ],
          ),
        ],
      ),
      h.div([h.Class("grid grid-cols-4 gap-x-6 gap-y-4 max-[520px]:grid-cols-2")], subs.map(([n, v]) => subScore(h, n, v, n === worstName))),
      h.div(
        [h.Class("grid gap-2")],
        [
          h.div(
            [h.Class("flex flex-wrap items-center gap-x-2 text-[13px] text-fg-3 tabular-nums")],
            [
              ...facts.flatMap((f, i) => (i === 0 ? [h.span([], [f])] : [h.span([h.Class("text-fg-4")], ["·"]), h.span([], [f])])),
              ...(a.truncated
                ? [h.span([h.Class("text-fg-4")], ["·"]), h.span([h.Class("flex items-center gap-2 text-fg-2"), h.Title("too big to read in one go")], [dot(h, "warn"), "partial scan"])]
                : []),
              ...(model.library ? [browseButton(h)] : []),
            ],
          ),
          ...auditDetails(h, model, libraryIndex(model), uid, a),
        ],
      ),
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

/** The agent speaks from a gutter mark; no name row, no box. */
const agentView = (h: H, turn: Turn, model: Model, caretKey: string | null, live: boolean) =>
  h.keyed("article")(
    turn.key,
    [h.Class("grid min-w-0 grid-cols-[20px_minmax(0,1fr)] gap-x-3 max-[480px]:grid-cols-1"), h.DataAttribute("role", "assistant"), h.AriaLabel("puterminator")],
    [
      h.span([h.Class("pt-0.5 max-[480px]:hidden")], [mark(h, 20)]),
      h.div([h.Class("grid min-w-0 gap-3")], agentBody(h, turn, model, caretKey, live)),
    ],
  );

/** The user's words sit on the right in a quiet block; that alone tells the voices apart. */
const userView = (h: H, turn: Turn, live: boolean) =>
  h.keyed("article")(
    turn.key,
    [h.Class(`grid justify-items-end ${live ? "enter-soft" : ""}`), h.DataAttribute("role", "user"), h.AriaLabel("you")],
    [
      h.div(
        [h.Class("max-w-[80%] rounded-2xl bg-raised px-4 py-2.5 break-words whitespace-pre-wrap text-fg-strong")],
        [turn.items[0]?.kind === "user" ? turn.items[0].text : ""],
      ),
    ],
  );

const followUps = (h: H, items: readonly string[], enabled: boolean) =>
  h.div(
    [h.Class("flex flex-wrap gap-2 ps-8 max-[480px]:ps-0")],
    items.map((s) =>
      h.button(
        [
          h.Type("button"),
          h.Disabled(!enabled),
          h.Class(
            "rounded-full border border-line px-3 py-1.5 text-[13px] text-fg-2 transition-colors duration-160 hover:border-line-hover hover:text-fg active:text-fg disabled:opacity-40",
          ),
          h.OnClick(Message.ClickedStarter({ text: s })),
        ],
        [s],
      ),
    ),
  );

const starterRows = (h: H, enabled: boolean) =>
  h.div(
    [h.Class("grid gap-1")],
    [
      label(h, "start with", "mb-1"),
      ...STARTERS.map((s) =>
        h.button(
          [
            h.Type("button"),
            h.Disabled(!enabled),
            h.Class("group -mx-3 grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-4 rounded-lg px-3 py-2.5 text-start transition-colors duration-160 hover:bg-raised active:bg-raised disabled:opacity-40"),
            h.OnClick(Message.ClickedStarter({ text: s })),
          ],
          [
            h.span([h.Class("flex min-w-0 items-baseline gap-3")], [
              h.span([h.Class("text-fg transition-colors duration-160 group-hover:text-fg-strong group-active:text-fg-strong")], [s]),
              h.span([h.Class("truncate text-[13px] text-fg-3 max-[520px]:hidden")], [STARTER_NOTES[s] ?? ""]),
            ]),
            h.span([h.Class("text-[13px] text-fg-4 transition-transform duration-160 group-hover:text-fg-2 motion-safe:group-hover:translate-x-0.5")], ["→"]),
          ],
        ),
      ),
    ],
  );

/** The library tree opens from where the library's numbers are, not from the topbar. */
const browseButton = (h: H) =>
  h.button(
    [h.Type("button"), h.Class("hit ms-auto flex-none text-[13px] text-fg-2 transition-colors duration-160 hover:text-fg active:text-fg"), h.OnClick(Message.ToggledTree())],
    ["browse →"],
  );

const stat = (h: H, name: string, value: string, note: Array<Html | string>) =>
  h.div([h.Class("grid min-w-0 gap-1")], [label(h, name), h.span([h.Class("font-display text-[26px] leading-none font-medium text-fg-strong tabular-nums")], [value]), h.span([h.Class("flex min-w-0 items-center gap-2 text-[13px] text-fg-3")], note)]);

const lastScanStrip = (h: H, last: LastAudit, credits: Credits, browsable: boolean) =>
  h.div(
    [h.Class("grid grid-cols-3 gap-6 max-[480px]:grid-cols-2")],
    [
      stat(h, "last score", `${last.score}`, [new Date(last.at).toLocaleDateString("en-US", { month: "short", day: "numeric" }).toLowerCase()]),
      stat(h, "items", fmt(last.items), [h.span([h.Class("truncate")], [`in ${last.rootName}`]), ...(browsable ? [browseButton(h)] : [])]),
      h.div([h.Class("max-[480px]:hidden")], [stat(h, "credits", fmt(creditsLeft(credits)), ["left this month"])]),
    ],
  );

/** Shown once a retry has failed too, so a single blip stays in the topbar. */
const connectionNotice = (h: H, model: Model) =>
  model.attempts < 2
    ? []
    : [
        h.div(
          [h.Class("notice"), h.Role("status")],
          [
            dot(h, "warn"),
            h.span([h.Class("grow")], ["can’t reach the agent. retrying…"]),
            ...(model.connection._tag === "Lost"
              ? [h.button([h.Type("button"), h.Class("hit btn btn-sm"), h.OnClick(Message.RetriedConnect({ attempts: model.attempts }))], ["retry now"])]
              : []),
          ],
        ),
      ];

// The length error renders in the composer, next to the field it is about.
const statusRows = (h: H, model: Model) => [
  ...connectionNotice(h, model),
  ...(model.error === null || model.error === LENGTH_ERROR
    ? []
    : [h.div([h.Class("notice"), h.Role("alert")], [dot(h, "error"), h.span([], [model.error])])]),
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
                  `pop absolute start-0 z-20 grid max-h-72 w-max max-w-[min(300px,calc(100vw-48px))] min-w-52 overflow-y-auto overscroll-contain rounded-xl border border-line-strong bg-raised p-1 shadow-[0_12px_32px_rgb(0_0_0/0.45)] ${below ? "top-full mt-1 origin-top-left" : "bottom-full mb-1 origin-bottom-left"}`,
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
                      "flex h-8 min-w-0 items-center gap-2.5 rounded-md px-3 text-start text-[13px] text-fg-2 transition-colors duration-160 hover:bg-hover hover:text-fg focus-visible:bg-hover focus-visible:text-fg focus-visible:outline-offset-[-2px] active:bg-hover active:text-fg aria-checked:text-fg",
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
        `pointer-events-auto grid w-full gap-3 rounded-2xl border bg-raised px-4 pt-3.5 pb-3 shadow-[0_8px_24px_rgb(0_0_0/0.25)] transition-colors duration-160 ${tooLong ? "border-danger/60!" : "border-line-strong hover:border-line-hover focus-within:border-line-hover!"}`,
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
          "block max-h-[160px] min-h-[24px] w-full resize-none border-0 bg-transparent p-0 text-[16px] leading-normal text-fg-strong caret-accent outline-none [field-sizing:content] placeholder:text-fg-3 focus-visible:outline-none pointer-fine:text-[15px]",
        ),
        h.OnInput((value) => Message.UpdatedDraft({ value })),
        h.OnKeyDownPreventDefault((key, mods) => (key === "Enter" && !COARSE && !mods.shiftKey && !mods.altKey ? Option.some(Message.SubmittedDraft()) : Option.none())),
      ]),
      ...(tooLong
        ? [h.p([h.Id(errorId), h.Class("m-0 flex items-center gap-2 text-[12px] text-fg-2"), h.Role("alert")], [dot(h, "error"), LENGTH_ERROR])]
        : []),
      h.div(
        [h.Class("flex min-w-0 items-center gap-2 text-[13px] text-fg-3")],
        [
          h.span([h.Class("-ms-2")], [folderMenu(h, model, !floating)]),
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
                  h.Class("hit btn btn-sm"),
                  h.OnClick(Message.ClickedStop()),
                ],
                [dot(h, "live"), model.stopping ? "stopping…" : "stop"],
              )
            : h.keyed("button")(
                "send",
                [
                  h.Type("submit"),
                  h.Disabled(!canSend),
                  h.AriaLabel("send"),
                  h.Title("send"),
                  h.Class("hit btn btn-icon btn-primary text-[16px] disabled:opacity-30"),
                ],
                [h.span([h.AriaHidden(true)], ["↑"])],
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
        [h.Class(`${COLUMN} enter gap-10 pt-[12svh] pb-16`)],
        [
          h.div(
            [h.Class("grid grid-cols-[1fr_auto] items-center gap-8 max-[520px]:grid-cols-1")],
            [
              h.div(
                [h.Class("grid gap-3")],
                [
                  label(h, "library agent for put.io"),
                  h.h1([h.Class("m-0 max-w-[22ch] font-display text-[36px] leading-[1.1] font-medium text-balance text-fg-strong")], ["what should i do with your put.io?"]),
                  h.p([h.Class("m-0 max-w-[46ch] text-[15px] text-fg-2")], ["i scan your library, score the mess and hunt down junk, duplicates and bad names."]),
                ],
              ),
              h.span([h.Class("max-[520px]:hidden")], [art(h, "idle", 96)]),
            ],
          ),
          ...(model.agent?.lastAudit ? [lastScanStrip(h, model.agent.lastAudit, model.agent.credits, model.library !== null)] : []),
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
          [h.Class(`${COLUMN} gap-9 pt-10 pb-14`)],
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
