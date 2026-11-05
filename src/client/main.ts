import { Duration, Effect, Exit, Match, Option, Queue, Schema, Stream } from "effect";
import { Command, ManagedResource, Render, type Runtime, Subscription, type Update } from "foldkit";
import { defineMessageUnion } from "foldkit/message";
import { defineTaggedUnion } from "foldkit/schema";
import { modifyFields } from "foldkit/struct";
import {
  AgentState,
  ClientEvent,
  ClientFrame,
  ContentBlock,
  Feedback,
  feedbackText,
  Folder,
  Library,
  Me,
  MessageParam,
  ROOT_FOLDER,
  ServerFrame,
  type ServerEvent,
} from "../shared/contract";
import { PlanRecord } from "../shared/actions";
import { DownloadLinksResponse } from "../shared/tools";
import { emptyClock, onMessage, onPartial, ThinkingClock } from "./thinking";

const CONNECT_TIMEOUT = Duration.seconds(8);
const MAX_PROMPT = 4000;
export const COMPOSER_ID = "composer";
export const THREAD_ID = "thread";
export const LENGTH_ERROR = `keep it under ${MAX_PROMPT.toLocaleString("en-US")} characters.`;
const NOT_CONNECTED = "not connected. try again in a moment.";

export const Session = defineTaggedUnion({
  Loading: {},
  SignedOut: { configured: Schema.Boolean },
  SignedIn: {},
  Failed: {},
});

export type Session = typeof Session.Type;

const Connection = defineTaggedUnion({
  Idle: {},
  Connecting: {},
  Connected: {},
  Lost: {},
});

type Connection = typeof Connection.Type;

export const Model = Schema.Struct({
  session: Session,
  connection: Connection,
  attempts: Schema.Int,
  agent: Schema.NullOr(AgentState),
  history: Schema.Array(MessageParam),
  synced: Schema.Boolean,
  partial: Schema.NullOr(Schema.Array(ContentBlock)),
  error: Schema.NullOr(Schema.String),
  sending: Schema.Boolean,
  stopping: Schema.Boolean,
  stopArmed: Schema.Boolean,
  draft: Schema.String,
  expanded: Schema.Array(Schema.String),
  clock: ThinkingClock,
  wait: Schema.NullOr(Schema.Struct({ since: Schema.Finite, now: Schema.Finite })),
  library: Schema.NullOr(Library),
  plans: Schema.Record(Schema.String, PlanRecord),
  treeOpen: Schema.Boolean,
  treeExpanded: Schema.Array(Schema.Finite),
  treeFocus: Schema.NullOr(Schema.Finite),
  avatarFailed: Schema.Boolean,
  confirmingDelete: Schema.Boolean,
  feedback: Schema.NullOr(
    Schema.Struct({
      kind: Feedback.fields.kind,
      text: Schema.String,
      status: Schema.Literals(["editing", "sending", "sent"]),
      error: Schema.NullOr(Schema.String),
    }),
  ),
  player: Schema.NullOr(
    Schema.Struct({ id: Schema.Finite, name: Schema.String, src: Schema.NullOr(Schema.String), failed: Schema.Boolean }),
  ),
  links: Schema.Record(
    Schema.String,
    Schema.Union([
      Schema.Struct({ state: Schema.Literal("loading") }),
      Schema.Struct({ state: Schema.Literal("done"), links: Schema.Array(Schema.String) }),
      Schema.Struct({ state: Schema.Literal("failed"), message: Schema.String }),
    ]),
  ),
});

export type Model = typeof Model.Type;

const targetFolder = (model: Model): Folder => model.agent?.folder ?? ROOT_FOLDER;
export const isBusy = (model: Model) => model.agent?.busy === true;

/** Busy, or a send the server has not answered yet. */
export const isLocked = (model: Model) => model.sending || isBusy(model);

