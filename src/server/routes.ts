import * as Effect from "effect/Effect";
import type { HttpServerError } from "effect/http/HttpServerError";
import type { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import type { Folder, Me } from "../shared/contract";
import type { DownloadLinksResponse } from "../shared/tools";
import type { AppConfig } from "./config";
import { accountInfo, authorizeUrl, exchangeCode, putioLayer } from "./putio";
import {
  cookieOptions,
  SESSION_COOKIE,
  SESSION_MAX_AGE_SEC,
  STATE_COOKIE,
  STATE_MAX_AGE_SEC,
  signSession,
  verifySession,
} from "./session";

/** The Worker's view of one user's Durable Object. */
export interface UserAgent {
  /** Stores the token and answers the session generation to sign. */
  readonly setAuth: (token: string, username: string, avatarUrl: string | null) => Effect.Effect<number>;
  /** Drops the token and ends every session signed so far. */
  readonly signOut: () => Effect.Effect<void>;
  readonly sessionGen: () => Effect.Effect<number>;
  readonly thumbnail: (id: number) => Effect.Effect<string | null>;
  readonly stream: (id: number) => Effect.Effect<string | null>;
  readonly downloadLinks: (id: number) => Effect.Effect<DownloadLinksResponse | null>;
  readonly fetch: (request: HttpServerRequest) => Effect.Effect<HttpServerResponse.HttpServerResponse, HttpServerError>;
}

export interface RouteDeps {
  readonly config: AppConfig;
  readonly agentFor: (uid: string) => UserAgent;
  readonly putioFetch?: typeof fetch;
}

const text = (body: string, status: number) => HttpServerResponse.text(body, { status });
const json = (body: unknown, status = 200) => HttpServerResponse.jsonUnsafe(body, { status });

/** Every Worker route. `publicUrl` is the Worker's own URL: the custom domain, or localhost under dev. */
export const makeHandler = (deps: RouteDeps) => (request: HttpServerRequest, publicUrl: string) =>
  Effect.gen(function* () {
    const origin = URL.canParse(publicUrl) ? new URL(publicUrl).origin : null;
    const url = new URL(request.url, origin ?? "http://localhost");
    const auth = origin ? deps.config.auth : null;
    const path = url.pathname;

    const current = (raw: string | undefined) =>
      Effect.gen(function* () {
        const session = auth ? yield* verifySession(auth.sessionSecret, raw) : Option.none();
        if (Option.isNone(session)) return session;
        const gen = yield* deps.agentFor(session.value.uid).sessionGen();
        return (session.value.gen ?? 0) === gen ? session : Option.none();
      });

    if (path === "/api/me") {
      const session = yield* current(request.cookies[SESSION_COOKIE]);
      const me: Me = { configured: auth !== null, signedIn: Option.isSome(session) };
      return json(me);
    }

    if (!auth || !origin) {
      if (path.startsWith("/auth/")) return HttpServerResponse.redirect("/");
      return json({ error: "sign-in is not configured" }, 503);
    }
    const callback = `${origin}/auth/callback`;

    if (path === "/auth/login") {
      const state = crypto.randomUUID();
      return HttpServerResponse.redirect(authorizeUrl(auth.putioClientId, callback, state, deps.config.devUpstream ?? undefined)).pipe(
        HttpServerResponse.setCookieUnsafe(STATE_COOKIE, state, cookieOptions(STATE_MAX_AGE_SEC)),
      );
    }

    if (path === "/auth/callback") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!code || !state || state !== request.cookies[STATE_COOKIE]) return text("Sign-in expired. Try again.", 400);
      const signedIn = yield* Effect.gen(function* () {
        const token = yield* exchangeCode({
          clientId: auth.putioClientId,
          clientSecret: Redacted.value(auth.putioClientSecret),
          redirectUri: callback,
          code,
        });
        const info = yield* accountInfo.pipe(Effect.provide(putioLayer(token, deps.putioFetch)));
        return { token, info };
      }).pipe(Effect.provide(putioLayer(undefined, deps.putioFetch)), Effect.result);
      if (signedIn._tag === "Failure") {
        yield* Effect.logWarning("sign-in failed", signedIn.failure._tag);
        return text("Sign-in failed. Try again.", 502);
      }
      const uid = `putio-${signedIn.success.info.userId}`;
      const gen = yield* deps.agentFor(uid).setAuth(signedIn.success.token, signedIn.success.info.username, signedIn.success.info.avatarUrl);
      const session = yield* signSession(auth.sessionSecret, uid, gen);
      return HttpServerResponse.redirect("/").pipe(
        HttpServerResponse.setCookieUnsafe(SESSION_COOKIE, session, cookieOptions(SESSION_MAX_AGE_SEC)),
        HttpServerResponse.expireCookieUnsafe(STATE_COOKIE, { path: "/", httpOnly: true, secure: true, sameSite: "lax" }),
      );
    }

    const session = yield* current(request.cookies[SESSION_COOKIE]);

    if (path === "/auth/logout" && request.method === "POST") {
      if (Option.isSome(session)) yield* deps.agentFor(session.value.uid).signOut();
      return json({ ok: true }).pipe(
        HttpServerResponse.expireCookieUnsafe(SESSION_COOKIE, { path: "/", httpOnly: true, secure: true, sameSite: "lax" }),
      );
    }

    if (Option.isNone(session)) return json({ error: "unauthorized" }, 401);
    const agent = deps.agentFor(session.value.uid);

    const media = path.match(/^\/api\/files\/(\d{1,15})\/(thumb|stream)$/);
    if (media && request.method === "GET") {
      const id = Number(media[1]);
      if (media[2] === "thumb") {
        const url = yield* agent.thumbnail(id);
        const dev = deps.config.devUpstream;
        return url && (/^https:\/\//.test(url) || (dev !== null && url.startsWith(`${dev}/`)))
          ? HttpServerResponse.redirect(url).pipe(HttpServerResponse.setHeader("cache-control", "private, max-age=3600"))
          : HttpServerResponse.empty({ status: 404 }).pipe(HttpServerResponse.setHeader("cache-control", "private, max-age=3600"));
      }
      const hls = yield* agent.stream(id);
      return hls ? json({ hls }).pipe(HttpServerResponse.setHeader("cache-control", "no-store")) : json({ error: "no stream" }, 404);
    }

    const links = path.match(/^\/api\/download-links\/(\d{1,15})$/);
    if (links && request.method === "GET") {
      const result = yield* agent.downloadLinks(Number(links[1]));
      return (result ? json(result) : json({ error: "no such links" }, 404)).pipe(HttpServerResponse.setHeader("cache-control", "no-store"));
    }

    if (path === "/agent" || path.startsWith("/agent/")) {
      if (request.headers.upgrade?.toLowerCase() !== "websocket") return text("Expected a WebSocket upgrade.", 426);
      const from = request.headers.origin;
      if (from && from !== origin) return text("bad origin", 403);
      return yield* agent.fetch(request);
    }

    return text("not found", 404);
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logError("request failed", cause).pipe(Effect.as(text("Something broke on our side.", 500))),
    ),
  );
