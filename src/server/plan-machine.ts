import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Schema from "effect/Schema";
import { createEffectLogic, createSnapshotCodec, setupEffect } from "@xstate/effect";
import { isUnhandled, transition } from "xstate";
import type { EventFromLogic, SnapshotFrom } from "xstate";
import { PlanRecord, Run, StepState } from "../shared/actions";
import type { Plan } from "../shared/actions";

type Step = Run["steps"][number];

const PlanStatus = PlanRecord.fields.status;

type PlanStatus = typeof PlanStatus.Type;

const StepsInput = Schema.Struct({ plan: Schema.String, eitherEnd: Schema.Boolean, undoing: Schema.Boolean });

/** Runs a plan's queued steps against put.io. It sends the plan's actor each step's progress before acting on it, and
    `FINISH` once the steps ran or a check refused them. */
export class PlanSteps extends Context.Service<PlanSteps, { readonly run: (input: typeof StepsInput.Type) => Effect.Effect<void> }>()(
  "puterminator/PlanSteps",
) {}

const runSteps = createEffectLogic({
  schemas: { input: StepsInput },
  effect: ({ input }) => PlanSteps.use((steps) => steps.run(input)),
});

const PlanContext = Schema.Struct({
  plan: Schema.String,
  run: Schema.NullOr(Run),
  undo: Schema.NullOr(Run),
  eitherEnd: Schema.Boolean,
});

type PlanContext = typeof PlanContext.Type;

const StepEvent = Schema.Struct({
  change: Schema.String,
  state: StepState,
  error: Schema.NullOr(Schema.String),
  maybeApplied: Schema.Boolean,
});

const failUnfinished = (run: Run, error: string): Run => ({
  ...run,
  steps: run.steps.map((s) =>
    Match.value(s.state).pipe(
      Match.withReturnType<Step>(),
      Match.when("running", () => ({ ...s, state: "failed", error, maybeApplied: true })),
      Match.when("queued", () => ({ ...s, state: "failed", error })),
      Match.orElse(() => s),
    ),
  ),
});

const requeueFailed = (run: Run): Run => ({ ...run, steps: run.steps.map((s) => (s.state === "failed" ? { ...s, state: "queued", error: null } : s)) });

const setStep = (run: Run, event: typeof StepEvent.Type): Run => ({
  ...run,
  steps: run.steps.map((s) => {
    if (s.change !== event.change) return s;
    const step = { change: s.change, state: event.state, error: event.error };

    return event.maybeApplied || s.maybeApplied ? { ...step, maybeApplied: true } : step;
  }),
});

const withRun = (context: PlanContext, f: (run: Run) => Run): PlanContext => (context.run ? { ...context, run: f(context.run) } : context);
const withUndo = (context: PlanContext, f: (run: Run) => Run): PlanContext => (context.undo ? { ...context, undo: f(context.undo) } : context);

const PLAN_MACHINE_VERSION = "1";

/**
 * A plan's lifecycle. Only browser frames move it past `proposed`; while `applying` or `undoing` it invokes the step
 * runner, and stop, a crashed runner or a restart all fail the unfinished steps and settle the run.
 */
