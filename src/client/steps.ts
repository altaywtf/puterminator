import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Audit } from "../shared/audit";

export const fmt = (n: number) => n.toLocaleString("en-US");

export const size = (b: number) =>
  b >= 2 ** 40
    ? `${(b / 2 ** 40).toFixed(1)} TB`
    : b >= 2 ** 30
      ? `${(b / 2 ** 30).toFixed(1)} GB`
      : `${Math.max(1, Math.round(b / 2 ** 20))} MB`;

const decodeAudit = Schema.decodeUnknownOption(Schema.fromJsonString(Audit));

/** The `scan_library` result, when the output is a valid audit. */
export const auditOf = (output: string | null): Option.Option<Audit> =>
  output === null ? Option.none() : decodeAudit(output);

type Out = Record<string, unknown> | null;

const parse = (s: string | null): Out => {
  if (!s) return null;
  try {
    const v: unknown = JSON.parse(s);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : { error: s };
  } catch {
    return { error: s };
  }
};

const num = (v: unknown) => (typeof v === "number" ? v : 0);
const record = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

export type StepText = { title: string; detail: string | null; lines: string[] };

/** One-line summary of a tool step: what ran, a short result, and detail lines for the folded body. */
export function describeStep(name: string, inputValue: unknown, output: string | null): StepText {
  const input = record(inputValue);
  const out = parse(output);
  if (out && typeof out.error === "string") return { title: `couldn’t run ${name}`, detail: null, lines: [out.error] };
  if (name === "scan_library") {
    return Option.match(auditOf(output), {
      onNone: () => ({ title: "read the library", detail: null, lines: [] }),
      onSome: (a) => ({
        title: "read the library",
        detail: `${fmt(a.totals.items)} items · ${size(a.totals.bytes)}`,
        lines: [
          `release names   ${fmt(a.naming.messy)} videos`,
          `wrapper folders   ${fmt(a.structure.wrapperFolders)}`,
          `junk   ${fmt(a.junk.count)} files · ${size(a.junk.bytes)}`,
          `duplicates   ${fmt(a.duplicates.groups)} groups`,
        ],
      }),
    });
  }
  if (name === "list_folder") {
    const path = typeof input.path === "string" && input.path ? input.path : "/";
    return { title: `open ${path}`, detail: out ? `${fmt(num(out.count))} items` : null, lines: [] };
  }
  if (name === "search_files") {
    const category = typeof input.category === "string" && input.category !== "any" ? input.category.replace("_", " ") : null;
    const query = typeof input.query === "string" && input.query ? `"${input.query}"` : null;
    const what = [category, query].filter((s) => s !== null).join(" ");
    const items = Array.isArray(out?.items) ? out.items : [];
    return {
      title: `search ${what || "files"}`,
      detail: out ? `${fmt(num(out.total))} matches` : null,
      lines: items.slice(0, 6).flatMap((i) => {
        const path = record(i).path;
        return typeof path === "string" ? [path] : [];
      }),
    };
  }
  return { title: name, detail: null, lines: [] };
}

/** `name(input)` as the step body's first mono line. */
export const callLine = (name: string, input: unknown) => {
  const args = JSON.stringify(input ?? {});
  return `${name}(${args === "{}" ? "" : args})`;
};
