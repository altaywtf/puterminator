import Anthropic, { type ClientOptions } from "@anthropic-ai/sdk";
import { betaStandardSchemaTool } from "@anthropic-ai/sdk/helpers/beta/standard-schema";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";
import { ToolError } from "@anthropic-ai/sdk/lib/tools/ToolError";
import type { BetaContentBlock, BetaMessage, BetaMessageParam, BetaUsage } from "@anthropic-ai/sdk/resources/beta/messages";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as JsonSchema from "effect/JsonSchema";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { type PutioError, PutioUnauthorized, rateLimitMessage } from "./putio";

export class AnthropicClient extends Context.Service<AnthropicClient, Anthropic>()("puterminator/AnthropicClient") {}

export const anthropicLayer = (opts: {
  apiKey: Redacted.Redacted<string>;
  fetch?: typeof fetch | undefined;
  maxRetries?: number;
}) =>
  Layer.sync(AnthropicClient, () => {
    const options: ClientOptions = { apiKey: Redacted.value(opts.apiKey), authToken: null, credentials: null };

    if (opts.fetch) options.fetch = opts.fetch;

    if (opts.maxRetries !== undefined) options.maxRetries = opts.maxRetries;

    return new Anthropic(options);
  });

type Usage = Pick<BetaUsage, "input_tokens" | "output_tokens" | "cache_creation_input_tokens" | "cache_read_input_tokens">;

const PRICE_VS_SONNET: ReadonlyArray<readonly [string, number]> = [
  ["claude-haiku", 0.05],
  ["claude-sonnet", 1],
];

const OTHER_MODELS = 2;

const priceVsSonnet = (model: string) => PRICE_VS_SONNET.find(([prefix]) => model.startsWith(prefix))?.[1] ?? OTHER_MODELS;

const weightedTokens = (u: Usage, model: string) =>
  Math.ceil(
    (u.input_tokens + (u.cache_creation_input_tokens ?? 0) * 1.25 + (u.cache_read_input_tokens ?? 0) * 0.1 + u.output_tokens * 5) * priceVsSonnet(model),
  );

const CHARS_PER_TOKEN = 4;

const withStreamedOutput = (u: Usage, streamedChars: number): Usage => ({
  ...u,
  output_tokens: Math.max(u.output_tokens, Math.ceil(streamedChars / CHARS_PER_TOKEN)),
});

type Metered = { readonly usage: Usage; readonly model: string; readonly content: unknown };

/** Pays for one request's weighted tokens as its usage grows. `chargeStreamed` covers a stream that failed before its final usage. */
export const usageMeter = (pay: (tokens: number) => void) => {
  let charged = 0;

  const charge = (m: Metered) => {
    const total = weightedTokens(m.usage, m.model);

    if (total > charged) pay(total - charged);
    charged = Math.max(charged, total);
  };

  return { charge, chargeStreamed: (m: Metered) => charge({ ...m, usage: withStreamedOutput(m.usage, JSON.stringify(m.content).length) }) };
};

const SPEND_LIMIT = /usage limit|spend limit|regain access/i;

export const isSpendLimit = (cause: unknown) => cause instanceof Anthropic.APIError && cause.status !== undefined && cause.status >= 400 && cause.status < 500 && SPEND_LIMIT.test(cause.message);

class AnthropicRateLimited extends Schema.TaggedError<AnthropicRateLimited>()("AnthropicRateLimited", {
  retryAfterSec: Schema.NullOr(Schema.Finite),
}) {}

class AnthropicOverloaded extends Schema.TaggedError<AnthropicOverloaded>()("AnthropicOverloaded", {}) {}

class AnthropicRejected extends Schema.TaggedError<AnthropicRejected>()("AnthropicRejected", {
  status: Schema.Finite,
  message: Schema.String,
}) {}

class AnthropicOutOfBudget extends Schema.TaggedError<AnthropicOutOfBudget>()("AnthropicOutOfBudget", {}) {}

class AnthropicUnavailable extends Schema.TaggedError<AnthropicUnavailable>()("AnthropicUnavailable", {
  message: Schema.String,
}) {}

export type TurnError = AnthropicRateLimited | AnthropicOverloaded | AnthropicOutOfBudget | AnthropicRejected | AnthropicUnavailable | PutioUnauthorized;

