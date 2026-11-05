import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { buffer as readBytes, text as readBody } from "node:stream/consumers";
import * as Predicate from "effect/Predicate";
import type { Json, JsonObject } from "effect/Schema";

let upstream = "http://localhost";
const TOKEN = "fake-putio-token";
const CODE = "fake-code";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type File = {
  id: number;
  parent_id: number;
  name: string;
  size: number;
  file_type: "FOLDER" | "VIDEO" | "TEXT" | "IMAGE";
  extension: string | null;
  crc32: string | null;
  created_at: string;
  first_accessed_at: string | null;
  content_type: string;
};

const MB = 2 ** 20;
const GB = 2 ** 30;
const files: Array<File> = [];
const trash: Array<File> = [];
let nextId = 1000;

const add = (parent: number, name: string, type: File["file_type"], size = 0, played = false, crc32: string | null = null): number => {
  const id = nextId++;
  const extension = type === "FOLDER" ? null : (name.split(".").pop() ?? null);
  files.push({
    id,
    parent_id: parent,
    name,
    size,
    file_type: type,
    extension,
    crc32: crc32 ?? (type === "VIDEO" ? id.toString(16).padStart(8, "0") : null),
    created_at: `2025-${String((id % 12) + 1).padStart(2, "0")}-14T10:00:00`,
    first_accessed_at: played ? "2026-02-01T21:00:00" : null,
    content_type: type === "FOLDER" ? "application/x-directory" : "application/octet-stream",
  });

  return id;
};

const movies = add(0, "Movies", "FOLDER");
const series = add(0, "Series", "FOLDER");
const downloads = add(0, "Downloads", "FOLDER");

add(0, "Courses", "FOLDER");

add(0, "Audiobooks", "FOLDER");

const titles = ["Arrival", "Heat", "Alien", "Dune", "Drive", "Fargo", "Memento", "Zodiac", "Sicario", "Prisoners"];

titles.forEach((t, i) => {
  const year = 1979 + i * 4;
  const folder = add(movies, `${t} (${year})`, "FOLDER");
  add(folder, `${t} (${year}).mkv`, "VIDEO", (2 + i) * GB, i % 3 === 0);

  if (i < 2) add(add(folder, "Subs", "FOLDER"), "English.srt", "TEXT", 60 * 1024);
});

titles.slice(0, 6).forEach((t, i) => {
  const year = 1979 + i * 4;
  const wrapper = add(downloads, `${t}.${year}.1080p.BluRay.x264-RARBG`, "FOLDER");
  add(wrapper, `${t}.${year}.1080p.BluRay.x264-RARBG.mkv`, "VIDEO", (2 + i) * GB);
  add(wrapper, "RARBG.txt", "TEXT", 1024);
  add(wrapper, `${t}.${year}.nfo`, "TEXT", 4096);
  add(wrapper, `${t.toLowerCase()}-sample.mkv`, "VIDEO", 30 * MB);
});

["Severance", "Andor", "The Bear"].forEach((show, s) => {
  const showFolder = add(series, show, "FOLDER");

  for (let season = 1; season <= 2; season++) {
    const seasonFolder = add(showFolder, `Season ${season}`, "FOLDER");

    for (let ep = 1; ep <= 9; ep++) {
      const tag = String(ep).padStart(2, "0");

      const name =
        s === 1 ? `${show}.S0${season}E${tag}.720p.WEB-DL.DDP5.1.H.264.mkv` : `${show} - S0${season}E${tag}.mkv`;

      add(seasonFolder, name, "VIDEO", 900 * MB + ep * 10 * MB, season === 1 && ep < 5);
    }

    add(seasonFolder, "poster.jpg", "IMAGE", 300 * 1024);
  }
});

add(0, "Heat.1995.2160p.WEB-DL.mkv", "VIDEO", 14 * GB);

const memento = files.find((f) => f.name === "Memento (2003).mkv");

if (memento) add(downloads, "Memento (2003).mkv", "VIDEO", memento.size, false, memento.crc32);

