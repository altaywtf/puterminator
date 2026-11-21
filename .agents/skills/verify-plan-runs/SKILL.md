---
name: verify-plan-runs
description: Model-check the plan run engine (apply, stop, retry, undo, eviction, standing-rule alarms) with TLA+. Use when a change touches how plan steps run, fail, stop, retry or undo in conversation.ts, when a rule's alarm starts a run (rule-machine.ts, ruleDue, checkDue), undoChanges or staleChanges in changes.ts, or maybeApplied and error mapping in putio.ts.
---

# Verify plan runs

[`PlanRuns.tla`](PlanRuns.tla) models one plan's runs against put.io. TLC checks every order of user frames, write outcomes, stops and evictions for 3 steps (2 of them trash) and up to 2 retries. Its `Apply` is any start of a run, from an `apply` frame or from a rule's alarm.

[`RuleRuns.tla`](RuleRuns.tla) models one standing rule and the runs its alarm starts, with each run's plan reduced to running, then settled with or without a failed step. TLC checks every order of alarm deliveries, checks, pauses, previews, approvals, run outcomes and evictions for 4 due times.

## The promises

| Invariant | Promise | Harm if broken |
| --- | --- | --- |
| `NoSilentWrite` | A step reaches put.io at most once per apply, retry or undo frame, or rule alarm, that queued it. | The library changes without a click: a lost write gets sent again. |
| `UndoSeesEveryWrite` | After a run, every step whose write may have landed is `done` or failed with `maybeApplied`. | Undo skips a change put.io made, and the library keeps it. |
| `UndoLeavesNothing` | An undo whose steps all finished leaves every touched file as it was before the apply. | The user trusts "undone" while files stay moved, renamed or trashed. |
| `NoOrphanRunning` | With no run fiber, no step is still `running`. | A dead run blocks retry and undo, and its step's fate stays unknown. |
| `OneRunPerDue` (rule) | A rule starts at most one run per due time, however often its alarm is delivered. | A redelivered alarm trashes a second batch nobody approved. |
| `NoRunWithoutApproval` (rule) | After a pause, a safety stop, a failed run or a run cut off by eviction, the rule starts nothing until a fresh preview is approved. | A rule keeps trashing after something went wrong. |

## Does a change touch it?

Covered code, last confirmed against commit `6b1ce1f`:

