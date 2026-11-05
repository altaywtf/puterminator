import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { describe, expect, it } from "vitest";
import type { Feedback } from "../shared/contract";
import { readConfig } from "./config";
import { makeHandler, type UserAgent } from "./routes";
import { makeStore } from "./store";
import { memorySql } from "./testing/sqlite";

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

  it("reads defaults for MODEL and the credit limits", async () => {
    const exit = await configFrom(valid);
    expect(Exit.isSuccess(exit) && [exit.value.model, exit.value.monthlyCredits, exit.value.poolBudgetCredits, exit.value.consoleSpend]).toEqual(["claude-sonnet-5-5", 300, 19_000, ""]);
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
  const gravatar = "https://www.gravatar.com/avatar/abc";

  const putioWith = (avatar: string): typeof fetch => async (input, init) => {
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

  const callback = async (code: string, avatar = gravatar, sendFeedback: (f: Feedback, from: { uid: string; username: string }) => Effect.Effect<void, unknown> = () => Effect.void) => {
    const config = await configFrom(valid);

    if (!Exit.isSuccess(config)) throw new Error("config failed");
    const calls: Array<[string, string, string, string | null]> = [];
    let gen = 0;

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
      takeFeedbackSlot: () => Effect.sync(() => (store.takeFeedbackSlot("2026-11-05", 2) ? "altay" : null)),
      returnFeedbackSlot: () => Effect.sync(() => store.returnFeedbackSlot("2026-11-05")),
      fetch: () => Effect.die("unused"),
    });

    const store = makeStore(memorySql());
    const handle = makeHandler({ config: config.value, agentFor: agent, putioFetch: putioWith(avatar), sendFeedback });
    const request = new Request(`${PUBLIC_URL}/auth/callback?code=${code}&state=st`, { headers: { cookie: "__Host-pt_oauth_state=st" } });
    const response = HttpServerResponse.toWeb(await Effect.runPromise(handle(HttpServerRequest.fromWeb(request), PUBLIC_URL)));
    const session = response.headers.getSetCookie().find((c) => c.startsWith("__Host-pt_session=")) ?? "";
    const cookie = session.split(";")[0] ?? "";

    const get = async (path: string, method = "GET") =>
      HttpServerResponse.toWeb(await Effect.runPromise(handle(HttpServerRequest.fromWeb(new Request(`${PUBLIC_URL}${path}`, { method, headers: { cookie } })), PUBLIC_URL)));

    const post = async (path: string, body: Readonly<Record<string, string>>, origin: string | null = PUBLIC_URL) => {
      const headers = new Headers({ cookie, "content-type": "application/json" });

      const raw = JSON.stringify(body);
      headers.set("content-length", String(new TextEncoder().encode(raw).length));

      if (origin) headers.set("origin", origin);
      const request = new Request(`${PUBLIC_URL}${path}`, { method: "POST", body: raw, headers });

      return HttpServerResponse.toWeb(await Effect.runPromise(handle(HttpServerRequest.fromWeb(request), PUBLIC_URL)));
    };

    return { response, calls, session, get, post, me: await (await get("/api/me")).json() };
  };

  it("exchanges the code, stores the token in the user's object and sets an HttpOnly, Secure session cookie", async () => {
    const { response, calls, session, me } = await callback("good-code");
    expect([response.status, response.headers.get("location")]).toEqual([302, "/"]);
    expect(calls).toEqual([["putio-77", "tok-1", "altay", gravatar]]);
    expect(session).toMatch(/HttpOnly/);
    expect(session).toMatch(/Secure/);
    expect(session).toMatch(/Path=\//);
    expect(me).toEqual({ configured: true, signedIn: true });
  });

  it("ends the session on logout, even for a copy of the cookie kept elsewhere", async () => {
    const { get } = await callback("good-code");
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

  it("emails feedback with the sender's put.io username, refuses other origins and empty text, and stops at the daily limit", async () => {
    const sent: Array<[Feedback, string]> = [];
    const { post } = await callback("good-code", gravatar, (f, from) => Effect.sync(() => void sent.push([f, from.username])));
    expect((await post("/api/feedback", { kind: "bug", text: "  undo broke  " })).status).toBe(200);
    expect((await post("/api/feedback", { kind: "bug", text: "x" }, "https://evil.test")).status).toBe(403);
    expect((await post("/api/feedback", { kind: "bug", text: "x" }, null)).status).toBe(403);
    expect((await post("/api/feedback", { kind: "idea", text: "   " })).status).toBe(400);
    expect((await post("/api/feedback", { kind: "rant", text: "x" })).status).toBe(400);
    expect((await post("/api/feedback", { kind: "idea", text: "dark mode" })).status).toBe(200);
    expect((await post("/api/feedback", { kind: "idea", text: "one more" })).status).toBe(429);
    expect(sent).toEqual([
      [{ kind: "bug", text: "undo broke" }, "altay"],
      [{ kind: "idea", text: "dark mode" }, "altay"],
    ]);
  });

  it("answers 502 when the feedback email fails without using up the daily limit, and 401 without a session", async () => {
    let attempts = 0;
    const { post } = await callback("good-code", gravatar, () => (++attempts === 1 ? Effect.fail("send_email refused") : Effect.void));
    expect((await post("/api/feedback", { kind: "bug", text: "x" })).status).toBe(502);
    expect((await post("/api/feedback", { kind: "bug", text: "x" })).status).toBe(200);
    expect((await post("/api/feedback", { kind: "bug", text: "x" })).status).toBe(200);
    expect((await post("/api/feedback", { kind: "bug", text: "x".repeat(20_000) })).status).toBe(413);
    expect((await call(valid, "/api/feedback", { method: "POST", body: "{}" })).status).toBe(401);
  });

  it("keeps only an https avatar, since the browser loads it directly", async () => {
    for (const bad of ["http://www.gravatar.com/avatar/abc", "javascript:alert(1)", ""]) {
      const { calls } = await callback("good-code", bad);
      expect(calls[0]?.[3], bad).toBeNull();
    }
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
