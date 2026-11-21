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

const chatIdle = (value: Parameters<typeof matchesState>[1]) => matchesState({ chat: "idle" }, value);

/**
 * What the Durable Object is doing. `chat` holds the turn: it is `replying` once Claude is called, and a stopped turn
 * stays `stopping` until its cleanup has run. `library` holds the background rescan and the one plan run at a time.
 * A turn may start during a rescan or a run; a rescan or a run only starts while no turn is running.
 */
export const activityMachine = setupEffect({
  schemas: {
    context: Schema.Struct({ plan: Schema.NullOr(Schema.String) }),
    events: {
      SEND: TurnInput,
      REPLYING: Schema.Struct({}),
      STOP: Schema.Struct({}),
      TURN_SETTLED: Schema.Struct({}),
      REFRESH: Schema.Struct({}),
      RUN: Schema.Struct({ plan: Schema.String }),
      RUN_ENDED: Schema.Struct({ plan: Schema.String }),
    },
  },
  actors: { turn, refresh },
}).createMachine({
  id: "activity",
  type: "parallel",
  context: { plan: null },
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
            preparing: { on: { REPLYING: { target: "replying" } } },
            replying: {},
          },
          on: {
            STOP: { target: "stopping" },
            TURN_SETTLED: { target: "idle" },
          },
        },
        stopping: { on: { TURN_SETTLED: { target: "idle" } } },
      },
    },
    library: {
      initial: "idle",
      states: {
        idle: {
          on: {
            REFRESH: ({ value }) => (chatIdle(value) ? { target: "refreshing" } : undefined),
            RUN: ({ context, event, value }) => (chatIdle(value) ? { target: "planRun", context: { ...context, plan: event.plan } } : undefined),
          },
        },
        refreshing: {
          invoke: { src: "refresh", onDone: { target: "idle" }, onError: { target: "idle" } },
          on: {
            RUN: ({ context, event, value }) => (chatIdle(value) ? { target: "planRun", context: { ...context, plan: event.plan } } : undefined),
          },
        },
        planRun: {
          on: {
            RUN_ENDED: ({ context, event }) => (event.plan === context.plan ? { target: "idle", context: { ...context, plan: null } } : undefined),
          },
        },
      },
    },
  },
});

export type Activity = SnapshotFrom<typeof activityMachine>;

export const isBusy = (activity: Activity) => activity.matches({ chat: { turn: "replying" } }) || activity.matches({ chat: "stopping" });

export const isIdle = (activity: Activity) => activity.matches({ chat: "idle" }) && !activity.matches({ library: "planRun" });

export const runningPlan = (activity: Activity) => (activity.matches({ library: "planRun" }) ? activity.context.plan : null);
