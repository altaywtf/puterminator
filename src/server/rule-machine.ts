import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { createEffectLogic, createSnapshotCodec, setupEffect } from "@xstate/effect";
import { type EventFromLogic, isUnhandled, transition, type SnapshotFrom } from "xstate";
import { Folder } from "../shared/contract";
import { RulePreview, type RuleRecord } from "../shared/actions";
import { Criteria, intervalMs } from "./rules";

const CheckInput = Schema.Struct({ rule: Schema.String, fresh: Schema.Boolean });

export const CheckOutcome = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("none") }),
  Schema.Struct({ kind: Schema.Literal("stop"), why: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("busy"), retryAt: Schema.Finite }),
  Schema.Struct({ kind: Schema.Literal("started"), plan: Schema.String }),
]);

export type CheckOutcome = typeof CheckOutcome.Type;

/** Lists put.io, matches the rule and, when it finds work within its limits, starts the run as an ordinary plan. */
export class RuleChecks extends Context.Service<RuleChecks, { readonly check: (input: typeof CheckInput.Type) => Effect.Effect<CheckOutcome> }>()(
  "puterminator/RuleChecks",
) {}

const runCheck = createEffectLogic({
  schemas: { input: CheckInput, output: CheckOutcome },
  effect: ({ input }) => RuleChecks.use((checks) => checks.check(input)),
});

const RuleContext = Schema.Struct({
  id: Schema.String,
  criteria: Criteria,
  folder: Folder,
  preview: RulePreview,
  why: Schema.NullOr(Schema.String),
  nextAt: Schema.NullOr(Schema.Finite),
  fresh: Schema.Boolean,
  run: Schema.NullOr(Schema.String),
});

type RuleContext = typeof RuleContext.Type;

const pause = (context: RuleContext, why: string): RuleContext => ({ ...context, why, nextAt: null, fresh: false });

const RULE_MACHINE_VERSION = "1";

/**
 * A standing cleanup rule. It runs only after the person approves its preview, once per due time: `DUE` for any other
 * time is ignored, so a redelivered alarm does nothing. Each run is a plan the plan machine drives; a run with any
 * failed step, a check over the rule's limits, a pause or a restart mid-run all move it to `paused`, and only a fresh
 * preview approved again makes it run again.
 */
export const ruleMachine = setupEffect({
  schemas: {
    context: RuleContext,
    input: Schema.Struct({ id: Schema.String, criteria: Criteria, folder: Folder, preview: RulePreview }),
    events: {
      PREVIEWED: Schema.Struct({ preview: RulePreview }),
      APPROVE: Schema.Struct({ now: Schema.Finite }),
      DUE: Schema.Struct({ due: Schema.Finite }),
      RUN_SETTLED: Schema.Struct({ plan: Schema.String, failed: Schema.Boolean }),
      PAUSE: Schema.Struct({ why: Schema.String }),
      DELETE: Schema.Struct({}),
    },
  },
  actors: { runCheck },
}).createMachine({
  id: "rule",
  version: RULE_MACHINE_VERSION,
  context: ({ input }) => ({ ...input, why: null, nextAt: null, fresh: false, run: null }),
  initial: "previewed",
  states: {
    previewed: {
      on: {
        PREVIEWED: ({ context, event }) => ({ context: { ...context, preview: event.preview } }),
        APPROVE: ({ context, event }) => ({ target: "active", context: { ...context, why: null, nextAt: event.now, fresh: true } }),
      },
    },
    active: {
      initial: "waiting",
      states: {
        waiting: {
          on: {
            DUE: ({ context, event }) =>
              event.due === context.nextAt ? { target: "checking", context: { ...context, nextAt: event.due + intervalMs(context.criteria.every) } } : undefined,
          },
        },
        checking: {
          invoke: {
            src: "runCheck",
            input: ({ context }) => ({ rule: context.id, fresh: context.fresh }),
            onDone: ({ context, event }) => {
              const out = event.output;

              switch (out.kind) {
                case "none":
                  return { target: "waiting", context: { ...context, fresh: false } };
                case "busy":
                  return { target: "waiting", context: { ...context, nextAt: out.retryAt } };
                case "stop":
                  return { target: "#rule.paused", context: pause(context, out.why) };
                case "started":
                  return { target: "applying", context: { ...context, fresh: false, run: out.plan } };
              }
            },
            onError: ({ context }) => ({ target: "#rule.paused", context: pause(context, "its check crashed") }),
          },
        },
        applying: {
          on: {
            RUN_SETTLED: ({ context, event }) =>
              event.plan !== context.run ? undefined
              : event.failed ? { target: "#rule.paused", context: pause(context, "its last run had failed steps; check the receipt") }
              : { target: "waiting" },
          },
        },
      },
      on: {
        PAUSE: ({ context, event }) => ({ target: "paused", context: pause(context, event.why) }),
      },
    },
    paused: {
      on: {
        PREVIEWED: ({ context, event }) => ({ target: "previewed", context: { ...context, preview: event.preview, why: null } }),
      },
    },
    deleted: { type: "final" },
  },
  on: {
    DELETE: { target: ".deleted" },
  },
});

