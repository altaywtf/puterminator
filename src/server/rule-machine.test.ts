import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import { initialTransition, transition } from "xstate";
import { encodeRuleSnapshot, ruleCodec, ruleMachine, ruleRecordOf, settleRuleAfterRestart } from "./rule-machine";

const input = {
  id: "r1",
  criteria: { title: "old films", within: ["/Movies"], openedDaysAgo: 30, protect: [], cap: 10, every: "day" as const },
  folder: { id: 0, name: "Your Files" },
  preview: { at: "2026-11-21T00:00:00.000Z", count: 1, bytes: 1, sample: ["a.mkv"], ids: [7] },
};

const [previewed] = initialTransition(ruleMachine, input);
const active = transition(ruleMachine, previewed, { type: "APPROVE", now: 1000 })[0];
const checking = transition(ruleMachine, active, { type: "DUE", due: 1000 })[0];
const applying = ruleMachine.resolveState({ value: { active: "applying" }, context: { ...checking.context, run: "p1" } });

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

  it("settles a check cut off by eviction back to waiting, and a cut-off run to paused", async () => {
    expect((await reloaded(checking)).value).toEqual({ active: "waiting" });
    const paused = await reloaded(applying);
    expect(ruleRecordOf(paused)).toMatchObject({ status: "paused", why: "a restart cut off its last run; check the receipt", nextAt: null, run: "p1" });
  });

  it("runs again only after a fresh preview is approved", () => {
    const paused = transition(ruleMachine, active, { type: "PAUSE", why: "paused by you" })[0];
    expect(transition(ruleMachine, paused, { type: "APPROVE", now: 2000 })[0].value).toBe("paused");
    const fresh = transition(ruleMachine, paused, { type: "PREVIEWED", preview: { ...input.preview, ids: [] } })[0];
    expect(transition(ruleMachine, fresh, { type: "APPROVE", now: 2000 })[0].context).toMatchObject({ nextAt: 2000, fresh: true, why: null });
  });
});
