import Anthropic from "@anthropic-ai/sdk";
import { betaStandardSchemaTool } from "@anthropic-ai/sdk/helpers/beta/standard-schema";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";
import { ToolError } from "@anthropic-ai/sdk/lib/tools/ToolError";
import type { BetaContentBlock, BetaMessage, BetaMessageParam, BetaUsage } from "@anthropic-ai/sdk/resources/beta/messages";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { type PutioError, PutioUnauthorized, rateLimitMessage } from "./putio";

export class AnthropicClient extends Context.Service<AnthropicClient, Anthropic>()("puterminator/AnthropicClient") {}

export const anthropicLayer = (opts: {
  apiKey: Redacted.Redacted<string>;
  fetch?: typeof fetch;
  maxRetries?: number;
}) =>
  Layer.sync(
    AnthropicClient,
    () =>
      // Only the Worker secret; never a token or profile picked up from the environment.
      new Anthropic({
        apiKey: Redacted.value(opts.apiKey),
        authToken: null,
        credentials: null,
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
        ...(opts.maxRetries === undefined ? {} : { maxRetries: opts.maxRetries }),
      }),
  );

/**
 * Credits are input-token equivalents at Sonnet 5.5 prices ($2 in, $10 out, cache writes 1.25x,
 * cache reads 0.1x), so the cap tracks real spend.
 */
export const weightedTokens = (u: BetaUsage) =>
  Math.round(
    u.input_tokens + (u.cache_creation_input_tokens ?? 0) * 1.25 + (u.cache_read_input_tokens ?? 0) * 0.1 + u.output_tokens * 5,
  );

// ---------- errors ----------

export class AnthropicRateLimited extends Schema.TaggedError<AnthropicRateLimited>()("AnthropicRateLimited", {
  retryAfterSec: Schema.NullOr(Schema.Finite),
}) {}
export class AnthropicOverloaded extends Schema.TaggedError<AnthropicOverloaded>()("AnthropicOverloaded", {}) {}
export class AnthropicRejected extends Schema.TaggedError<AnthropicRejected>()("AnthropicRejected", {
  status: Schema.Finite,
  message: Schema.String,
}) {}
export class AnthropicUnavailable extends Schema.TaggedError<AnthropicUnavailable>()("AnthropicUnavailable", {
  message: Schema.String,
}) {}

export type TurnError = AnthropicRateLimited | AnthropicOverloaded | AnthropicRejected | AnthropicUnavailable | PutioUnauthorized;

const mapAnthropicError = (e: unknown): TurnError => {
  if (e instanceof Anthropic.APIError && typeof e.status === "number") {
    if (e.status === 429) {
      const ra = Number(e.headers?.get("retry-after"));
      return new AnthropicRateLimited({ retryAfterSec: Number.isFinite(ra) ? ra : null });
    }
    if (e.status === 529) return new AnthropicOverloaded({});
    if (e.status >= 400 && e.status < 500) return new AnthropicRejected({ status: e.status, message: e.message });
  }
  return new AnthropicUnavailable({ message: e instanceof Error ? e.message : String(e) });
};

// ---------- tools ----------

/** A failure the model sees as an `is_error` tool result; the turn goes on. */
export class ToolFailure extends Schema.TaggedError<ToolFailure>()("ToolFailure", { message: Schema.String }) {}

export interface EffectTool<R> {
  /** Phantom, covariant: lets runTurn infer the union of every tool's requirements. */
  readonly _R?: R;
  readonly name: string;
  readonly jsonSchema: Record<string, unknown>;
  readonly build: (context: Context.Context<R>, onFatal: (e: PutioUnauthorized) => void) => BetaRunnableTool<unknown>;
}

/**
 * Strict tool use on Sonnet 5.5 rejects numeric and length bounds (Schema.Int emits them), open
 * objects and optional keys. Use Schema.Finite and literals, and clamp in code.
 */
export const strictJsonSchema = (schema: Schema.Top): Record<string, unknown> => {
  const doc = Schema.toJsonSchemaDocument(schema, { onExcessProperty: "error" });
  // Schema.Struct({}) compiles to `{ not: { type: "null" } }`, which is not an object schema.
  const root: Record<string, unknown> =
    doc.schema.type === "object" ? { ...doc.schema } : { type: "object", properties: {}, required: [], additionalProperties: false };
  const problems: Array<string> = [];
  const walk = (node: unknown, at: string) => {
    if (typeof node !== "object" || node === null) return;
    const n = node as Record<string, unknown>;
    for (const k of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "pattern", "$ref"]) {
      if (k in n) problems.push(`${at}: ${k}`);
    }
    if (n.type === "object") {
      if (n.additionalProperties !== false) problems.push(`${at}: additionalProperties not false`);
      const required = new Set(Array.isArray(n.required) ? n.required : []);
      for (const p of Object.keys(typeof n.properties === "object" && n.properties !== null ? n.properties : {})) {
        if (!required.has(p)) problems.push(`${at}.${p}: optional`);
      }
    }
    for (const [k, v] of Object.entries(n)) if (typeof v === "object") walk(v, `${at}/${k}`);
  };
  walk(root, "#");
  if (Object.keys(doc.definitions).length > 0) problems.push("#: uses definitions");
  if (problems.length > 0) throw new Error(`not strict-compatible: ${problems.join(", ")}`);
  return root;
};

