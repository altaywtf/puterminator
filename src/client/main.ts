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
  Folder,
  Folders,
  Library,
  Me,
  MessageParam,
  ROOT_FOLDER,
  ServerFrame,
  type ServerEvent,
} from "../shared/contract";
import { emptyClock, onMessage, onPartial, ThinkingClock } from "./thinking";

const CONNECT_TIMEOUT = Duration.seconds(8);
const MAX_PROMPT = 4000;
export const COMPOSER_ID = "composer";
export const THREAD_ID = "thread";
export const FOLDER_TRIGGER_ID = "folder-trigger";
export const folderOptionId = (index: number) => `folder-opt-${index}`;
export const LENGTH_ERROR = `keep it under ${MAX_PROMPT.toLocaleString("en-US")} characters.`;

// MODEL

export const Session = defineTaggedUnion({
  Loading: {},
  SignedOut: { configured: Schema.Boolean },
  SignedIn: {},
  /** /api/me failed or returned garbage; not the same as "not configured". */
  Failed: {},
});
export type Session = typeof Session.Type;

export const Connection = defineTaggedUnion({
  Idle: {},
  Connecting: {},
  Connected: {},
  Lost: {},
});
export type Connection = typeof Connection.Type;

export const Model = Schema.Struct({
  session: Session,
  connection: Connection,
  attempts: Schema.Int,
  agent: Schema.NullOr(AgentState),
  history: Schema.Array(MessageParam),
  /** False until the first history frame; the empty home must not flash before it. */
  synced: Schema.Boolean,
  partial: Schema.NullOr(Schema.Array(ContentBlock)),
  error: Schema.NullOr(Schema.String),
  /** Set by a send until the server answers; stops a double tap from sending twice. */
  sending: Schema.Boolean,
  stopping: Schema.Boolean,
  /** False for a moment after a send, so a double click on send never lands on stop. */
  stopArmed: Schema.Boolean,
  draft: Schema.String,
  folders: Schema.Array(Folder),
  picked: Schema.NullOr(Folder),
  menuOpen: Schema.Boolean,
  expanded: Schema.Array(Schema.String),
  clock: ThinkingClock,
  /** The last scan, as the server sent it; indexed lazily in library.ts. */
  library: Schema.NullOr(Library),
  treeOpen: Schema.Boolean,
  treeExpanded: Schema.Array(Schema.Finite),
  treeFocus: Schema.NullOr(Schema.Finite),
  /** The put.io avatar didn't load; the topbar shows the initial instead. */
  avatarFailed: Schema.Boolean,
  /** The video playing in the overlay; `src` arrives from /api/files/:id/stream. */
  player: Schema.NullOr(
    Schema.Struct({ id: Schema.Finite, name: Schema.String, src: Schema.NullOr(Schema.String), failed: Schema.Boolean }),
  ),
});
export type Model = typeof Model.Type;

/** The folder the next prompt targets: the user's pick, else the agent's last one. */
export const targetFolder = (model: Model): Folder => model.picked ?? model.agent?.folder ?? ROOT_FOLDER;
export const isBusy = (model: Model) => model.agent?.busy === true;
/** Busy, or a send the server has not answered yet. */
export const isLocked = (model: Model) => model.sending || isBusy(model);

// MESSAGE

export const Message = defineMessageUnion({
  GotMe: { me: Me },
  FailedMe: {},
  ClickedRetryMe: {},
  GotFolders: { folders: Folders },
  ConnectedSocket: {},
  ReleasedSocket: {},
  FailedSocket: {},
  ClosedSocket: {},
  /** `attempts` ties a timer to the failure that scheduled it; stale timers are ignored. */
  RetriedConnect: { attempts: Schema.Int },
  ReceivedState: { state: AgentState },
  ReceivedHistory: { messages: Schema.Array(MessageParam) },
  ReceivedMessage: { message: MessageParam, at: Schema.Finite },
  ReceivedPartial: { content: Schema.NullOr(Schema.Array(ContentBlock)), at: Schema.Finite },
  ReceivedError: { message: Schema.String },
  ReceivedLibrary: { library: Library },
  ToggledTree: {},
  ClosedTree: {},
  ToggledTreeNode: { id: Schema.Finite },
  /** Opens the tree with every ancestor expanded and scrolls the file into view. */
  RevealedFile: { id: Schema.Finite, ancestors: Schema.Array(Schema.Finite) },
  OpenedPlayer: { id: Schema.Finite, name: Schema.String },
  GotStream: { id: Schema.Finite, src: Schema.String },
  FailedStream: { id: Schema.Finite },
  ClosedPlayer: {},
  FailedAvatar: {},
  UpdatedDraft: { value: Schema.String },
  SubmittedDraft: {},
  ClickedStarter: { text: Schema.String },
  ClickedStop: {},
  ArmedStop: {},
  SentFrame: {},
  FailedFrame: { error: Schema.String },
  ToggledStep: { key: Schema.String },
  ToggledFolderMenu: {},
  ClosedFolderMenu: {},
  LeftFolderMenu: {},
  PickedFolder: { folder: Folder },
  ClickedSignOut: {},
  CompletedEffect: {},
});
export type Message = typeof Message.Type;

