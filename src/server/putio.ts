import { z } from "zod";

const API = "https://api.put.io/v2";

export const PutioFile = z.object({
  id: z.number(),
  parent_id: z.number().nullable(),
  name: z.string(),
  size: z.number(),
  file_type: z.string(),
  extension: z.string().nullable(),
  crc32: z.string().nullable(),
  created_at: z.string(),
  first_accessed_at: z.string().nullable(),
});
export type PutioFile = z.infer<typeof PutioFile>;

const ListPage = z.object({
  files: z.array(PutioFile),
  parent: PutioFile.nullish(),
  cursor: z.string().nullable(),
});

const AccountInfo = z.object({ info: z.object({ user_id: z.number(), username: z.string() }) });
const AccessToken = z.object({ access_token: z.string() });

export class PutioError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function call<T>(schema: z.ZodType<T>, token: string | null, path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("accept", "application/json");
  if (token) headers.set("authorization", `token ${token}`);
  // Every call here is a read, so retrying a 429 is safe. Bounded: four short waits at most.
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}${path}`, { ...init, headers });
    if (res.status === 429) {
      // put.io allows a fixed number of requests per window; `x-ratelimit-reset` is when it refills (epoch seconds).
      const reset = Number(res.headers.get("x-ratelimit-reset"));
      const waitMs = Number.isFinite(reset) && reset > 0 ? reset * 1000 - Date.now() : 1000 * 2 ** attempt;
      if (attempt < 4 && waitMs <= 10_000) {
        await new Promise((r) => setTimeout(r, Math.max(waitMs, 500)));
        continue;
      }
      const minutes = Math.max(1, Math.ceil(waitMs / 60_000));
      throw new PutioError(`put.io rate limit: try again in about ${minutes} minute${minutes === 1 ? "" : "s"}.`, 429);
    }
    if (!res.ok) throw new PutioError(`put.io ${path.split("?")[0]} → ${res.status}`, res.status);
    return schema.parse(await res.json());
  }
}

export function authorizeUrl(clientId: string, redirectUri: string, state: string) {
  const q = new URLSearchParams({ client_id: clientId, response_type: "code", redirect_uri: redirectUri, state });
  return `${API}/oauth2/authenticate?${q}`;
}

export async function exchangeCode(opts: { clientId: string; clientSecret: string; redirectUri: string; code: string }) {
  const body = new URLSearchParams({
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    grant_type: "authorization_code",
    redirect_uri: opts.redirectUri,
    code: opts.code,
  });
  const r = await call(AccessToken, null, "/oauth2/access_token", { method: "POST", body });
  return r.access_token;
}

export async function accountInfo(token: string) {
  return (await call(AccountInfo, token, "/account/info")).info;
}

/** All direct children of one folder, following put.io's cursor pagination. */
export async function listFolder(token: string, parentId: number) {
  const q = new URLSearchParams({ parent_id: String(parentId), per_page: "1000", hidden: "1" });
  const first = await call(ListPage, token, `/files/list?${q}`);
  const files = [...first.files];
  let cursor = first.cursor;
  while (cursor) {
    const page = await call(ListPage, token, "/files/list/continue", {
      method: "POST",
      body: new URLSearchParams({ cursor, per_page: "1000" }),
    });
    files.push(...page.files);
    cursor = page.cursor;
  }
  return { parent: first.parent, files };
}

export type WalkedFile = PutioFile & { path: string; depth: number };

/** Every file the user has, in pages of 2,000. put.io's `parent_id=-1` means "all files", flat. */
export async function listAll(token: string) {
  const q = new URLSearchParams({ parent_id: "-1", per_page: "2000", hidden: "1" });
  const first = await call(ListPage, token, `/files/list?${q}`);
  const files = [...first.files];
  let cursor = first.cursor;
  while (cursor) {
    const page = await call(ListPage, token, "/files/list/continue", {
      method: "POST",
      body: new URLSearchParams({ cursor, per_page: "2000" }),
    });
    files.push(...page.files);
    cursor = page.cursor;
  }
  return files;
}

/** Rebuild paths for everything under `rootId` (0 is Your Files) from a flat listing. */
export function buildTree(all: PutioFile[], rootId: number) {
  const byId = new Map(all.map((f) => [f.id, f]));
  const memo = new Map<number, { path: string; depth: number } | null>([[rootId, { path: "", depth: 0 }]]);
  const place = (id: number, seen = new Set<number>()): { path: string; depth: number } | null => {
    const hit = memo.get(id);
    if (hit !== undefined) return hit;
    const f = byId.get(id);
    if (!f || f.parent_id == null || seen.has(id)) return null;
    seen.add(id);
    const parent = place(f.parent_id, seen);
    const here = parent && { path: `${parent.path}/${f.name}`, depth: parent.depth + 1 };
    memo.set(id, here);
    return here;
  };
  const files: WalkedFile[] = [];
  for (const f of all) {
    if (f.id === rootId) continue;
    const at = place(f.id);
    if (at) files.push({ ...f, ...at });
  }
  return { files, rootName: rootId === 0 ? "Your Files" : (byId.get(rootId)?.name ?? "Your Files") };
}

export async function walk(token: string, rootId: number) {
  const { files, rootName } = buildTree(await listAll(token), rootId);
  return { files, rootName, truncated: false };
}