add(0, "www.Torrenting.com - Notes.url", "TEXT", 200);

add(0, "Thumbs.db", "TEXT", 12_000);

add(add(0, "New Folder", "FOLDER"), "Untitled", "FOLDER");

const LINK_JOB_MS = 1200;
const linkJobs = new Map<number, { ids: number[]; readyAt: number }>();
const byParent = (parent: number) => files.filter((f) => parent === -1 || f.parent_id === parent);

const log = (line: string) => console.log(`[fake] ${line}`);

const json = (res: ServerResponse, status: number, body: Json) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const authorized = (req: IncomingMessage) => (req.headers.authorization ?? "").endsWith(TOKEN);

const MAX_PAGE_FILES = 50;

const page = (parent: number, offset: number, perPage: number) => {
  const all = byParent(parent);
  const size = Math.min(perPage, MAX_PAGE_FILES);
  const next = offset + size;

  return { files: all.slice(offset, next), cursor: next < all.length ? `${parent}:${next}` : null, status: "OK" };
};

const putio = async (req: IncomingMessage, res: ServerResponse, url: URL) => {
  const method = req.method ?? "GET";
  const route = `${method} ${url.pathname}`;

  if (route === "GET /v2/oauth2/authenticate") {
    const to = new URL(url.searchParams.get("redirect_uri") ?? "");
    to.searchParams.set("code", CODE);
    to.searchParams.set("state", url.searchParams.get("state") ?? "");
    log(`authorize client_id=${url.searchParams.get("client_id")} → ${to.origin}${to.pathname}`);
    res.writeHead(302, { location: to.href });

    return res.end();
  }

  if (route === "POST /v2/oauth2/access_token") {
    const form = new URLSearchParams(await readBody(req));
    const ok = form.get("code") === CODE && form.get("grant_type") === "authorization_code";
    log(`access_token code=${form.get("code")} → ${ok ? 200 : 400}`);

    return ok ? json(res, 200, { access_token: TOKEN }) : json(res, 400, { error: "invalid_grant", status: "ERROR" });
  }

  const shot = route.match(/^GET \/screenshot\/(\d+)\.svg$/);

  if (shot) {
    const hue = (Number(shot[1]) * 47) % 360;
    res.writeHead(200, { "content-type": "image/svg+xml" });

    return res.end(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 90"><defs><linearGradient id="g" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 70% 45%)"/><stop offset="1" stop-color="hsl(${(hue + 60) % 360} 70% 25%)"/></linearGradient></defs><rect width="160" height="90" fill="url(#g)"/><text x="80" y="52" font-family="monospace" font-size="14" fill="#fff" text-anchor="middle">#${shot[1]}</text></svg>`,
    );
  }

  if (!authorized(req)) return json(res, 401, { status: "ERROR", error_type: "invalid_grant", status_code: 401 });

  if (route === "GET /v2/account/info") {
    const info = { user_id: 4242, username: "altay", mail: "dev@localhost", avatar_url: "https://www.gravatar.com/avatar/0?d=identicon&s=80", disk: { avail: 12 * GB, used: 988 * GB, size: 1000 * GB } };

    return json(res, 200, { info: url.searchParams.get("download_token") === "1" ? { ...info, download_token: "fake-dl" } : info, status: "OK" });
  }

  const subs = route.match(/^GET \/v2\/files\/(\d+)\/subtitles(?:\/([^/]+))?$/);
  const video = subs && files.find((f) => f.id === Number(subs[1]) && f.file_type === "VIDEO");

  if (subs && !subs[2]) {
    const list = video ? [{ key: `eng-${video.id}`, language: "English", language_code: "eng", name: "English", source: "mkv", format: "srt", url: "" }] : [];

    return json(res, 200, { subtitles: list, default: null, status: "OK" });
  }

  if (subs && video) {
    const cues = ["I'm not going back.", "Then where are you going?", "Somewhere they can't find me.", "<i>Everybody gets found.</i>", "- Not me.\n- Everybody."];

    res.writeHead(200, { "content-type": "text/plain" });

    return res.end(cues.map((c, i) => `${i + 1}\n00:00:${String(i * 3 + 1).padStart(2, "0")},000 --> 00:00:${String(i * 3 + 3).padStart(2, "0")},500\n${c}`).join("\n\n"));
  }

  if (route === "POST /v2/files/upload") {
    const form = await new Response(await readBytes(req), { headers: { "content-type": req.headers["content-type"] ?? "" } }).formData();
    const blob = form.get("file");
    const text = blob instanceof Blob ? await blob.text() : "";
    const id = add(Number(form.get("parent_id")), String(form.get("filename") ?? "upload.srt"), "TEXT", text.length);
    log(`uploaded ${form.get("filename")} (${text.length} bytes)`);

    const uploaded = files.find((f) => f.id === id);

    return uploaded ? json(res, 200, { file: uploaded, status: "OK" }) : json(res, 500, { status: "ERROR" });
  }

  const one = route.match(/^GET \/v2\/files\/(\d+)$/);
  const found = one && files.find((f) => f.id === Number(one[1]));

  if (found) {
    const screenshot = found.file_type === "VIDEO" ? `${upstream}/screenshot/${found.id}.svg` : null;

    return json(res, 200, { file: { ...found, screenshot }, status: "OK" });
  }

  if (route === "GET /v2/files/list") {
    const parent = Number(url.searchParams.get("parent_id"));
    const perPage = Number(url.searchParams.get("per_page"));
    await sleep(parent === -1 ? 700 : 100);
    log(`files/list parent_id=${parent} per_page=${perPage}`);

    return json(res, 200, { ...page(parent, 0, perPage), parent: null });
  }

  if (route === "POST /v2/files/list/continue") {
    const form = new URLSearchParams(await readBody(req));
    const [parent, offset] = (form.get("cursor") ?? "0:0").split(":").map(Number);
    const perPage = Number(form.get("per_page"));
    await sleep(500);
    log(`files/list/continue cursor=${form.get("cursor")} per_page=${perPage}`);

    if (!Number.isFinite(perPage) || perPage <= 0) return json(res, 400, { status: "ERROR", error_type: "BAD_REQUEST" });

    return json(res, 200, page(parent ?? 0, offset ?? 0, perPage));
  }

  if (route === "GET /v2/account/settings") return json(res, 200, { settings: { trash_enabled: true }, status: "OK" });

  if (method === "POST" && ["/v2/files/delete", "/v2/files/rename", "/v2/files/move", "/v2/files/create-folder", "/v2/trash/restore"].includes(url.pathname)) {
    const form = new URLSearchParams(await readBody(req));
    const id = Number(form.get("file_ids") ?? form.get("file_id"));

    if (url.pathname === "/v2/trash/restore") {
      const t = trash.find((x) => x.id === id);
      await sleep(350);
      log(`${url.pathname} file_ids=${id}`);

      if (!t) return json(res, 404, { status: "ERROR", error_type: "NOT_FOUND", status_code: 404 });
      trash.splice(trash.indexOf(t), 1);
      files.push(t);

      return json(res, 200, { status: "OK" });
    }

    const f = files.find((x) => x.id === id);
    await sleep(350);
    log(`${url.pathname} ${[...form].map(([k, v]) => `${k}=${v}`).join(" ")}`);

    if (url.pathname === "/v2/files/create-folder") {
      const created = add(Number(form.get("parent_id")), form.get("name") ?? "", "FOLDER");

      return json(res, 200, { file: files.find((x) => x.id === created) ?? null, status: "OK" });
    }

    if (!f) return json(res, 404, { status: "ERROR", error_type: "NOT_FOUND", status_code: 404 });

    if (f.name.toLowerCase().includes("locked")) return json(res, 400, { status: "ERROR", error_type: "LOCKED", status_code: 400 });

    if (url.pathname === "/v2/files/delete") trash.push(...files.splice(files.indexOf(f), 1));

    if (url.pathname === "/v2/files/rename") f.name = form.get("name") ?? f.name;

    if (url.pathname === "/v2/files/move") f.parent_id = Number(form.get("parent_id"));

    return json(res, 200, { status: "OK", errors: [] });
  }

  if (route === "POST /v2/download_links/create") {
    const ids = (new URLSearchParams(await readBody(req)).get("file_ids") ?? "").split(",").map(Number);
    linkJobs.set(linkJobs.size + 1, { ids, readyAt: Date.now() + LINK_JOB_MS });
    log(`${route} file_ids=${ids.join(",")}`);

    return json(res, 200, { id: linkJobs.size, status: "OK" });
  }

  const job = route.match(/^GET \/v2\/download_links\/(\d+)$/);

  if (job) {
    const j = linkJobs.get(Number(job[1]));

    if (!j) return json(res, 404, { status: "ERROR", error_type: "NOT_FOUND", status_code: 404 });

    if (Date.now() < j.readyAt) return json(res, 200, { links_status: "PROCESSING", links: null, status: "OK" });
    const under = (id: number): typeof files => files.flatMap((f) => (f.id === id ? (f.file_type === "FOLDER" ? byParent(f.id).flatMap((c) => under(c.id)) : [f]) : []));
    const links = j.ids.flatMap(under).map((f) => `https://dl.example.put.io/files/${f.id}/${encodeURIComponent(f.name)}`);

    return json(res, 200, { links_status: "DONE", links: { download_links: links, media_links: [], mp4_links: [] }, status: "OK" });
  }

  log(`UNEXPECTED put.io call: ${route}`);
  const status = method === "GET" ? 404 : 405;

  return json(res, status, { status: "ERROR", error_type: "NOT_FAKED", status_code: status });
};

