import type { Json } from "effect/Schema";

const json = (status: number, body: Json) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export const makeFakeTmdb = (routes: Readonly<Record<string, Json>>) => {
  const paths: Array<string> = [];

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/3/, "");

    paths.push(`${path}${url.search}`);

    if (request.headers.get("authorization") !== "Bearer tmdb-token") return json(401, { status_message: "Invalid API key" });
    const body = routes[path];

    return body === undefined ? json(404, { status_message: "not found" }) : json(200, body);
  };

  return { fetch, paths };
};
