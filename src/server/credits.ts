import { type Blocked, CREDIT_TOKENS } from "../shared/contract";

const PACE_FLOOR = 0.1;

const monthBounds = (now: number) => {
  const d = new Date(now);

  return { start: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1), end: Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) };
};

const nextMidnight = (ms: number) => {
  const d = new Date(ms);

  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
};

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export const outOfBudget = (now: number): Blocked => ({ reason: "out", until: day(monthBounds(now).end) });

const paceLine = (budget: number, now: number) => {
  const { start, end } = monthBounds(now);

  return budget * (PACE_FLOOR + (1 - PACE_FLOOR) * ((now - start) / (end - start)));
};

export interface Usage {
  readonly now: number;
  readonly used: number;
  readonly cap: number;
  readonly pool: number;
  readonly budget: number;
}

export const blockedBy = ({ now, used, cap, pool, budget }: Usage): Blocked | null => {
  const { start, end } = monthBounds(now);
  const out = outOfBudget(now);

  if (used >= cap || pool >= budget) return out;

  if (pool < paceLine(budget, now)) return null;

  const reopens = nextMidnight(start + ((pool / budget - PACE_FLOOR) / (1 - PACE_FLOOR)) * (end - start));

  return reopens >= end ? out : { reason: "paused", until: day(reopens) };
};

export const consoleFloor = (consoleSpend: string, m: string) => {
  const match = consoleSpend.match(/^(\d{4}-\d{2}):(\d+)$/);

  return match?.[1] === m ? Number(match[2]) * CREDIT_TOKENS : 0;
};
