import * as Predicate from "effect/Predicate";
import type { Json } from "effect/Schema";

const CONTENT_TYPES = { FOLDER: "application/x-directory", VIDEO: "video/x-matroska", TEXT: "text/plain" } as const;

export const file = (
  id: number,
  parent_id: number,
  name: string,
  file_type: "FOLDER" | "VIDEO" | "TEXT",
  size = 0,
  seen: { crc32?: string; playedAt?: string } = {},
) => ({
  content_type: CONTENT_TYPES[file_type],
  created_at: "2026-01-01T00:00:00",
  crc32: seen.crc32 ?? null,
  extension: file_type === "VIDEO" ? "mkv" : null,
  file_type,
  first_accessed_at: seen.playedAt ?? null,
  folder_type: "REGULAR",
  icon: null,
  id,
  is_hidden: false,
  is_mp4_available: false,
  is_shared: false,
  name,
  opensubtitles_hash: null,
  parent_id,
  screenshot: null,
  size,
  updated_at: "2026-01-01T00:00:00",
});

const mediaInfoOf = (f: ReturnType<typeof file>): Json =>
  f.file_type === "VIDEO"
    ? {
        mime_type: f.content_type,
        format: { name: "matroska,webm", duration: 6612.4, bit_rate: 8_215_000 },
        streams: [
          { codec_type: "video", codec_name: "hevc", profile: "Main 10", width: 1920, height: 1080 },
          { codec_type: "audio", codec_name: "eac3", channels: 6 },
          { codec_type: "subtitle", codec_name: "subrip" },
        ],
        playback_issues: ["open_gop"],
      }
    : null;

export type FakePutioOptions = {
  files: ReadonlyArray<ReturnType<typeof file>>;
  pageSize: number;
  rateLimitContinue?: { times: number; resetAt: number };
  unauthorized?: boolean;
  trashEnabled?: boolean;
  failWrites?: ReadonlyArray<number>;
  failRenames?: ReadonlyArray<number>;
  loseWriteAnswers?: ReadonlyArray<number>;
  restoreLagListings?: number;
  holdFirstListing?: Promise<void>;
  subtitles?: Readonly<Record<number, ReadonlyArray<{ key: string; language_code: string; source: string; name: string; srt: string }>>>;
};

type PutioRequest = { method: string; url: URL; body: URLSearchParams };