type Block = { readonly type: string; readonly [field: string]: Json };

type Message = { role: string; content: string | Array<Block> };

const STRICT_TOOL_FORBIDDEN_KEYWORDS = ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength", "pattern", "$ref"];

const schemaProblems = (node: Json, at: string): Array<string> => {
  if (node instanceof Array) return node.flatMap((v, i) => schemaProblems(v, `${at}/${i}`));

  if (!(node instanceof Object)) return [];
  const own = STRICT_TOOL_FORBIDDEN_KEYWORDS.flatMap((k) => (k in node ? [`${at}: ${k}`] : []));

  if (node.type === "object" && node.additionalProperties !== false) own.push(`${at}: additionalProperties`);

  return [...own, ...Object.entries(node).flatMap(([k, v]) => schemaProblems(v, `${at}/${k}`))];
};

const requestProblems = (body: any): Array<string> => {
  const problems: Array<string> = [];

  if (body.stream !== true) problems.push("stream must be true");

  if (body.tool_choice && body.tool_choice.type !== "auto") problems.push("forced tool_choice");

  if (body.thinking?.type !== "adaptive") problems.push("thinking must be adaptive");

  for (const t of body.tools ?? []) {
    if (t.strict !== true) problems.push(`${t.name}: strict is not true`);
    problems.push(...schemaProblems(t.input_schema, t.name));
  }

  return problems;
};

