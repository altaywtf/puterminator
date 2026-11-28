import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { createEffectLogic, createSnapshotCodec, setupEffect } from "@xstate/effect";
import { isUnhandled, transition } from "xstate";
import type { EventFromLogic, SnapshotFrom } from "xstate";
import { Folder } from "../shared/contract";
import { RulePreview } from "../shared/actions";
import type { RuleRecord } from "../shared/actions";
import { Criteria, intervalMs } from "./rules";

const CheckInput = Schema.Struct({ rule: Schema.String, fresh: Schema.Boolean });

export const CheckOutcome = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("none") }),
  Schema.Struct({ kind: Schema.Literal("stop"), why: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("later"), retryAt: Schema.Finite }),
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
  guards: Schema.Array(Schema.Struct({ path: Schema.String, id: Schema.Finite })),
  why: Schema.NullOr(Schema.String),
  nextAt: Schema.NullOr(Schema.Finite),
  fresh: Schema.Boolean,
  starting: Schema.NullOr(Schema.String),
  runs: Schema.Array(Schema.String),
});

type RuleContext = typeof RuleContext.Type;

const pause = (context: RuleContext, why: string): RuleContext => ({ ...context, why, nextAt: null, fresh: false, starting: null });

const KEPT_RUNS = 5;

const CUT_OFF = "a restart cut off its last run; check the receipt";

const RULE_MACHINE_VERSION = "1";

/**
 * A standing cleanup rule. It runs only after the person approves the preview they saw, once per due time: `DUE` for
 * any other time is ignored, so a redelivered alarm does nothing. The check records the plan it is about to start
 * (`STARTING`) before starting it, so a restart can tell a cut-off run from a cut-off check. Each run is a plan the
 * plan machine drives; a run with any failed step, a check over the rule's limits, a pause or a restart mid-run all
 * move it to `paused`, and only a fresh preview approved again makes it run again.
 */
export const ruleMachine = setupEffect({
  schemas: {
    context: RuleContext,
    input: Schema.Struct({ id: Schema.String, criteria: Criteria, folder: Folder, preview: RulePreview, guards: Schema.Array(Schema.Struct({ path: Schema.String, id: Schema.Finite })) }),
    events: {
      PREVIEWED: Schema.Struct({ preview: RulePreview }),
      APPROVE: Schema.Struct({ now: Schema.Finite, preview: Schema.String }),
      STARTING: Schema.Struct({ plan: Schema.String }),
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
  context: ({ input }) => ({ ...input, why: null, nextAt: null, fresh: false, starting: null, runs: [] }),
  initial: "previewed",
  states: {
    previewed: {
      on: {
        PREVIEWED: ({ context, event }) => ({ context: { ...context, preview: event.preview } }),
        PAUSE: ({ context, event }) => ({ target: "paused", context: pause(context, event.why) }),
        APPROVE: ({ context, event }) =>
          event.preview === context.preview.at ? { target: "active", context: { ...context, why: null, nextAt: event.now, fresh: true } } : undefined,
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
                  return { target: "waiting", context: { ...context, fresh: false, starting: null } };
                case "later":
                  return { target: "waiting", context: { ...context, nextAt: out.retryAt, starting: null } };
                case "stop":
                  return { target: "#rule.paused", context: pause(context, out.why) };
                case "started":
                  return out.plan === context.starting
                    ? { target: "applying", context: { ...context, fresh: false, starting: null, runs: [out.plan, ...context.runs].slice(0, KEPT_RUNS) } }
                    : { target: "#rule.paused", context: pause(context, "its check crashed") };
              }
            },
            onError: ({ context }) => ({ target: "#rule.paused", context: pause(context, "its check crashed") }),
          },
          on: {
            STARTING: ({ context, event }) => ({ context: { ...context, starting: event.plan } }),
          },
        },
        applying: {
          on: {
            RUN_SETTLED: ({ context, event }) =>
              event.plan !== context.runs[0] ? undefined
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
        PAUSE: ({ context, event }) => ({ context: { ...context, why: event.why } }),
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
  const { id, criteria, folder, preview, why, nextAt, runs } = snapshot.context;

  return { id, ...criteria, folder: folder.name, status: statusOf(snapshot), why, preview, nextAt: nextAt === null ? null : new Date(nextAt).toISOString(), runs };
};

/** A check or run the Durable Object lost to eviction never resumes: a check cut off before `STARTING` waits for the
    next due time, and a cut-off run (its plan settles as interrupted) pauses the rule. */
export const settleRuleAfterRestart = (snapshot: RuleSnapshot): RuleSnapshot => {
  const resolved = ruleMachine.resolveState({ value: snapshot.value, context: snapshot.context });
  const cutOffCheck = snapshot.matches({ active: "checking" }) && snapshot.context.starting === null;

  if (cutOffCheck) return ruleMachine.resolveState({ value: { active: "waiting" }, context: snapshot.context });

  if (!snapshot.matches("active") || isWaiting(snapshot)) return snapshot;
  const { starting, runs } = snapshot.context;
  const kept = starting === null ? resolved : ruleMachine.resolveState({ value: snapshot.value, context: { ...snapshot.context, runs: [starting, ...runs].slice(0, KEPT_RUNS) } });

  return transition(ruleMachine, kept, { type: "PAUSE", why: CUT_OFF })[0];
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