export const planMachine = setupEffect({
  schemas: {
    context: PlanContext,
    input: Schema.Struct({ plan: Schema.String }),
    events: {
      APPLY: Schema.Struct({ run: Run }),
      DISCARD: Schema.Struct({}),
      RETRY: Schema.Struct({}),
      UNDO: Schema.Struct({ undo: Run }),
      STEP: StepEvent,
      FINISH: Schema.Struct({ error: Schema.NullOr(Schema.String) }),
      STOP: Schema.Struct({}),
      INTERRUPTED: Schema.Struct({}),
    },
  },
  actors: { runSteps },
}).createMachine({
  id: "plan",
  version: PLAN_MACHINE_VERSION,
  context: ({ input }) => ({ plan: input.plan, run: null, undo: null, eitherEnd: false }),
  initial: "proposed",
  states: {
    proposed: {
      on: {
        APPLY: ({ context, event }) => (event.run.steps.length > 0 ? { target: "applying", context: { ...context, run: event.run, eitherEnd: false } } : undefined),
        DISCARD: { target: "discarded" },
      },
    },
    discarded: {},
    applying: {
      invoke: {
        src: "runSteps",
        input: ({ context }) => ({ plan: context.plan, eitherEnd: context.eitherEnd, undoing: false }),
        onDone: ({ context }) => ({ target: "done", context: withRun(context, (r) => failUnfinished(r, "stopped")) }),
        onError: ({ context }) => ({ target: "done", context: withRun(context, (r) => failUnfinished(r, "stopped")) }),
      },
      on: {
        STEP: ({ context, event }) => ({ context: withRun(context, (r) => setStep(r, event)) }),
        FINISH: ({ context, event }) => ({ target: "done", context: event.error === null ? context : withRun(context, (r) => failUnfinished(r, event.error ?? "")) }),
        STOP: ({ context }) => ({ target: "done", context: withRun(context, (r) => failUnfinished(r, "stopped")) }),
        INTERRUPTED: ({ context }) => ({ target: "done", context: withRun(context, (r) => failUnfinished(r, "interrupted")) }),
      },
    },
    done: {
      on: {
        RETRY: ({ context }) => ({ target: "applying", context: { ...withRun(context, requeueFailed), eitherEnd: true } }),
        UNDO: ({ context, event }) => (event.undo.steps.length > 0 ? { target: "undoing", context: { ...context, undo: event.undo, eitherEnd: true } } : undefined),
      },
    },
    undoing: {
      invoke: {
        src: "runSteps",
        input: ({ context }) => ({ plan: context.plan, eitherEnd: context.eitherEnd, undoing: true }),
        onDone: ({ context }) => ({ target: "undone", context: withUndo(context, (r) => failUnfinished(r, "stopped")) }),
        onError: ({ context }) => ({ target: "undone", context: withUndo(context, (r) => failUnfinished(r, "stopped")) }),
      },
      on: {
        STEP: ({ context, event }) => ({ context: withUndo(context, (r) => setStep(r, event)) }),
        FINISH: ({ context, event }) => ({ target: "undone", context: event.error === null ? context : withUndo(context, (r) => failUnfinished(r, event.error ?? "")) }),
        STOP: ({ context }) => ({ target: "undone", context: withUndo(context, (r) => failUnfinished(r, "stopped")) }),
        INTERRUPTED: ({ context }) => ({ target: "undone", context: withUndo(context, (r) => failUnfinished(r, "interrupted")) }),
      },
    },
    undone: {
      on: {
        RETRY: ({ context }) => ({ target: "undoing", context: { ...withUndo(context, requeueFailed), eitherEnd: true } }),
      },
    },
  },
});

export type PlanSnapshot = SnapshotFrom<typeof planMachine>;

const planStatus = (snapshot: PlanSnapshot): PlanStatus => Schema.decodeUnknownSync(PlanStatus)(snapshot.value);

export type PlanEvent = EventFromLogic<typeof planMachine>;

export const isRunning = (snapshot: PlanSnapshot) => snapshot.matches("applying") || snapshot.matches("undoing");

export const accepts = (snapshot: PlanSnapshot, event: PlanEvent) => !isUnhandled(snapshot, transition(planMachine, snapshot, event));

/** The record the browser sees, read off the machine. */
export const recordOf = (plan: Plan, snapshot: PlanSnapshot): PlanRecord => {
  const { run, undo } = snapshot.context;
  const status = planStatus(snapshot);

  return undo === null ? { plan, status, run } : { plan, status, run, undo };
};

/** A plan saved before plans were machines, or whose snapshot no longer decodes, resumes from its status. */
export const fromRecord = (record: PlanRecord): PlanSnapshot =>
  planMachine.resolveState({ value: record.status, context: { plan: record.plan.id, run: record.run, undo: record.undo ?? null, eitherEnd: false } });

/** A run the Durable Object lost to eviction can't resume: its unfinished steps fail as interrupted. */
export const settleAfterRestart = (snapshot: PlanSnapshot): PlanSnapshot =>
  isRunning(snapshot) ? transition(planMachine, planMachine.resolveState({ value: snapshot.value, context: snapshot.context }), { type: "INTERRUPTED" })[0] : snapshot;

const PersistedPlan = Schema.Struct({
  status: Schema.Literals(["active", "done", "error", "stopped"]),
  value: PlanStatus,
  context: PlanContext,
  historyValue: Schema.Record(Schema.String, Schema.Unknown),
  children: Schema.Struct({}),
  timers: Schema.Array(Schema.Unknown),
  nextTimerId: Schema.optionalKey(Schema.Finite),
  machine: Schema.Struct({ id: Schema.Literal("plan"), version: Schema.Literal(PLAN_MACHINE_VERSION) }),
});

export const planCodec = createSnapshotCodec(planMachine, PersistedPlan);

const toPersisted = Schema.decodeUnknownEffect(PersistedPlan);

/** A run never resumes after eviction (see `settleAfterRestart`), so the step runner child isn't saved. */
export const encodeSnapshot = (snapshot: PlanSnapshot) => toPersisted({ ...planMachine.getPersistedSnapshot(snapshot), children: {} }).pipe(Effect.flatMap(planCodec.encode), Effect.orDie);