| Model | Code |
| --- | --- |
| `Deliver`, `Issue` | `DUE` in [`rule-machine.ts`](../../../src/server/rule-machine.ts), accepted only for `nextAt`, which it advances; `ruleDue` and `syncSchedule` in `conversation.ts` |
| `CheckLater`, `CheckNothing`, `CheckStop` | the `later`, `none` and `stop` outcomes of `checkDue` |
| `Mark`, `Launch`, `Fizzle`, `Started` | `STARTING`, then `storePlan` and `applyAll` in `checkDue`; a refused start (`discard`, `later`); the `started` outcome |
| `PlanEnds`, `Settle` | the rule plan settling (`persistPlan`, `settleRuleRun`, `RUN_SETTLED`) |
| `Pause`, `Preview`, `Approve` | `PAUSE` (frame, sign-out); `resumeRule` and `PREVIEWED`; `APPROVE` with the shown `preview.at`, refused while the latest run is running (`ruleFrame`) |
| `Evict` | `settleRuleAfterRestart` |
| `Apply`, `Retry`, `Undo` | `APPLY`, `RETRY`, `UNDO` in [`plan-machine.ts`](../../../src/server/plan-machine.ts); `startRun`, `apply`, `retry`, `undo` and their `receive` cases (`apply`, `retry`, `undo`, `stopRun`) in [`conversation.ts`](../../../src/server/conversation.ts) |
| `InUndo` | `undoChanges` in [`changes.ts`](../../../src/server/changes.ts) |
| `PrecheckPass`, `PrecheckFail` | `runPlan`: `refused`, the opening `scanFolder(folder)` and its listing, `trashed`, `staleChanges`, `trashEnabled`, `finish(error)` |
| `StartStep`, `WriteOk`, `WriteRefused`, `WriteLost` | `runPlan` loop: `setStep(…, "running")` (a `STEP` the plan's actor acknowledges before the write), `applyChange`, `failStep`; `maybeApplied` and the 4xx-means-refused rule in [`putio.ts`](../../../src/server/putio.ts) |
| `LoopDone`, `Finish` | the closing `rescan` of the run's folder, the restore rechecks against its listing, `finish(null)` (`FINISH`) |
| `Halt` | `STOP`, the runner's `onDone` and `onError` (stop, crash), and `INTERRUPTED` through `settleAfterRestart` (eviction) in `plan-machine.ts`; any `STEP` acknowledgement is a point where a stop lands |
| `FailUnfinished`, `FailUnfinishedMaybe`, `SetCur` | `failUnfinished`, `setStep` in `plan-machine.ts` |

[`plan-machine.test.ts`](../../../src/server/plan-machine.test.ts) checks the machine allows exactly the model's status transitions. Change it with the model.

See what changed since the sync commit:

```bash
git diff 6b1ce1f -- src/server/conversation.ts src/server/plan-machine.ts src/server/rule-machine.ts src/server/changes.ts src/server/putio.ts
```

The change touches the verification when a hunk lands in a function in the table.

## Run it

```bash
.agents/skills/verify-plan-runs/check.sh
```

It needs Java 11 or newer. It downloads TLC 1.7.4 once into `~/.cache/tla2tools`, checks the jar's SHA-256, and finishes in a few seconds. It checks both models in turn; a pass prints `Model checking completed. No error has been found.` under each `== <model>` line.

## Read a failure

TLC prints `Invariant <name> is violated` and the shortest trace from `Init`. Retell it as steps in the code's words: each state's action name maps through the table above. `step`, `ustep` are the apply and undo runs' step states, `maybe`/`umaybe` are `maybeApplied`, `lib` is whether put.io holds the changed (`"changed"`) or original (`"orig"`) file, and `fiber` is where the run's fiber waits.

- **Real bug**: every transition in the trace can happen in the code. Report it with the trace in plain steps, the invariant's promise and its harm. Leave the invariant and the product code as they are unless the user asks for a fix.
- **Modeling error**: a transition can't happen in the code (an action allows an order the code forbids). Fix the action so it matches the code, and say what you changed.

## Change the model with the code

When a change in the table is intended, mirror it in the matching action, then run `check.sh`. Change an invariant only when the product promise itself changes, and tell the user which promise moved.

After editing the model, prove the check can still fail: break the matching action as below in a scratch copy and confirm the named invariant goes red.

| Break | Invariant that catches it |
| --- | --- |
| `FailUnfinishedMaybe(s, m) == m` (stop forgets a running write) | `UndoSeesEveryWrite` |
| `Retry` re-queues failed steps with `maybe` cleared | `UndoSeesEveryWrite` |
| `InUndo(st, mb) == st = "done"` | `UndoLeavesNothing` |
| `WriteLost` sets the step back to `"queued"` | `NoSilentWrite` |
| `FailUnfinished` leaves `"running"` steps alone | `NoOrphanRunning` |
| `Deliver` drops `d = nextDue` | `OneRunPerDue` |
| `Evict` sends a cut-off `checking` rule back to `waiting` whatever its `phase` | `NoRunWithoutApproval` |
| `Settle` ignores `failed` | `NoRunWithoutApproval` |
| `Approve` drops `plan # "running"` | `NoRunWithoutApproval` |

Move the sync commit in the table above forward only after confirming the model matches the code at the new commit.

## Scope

- One plan, 3 steps, 2 of them trash, at most 2 retries; one rule, 4 due times. Runs on two plans at once are left out: the `plans` region of [`activity-machine.ts`](../../../src/server/activity-machine.ts) keeps them apart, and the runner sends `RUN_ENDED` only once it has exited.
- A 4xx from put.io means the write did not happen. A lost response or a stopped or evicted request may or may not have landed.
- Left out: translate steps (parallel uploads, subtitle ids saved after the upload), the video-then-subtitle ordering in `failedVideos`, folder creation inside a move, unticked changes, and the snapshot rescans themselves. A pass says nothing about those paths.
