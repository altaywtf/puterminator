import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import { createKeyedLazy, type Document, type Html, type HtmlBuilder } from "foldkit/html";
import { blockedText, type Credits, creditsLeft, creditsTotal, feedbackText, shortDate, unlimitedCredits } from "../shared/contract";
import { type Item, type Turn, toTurns } from "../shared/thread";
import { art, type IconName, icon } from "./art";
import logoUrl from "./logo.svg?inline";
import { COMPOSER_ID, DELETE_CANCEL_ID, FEEDBACK_CLOSE_ID, FEEDBACK_TEXT_ID, isBusy, isLocked, LENGTH_ERROR, Message, type Model, Session, THREAD_ID } from "./main";
import { toolCard } from "./cards";
import { playerView, treeDrawer } from "./files";
import { landingView } from "./landing";
import { renderMarkdown } from "./markdown";
import { callLine, describeStep, fmt } from "./steps";
import { thoughtSeconds } from "./thinking";

type H = HtmlBuilder<Message>;

type ToolItem = Extract<Item, { kind: "tool" }>;

type ThinkingItem = Extract<Item, { kind: "thinking" }>;

const STARTERS: Array<[prompt: string, does: string]> = [
  ["what can you do?", "a short tour, then a first step"],
  ["audit my library", "score naming, junk, duplicates"],
  ["what’s eating my space?", "the biggest files, doubles, things nobody played"],
  ["clean up my downloads", "junk, release names and wrapper folders as one diff"],
  ["download links for my biggest files", "direct links to paste anywhere"],
];

const LOW_CREDITS = 30;

const FAILURES_BEFORE_NOTICE = 2;

const COLUMN = "mx-auto grid w-full max-w-[calc(46rem+40px)] px-5 max-[480px]:px-4";

const ENTER_INSERTS_NEWLINE = typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches;

const isConnected = Predicate.isTagged("Connected");

const isLost = Predicate.isTagged("Lost");

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

const dot = (h: H, tone: "warn" | "error" | null = null) =>
  h.span([h.Class(`dot ${tone ? `dot-${tone}` : ""}`), h.AriaHidden(true)], []);

const status = (h: H, model: Model) =>
  isConnected(model.connection)
    ? []
    : [
        h.span([h.Class("flex items-center gap-2 text-meta text-fg-3")], [
          dot(h, isLost(model.connection) ? "warn" : null),
          isLost(model.connection) ? "reconnecting" : "connecting",
        ]),
      ];

