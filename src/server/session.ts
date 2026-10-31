import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as Cookies from "effect/http/Cookies";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

/** `__Host-`: only this exact origin over https can set them, so a sibling subdomain can't plant a session. */
export const SESSION_COOKIE = "__Host-pt_session";
export const STATE_COOKIE = "__Host-pt_oauth_state";
export const SESSION_MAX_AGE_SEC = 60 * 60 * 24 * 30;
export const STATE_MAX_AGE_SEC = 600;

export const cookieOptions = (maxAgeSec: number): NonNullable<Cookies.Cookie["options"]> => ({
  path: "/",
  httpOnly: true,
  secure: true,
  sameSite: "lax",
  maxAge: Duration.seconds(maxAgeSec),
});

/** `gen`: the user's session generation when signed; signing out bumps it, which ends every earlier session. */
const Session = Schema.Struct({ uid: Schema.String, exp: Schema.Finite, gen: Schema.optionalKey(Schema.Finite) });
export type Session = typeof Session.Type;
const decodeSession = Schema.decodeUnknownOption(Schema.fromJsonString(Session));

const enc = new TextEncoder();
const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

const hmacKey = (secret: Redacted.Redacted<string>) =>
  Effect.promise(() =>
    crypto.subtle.importKey("raw", enc.encode(Redacted.value(secret)), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]),
  );

/** `<base64url JSON>.<base64url HMAC-SHA256>`, the v1 format, so v1 sessions stay valid. */
export const signSession = (secret: Redacted.Redacted<string>, uid: string, gen: number) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const payload = b64url(enc.encode(JSON.stringify({ uid, exp: Math.floor(now / 1000) + SESSION_MAX_AGE_SEC, gen })));
    const key = yield* hmacKey(secret);
    const sig = yield* Effect.promise(() => crypto.subtle.sign("HMAC", key, enc.encode(payload)));
    return `${payload}.${b64url(new Uint8Array(sig))}`;
  });

/** None for a missing, tampered, malformed or expired cookie. */
export const verifySession = (secret: Redacted.Redacted<string>, raw: string | undefined) =>
  Effect.gen(function* () {
    const [payload, sig, ...rest] = (raw ?? "").split(".");
    if (!payload || !sig || rest.length > 0) return Option.none<Session>();
    const key = yield* hmacKey(secret);
    const valid = yield* Effect.tryPromise(() => crypto.subtle.verify("HMAC", key, fromB64url(sig), enc.encode(payload))).pipe(
      Effect.orElseSucceed(() => false),
    );
    if (!valid) return Option.none<Session>();
    const json = yield* Effect.try(() => new TextDecoder().decode(fromB64url(payload))).pipe(Effect.option);
    const session = Option.flatMap(json, (j) => decodeSession(j));
    const now = yield* Clock.currentTimeMillis;
    return Option.filter(session, (s) => s.exp >= now / 1000);
  });
