import * as Schema from "effect/Schema";

export const PUTIO_API = "https://api.put.io";
const UPSTREAMS = new Set([PUTIO_API, "https://api.anthropic.com"]);
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * `DEV_FAKE_UPSTREAM`: a local fake for put.io and Anthropic (`pnpm dev:fake`). Only a loopback
 * http URL decodes, so a deployed Worker can never be pointed at a real host through it.
 */
export const DevUpstream = Schema.String.check(
  Schema.makeFilter((s: string) => {
    const url = URL.canParse(s) ? new URL(s) : null;

    return (url !== null && url.protocol === "http:" && LOOPBACK.has(url.hostname)) || "must be a loopback http URL";
  }),
);

/** Sends put.io and Anthropic requests to `base`, path and query kept. Anything else passes through. */
export const upstreamFetch =
  (base: string): typeof fetch =>
  (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);

    if (!UPSTREAMS.has(url.origin)) return fetch(request);

    return fetch(new Request(new URL(`${url.pathname}${url.search}`, base), request));
  };
