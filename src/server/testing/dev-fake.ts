// `pnpm dev:fake`: the real Worker and Durable Object under `alchemy dev`, with put.io and
// Anthropic replaced by this local server at the network boundary (DEV_FAKE_UPSTREAM).
// Sign-in runs the real OAuth routes against the fake. Nothing here reaches the network.
//   Prompts: "audit" or "scan" scans; "junk" searches; "folders" lists; anything else streams a long reply.
//   FAKE_UNCONFIGURED=1 starts with a short SESSION_SECRET, so the app shows the unconfigured state.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const PORT = Number(process.env.FAKE_PORT ?? 8788);
const UPSTREAM = `http://localhost:${PORT}`;
const TOKEN = "fake-putio-token";
const CODE = "fake-code";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- library ----------

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
let nextId = 1000;
const add = (parent: number, name: string, type: File["file_type"], size = 0, played = false): number => {
  const id = nextId++;
  const extension = type === "FOLDER" ? null : (name.split(".").pop() ?? null);
  files.push({
    id,
    parent_id: parent,
    name,
    size,
    file_type: type,
    extension,
    crc32: type === "VIDEO" ? id.toString(16).padStart(8, "0") : null,
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
add(0, "www.Torrenting.com - Notes.url", "TEXT", 200);
add(0, "Thumbs.db", "TEXT", 12_000);
add(add(0, "New Folder", "FOLDER"), "Untitled", "FOLDER");

const byParent = (parent: number) => files.filter((f) => parent === -1 || f.parent_id === parent);

// ---------- put.io ----------

const log = (line: string) => console.log(`[fake] ${line}`);
const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
const readBody = async (req: IncomingMessage) => {
  const chunks: Array<Buffer> = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
};
const authorized = (req: IncomingMessage) => (req.headers.authorization ?? "").endsWith(TOKEN);

// Cursors carry offset and parent. A page holds at most 50 files, so a scan always continues.
const page = (parent: number, offset: number, perPage: number) => {
  const all = byParent(parent);
  const size = Math.min(perPage, 50);
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
    const info = { user_id: 4242, username: "altay", mail: "dev@localhost", disk: {} };
    return json(res, 200, { info: url.searchParams.get("download_token") === "1" ? { ...info, download_token: "fake-dl" } : info, status: "OK" });
  }
  const one = route.match(/^GET \/v2\/files\/(\d+)$/);
  const found = one && files.find((f) => f.id === Number(one[1]));
  if (found) {
    const screenshot = found.file_type === "VIDEO" ? `${UPSTREAM}/screenshot/${found.id}.svg` : null;
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
  log(`UNEXPECTED put.io call: ${route}`);
  return json(res, method === "GET" ? 404 : 405, { status: "ERROR", error_type: "NOT_FAKED", status_code: 404 });
};

// ---------- Anthropic ----------

type Block = Record<string, unknown> & { type: string };
type Message = { role: string; content: string | Array<Block> };

// The strict tool-use rules this app relies on (see runner.ts). The live API is the authority; this only catches regressions.
const FORBIDDEN = ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength", "pattern", "$ref"];
const schemaProblems = (node: unknown, at: string): Array<string> => {
  if (typeof node !== "object" || node === null) return [];
  const n = node as Record<string, unknown>;
  const own = FORBIDDEN.filter((k) => k in n).map((k) => `${at}: ${k}`);
  if (n.type === "object" && n.additionalProperties !== false) own.push(`${at}: additionalProperties`);
  return [...own, ...Object.entries(n).flatMap(([k, v]) => schemaProblems(v, `${at}/${k}`))];
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
  | { kind: "tool"; name: string; input: Record<string, unknown> }
  | { kind: "text"; text: string; delayMs: number };

const textOf = (m: Message | undefined) =>
  typeof m?.content === "string" ? m.content : (m?.content.find((b) => b.type === "text")?.text as string | undefined) ?? "";

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
    const r = JSON.parse(raw);
    const lines = (r.items ?? []).slice(0, 5).map((i: any) => `- \`${i.path ?? i.name}\``);
    return [{ kind: "text", delayMs: 40, text: [`${r.total ?? r.count} found.`, ...lines].join("\n") }];
  }
  const ask = textOf(last).toLowerCase();
  if (/audit|scan/.test(ask)) {
    return [
      { kind: "thinking", text: "No fresh snapshot for this folder. Scan first, then answer from the numbers." },
      { kind: "tool", name: "scan_library", input: {} },
    ];
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
    { kind: "thinking", text: "No tool needed. Answer directly." },
    { kind: "text", text: long, delayMs: 120 },
  ];
};

let messageCount = 0;
const anthropic = async (req: IncomingMessage, res: ServerResponse) => {
  const body = JSON.parse(await readBody(req));
  const problems = requestProblems(body);
  if (problems.length > 0) {
    log(`REJECTED messages request: ${problems.join("; ")}`);
    return json(res, 400, { type: "error", error: { type: "invalid_request_error", message: problems.join("; ") } });
  }
  const steps = plan(body.messages);
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
      id: `msg_fake_${++messageCount}`,
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
      send({ type: "content_block_start", index, content_block: { type: "tool_use", id: `toolu_fake_${messageCount}`, name: step.name, input: {} } });
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

// ---------- server and launcher ----------

createServer((req, res) => {
  const url = new URL(req.url ?? "/", UPSTREAM);
  const handle = url.pathname.startsWith("/v1/messages") ? anthropic(req, res) : putio(req, res, url);
  handle.catch((e: unknown) => {
    log(`handler failed: ${e instanceof Error ? e.message : String(e)}`);
    if (!res.headersSent) json(res, 500, { status: "ERROR" });
    else res.end();
  });
}).listen(PORT, "localhost", () => {
  log(`put.io + Anthropic fake on ${UPSTREAM} (${files.length} files)`);
  // Throwaway values, generated per run; the file sits under .alchemy/ (gitignored).
  mkdirSync(".alchemy", { recursive: true });
  const sessionSecret = process.env.FAKE_UNCONFIGURED ? "short" : randomBytes(32).toString("hex");
  writeFileSync(
    ".alchemy/fake.env",
    [
      "ANTHROPIC_API_KEY=sk-ant-fake",
      "PUTIO_CLIENT_ID=fake-client",
      "PUTIO_CLIENT_SECRET=fake-secret",
      `SESSION_SECRET=${sessionSecret}`,
      `DEV_FAKE_UPSTREAM=${UPSTREAM}`,
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
