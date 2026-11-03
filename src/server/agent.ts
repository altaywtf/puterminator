import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { ServerFrame, type ServerEvent } from "../shared/contract";
import { readConfig } from "./config";
// oxlint-disable-next-line anti-slop-effect/no-service-constructor-imports -- composition root: the Durable Object wires the agent's dependencies here
import { type AgentDeps, makeAgent } from "./conversation";
import { upstreamFetch } from "./dev";
import { consoleFloor } from "./credits";
import { anthropicLayer } from "./runner";
// oxlint-disable-next-line anti-slop-effect/no-service-constructor-imports -- composition root: the Durable Object owns the SQLite handle it passes in
import { makeStore, type Sql } from "./store";

const encodeEvent = Schema.encodeSync(ServerFrame);

const POOL_NAME = "pool";

type PoolLedger = { readonly poolReport: (m: string, user: string, tokens: number) => Effect.Effect<number> };

export default class Puterminator extends Cloudflare.DurableObject<Puterminator>()(
  "Puterminator",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    // SAFETY: the scope is this class's own namespace, whose stubs expose the poolReport method returned below.
    const agents = (yield* Cloudflare.DurableObjectScope) as Cloudflare.DurableObject<PoolLedger>;

    return Effect.gen(function* () {
      const config = yield* readConfig.pipe(Effect.orDie);
      const dev = config.devUpstream ? { fetch: upstreamFetch(config.devUpstream), base: config.devUpstream } : null;
      const raw = state.raw;

      const sql: Sql = {
        exec: (query, ...bindings) => raw.storage.sql.exec(query, ...bindings).toArray(),
        transaction: (body) => raw.storage.transactionSync(body),
      };

      const store = makeStore(sql);

      const deps: AgentDeps = {
        store,
        model: config.model,
        monthlyCredits: config.monthlyCredits,
        poolBudgetCredits: config.poolBudgetCredits,
        pool: (m, tokens) => agents.getByName(POOL_NAME).poolReport(m, raw.id.toString(), tokens),
        unlimitedUsers: config.unlimitedUsers,
        anthropic: anthropicLayer({ apiKey: config.anthropicApiKey, maxRetries: 0, fetch: dev?.fetch }),
        broadcast: (event: ServerEvent) => {
          const frame = encodeEvent(event);

          for (const ws of raw.getWebSockets()) {
            try {
              ws.send(frame);
            } catch {}
          }
        },
        disconnect: () => {
          for (const ws of raw.getWebSockets()) {
            try {
              ws.close(4001, "signed out");
            } catch {}
          }
        },
        background: (effect) => raw.waitUntil(Effect.runPromiseExit(effect)),
      };

      const agent = yield* makeAgent(dev ? { ...deps, putioFetch: dev.fetch, putioBase: dev.base } : deps);

      return {
        fetch: Effect.gen(function* () {
          const [response, socket] = yield* Cloudflare.upgrade();

          for (const event of agent.greeting()) yield* socket.send(encodeEvent(event));

          agent.connected();

          return response;
        }).pipe(Effect.orDie),
        webSocketMessage: Effect.fn(function* (_socket: Cloudflare.WebSocket, message: string | ArrayBuffer) {
          if (!Predicate.isString(message)) return;
          yield* agent.receive(message);
        }),
        webSocketClose: Effect.fn(function* (socket: Cloudflare.WebSocket, code: number, reason: string) {
          yield* socket.close(code, reason);
        }),
        setAuth: (token: string, username: string, avatarUrl: string | null) => agent.setAuth(token, username, avatarUrl),
        signOut: () => agent.signOut,
        deleteData: () => agent.deleteData,
        sessionGen: () => agent.sessionGen,
        thumbnail: (id: number) => agent.thumbnail(id),
        stream: (id: number) => agent.stream(id),
        downloadLinks: (id: number) => agent.downloadLinks(id),
        poolReport: (m: string, user: string, tokens: number) => Effect.sync(() => Math.max(store.poolReport(m, user, tokens), consoleFloor(config.consoleSpend, m))),
      };
    });
  }),
) {}
