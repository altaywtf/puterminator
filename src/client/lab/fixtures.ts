import { Match } from "effect";
import type { Change, Plan, Question, Run } from "../../shared/actions";
import type { Audit } from "../../shared/audit";
import { type Feedback, FileFlag, type Library } from "../../shared/contract";
import type { DownloadLinksOutput, ListFolderOutput, SearchFilesOutput } from "../../shared/tools";

const GB = 2 ** 30;
const MB = 2 ** 20;
const { folder: F, video: V, played: P, junk: J, messy: M } = FileFlag;

const files: Array<Library["files"][number]> = [];
let next = 1;

const add = (parent: number, name: string, bytes = 0, flags = 0) => {
  const id = next++;
  files.push([id, parent, name, bytes, flags]);

  return id;
};

const movies = add(0, "Movies", 0, F);
const downloads = add(0, "Downloads", 0, F);
const series = add(0, "Series", 0, F);

add(0, "Courses", 0, F);

add(0, "notes.txt", 4096);

const FILMS = ["Arrowmere", "Haze", "Alvex", "Dunmar", "Drovel", "Farlow", "Memora", "Zorvane"];

FILMS.forEach((t, i) => {
  const dir = add(movies, `${t} (${1979 + i * 4})`, 0, F);
  add(dir, `${t} (${1979 + i * 4}).mkv`, (2 + i) * GB, V | (i % 3 === 0 ? P : 0));
});

FILMS.slice(0, 4).forEach((t, i) => {
  const dir = add(downloads, `${t}.${1979 + i * 4}.1080p.BluRay.x264-RIPGROVE`, 0, F);
  add(dir, `${t}.${1979 + i * 4}.1080p.BluRay.x264-RIPGROVE.mkv`, (3 + i) * GB, V | M);
  add(dir, "www.Ripgrove.to.txt", 1024, J);
  add(dir, `${t}.${1979 + i * 4}.nfo`, 4096, J);
  add(dir, `${t.toLowerCase()}-sample.mkv`, 30 * MB, V | J);
});

add(downloads, "The.Extremely.Long.Release.Name.Of.A.Documentary.Series.Complete.2160p.UHD.BluRay.REMUX.HDR.HEVC.Atmos-GROUP.mkv", 48 * GB, V | M);

["Sevenfold", "Anvor"].forEach((show) => {
  const s = add(series, show, 0, F);

  for (let season = 1; season <= 2; season++) {
    const dir = add(s, `Season ${season}`, 0, F);

    for (let ep = 1; ep <= 8; ep++) add(dir, `${show} - S0${season}E0${ep}.mkv`, 1.4 * GB, V | (season === 1 ? P : 0));
  }
});

export const library: Library = { rootId: 0, rootName: "Your Files", files };

const junk = [
  { path: "/Downloads/Arrowmere.1979.1080p.BluRay.x264-RIPGROVE/arrowmere-sample.mkv", size: 30 * MB, why: "sample clip" },
  { path: "/Downloads/Haze.1983.1080p.BluRay.x264-RIPGROVE/haze-sample.mkv", size: 30 * MB, why: "sample clip" },
  { path: "/Downloads/Arrowmere.1979.1080p.BluRay.x264-RIPGROVE/www.Ripgrove.to.txt", size: 1024, why: "tracker filler" },
  { path: "/Downloads/Arrowmere.1979.1080p.BluRay.x264-RIPGROVE/Arrowmere.1979.nfo", size: 4096, why: ".nfo file" },
  { path: "/Downloads/Haze.1983.1080p.BluRay.x264-RIPGROVE/www.Ripgrove.to.txt", size: 1024, why: "tracker filler" },
  { path: "/Downloads/Alvex.1987.1080p.BluRay.x264-RIPGROVE/www.Ripgrove.to.txt", size: 1024, why: "tracker filler" },
  { path: "/Downloads/Dunmar.1991.1080p.BluRay.x264-RIPGROVE/dunmar-sample.mkv", size: 30 * MB, why: "sample clip" },
];

const unplayed = [
  { path: "/Downloads/The.Extremely.Long.Release.Name.Of.A.Documentary.Series.Complete.2160p.UHD.BluRay.REMUX.HDR.HEVC.Atmos-GROUP.mkv", size: 48 * GB, why: "never played" },
  { path: "/Movies/Zorvane (2007)/Zorvane (2007).mkv", size: 9 * GB, why: "never played" },
  { path: "/Movies/Memora (2003)/Memora (2003).mkv", size: 8 * GB, why: "never played" },
];