export const makeFakePutio = (opts: FakePutioOptions) => {
  const log: Array<PutioRequest> = [];
  let limited = opts.rateLimitContinue?.times ?? 0;

  const json = (status: number, body: Json, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

  const uploads: Array<{ name: string; parentId: number; text: string }> = [];
  const lagging = new Map<number, number>();
  const linkJobs = new Map<number, number[]>();
  let heldListing = false;
  let tree = [...opts.files];
  const trash: typeof tree = [];
  let listing = tree;

  const page = (offset: number) => {
    const next = offset + opts.pageSize;

    return { files: listing.slice(offset, next), cursor: next < listing.length ? `c${next}` : null };
  };

  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(Predicate.isString(input) ? input : input instanceof URL ? input.href : input.url);
    const body = new URLSearchParams(init?.body == null ? "" : String(init.body));
    log.push({ method: init?.method ?? "GET", url, body });

    if (opts.unauthorized) return json(401, { status: "ERROR", error_type: "invalid_grant", status_code: 401 });

    if (url.pathname === "/v2/files/list") {
      const snapshot = tree.filter((f) => !lagging.has(f.id));

      if (opts.holdFirstListing && !heldListing) {
        heldListing = true;
        await opts.holdFirstListing;
      }

      listing = snapshot;

      for (const [id, n] of lagging) {
        if (n <= 1) lagging.delete(id);
        else lagging.set(id, n - 1);
      }

      return json(200, { ...page(0), parent: null, status: "OK" });
    }

    if (url.pathname === "/v2/files/list/continue") {
      if (limited > 0 && opts.rateLimitContinue) {
        limited--;

        return json(
          429,
          { status: "ERROR", error_type: "RATE_LIMITED", status_code: 429 },
          { "x-ratelimit-reset": String(opts.rateLimitContinue.resetAt), "x-ratelimit-limit": "1000", "x-ratelimit-remaining": "0" },
        );
      }

      return json(200, { ...page(Number((body.get("cursor") ?? "c0").slice(1))), status: "OK" });
    }

    if (url.pathname === "/v2/account/info" && url.searchParams.get("download_token") === "1") {
      return json(200, { info: { user_id: 1, username: "altay", download_token: "dl-token" }, status: "OK" });
    }

    if (url.pathname === "/v2/account/info") return json(200, { info: { user_id: 1, username: "altay", disk: { avail: 5e9, used: 995e9, size: 1e12 } }, status: "OK" });

    if (url.pathname === "/v2/account/settings") return json(200, { settings: { trash_enabled: opts.trashEnabled ?? true }, status: "OK" });

    if (url.pathname === "/v2/download_links/create") {
      const id = 70 + linkJobs.size;
      linkJobs.set(id, (body.get("file_ids") ?? "").split(",").map(Number));

      return json(200, { id, status: "OK" });
    }

    const job = url.pathname.match(/^\/v2\/download_links\/(\d+)$/);

    if (job) {
      const ids = linkJobs.get(Number(job[1]));

      if (!ids) return json(404, { status: "ERROR", error_type: "NOT_FOUND", status_code: 404 });
      const files = ids.flatMap((id) => tree.filter((f) => (f.id === id || f.parent_id === id) && f.file_type !== "FOLDER"));
      const links = files.map((f) => `https://dl.put.io/files/${f.id}/${encodeURIComponent(f.name)}`);

      return json(200, { links_status: "DONE", links: { download_links: links, media_links: [], mp4_links: [] }, status: "OK" });
    }

    const target = Number(body.get("file_ids") ?? body.get("file_id") ?? NaN);
    const fails = (opts.failWrites ?? []).includes(target);

    if (url.pathname === "/v2/trash/restore" && !fails && opts.restoreLagListings) lagging.set(target, opts.restoreLagListings);

    if (["/v2/files/delete", "/v2/files/rename", "/v2/files/move", "/v2/trash/restore"].includes(url.pathname)) {
      if (fails || (url.pathname === "/v2/files/rename" && (opts.failRenames ?? []).includes(target)))
        return json(400, { status: "ERROR", error_type: "LOCKED", status_code: 400 });

      if (url.pathname !== "/v2/trash/restore" && !tree.some((f) => f.id === target)) return json(404, { status: "ERROR", error_type: "NOT_FOUND", status_code: 404 });
      const edit = (f: (typeof tree)[number]) => (f.id === target ? { ...f, ...(url.pathname.endsWith("rename") ? { name: body.get("name") ?? f.name } : { parent_id: Number(body.get("parent_id")) }) } : f);

      if (url.pathname === "/v2/files/delete") {
        trash.push(...tree.filter((f) => f.id === target));
        tree = tree.filter((f) => f.id !== target);
      } else if (url.pathname === "/v2/trash/restore") {
        tree = [...tree, ...trash.filter((f) => f.id === target)];
      } else tree = tree.map(edit);

      return (opts.loseWriteAnswers ?? []).includes(target) ? json(502, { status: "ERROR" }) : json(200, { status: "OK", errors: [] });
    }

    const subs = url.pathname.match(/^\/v2\/files\/(\d+)\/subtitles(?:\/(.+))?$/);

    if (subs) {
      const list = opts.subtitles?.[Number(subs[1])] ?? [];

      if (!subs[2]) return json(200, { subtitles: list.map(({ key, language_code, source, name }) => ({ key, language_code, source, name })), default: null, status: "OK" });
      const one = list.find((x) => x.key === decodeURIComponent(subs[2] ?? ""));

      return one ? new Response(one.srt, { status: 200, headers: { "content-type": "text/plain" } }) : json(404, { status: "ERROR" });
    }

    if (url.pathname === "/v2/files/upload" && init?.body instanceof FormData) {
      const form = init.body;
      const blob = form.get("file");
      const text = blob instanceof Blob ? await blob.text() : "";
      const name = String(form.get("filename") ?? "");
      const parentId = Number(form.get("parent_id"));
      const created = file(9500 + log.length, parentId, name, "TEXT", text.length);
      uploads.push({ name, parentId, text });
      tree = [...tree, created];

      return json(200, { file: created, status: "OK" });
    }

    if (url.pathname === "/v2/files/create-folder") {
      const created = file(9000 + log.length, Number(body.get("parent_id")), body.get("name") ?? "", "FOLDER");
      tree = [...tree, created];

      return json(200, { file: created, status: "OK" });
    }

    const one = url.pathname.match(/^\/v2\/files\/(\d+)$/);
    const found = one && tree.find((f) => f.id === Number(one[1]));

    if (found && url.searchParams.get("media_info") === "1") return json(200, { file: { ...found, media_info: mediaInfoOf(found) }, status: "OK" });

    if (found) return json(200, { file: { ...found, screenshot: `https://img.put.io/s/${found.id}.jpg` }, status: "OK" });

    return json(404, { status: "ERROR", error_type: "NOT_FOUND", status_code: 404 });
  };

  return { fetch: fetchImpl, log, uploads };
};