export const Message = defineMessageUnion({
  GotMe: { me: Me },
  FailedMe: {},
  ClickedRetryMe: {},
  KeptSession: {},
  ConnectedSocket: {},
  ReleasedSocket: {},
  FailedSocket: {},
  ClosedSocket: {},
  RetriedConnect: { attempts: Schema.Int },
  ReceivedState: { state: AgentState },
  ReceivedHistory: { messages: Schema.Array(MessageParam) },
  ReceivedMessage: { message: MessageParam, at: Schema.Finite },
  ReceivedPartial: { content: Schema.NullOr(Schema.Array(ContentBlock)), at: Schema.Finite },
  Ticked: { at: Schema.Finite },
  ReceivedError: { message: Schema.String },
  ReceivedLibrary: { library: Library },
  ReceivedPlan: { record: PlanRecord },
  ClickedApply: { plan: Schema.String, exclude: Schema.Array(Schema.String) },
  ClickedDiscard: { plan: Schema.String },
  ClickedStopRun: { plan: Schema.String },
  ClickedRetryRun: { plan: Schema.String },
  ClickedUndoRun: { plan: Schema.String },
  ClickedNewThread: {},
  ToggledTree: {},
  ClosedTree: {},
  ToggledTreeNode: { id: Schema.Finite },
  RevealedFile: { id: Schema.Finite },
  OpenedPlayer: { id: Schema.Finite, name: Schema.String },
  GotStream: { id: Schema.Finite, src: Schema.String },
  FailedStream: { id: Schema.Finite },
  ClosedPlayer: {},
  ClickedLinks: { id: Schema.Finite },
  GotLinks: { id: Schema.Finite, links: Schema.Array(Schema.String) },
  FailedLinks: { id: Schema.Finite, message: Schema.String },
  ClickedCopyLinks: { id: Schema.Finite },
  FailedAvatar: {},
  UpdatedDraft: { value: Schema.String },
  SubmittedDraft: {},
  ClickedStarter: { text: Schema.String },
  ClickedStop: {},
  ArmedStop: {},
  SentFrame: {},
  FailedFrame: { error: Schema.String, unsent: Schema.optionalKey(Schema.String) },
  ToggledStep: { key: Schema.String },
  ClickedSignOut: {},
  ClickedDeleteData: {},
  CancelledDelete: {},
  ConfirmedDelete: {},
  ClickedFeedback: { kind: Feedback.fields.kind, text: Schema.String },
  ChoseFeedbackKind: { kind: Feedback.fields.kind },
  UpdatedFeedback: { text: Schema.String },
  SubmittedFeedback: {},
  SentFeedback: {},
  FailedFeedback: { error: Schema.String },
  ClosedFeedback: {},
  CompletedEffect: {},
});

export type Message = typeof Message.Type;

const AgentSocket = ManagedResource.tag<WebSocket>()("AgentSocket");

type AgentSocketService = ManagedResource.ServiceOf<typeof AgentSocket>;

const agentUrl = () => `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/agent`;

export const managedResources = ManagedResource.make<Model, Message>()((entry) => ({
  agentSocket: entry(Schema.Option(Schema.Null), {
    resource: AgentSocket,
    modelToMaybeRequirements: (model) =>
      Connection.match(model.connection, {
        Idle: () => Option.none(),
        Connecting: () => Option.some(null),
        Connected: () => Option.some(null),
        Lost: () => Option.none(),
      }),
    acquire: () =>
      Effect.callback<WebSocket, Error>((resume) => {
        const socket = new WebSocket(agentUrl());
        const onOpen = () => resume(Effect.succeed(socket));
        const onError = () => resume(Effect.fail(new Error("Could not reach the agent")));
        socket.addEventListener("open", onOpen, { once: true });
        socket.addEventListener("error", onError, { once: true });

        return Effect.sync(() => {
          socket.removeEventListener("open", onOpen);
          socket.removeEventListener("error", onError);
          socket.close();
        });
      }).pipe(
        Effect.timeoutOrElse({ duration: CONNECT_TIMEOUT, orElse: () => Effect.fail(new Error("Agent connection timed out")) }),
      ),
    release: (socket) => Effect.sync(() => socket.close()),
    onAcquired: () => Message.ConnectedSocket(),
    onReleased: () => Message.ReleasedSocket(),
    onAcquireError: () => Message.FailedSocket(),
  }),
}));

const decodeMe = Schema.decodeUnknownEffect(Me);

