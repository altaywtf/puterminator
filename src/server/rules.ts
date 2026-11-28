import * as Schema from "effect/Schema";
import { RuleCriteria } from "../shared/actions";
import { cleanPath, MAX_CHANGES, type ProposeInput } from "./changes";
import type { WalkedFile } from "./tree";

export const DAY_MS = 86_400_000;
const MAX_DAYS = 3650;
const SHARE_LIMIT = 0.5;
const SHARE_FLOOR = 10;

export const RuleInput = Schema.Struct({
  title: Schema.String.annotate({ description: "short, lowercase, e.g. 'trash old films'" }),
  within: Schema.Array(Schema.String).annotate({ description: "folders it looks in, as scan and search return them, e.g. ['/Movies']; ['/'] for the whole target folder" }),
  openedDaysAgo: Schema.Finite.annotate({ description: "trash videos first opened at least this many days ago, 1 to 3650" }),
  protect: Schema.Array(Schema.String).annotate({ description: "folders it never touches, e.g. ['/Movies/Keep']; [] for none" }),
  cap: Schema.Finite.annotate({ description: `most files one run may trash, 1 to ${MAX_CHANGES}; a run that matches more stops and pauses the rule` }),
  every: Schema.Literals(["day", "week"]),
});

export type RuleInput = typeof RuleInput.Type;

export const Criteria = RuleCriteria;

export type Criteria = RuleCriteria;

export type Check =
  | { readonly kind: "none" }
  | { readonly kind: "plan"; readonly input: ProposeInput; readonly ids: ReadonlyArray<number>; readonly bytes: number }
  | { readonly kind: "stop"; readonly why: string };

export const intervalMs = (every: Criteria["every"]) => (every === "day" ? DAY_MS : 7 * DAY_MS);

const inside = (path: string, folder: string) => folder === "/" || path === folder || path.startsWith(`${folder}/`);

const putioTime = (at: string) => Date.parse(/(?:z|[+-]\d\d:?\d\d)$/i.test(at) ? at : `${at}Z`);

const inScope = (f: WalkedFile, rule: Criteria) =>
  f.file_type === "VIDEO" && rule.within.some((w) => inside(f.path, w)) && !rule.protect.some((p) => inside(f.path, p));

const byOpenedThenPath = (a: WalkedFile, b: WalkedFile) =>
  putioTime(a.first_accessed_at ?? "") - putioTime(b.first_accessed_at ?? "") || (a.path < b.path ? -1 : a.path > b.path ? 1 : a.id - b.id);

/** Videos in the rule's folders, outside its protected ones, first opened at least `openedDaysAgo` days before `now`. */
export const matchRule = (files: ReadonlyArray<WalkedFile>, rule: Criteria, now: number): Array<WalkedFile> => {
  const cutoff = now - rule.openedDaysAgo * DAY_MS;

  return files
    .filter((f) => inScope(f, rule) && f.first_accessed_at != null && putioTime(f.first_accessed_at) <= cutoff)
    .sort(byOpenedThenPath);
};

/** What one run of the rule would do now: nothing, a plan of trash changes, or a stop that pauses the rule. */
export const checkRule = (files: ReadonlyArray<WalkedFile>, rule: Criteria, now: number): Check => {
  const folders = new Set(files.flatMap((f) => (f.file_type === "FOLDER" ? [f.path] : [])));
  const gone = [...rule.within, ...rule.protect].find((p) => p !== "/" && !folders.has(p));

  if (gone !== undefined) return { kind: "stop", why: `${gone} is gone or was renamed` };
  const matched = matchRule(files, rule, now);

  if (matched.length === 0) return { kind: "none" };

  if (matched.length > rule.cap) return { kind: "stop", why: `it matched ${matched.length} files, over its cap of ${rule.cap}` };
  const videos = files.filter((f) => inScope(f, rule)).length;

  if (matched.length > SHARE_FLOOR && matched.length > videos * SHARE_LIMIT) return { kind: "stop", why: `it matched ${matched.length} of the ${videos} videos it looks at` };

  return {
    kind: "plan",
    input: { title: rule.title, changes: matched.map((f) => ({ op: "trash", path: f.path, to: null })) },
    ids: matched.map((f) => f.id),
    bytes: matched.reduce((sum, f) => sum + f.size, 0),
  };
};

/** Checks the model's rule against the snapshot; errors go back to the model. */
export const validateRule = (snapshot: ReadonlyArray<WalkedFile>, input: RuleInput): Criteria | { error: string } => {
  const folders = new Set(snapshot.flatMap((f) => (f.file_type === "FOLDER" ? [f.path] : [])));
  const within = [...new Set(input.within.map(cleanPath))];
  const protect = [...new Set(input.protect.map(cleanPath))];

  const problems = [
    ...[...within, ...protect].flatMap((p) => (p !== "/" && !folders.has(p) ? [`${p}: not a folder in the snapshot`] : [])),
    ...(within.length === 0 ? ["within needs at least one folder"] : []),
    ...(protect.includes("/") ? ["protect can't cover the whole target folder"] : []),
    ...(Number.isInteger(input.openedDaysAgo) && input.openedDaysAgo >= 1 && input.openedDaysAgo <= MAX_DAYS ? [] : [`openedDaysAgo must be a whole number from 1 to ${MAX_DAYS}`]),
    ...(Number.isInteger(input.cap) && input.cap >= 1 && input.cap <= MAX_CHANGES ? [] : [`cap must be a whole number from 1 to ${MAX_CHANGES}`]),
  ];

  if (problems.length > 0) return { error: `Fix these and propose again: ${problems.slice(0, 10).join("; ")}` };

  return { title: input.title.trim().slice(0, 80) || "cleanup rule", within, openedDaysAgo: input.openedDaysAgo, protect, cap: input.cap, every: input.every };
};
