import * as Effect from "effect/Effect";
import { createEffectActor, sendAndAwait, waitFor } from "@xstate/effect";
import { describe, expect, it } from "vitest";
import { initialTransition, transition } from "xstate";
import {
  encodeRuleSnapshot,
  RuleChecks,
  ruleCodec,
  ruleMachine,
  ruleRecordOf,
  settleRuleAfterRestart,
} from "./rule-machine";
import type { CheckOutcome } from "./rule-machine";

const input = {
  id: "r1",
  criteria: { title: "old films", within: ["/Movies"], openedDaysAgo: 30, protect: [], cap: 10, every: "day" as const },
  folder: { id: 0, name: "Your Files" },
  preview: { at: "2026-11-21T00:00:00.000Z", count: 1, bytes: 1, sample: ["a.mkv"], ids: [7] },
  guards: [],
};

const [previewed] = initialTransition(ruleMachine, input);
const active = transition(ruleMachine, previewed, { type: "APPROVE", now: 1000, preview: input.preview.at })[0];
const checking = transition(ruleMachine, active, { type: "DUE", due: 1000 })[0];
const starting = transition(ruleMachine, checking, { type: "STARTING", plan: "p1" })[0];
const applying = ruleMachine.resolveState({ value: { active: "applying" }, context: { ...checking.context, runs: ["p1"] } });

const checkWith = (outcome: CheckOutcome) =>
  Effect.gen(function* () {
    const actor = yield* createEffectActor(ruleMachine, { snapshot: ruleMachine.getPersistedSnapshot(active) });
    yield* sendAndAwait(actor, { type: "DUE", due: 1000 });

    return yield* waitFor(actor, (s) => !s.matches({ active: "checking" }));
  }).pipe(Effect.provideService(RuleChecks, { check: () => Effect.succeed(outcome) }), Effect.scoped, Effect.runPromise);

const reloaded = async (snapshot: typeof previewed) => {
  const decoded = await Effect.runPromise(encodeRuleSnapshot(snapshot).pipe(Effect.flatMap(ruleCodec.decode)));

  return settleRuleAfterRestart(ruleMachine.resolveState({ value: decoded.value, context: decoded.context }));
};

describe("rule machine", () => {
  it("ignores an alarm for any time but the next due one", () => {
    expect(transition(ruleMachine, active, { type: "DUE", due: 999 })[0].value).toEqual({ active: "waiting" });
    expect(checking.value).toEqual({ active: "checking" });
    expect(checking.context.nextAt).toBe(1000 + 86_400_000);
  });

  it("settles a check cut off by eviction back to waiting, and a run cut off at or after its start to paused", async () => {
    expect((await reloaded(checking)).value).toEqual({ active: "waiting" });
    expect(ruleRecordOf(await reloaded(starting))).toMatchObject({ status: "paused", why: "a restart cut off its last run; check the receipt", runs: ["p1"] });
    expect(ruleRecordOf(await reloaded(applying))).toMatchObject({ status: "paused", why: "a restart cut off its last run; check the receipt", nextAt: null, runs: ["p1"] });
  });

  it("keeps the first run's drift check when a check has to try again later", async () => {
    const later = await checkWith({ kind: "later", retryAt: 5000 });
    expect(later.value).toEqual({ active: "waiting" });
    expect(later.context).toMatchObject({ fresh: true, nextAt: 5000 });
  });

  it("keeps a plan out of its receipts until the plan has started", () => {
    expect(starting.context).toMatchObject({ starting: "p1", runs: [] });
  });

  it("ignores an approval of any preview but the one it holds", () => {
    expect(transition(ruleMachine, previewed, { type: "APPROVE", now: 1000, preview: "stale" })[0].value).toBe("previewed");
  });

  it("runs again only after a fresh preview is approved", () => {
    const paused = transition(ruleMachine, active, { type: "PAUSE", why: "paused by you" })[0];
    expect(transition(ruleMachine, paused, { type: "APPROVE", now: 2000, preview: input.preview.at })[0].value).toBe("paused");
    const fresh = transition(ruleMachine, paused, { type: "PREVIEWED", preview: { ...input.preview, at: "later", ids: [] } })[0];
    expect(transition(ruleMachine, fresh, { type: "APPROVE", now: 2000, preview: "later" })[0].context).toMatchObject({ nextAt: 2000, fresh: true, why: null });
  });
});
