import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import { createEffectActor, sendAndAwait, waitFor } from "@xstate/effect";
import { describe, expect, it } from "vitest";
import { isUnhandled, transition } from "xstate";
import type { Run } from "../shared/actions";
import { isRunning, type PlanEvent, planMachine, type PlanSnapshot, PlanSteps } from "./plan-machine";

const STATUSES = ["proposed", "discarded", "applying", "done", "undoing", "undone"] as const;

const run = (states: ReadonlyArray<Run["steps"][number]["state"]>, maybe: ReadonlyArray<boolean> = []): Run => ({
  id: "p",
  title: "t",
  changes: states.map((_, i) => ({ id: `c${i}`, op: "trash", path: `/f${i}`, to: null, bytes: 1 })),
  steps: states.map((state, i) => (maybe[i] ? { change: `c${i}`, state, error: state === "failed" ? "x" : null, maybeApplied: true } : { change: `c${i}`, state, error: state === "failed" ? "x" : null })),
});

const resolved = (value: (typeof STATUSES)[number], context: Partial<PlanSnapshot["context"]> = {}) =>
  planMachine.resolveState({ value, context: { plan: "p", run: run(["done", "failed"]), undo: value === "undoing" || value === "undone" ? run(["done", "failed"]) : null, eitherEnd: false, ...context } });

const at = (value: (typeof STATUSES)[number], context: Partial<PlanSnapshot["context"]> = {}) =>
  Match.value(value).pipe(
    Match.when("applying", () => transition(planMachine, resolved("proposed", context), { type: "APPLY", run: context.run ?? run(["queued"]) })[0]),
    Match.when("undoing", () => transition(planMachine, resolved("done", context), { type: "UNDO", undo: context.undo ?? run(["queued"]) })[0]),
    Match.orElse(() => resolved(value, context)),
  );

const events: ReadonlyArray<[string, PlanEvent]> = [
  ["APPLY", { type: "APPLY", run: run(["queued"]) }],
  ["DISCARD", { type: "DISCARD" }],
  ["RETRY", { type: "RETRY" }],
  ["UNDO", { type: "UNDO", undo: run(["queued"]) }],
  ["STEP", { type: "STEP", change: "c0", state: "running", error: null, maybeApplied: false }],
  ["FINISH", { type: "FINISH", error: null }],
  ["STOP", { type: "STOP" }],
  ["INTERRUPTED", { type: "INTERRUPTED" }],
];

const settleWithRunner = (value: "applying" | "undoing", name: string, runner: Effect.Effect<void>) =>
  Effect.gen(function* () {
    const actor = yield* createEffectActor(planMachine, { snapshot: planMachine.getPersistedSnapshot(at(value === "applying" ? "proposed" : "done")) }).pipe(
      Effect.provideService(PlanSteps, { run: () => runner }),
    );

    yield* sendAndAwait(actor, value === "applying" ? { type: "APPLY", run: run(["queued"]) } : { type: "UNDO", undo: run(["queued"]) });
    const settled = yield* waitFor(actor, (s) => !isRunning(s));

    return `${value} --${name}--> ${String(settled.value)}`;
  }).pipe(Effect.scoped, Effect.runPromise);

const MODEL: ReadonlyArray<readonly [string, string, string, string]> = [
  ["Apply", "proposed", "APPLY", "applying"],
  ["Retry", "done", "RETRY", "applying"],
  ["Retry", "undone", "RETRY", "undoing"],
  ["Undo", "done", "UNDO", "undoing"],
  ["StartStep, WriteOk, WriteRefused, WriteLost", "applying", "STEP", "applying"],
  ["StartStep, WriteOk, WriteRefused, WriteLost", "undoing", "STEP", "undoing"],
  ["PrecheckFail, Finish", "applying", "FINISH", "done"],
  ["PrecheckFail, Finish", "undoing", "FINISH", "undone"],
  ["Halt (stop)", "applying", "STOP", "done"],
  ["Halt (stop)", "undoing", "STOP", "undone"],
  ["Halt (eviction)", "applying", "INTERRUPTED", "done"],
  ["Halt (eviction)", "undoing", "INTERRUPTED", "undone"],
  ["Halt (crash)", "applying", "runner done", "done"],
  ["Halt (crash)", "undoing", "runner done", "undone"],
  ["Halt (crash)", "applying", "runner error", "done"],
  ["Halt (crash)", "undoing", "runner error", "undone"],
];

const OUTSIDE_MODEL = [["discard", "proposed", "DISCARD", "discarded"]] as const;

const stepsOf = (snapshot: PlanSnapshot, undoing: boolean) => (undoing ? snapshot.context.undo : snapshot.context.run)?.steps.map((s) => [s.state, s.maybeApplied === true]);

describe("plan machine", () => {
  it("allows exactly the transitions of the PlanRuns.tla model, plus discard", async () => {
    const allowed = STATUSES.flatMap((value) =>
      events.flatMap(([name, event]) => {
        const before = at(value);
        const result = transition(planMachine, before, event);

        return isUnhandled(before, result) ? [] : [`${value} --${name}--> ${String(result[0].value)}`];
      }),
    );

    for (const value of ["applying", "undoing"] as const) {
      allowed.push(await settleWithRunner(value, "runner done", Effect.void), await settleWithRunner(value, "runner error", Effect.die(new Error("crash"))));
    }

    expect(allowed.sort()).toEqual([...MODEL, ...OUTSIDE_MODEL].map(([, from, event, to]) => `${from} --${event}--> ${to}`).sort());
  });

  it("refuses an apply or undo with no steps, as the model's Undo needs a step to reverse", () => {
    for (const [value, event] of [
      ["proposed", { type: "APPLY", run: run([]) }],
      ["done", { type: "UNDO", undo: run([]) }],
    ] as const) {
      const before = at(value);

      expect(isUnhandled(before, transition(planMachine, before, event))).toBe(true);
    }
  });

  it("halts like the model: a running step may have landed, a queued one did not", () => {
    for (const [value, undoing] of [
      ["applying", false],
      ["undoing", true],
    ] as const) {
      const steps = run(["done", "running", "queued", "failed"], [false, false, false, true]);
      const before = at(value, undoing ? { undo: steps } : { run: steps });

      for (const event of [{ type: "STOP" }, { type: "INTERRUPTED" }] as const) {
        expect(stepsOf(transition(planMachine, before, event)[0], undoing)).toEqual([
          ["done", false],
          ["failed", true],
          ["failed", false],
          ["failed", true],
        ]);
      }
    }
  });

  it("keeps a lost write's maybeApplied through a retry, and requeues only failed steps", () => {
    const steps = run(["done", "failed", "failed"], [false, true, false]);
    const [next] = transition(planMachine, at("done", { run: steps }), { type: "RETRY" });

    expect([next.value, next.context.eitherEnd, stepsOf(next, false)]).toEqual([
      "applying",
      true,
      [
        ["done", false],
        ["queued", true],
        ["queued", false],
      ],
    ]);
  });
});