const frame = (h: H, topbarEnd: Html[], children: Html[], inert: boolean) =>
  h.div(
    [h.Class("grid h-dvh grid-rows-[auto_minmax(0,1fr)] bg-bg text-fg"), ...(inert ? [h.Inert(true)] : [])],
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

const liveStatus = (h: H, model: Model) =>
  h.div(
    [h.Class("sr-only"), h.Role("status"), h.AriaLive("polite")],
    [
      isLost(model.connection)
        ? "connection lost. reconnecting."
        : isBusy(model)
          ? "puterminator is working."
          : model.history.length > 0
            ? "reply ready."
            : "",
    ],
  );

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

const MENU_ROW = "flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-start text-[13px] no-underline transition-colors duration-160";
const MENU_ACTION = `${MENU_ROW} text-fg-2 hover:bg-hover hover:text-fg focus-visible:bg-hover focus-visible:text-fg`;

const menuItem = (h: H, name: IconName, text: string, message: Message, cls = MENU_ACTION) =>
  h.button(
    [h.Type("button"), h.Popovertarget(ACCOUNT_MENU_ID), h.Popovertargetaction("hide"), h.Class(cls), h.OnClick(message)],
    [icon(h, name), text],
  );

const menuRule = (h: H) => h.hr([h.Class("-mx-1 my-1 border-0 border-t border-line")]);

const nextMonthDay = (month: string) => {
  const [y, m] = month.split("-").map(Number);

  return new Date(Date.UTC(y ?? 1970, m ?? 1, 1)).toISOString().slice(0, 10);
};

const creditsMeter = (h: H, credits: Credits) => {
  const note = h.p([h.Class(`m-0 text-meta ${credits.blocked ? "text-fg-2" : "text-fg-4"}`)], [credits.blocked ? blockedText(credits.blocked) : `refills ${shortDate(nextMonthDay(credits.month))}`]);

  if (unlimitedCredits(credits)) return [h.div([h.Class("grid gap-1.5 px-2.5 py-1.5")], [h.p([h.Class("m-0 text-[13px] text-fg-2")], ["unlimited credits"]), ...(credits.blocked ? [note] : [])])];

  const total = creditsTotal(credits);
  const left = creditsLeft(credits);
  const share = total > 0 ? Math.round((left / total) * 100) : 0;

  return [
    h.div(
      [h.Class("grid gap-1.5 px-2.5 py-1.5")],
      [
        h.p([h.Class("m-0 flex items-baseline justify-between gap-2 text-[13px] text-fg-2 tabular-nums")], [h.span([], [`${fmt(left)} credits left`]), h.span([h.Class("text-meta text-fg-4")], [`of ${fmt(total)}`])]),
        h.div(
          [h.Role("meter"), h.AriaLabel("credits left this month"), h.AriaValuenow(left), h.AriaValuemin(0), h.AriaValuemax(total), h.Class("h-1 overflow-hidden rounded-full bg-hover")],
          [h.div([h.Class(`h-full rounded-full ${left < LOW_CREDITS || credits.blocked ? "bg-danger" : "bg-accent"}`), h.Style({ width: `${share}%` })], [])],
        ),
        note,
      ],
    ),
  ];
};

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
      h.p([h.Class("m-0 truncate px-2.5 pt-1.5 pb-1 text-meta text-fg-4")], [`signed in as ${username}`]),
      ...(model.agent ? creditsMeter(h, model.agent.credits) : []),
      menuRule(h),
      ...(model.history.length > 0 && !isBusy(model) ? [menuItem(h, "plus", "new thread", Message.ClickedNewThread())] : []),
      ...(model.library ? [menuItem(h, "folder", "browse library", Message.ToggledTree())] : []),
      menuItem(h, "mail", "send feedback", Message.ClickedFeedback({ kind: "bug", text: "" })),
      h.a([h.Href("/privacy"), h.Class(MENU_ACTION)], [icon(h, "lock"), "privacy"]),
      menuItem(h, "trash", "forget me", Message.ClickedDeleteData()),
      menuRule(h),
      menuItem(h, "exit", "sign out", Message.ClickedSignOut()),
    ],
  ),
];

const deleteDialog = (h: H, model: Model) =>
  model.confirmingDelete
    ? [
        h.div(
          [
            h.Class("fixed inset-0 z-40 grid place-items-center bg-black/70 p-4"),
            h.Role("alertdialog"),
            h.AriaModal(true),
            h.AriaLabelledBy("delete-title"),
            h.AriaDescribedBy("delete-body"),
            h.OnKeyDownPreventDefault((key) => (key === "Escape" ? Option.some(Message.CancelledDelete()) : Option.none())),
          ],
          [
            h.button([h.Type("button"), h.Tabindex(-1), h.AriaLabel("cancel"), h.Class("absolute inset-0 cursor-default"), h.OnClick(Message.CancelledDelete())], []),
            h.div(
              [h.Class("pop relative grid w-full max-w-[400px] gap-3 rounded-xl border border-line-strong bg-raised p-5 shadow-[0_12px_32px_rgb(0_0_0/0.45)]")],
              [
                h.h2([h.Id("delete-title"), h.Class("m-0 text-[15px] font-medium text-fg-strong")], ["make puterminator forget you?"]),
                h.p([h.Id("delete-body"), h.Class("m-0 text-[13px] leading-[1.6] text-fg-2")], [
                  "your chats, plans, library snapshot and put.io sign-in go for good, and every session signs out. your put.io files stay as they are.",
                ]),
                h.div([h.Class("mt-2 flex justify-end gap-2")], [
                  h.button([h.Type("button"), h.Id(DELETE_CANCEL_ID), h.Class("btn btn-sm border-transparent text-fg-2"), h.OnClick(Message.CancelledDelete())], ["cancel"]),
                  h.button([h.Type("button"), h.Class("btn btn-sm border-danger/40 bg-danger/10 text-danger"), h.OnClick(Message.ConfirmedDelete())], ["forget me"]),
                ]),
              ],
            ),
          ],
        ),
      ]
    : [];

