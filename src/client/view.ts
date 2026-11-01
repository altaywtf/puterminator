import * as Option from "effect/Option";
import { createKeyedLazy, type Document, type Html, type HtmlBuilder } from "foldkit/html";
import { creditsLeft } from "../shared/contract";
import { type Item, type Turn, toTurns } from "../shared/thread";
import { art } from "./art";
import logoUrl from "./logo.svg?inline";
import { COMPOSER_ID, isBusy, isLocked, LENGTH_ERROR, Message, type Model, Session, THREAD_ID } from "./main";
import { toolCard } from "./cards";
import { playerView, treeDrawer } from "./files";
import { renderMarkdown } from "./markdown";
import { callLine, describeStep, fmt } from "./steps";
import { thoughtSeconds } from "./thinking";

type H = HtmlBuilder<Message>;
type ToolItem = Extract<Item, { kind: "tool" }>;
type ThinkingItem = Extract<Item, { kind: "thinking" }>;

/** First-run commands: what to type, and what it does. Each line sends its prompt. */
export const STARTERS: Array<[prompt: string, does: string]> = [
  ["audit my library", "score naming, junk, duplicates"],
  ["find junk files", "tracker filler, samples, .nfo"],
  ["what did i never play?", "the biggest files nobody opened"],
  ["clean up my downloads", "a diff you approve before anything moves"],
];

/** Credits left at which the composer starts showing the count. */
const LOW_CREDITS = 100;

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


// ---------- shell ----------

/** Silent while connected; the topbar only speaks up when the agent is out of reach. */
const status = (h: H, model: Model) =>
  model.connection._tag === "Connected"
    ? []
    : [
        h.span([h.Class("flex items-center gap-2 text-[13px] text-fg-3")], [
          dot(h, model.connection._tag === "Lost" ? "warn" : null),
          model.connection._tag === "Lost" ? "reconnecting" : "connecting",
        ]),
      ];

