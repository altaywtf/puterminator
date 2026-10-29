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
      const env: Record<string, string> = { ...valid };
      delete env[key];
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
    expect(login.headers.getSetCookie().find((c) => c.startsWith("pt_oauth_state="))).toContain(`pt_oauth_state=${state}`);
    expect((await call(valid, "/api/folders")).status).toBe(401);
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
      expect((await call(env, "/api/folders", undefined, publicUrl)).status).toBe(503);
      expect((await call(env, "/agent", { headers: { upgrade: "websocket" } }, publicUrl)).status).toBe(503);
    });
  }
});
