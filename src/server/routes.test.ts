import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { describe, expect, it } from "vitest";
import { readConfig } from "./config";
import { makeHandler, type UserAgent } from "./routes";

const PUBLIC_URL = "https://puterminator.test";

const valid = {
  PUTIO_CLIENT_ID: "1234",
  PUTIO_CLIENT_SECRET: "client-secret",
  SESSION_SECRET: "s".repeat(32),
  ANTHROPIC_API_KEY: "sk-test",
};

const configFrom = (env: Record<string, string>) =>
  Effect.runPromiseExit(readConfig.pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env)))));

const noAgent = (): UserAgent => {
  throw new Error("no route may reach a Durable Object without valid sign-in config");
};

const call = async (env: Record<string, string>, path: string, init?: RequestInit, publicUrl = PUBLIC_URL) => {
  const config = await configFrom(env);

  if (!Exit.isSuccess(config)) throw new Error("config failed");
  const handle = makeHandler({ config: config.value, agentFor: noAgent });
  const response = await Effect.runPromise(handle(HttpServerRequest.fromWeb(new Request(`${PUBLIC_URL}${path}`, init)), publicUrl));

  return HttpServerResponse.toWeb(response);
};

describe("config", () => {
  it("fails Init when a required key is missing, so a deploy cannot drop a live secret", async () => {
    for (const key of Object.keys(valid)) {
      const env = Object.fromEntries(Object.entries(valid).filter(([name]) => name !== key));
      expect(Exit.isFailure(await configFrom(env)), key).toBe(true);
    }
  });

  it("reads defaults for MODEL and MONTHLY_TOKEN_CAP", async () => {
    const exit = await configFrom(valid);
    expect(Exit.isSuccess(exit) && [exit.value.model, exit.value.monthlyTokenCap]).toEqual(["claude-sonnet-5-5", 1_000_000]);
  });

  it("serves configured:true and starts OAuth with valid secrets", async () => {
    expect(await (await call(valid, "/api/me")).json()).toEqual({ configured: true, signedIn: false });
    const login = await call(valid, "/auth/login");
    expect(login.status).toBe(302);
    const to = new URL(login.headers.get("location") ?? "");
    expect(to.origin + to.pathname).toBe("https://api.put.io/v2/oauth2/authenticate");
    expect(to.searchParams.get("client_id")).toBe("1234");
    expect(to.searchParams.get("redirect_uri")).toBe(`${PUBLIC_URL}/auth/callback`);
    const state = to.searchParams.get("state");
    expect(login.headers.getSetCookie().find((c) => c.startsWith("__Host-pt_oauth_state="))).toContain(`__Host-pt_oauth_state=${state}`);
    expect((await call(valid, "/api/files/1/thumb")).status).toBe(401);
  });

  for (const [why, env, publicUrl] of [
    ["a short SESSION_SECRET", { ...valid, SESSION_SECRET: "s".repeat(31) }, PUBLIC_URL],
    ["a blank PUTIO_CLIENT_ID", { ...valid, PUTIO_CLIENT_ID: "  " }, PUBLIC_URL],
    ["an 'undefined' PUTIO_CLIENT_SECRET", { ...valid, PUTIO_CLIENT_SECRET: "undefined" }, PUBLIC_URL],
    ["a public URL that does not parse", valid, "not a url"],
  ] as const) {
    it(`fails closed with ${why}`, async () => {
      expect(await (await call(env, "/api/me", undefined, publicUrl)).json()).toEqual({ configured: false, signedIn: false });
      const login = await call(env, "/auth/login", undefined, publicUrl);
      expect([login.status, login.headers.get("location")]).toEqual([302, "/"]);
      expect((await call(env, "/auth/callback?code=c&state=s", undefined, publicUrl)).headers.get("location")).toBe("/");
      expect((await call(env, "/api/files/1/thumb", undefined, publicUrl)).status).toBe(503);
      expect((await call(env, "/agent", { headers: { upgrade: "websocket" } }, publicUrl)).status).toBe(503);
    });
  }
});

