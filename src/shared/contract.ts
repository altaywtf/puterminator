import * as Schema from "effect/Schema";
import { PlanRecord } from "./actions";

/** Wire contract between the Worker, the Puterminator Durable Object and the browser. */

export const Folder = Schema.Struct({
  id: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  name: Schema.String.check(Schema.isMaxLength(200)),
});

export type Folder = typeof Folder.Type;

export const ROOT_FOLDER: Folder = { id: 0, name: "Your Files" };

export const CREDIT_TOKENS = 5000;

export const Blocked = Schema.Struct({ reason: Schema.Literals(["paused", "out"]), until: Schema.String });

export type Blocked = typeof Blocked.Type;

/** `used` and `cap` are weighted tokens (Sonnet input-token equivalents) for `month` (YYYY-MM); `until` is a UTC date. */
export const Credits = Schema.Struct({ month: Schema.String, used: Schema.Finite, cap: Schema.Finite, blocked: Schema.optionalKey(Schema.NullOr(Blocked)) });

export type Credits = typeof Credits.Type;

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

export const shortDate = (isoDay: string) => `${MONTHS[Number(isoDay.slice(5, 7)) - 1] ?? ""} ${Number(isoDay.slice(8, 10))}`;

export const blockedText = (b: Blocked) =>
  b.reason === "out" ? `out of credits until ${shortDate(b.until)}.` : `busy month: everyone's credits are spread over the month. back ${shortDate(b.until)}.`;

/** One credit is one US cent of model use. */
export const creditsLeft = (c: Credits) => Math.max(0, Math.floor((c.cap - c.used) / CREDIT_TOKENS));

export const creditsTotal = (c: Credits) => Math.floor(c.cap / CREDIT_TOKENS);

export const unlimitedCredits = (c: Credits) => c.cap >= Number.MAX_SAFE_INTEGER;

const LastAudit = Schema.Struct({
  at: Schema.String,
  rootName: Schema.String,
  score: Schema.Finite,
  items: Schema.Finite,
});

type LastAudit = typeof LastAudit.Type;

/**
 * Server-owned; the browser only reads it. Same shape v1 kept in the Agents SDK
 * `cf_agents_state` row, so existing Durable Objects decode it unchanged.
 * `avatarUrl` is set at sign-in; state saved before it existed decodes without it.
 */
export const AgentState = Schema.Struct({
  username: Schema.NullOr(Schema.String),
  avatarUrl: Schema.optional(Schema.NullOr(Schema.String)),
  folder: Folder,
  credits: Credits,
  lastAudit: Schema.NullOr(LastAudit),
  busy: Schema.Boolean,
});

export type AgentState = typeof AgentState.Type;

export const initialAgentState = (month: string): AgentState => ({
  username: null,
  avatarUrl: null,
  folder: ROOT_FOLDER,
  credits: { month, used: 0, cap: 0 },
  lastAudit: null,
  busy: false,
});

/**
 * Browser → agent. A frame that fails to decode is dropped. `apply` is the only path to a write: it applies a
 * proposed plan, minus the changes in `exclude`. `undo` reverses a finished run's done steps. `newThread` archives
 * the conversation and starts an empty one.
 */
export const ClientEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("send"),
    text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4000)),
    folder: Folder,
  }),
  Schema.Struct({ type: Schema.Literal("stop") }),
  Schema.Struct({ type: Schema.Literal("apply"), plan: Schema.String, exclude: Schema.Array(Schema.String) }),
  Schema.Struct({ type: Schema.Literal("discard"), plan: Schema.String }),
  Schema.Struct({ type: Schema.Literal("stopRun"), plan: Schema.String }),
  Schema.Struct({ type: Schema.Literal("retry"), plan: Schema.String }),
  Schema.Struct({ type: Schema.Literal("undo"), plan: Schema.String }),
  Schema.Struct({ type: Schema.Literal("newThread") }),
]);

export type ClientEvent = typeof ClientEvent.Type;

/**
 * An Anthropic content block, kept opaque so every block type (thinking, redacted_thinking,
 * tool_result with array content) decodes and signatures survive the round trip.
 */
export const ContentBlock = Schema.StructWithRest(Schema.Struct({ type: Schema.String }), [
  Schema.Record(Schema.String, Schema.Unknown),
]);

export type ContentBlock = typeof ContentBlock.Type;

/** An Anthropic `BetaMessageParam`, as stored append-only in the `messages` table. */
export const MessageParam = Schema.Struct({
  role: Schema.Literals(["user", "assistant"]),
  content: Schema.Union([Schema.String, Schema.Array(ContentBlock)]),
});

export type MessageParam = typeof MessageParam.Type;

/** Bits in a `LibraryFile`'s flags. */
export const FileFlag = { folder: 1, video: 2, played: 4, junk: 8, messy: 16 } as const;

const LibraryFile = Schema.Tuple([Schema.Finite, Schema.Finite, Schema.String, Schema.Finite, Schema.Finite]);

type LibraryFile = typeof LibraryFile.Type;

/**
 * The last scan's tree under `rootId`, for file links and the tree view. Each file is one compact
 * `[id, parentId, name, bytes, flags]` row, since a library can hold tens of thousands. Paths rebuild from parent ids.
 */
export const Library = Schema.Struct({ rootId: Schema.Finite, rootName: Schema.String, files: Schema.Array(LibraryFile) });

export type Library = typeof Library.Type;

/** Agent → browser. `state` replaces the Agents SDK `cf_agent_state` frame. */
export const ServerEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("state"), state: AgentState }),
  Schema.Struct({ type: Schema.Literal("history"), messages: Schema.Array(MessageParam) }),
  Schema.Struct({ type: Schema.Literal("message"), message: MessageParam }),
  Schema.Struct({ type: Schema.Literal("partial"), content: Schema.NullOr(Schema.Array(ContentBlock)) }),
  Schema.Struct({ type: Schema.Literal("error"), message: Schema.String }),
  Schema.Struct({ type: Schema.Literal("library"), library: Library }),
  Schema.Struct({ type: Schema.Literal("plan"), record: PlanRecord }),
]);

export type ServerEvent = typeof ServerEvent.Type;

export const ClientFrame = Schema.fromJsonString(ClientEvent);
export const ServerFrame = Schema.fromJsonString(ServerEvent);

/** `GET /api/me`. `configured` is false when a required secret is missing. */
export const Me = Schema.Struct({ configured: Schema.Boolean, signedIn: Schema.Boolean });

export type Me = typeof Me.Type;

/** HTTP and WebSocket paths the Worker handles before static assets. */
export const WORKER_ROUTES = ["/agent", "/agent/*", "/auth/*", "/api/*"];