const FEEDBACK_KINDS = [
  ["bug", "something broke"],
  ["idea", "an idea"],
] as const;

const feedbackDialog = (h: H, model: Model) => {
  const f = model.feedback;

  if (!f) return [];
  const sending = f.status === "sending";

  const body =
    f.status === "sent"
      ? [
          h.h2([h.Id("feedback-title"), h.Class("m-0 text-[15px] font-medium text-fg-strong")], ["thanks. it’s on its way."]),
          h.p([h.Class("m-0 text-[13px] leading-[1.6] text-fg-2")], ["it went to the maintainer’s inbox with your put.io username."]),
          h.div([h.Class("mt-2 flex justify-end")], [
            h.button([h.Type("button"), h.Id(FEEDBACK_CLOSE_ID), h.Class("btn btn-sm"), h.OnClick(Message.ClosedFeedback())], ["close"]),
          ]),
        ]
      : [
          h.h2([h.Id("feedback-title"), h.Class("m-0 text-[15px] font-medium text-fg-strong")], ["send feedback"]),
          h.div(
            [h.Role("radiogroup"), h.AriaLabel("kind"), h.Class("flex gap-2")],
            FEEDBACK_KINDS.map(([kind, label]) =>
              h.button(
                [
                  h.Type("button"),
                  h.Role("radio"),
                  h.AriaChecked(f.kind === kind),
                  h.Disabled(sending),
                  h.Class(f.kind === kind ? "btn btn-sm border-accent/50 bg-accent/10 text-accent" : "btn btn-sm border-line-strong text-fg-2"),
                  h.OnClick(Message.ChoseFeedbackKind({ kind })),
                ],
                [label],
              ),
            ),
          ),
          h.label([h.For(FEEDBACK_TEXT_ID), h.Class("sr-only")], ["your feedback"]),
          h.textarea([
            h.Id(FEEDBACK_TEXT_ID),
            h.Value(f.text),
            h.Rows(5),
            h.Disabled(sending),
            h.Placeholder(f.kind === "bug" ? "what happened, and what did you expect?" : "what should puterminator do?"),
            h.Class(
              "block min-h-[120px] w-full resize-y rounded-lg border border-line-strong bg-bg p-3 text-[16px] leading-normal text-fg-strong caret-accent outline-none placeholder:text-fg-3 focus-visible:border-accent/60 pointer-fine:text-[14px]",
            ),
            h.OnInput((text) => Message.UpdatedFeedback({ text })),
          ]),
          h.p([h.Class("m-0 text-meta leading-[1.6] text-fg-3")], ["it goes to the maintainer with your put.io username. add an email if you want a reply."]),
          ...(f.error ? [h.p([h.Role("alert"), h.Class("m-0 text-[13px] text-danger")], [f.error])] : []),
          h.div([h.Class("mt-1 flex justify-end gap-2")], [
            h.button([h.Type("button"), h.Class("btn btn-sm border-transparent text-fg-2"), h.OnClick(Message.ClosedFeedback())], ["cancel"]),
            h.button(
              [h.Type("button"), h.Disabled(sending || feedbackText(f.text) === null), h.Class("btn btn-sm btn-primary"), h.OnClick(Message.SubmittedFeedback())],
              [sending ? "sending…" : "send"],
            ),
          ]),
        ];

  return [
    h.div(
      [
        h.Class("fixed inset-0 z-40 grid place-items-center bg-black/70 p-4"),
        h.Role("dialog"),
        h.AriaModal(true),
        h.AriaLabelledBy("feedback-title"),
        h.OnKeyDownPreventDefault((key) => (key === "Escape" ? Option.some(Message.ClosedFeedback()) : Option.none())),
      ],
      [
        h.button([h.Type("button"), h.Tabindex(-1), h.AriaLabel("close"), h.Class("absolute inset-0 cursor-default"), h.OnClick(Message.ClosedFeedback())], []),
        h.div([h.Class("pop relative grid w-full max-w-[440px] gap-3 rounded-xl border border-line-strong bg-raised p-5 shadow-[0_12px_32px_rgb(0_0_0/0.45)]")], body),
      ],
    ),
  ];
};

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
      model.player !== null || model.confirmingDelete || model.feedback !== null,
    ),
    ...playerView(h, model),
    ...deleteDialog(h, model),
    ...feedbackDialog(h, model),
  ]);