describe("OAuth callback", () => {
  const putio: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);

    if (url.pathname === "/v2/oauth2/access_token") {
      const form = new URLSearchParams(await request.text());

      if (form.get("code") !== "good-code") return Response.json({ error: "invalid_grant" }, { status: 400 });

      return Response.json({ access_token: "tok-1" });
    }

    if (url.pathname === "/v2/account/info" && request.headers.get("authorization")?.endsWith("tok-1")) {
      return Response.json({ info: { user_id: 77, username: "altay", avatar_url: avatar, disk: {} }, status: "OK" });
    }

    return Response.json({ status: "ERROR" }, { status: 401 });
  };

  let avatar = "https://www.gravatar.com/avatar/abc";

  const callback = async (code: string) => {
    const config = await configFrom(valid);

    if (!Exit.isSuccess(config)) throw new Error("config failed");
    const calls: Array<[string, string, string, string | null]> = [];

    const agent = (uid: string): UserAgent => ({
      setAuth: (token, username, avatarUrl) =>
        Effect.sync(() => {
          calls.push([uid, token, username, avatarUrl]);

          return gen;
        }),
      signOut: () => Effect.sync(() => void gen++),
      deleteData: () => Effect.sync(() => (gen++, true)),
      sessionGen: () => Effect.sync(() => gen),
      thumbnail: () => Effect.succeed(null),
      stream: () => Effect.succeed(null),
      downloadLinks: () => Effect.succeed(null),
      fetch: () => Effect.die("unused"),
    });

    const handle = makeHandler({ config: config.value, agentFor: agent, putioFetch: putio });
    const request = new Request(`${PUBLIC_URL}/auth/callback?code=${code}&state=st`, { headers: { cookie: "__Host-pt_oauth_state=st" } });
    const response = HttpServerResponse.toWeb(await Effect.runPromise(handle(HttpServerRequest.fromWeb(request), PUBLIC_URL)));
    const session = response.headers.getSetCookie().find((c) => c.startsWith("__Host-pt_session=")) ?? "";
    const cookie = session.split(";")[0] ?? "";

    const get = async (path: string, method = "GET") =>
      HttpServerResponse.toWeb(await Effect.runPromise(handle(HttpServerRequest.fromWeb(new Request(`${PUBLIC_URL}${path}`, { method, headers: { cookie } })), PUBLIC_URL)));

    return { response, calls, session, get, me: await (await get("/api/me")).json() };
  };

  let gen = 0;

  it("exchanges the code, stores the token in the user's object and signs a session", async () => {
    const { response, calls, session, me } = await callback("good-code");
    expect([response.status, response.headers.get("location")]).toEqual([302, "/"]);
    expect(calls).toEqual([["putio-77", "tok-1", "altay", "https://www.gravatar.com/avatar/abc"]]);
    expect(session).toMatch(/HttpOnly/);
    expect(me).toEqual({ configured: true, signedIn: true });
  });

  it("ends the session on logout, even for a copy of the cookie kept elsewhere", async () => {
    const { get, session } = await callback("good-code");
    expect(session).toMatch(/Secure/);
    expect(session).toMatch(/Path=\//);
    expect(await (await get("/api/me")).json()).toEqual({ configured: true, signedIn: true });
    expect((await get("/auth/logout", "POST")).status).toBe(200);
    expect(await (await get("/api/me")).json()).toEqual({ configured: true, signedIn: false });
    expect((await get("/api/files/1/thumb")).status).toBe(401);
  });

  it("ends the session when the user deletes their data", async () => {
    const { get } = await callback("good-code");
    expect((await get("/auth/delete", "POST")).headers.getSetCookie().some((c) => c.startsWith("__Host-pt_session=;"))).toBe(true);
    expect(await (await get("/api/me")).json()).toEqual({ configured: true, signedIn: false });
    expect((await get("/auth/delete", "POST")).status).toBe(401);
  });

  it("keeps only an https avatar, since the browser loads it directly", async () => {
    for (const bad of ["http://www.gravatar.com/avatar/abc", "javascript:alert(1)", ""]) {
      avatar = bad;
      const { calls } = await callback("good-code");
      expect(calls[0]?.[3], bad).toBeNull();
    }

    avatar = "https://www.gravatar.com/avatar/abc";
  });

  it("answers 502 and stores nothing when put.io rejects the code", async () => {
    const { response, calls, me } = await callback("reused-code");
    expect(response.status).toBe(502);
    expect(calls).toEqual([]);
    expect(me).toEqual({ configured: true, signedIn: false });
  });
});

describe("DEV_FAKE_UPSTREAM", () => {
  it("accepts only a loopback http URL, and sends sign-in there", async () => {
    for (const bad of ["https://localhost:8788", "http://api.put.io", "http://10.0.0.1:8788", "nope"]) {
      expect(Exit.isFailure(await configFrom({ ...valid, DEV_FAKE_UPSTREAM: bad })), bad).toBe(true);
    }

    const to = new URL((await call({ ...valid, DEV_FAKE_UPSTREAM: "http://localhost:8788" }, "/auth/login")).headers.get("location") ?? "");
    expect(to.origin + to.pathname).toBe("http://localhost:8788/v2/oauth2/authenticate");
  });
});
