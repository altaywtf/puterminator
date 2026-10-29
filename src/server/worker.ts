import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Redacted from "effect/Redacted";
import { type Me, WORKER_ROUTES } from "../shared/contract";
import Puterminator from "./agent";

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
    const putioClientId = yield* Config.String("PUTIO_CLIENT_ID");
    const putioClientSecret = yield* Config.Redacted("PUTIO_CLIENT_SECRET");
    const sessionSecret = yield* Config.Redacted("SESSION_SECRET");
    yield* Config.Redacted("ANTHROPIC_API_KEY");
    yield* Config.String("MODEL").pipe(Config.withDefault("claude-sonnet-5-5"));
    yield* Config.Int("MONTHLY_TOKEN_CAP").pipe(Config.withDefault(1_000_000));
    const publicUrl = yield* Cloudflare.Worker.URL;
    yield* Puterminator;

    // Stub: the backend stage replaces this with OAuth, sessions, /api/folders and /agent.
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const path = new URL(request.url, yield* publicUrl).pathname;
        if (path === "/api/me") {
          const me: Me = {
            configured:
              putioClientId.trim().length > 0 &&
              Redacted.value(putioClientSecret).trim().length > 0 &&
              Redacted.value(sessionSecret).length >= 32,
            signedIn: false,
          };
          return yield* HttpServerResponse.json(me);
        }
        return HttpServerResponse.text("Not implemented yet.", { status: 501 });
      }),
    };
  }),
);