// RESOURCES

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

// COMMANDS

const decodeMe = Schema.decodeUnknownEffect(Me);
const decodeFolders = Schema.decodeUnknownEffect(Folders);

const getJson = (path: string) =>
  Effect.tryPromise(async () => {
    const response = await fetch(path, { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`${path} returned ${response.status}`);
    return (await response.json()) as unknown;
  });

export const FetchMe = Command.define("FetchMe", {
  messages: [Message.GotMe, Message.FailedMe],
  execute: getJson("/api/me").pipe(
    Effect.flatMap(decodeMe),
    Effect.map((me) => Message.GotMe({ me })),
    Effect.orElseSucceed(() => Message.FailedMe()),
  ),
});

/** The picker still offers the root folder when /api/folders fails. */
export const FetchFolders = Command.define("FetchFolders", {
  messages: [Message.GotFolders],
  execute: getJson("/api/folders").pipe(
    Effect.flatMap(decodeFolders),
    Effect.orElseSucceed(() => []),
    Effect.map((folders) => Message.GotFolders({ folders })),
  ),
});

const encodeClientFrame = Schema.encodeSync(ClientFrame);

export const SendFrame = Command.define("SendFrame", {
  args: { event: ClientEvent },
  messages: [Message.SentFrame, Message.FailedFrame],
  execute: ({ event }) =>
    AgentSocket.get.pipe(
      Effect.flatMap((socket) => Effect.try(() => socket.send(encodeClientFrame(event)))),
      Effect.as(Message.SentFrame()),
      Effect.orElseSucceed(() => Message.FailedFrame({ error: "not connected. try again in a moment." })),
    ),
});

/** Bounded backoff: 1s, 2s, 4s, then every 10s, like the v1 PartySocket. */
export const RetryConnect = Command.define("RetryConnect", {
  args: { attempts: Schema.Int },
  messages: [Message.RetriedConnect],
  execute: ({ attempts }) =>
    Effect.sleep(Duration.millis(Math.min(10_000, 1000 * 2 ** Math.max(0, attempts - 1)))).pipe(
      Effect.as(Message.RetriedConnect({ attempts })),
    ),
});

export const SignOut = Command.define("SignOut", {
  messages: [Message.CompletedEffect],
  execute: Effect.tryPromise(() => fetch("/auth/logout", { method: "POST" })).pipe(
    Effect.ignore,
    Effect.flatMap(() => Effect.sync(() => location.reload())),
    Effect.as(Message.CompletedEffect()),
  ),
});

export const ArmStop = Command.define("ArmStop", {
  messages: [Message.ArmedStop],
  execute: Effect.sleep(Duration.millis(300)).pipe(Effect.as(Message.ArmedStop())),
});

const finePointer = () => matchMedia("(pointer: fine)").matches;
const nothingFocused = () => document.activeElement === null || document.activeElement === document.body;

const focusAfterCommit = (selector: string, allowed: () => boolean) =>
  Effect.sync(allowed).pipe(
    Effect.flatMap((ok) =>
      Render.afterCommit.pipe(
        Effect.flatMap(() =>
          Effect.sync(() => {
            const el = document.querySelector(selector);
            if (ok && el instanceof HTMLElement) el.focus({ preventScroll: true });
          }),
        ),
      ),
    ),
    Effect.as(Message.CompletedEffect()),
  );

/**
 * `always`: the user asked for the composer. `idle`: only if nothing holds focus.
 * `keep`: after a send or stop; touch keeps the soft keyboard shut unless it was already open.
 */
export const FocusComposer = Command.define("FocusComposer", {
  args: { when: Schema.Literals(["always", "idle", "keep"]) },
  messages: [Message.CompletedEffect],
  execute: ({ when }) => {
    // Read before the commit: the send can unmount the focused node.
    const composerHadFocus = document.activeElement?.id === COMPOSER_ID;
    return focusAfterCommit(`#${COMPOSER_ID}`, () =>
      when === "always" ? true : when === "idle" ? finePointer() && nothingFocused() : finePointer() || composerHadFocus,
    );
  },
});

export const FocusFolderItem = Command.define("FocusFolderItem", {
  messages: [Message.CompletedEffect],
  execute: focusAfterCommit(`[role="menuitemradio"][tabindex="0"]`, () => true),
});

export const treeNodeId = (id: number) => `tree-${id}`;
export const PLAYER_ID = "player";

const StreamResponse = Schema.Struct({ hls: Schema.String });

export const FetchStream = Command.define("FetchStream", {
  args: { id: Schema.Finite },
  messages: [Message.GotStream, Message.FailedStream],
  execute: ({ id }) =>
    Effect.tryPromise(() => fetch(`/api/files/${id}/stream`).then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(StreamResponse)),
      Effect.map(({ hls }) => Message.GotStream({ id, src: hls })),
      Effect.orElseSucceed(() => Message.FailedStream({ id })),
    ),
});

