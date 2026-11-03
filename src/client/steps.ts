import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Audit } from "../shared/audit";
import { FreeSpaceOutput } from "../shared/tools";

export const fmt = (n: number) => n.toLocaleString("en-US");

export const size = (b: number) =>
  b >= 2 ** 40
    ? `${(b / 2 ** 40).toFixed(1)} TB`
    : b >= 2 ** 30
      ? `${(b / 2 ** 30).toFixed(1)} GB`
      : b >= 2 ** 20
        ? `${Math.round(b / 2 ** 20)} MB`
        : `${Math.max(1, Math.round(b / 2 ** 10))} KB`;

const decodeAudit = Schema.decodeUnknownOption(Schema.fromJsonString(Audit));

/** The `scan_library` result, when the output is a valid audit. */
export const auditOf = (output: string | null): Option.Option<Audit> =>
  output === null ? Option.none() : decodeAudit(output);

const decodeOutput = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.JsonObject));
const decodeToolError = Schema.decodeUnknownOption(Schema.Struct({ error: Schema.String }));
const decodeFreeSpaceSummary = Schema.decodeUnknownOption(FreeSpaceOutput);
const decodeLayoutSummary = Schema.decodeUnknownOption(Schema.Struct({ changes: Schema.Finite, skipped: Schema.Finite }));
const decodeLinkedFiles = Schema.decodeUnknownOption(Schema.Struct({ files: Schema.Finite }));
const decodeFolderCount = Schema.decodeUnknownOption(Schema.Struct({ count: Schema.Finite }));
const decodeTotal = Schema.decodeUnknownOption(Schema.Struct({ total: Schema.Finite }));
const decodeItems = Schema.decodeUnknownOption(Schema.Struct({ items: Schema.Array(Schema.Json) }));
const decodeItemPath = Schema.decodeUnknownOption(Schema.Struct({ path: Schema.String }));
const decodePath = Schema.decodeUnknownOption(Schema.Struct({ path: Schema.NonEmptyString }));
const decodeCategory = Schema.decodeUnknownOption(Schema.Struct({ category: Schema.String }));
const decodeQuery = Schema.decodeUnknownOption(Schema.Struct({ query: Schema.NonEmptyString }));

export type StepText = { title: string; detail: string | null; lines: string[] };

/** One-line summary of a tool step: what ran, a short result, and detail lines for the folded body. */
export function describeStep(name: string, input: Schema.Json, output: string | null): StepText {
  const out = decodeOutput(output);

  const failure = Option.match(out, {
    onNone: () => (output ? Option.some(output) : Option.none()),
    onSome: (o) => Option.map(decodeToolError(o), ({ error }) => error),
  });

  if (Option.isSome(failure)) return { title: `couldn’t run ${name}`, detail: null, lines: [failure.value] };

  if (name === "scan_library") {
    return Option.match(auditOf(output), {
      onNone: () => ({ title: "read the library", detail: null, lines: [] }),
      onSome: (a) => ({
        title: "read the library",
        detail: `${fmt(a.totals.items)} ${a.totals.items === 1 ? "item" : "items"} · ${size(a.totals.bytes)}`,
        lines: [
          `release names   ${fmt(a.naming.messy)} videos`,
          `wrapper folders   ${fmt(a.structure.wrapperFolders)}`,
          `junk   ${fmt(a.junk.count)} files · ${size(a.junk.bytes)}`,
          `duplicates   ${fmt(a.duplicates.groups)} groups`,
        ],
      }),
    });
  }

  if (name === "plan_layout") {
    return {
      title: "plan the media server layout",
      detail: Option.match(Option.flatMap(out, decodeLayoutSummary), {
        onNone: () => null,
        onSome: ({ changes, skipped }) => `${fmt(changes)} ${changes === 1 ? "change" : "changes"}${skipped > 0 ? `, ${fmt(skipped)} left alone` : ""}`,
      }),
      lines: [],
    };
  }

  if (name === "plan_subtitles") {
    return {
      title: "tidy subtitles",
      detail: Option.match(Option.flatMap(out, decodeLayoutSummary), {
        onNone: () => null,
        onSome: ({ changes, skipped }) => `${fmt(changes)} ${changes === 1 ? "subtitle" : "subtitles"}${skipped > 0 ? `, ${fmt(skipped)} left alone` : ""}`,
      }),
      lines: [],
    };
  }

  if (name === "plan_free_space") {
    return {
      title: "plan what to trash for space",
      detail: Option.match(Option.flatMap(out, decodeFreeSpaceSummary), {
        onNone: () => null,
        onSome: ({ freed, choices }) => `frees ${size(freed)}${choices.length > 0 ? `, ${fmt(choices.length)} for you to pick` : ""}`,
      }),
      lines: [],
    };
  }

  if (name === "make_download_links") {
    return {
      title: "ask put.io for download links",
      detail: Option.match(Option.flatMap(out, decodeLinkedFiles), {
        onNone: () => null,
        onSome: ({ files }) => `${fmt(files)} ${files === 1 ? "file" : "files"}`,
      }),
      lines: [],
    };
  }

  if (name === "list_folder") {
    const path = Option.match(decodePath(input), { onNone: () => "/", onSome: ({ path }) => path });

    return {
      title: `open ${path}`,
      detail: Option.match(out, {
        onNone: () => null,
        onSome: (o) => {
          const count = Option.match(decodeFolderCount(o), { onNone: () => 0, onSome: ({ count }) => count });

          return `${fmt(count)} ${count === 1 ? "item" : "items"}`;
        },
      }),
      lines: [],
    };
  }

  if (name === "search_files") {
    const category = decodeCategory(input).pipe(
      Option.map(({ category }) => category),
      Option.filter((c) => c !== "any"),
      Option.map((c) => c.replace("_", " ")),
    );

    const query = Option.map(decodeQuery(input), ({ query }) => `"${query}"`);
    const what = [category, query].flatMap(Option.toArray).join(" ");
    const total = Option.map(out, (o) => Option.match(decodeTotal(o), { onNone: () => 0, onSome: ({ total }) => total }));
    const items = Option.match(Option.flatMap(out, decodeItems), { onNone: () => [], onSome: ({ items }) => items });

    return {
      title: `search ${what || "files"}`,
      detail: Option.match(total, { onNone: () => null, onSome: (n) => `${fmt(n)} matches` }),
      lines: items.slice(0, 6).flatMap((i) => Option.toArray(Option.map(decodeItemPath(i), ({ path }) => path))),
    };
  }

  return { title: name, detail: null, lines: [] };
}

/** `name(input)` as the step body's first mono line. */
export const callLine = (name: string, input: Schema.Json) => {
  const args = JSON.stringify(input ?? {});

  return `${name}(${args === "{}" ? "" : args})`;
};
