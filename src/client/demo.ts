import type { Audit } from "../shared/audit";
import { FileFlag, type Library } from "../shared/contract";

const GB = 2 ** 30;
const MB = 2 ** 20;
const KB = 2 ** 10;
const { folder: F, video: V, played: P, junk: J, messy: M } = FileFlag;

const HAZE = "Haze.1995.1080p.BluRay.x264-RIPGROVE";
const DUNMAR = "Dunmar.Part.Two.2024.2160p.WEB-DL.DDP5.1.Atmos.H.265-FLAX";
const BADGER = "The.Badger.S03.1080p.WEB.h264-MABEL";

const FILES: Array<[path: string, bytes: number, flags: number]> = [
  ["/Movies/Haze (1995)/Haze (1995).mkv", 9.1 * GB, V | P],
  ["/Movies/Arrowmere (2016)/Arrowmere (2016).mkv", 6.4 * GB, V | P],
  ["/Movies/Zorvane (2007)/Zorvane (2007).mkv", 8.2 * GB, V],
  ["/Movies/Farlow (1996)/Farlow (1996).mkv", 4.7 * GB, V | P],
  ["/Movies/alvex.1979.directors.cut.1080p.mkv", 7.3 * GB, V | M | P],
  [`/Downloads/${HAZE}/${HAZE}.mkv`, 4.4 * GB, V | M],
  [`/Downloads/${HAZE}/www.Ripgrove.to.txt`, 1 * KB, J],
  [`/Downloads/${HAZE}/Haze.1995.nfo`, 4 * KB, J],
  [`/Downloads/${HAZE}/haze-sample.mkv`, 31 * MB, V | J],
  [`/Downloads/${DUNMAR}/${DUNMAR}.mkv`, 18.6 * GB, V | M],
  [`/Downloads/${DUNMAR}/Sample/dunmar.sample.mkv`, 48 * MB, V | J],
  ...[1, 2, 3].flatMap((ep): Array<[string, number, number]> => [
    [`/Downloads/${BADGER}/The.Badger.S03E0${ep}.1080p.WEB.h264-MABEL.mkv`, 1.6 * GB, V | M],
    [`/Downloads/${BADGER}/The.Badger.S03E0${ep}.1080p.WEB.h264-MABEL.en.srt`, 52 * KB, 0],
  ]),
  [`/Downloads/${BADGER}/www.NOSUCHFLIX.TO.jpg`, 64 * KB, J],
  ["/Downloads/Sevenfold.S02E01.1080p.WEB.H264-AmbitiousEel.mkv", 2.1 * GB, V | M],
  ["/Downloads/Perfect.Hours.2023.1080p.BluRay.x264-QoXT.mkv", 8.9 * GB, V | M],
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((ep): [string, number, number] => [`/Series/Sevenfold/Season 01/Sevenfold - S01E0${ep}.mkv`, 1.9 * GB, V | P]),
];

const files: Array<Library["files"][number]> = [];
const ids = new Map<string, number>([["", 0]]);

const idOf = (path: string, bytes = 0, flags: number = F): number => {
  const known = ids.get(path);

  if (known !== undefined) return known;
  const cut = path.lastIndexOf("/");
  const parent = idOf(path.slice(0, cut));
  const id = -(files.length + 1);
  files.push([id, parent, path.slice(cut + 1), bytes, flags]);
  ids.set(path, id);

  return id;
};

for (const [path, bytes, flags] of FILES) idOf(path, bytes, flags);

export const library: Library = { rootId: 0, rootName: "Your Files", files };

export const audit: Audit = {
  at: "2026-11-01T09:00:00.000Z",
  rootName: "Your Files",
  truncated: false,
  totals: { items: files.length, files: 29, folders: 13, videos: 24, bytes: 91.7 * GB },
  score: 58,
  scores: { naming: 41, structure: 66, junk: 52, duplicates: 74 },
  naming: { messy: 8, examples: [`${DUNMAR}.mkv`] },
  structure: { rootFiles: 0, wrapperFolders: 3, emptyFolders: 0, deepest: 4, examples: [`/Downloads/${DUNMAR}/Sample`] },
  junk: {
    count: 5,
    bytes: 79 * MB,
    examples: [
      { path: `/Downloads/${DUNMAR}/Sample/dunmar.sample.mkv`, size: 48 * MB, why: "sample clip" },
      { path: `/Downloads/${HAZE}/haze-sample.mkv`, size: 31 * MB, why: "sample clip" },
      { path: `/Downloads/${BADGER}/www.NOSUCHFLIX.TO.jpg`, size: 64 * KB, why: "tracker ad" },
      { path: `/Downloads/${HAZE}/Haze.1995.nfo`, size: 4 * KB, why: ".nfo file" },
      { path: `/Downloads/${HAZE}/www.Ripgrove.to.txt`, size: 1 * KB, why: "tracker filler" },
    ],
  },
  duplicates: {
    groups: 1,
    wastedBytes: 4.4 * GB,
    examples: [{ keep: "/Movies/Haze (1995)/Haze (1995).mkv", drop: [`/Downloads/${HAZE}/${HAZE}.mkv`], size: 4.4 * GB }],
  },
  neverPlayed: {
    count: 8,
    bytes: 47 * GB,
    examples: [
      { path: `/Downloads/${DUNMAR}/${DUNMAR}.mkv`, size: 18.6 * GB, why: "never played" },
      { path: "/Downloads/Perfect.Hours.2023.1080p.BluRay.x264-QoXT.mkv", size: 8.9 * GB, why: "never played" },
      { path: "/Movies/Zorvane (2007)/Zorvane (2007).mkv", size: 8.2 * GB, why: "never played" },
    ],
  },
};

