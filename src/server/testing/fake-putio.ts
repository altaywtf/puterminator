// put.io at the fetch boundary, in the API's recorded response shapes. No network.

export const file = (id: number, parent_id: number, name: string, file_type: "FOLDER" | "VIDEO" | "TEXT", size = 0) => ({
  content_type: file_type === "FOLDER" ? "application/x-directory" : "video/mp4",
  created_at: "2026-01-01T00:00:00",
  crc32: null,
  extension: file_type === "VIDEO" ? "mkv" : null,
  file_type,
  first_accessed_at: null,
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

export type FakePutioOptions = {
  files: ReadonlyArray<ReturnType<typeof file>>;
  pageSize: number;
  /** Answer the first `times` continue requests with 429, refilling at `resetAt` (epoch seconds). */
  rateLimitContinue?: { times: number; resetAt: number };
  unauthorized?: boolean;
  /** put.io's account setting; with it off, delete is permanent. Default on. */
  trashEnabled?: boolean;
  /** File ids whose writes fail with a 400. */
  failWrites?: ReadonlyArray<number>;
  /** A restored file stays out of this many following listings, as put.io restores in the background. */
  restoreLag?: number;
};

export type PutioRequest = { method: string; url: URL; body: URLSearchParams };

export const makeFakePutio = (opts: FakePutioOptions) => {
  const log: Array<PutioRequest> = [];
  let limited = opts.rateLimitContinue?.times ?? 0;
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const lagging = new Map<number, number>();
  let listing = opts.files;
  const page = (offset: number) => {
    const next = offset + opts.pageSize;
    return { files: listing.slice(offset, next), cursor: next < listing.length ? `c${next}` : null };
  };

  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const body = new URLSearchParams(init?.body == null ? "" : String(init.body));
    log.push({ method: init?.method ?? "GET", url, body });
    if (opts.unauthorized) return json(401, { status: "ERROR", error_type: "invalid_grant", status_code: 401 });

    if (url.pathname === "/v2/files/list") {
      listing = opts.files.filter((f) => !lagging.has(f.id));
      for (const [id, n] of lagging) n <= 1 ? lagging.delete(id) : lagging.set(id, n - 1);
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
    if (url.pathname === "/v2/account/info" && url.searchParams.get("download_token") === "1")
      return json(200, { info: { user_id: 1, username: "altay", download_token: "dl-token" }, status: "OK" });
    if (url.pathname === "/v2/account/settings") return json(200, { settings: { trash_enabled: opts.trashEnabled ?? true }, status: "OK" });
    const target = Number(body.get("file_ids") ?? body.get("file_id") ?? NaN);
    const fails = (opts.failWrites ?? []).includes(target);
    if (url.pathname === "/v2/trash/restore" && !fails && opts.restoreLag) lagging.set(target, opts.restoreLag);
    if (["/v2/files/delete", "/v2/files/rename", "/v2/files/move", "/v2/trash/restore"].includes(url.pathname))
      return fails ? json(400, { status: "ERROR", error_type: "LOCKED", status_code: 400 }) : json(200, { status: "OK", errors: [] });
    if (url.pathname === "/v2/files/create-folder") return json(200, { file: { ...file(9000 + log.length, Number(body.get("parent_id")), body.get("name") ?? "", "FOLDER") }, status: "OK" });
    const one = url.pathname.match(/^\/v2\/files\/(\d+)$/);
    const found = one && opts.files.find((f) => f.id === Number(one[1]));
    if (found) return json(200, { file: { ...found, screenshot: `https://img.put.io/s/${found.id}.jpg` }, status: "OK" });
    return json(404, { status: "ERROR", error_type: "NOT_FOUND", status_code: 404 });
  };
  return { fetch: fetchImpl as typeof fetch, log };
};