const frame = (e: Block) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;

type Step =
  | { kind: "thinking"; text: string }
  | { kind: "tool"; name: string; input: JsonObject }
  | { kind: "text"; text: string; delayMs: number };

const textOf = (m: Message | undefined) => {
  const content = m?.content ?? [];

  if (Predicate.isString(content)) return content;
  const text = content.find((b) => b.type === "text")?.text;

  return Predicate.isString(text) ? text : "";
};

const plan = (messages: Array<Message>): Array<Step> => {
  const last = messages.at(-1);
  const results = Array.isArray(last?.content) ? last.content.filter((b) => b.type === "tool_result") : [];

  if (results.length > 0) {
    const prior = messages.at(-2);
    const call = Array.isArray(prior?.content) ? prior.content.find((b) => b.type === "tool_use") : undefined;
    const raw = String(results[0]?.content ?? "");

    if (results[0]?.is_error) return [{ kind: "text", text: `Scan failed: ${raw}`, delayMs: 30 }];

    if (call?.name === "scan_library") {
      const a = JSON.parse(raw);

      return [
        { kind: "thinking", text: "Score is in. Naming and junk drag it down; pick real paths as examples." },
        {
          kind: "text",
          delayMs: 45,
          text:
            `Score **${a.score}/100**: naming is the biggest problem (${a.scores.naming}).\n\n` +
            `- ${a.naming.messy} release-style names, e.g. \`${a.naming.examples[0] ?? "none"}\`\n` +
            `- ${a.junk.count} junk files, e.g. \`${a.junk.examples[0]?.path ?? "none"}\`\n` +
            `- ${a.duplicates.groups} duplicate groups waste ${(a.duplicates.wastedBytes / GB).toFixed(1)} GB`,
        },
      ];
    }

    if (call?.name === "propose_changes") {
      const p = JSON.parse(raw);

      return [{ kind: "text", delayMs: 40, text: p.error ? `couldn't build that plan: ${p.error}` : "plan's up. untick anything you want to keep." }];
    }

    if (call?.name === "ask_user") return [{ kind: "text", delayMs: 40, text: "your call." }];

    if (call?.name === "draft_feedback") return [{ kind: "text", delayMs: 40, text: "drafted. review it and send." }];

    if (call?.name === "make_download_links") return [{ kind: "text", delayMs: 40, text: "the links are in the card above." }];

    if (call?.name === "propose_translation") {
      const p = JSON.parse(raw);

      return [{ kind: "text", delayMs: 40, text: p.error ? `couldn't plan that: ${p.error}` : "plan's up. apply it and i'll translate them." }];
    }

    if (call?.name === "plan_subtitles") {
      const p = JSON.parse(raw);

      return [{ kind: "text", delayMs: 40, text: p.error ? `nothing to fix: ${p.error}` : `plan's up. ${p.skipped} subtitles i couldn't place stay where they are.` }];
    }

    if (call?.name === "plan_free_space") {
      const p = JSON.parse(raw);
      const pick = p.choices?.[0];

      return [
        {
          kind: "text",
          delayMs: 40,
          text: p.error
            ? `couldn't plan that: ${p.error}`
            : `plan's up: ${(p.freed / GB).toFixed(1)} GB of copies and junk.${pick ? ` ${p.choices.length} titles come in two versions; ask me "which ${pick.title} to keep".` : ""}`,
        },
      ];
    }

    if (call?.name === "plan_layout") {
      const p = JSON.parse(raw);

      return [{ kind: "text", delayMs: 40, text: p.error ? `couldn't lay it out: ${p.error}` : `plan's up. ${p.skipped} files i couldn't name stay where they are.` }];
    }

    const r = JSON.parse(raw);
    const lines = (r.items ?? []).slice(0, 5).map((i: any) => `- \`${i.path ?? i.name}\` (${i.size})`);

    return [{ kind: "text", delayMs: 40, text: [`${r.total ?? r.count} found, the biggest first; each one opens on put.io from its link.`, "", ...lines].join("\n") }];
  }

  const ask = textOf(last).toLowerCase();

  if (/feedback|report a bug/.test(ask)) {
    return [
      {
        kind: "tool",
        name: "draft_feedback",
        input: { kind: "bug", text: "undo after a cleanup said the library changed since the plan, and nothing was undone. expected the renames and trash to be reversed." },
      },
    ];
  }

  if (/audit|scan/.test(ask)) {
    return [
      { kind: "thinking", text: "No fresh snapshot for this folder. Scan first, then answer from the numbers." },
      { kind: "tool", name: "scan_library", input: {} },
    ];
  }

  if (/translate|turkish/.test(ask)) {
    return [{ kind: "tool", name: "propose_translation", input: { paths: ["/Movies/Heat (1983)/Heat (1983).mkv", "/Movies/Alien (1987)/Alien (1987).mkv"], language: "tur" } }];
  }

  if (/subtitle|subs\b/.test(ask)) {
    return [{ kind: "tool", name: "plan_subtitles", input: { within: "" } }];
  }

  if (/clean/.test(ask)) {
    const releases = titles.slice(0, 3).map((t, i) => ({ t, year: 1979 + i * 4 }));
    const dir = (t: string, year: number) => `/Downloads/${t}.${year}.1080p.BluRay.x264-RARBG`;

    return [
      { kind: "thinking", text: "Junk out, release names cleaned, wrapper folders moved under Movies." },
      {
        kind: "tool",
        name: "propose_changes",
        input: {
          title: "clean up Downloads",
          changes: [
            ...releases.flatMap(({ t, year }) => [
              { op: "trash", path: `${dir(t, year)}/RARBG.txt`, to: null },
              { op: "trash", path: `${dir(t, year)}/${t}.${year}.nfo`, to: null },
              { op: "trash", path: `${dir(t, year)}/${t.toLowerCase()}-sample.mkv`, to: null },
            ]),
            ...releases.map(({ t, year }) => ({ op: "rename", path: `${dir(t, year)}/${t}.${year}.1080p.BluRay.x264-RARBG.mkv`, to: `${t} (${year}).mkv` })),
            ...releases.map(({ t, year }) => ({ op: "move", path: dir(t, year), to: `/Movies/${t} (${year}) [release]` })),
          ],
        },
      },
    ];
  }

  if (/which|keep/.test(ask)) {
    return [
      {
        kind: "tool",
        name: "ask_user",
        input: {
          prompt: "which copy of Heat should I keep?",
          multi: false,
          options: [
            { label: "Heat (1983).mkv", detail: "/Movies · played" },
            { label: "Heat.1995.2160p.WEB-DL.mkv", detail: "/ · 14.0 GB · never played" },
          ],
        },
      },
    ];
  }

  if (/space|free up/.test(ask)) {
    return [{ kind: "tool", name: "plan_free_space", input: { free_gb: 0 } }];
  }

  if (/plex|jellyfin|infuse|kodi|layout/.test(ask)) {
    return [{ kind: "tool", name: "plan_layout", input: { movies: "/Movies", shows: "/Series", within: "" } }];
  }

  if (/download|link/.test(ask)) {
    return [
      {
        kind: "tool",
        name: "make_download_links",
        input: { paths: ["/Heat.1995.2160p.WEB-DL.mkv", "/Movies/Prisoners (2015)/Prisoners (2015).mkv", "/Movies/Sicario (2011)/Sicario (2011).mkv"] },
      },
    ];
  }

  if (/largest|biggest/.test(ask)) {
    return [{ kind: "tool", name: "search_files", input: { query: "", category: "large", limit: 3 } }];
  }

  if (/junk/.test(ask)) {
    return [
      { kind: "thinking", text: "Search the snapshot for junk." },
      { kind: "tool", name: "search_files", input: { query: "", category: "junk", limit: 5 } },
    ];
  }

  if (/folder/.test(ask)) {
    return [{ kind: "tool", name: "list_folder", input: { path: "" } }];
  }

  const long = Array.from(
    { length: 12 },
    (_, i) => `Line ${i + 1}: this reply streams slowly so a stop lands mid-turn.`,
  ).join("\n");

  return [
    {
      kind: "thinking",
      text: "**Reading the question**\n\nThey want a reply, not a scan. No tool needed.\n\n**Planning the answer**\n\nKeep it short, then offer the next step.",
    },
    { kind: "text", text: long, delayMs: 120 },
  ];
};

