import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import { WORKER_ROUTES } from "../shared/contract";
import Puterminator from "./agent";
import { readConfig } from "./config";
import { upstreamFetch } from "./dev";
// oxlint-disable-next-line anti-slop-effect/no-service-constructor-imports -- composition root: the Worker wires route dependencies here
import { makeHandler, type RouteDeps } from "./routes";
import type { RuntimeContext } from "alchemy/RuntimeContext";

const PUBLIC_ORIGIN = "https://puterminator.com";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);
const LIVE_SCRIPT_NAME = "puterminator";
const BUNDLED_WORKERD_MAX_COMPATIBILITY_DATE = "2026-10-19";
const FEEDBACK_FROM = "puterminator@uinaf.dev";
const FEEDBACK_TO = "dev@uinaf.dev";
const oneLine = (text: string) => text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
const FeedbackEmail = Cloudflare.Email.SendEmail("FeedbackEmail", { allowedSenderAddresses: [FEEDBACK_FROM] });

export default Cloudflare.Worker(
  "Worker",
  {
    main: import.meta.url,
    name: LIVE_SCRIPT_NAME,
    workersDev: false,
    compatibility: { flags: ["nodejs_compat"], date: BUNDLED_WORKERD_MAX_COMPATIBILITY_DATE },
    observability: { enabled: true },
    assets: {
      directory: "./dist",
      notFoundHandling: "single-page-application",
      runWorkerFirst: WORKER_ROUTES,
    },
  },
  Effect.gen(function* () {
    const config = yield* readConfig;
    const agents = yield* Puterminator;
    const email = yield* Cloudflare.Email.Send(FeedbackEmail);

    const deps: RouteDeps<RuntimeContext> = {
      config,
      agentFor: (uid) => agents.getByName(uid),
      sendFeedback: (feedback, from) =>
        email.send({
          from: { name: "puterminator", email: FEEDBACK_FROM },
          to: FEEDBACK_TO,
          subject: `[${feedback.kind}] ${oneLine(from.username)}: ${oneLine(feedback.text).slice(0, 60)}`,
          text: `${feedback.text}\n\n-- \nput.io user ${from.username} (${from.uid})`,
        }),
    };

    const handle = makeHandler(config.devUpstream ? { ...deps, putioFetch: upstreamFetch(config.devUpstream) } : deps);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const host = request.headers.host ?? "";
        const local = URL.canParse(`http://${host}`) && LOCAL_HOSTS.has(new URL(`http://${host}`).hostname);

        return yield* handle(request, local ? `http://${host}` : PUBLIC_ORIGIN);
      }),
    };
  }).pipe(Effect.provide(Cloudflare.Email.SendBinding)),
);
