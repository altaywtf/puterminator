import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import { WORKER_ROUTES } from "../shared/contract";
import Puterminator from "./agent";
import { readConfig } from "./config";
import { upstreamFetch } from "./dev";
// oxlint-disable-next-line anti-slop-effect/no-service-constructor-imports -- composition root: the Worker wires route dependencies here
import { makeHandler, type RouteDeps } from "./routes";

const PUBLIC_ORIGIN = "https://puterminator.com";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);
const LIVE_SCRIPT_NAME = "puterminator";
const BUNDLED_WORKERD_MAX_COMPATIBILITY_DATE = "2026-10-19";

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
    const publicUrl = yield* Cloudflare.Worker.URL;
    const agents = yield* Puterminator;

    const deps: RouteDeps = { config, agentFor: (uid) => agents.getByName(uid) };
    const handle = makeHandler(config.devUpstream ? { ...deps, putioFetch: upstreamFetch(config.devUpstream) } : deps);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;

        const url = yield* publicUrl;

        return yield* handle(request, URL.canParse(url) && LOCAL_HOSTS.has(new URL(url).hostname) ? url : PUBLIC_ORIGIN);
      }),
    };
  }),
);