const mapAnthropicError = (cause: unknown): TurnError => {
  if (isSpendLimit(cause)) return new AnthropicOutOfBudget({});

  if (cause instanceof Anthropic.APIError && cause.status !== undefined) {
    if (cause.status === 429) {
      const ra = Number(cause.headers?.get("retry-after"));

      return new AnthropicRateLimited({ retryAfterSec: Number.isFinite(ra) ? ra : null });
    }

    if (cause.status === 529) return new AnthropicOverloaded({});

    if (cause.status >= 400 && cause.status < 500) return new AnthropicRejected({ status: cause.status, message: cause.message });
  }

  return new AnthropicUnavailable({ message: cause instanceof Error ? cause.message : String(cause) });
};

export interface EffectTool<R> {
  /** Phantom, covariant: lets runTurn infer the union of every tool's requirements. */
  readonly _R?: R;
  readonly name: string;
  readonly jsonSchema: JsonSchema.JsonSchema;
  readonly build: (context: Context.Context<R>, onFatal: (e: PutioUnauthorized) => void) => BetaRunnableTool<unknown>;
}

const strictJsonSchema = (schema: Schema.Top): JsonSchema.JsonSchema => {
  const doc = Schema.toJsonSchemaDocument(schema, { onExcessProperty: "error" });

  const root: JsonSchema.JsonSchema =
    doc.schema.type === "object" ? { ...doc.schema } : { type: "object", properties: {}, required: [], additionalProperties: false };

  const problems: Array<string> = [];

  const walk = (node: JsonSchema.JsonSchema, at: string) => {
    for (const k of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "pattern", "$ref"]) {
      if (k in node) problems.push(`${at}: ${k}`);
    }

    if (node.type === "object") {
      if (node.additionalProperties !== false) problems.push(`${at}: additionalProperties not false`);
      const required = new Set(Array.isArray(node.required) ? node.required : []);

      for (const p of Object.keys(Predicate.isObjectOrArray(node.properties) ? node.properties : {})) {
        if (!required.has(p)) problems.push(`${at}.${p}: optional`);
      }
    }

    for (const [k, v] of Object.entries(node)) {
      if (Predicate.isObject(v)) walk(v, `${at}/${k}`);
      else if (Array.isArray(v)) walk(Object.fromEntries(v.entries()), `${at}/${k}`);
    }
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
  run: (input: S["Type"]) => Effect.Effect<string, PutioError, R>;
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
        run: async (args, rc) => {
          const exit = await Effect.runPromiseExit(
            def.run(args).pipe(Effect.provideContext(context)),
            rc?.signal ? { signal: rc.signal } : undefined,
          );

          if (Exit.isSuccess(exit)) return exit.value;
          const err = Cause.findErrorOption(exit.cause);

          if (Option.isNone(err)) throw new ToolError(Cause.hasInterrupts(exit.cause) ? "Interrupted." : "Tool crashed.");

          throw new ToolError(
            Match.valueTags(err.value, {
              PutioUnauthorized: (unauthorized) => {
                onFatal(unauthorized);

                return "put.io sign-in expired.";
              },
              PutioRateLimited: rateLimitMessage,
              PutioFailed: ({ message }) => message,
            }),
          );
        },
      }),
  };
};

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
  /** Weighted tokens as each request streams in, so a stopped or failed turn is still paid for. */
  readonly onUsage?: (weightedTokens: number) => void;
  /** Checked before each follow-up request; false ends the turn with its tool calls unanswered. */
  readonly canContinue?: () => boolean;
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
            let last: BetaMessage | null = null;
            const meter = usageMeter((tokens) => input.onUsage?.(tokens));

            stream.on("streamEvent", (e, snapshot) => {
              last = snapshot;

              if (e.type === "message_start" || e.type === "message_delta") meter.charge(snapshot);

              if (Date.now() - sent < input.partialEveryMs) return;
              sent = Date.now();
              Queue.offerUnsafe(queue, { type: "partial", content: snapshot.content });
            });

            const final = stream.finalMessage();

            final.catch(() => {
              if (last) meter.chargeStreamed(last);
            });

            const message = await final;

            meter.charge(message);
            Queue.offerUnsafe(queue, { type: "assistant", message });

            if (message.stop_reason === "refusal") break;

            if (message.stop_reason === "tool_use" && input.canContinue && !input.canContinue()) break;
            const results = await runner.generateToolResponse();

            if (fatal) throw fatal;

            if (results) Queue.offerUnsafe(queue, { type: "tool_results", message: results });

            if (input.canContinue && !input.canContinue()) break;
          }
        },
        catch: (e) => fatal ?? mapAnthropicError(e),
      });
      yield* Queue.end(queue);
    }),
  );