const base: Audit = {
  at: "2026-10-31T09:00:00.000Z",
  rootName: "Your Files",
  truncated: false,
  totals: { items: files.length, files: 60, folders: 21, videos: 52, bytes: 170 * GB },
  score: 62,
  scores: { naming: 71, structure: 80, junk: 48, duplicates: 90 },
  naming: { messy: 5, examples: ["Haze.1983.1080p.BluRay.x264-RIPGROVE.mkv"] },
  structure: { rootFiles: 1, wrapperFolders: 4, emptyFolders: 1, deepest: 3, examples: ["/Courses"] },
  junk: { count: 12, bytes: 0.12 * GB, examples: junk },
  duplicates: {
    groups: 1,
    wastedBytes: 5 * GB,
    examples: [{ keep: "/Movies/Haze (1983)/Haze (1983).mkv", drop: ["/Downloads/Haze.1983.1080p.BluRay.x264-RIPGROVE/Haze.1983.1080p.BluRay.x264-RIPGROVE.mkv"], size: 5 * GB }],
  },
  neverPlayed: { count: 34, bytes: 112 * GB, examples: unplayed },
};

export const audits: Array<[string, Audit]> = [
  ["lived in", base],
  ["clean", { ...base, score: 97, scores: { naming: 96, structure: 98, junk: 100, duplicates: 100 }, junk: { count: 0, bytes: 0, examples: [] }, duplicates: { groups: 0, wastedBytes: 0, examples: [] }, neverPlayed: { count: 0, bytes: 0, examples: [] } }],
  ["empty", { ...base, score: 100, scores: { naming: 100, structure: 100, junk: 100, duplicates: 100 }, totals: { items: 2, files: 0, folders: 2, videos: 0, bytes: 0 }, naming: { messy: 0, examples: [] }, structure: { rootFiles: 0, wrapperFolders: 0, emptyFolders: 2, deepest: 1, examples: [] }, junk: { count: 0, bytes: 0, examples: [] }, duplicates: { groups: 0, wastedBytes: 0, examples: [] }, neverPlayed: { count: 0, bytes: 0, examples: [] } }],
  ["drowning, partial scan", { ...base, score: 18, truncated: true, scores: { naming: 12, structure: 30, junk: 9, duplicates: 40 } }],
];

const listing = (path: string, parent: number): ListFolderOutput => {
  const kids = files.filter((f) => f[1] === parent);

  return {
    path,
    count: kids.length,
    items: kids.map(([, , name, bytes, flags]) => ({ name, type: flags & F ? "FOLDER" : flags & V ? "VIDEO" : "TEXT", mime: flags & F ? null : flags & V ? "video/x-matroska" : "text/plain", size: `${(bytes / GB).toFixed(1)} GB`, played: (flags & P) !== 0 })),
  };
};

export const folders: Array<[string, ListFolderOutput]> = [
  ["root", listing("/", 0)],
  ["Movies", listing("/Movies", movies)],
  ["Downloads", listing("/Downloads", downloads)],
];

const found = (paths: string[], total: number, bytes: string): SearchFilesOutput => ({
  total,
  bytes,
  byMime: [{ mime: "video/x-matroska", count: total, bytes }],
  items: paths.map((path) => ({ path, type: "VIDEO", mime: "video/x-matroska", size: "", added: "2026-01-01", firstPlayed: null, junk: null })),
});

export const downloadLinks: Array<[string, DownloadLinksOutput]> = [
  ["ready", { id: 7, files: 3 }],
  ["put.io still working", { id: 8, files: null }],
];

export const feedbackDrafts: Array<[string, Feedback]> = [
  ["bug report", { kind: "bug", text: "undo after a cleanup said the library changed since the plan, and nothing was undone. expected the renames and trash to be reversed." }],
  [
    "long idea",
    {
      kind: "idea",
      text: "let me pick which media server i use once, so every plan names folders its way.\n\nright now i say plex every time. it would also help if the score card said which server it judged against, and if the layout plan could leave anime alone, since my anime folder already follows its own scheme and every plan wants to move it.",
    },
  ],
];

export const searches: Array<[string, SearchFilesOutput]> = [
  ["junk", found(junk.map((j) => j.path), 12, "0.1 GB")],
  ["never played", found(unplayed.map((u) => u.path), 34, "112.0 GB")],
  ["one match", found([unplayed[1]?.path ?? ""], 1, "9.0 GB")],
  ["no match", found([], 0, "0 MB")],
];

const trash = (id: string, path: string, bytes: number): Change => ({ id, op: "trash", path, to: null, bytes });
const FILMS_DL = FILMS.slice(0, 4).map((t, i) => ({ t, year: 1979 + i * 4, dir: `/Downloads/${t}.${1979 + i * 4}.1080p.BluRay.x264-RIPGROVE` }));

