import { z } from "zod";

const COOKIE = "pt_session";
const MAX_AGE = 60 * 60 * 24 * 30;
const Session = z.object({ uid: z.string(), exp: z.number() });
export type Session = z.infer<typeof Session>;

const enc = new TextEncoder();
const b64url = (buf: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

async function key(secret: string) {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function sign(secret: string, payload: string) {
  return b64url(await crypto.subtle.sign("HMAC", await key(secret), enc.encode(payload)));
}

async function verify(secret: string, payload: string, sig: string) {
  try {
    return await crypto.subtle.verify("HMAC", await key(secret), fromB64url(sig), enc.encode(payload));
  } catch {
    return false;
  }
}

export function readCookie(req: Request, name: string) {
  const header = req.headers.get("cookie") ?? "";
  for (const part of header.split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1));
  }
  return null;
}

export function cookie(name: string, value: string, maxAge: number) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export async function createSession(secret: string, uid: string) {
  const payload = b64url(enc.encode(JSON.stringify({ uid, exp: Math.floor(Date.now() / 1000) + MAX_AGE })));
  return cookie(COOKIE, `${payload}.${await sign(secret, payload)}`, MAX_AGE);
}

export const clearSession = () => cookie(COOKIE, "", 0);

export async function readSession(req: Request, secret: string): Promise<Session | null> {
  const raw = readCookie(req, COOKIE);
  if (!raw) return null;
  const [payload, sig] = raw.split(".");
  if (!payload || !sig || !(await verify(secret, payload, sig))) return null;
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(fromB64url(payload)));
  } catch {
    return null;
  }
  const parsed = Session.safeParse(json);
  if (!parsed.success || parsed.data.exp < Date.now() / 1000) return null;
  return parsed.data;
}
