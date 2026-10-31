import * as Schema from "effect/Schema";

/** Tool results the agent and the browser share; the server builds them, the cards decode them. */

const FileType = Schema.String;

/** `list_folder`: the direct children of one folder, sorted by name. Sizes are display strings. */
export const ListFolderOutput = Schema.Struct({
  path: Schema.String,
  count: Schema.Finite,
  items: Schema.Array(Schema.Struct({ name: Schema.String, type: FileType, size: Schema.String, played: Schema.Boolean })),
});
export type ListFolderOutput = typeof ListFolderOutput.Type;

/** `search_files`: matching files, by size for the size-ranked categories. */
export const SearchFilesOutput = Schema.Struct({
  total: Schema.Finite,
  bytes: Schema.String,
  items: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      type: FileType,
      size: Schema.String,
      added: Schema.String,
      firstPlayed: Schema.NullOr(Schema.String),
      junk: Schema.NullOr(Schema.String),
    }),
  ),
});
export type SearchFilesOutput = typeof SearchFilesOutput.Type;