// One player at a time; hls.js loads on the first play.
let hls: { destroy: () => void } | null = null;

const detach = () => {
  hls?.destroy();
  hls = null;
};

export const AttachPlayer = Command.define("AttachPlayer", {
  args: { id: Schema.Finite, src: Schema.String },
  messages: [Message.CompletedEffect, Message.FailedStream],
  execute: ({ id, src }) =>
    Render.afterCommit.pipe(
      Effect.flatMap(() =>
        Effect.tryPromise(async () => {
          const video = document.getElementById(PLAYER_ID);
          if (!(video instanceof HTMLVideoElement)) return;
          detach();
          // hls.js wherever MSE exists: Chrome's native HLS rejects put.io's playlists (MEDIA_ERR_SRC_NOT_SUPPORTED).
          // Native HLS only where MSE is missing, which is iOS Safari.
          const mse = "MediaSource" in window || "ManagedMediaSource" in window;
          const { default: Hls } = mse ? await import("hls.js/light") : { default: null };
          if (Hls?.isSupported()) {
            const player = new Hls();
            hls = player;
            // Wait for the playlist, so a dead stream shows the failure state instead of a black box.
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

export const DetachPlayer = Command.define("DetachPlayer", {
  messages: [Message.CompletedEffect],
  execute: Effect.sync(detach).pipe(Effect.as(Message.CompletedEffect())),
});

export const ScrollTreeNode = Command.define("ScrollTreeNode", {
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

export const FocusFolderTrigger = Command.define("FocusFolderTrigger", {
  messages: [Message.CompletedEffect],
  execute: focusAfterCommit(`#${FOLDER_TRIGGER_ID}`, () => true),
});

// Scroll state lives in the DOM, so the stick-to-bottom check does too: follow new content only
// when the reader was within 160px of the end before it rendered.
let lastHeight = 0;
export const ScrollThread = Command.define("ScrollThread", {
  args: { force: Schema.Boolean },
  messages: [Message.CompletedEffect],
  execute: ({ force }) =>
    Render.afterCommit.pipe(
      Effect.flatMap(() =>
        Effect.sync(() => {
          const el = document.getElementById(THREAD_ID);
          if (!el) return;
          if (force || lastHeight - el.scrollTop - el.clientHeight < 160) el.scrollTop = el.scrollHeight;
          lastHeight = el.scrollHeight;
        }),
      ),
      Effect.as(Message.CompletedEffect()),
    ),
});

// UPDATE

type UpdateReturn = Update.Return<Model, Message, AgentSocketService>;

const send = (model: Model, raw: string): UpdateReturn => {
  const text = raw.trim();
  if (!text || isLocked(model) || model.connection._tag !== "Connected") return { model };
  if (text.length > MAX_PROMPT) return { model: modifyFields(model, { error: () => LENGTH_ERROR }) };
  return {
    model: modifyFields(model, { draft: () => "", error: () => null, menuOpen: () => false, sending: () => true, stopArmed: () => false }),
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
    commands: [RetryConnect({ attempts })],
  };
};

export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    GotMe: ({ me }) =>
      me.signedIn
        ? {
            model: modifyFields(model, { session: () => Session.SignedIn(), connection: () => Connection.Connecting() }),
            commands: [FetchFolders()],
          }
        : { model: modifyFields(model, { session: () => Session.SignedOut({ configured: me.configured }) }) },
    FailedMe: () => ({ model: modifyFields(model, { session: () => Session.Failed() }) }),
    ClickedRetryMe: () => ({ model: modifyFields(model, { session: () => Session.Loading() }), commands: [FetchMe()] }),
    GotFolders: ({ folders }) => ({ model: modifyFields(model, { folders: () => folders }) }),
    ConnectedSocket: () => ({
      model: modifyFields(model, { connection: () => Connection.Connected(), attempts: () => 0, error: () => null }),
      commands: [FocusComposer({ when: "idle" })],
    }),
    ReleasedSocket: () => ({ model }),
    FailedSocket: () => lost(model),
    ClosedSocket: () => (model.connection._tag === "Connected" ? lost(model) : { model }),
    RetriedConnect: ({ attempts }) =>
      model.connection._tag === "Lost" && attempts === model.attempts
        ? { model: modifyFields(model, { connection: () => Connection.Connecting() }) }
        : { model },
    ReceivedState: ({ state }) => ({
      model: modifyFields(model, { agent: () => state, sending: (s) => s && !state.busy, stopping: (s) => s && state.busy }),
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
    ReceivedPartial: ({ content, at }) => ({
      model: modifyFields(model, { partial: () => content, clock: (c) => (content ? onPartial(c, content, at) : c) }),
      commands: [ScrollThread({ force: false })],
    }),
    ReceivedError: ({ message: error }) => ({ model: modifyFields(model, { error: () => error, sending: () => false }) }),
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
    FailedFrame: ({ error }) => ({ model: modifyFields(model, { error: () => error, sending: () => false, stopping: () => false }) }),
    ToggledStep: ({ key }) => ({
      model: modifyFields(model, { expanded: (ks) => (ks.includes(key) ? ks.filter((k) => k !== key) : [...ks, key]) }),
    }),
    ToggledFolderMenu: () => ({
      model: modifyFields(model, { menuOpen: (open) => !open }),
      commands: model.menuOpen ? [] : [FocusFolderItem()],
    }),
    ClosedFolderMenu: () =>
      model.menuOpen ? { model: modifyFields(model, { menuOpen: () => false }), commands: [FocusFolderTrigger()] } : { model },
    LeftFolderMenu: () => ({ model: modifyFields(model, { menuOpen: () => false }) }),
    PickedFolder: ({ folder }) => ({
      model: modifyFields(model, { picked: () => folder, menuOpen: () => false }),
      commands: [FocusComposer({ when: "always" })],
    }),
    ReceivedLibrary: ({ library }) => ({ model: modifyFields(model, { library: () => library }) }),
    ToggledTree: () => ({ model: modifyFields(model, { treeOpen: (open) => !open }) }),
    ClosedTree: () => ({ model: modifyFields(model, { treeOpen: () => false }) }),
    ToggledTreeNode: ({ id }) => ({
      model: modifyFields(model, {
        treeExpanded: (ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]),
        treeFocus: () => id,
      }),
    }),
    RevealedFile: ({ id, ancestors }) => ({
      model: modifyFields(model, {
        treeOpen: () => true,
        treeExpanded: (ids) => [...new Set([...ids, ...ancestors])],
        treeFocus: () => id,
      }),
      commands: [ScrollTreeNode({ id })],
    }),
    OpenedPlayer: ({ id, name }) => ({
      model: modifyFields(model, { player: () => ({ id, name, src: null, failed: false }) }),
      commands: [FetchStream({ id })],
    }),
    GotStream: ({ id, src }) =>
      model.player?.id === id
        ? { model: modifyFields(model, { player: (p) => (p ? { ...p, src } : p) }), commands: [AttachPlayer({ id, src })] }
        : { model },
    FailedStream: ({ id }) =>
      model.player?.id === id ? { model: modifyFields(model, { player: (p) => (p ? { ...p, failed: true } : p) }) } : { model },
    ClosedPlayer: () => ({ model: modifyFields(model, { player: () => null }), commands: [DetachPlayer()] }),
    FailedAvatar: () => ({ model: modifyFields(model, { avatarFailed: () => true }) }),
    ClickedSignOut: () => ({ model, commands: [SignOut()] }),
    CompletedEffect: () => ({ model }),
  });

// INIT

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
    folders: [],
    picked: null,
    menuOpen: false,
    expanded: [],
    clock: emptyClock,
    library: null,
    treeOpen: false,
    treeExpanded: [],
    treeFocus: null,
    avatarFailed: false,
    player: null,
  },
  commands: [FetchMe()],
});

// SUBSCRIPTIONS

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
    }),
  );

// A frame that fails to decode is dropped, mirroring the server's handling of client frames.
const socketMessages = (socket: WebSocket) =>
  Stream.callback<Message>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const onFrame = (event: MessageEvent) => {
          const exit = decodeServerFrame(event.data);
          if (Exit.isSuccess(exit)) Queue.offerUnsafe(queue, toMessage(exit.value, Date.now()));
          // The cause can echo library file names; keep it out of production consoles.
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
      modelToDependencies: (model) => ({ isConnected: model.connection._tag === "Connected" }),
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
}));
