import * as Arbitrary from "effect/Arbitrary";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { checkRule, DAY_MS, matchRule, validateRule, type Criteria } from "./rules";
import type { WalkedFile } from "./tree";

const NOW = Date.parse("2026-11-21T12:00:00Z");
const DIRS = ["/Movies", "/Movies/Keep", "/Shows", "/Shows/Keep/Deep"] as const;
const WITHIN = [["/"], ["/Movies"], ["/Shows"], ["/Movies", "/Shows"]];
const PROTECT = [[], ["/Movies/Keep"], ["/Shows/Keep"], ["/Movies/Keep", "/Shows/Keep/Deep"]];

const Spec = Schema.Struct({
  files: Schema.Array(
    Schema.Struct({
      dir: Schema.Literals(DIRS),
      name: Schema.Literals(["a.mkv", "b.mkv", "c.mp4", "d.nfo"]),
      openedDaysAgo: Schema.NullOr(Schema.Literals([0, 1, 29, 30, 31, 400])),
      size: Schema.Literals([1, 700, 4000]),
    }),
  ),
  within: Schema.Literals([0, 1, 2, 3]),
  protect: Schema.Literals([0, 1, 2, 3]),
  openedDaysAgo: Schema.Literals([1, 30, 31]),
  cap: Schema.Literals([1, 3, 50]),
  shuffle: Schema.Literals([0, 1, 2, 3]),
});

type Spec = typeof Spec.Type;

const walked = (spec: Spec): WalkedFile[] =>
  spec.files.map((f, i) => ({
    id: i + 1,
    parent_id: 0,
    name: f.name,
    path: `${f.dir}/${i}-${f.name}`,
    depth: f.dir.split("/").length,
    size: f.size,
    file_type: f.name.endsWith(".nfo") ? "TEXT" : "VIDEO",
    content_type: null,
    extension: f.name.split(".").pop() ?? null,
    crc32: null,
    created_at: "2025-01-01T00:00:00",
    first_accessed_at: f.openedDaysAgo === null ? null : new Date(NOW - f.openedDaysAgo * DAY_MS).toISOString().slice(0, 19),
  }));

const ruleOf = (spec: Spec): Criteria => ({ title: "old", within: WITHIN[spec.within] ?? [], protect: PROTECT[spec.protect] ?? [], openedDaysAgo: spec.openedDaysAgo, cap: spec.cap, every: "day" });

const rotate = <A>(xs: ReadonlyArray<A>, n: number) => (xs.length === 0 ? [...xs] : [...xs.slice(n % xs.length), ...xs.slice(0, n % xs.length)].reverse());

const holds = (property: (spec: Spec) => boolean) =>
  Effect.runPromise(Arbitrary.checkEffect(Arbitrary.schema(Spec), property, { runs: 300 })).then((r) => expect(r._tag).toBe("Passed"));

describe("rules", () => {
  it("never matches a file under a protected folder", () =>
    holds((spec) => matchRule(walked(spec), ruleOf(spec), NOW).every((f) => !ruleOf(spec).protect.some((p) => f.path.startsWith(`${p}/`)))));

  it("matches only videos inside its folders, first opened at least the given days ago", () =>
    holds((spec) => {
      const rule = ruleOf(spec);
      const files = walked(spec);
      const matched = new Set(matchRule(files, rule, NOW).map((f) => f.id));

      return spec.files.every((f, i) => {
        const inside = rule.within.some((w) => w === "/" || f.dir === w || f.dir.startsWith(`${w}/`));
        const guarded = rule.protect.some((p) => f.dir === p || f.dir.startsWith(`${p}/`));
        const due = f.openedDaysAgo !== null && f.openedDaysAgo >= rule.openedDaysAgo;

        return matched.has(i + 1) === (inside && !guarded && due && !f.name.endsWith(".nfo"));
      });
    }));

  it("never plans more trash than its cap", () =>
    holds((spec) => {
      const check = checkRule(walked(spec), ruleOf(spec), NOW);

      return check.kind !== "plan" || (check.input.changes.length <= spec.cap && check.input.changes.every((c) => c.op === "trash"));
    }));

  it("gives the same answer whatever order put.io lists files in", () =>
    holds((spec) => {
      const files = walked(spec);

      return JSON.stringify(checkRule(files, ruleOf(spec), NOW)) === JSON.stringify(checkRule(rotate(files, spec.shuffle), ruleOf(spec), NOW));
    }));

  it("stops when a run would trash most of what it looks at", () => {
    const files = walked({
      files: Array.from({ length: 12 }, () => ({ dir: "/Movies" as const, name: "a.mkv" as const, openedDaysAgo: 400 as const, size: 700 as const })),
      within: 0,
      protect: 0,
      openedDaysAgo: 30,
      cap: 50,
      shuffle: 0,
    });

    expect(checkRule(files, { title: "old", within: ["/"], protect: [], openedDaysAgo: 30, cap: 50, every: "week" }, NOW)).toEqual({ kind: "stop", why: "it matched 12 of the 12 videos it looks at" });
  });

  it("refuses folders the snapshot lacks and out-of-range numbers", () => {
    const snapshot = walked({ files: [], within: 0, protect: 0, openedDaysAgo: 30, cap: 50, shuffle: 0 });

    expect(validateRule(snapshot, { title: "x", within: ["/Nope"], openedDaysAgo: 0.5, protect: ["/"], cap: 500, every: "day" })).toEqual({
      error:
        "Fix these and propose again: /Nope: not a folder in the snapshot; protect can't cover the whole target folder; openedDaysAgo must be a whole number from 1 to 3650; cap must be a whole number from 1 to 200",
    });
  });
});
