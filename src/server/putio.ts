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
  parent: PutioFile.optional(),
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
  const res = await fetch(`${API}${path}`, { ...init, headers });
  if (!res.ok) throw new PutioError(`put.io ${path} → ${res.status}`, res.status);
  return schema.parse(await res.json());
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

/**
 * Breadth-first walk of the tree under `rootId`. Stops after `maxFolders`
 * listings so one huge library can't exhaust the Worker subrequest budget.
 */
export async function walk(token: string, rootId: number, maxFolders = 2000) {
  const out: WalkedFile[] = [];
  const queue: { id: number; path: string; depth: number }[] = [{ id: rootId, path: "", depth: 0 }];
  let listed = 0;
  let rootName = "Your Files";
  while (queue.length && listed < maxFolders) {
    const batch = queue.splice(0, 6);
    const pages = await Promise.all(batch.map((f) => listFolder(token, f.id)));
    listed += batch.length;
    pages.forEach((page, i) => {
      const dir = batch[i]!;
      if (dir.id === rootId && rootId !== 0 && page.parent) rootName = page.parent.name;
      for (const f of page.files) {
        const path = `${dir.path}/${f.name}`;
        out.push({ ...f, path, depth: dir.depth + 1 });
        if (f.file_type === "FOLDER") queue.push({ id: f.id, path, depth: dir.depth + 1 });
      }
    });
  }
  return { files: out, rootName, truncated: queue.length > 0, foldersListed: listed };
}
