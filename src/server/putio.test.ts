import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, it } from "vitest";
import { listAll, PutioRateLimited, PutioUnauthorized, putioLayer, rootFolders } from "./putio";
import { file, makeFakePutio } from "./testing/fake-putio";

const T0 = Date.UTC(2026, 9, 29);
const library = Array.from({ length: 5 }, (_, i) => file(i + 1, 0, `f${i + 1}.mkv`, "VIDEO", 1));

const scan = (fake: ReturnType<typeof makeFakePutio>, advance: number) =>
  Effect.runPromiseExit(
    Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      const fiber = yield* Effect.forkChild(listAll.pipe(Effect.provide(putioLayer("tok", fake.fetch))));
      // Let the fake answer before moving the clock; its fetch is a real promise.
      yield* Effect.promise(() => new Promise((r) => setTimeout(r, 20)));
      yield* TestClock.adjust(advance);
      return yield* Fiber.join(fiber);
    }).pipe(Effect.provide(TestClock.layer())),
  );

describe("put.io scan", () => {
  it("reads every file flat: parent_id=-1, 2,000 per page, then the cursor", async () => {
    const fake = makeFakePutio({ files: library, pageSize: 2 });
    const exit = await scan(fake, 0);
    expect(Exit.isSuccess(exit) && exit.value.map((f) => f.id)).toEqual([1, 2, 3, 4, 5]);
    const [first, ...rest] = fake.log;
    expect(first?.url.pathname).toBe("/v2/files/list");
    expect(Object.fromEntries(first?.url.searchParams ?? [])).toEqual({ parent_id: "-1", per_page: "2000", hidden: "1" });
    expect(first?.method).toBe("GET");
    expect(rest.map((r) => [r.method, r.url.pathname, r.body.get("cursor")])).toEqual([
      ["POST", "/v2/files/list/continue", "c2"],
      ["POST", "/v2/files/list/continue", "c4"],
    ]);
  });
});

describe("put.io 429", () => {
  it("waits until x-ratelimit-reset when it is near, then goes on", async () => {
    const fake = makeFakePutio({ files: library, pageSize: 2, rateLimitContinue: { times: 1, resetAt: T0 / 1000 + 3 } });
    const exit = await scan(fake, 3_000);
    expect(Exit.isSuccess(exit) && exit.value.length).toBe(5);
    expect(fake.log.filter((r) => r.url.pathname === "/v2/files/list/continue")).toHaveLength(3);
  });

  it("does not sleep before the reset time", async () => {
    const fake = makeFakePutio({ files: library, pageSize: 2, rateLimitContinue: { times: 1, resetAt: T0 / 1000 + 3 } });
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(T0);
        const fiber = yield* Effect.forkChild(listAll.pipe(Effect.provide(putioLayer("tok", fake.fetch))));
        yield* Effect.promise(() => new Promise((r) => setTimeout(r, 20)));
        yield* TestClock.adjust(2_000);
        yield* Effect.promise(() => new Promise((r) => setTimeout(r, 20)));
        const done = fiber.pollUnsafe();
        yield* Fiber.interrupt(fiber);
        return done;
      }).pipe(Effect.provide(TestClock.layer())),
    );
    expect(exit).toBeUndefined();
  });

  it("fails with PutioRateLimited when the reset is far away, without waiting", async () => {
    const fake = makeFakePutio({ files: library, pageSize: 2, rateLimitContinue: { times: 1, resetAt: T0 / 1000 + 600 } });
    const exit = await scan(fake, 0);
    expect(exit).toEqual(Exit.fail(new PutioRateLimited({ retryAfterMs: 600_000 })));
    expect(fake.log.filter((r) => r.url.pathname === "/v2/files/list/continue")).toHaveLength(1);
  });

  it("maps 401 to PutioUnauthorized", async () => {
    const exit = await scan(makeFakePutio({ files: library, pageSize: 2, unauthorized: true }), 0);
    expect(exit).toEqual(Exit.fail(new PutioUnauthorized({ status: 401 })));
  });
});

describe("folder picker", () => {
  it("lists regular top-level folders and leaves out put.io's shared-items folder", async () => {
    const fake = makeFakePutio({
      files: [file(-2, 0, "Items shared with you", "FOLDER"), file(1, 0, "Movies", "FOLDER"), file(2, 0, "Alien.mkv", "VIDEO")],
      pageSize: 10,
    });
    const folders = await Effect.runPromise(rootFolders.pipe(Effect.provide(putioLayer("tok", fake.fetch))));
    expect(folders).toEqual([{ id: 1, name: "Movies" }]);
  });
});
