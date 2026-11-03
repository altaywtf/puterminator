import type { Audit } from "../../shared/audit";

export const audit: Audit = {
  at: "2026-10-27T09:12:00.000Z",
  rootName: "Your Files",
  truncated: false,
  totals: {
    items: 3688,
    files: 3122,
    folders: 566,
    videos: 1910,
    bytes: 1841896724889.6
  },
  score: 64,
  scores: {
    naming: 38,
    structure: 71,
    junk: 82,
    duplicates: 91
  },
  naming: {
    messy: 1442,
    examples: [
      "The.Office.S02E01.720p.HDTV.x264.mkv"
    ]
  },
  structure: {
    rootFiles: 14,
    wrapperFolders: 318,
    emptyFolders: 9,
    deepest: 6,
    examples: [
      "movies/Heat.1995.1080p.BluRay/Heat.1995.1080p.BluRay.mkv"
    ]
  },
  junk: {
    count: 351,
    bytes: 2254857830.4,
    examples: [
      {
        path: "movies/Heat.1995/RARBG.txt",
        size: 31,
        why: "tracker filler"
      }
    ]
  },
  duplicates: {
    groups: 12,
    wastedBytes: 40802189312,
    examples: [
      {
        keep: "movies/Heat (1995)/Heat.mkv",
        drop: [
          "movies/Heat.1995.720p.mkv"
        ],
        size: 4724464025.6
      }
    ]
  },
  neverPlayed: {
    count: 214,
    bytes: 431644213248,
    examples: [
      {
        path: "movies/Stalker (1979)/Stalker.mkv",
        size: 6549825126.4,
        why: "never played"
      }
    ]
  }
};

export const search = {
  total: 351,
  items: [
    {
      path: "movies/Heat.1995/RARBG.txt"
    },
    {
      path: "movies/Heat.1995/Sample/heat-sample.mkv"
    },
    {
      path: "series/The.Office.S02/www.torrenting.com.url"
    },
    {
      path: "series/The.Office.S02/RARBG_DO_NOT_MIRROR.exe"
    },
    {
      path: "documentaries/Cosmos/cover.jpg"
    },
    {
      path: "courses/Rust/readme.nfo"
    }
  ]
};
