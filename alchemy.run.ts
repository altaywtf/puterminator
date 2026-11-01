import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import { inMemoryState } from "alchemy/State";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import Worker from "./src/server/worker";

const adoptLiveWorker = Effect.gen(function* () {
  return (yield* Alchemy.Stage) === "prod";
});

export default Alchemy.Stack(
  "Puterminator",
  { providers: Cloudflare.providers(), state: inMemoryState() },
  Effect.gen(function* () {
    const devUpstream = yield* Config.option(Config.String("DEV_FAKE_UPSTREAM")).pipe(Effect.orDie);

    if ((yield* Alchemy.Stage) === "prod" && Option.isSome(devUpstream)) {
      return yield* Effect.die("DEV_FAKE_UPSTREAM is set: it would send prod's put.io and Anthropic calls to a local fake");
    }

    const worker = yield* Worker.pipe(Alchemy.AdoptPolicy.adopt(adoptLiveWorker));

    return { url: worker.url };
  }),
);