const getJson = (path: string) =>
  Effect.tryPromise(async () => {
    const response = await fetch(path, { headers: { accept: "application/json" } });

    if (!response.ok) throw new Error(`${path} returned ${response.status}`);

    const body: unknown = await response.json();

    return body;
  });

const FetchMe = Command.define("FetchMe", {
  messages: [Message.GotMe, Message.FailedMe],
  execute: getJson("/api/me").pipe(
    Effect.flatMap(decodeMe),
    Effect.map((me) => Message.GotMe({ me })),
    Effect.orElseSucceed(() => Message.FailedMe()),
  ),
});

const CheckMe = Command.define("CheckMe", {
  messages: [Message.GotMe, Message.KeptSession],
  execute: getJson("/api/me").pipe(
    Effect.flatMap(decodeMe),
    Effect.map((me) => (me.signedIn ? Message.KeptSession() : Message.GotMe({ me }))),
    Effect.orElseSucceed(() => Message.KeptSession()),
  ),
});

const encodeClientFrame = Schema.encodeSync(ClientFrame);

const SendFrame = Command.define("SendFrame", {
  args: { event: ClientEvent },
  messages: [Message.SentFrame, Message.FailedFrame],
  execute: ({ event }) =>
    AgentSocket.get.pipe(
      Effect.flatMap((socket) => Effect.try(() => socket.send(encodeClientFrame(event)))),
      Effect.as(Message.SentFrame()),
      Effect.orElseSucceed(() =>
        event.type === "send" ? Message.FailedFrame({ error: NOT_CONNECTED, unsent: event.text }) : Message.FailedFrame({ error: NOT_CONNECTED }),
      ),
    ),
});

const RetryConnect = Command.define("RetryConnect", {
  args: { attempts: Schema.Int },
  messages: [Message.RetriedConnect],
  execute: ({ attempts }) =>
    Effect.sleep(Duration.millis(Math.min(10_000, 1000 * 2 ** Math.max(0, attempts - 1)))).pipe(
      Effect.as(Message.RetriedConnect({ attempts })),
    ),
});

const SignOut = Command.define("SignOut", {
  messages: [Message.CompletedEffect],
  execute: Effect.tryPromise(() => fetch("/auth/logout", { method: "POST" })).pipe(
    Effect.ignore,
    Effect.flatMap(() => Effect.sync(() => location.reload())),
    Effect.as(Message.CompletedEffect()),
  ),
});

const DeleteData = Command.define("DeleteData", {
  messages: [Message.CompletedEffect, Message.FailedFrame],
  execute: Effect.gen(function* () {
    const res = yield* Effect.tryPromise(() => fetch("/auth/delete", { method: "POST" })).pipe(Effect.option);

    if (Option.isSome(res) && (res.value.ok || res.value.status === 401)) {
      yield* Effect.sync(() => location.reload());

      return Message.CompletedEffect();
    }

    return Message.FailedFrame({
      error: Option.isSome(res) && res.value.status === 409 ? "wait for the reply or plan run to finish, then try again" : "couldn’t forget you; try again",
    });
  }),
});

const SendFeedback = Command.define("SendFeedback", {
  args: { feedback: Feedback },
  messages: [Message.SentFeedback, Message.FailedFeedback],
  execute: ({ feedback }) =>
    Effect.tryPromise(() =>
      fetch("/api/feedback", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(feedback) }),
    ).pipe(
      Effect.option,
      Effect.map((res) =>
        Option.isSome(res) && res.value.ok
          ? Message.SentFeedback()
          : Message.FailedFeedback({
              error: Option.isSome(res) && res.value.status === 429 ? "that’s enough for today. try again tomorrow." : "couldn’t send it. try again.",
            }),
      ),
    ),
});

const ArmStop = Command.define("ArmStop", {
  messages: [Message.ArmedStop],
  execute: Effect.sleep(Duration.millis(300)).pipe(Effect.as(Message.ArmedStop())),
});

const finePointer = () => matchMedia("(pointer: fine)").matches;
const nothingFocused = () => document.activeElement === null || document.activeElement === document.body;

