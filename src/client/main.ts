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

// MODEL

export const Session = defineTaggedUnion({
  Loading: {},
  SignedOut: { configured: Schema.Boolean },
  SignedIn: {},
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
  draft: Schema.String,
  folders: Schema.Array(Folder),
  picked: Schema.NullOr(Folder),
  menuOpen: Schema.Boolean,
  expanded: Schema.Array(Schema.String),
  clock: ThinkingClock,
});
export type Model = typeof Model.Type;

/** The folder the next prompt targets: the user's pick, else the agent's last one. */
export const targetFolder = (model: Model): Folder => model.picked ?? model.agent?.folder ?? ROOT_FOLDER;
export const isBusy = (model: Model) => model.agent?.busy === true;

// MESSAGE

export const Message = defineMessageUnion({
  GotMe: { me: Me },
  GotFolders: { folders: Folders },
  ConnectedSocket: {},
  ReleasedSocket: {},
  FailedSocket: {},
  ClosedSocket: {},
  RetriedConnect: {},
  ReceivedState: { state: AgentState },
  ReceivedHistory: { messages: Schema.Array(MessageParam) },
  ReceivedMessage: { message: MessageParam, at: Schema.Finite },
  ReceivedPartial: { content: Schema.NullOr(Schema.Array(ContentBlock)), at: Schema.Finite },
  ReceivedError: { message: Schema.String },
  UpdatedDraft: { value: Schema.String },
  SubmittedDraft: {},
  ClickedStarter: { text: Schema.String },
  ClickedStop: {},
  SentFrame: {},
  FailedFrame: { error: Schema.String },
  ToggledStep: { key: Schema.String },
  ToggledFolderMenu: {},
  ClosedFolderMenu: {},
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

/** A failed or malformed /api/me reads as "not configured", as in v1. */
export const FetchMe = Command.define("FetchMe", {
  messages: [Message.GotMe],
  execute: getJson("/api/me").pipe(
    Effect.flatMap(decodeMe),
    Effect.orElseSucceed((): Me => ({ configured: false, signedIn: false })),
    Effect.map((me) => Message.GotMe({ me })),
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
      Effect.as(Message.RetriedConnect()),
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

export const FocusComposer = Command.define("FocusComposer", {
  messages: [Message.CompletedEffect],
  execute: Render.afterCommit.pipe(
    Effect.flatMap(() => Effect.sync(() => document.getElementById(COMPOSER_ID)?.focus({ preventScroll: true }))),
    Effect.as(Message.CompletedEffect()),
  ),
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
  if (!text || isBusy(model) || model.connection._tag !== "Connected") return { model };
  if (text.length > MAX_PROMPT)
    return { model: modifyFields(model, { error: () => `Keep it under ${MAX_PROMPT.toLocaleString("en-US")} characters.` }) };
  return {
    model: modifyFields(model, { draft: () => "", error: () => null, menuOpen: () => false }),
    commands: [SendFrame({ event: { type: "send", text, folder: targetFolder(model) } }), ScrollThread({ force: true })],
  };
};

const lost = (model: Model): UpdateReturn => {
  const attempts = model.attempts + 1;
  return {
    model: modifyFields(model, { connection: () => Connection.Lost(), attempts: () => attempts, partial: () => null }),
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
    GotFolders: ({ folders }) => ({ model: modifyFields(model, { folders: () => folders }) }),
    ConnectedSocket: () => ({
      model: modifyFields(model, { connection: () => Connection.Connected(), attempts: () => 0, error: () => null }),
      commands: [FocusComposer()],
    }),
    ReleasedSocket: () => ({ model }),
    FailedSocket: () => lost(model),
    ClosedSocket: () => (model.connection._tag === "Connected" ? lost(model) : { model }),
    RetriedConnect: () =>
      model.connection._tag === "Lost" ? { model: modifyFields(model, { connection: () => Connection.Connecting() }) } : { model },
    ReceivedState: ({ state }) => ({ model: modifyFields(model, { agent: () => state }) }),
    ReceivedHistory: ({ messages }) => ({
      model: modifyFields(model, { history: () => messages, partial: () => null, synced: () => true }),
      commands: [ScrollThread({ force: true })],
    }),
    ReceivedMessage: ({ message: m, at }) => ({
      model: modifyFields(model, {
        history: (h) => [...h, m],
        partial: () => null,
        clock: (c) => (m.role === "assistant" ? onMessage(c, model.history.length, at) : c),
      }),
      commands: [ScrollThread({ force: false })],
    }),
    ReceivedPartial: ({ content, at }) => ({
      model: modifyFields(model, { partial: () => content, clock: (c) => (content ? onPartial(c, content, at) : c) }),
      commands: [ScrollThread({ force: false })],
    }),
    ReceivedError: ({ message: error }) => ({ model: modifyFields(model, { error: () => error }) }),
    UpdatedDraft: ({ value }) => ({ model: modifyFields(model, { draft: () => value }) }),
    SubmittedDraft: () => send(model, model.draft),
    ClickedStarter: ({ text }) => send(model, text),
    ClickedStop: () => ({ model, commands: [SendFrame({ event: { type: "stop" } })] }),
    SentFrame: () => ({ model }),
    FailedFrame: ({ error }) => ({ model: modifyFields(model, { error: () => error }) }),
    ToggledStep: ({ key }) => ({
      model: modifyFields(model, { expanded: (ks) => (ks.includes(key) ? ks.filter((k) => k !== key) : [...ks, key]) }),
    }),
    ToggledFolderMenu: () => ({ model: modifyFields(model, { menuOpen: (open) => !open }) }),
    ClosedFolderMenu: () => ({ model: modifyFields(model, { menuOpen: () => false }) }),
    PickedFolder: ({ folder }) => ({
      model: modifyFields(model, { picked: () => folder, menuOpen: () => false }),
      commands: [FocusComposer()],
    }),
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
    draft: "",
    folders: [],
    picked: null,
    menuOpen: false,
    expanded: [],
    clock: emptyClock,
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
          else console.warn("dropped a malformed agent frame", exit.cause);
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
