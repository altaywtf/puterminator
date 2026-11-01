import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, it } from "vitest";
import { SESSION_MAX_AGE_SEC, signSession, verifySession } from "./session";

const secret = Redacted.make("s".repeat(32));
const T0 = Date.UTC(2026, 9, 29);

const run = <A>(effect: Effect.Effect<A>) =>
  Effect.runPromise(Effect.gen(function* () {
    yield* TestClock.setTime(T0);

    return yield* effect;
  }).pipe(Effect.provide(TestClock.layer())));

const b64url = (s: string) => Buffer.from(s).toString("base64url");

describe("session cookie", () => {
  it("verifies what it signed", async () => {
    const session = await run(Effect.flatMap(signSession(secret, "putio-42", 3), (raw) => verifySession(secret, raw)));
    expect(session).toEqual(Option.some({ uid: "putio-42", exp: T0 / 1000 + SESSION_MAX_AGE_SEC, gen: 3 }));
  });

  it("verifies a v1 cookie: base64url JSON, HMAC-SHA256 over it", async () => {
    const payload = b64url(JSON.stringify({ uid: "putio-7", exp: T0 / 1000 + 60 }));
    const { createHmac } = await import("node:crypto");
    const sig = createHmac("sha256", Redacted.value(secret)).update(payload).digest("base64url");
    expect(await run(verifySession(secret, `${payload}.${sig}`))).toEqual(Option.some({ uid: "putio-7", exp: T0 / 1000 + 60 }));
  });

  it("rejects tampering, a foreign secret, expiry and junk", async () => {
    const raw = await run(signSession(secret, "putio-42", 0));
    const [payload, sig] = raw.split(".");

    if (payload === undefined || sig === undefined) throw new Error("signSession made no signature");
    const forged = `${b64url(JSON.stringify({ uid: "putio-1", exp: T0 / 1000 + SESSION_MAX_AGE_SEC }))}.${sig}`;
    const flipped = `${payload}.${sig.startsWith("A") ? "B" : "A"}${sig.slice(1)}`;

    for (const bad of [forged, flipped, `${payload}.`, payload, "", "a.b.c", undefined]) {
      expect(await run(verifySession(secret, bad)), String(bad)).toEqual(Option.none());
    }

    expect(await run(verifySession(Redacted.make("t".repeat(32)), raw))).toEqual(Option.none());

    const later = Effect.gen(function* () {
      yield* TestClock.adjust(`${SESSION_MAX_AGE_SEC + 1} seconds`);

      return yield* verifySession(secret, raw);
    });

    expect(await run(later)).toEqual(Option.none());
  });
});
