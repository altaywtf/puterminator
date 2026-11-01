import * as Schema from "effect/Schema";

const FileType = Schema.String;

/** `list_folder`: the direct children of one folder, sorted by name. Sizes are display strings. */
export const ListFolderOutput = Schema.Struct({
  path: Schema.String,
  count: Schema.Finite,
  items: Schema.Array(Schema.Struct({ name: Schema.String, type: FileType, size: Schema.String, played: Schema.Boolean })),
});

export type ListFolderOutput = typeof ListFolderOutput.Type;

/** `make_download_links`: put.io's job id, and how many files it linked once done. The links themselves
    never reach the model; the card fetches them. */
export const DownloadLinksOutput = Schema.Struct({ id: Schema.Finite, files: Schema.NullOr(Schema.Finite) });

export type DownloadLinksOutput = typeof DownloadLinksOutput.Type;

/** `/api/download-links/:id`. */
export const DownloadLinksResponse = Schema.Union([
  Schema.Struct({ status: Schema.Literal("done"), links: Schema.Array(Schema.String) }),
  Schema.Struct({ status: Schema.Literal("pending") }),
  Schema.Struct({ status: Schema.Literal("error"), message: Schema.String }),
]);

export type DownloadLinksResponse = typeof DownloadLinksResponse.Type;

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