const FocusComposer = Command.define("FocusComposer", {
  args: { when: Schema.Literals(["always", "idle", "keep"]) },
  messages: [Message.CompletedEffect],
  execute: ({ when }) => {
    const composerFocusedBeforeCommit = document.activeElement?.id === COMPOSER_ID;

    const allowed = () =>
      Match.value(when).pipe(
        Match.when("always", () => true),
        Match.when("idle", () => finePointer() && nothingFocused()),
        Match.when("keep", () => finePointer() || composerFocusedBeforeCommit),
        Match.exhaustive,
      );

    return Effect.sync(allowed).pipe(
      Effect.flatMap((ok) =>
        Render.afterCommit.pipe(
          Effect.flatMap(() =>
            Effect.sync(() => {
              if (ok) document.getElementById(COMPOSER_ID)?.focus({ preventScroll: true });
            }),
          ),
        ),
      ),
      Effect.as(Message.CompletedEffect()),
    );
  },
});

export const treeNodeId = (id: number) => `tree-${id}`;
export const PLAYER_ID = "player";
export const PLAYER_CLOSE_ID = "player-close";
export const DELETE_CANCEL_ID = "delete-cancel";
export const FEEDBACK_TEXT_ID = "feedback-text";
export const FEEDBACK_CLOSE_ID = "feedback-close";

let lastFocus: Element | null = null;

if (typeof document !== "undefined")
  document.addEventListener("focusin", (e) => {
    if (e.target instanceof Element && !e.target.closest("[role=dialog]")) lastFocus = e.target;
  });

let beforeDialog: Element | null = null;

const FocusDialog = Command.define("FocusDialog", {
  args: { focus: Schema.NullOr(Schema.String) },
  messages: [Message.CompletedEffect],
  execute: ({ focus }) => {
    if (focus !== null) {
      const menu = lastFocus?.closest("[popover]");

      beforeDialog = menu ? document.querySelector(`[popovertarget="${menu.id}"]`) : lastFocus;
    }

    return Render.afterCommit.pipe(
      Effect.flatMap(() =>
        Effect.sync(() => {
          if (focus !== null) {
            document.getElementById(focus)?.focus({ preventScroll: true });
          } else {
            if (beforeDialog instanceof HTMLElement && beforeDialog.isConnected) beforeDialog.focus({ preventScroll: true });
            beforeDialog = null;
          }
        }),
      ),
      Effect.as(Message.CompletedEffect()),
    );
  },
});

const StreamResponse = Schema.Struct({ hls: Schema.String });

const FetchLinks = Command.define("FetchLinks", {
  args: { id: Schema.Finite },
  messages: [Message.GotLinks, Message.FailedLinks],
  execute: ({ id }) =>
    getJson(`/api/download-links/${id}`).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(DownloadLinksResponse)),
      Effect.map((r) =>
        r.status === "done"
          ? Message.GotLinks({ id, links: r.links })
          : Message.FailedLinks({ id, message: r.status === "pending" ? "put.io is still making them. try again in a moment." : r.message }),
      ),
      Effect.orElseSucceed(() => Message.FailedLinks({ id, message: "couldn’t get the links from put.io. try again." })),
    ),
});

const CopyText = Command.define("CopyText", {
  args: { text: Schema.String },
  messages: [Message.CompletedEffect],
  execute: ({ text }) =>
    Effect.tryPromise(() => navigator.clipboard.writeText(text)).pipe(
      Effect.ignore,
      Effect.as(Message.CompletedEffect()),
    ),
});

const FetchStream = Command.define("FetchStream", {
  args: { id: Schema.Finite },
  messages: [Message.GotStream, Message.FailedStream],
  execute: ({ id }) =>
    getJson(`/api/files/${id}/stream`).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(StreamResponse)),
      Effect.map(({ hls }) => Message.GotStream({ id, src: hls })),
      Effect.orElseSucceed(() => Message.FailedStream({ id })),
    ),
});

let hls: { destroy: () => void } | null = null;

const detach = () => {
  hls?.destroy();
  hls = null;
};