const cleanup: Change[] = [
  ...FILMS_DL.flatMap(({ t, year, dir }, i) => [
    trash(`t${i}a`, `${dir}/www.Ripgrove.to.txt`, 1024),
    trash(`t${i}b`, `${dir}/${t}.${year}.nfo`, 4096),
    trash(`t${i}c`, `${dir}/${t.toLowerCase()}-sample.mkv`, 30 * MB),
  ]),
  ...FILMS_DL.map(({ t, year, dir }, i): Change => ({ id: `r${i}`, op: "rename", path: `${dir}/${t}.${year}.1080p.BluRay.x264-RIPGROVE.mkv`, to: `${t} (${year}).mkv`, bytes: 0 })),
  ...FILMS_DL.map(({ t, year, dir }, i): Change => ({ id: `m${i}`, op: "move", path: dir, to: `/Movies/${t} (${year})`, bytes: 0 })),
];

export const questions: Array<[string, Question, string[]]> = [
  [
    "one answer",
    {
      id: "q1",
      prompt: "which copy of Haze should I keep?",
      multi: false,
      options: [
        { id: "a", label: "Haze (1983).mkv", detail: "/Movies/Haze (1983) · 3.0 GB · played" },
        { id: "b", label: "Haze.1983.1080p.BluRay.x264-RIPGROVE.mkv", detail: "/Downloads · 4.0 GB · never played" },
      ],
    },
    [],
  ],
  [
    "several answers",
    {
      id: "q2",
      prompt: "which folders should I leave alone?",
      multi: true,
      options: [
        { id: "a", label: "Courses", detail: "1 item" },
        { id: "b", label: "Series", detail: "32 episodes · 44.8 GB" },
        { id: "c", label: "Downloads", detail: "17 items · 66.1 GB" },
      ],
    },
    ["question.q2.b"],
  ],
  ["answered", { id: "q3", prompt: "which copy of Haze should I keep?", multi: false, options: [{ id: "a", label: "Haze (1983).mkv", detail: null }] }, ["question.q3.a"]],
];

const steps = (states: Array<Run["steps"][number]["state"]>, fail: Record<number, string> = {}): Run["steps"] =>
  cleanup.map((c, i) => ({ change: c.id, state: states[i] ?? "queued", error: fail[i] ?? null }));

const run = (id: string, s: Run["steps"]): Run => ({ id, title: "clean up Downloads", changes: cleanup, steps: s });
const N = cleanup.length;

export const runs: Array<[string, Run, string[]]> = [
  ["running", run("r1", steps([...Array(13).fill("done"), "running"])), []],
  ["running, one failed", run("r2", steps([...Array(9).fill("done"), "failed", "done", "done", "done", "running"], { 9: "put.io said the file is locked by a transfer" })), []],
  ["done", run("r3", steps(Array(N).fill("done"))), []],
  ["done, one failed, opened", run("r4", steps([...Array(N - 1).fill("done"), "failed"], { [N - 1]: "the target folder already exists" })), ["run.r4.diff"]],
];

const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

const back: Run["changes"] = [...cleanup].reverse().map((c) =>
  Match.value(c.op).pipe(
    Match.when("trash", (): Change => ({ ...c, op: "restore" })),
    Match.when("rename", (): Change => ({ ...c, path: `${c.path.slice(0, c.path.lastIndexOf("/"))}/${c.to ?? ""}`, to: nameOf(c.path), bytes: 0 })),
    Match.whenOr("move", "restore", (): Change => ({ ...c, path: c.to ?? c.path, to: c.path, bytes: 0 })),
    Match.when("translate", (): Change => ({ ...c, id: `${c.id}u`, op: "trash", path: c.to ?? c.path, to: null })),
    Match.exhaustive,
  ),
);

const undoRun = (id: string, states: Array<Run["steps"][number]["state"]>, fail: Record<number, string> = {}): Run => ({
  id,
  title: "clean up Downloads",
  changes: back,
  steps: back.map((c, i) => ({ change: c.id, state: states[i] ?? "queued", error: fail[i] ?? null })),
});

export const undos: Array<[string, Run, string[]]> = [
  ["undoing", undoRun("u1", [...Array(5).fill("done"), "running"]), []],
  ["undone", undoRun("u2", Array(N).fill("done")), []],
  ["undone, one failed", undoRun("u3", [...Array(N - 1).fill("done"), "failed"], { [N - 1]: "put.io: not in the trash any more" }), []],
];

export const plans: Array<[string, Plan, string[]]> = [
  ["proposed", { id: "d1", title: "clean up Downloads", changes: cleanup }, []],
  ["two lines and the moves left out", { id: "d2", title: "clean up Downloads", changes: cleanup }, ["plan.d2.off.t0c", "plan.d2.off.r1", "plan.d2.hunkoff.moves"]],
  [
    "translations",
    {
      id: "d3",
      title: "turkish subtitles",
      changes: FILMS_DL.map(({ t, year }, i): Change => ({ id: `x${i}`, op: "translate", path: `/Movies/${t} (${year})/${t} (${year}).mkv`, to: `/Movies/${t} (${year})/${t} (${year}).tur.srt`, bytes: 0 })),
    },
    [],
  ],
];
