import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import { WORKER_ROUTES } from "../shared/contract";
import Puterminator from "./agent";
import { readConfig } from "./config";
import { upstreamFetch } from "./dev";
import { makeHandler } from "./routes";

export const DOMAIN = "puterminator.uinaf.dev";

export default Cloudflare.Worker(
  "Worker",
  {
    main: import.meta.url,
    // The live script's name; adoption matches it.
    name: "puterminator",
    domain: { name: DOMAIN, zoneName: "uinaf.dev" },
    workersDev: false,
    // The workerd bundled with @alchemy.run/cloudflare 2.0.0-beta.84 accepts dates up to 2026-10-19.
    compatibility: { flags: ["nodejs_compat"], date: "2026-10-19" },
    observability: { enabled: true },
    assets: {
      directory: "./dist",
      notFoundHandling: "single-page-application",
      runWorkerFirst: WORKER_ROUTES,
    },
  },
  Effect.gen(function* () {
    // Every Config read here becomes a secret binding on deploy. An upload replaces the whole
    // binding set, so a live secret not read here is deleted.
    const config = yield* readConfig;
    const publicUrl = yield* Cloudflare.Worker.URL;
    const agents = yield* Puterminator;
    const handle = makeHandler({
      config,
      agentFor: (uid) => agents.getByName(uid),
      ...(config.devUpstream ? { putioFetch: upstreamFetch(config.devUpstream) } : {}),
    });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        return yield* handle(request, yield* publicUrl);
      }),
    };
  }),
);