export type RuleSnapshot = SnapshotFrom<typeof ruleMachine>;

export type RuleEvent = EventFromLogic<typeof ruleMachine>;

export const ruleAccepts = (snapshot: RuleSnapshot, event: RuleEvent) => !isUnhandled(snapshot, transition(ruleMachine, snapshot, event));

export const isWaiting = (snapshot: RuleSnapshot) => snapshot.matches({ active: "waiting" });

export const isApplying = (snapshot: RuleSnapshot) => snapshot.matches({ active: "applying" });

export const isDeleted = (snapshot: RuleSnapshot) => snapshot.matches("deleted");

const statusOf = (snapshot: RuleSnapshot): RuleRecord["status"] =>
  snapshot.matches("active") ? (snapshot.matches({ active: "waiting" }) ? "active" : "running") : snapshot.matches("paused") ? "paused" : "previewed";

/** The rule as the browser sees it. */
export const ruleRecordOf = (snapshot: RuleSnapshot): RuleRecord => {
  const { id, criteria, folder, preview, why, nextAt, run } = snapshot.context;

  return { id, ...criteria, folder: folder.name, status: statusOf(snapshot), why, preview, nextAt: nextAt === null ? null : new Date(nextAt).toISOString(), run };
};

/** A check or run the Durable Object lost to eviction never resumes: a cut-off check waits for the next due time, and
    a cut-off run (its plan settles as interrupted) pauses the rule. */
export const settleRuleAfterRestart = (snapshot: RuleSnapshot): RuleSnapshot => {
  const resolved = ruleMachine.resolveState({ value: snapshot.value, context: snapshot.context });

  if (snapshot.matches({ active: "checking" })) return ruleMachine.resolveState({ value: { active: "waiting" }, context: snapshot.context });

  return isApplying(snapshot) ? transition(ruleMachine, resolved, { type: "PAUSE", why: "a restart cut off its last run; check the receipt" })[0] : snapshot;
};

const PersistedRule = Schema.Struct({
  status: Schema.Literals(["active", "done", "error", "stopped"]),
  value: Schema.Union([Schema.Literals(["previewed", "paused", "deleted"]), Schema.Struct({ active: Schema.Literals(["waiting", "checking", "applying"]) })]),
  context: RuleContext,
  historyValue: Schema.Record(Schema.String, Schema.Unknown),
  children: Schema.Struct({}),
  timers: Schema.Array(Schema.Unknown),
  nextTimerId: Schema.optionalKey(Schema.Finite),
  machine: Schema.Struct({ id: Schema.Literal("rule"), version: Schema.Literal(RULE_MACHINE_VERSION) }),
});

export const ruleCodec = createSnapshotCodec(ruleMachine, PersistedRule);

const toPersisted = Schema.decodeUnknownEffect(PersistedRule);

/** A check never resumes after eviction (see `settleRuleAfterRestart`), so its child isn't saved. */
export const encodeRuleSnapshot = (snapshot: RuleSnapshot) =>
  toPersisted({ ...ruleMachine.getPersistedSnapshot(snapshot), children: {} }).pipe(Effect.flatMap(ruleCodec.encode), Effect.orDie);
