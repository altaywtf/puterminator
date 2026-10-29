import * as Schema from "effect/Schema";

/** The `scan_library` tool result, as `audit()` in src/server/audit.ts returns it. The score card decodes it. */

const Finding = Schema.Struct({ path: Schema.String, size: Schema.Finite, why: Schema.String });

export const Audit = Schema.Struct({
  at: Schema.String,
  rootName: Schema.String,
  truncated: Schema.Boolean,
  totals: Schema.Struct({
    items: Schema.Finite,
    files: Schema.Finite,
    folders: Schema.Finite,
    videos: Schema.Finite,
    bytes: Schema.Finite,
  }),
  score: Schema.Finite,
  scores: Schema.Struct({
    naming: Schema.Finite,
    structure: Schema.Finite,
    junk: Schema.Finite,
    duplicates: Schema.Finite,
  }),
  naming: Schema.Struct({ messy: Schema.Finite, examples: Schema.Array(Schema.String) }),
  structure: Schema.Struct({
    rootFiles: Schema.Finite,
    wrapperFolders: Schema.Finite,
    emptyFolders: Schema.Finite,
    deepest: Schema.Finite,
    examples: Schema.Array(Schema.String),
  }),
  junk: Schema.Struct({ count: Schema.Finite, bytes: Schema.Finite, examples: Schema.Array(Finding) }),
  duplicates: Schema.Struct({
    groups: Schema.Finite,
    wastedBytes: Schema.Finite,
    examples: Schema.Array(
      Schema.Struct({ keep: Schema.String, drop: Schema.Array(Schema.String), size: Schema.Finite }),
    ),
  }),
  neverPlayed: Schema.Struct({ count: Schema.Finite, bytes: Schema.Finite, examples: Schema.Array(Finding) }),
});
export type Audit = typeof Audit.Type;