const AttachPlayer = Command.define("AttachPlayer", {
  args: { id: Schema.Finite, src: Schema.String },
  messages: [Message.CompletedEffect, Message.FailedStream],
  execute: ({ id, src }) =>
    Render.afterCommit.pipe(
      Effect.flatMap(() =>
        Effect.tryPromise(async () => {
          const video = document.getElementById(PLAYER_ID);

          if (!(video instanceof HTMLVideoElement)) return;
          detach();
          const hasMediaSource = "MediaSource" in window || "ManagedMediaSource" in window;
          const { default: Hls } = hasMediaSource ? await import("hls.js/light") : { default: null };

          if (Hls?.isSupported()) {
            const player = new Hls();
            hls = player;
            await new Promise<void>((resolve, reject) => {
              player.on(Hls.Events.MANIFEST_PARSED, () => resolve());
              player.on(Hls.Events.ERROR, (_event, data) => (data.fatal ? reject(new Error(data.details)) : undefined));
              player.loadSource(src);
              player.attachMedia(video);
            });
          } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
            await new Promise<void>((resolve, reject) => {
              video.addEventListener("loadedmetadata", () => resolve(), { once: true });
              video.addEventListener("error", () => reject(new Error("media error")), { once: true });
              video.src = src;
            });
          } else {
            throw new Error("no HLS support");
          }

          void video.play().catch(() => undefined);
        }),
      ),
      Effect.as(Message.CompletedEffect()),
      Effect.orElseSucceed(() => Message.FailedStream({ id })),
    ),
});

const DetachPlayer = Command.define("DetachPlayer", {
  messages: [Message.CompletedEffect],
  execute: Effect.sync(detach).pipe(Effect.as(Message.CompletedEffect())),
});

const ScrollTreeNode = Command.define("ScrollTreeNode", {
  args: { id: Schema.Finite },
  messages: [Message.CompletedEffect],
  execute: ({ id }) =>
    Render.afterCommit.pipe(
      Effect.flatMap(() =>
        Effect.sync(() => {
          const el = document.getElementById(treeNodeId(id));
          el?.scrollIntoView({ block: "center" });
          el?.focus({ preventScroll: true });
        }),
      ),
      Effect.as(Message.CompletedEffect()),
    ),
});

const STICK_TO_BOTTOM_PX = 160;
let previousScrollHeight = 0;

const ScrollThread = Command.define("ScrollThread", {
  args: { force: Schema.Boolean },
  messages: [Message.CompletedEffect],
  execute: ({ force }) =>
    Render.afterCommit.pipe(
      Effect.flatMap(() =>
        Effect.sync(() => {
          const el = document.getElementById(THREAD_ID);

          if (!el) return;

          if (force || previousScrollHeight - el.scrollTop - el.clientHeight < STICK_TO_BOTTOM_PX) el.scrollTop = el.scrollHeight;
          previousScrollHeight = el.scrollHeight;
        }),
      ),
      Effect.as(Message.CompletedEffect()),
    ),
});

type UpdateReturn = Update.Return<Model, Message, AgentSocketService>;

const send = (model: Model, raw: string): UpdateReturn => {
  const text = raw.trim();

  if (!text || isLocked(model) || !Connection.guards.Connected(model.connection)) return { model };

  if (text.length > MAX_PROMPT) return { model: modifyFields(model, { error: () => LENGTH_ERROR }) };

  return {
    model: modifyFields(model, { draft: () => "", error: () => null, sending: () => true, stopArmed: () => false }),
    commands: [
      SendFrame({ event: { type: "send", text, folder: targetFolder(model) } }),
      ScrollThread({ force: true }),
      ArmStop(),
      FocusComposer({ when: "keep" }),
    ],
  };
};

const lost = (model: Model): UpdateReturn => {
  const attempts = model.attempts + 1;

  return {
    model: modifyFields(model, {
      connection: () => Connection.Lost(),
      attempts: () => attempts,
      partial: () => null,
      sending: () => false,
      stopping: () => false,
    }),
    commands: [RetryConnect({ attempts }), CheckMe()],
  };
};

