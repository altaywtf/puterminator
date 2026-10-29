import * as Schema from "effect/Schema";
import type { ContentBlock } from "../shared/contract";

/**
 * The history has no thinking durations, so the browser times them from the partial frames it
 * sees. Live blocks are keyed by index; when the message lands, the times move to its item keys
 * (`m<history index>.<block index>`), the keys toTurns gives them.
 */
export const ThinkingClock = Schema.Struct({
  started: Schema.Record(Schema.String, Schema.Finite),
  ended: Schema.Record(Schema.String, Schema.Finite),
  seconds: Schema.Record(Schema.String, Schema.Finite),
});
export type ThinkingClock = typeof ThinkingClock.Type;

export const emptyClock: ThinkingClock = { started: {}, ended: {}, seconds: {} };

const toSeconds = (ms: number) => Math.max(1, Math.round(ms / 1000));

export function onPartial(clock: ThinkingClock, content: readonly ContentBlock[], at: number): ThinkingClock {
  const started = { ...clock.started };
  const ended = { ...clock.ended };
  content.forEach((b, i) => {
    if (b.type !== "thinking") return;
    started[i] ??= at;
    if (i < content.length - 1) ended[i] ??= at;
  });
  return { ...clock, started, ended };
}

/** An assistant message landed at `historyIndex`: freeze the live timings under its keys. */
export function onMessage(clock: ThinkingClock, historyIndex: number, at: number): ThinkingClock {
  const seconds = { ...clock.seconds };
  for (const [i, start] of Object.entries(clock.started)) {
    seconds[`m${historyIndex}.${i}`] = toSeconds((clock.ended[i] ?? at) - start);
  }
  return { started: {}, ended: {}, seconds };
}

/** Seconds for a finished thinking item, or null when this browser never saw it stream. */
export function thoughtSeconds(clock: ThinkingClock, key: string): number | null {
  if (key.startsWith("live.")) {
    const i = key.slice(5);
    const start = clock.started[i];
    const end = clock.ended[i];
    return start !== undefined && end !== undefined ? toSeconds(end - start) : null;
  }
  return clock.seconds[key] ?? null;
}
