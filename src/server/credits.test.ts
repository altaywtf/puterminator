import { describe, expect, it } from "vitest";
import { CREDIT_TOKENS } from "../shared/contract";
import { blockedBy, consoleFloor } from "./credits";
import { makeStore } from "./store";
import { memorySql } from "./testing/sqlite";

const NOV_1_NOON = Date.UTC(2026, 10, 1, 12);
const NOV_30_NOON = Date.UTC(2026, 10, 30, 12);
const base = { now: NOV_1_NOON, used: 0, cap: 300, pool: 0, budget: 19_000 };

describe("blockedBy", () => {
  it("lets the shared budget out at 10% on day one plus an even share of the rest per day, and says which day it reopens", () => {
    expect(blockedBy({ ...base, pool: 2_000 })).toBeNull();
    expect(blockedBy({ ...base, pool: 3_800 })).toEqual({ reason: "paused", until: "2026-11-05" });
  });

  it("says out until the 1st when the reopening day would fall next month or the budget is spent", () => {
    expect(blockedBy({ ...base, now: NOV_30_NOON, pool: 18_900 })).toEqual({ reason: "out", until: "2026-12-01" });
    expect(blockedBy({ ...base, now: NOV_30_NOON, pool: 19_000 })).toEqual({ reason: "out", until: "2026-12-01" });
  });

  it("stops a user at their own cap, and never stops an uncapped one while the shared budget lasts", () => {
    expect(blockedBy({ ...base, used: 300 })).toEqual({ reason: "out", until: "2026-12-01" });
    expect(blockedBy({ ...base, used: 10_000, cap: Number.MAX_SAFE_INTEGER })).toBeNull();
  });
});

describe("pool totals", () => {
  it("keeps each user's largest reported total, so a retried or stale report changes nothing, and forgets past months", () => {
    const pool = makeStore(memorySql());

    expect([pool.poolReport("2026-11", "a", 50), pool.poolReport("2026-11", "a", 50), pool.poolReport("2026-11", "a", 20), pool.poolReport("2026-11", "b", 5), pool.poolReport("2026-12", "a", 1), pool.poolReport("2026-11", "b", 5)]).toEqual([50, 50, 50, 55, 1, 5]);
  });
});

describe("consoleFloor", () => {
  it("counts the console's spend only for its own month, so a stale deploy never inflates the next one", () => {
    expect([consoleFloor("2026-11:850", "2026-11"), consoleFloor("2026-10:850", "2026-11"), consoleFloor("", "2026-11")]).toEqual([850 * CREDIT_TOKENS, 0, 0]);
  });
});
