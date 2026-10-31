import * as Schema from "effect/Schema";

// Action cards: what the agent proposes, asks and applies. The server builds plans from the model's
// `propose_changes` call; only the user's apply click, handled by the server, changes anything on put.io.

/** One change to one file or folder. `to` is the new name (rename) or the new full path (move). Paths are
    relative to the target folder, as the snapshot writes them. */
export const Change = Schema.Struct({
  id: Schema.String,
  op: Schema.Literals(["trash", "rename", "move"]),
  path: Schema.String,
  to: Schema.NullOr(Schema.String),
  bytes: Schema.Finite,
});
export type Change = typeof Change.Type;

/** A proposed set of changes; nothing happens until the user applies it. */
export const Plan = Schema.Struct({ id: Schema.String, title: Schema.String, changes: Schema.Array(Change) });
export type Plan = typeof Plan.Type;

/** A decision the agent can't make alone. One answer, or several when `multi`. */
export const Question = Schema.Struct({
  id: Schema.String,
  prompt: Schema.String,
  multi: Schema.Boolean,
  options: Schema.Array(Schema.Struct({ id: Schema.String, label: Schema.String, detail: Schema.NullOr(Schema.String) })),
});
export type Question = typeof Question.Type;

export const StepState = Schema.Literals(["queued", "running", "done", "failed"]);

/** An applied plan in flight, or finished: one step per change. */
export const Run = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  changes: Schema.Array(Change),
  steps: Schema.Array(Schema.Struct({ change: Schema.String, state: StepState, error: Schema.NullOr(Schema.String) })),
});
export type Run = typeof Run.Type;

/** A plan and where it stands. The browser reads it; only browser frames move it past `proposed`. */
export const PlanRecord = Schema.Struct({
  plan: Plan,
  status: Schema.Literals(["proposed", "discarded", "applying", "done"]),
  run: Schema.NullOr(Run),
});
export type PlanRecord = typeof PlanRecord.Type;
