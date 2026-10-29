import { getAgentByName } from "agents";
import { Puterminator } from "./agent";
import { accountInfo, authorizeUrl, exchangeCode } from "./putio";
import { clearSession, cookie, createSession, readCookie, readSession } from "./session";

export { Puterminator };

const STATE_COOKIE = "pt_oauth_state";

const json = (data: unknown, init?: ResponseInit) => Response.json(data, init);
const redirect = (to: string, headers: HeadersInit = {}) => new Response(null, { status: 302, headers: { location: to, ...headers } });
const agentFor = (env: Env, uid: string) => getAgentByName(env.Puterminator, uid);

async function handle(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const callback = `${env.PUBLIC_URL}/auth/callback`;

  if (url.pathname === "/auth/login") {
    const state = crypto.randomUUID();
    return redirect(authorizeUrl(env.PUTIO_CLIENT_ID, callback, state), { "set-cookie": cookie(STATE_COOKIE, state, 600) });
  }

  if (url.pathname === "/auth/callback") {
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state || state !== readCookie(req, STATE_COOKIE)) return new Response("Sign-in expired. Try again.", { status: 400 });
    const token = await exchangeCode({ clientId: env.PUTIO_CLIENT_ID, clientSecret: env.PUTIO_CLIENT_SECRET, redirectUri: callback, code });
    const info = await accountInfo(token);
    const uid = `putio-${info.user_id}`;
    await (await agentFor(env, uid)).setAuth(token, info.username);
    const headers = new Headers({ location: "/" });
    headers.append("set-cookie", await createSession(env.SESSION_SECRET, uid));
    headers.append("set-cookie", cookie(STATE_COOKIE, "", 0));
    return new Response(null, { status: 302, headers });
  }

  const session = await readSession(req, env.SESSION_SECRET);

  if (url.pathname === "/auth/logout" && req.method === "POST") {
    if (session) await (await agentFor(env, session.uid)).signOut();
    return json({ ok: true }, { headers: { "set-cookie": clearSession() } });
  }

  if (url.pathname === "/api/me") {
    return json(session ? { signedIn: true } : { signedIn: false });
  }

  if (!session) return json({ error: "unauthorized" }, { status: 401 });

  if (url.pathname === "/api/folders") {
    return json(await (await agentFor(env, session.uid)).rootFolders());
  }

  if (url.pathname === "/agent" || url.pathname.startsWith("/agent/")) {
    const origin = req.headers.get("origin");
    if (req.headers.get("upgrade") === "websocket" && origin && origin !== new URL(env.PUBLIC_URL).origin) {
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
