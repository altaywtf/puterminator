import * as Schema from "effect/Schema";

/** One change to one file or folder. `to` is the new name (rename) or the new full path (move). Paths are
    relative to the target folder, as the snapshot writes them. `restore` only appears when undoing a trash.
    `items`: set for a folder, how many files and folders are under it. */
export const Change = Schema.Struct({
  id: Schema.String,
  op: Schema.Literals(["trash", "rename", "move", "restore", "translate"]),
  path: Schema.String,
  to: Schema.NullOr(Schema.String),
  bytes: Schema.Finite,
  items: Schema.optionalKey(Schema.Finite),
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

const StepState = Schema.Literals(["queued", "running", "done", "failed"]);

/** An applied plan in flight, or finished: one step per change. `maybeApplied` marks a failed step whose write may
    still have reached put.io (stopped mid-write, no answer, 5xx). */
export const Run = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  changes: Schema.Array(Change),
  steps: Schema.Array(
    Schema.Struct({
      change: Schema.String,
      state: StepState,
      error: Schema.NullOr(Schema.String),
      maybeApplied: Schema.optionalKey(Schema.Boolean),
    }),
  ),
});

export type Run = typeof Run.Type;

/** A plan and where it stands. The browser reads it; only browser frames move it past `proposed`.
    `undo` is the reverse of the run's done steps, once the user asks for it. */
export const PlanRecord = Schema.Struct({
  plan: Plan,
  status: Schema.Literals(["proposed", "discarded", "applying", "done", "undoing", "undone"]),
  run: Schema.NullOr(Run),
  undo: Schema.optionalKey(Run),
});

export type PlanRecord = typeof PlanRecord.Type;
