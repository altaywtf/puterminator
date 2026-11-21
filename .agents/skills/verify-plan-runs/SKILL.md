---
name: verify-plan-runs
description: Model-check the plan run engine (apply, stop, retry, undo, eviction) with TLA+. Use when a change touches how plan steps run, fail, stop, retry or undo in conversation.ts, undoChanges or staleChanges in changes.ts, or maybeApplied and error mapping in putio.ts.
---

# Verify plan runs

[`PlanRuns.tla`](PlanRuns.tla) models one plan's runs against put.io. TLC checks every order of user frames, write outcomes, stops and evictions for 3 steps (2 of them trash) and up to 2 retries.

## The promises

| Invariant | Promise | Harm if broken |
| --- | --- | --- |
| `NoSilentWrite` | A step reaches put.io at most once per apply, retry or undo frame that queued it. | The library changes without a click: a lost write gets sent again. |
| `UndoSeesEveryWrite` | After a run, every step whose write may have landed is `done` or failed with `maybeApplied`. | Undo skips a change put.io made, and the library keeps it. |
| `UndoLeavesNothing` | An undo whose steps all finished leaves every touched file as it was before the apply. | The user trusts "undone" while files stay moved, renamed or trashed. |
| `NoOrphanRunning` | With no run fiber, no step is still `running`. | A dead run blocks retry and undo, and its step's fate stays unknown. |

## Does a change touch it?

Covered code, last confirmed against commit `b6fb0c4`:

| Model | Code |
| --- | --- |
| `Apply`, `Retry`, `Undo` | `APPLY`, `RETRY`, `UNDO` in [`plan-machine.ts`](../../../src/server/plan-machine.ts); `startRun`, `apply`, `retry`, `undo` and their `receive` cases (`apply`, `retry`, `undo`, `stopRun`) in [`conversation.ts`](../../../src/server/conversation.ts) |
| `InUndo` | `undoChanges` in [`changes.ts`](../../../src/server/changes.ts) |
| `PrecheckPass`, `PrecheckFail` | `runPlan`: `refused`, the opening `scan`, `trashed`, `staleChanges`, `trashEnabled`, `finish(error)` |
| `StartStep`, `WriteOk`, `WriteRefused`, `WriteLost` | `runPlan` loop: `setStep(…, "running")` (a `STEP` the plan's actor acknowledges before the write), `applyChange`, `failStep`; `maybeApplied` and the 4xx-means-refused rule in [`putio.ts`](../../../src/server/putio.ts) |
| `LoopDone`, `Finish` | the closing `scan`, the restore rechecks, `finish(null)` (`FINISH`) |
| `Halt` | `STOP`, the runner's `onDone` and `onError` (stop, crash), and `INTERRUPTED` through `settleAfterRestart` (eviction) in `plan-machine.ts`; any `STEP` acknowledgement is a point where a stop lands |
| `FailUnfinished`, `FailUnfinishedMaybe`, `SetCur` | `failUnfinished`, `setStep` in `plan-machine.ts` |

[`plan-machine.test.ts`](../../../src/server/plan-machine.test.ts) checks the machine allows exactly the model's status transitions. Change it with the model.

See what changed since the sync commit:

```bash
git diff b6fb0c4 -- src/server/conversation.ts src/server/plan-machine.ts src/server/changes.ts src/server/putio.ts
```

The change touches the verification when a hunk lands in a function in the table.

## Run it

```bash
.agents/skills/verify-plan-runs/check.sh
```

It needs Java 11 or newer. It downloads TLC 1.7.4 once into `~/.cache/tla2tools`, checks the jar's SHA-256, and finishes in a few seconds. A pass prints `Model checking completed. No error has been found.`

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

Move the sync commit in the table above forward only after confirming the model matches the code at the new commit.

## Scope

- One plan, 3 steps, 2 of them trash, at most 2 retries. Runs on two plans at once are left out: the `plans` region of [`activity-machine.ts`](../../../src/server/activity-machine.ts) keeps them apart, and the runner sends `RUN_ENDED` only once it has exited.
- A 4xx from put.io means the write did not happen. A lost response or a stopped or evicted request may or may not have landed.
- Left out: translate steps (parallel uploads, subtitle ids saved after the upload), the video-then-subtitle ordering in `failedVideos`, folder creation inside a move, unticked changes, and the snapshot rescans themselves. A pass says nothing about those paths.
