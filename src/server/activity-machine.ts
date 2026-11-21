import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { createEffectLogic, setupEffect } from "@xstate/effect";
import { assertEvent, matchesState, type SnapshotFrom } from "xstate";
import { Folder } from "../shared/contract";

const TurnInput = Schema.Struct({ text: Schema.String, folder: Folder });

/** The work behind the agent's activities: a chat turn and a background rescan. */
export class AgentWork extends Context.Service<
  AgentWork,
  {
    readonly turn: (input: typeof TurnInput.Type) => Effect.Effect<void>;
    readonly refresh: Effect.Effect<void>;
  }
>()("puterminator/AgentWork") {}

const turn = createEffectLogic({
  schemas: { input: TurnInput },
  effect: ({ input }) => AgentWork.use((work) => work.turn(input)),
});

const refresh = createEffectLogic({ effect: () => AgentWork.use((work) => work.refresh) });

/**
 * What the Durable Object is doing. `chat` holds the turn: it is `replying` once Claude is called, and a stopped turn
 * stays `stopping` until its cleanup has run. `rescan` holds the background rescan and `plans` the one plan run at a
 * time. A turn may start during a rescan or a run, and a run during a rescan; a rescan or a run only starts while no
 * turn is running, and a rescan only while nothing else is.
 */
export const activityMachine = setupEffect({
  schemas: {
    context: Schema.Struct({ run: Schema.NullOr(Schema.String) }),
    events: {
      SEND: TurnInput,
      REPLYING: Schema.Struct({}),
      STOP: Schema.Struct({}),
      TURN_SETTLED: Schema.Struct({}),
      REFRESH: Schema.Struct({}),
      RUN: Schema.Struct({ run: Schema.String }),
      RUN_ENDED: Schema.Struct({ run: Schema.String }),
    },
  },
  actors: { turn, refresh },
}).createMachine({
  id: "activity",
  type: "parallel",
  context: { run: null },
  states: {
    chat: {
      initial: "idle",
      states: {
        idle: { on: { SEND: { target: "turn" } } },
        turn: {
          invoke: {
            src: "turn",
            input: ({ event }) => {
              assertEvent(event, "SEND");

              return { text: event.text, folder: event.folder };
            },
            onDone: { target: "idle" },
            onError: { target: "idle" },
          },
          initial: "preparing",
          states: {
            preparing: { on: { REPLYING: { target: "replying" }, STOP: { target: "#activity.chat.stopping.quiet" } } },
            replying: { on: { STOP: { target: "#activity.chat.stopping.replying" } } },
          },
          on: { TURN_SETTLED: { target: "idle" } },
        },
        stopping: {
          initial: "quiet",
          states: { quiet: {}, replying: {} },
          on: { TURN_SETTLED: { target: "idle" } },
        },
      },
    },
    rescan: {
      initial: "idle",
      states: {
        idle: {
          on: {
            REFRESH: ({ value }) => (matchesState({ chat: "idle", plans: "idle" }, value) ? { target: "refreshing" } : undefined),
          },
        },
        refreshing: {
          invoke: { src: "refresh", onDone: { target: "idle" }, onError: { target: "idle" } },
        },
      },
    },
    plans: {
      initial: "idle",
      states: {
        idle: {
          on: {
            RUN: ({ context, event, value }) => (matchesState({ chat: "idle" }, value) ? { target: "running", context: { ...context, run: event.run } } : undefined),
          },
        },
        running: {
          on: {
            RUN_ENDED: ({ context, event }) => (event.run === context.run ? { target: "idle", context: { ...context, run: null } } : undefined),
          },
        },
      },
    },
  },
});

export type Activity = SnapshotFrom<typeof activityMachine>;

export const isBusy = (activity: Activity) => activity.matches({ chat: { turn: "replying" } }) || activity.matches({ chat: { stopping: "replying" } });

export const isIdle = (activity: Activity) => activity.matches({ chat: "idle" }) && activity.matches({ plans: "idle" });

export const isRescanning = (activity: Activity) => activity.matches({ rescan: "refreshing" });

export const runOf = (activity: Activity) => (activity.matches({ plans: "running" }) ? activity.context.run : null);