const loadingView = (h: H) => h.div([h.Class("h-dvh bg-bg"), h.AriaBusy(true)], [h.span([h.Class("sr-only"), h.Role("status")], ["loading"])]);

type SignIn = "unconfigured" | "failed";

const signInOutput = (h: H, kind: SignIn): Html[] =>
  Match.value(kind).pipe(
    Match.when("unconfigured", () => [h.span([h.Class("text-warn")], ["! sign-in isn’t wired up yet"])]),
    Match.when("failed", () => [h.span([h.Class("text-danger"), h.Role("alert")], ["! couldn’t reach puterminator"])]),
    Match.exhaustive,
  );

const signInAction = (h: H, kind: SignIn) =>
  Match.value(kind).pipe(
    Match.when("unconfigured", () => h.button([h.Type("button"), h.Disabled(true), h.Class("btn justify-self-start")], ["continue with put.io"])),
    Match.when("failed", () => h.button([h.Type("button"), h.Class("btn justify-self-start"), h.OnClick(Message.ClickedRetryMe())], ["try again"])),
    Match.exhaustive,
  );

const signInView = (h: H, kind: SignIn) =>
  h.div(
    [h.Class("grid min-h-dvh place-items-center bg-bg p-6 text-fg")],
    [
      h.div(
        [h.Class("enter grid w-full max-w-[400px] gap-6")],
        [
          art(h, "unplugged", 56),
          h.h1([h.Class("m-0 font-display text-[28px] leading-none font-medium text-accent")], ["puterminator"]),
          h.div([h.Class("grid gap-0.5 rounded-xl border border-line bg-sunk px-4 py-3 font-mono text-mono leading-[1.7]")], [
            h.span([h.Class("text-fg-2")], ["$ puterminator login"]),
            ...signInOutput(h, kind),
          ]),
          signInAction(h, kind),
          h.p([h.Class("m-0 text-meta text-fg-4")], [
            "it reads your file list and asks Claude about it. ",
            h.a([h.Href("/privacy"), h.Class("text-fg-3 underline decoration-fg-4 underline-offset-2 hover:text-fg")], ["privacy and disclaimer"]),
          ]),
        ],
      ),
    ],
  );

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

const waited = (model: Model) => {
  if (!model.wait) return null;
  const s = Math.max(0, Math.floor((model.wait.now - model.wait.since) / 1000));

  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
};

