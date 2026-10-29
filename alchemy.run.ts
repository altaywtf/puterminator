import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import Worker from "./src/server/worker";

// Only the prod stage may take over the wrangler-deployed `puterminator` script; any other stage
// that reaches the account fails with OwnedBySomeoneElse instead of replacing production.
const adoptLiveWorker = Effect.gen(function* () {
  return (yield* Alchemy.Stage) === "prod";
});

// Local state under .alchemy/ (gitignored; it holds secret values in plaintext).
// Cloudflare.state() would deploy a state-store Worker on the account, even under `alchemy dev`.
export default Alchemy.Stack(
  "Puterminator",
  { providers: Cloudflare.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const worker = yield* Worker.pipe(Alchemy.AdoptPolicy.adopt(adoptLiveWorker));
    return { url: worker.url };
  }),
);
