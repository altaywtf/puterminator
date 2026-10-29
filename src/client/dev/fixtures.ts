import type { Audit } from "../../shared/audit.ts";
import type { MessageParam } from "../../shared/contract.ts";

// Fake-agent data, typed against the contract so drift fails typecheck. Node runs this file
// directly (type stripping), so imports are type-only and carry the .ts extension.

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

const ask = (text: string): MessageParam => ({
  role: "user",
  content: [
    { type: "text", text },
    { type: "text", text: "<context>Target folder: Your Files (id 0). No scan yet.</context>" },
  ],
});

export const history: MessageParam[] = [
  ask("Audit my library"),
  {
    role: "assistant",
    content: [
      {
        type: "thinking",
        thinking: "Read the whole tree first, then score naming, structure, junk and duplicates.",
        signature: "sig"
      },
      {
        type: "tool_use",
        id: "toolu_1",
        name: "scan_library",
        input: {}
      }
    ]
  },
  {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: "toolu_1",
        content: JSON.stringify(audit)
      }
    ]
  },
  {
    role: "assistant",
    content: [
      {
        type: "text",
        text: "Your library scores **64/100**. Naming drags it down; the rest is decent.\n\n- **1,442 videos** keep release names like `The.Office.S02E01.720p.HDTV.x264.mkv`\n- **318 wrapper folders** hold a single file\n- **351 junk files** (2.1 GB): `.nfo`, `.url`, sample clips\n- **12 duplicate groups** waste 38 GB\n\nWant me to list the junk or the duplicates first?"
      }
    ]
  },
  ask("Find junk files"),
  {
    role: "assistant",
    content: [
      {
        type: "thinking",
        thinking: "Search the junk category; the scan is fresh.",
        signature: "sig"
      },
      {
        type: "tool_use",
        id: "toolu_2",
        name: "search_files",
        input: {
          category: "junk",
          query: ""
        }
      }
    ]
  },
  {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: "toolu_2",
        content: JSON.stringify(search)
      }
    ]
  },
  {
    role: "assistant",
    content: [
      {
        type: "text",
        text: "351 junk files, 2.1 GB. The usual suspects:\n\n| Kind | Files | Size |\n| --- | --- | --- |\n| tracker filler | 204 | 3 MB |\n| sample clips | 96 | 2.0 GB |\n| covers and logos | 51 | 61 MB |\n\nThis version changes nothing, so delete them in put.io for now. Raw `<img src=x onerror=alert(1)>` stays text and [this link](javascript:alert(1)) stays inert."
      }
    ]
  },
];