export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    GotMe: ({ me }) =>
      me.signedIn
        ? {
            model: modifyFields(model, { session: () => Session.SignedIn(), connection: () => Connection.Connecting() }),
          }
        : {
            model: modifyFields(model, {
              session: () => Session.SignedOut({ configured: me.configured }),
              connection: () => Connection.Idle(),
              agent: () => null,
              partial: () => null,
            }),
          },
    FailedMe: () => ({ model: modifyFields(model, { session: () => Session.Failed() }) }),
    ClickedRetryMe: () => ({ model: modifyFields(model, { session: () => Session.Loading() }), commands: [FetchMe()] }),
    KeptSession: () => ({ model }),
    ConnectedSocket: () => ({
      model: modifyFields(model, { connection: () => Connection.Connected(), attempts: () => 0, error: () => null }),
      commands: [FocusComposer({ when: "idle" })],
    }),
    ReleasedSocket: () => ({ model }),
    FailedSocket: () => lost(model),
    ClosedSocket: () => (Connection.guards.Connected(model.connection) ? lost(model) : { model }),
    RetriedConnect: ({ attempts }) =>
      Connection.guards.Lost(model.connection) && attempts === model.attempts
        ? { model: modifyFields(model, { connection: () => Connection.Connecting() }) }
        : { model },
    ReceivedState: ({ state }) => ({
      model: modifyFields(model, {
        agent: () => state,
        sending: (s) => s && !state.busy,
        stopping: (s) => s && state.busy,
        wait: (w) => (state.busy || model.sending ? w : null),
      }),
    }),
    ReceivedHistory: ({ messages }) => ({
      model: modifyFields(model, { history: () => messages, partial: () => null, synced: () => true }),
      commands: [ScrollThread({ force: true })],
    }),
    ReceivedMessage: ({ message: m, at }) => ({
      model: modifyFields(model, {
        history: (h) => [...h, m],
        partial: () => null,
        sending: () => false,
        clock: (c) => (m.role === "assistant" ? onMessage(c, model.history.length, at) : c),
      }),
      commands: [ScrollThread({ force: false })],
    }),
    Ticked: ({ at }) => ({
      model: modifyFields(model, { wait: (w) => (isLocked(model) ? { since: w?.since ?? at, now: at } : null) }),
    }),
    ReceivedPartial: ({ content, at }) => ({
      model: modifyFields(model, { partial: () => content, clock: (c) => (content ? onPartial(c, content, at) : c) }),
      commands: [ScrollThread({ force: false })],
    }),
    ReceivedError: ({ message: error }) => ({
      model: modifyFields(model, { error: () => error, sending: () => false, wait: (w) => (isBusy(model) ? w : null) }),
    }),
    UpdatedDraft: ({ value }) => ({
      model: modifyFields(model, {
        draft: () => value,
        error: (e) => (e === LENGTH_ERROR && value.trim().length <= MAX_PROMPT ? null : e),
      }),
    }),
    SubmittedDraft: () => send(model, model.draft),
    ClickedStarter: ({ text }) => send(model, text),
    ClickedStop: () =>
      !model.stopArmed || model.stopping
        ? { model }
        : {
            model: modifyFields(model, { stopping: () => true }),
            commands: [SendFrame({ event: { type: "stop" } }), FocusComposer({ when: "keep" })],
          },
    ArmedStop: () => ({ model: modifyFields(model, { stopArmed: () => true }) }),
    SentFrame: () => ({ model }),
    FailedFrame: ({ error, unsent }) => ({
      model: modifyFields(model, {
        error: () => error,
        sending: () => false,
        stopping: () => false,
        draft: (d) => (d === "" && unsent ? unsent : d),
      }),
    }),
    ToggledStep: ({ key }) => ({
      model: modifyFields(model, { expanded: (ks) => (ks.includes(key) ? ks.filter((k) => k !== key) : [...ks, key]) }),
    }),
    ReceivedLibrary: ({ library }) => ({ model: modifyFields(model, { library: () => library }) }),
    ReceivedPlan: ({ record }) => ({ model: modifyFields(model, { plans: (ps) => ({ ...ps, [record.plan.id]: record }) }) }),
    ClickedApply: ({ plan, exclude }) => ({ model, commands: [SendFrame({ event: { type: "apply", plan, exclude } })] }),
    ClickedDiscard: ({ plan }) => ({ model, commands: [SendFrame({ event: { type: "discard", plan } })] }),
    ClickedStopRun: ({ plan }) => ({ model, commands: [SendFrame({ event: { type: "stopRun", plan } })] }),
    ClickedRetryRun: ({ plan }) => ({ model, commands: [SendFrame({ event: { type: "retry", plan } })] }),
    ClickedUndoRun: ({ plan }) => ({ model, commands: [SendFrame({ event: { type: "undo", plan } })] }),
    ClickedNewThread: () => ({ model, commands: [SendFrame({ event: { type: "newThread" } })] }),
    ToggledTree: () => ({ model: modifyFields(model, { treeOpen: (open) => !open }) }),
    ClosedTree: () => ({ model: modifyFields(model, { treeOpen: () => false }) }),
    ToggledTreeNode: ({ id }) => ({
      model: modifyFields(model, {
        treeExpanded: (ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]),
        treeFocus: () => id,
      }),
    }),
    RevealedFile: ({ id }) => ({
      model: modifyFields(model, { treeOpen: () => true, treeFocus: () => id }),
      commands: [ScrollTreeNode({ id })],
    }),
    OpenedPlayer: ({ id, name }) => ({
      model: modifyFields(model, { player: () => ({ id, name, src: null, failed: false }) }),
      commands: [FetchStream({ id }), FocusDialog({ focus: PLAYER_CLOSE_ID })],
    }),
    GotStream: ({ id, src }) =>
      model.player?.id === id
        ? { model: modifyFields(model, { player: (p) => (p ? { ...p, src } : p) }), commands: [AttachPlayer({ id, src })] }
        : { model },
    FailedStream: ({ id }) =>
      model.player?.id === id ? { model: modifyFields(model, { player: (p) => (p ? { ...p, failed: true } : p) }) } : { model },
    ClickedLinks: ({ id }) => ({
      model: modifyFields(model, { links: (ls) => ({ ...ls, [id]: { state: "loading" as const } }) }),
      commands: [FetchLinks({ id })],
    }),
    GotLinks: ({ id, links }) => ({ model: modifyFields(model, { links: (ls) => ({ ...ls, [id]: { state: "done" as const, links } }) }) }),
    FailedLinks: ({ id, message }) => ({ model: modifyFields(model, { links: (ls) => ({ ...ls, [id]: { state: "failed" as const, message } }) }) }),
    ClickedCopyLinks: ({ id }) => {
      const entry = model.links[id];

      return { model, commands: entry?.state === "done" ? [CopyText({ text: entry.links.join("\n") })] : [] };
    },
    ClosedPlayer: () => ({
      model: modifyFields(model, { player: () => null }),
      commands: [DetachPlayer(), FocusDialog({ focus: null })],
    }),
    FailedAvatar: () => ({ model: modifyFields(model, { avatarFailed: () => true }) }),
    ClickedSignOut: () => ({ model, commands: [SignOut()] }),
    ClickedDeleteData: () => ({ model: modifyFields(model, { confirmingDelete: () => true }), commands: [FocusDialog({ focus: DELETE_CANCEL_ID })] }),
    CancelledDelete: () => ({ model: modifyFields(model, { confirmingDelete: () => false }), commands: [FocusDialog({ focus: null })] }),
    ConfirmedDelete: () => ({ model: modifyFields(model, { confirmingDelete: () => false }), commands: [FocusDialog({ focus: null }), DeleteData()] }),
    ClickedFeedback: ({ kind, text }) => ({
      model: modifyFields(model, { feedback: () => ({ kind, text, status: "editing" as const, error: null }) }),
      commands: [FocusDialog({ focus: FEEDBACK_TEXT_ID })],
    }),
    ChoseFeedbackKind: ({ kind }) => ({ model: modifyFields(model, { feedback: (f) => (f && f.status === "editing" ? { ...f, kind } : f) }) }),
    UpdatedFeedback: ({ text }) => ({ model: modifyFields(model, { feedback: (f) => (f && f.status === "editing" ? { ...f, text, error: null } : f) }) }),
    SubmittedFeedback: () => {
      const f = model.feedback;
      const text = f ? feedbackText(f.text) : null;

      if (!f || f.status !== "editing" || text === null) return { model };

      return {
        model: modifyFields(model, { feedback: () => ({ ...f, status: "sending" as const, error: null }) }),
        commands: [SendFeedback({ feedback: { kind: f.kind, text } })],
      };
    },
    SentFeedback: () =>
      model.feedback
        ? { model: modifyFields(model, { feedback: (f) => (f ? { ...f, status: "sent" as const } : f) }), commands: [FocusDialog({ focus: FEEDBACK_CLOSE_ID })] }
        : { model },
    FailedFeedback: ({ error }) => ({ model: modifyFields(model, { feedback: (f) => (f ? { ...f, status: "editing" as const, error } : f) }) }),
    ClosedFeedback: () => ({ model: modifyFields(model, { feedback: () => null }), commands: [FocusDialog({ focus: null })] }),
    CompletedEffect: () => ({ model }),
  });

