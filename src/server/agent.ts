import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ServerFrame, type ServerEvent } from "../shared/contract";
import { readConfig } from "./config";
import { makeAgent } from "./conversation";
import { upstreamFetch } from "./dev";
import { anthropicLayer } from "./runner";
import { makeStore, type Sql } from "./store";

const encodeEvent = Schema.encodeSync(ServerFrame);

// The live Worker binds `Puterminator` -> class `Puterminator`. Adoption matches the namespace by
// that name and keeps its SQLite data; renaming the class in the adopting deploy loses it.
export default class Puterminator extends Cloudflare.DurableObject<Puterminator>()(
  "Puterminator",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    return Effect.gen(function* () {
      const config = yield* readConfig.pipe(Effect.orDie);
      const devFetch = config.devUpstream ? upstreamFetch(config.devUpstream) : undefined;
      const raw = state.raw;
      const sql: Sql = {
        exec: (query, ...bindings) => raw.storage.sql.exec(query, ...bindings).toArray(),
        transaction: (body) => raw.storage.transactionSync(body),
      };
      const agent = yield* makeAgent({
        store: makeStore(sql),
        model: config.model,
        monthlyTokenCap: config.monthlyTokenCap,
        anthropic: anthropicLayer({ apiKey: config.anthropicApiKey, ...(devFetch ? { fetch: devFetch } : {}) }),
        ...(devFetch ? { putioFetch: devFetch } : {}),
        broadcast: (event: ServerEvent) => {
          const frame = encodeEvent(event);
          for (const ws of raw.getWebSockets()) {
            try {
              ws.send(frame);
            } catch {
              // A socket closing mid-broadcast is not an error for the others.
            }
          }
        },
        // A stopped turn ends interrupted; an exit, not a rejection.
        background: (effect) => raw.waitUntil(Effect.runPromiseExit(effect)),
      });

      return {
        fetch: Effect.gen(function* () {
          const [response, socket] = yield* Cloudflare.upgrade();
          for (const event of agent.greeting()) yield* socket.send(encodeEvent(event));
          return response;
        }).pipe(Effect.orDie),
        webSocketMessage: Effect.fn(function* (_socket: Cloudflare.WebSocket, message: string | ArrayBuffer) {
          if (typeof message !== "string") return;
          yield* agent.receive(message);
        }),
        webSocketClose: Effect.fn(function* (socket: Cloudflare.WebSocket, code: number, reason: string) {
          yield* socket.close(code, reason);
        }),
        setAuth: (token: string, username: string) => agent.setAuth(token, username),
        signOut: () => agent.signOut,
        rootFolders: () => agent.rootFolders.pipe(Effect.orDie),
      };
    });
  }),
) {}