const RESTART_NONCE = randomBytes(3).toString("hex");
let messageCount = 0;

const anthropic = async (req: IncomingMessage, res: ServerResponse) => {
  const body = JSON.parse(await readBody(req));
  const problems = requestProblems(body);

  if (problems.length > 0) {
    log(`REJECTED messages request: ${problems.join("; ")}`);

    return json(res, 400, { type: "error", error: { type: "invalid_request_error", message: problems.join("; ") } });
  }

  const lines = Predicate.isString(body.system) && body.system.startsWith("Translate English") ? JSON.parse(textOf(body.messages.at(-1))).sentences : null;
  const verdict = Predicate.isString(body.system) && body.system.startsWith("Subtitle sites") ? [{ kind: "text" as const, text: JSON.stringify({ matches: true }), delayMs: 5 }] : null;
  const steps: Array<Step> = verdict ?? (Array.isArray(lines) ? [{ kind: "text", text: JSON.stringify({ sentences: lines.map((s: { id: number; text: string }) => ({ id: s.id, english: s.text, text: `[tr] ${s.text}` })) }), delayMs: 5 }] : plan(body.messages));
  log(`messages model=${body.model} turns=${body.messages.length} → ${steps.map((s) => s.kind).join(",")}`);
  let closed = false;
  res.on("close", () => {
    if (!res.writableFinished) {
      closed = true;
      log("messages stream aborted by client");
    }
  });

  const send = (e: Block) => {
    if (!closed) res.write(frame(e));
  };

  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  send({
    type: "message_start",
    message: {
      id: `msg_fake_${RESTART_NONCE}_${++messageCount}`,
      type: "message",
      role: "assistant",
      model: body.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 2400, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 1800 },
    },
  });
  let stop = "end_turn";

  for (const [index, step] of steps.entries()) {
    if (closed) return;

    if (step.kind === "thinking") {
      send({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } });

      for (const word of step.text.split(/(?<= )/)) {
        await sleep(70);
        send({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: word } });
      }

      send({ type: "content_block_delta", index, delta: { type: "signature_delta", signature: "ZmFrZS1zaWc=" } });
    } else if (step.kind === "tool") {
      stop = "tool_use";
      send({ type: "content_block_start", index, content_block: { type: "tool_use", id: `toolu_fake_${RESTART_NONCE}_${messageCount}`, name: step.name, input: {} } });
      send({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(step.input) } });
    } else {
      send({ type: "content_block_start", index, content_block: { type: "text", text: "" } });

      for (const word of step.text.split(/(?<= )/)) {
        await sleep(step.delayMs);
        send({ type: "content_block_delta", index, delta: { type: "text_delta", text: word } });
      }
    }

    send({ type: "content_block_stop", index });
  }

  send({ type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 420 } });
  send({ type: "message_stop" });
  res.end();
};