export const init: Runtime.ApplicationInit<Model, Message, void, never, AgentSocketService> = () => ({
  model: {
    session: Session.Loading(),
    connection: Connection.Idle(),
    attempts: 0,
    agent: null,
    history: [],
    synced: false,
    partial: null,
    error: null,
    sending: false,
    stopping: false,
    stopArmed: true,
    draft: "",
    expanded: [],
    clock: emptyClock,
    wait: null,
    library: null,
    plans: {},
    treeOpen: false,
    treeExpanded: [],
    treeFocus: null,
    avatarFailed: false,
    confirmingDelete: false,
    feedback: null,
    player: null,
    links: {},
  },
  commands: [FetchMe()],
});

const decodeServerFrame = Schema.decodeUnknownExit(ServerFrame);

const toMessage = (event: ServerEvent, at: number): Message =>
  Match.value(event).pipe(
    Match.discriminatorsExhaustive("type")({
      state: ({ state }) => Message.ReceivedState({ state }),
      history: ({ messages }) => Message.ReceivedHistory({ messages }),
      message: ({ message }) => Message.ReceivedMessage({ message, at }),
      partial: ({ content }) => Message.ReceivedPartial({ content, at }),
      error: ({ message }) => Message.ReceivedError({ message }),
      library: ({ library }) => Message.ReceivedLibrary({ library }),
      plan: ({ record }) => Message.ReceivedPlan({ record }),
    }),
  );