const lastLine = (text: string) =>
  text
    .split("\n")
    .map((l) => l.replace(/\*\*|^#+\s*/g, "").trim())
    .findLast((l) => l.length > 0) ?? null;

const thinkingRow = (h: H, item: ThinkingItem, model: Model) => {
  const bodyId = `step-${item.key}`;
  const open = model.expanded.includes(item.key);

  if (item.streaming) {
    const line = lastLine(item.text);

    return h.keyed("div")(item.key, [h.Class("grid min-w-0 enter-soft")], [
      liveRow(h, "thinking", waited(model)),
      ...(line ? [stepBody(h, bodyId, [h.div([h.Class("min-w-0 truncate text-[12px]")], [line])])] : []),
    ]);
  }

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

const lazyMarkdown = createKeyedLazy();

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

  return out.length > 0 ? out : [runLog(h, `${turn.key}.wait`, [liveRow(h, "thinking", waited(model))])];
};

const agentView = (h: H, turn: Turn, model: Model, caretKey: string | null, live: boolean, settled = false) =>
  h.keyed("article")(
    turn.key,
    [h.Class("grid min-w-0 gap-3"), h.DataAttribute("role", "assistant"), h.AriaLabel("puterminator")],
    agentBody(h, turn, model, caretKey, live, settled),
  );

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

const starterRows = (h: H, enabled: boolean) =>
  h.div(
    [h.Class("grid overflow-hidden rounded-xl border border-line bg-sunk py-2 font-mono text-mono leading-[1.7]")],
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

const connectionNotice = (h: H, model: Model) =>
  model.attempts < FAILURES_BEFORE_NOTICE
    ? []
    : [
        h.div(
          [h.Class("notice"), h.Role("status")],
          [
            dot(h, "warn"),
            h.span([h.Class("grow")], ["can’t reach the agent. retrying…"]),
            ...(isLost(model.connection)
              ? [h.button([h.Type("button"), h.Class("hit btn btn-sm"), h.OnClick(Message.RetriedConnect({ attempts: model.attempts }))], ["retry now"])]
              : []),
          ],
        ),
      ];

const statusRows = (h: H, model: Model) => [
  ...connectionNotice(h, model),
  ...(model.error === null || model.error === LENGTH_ERROR
    ? []
    : [h.div([h.Class("notice"), h.Role("alert")], [dot(h, "error"), h.span([], [model.error])])]),
];

const composer = (h: H, model: Model, placeholder: string) => {
  const busy = isBusy(model);
  const connected = isConnected(model.connection);
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
            h.EnterKeyHint(ENTER_INSERTS_NEWLINE ? "enter" : "send"),
            ...(tooLong ? [h.AriaInvalid(true), h.AriaDescribedBy(errorId)] : []),
            h.Class(
              "block max-h-[160px] min-h-[32px] w-full resize-none border-0 bg-transparent p-0 py-1 text-[16px] leading-normal text-fg-strong caret-accent outline-none [field-sizing:content] placeholder:text-fg-3 focus-visible:outline-none pointer-fine:text-[15px]",
            ),
            h.OnInput((value) => Message.UpdatedDraft({ value })),
            h.OnKeyDownPreventDefault((key, mods) => (key === "Enter" && !ENTER_INSERTS_NEWLINE && !mods.shiftKey && !mods.altKey ? Option.some(Message.SubmittedDraft()) : Option.none())),
          ]),
          ...(credits !== null && credits < LOW_CREDITS
            ? [h.span([h.Class("flex-none pb-1.5 text-meta text-fg-3 tabular-nums"), h.Title("credits left this month")], [`${fmt(credits)} credits left`])]
            : []),
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
        ? [h.p([h.Id(errorId), h.Class("m-0 flex items-center gap-2 text-meta text-fg-2"), h.Role("alert")], [dot(h, "error"), LENGTH_ERROR])]
        : []),
    ],
  );
};

const emptyThread = (h: H, model: Model) => {
  const enabled = isConnected(model.connection) && !isLocked(model);

  return h.div(
    [h.Id(THREAD_ID), h.Class("flex-1 overflow-y-auto overscroll-contain")],
    [
      h.div(
        [h.Class(`${COLUMN} enter gap-8 pt-[16svh] pb-16`)],
        [
          h.div(
            [h.Class("grid justify-items-start gap-4")],
            [
              art(h, "idle", 56),
              h.h1([h.Class("m-0 font-display text-[36px] leading-[1.1] font-medium text-fg-strong")], [model.agent?.username ? `hi ${model.agent.username}.` : "hi."]),
              h.p([h.Class("m-0 max-w-[52ch] text-fg-2")], [
                "i’m puterminator. i read your put.io library, find junk and doubles, rename and sort files, play them and make download links. start here, or ask anything:",
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
    SignedOut: ({ configured }) => (configured ? landingView(h, model) : signInView(h, "unconfigured")),
    Failed: () => signInView(h, "failed"),
    SignedIn: () => threadPage(h, model),
  }),
});