/** One 56px topbar row over the content; no inset panel, no shadow. */
const frame = (h: H, topbarEnd: Html[], children: Html[], busy = false, inert = false) =>
  h.div(
    [h.Class("grid h-dvh grid-rows-[auto_minmax(0,1fr)] bg-bg text-fg"), ...(busy ? [h.AriaBusy(true)] : []), ...(inert ? [h.Inert(true)] : [])],
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

const ACCOUNT_MENU_ID = "account-menu";

const menuItem = (h: H, text: string, message: Message) =>
  h.button(
    [
      h.Type("button"),
      h.Popovertarget(ACCOUNT_MENU_ID),
      h.Popovertargetaction("hide"),
      h.Class("flex h-9 items-center rounded-lg px-3 text-start text-[14px] text-fg-2 transition-colors duration-160 hover:bg-hover hover:text-fg focus-visible:bg-hover focus-visible:text-fg"),
      h.OnClick(message),
    ],
    [text],
  );

/** The avatar opens a native popover: who is signed in, the library tree, sign out. */
const accountMenu = (h: H, model: Model, username: string, url: string | null) => [
  h.button(
    [
      h.Type("button"),
      h.Popovertarget(ACCOUNT_MENU_ID),
      h.AriaLabel(`account: ${username}`),
      h.Class("hit rounded-full [anchor-name:--account]"),
    ],
    [avatar(h, username, url)],
  ),
  h.div(
    [
      h.Id(ACCOUNT_MENU_ID),
      h.Popover("auto"),
      h.Class(
        "m-0 mt-2 w-52 rounded-xl border border-line-strong bg-raised p-1 text-fg shadow-[0_12px_32px_rgb(0_0_0/0.45)] [position-anchor:--account] [inset:auto] [top:anchor(bottom)] [right:anchor(right)]",
      ),
    ],
    [
      h.p([h.Class("m-0 truncate px-3 pt-2 pb-1.5 text-[13px] text-fg-3")], [username]),
      ...(model.history.length > 0 && !isBusy(model) ? [menuItem(h, "new thread", Message.ClickedNewThread())] : []),
      ...(model.library ? [menuItem(h, "browse library", Message.ToggledTree())] : []),
      h.a(
        [
          h.Href("/privacy"),
          h.Class("flex h-9 items-center rounded-lg px-3 text-[14px] text-fg-2 no-underline transition-colors duration-160 hover:bg-hover hover:text-fg focus-visible:bg-hover focus-visible:text-fg"),
        ],
        ["privacy"],
      ),
      menuItem(h, "sign out", Message.ClickedSignOut()),
    ],
  ),
];

/** While the player is open, everything behind it is inert, so focus stays in the dialog. */
const shell = (h: H, model: Model, children: Html[]) =>
  h.div([h.Class("contents")], [
    frame(
      h,
      [
        h.span([h.Class("grow")], []),
        ...status(h, model),
        ...(model.agent?.username ? accountMenu(h, model, model.agent.username, model.avatarFailed ? null : (model.agent.avatarUrl ?? null)) : []),
      ],
      [liveStatus(h, model), ...children, ...treeDrawer(h, model)],
      false,
      model.player !== null,
    ),
    ...playerView(h, model),
  ]);

/** The shell's frame while /api/me resolves, so the swap to sign-in or the thread keeps its shape. */
const loadingView = (h: H) => h.div([h.Class("h-dvh bg-bg"), h.AriaBusy(true)], [h.span([h.Class("sr-only"), h.Role("status")], ["loading"])]);

// ---------- sign in ----------

type SignIn = "ready" | "unconfigured" | "failed";

/** What the terminal printed: a status line per state, the way a CLI answers `login`. */
const signInOutput = (h: H, kind: SignIn): Html[] =>
  kind === "ready"
    ? [h.span([h.Class("text-fg-3")], ["# terminates the mess in your put.io"]), h.span([h.Class("text-fg-3")], ["# asks before it touches anything"])]
    : kind === "unconfigured"
      ? [h.span([h.Class("text-warn")], ["! sign-in isn’t wired up yet"])]
      : [h.span([h.Class("text-danger"), h.Role("alert")], ["! couldn’t reach puterminator"])];

const signInAction = (h: H, kind: SignIn) =>
  kind === "ready"
    ? h.a([h.Href("/auth/login"), h.Class("btn btn-primary justify-self-start")], ["continue with put.io ↗"])
    : kind === "unconfigured"
      ? h.button([h.Type("button"), h.Disabled(true), h.Class("btn justify-self-start")], ["continue with put.io"])
      : h.button([h.Type("button"), h.Class("btn justify-self-start"), h.OnClick(Message.ClickedRetryMe())], ["try again"]);

/** No box: the mascot, the wordmark, a few lines of terminal output, one button. */
const signInView = (h: H, kind: SignIn) =>
  h.div(
    [h.Class("grid min-h-dvh place-items-center bg-bg p-6 text-fg")],
    [
      h.div(
        [h.Class("enter grid w-full max-w-[400px] gap-6")],
        [
          art(h, kind === "ready" ? "asleep" : "unplugged", 56),
          h.h1([h.Class("m-0 font-display text-[28px] leading-none font-medium text-accent")], ["puterminator"]),
          h.div([h.Class("grid gap-0.5 rounded-xl border border-line bg-sunk px-4 py-3 font-mono text-[12.5px] leading-[1.7]")], [
            h.span([h.Class("text-fg-2")], ["$ puterminator login"]),
            ...signInOutput(h, kind),
          ]),
          signInAction(h, kind),
          h.p([h.Class("m-0 text-[13px] text-fg-4")], [
            "it reads your file list and asks Claude about it. ",
            h.a([h.Href("/privacy"), h.Class("text-fg-3 underline decoration-fg-4 underline-offset-2 hover:text-fg")], ["privacy and disclaimer"]),
          ]),
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
  h.div([h.Class("step-head")], [slot(h, h.span([h.Class("cursor"), h.AriaHidden(true)], [])), h.span([h.Class("text-fg")], [text]), ...detailSpan(h, detail)]);

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

/** Finished work folds into one quiet line; the steps open on tap. */
const doneLog = (h: H, model: Model, key: string, summary: string, rows: Html[]) => {
  const k = `log.${key}`;
  const open = model.expanded.includes(k);
  return h.keyed("div")(k, [h.Class("grid min-w-0")], [
    h.button(
      [h.Type("button"), h.Class("step-head hit"), h.AriaExpanded(open), h.OnClick(Message.ToggledStep({ key: k }))],
      [slot(h, chev(h)), h.span([h.Class("name min-w-0 truncate")], [summary])],
    ),
    ...(open ? [h.div([h.Class("ms-1 grid min-w-0 border-s border-line ps-3")], rows)] : []),
  ]);
};

// ---------- score card ----------

// ---------- thread ----------

const lazyMarkdown = createKeyedLazy();

/** Text stays prose; consecutive steps share one run log; a scan's score card closes its log. */
const agentBody = (h: H, turn: Turn, model: Model, caretKey: string | null, live: boolean, settled: boolean): Html[] => {
  const out: Html[] = [];
  let rows: Html[] = [];
  let logKey = "";
  let running = false;
  let calls: string[] = [];
  let detail: string | null = null;
  let failed = 0;
  const flush = () => {
    if (rows.length > 0) {
      // Reads like the shell line that ran: the tools, then what the last one found.
      const summary = `$ ${calls.length > 0 ? calls.join(" && ") : "think"}${failed > 0 ? "  # didn’t finish" : detail ? `  # ${detail}` : ""}`;
      out.push(running ? runLog(h, logKey, rows) : doneLog(h, model, logKey, summary, rows));
    }
    rows = [];
    running = false;
    calls = [];
    detail = null;
    failed = 0;
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
        running ||= item.streaming;
        rows.push(thinkingRow(h, item, model));
        break;
      case "tool": {
        if (rows.length === 0) logKey = item.key;
        running ||= item.state === "running";
        calls.push(item.name);
        detail = describeStep(item.name, item.input, item.output).detail;
        if (item.state === "error") failed++;
        rows.push(toolRow(h, item, model));
        const card = item.state === "done" ? toolCard(h, model, item, live, settled) : null;
        if (card) {
          flush();
          out.push(h.keyed("div")(`card.${item.key}`, [], [card]));
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

/** The agent's words sit in the column, no mark, no box; the user's bubble is what tells the voices apart. */
const agentView = (h: H, turn: Turn, model: Model, caretKey: string | null, live: boolean, settled = false) =>
  h.keyed("article")(
    turn.key,
    [h.Class("grid min-w-0 gap-3"), h.DataAttribute("role", "assistant"), h.AriaLabel("puterminator")],
    agentBody(h, turn, model, caretKey, live, settled),
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

/** The starters as a terminal listing: `$ prompt` and a `# what it does` comment, one per line. */
const starterRows = (h: H, enabled: boolean) =>
  h.div(
    [h.Class("grid overflow-hidden rounded-xl border border-line bg-sunk py-2 font-mono text-[12.5px] leading-[1.7]")],
    STARTERS.map(([prompt, does]) =>
      h.button(
        [
          h.Type("button"),
          h.Disabled(!enabled),
          h.Class("group grid grid-cols-[1.5ch_minmax(0,auto)_minmax(0,1fr)] items-baseline gap-x-2 px-4 py-0.5 text-start transition-colors duration-160 hover:bg-hover disabled:opacity-40"),
          h.OnClick(Message.ClickedStarter({ text: prompt })),
        ],
        [
          h.span([h.Class("text-fg-4 group-hover:text-accent"), h.AriaHidden(true)], ["$"]),
          h.span([h.Class("truncate text-fg group-hover:text-fg-strong")], [prompt]),
          h.span([h.Class("truncate ps-3 text-fg-4 max-[520px]:hidden")], [`# ${does}`]),
        ],
      ),
    ),
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

const composer = (h: H, model: Model, placeholder: string) => {
  const busy = isBusy(model);
  const connected = model.connection._tag === "Connected";
  const canSend = connected && !model.sending && model.draft.trim().length > 0;
  const tooLong = model.error === LENGTH_ERROR;
  const errorId = `${COMPOSER_ID}-error`;
  const credits = model.agent ? creditsLeft(model.agent.credits) : null;
  return h.form(
    [
      h.Class(
        `pointer-events-auto grid w-full gap-2 rounded-2xl border bg-raised py-2.5 ps-4 pe-2.5 shadow-[0_8px_24px_rgb(0_0_0/0.25)] transition-colors duration-160 ${tooLong ? "border-danger/60!" : "border-line-strong hover:border-line-hover focus-within:border-line-hover!"}`,
      ),
      h.OnSubmit(Message.SubmittedDraft()),
    ],
    [
      h.label([h.For(COMPOSER_ID), h.Class("sr-only")], ["message puterminator"]),
      h.div(
        [h.Class("flex min-w-0 items-end gap-3")],
        [
          h.textarea([
            h.Id(COMPOSER_ID),
            h.Value(model.draft),
            h.Rows(1),
            h.Placeholder(placeholder),
            h.Autocomplete("off"),
            h.EnterKeyHint(COARSE ? "enter" : "send"),
            ...(tooLong ? [h.AriaInvalid(true), h.AriaDescribedBy(errorId)] : []),
            h.Class(
              "block max-h-[160px] min-h-[32px] w-full resize-none border-0 bg-transparent p-0 py-1 text-[16px] leading-normal text-fg-strong caret-accent outline-none [field-sizing:content] placeholder:text-fg-3 focus-visible:outline-none pointer-fine:text-[15px]",
            ),
            h.OnInput((value) => Message.UpdatedDraft({ value })),
            h.OnKeyDownPreventDefault((key, mods) => (key === "Enter" && !COARSE && !mods.shiftKey && !mods.altKey ? Option.some(Message.SubmittedDraft()) : Option.none())),
          ]),
          ...(credits !== null && credits < LOW_CREDITS
            ? [h.span([h.Class("flex-none pb-1.5 text-[13px] text-fg-3 tabular-nums"), h.Title("credits left this month")], [`${fmt(credits)} credits left`])]
            : []),
          // Keyed so send and stop are separate elements: focus and a second click never carry over.
          busy
            ? h.keyed("button")(
                "stop",
                [
                  h.Type("button"),
                  h.Disabled(model.stopping),
                  h.AriaLabel(model.stopping ? "stopping reply" : "stop reply"),
                  h.Title("stop"),
                  h.Class("hit btn btn-icon flex-none"),
                  h.OnClick(Message.ClickedStop()),
                ],
                [h.span([h.Class("block size-2.5 rounded-[2px] bg-fg"), h.AriaHidden(true)], [])],
              )
            : h.keyed("button")(
                "send",
                [
                  h.Type("submit"),
                  h.Disabled(!canSend),
                  h.AriaLabel("send"),
                  h.Title("send"),
                  h.Class("hit btn btn-icon btn-primary flex-none text-[16px] disabled:opacity-30"),
                ],
                [h.span([h.AriaHidden(true)], ["↑"])],
              ),
        ],
      ),
      ...(tooLong
        ? [h.p([h.Id(errorId), h.Class("m-0 flex items-center gap-2 text-[13px] text-fg-2"), h.Role("alert")], [dot(h, "error"), LENGTH_ERROR])]
        : []),
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
        [h.Class(`${COLUMN} enter gap-8 pt-[16svh] pb-16`)],
        [
          // First run: the agent says who it is and what it does, then offers the commands to start with.
          h.div(
            [h.Class("grid justify-items-start gap-4")],
            [
              art(h, "idle", 56),
              h.h1([h.Class("m-0 font-display text-[36px] leading-[1.1] font-medium text-fg-strong")], [model.agent?.username ? `hi ${model.agent.username}.` : "hi."]),
              h.p([h.Class("m-0 max-w-[52ch] text-[15px] text-fg-2")], [
                "i’m puterminator. i read your put.io library, score the mess and tell you what to fix. ask me anything about your files, or start with one of these:",
              ]),
            ],
          ),
          h.div([h.Class("grid gap-3")], [starterRows(h, enabled), composer(h, model, "or ask puterminator…")]),
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
  // A sent message has no agent turn yet; show who is on it.
  const pending = busy && last?.role === "user";

  return shell(h, model, [
    h.div(
      [h.Id(THREAD_ID), h.Class("flex-1 overflow-y-auto overscroll-contain [scroll-padding-bottom:56px]")],
      [
        h.div(
          [h.Class(`${COLUMN} gap-9 pt-10 pb-14`)],
          [
            ...turns.map((t, i) =>
              t.role === "user"
                ? userView(h, t, busy && (t === last || t === turns.at(-2)))
                : agentView(h, t, model, caretKey, busy && t === last, turns.slice(i + 1).some((u) => u.role === "user")),
            ),
            ...(pending ? [agentView(h, { key: "pending", role: "assistant", items: [] }, model, null, true)] : []),
            ...statusRows(h, model),
          ],
        ),
      ],
    ),
    // A flex row, not an overlay: the scroller shrinks as the draft grows. -mt-10 lets the fade overlap it.
    h.div(
      [h.Class("pointer-events-none relative -mt-10 flex-none bg-linear-to-b from-transparent to-bg to-35% pt-10 pb-[max(16px,env(safe-area-inset-bottom))]")],
      [h.div([h.Class(COLUMN)], [composer(h, model, "reply…")])],
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