export const effectTool = <S extends Schema.Codec<any, any, never, never>, R>(def: {
  name: string;
  description: string;
  input: S;
  run: (input: S["Type"]) => Effect.Effect<string, ToolFailure | PutioError, R>;
}): EffectTool<R> => {
  const jsonSchema = strictJsonSchema(def.input);
  return {
    name: def.name,
    jsonSchema,
    build: (context, onFatal) =>
      betaStandardSchemaTool({
        name: def.name,
        description: def.description,
        strict: true,
        inputSchema: Schema.toStandardSchemaV1(def.input),
        jsonSchema,
        // The runner aborts `signal` when the turn is interrupted; runPromiseExit turns that into a fiber interrupt.
        run: async (args, rc) => {
          const exit = await Effect.runPromiseExit(
            def.run(args).pipe(Effect.provideContext(context)),
            rc?.signal ? { signal: rc.signal } : undefined,
          );
          if (Exit.isSuccess(exit)) return exit.value;
          const err = Cause.findErrorOption(exit.cause);
          if (err._tag === "None") throw new ToolError(Cause.hasInterrupts(exit.cause) ? "Interrupted." : "Tool crashed.");
          const e = err.value;
          switch (e._tag) {
            case "PutioUnauthorized":
              onFatal(e);
              throw new ToolError("put.io sign-in expired.");
            case "PutioRateLimited":
              throw new ToolError(rateLimitMessage(e));
            case "PutioFailed":
            case "ToolFailure":
              throw new ToolError(e.message);
          }
        },
      }) as BetaRunnableTool<unknown>,
  };
};

// ---------- the turn ----------

export type TurnEvent =
  | { readonly type: "partial"; readonly content: ReadonlyArray<BetaContentBlock> }
  | { readonly type: "assistant"; readonly message: BetaMessage }
  | { readonly type: "tool_results"; readonly message: BetaMessageParam };

type ToolsR<T> = T extends EffectTool<infer R> ? R : never;

export interface TurnInput<T extends EffectTool<any>> {
  readonly model: string;
  readonly system: string;
  readonly messages: ReadonlyArray<BetaMessageParam>;
  readonly tools: ReadonlyArray<T>;
  readonly partialEveryMs: number;
}

/**
 * One user turn as a Stream. Interrupting the consumer closes the scope, which aborts the signal
 * Effect.tryPromise hands over, which aborts the runner's HTTP stream and any running tool.
 */
export const runTurn = <T extends EffectTool<any>>(
  input: TurnInput<T>,
): Stream.Stream<TurnEvent, TurnError, AnthropicClient | ToolsR<T>> =>
  Stream.callback<TurnEvent, TurnError, AnthropicClient | ToolsR<T>>((queue) =>
    Effect.gen(function* () {
      const client = yield* AnthropicClient;
      const context = yield* Effect.context<ToolsR<T>>();
      const abort = new AbortController();
      let fatal: PutioUnauthorized | null = null;
      const tools = input.tools.map((t) =>
        t.build(context, (e) => {
          fatal = e;
          abort.abort();
        }),
      );

      yield* Effect.tryPromise({
        try: async (signal) => {
          signal.addEventListener("abort", () => abort.abort(), { once: true });
          const runner = client.beta.messages.toolRunner(
            {
              model: input.model,
              max_tokens: 16000,
              stream: true,
              max_iterations: 8,
              thread: false,
              system: input.system,
              messages: [...input.messages],
              tools,
              thinking: { type: "adaptive", display: "summarized" },
              output_config: { effort: "medium" },
              cache_control: { type: "ephemeral" },
              betas: ["server-side-fallback-2026-07-01"],
              fallbacks: "default",
            },
            { signal: abort.signal },
          );
          for await (const stream of runner) {
            let sent = 0;
            stream.on("streamEvent", (_e, snapshot) => {
              if (Date.now() - sent < input.partialEveryMs) return;
              sent = Date.now();
              Queue.offerUnsafe(queue, { type: "partial", content: snapshot.content });
            });
            const message = await stream.finalMessage();
            Queue.offerUnsafe(queue, { type: "assistant", message });
            if (message.stop_reason === "refusal") break;
            // Cached by the runner, so the next iteration reuses these results instead of running tools again.
            const results = await runner.generateToolResponse();
            if (fatal) throw fatal;
            if (results) Queue.offerUnsafe(queue, { type: "tool_results", message: results });
          }
        },
        catch: (e) => fatal ?? mapAnthropicError(e),
      });
      yield* Queue.end(queue);
    }),
  );