const socketMessages = (socket: WebSocket) =>
  Stream.callback<Message>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const onFrame = (event: MessageEvent) => {
          const exit = decodeServerFrame(event.data);

          if (Exit.isSuccess(exit)) Queue.offerUnsafe(queue, toMessage(exit.value, Date.now()));
          else if (import.meta.env.DEV) console.warn("dropped a malformed agent frame", exit.cause);
        };

        const onClose = () => {
          Queue.offerUnsafe(queue, Message.ClosedSocket());
          Queue.endUnsafe(queue);
        };

        socket.addEventListener("message", onFrame);
        socket.addEventListener("close", onClose);

        return { onFrame, onClose };
      }),
      ({ onFrame, onClose }) =>
        Effect.sync(() => {
          socket.removeEventListener("message", onFrame);
          socket.removeEventListener("close", onClose);
        }),
    ).pipe(Effect.flatMap(() => Effect.never)),
  );

export const subscriptions = Subscription.make<Model, Message, AgentSocketService>()((entry) => ({
  agentFrames: entry(
    { isConnected: Schema.Boolean },
    {
      modelToDependencies: (model) => ({ isConnected: Connection.guards.Connected(model.connection) }),
      dependenciesToStream: ({ isConnected }) =>
        Stream.when(
          Stream.unwrap(
            AgentSocket.get.pipe(
              Effect.map(socketMessages),
              Effect.catchTag("ResourceNotAvailable", () => Effect.succeed(Stream.empty)),
            ),
          ),
          Effect.sync(() => isConnected),
        ),
    },
  ),
  waitTicks: entry(
    { isLocked: Schema.Boolean },
    {
      modelToDependencies: (model) => ({ isLocked: isLocked(model) }),
      dependenciesToStream: ({ isLocked }) =>
        Stream.when(
          Stream.tick(Duration.seconds(1)).pipe(Stream.map(() => Message.Ticked({ at: Date.now() }))),
          Effect.sync(() => isLocked),
        ),
    },
  ),
}));