const portOf = (address: AddressInfo | string | null) => (address === null || Predicate.isString(address) ? 0 : address.port);

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", upstream);
  const handle = url.pathname.startsWith("/v1/messages") ? anthropic(req, res) : putio(req, res, url);
  handle.catch((cause: unknown) => {
    log(`handler failed: ${cause instanceof Error ? cause.message : String(cause)}`);

    if (!res.headersSent) json(res, 500, { status: "ERROR" });
    else res.end();
  });
});

server.listen(0, "localhost", () => {
  upstream = `http://localhost:${portOf(server.address())}`;
  log(`put.io + Anthropic fake on ${upstream} (${files.length} files)`);
  mkdirSync(".alchemy", { recursive: true });
  const sessionSecret = process.env.FAKE_UNCONFIGURED ? "short" : randomBytes(32).toString("hex");
  writeFileSync(
    ".alchemy/fake.env",
    [
      "ANTHROPIC_API_KEY=sk-ant-fake",
      "PUTIO_CLIENT_ID=fake-client",
      "PUTIO_CLIENT_SECRET=fake-secret",
      `SESSION_SECRET=${sessionSecret}`,
      `DEV_FAKE_UPSTREAM=${upstream}`,
      "",
    ].join("\n"),
  );

  const child = spawn("pnpm", ["exec", "alchemy", "dev", "--stage", "fake", "--env-file", ".alchemy/fake.env"], {
    stdio: "inherit",
    env: { ...process.env, DO_NOT_TRACK: "1" },
  });

  child.on("exit", (code) => process.exit(code ?? 0));

  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
});
