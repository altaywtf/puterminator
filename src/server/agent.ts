import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { initialAgentState, ServerFrame, type ServerEvent } from "../shared/contract";

const encodeEvent = Schema.encodeSync(ServerFrame);
const month = () => new Date().toISOString().slice(0, 7);

// The live Worker binds `Puterminator` -> class `Puterminator`. Adoption matches the namespace by
// that name and keeps its SQLite data; renaming the class in the adopting deploy loses it.
// Stub: the backend stage replaces the body with the agent loop over the existing v1 tables.
export default class Puterminator extends Cloudflare.DurableObject<Puterminator>()(
  "Puterminator",
  Effect.gen(function* () {
    return Effect.gen(function* () {
      const send = (socket: Cloudflare.WebSocket, event: ServerEvent) => socket.send(encodeEvent(event));
      return {
        fetch: Effect.gen(function* () {
          const [response, socket] = yield* Cloudflare.upgrade();
          yield* send(socket, { type: "state", state: initialAgentState(month()) });
          yield* send(socket, { type: "history", messages: [] });
          return response;
        }).pipe(Effect.orDie),
        webSocketMessage: Effect.fn(function* (socket: Cloudflare.WebSocket, _message: string | ArrayBuffer) {
          yield* send(socket, { type: "error", message: "Not implemented yet." });
        }, Effect.orDie),
        webSocketClose: Effect.fn(function* (socket: Cloudflare.WebSocket, code: number, reason: string) {
          yield* socket.close(code, reason);
        }),
      };
    });
  }),
) {}
