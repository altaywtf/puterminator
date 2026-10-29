import { getAgentByName } from "agents";
import { z } from "zod";
import { Puterminator } from "./agent";
import { accountInfo, authorizeUrl, exchangeCode } from "./putio";
import { clearSession, cookie, createSession, readCookie, readSession } from "./session";

export { Puterminator };

const STATE_COOKIE = "pt_oauth_state";

const json = (data: unknown, init?: ResponseInit) => Response.json(data, init);
const redirect = (to: string, headers: HeadersInit = {}) => new Response(null, { status: 302, headers: { location: to, ...headers } });
const agentFor = (env: Env, uid: string) => getAgentByName(env.Puterminator, uid);

// Secrets arrive as untyped strings; a missing one must stop sign-in, not leak "undefined" into a put.io URL.
const secret = z.string().trim().min(1).refine((v) => v !== "undefined" && v !== "null");
const AuthConfig = z.object({
  PUBLIC_URL: z.url(),
  PUTIO_CLIENT_ID: secret,
  PUTIO_CLIENT_SECRET: secret,
  SESSION_SECRET: secret.refine((v) => v.length >= 32),
});
type AuthConfig = z.infer<typeof AuthConfig>;

function authConfig(env: Env): AuthConfig | null {
  const parsed = AuthConfig.safeParse(env);
  if (!parsed.success) console.warn("sign-in is not configured:", parsed.error.issues.map((i) => i.path.join(".")).join(", "));
  return parsed.success ? parsed.data : null;
}

async function handle(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const config = authConfig(env);

  if (url.pathname === "/api/me") {
    const session = config && (await readSession(req, config.SESSION_SECRET));
    return json({ configured: !!config, signedIn: !!session });
  }

  if (!config) {
    if (url.pathname.startsWith("/auth/")) return redirect("/");
    return json({ error: "sign-in is not configured" }, { status: 503 });
  }
  const callback = `${config.PUBLIC_URL}/auth/callback`;

  if (url.pathname === "/auth/login") {
    const state = crypto.randomUUID();
    return redirect(authorizeUrl(config.PUTIO_CLIENT_ID, callback, state), { "set-cookie": cookie(STATE_COOKIE, state, 600) });
  }

  if (url.pathname === "/auth/callback") {
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state || state !== readCookie(req, STATE_COOKIE)) return new Response("Sign-in expired. Try again.", { status: 400 });
    const token = await exchangeCode({ clientId: config.PUTIO_CLIENT_ID, clientSecret: config.PUTIO_CLIENT_SECRET, redirectUri: callback, code });
    const info = await accountInfo(token);
    const uid = `putio-${info.user_id}`;
    await (await agentFor(env, uid)).setAuth(token, info.username);
    const headers = new Headers({ location: "/" });
    headers.append("set-cookie", await createSession(config.SESSION_SECRET, uid));
    headers.append("set-cookie", cookie(STATE_COOKIE, "", 0));
    return new Response(null, { status: 302, headers });
  }

  const session = await readSession(req, config.SESSION_SECRET);

  if (url.pathname === "/auth/logout" && req.method === "POST") {
    if (session) await (await agentFor(env, session.uid)).signOut();
    return json({ ok: true }, { headers: { "set-cookie": clearSession() } });
  }

  if (!session) return json({ error: "unauthorized" }, { status: 401 });

  if (url.pathname === "/api/folders") {
    return json(await (await agentFor(env, session.uid)).rootFolders());
  }

  if (url.pathname === "/agent" || url.pathname.startsWith("/agent/")) {
    const origin = req.headers.get("origin");
    if (req.headers.get("upgrade") === "websocket" && origin && origin !== new URL(config.PUBLIC_URL).origin) {
      return new Response("bad origin", { status: 403 });
    }
    return (await agentFor(env, session.uid)).fetch(req);
  }

  return new Response("not found", { status: 404 });
}

export default {
  async fetch(req, env) {
    try {
      return await handle(req, env);
    } catch (err) {
      console.error(err);
      return new Response("Something broke on our side.", { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;
