import {
  buildFileHlsStreamUrl,
  buildPutioUrl,
  createPutioSdkEffectClient,
  isPutioAuthError,
  isPutioRateLimitError,
  makePutioFetchLayer,
  makePutioSdkLayer,
  type PutioSdkContext,
  type PutioSdkError,
  requestJson,
} from "@putdotio/sdk";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { Folder } from "../shared/contract";
import { PUTIO_API } from "./dev";
import type { PutioFile } from "./tree";

const sdk = createPutioSdkEffectClient();

/** put.io rejected the token (401/403). */
export class PutioUnauthorized extends Schema.TaggedError<PutioUnauthorized>()("PutioUnauthorized", {
  status: Schema.Finite,
}) {}

/** put.io's request window is spent and refills later than a turn should wait. */
export class PutioRateLimited extends Schema.TaggedError<PutioRateLimited>()("PutioRateLimited", {
  retryAfterMs: Schema.Finite,
}) {}

/** Any other put.io failure: transport, status or decoding. */
export class PutioFailed extends Schema.TaggedError<PutioFailed>()("PutioFailed", {
  message: Schema.String,
}) {}

export type PutioError = PutioUnauthorized | PutioRateLimited | PutioFailed;

/** Workers need `fetch` called unbound, so pass a closure; tests pass a fake. */
export const putioLayer = (accessToken: string | undefined, fetchImpl: typeof fetch = (input, init) => fetch(input, init)) =>
  makePutioSdkLayer(accessToken === undefined ? {} : { accessToken }).pipe(Layer.provideMerge(makePutioFetchLayer(fetchImpl)));

export const rateLimitMessage = (e: PutioRateLimited) => {
  const minutes = Math.max(1, Math.ceil(e.retryAfterMs / 60_000));
  return `put.io rate limit: try again in about ${minutes} minute${minutes === 1 ? "" : "s"}.`;
};

const MAX_WAIT_MS = 10_000;
const MAX_ATTEMPTS = 4;

/**
 * Every call here is a read, so retrying a 429 is safe. put.io allows a fixed number of requests
 * per window and `x-ratelimit-reset` is when it refills (epoch seconds). Waits beyond 10 s, or a
 * fifth 429, surface as PutioRateLimited instead of holding the Durable Object.
 */
export const read = <A, R>(
  label: string,
  effect: Effect.Effect<A, PutioSdkError, R>,
): Effect.Effect<A, PutioError, R> => {
  const loop = (attempt: number): Effect.Effect<A, PutioError, R> =>
    effect.pipe(
      Effect.catch((err) => {
        if (isPutioAuthError(err)) return Effect.fail(new PutioUnauthorized({ status: err.status }));
        if (!isPutioRateLimitError(err)) {
          const status = "status" in err ? ` → ${err.status}` : "";
          return Effect.fail(new PutioFailed({ message: `put.io ${label}${status}` }));
        }
        return Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const reset = Number(err.reset);
          const waitMs = Number.isFinite(reset) && reset > 0 ? reset * 1000 - now : 1000 * 2 ** attempt;
          if (attempt >= MAX_ATTEMPTS || waitMs > MAX_WAIT_MS) {
            return yield* new PutioRateLimited({ retryAfterMs: Math.max(waitMs, 0) });
          }
          yield* Effect.sleep(Duration.millis(Math.max(waitMs, 500)));
          return yield* loop(attempt + 1);
        });
      }),
    );
  return loop(0);
};

/** put.io's own authorize endpoint, as v1 used it; it hands over to the put.io login page. */
export const authorizeUrl = (clientId: string, redirectUri: string, state: string, base: string = PUTIO_API) =>
  buildPutioUrl(base, "/v2/oauth2/authenticate", {
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    state,
  });

/** Any failure, including `invalid_grant` for a reused code, means sign-in failed. */
export const exchangeCode = (input: { clientId: string; clientSecret: string; redirectUri: string; code: string }) =>
  sdk.auth.exchangeAuthorizationCode(input).pipe(
    Effect.mapError(() => new PutioFailed({ message: "put.io code exchange failed" })),
  );

// Only the fields sign-in needs, so drift elsewhere in the account payload can't break it.
const AccountInfo = Schema.Struct({
  info: Schema.Struct({ user_id: Schema.Finite, username: Schema.String, avatar_url: Schema.optional(Schema.NullOr(Schema.String)) }),
});

/** The browser loads the avatar straight from this URL, so anything but https is dropped. */
const httpsUrl = (raw: string | null | undefined): string | null => {
  if (!raw) return null;
  try {
    return new URL(raw).protocol === "https:" ? raw : null;
  } catch {
    return null;
  }
};

export const accountInfo = read("/account/info", requestJson(AccountInfo, { method: "GET", path: "/v2/account/info" })).pipe(
  Effect.map(({ info }) => ({ userId: info.user_id, username: info.username, avatarUrl: httpsUrl(info.avatar_url) })),
);

// Narrower than the SDK's FileBroadSchema: an unknown `file_type` must not fail a whole page.
const ScanFile = Schema.Struct({
  id: Schema.Finite,
  parent_id: Schema.NullOr(Schema.Finite),
  name: Schema.String,
  size: Schema.Finite,
  file_type: Schema.String,
  extension: Schema.NullOr(Schema.String),
  crc32: Schema.NullOr(Schema.String),
  created_at: Schema.String,
  first_accessed_at: Schema.NullOr(Schema.String),
});
const ListPage = Schema.Struct({ files: Schema.Array(ScanFile), cursor: Schema.NullOr(Schema.String) });

const listPaged = (parentId: number, perPage: number): Effect.Effect<Array<PutioFile>, PutioError, PutioSdkContext> =>
  Effect.gen(function* () {
    const first = yield* read(
      "/files/list",
      requestJson(ListPage, { method: "GET", path: "/v2/files/list", query: { parent_id: parentId, per_page: perPage, hidden: 1 } }),
    );
    const files: Array<PutioFile> = [...first.files];
    let cursor = first.cursor;
    while (cursor) {
      const page = yield* read(
        "/files/list/continue",
        requestJson(ListPage, {
          method: "POST",
          path: "/v2/files/list/continue",
          body: { type: "form", value: { cursor, per_page: perPage } },
        }),
      );
      files.push(...page.files);
      cursor = page.cursor;
    }
    return files;
  });

/**
 * Every file the user has, flat: put.io's `parent_id=-1`. The SDK's `files.list` refuses -1, so
 * this goes through its transport directly. A per-folder walk exhausts the request window.
 */
export const listAll = listPaged(-1, 2000);

const FileMedia = Schema.Struct({ file: Schema.Struct({ file_type: Schema.String, screenshot: Schema.NullOr(Schema.String) }) });

/** A file's type and screenshot URL; put.io serves screenshots without auth. */
export const fileMedia = (id: number) =>
  read("/files/:id", requestJson(FileMedia, { method: "GET", path: `/v2/files/${id}` })).pipe(Effect.map(({ file }) => file));

const DownloadToken = Schema.Struct({ info: Schema.Struct({ download_token: Schema.String }) });

/**
 * put.io's download token: scoped to download and stream URLs, the same token put.io's own web
 * app puts in its player URLs. The OAuth token itself never leaves the Durable Object.
 */
export const downloadToken = read(
  "/account/info",
  requestJson(DownloadToken, { method: "GET", path: "/v2/account/info", query: { download_token: 1 } }),
).pipe(Effect.map(({ info }) => info.download_token));

export const hlsUrl = (id: number, token: string, base: string = PUTIO_API) =>
  buildFileHlsStreamUrl(base, id, { downloadToken: token });

// ---------- writes ----------

/**
 * Writes are never retried: a 429 or a dropped response could mean put.io already applied it. A failure
 * surfaces on its step, and the user retries from the run card.
 */
const write = <A, R>(label: string, effect: Effect.Effect<A, PutioSdkError, R>): Effect.Effect<A, PutioError, R> =>
  effect.pipe(
    Effect.mapError((err): PutioError =>
      isPutioAuthError(err)
        ? new PutioUnauthorized({ status: err.status })
        : isPutioRateLimitError(err)
          ? new PutioRateLimited({ retryAfterMs: 60_000 })
          : new PutioFailed({ message: `put.io ${label}${"status" in err ? ` → ${err.status}` : ""}` }),
    ),
  );

const Ok = Schema.Struct({ status: Schema.String });

/** With trash off, put.io's delete is permanent, so trash changes check this first. */
export const trashEnabled = read(
  "/account/settings",
  requestJson(Schema.Struct({ settings: Schema.Struct({ trash_enabled: Schema.Boolean }) }), { method: "GET", path: "/v2/account/settings" }),
).pipe(Effect.map(({ settings }) => settings.trash_enabled));

/** Moves one file to put.io's trash. Never passes skip_trash. */
export const trashFile = (id: number) =>
  write("/files/delete", requestJson(Ok, { method: "POST", path: "/v2/files/delete", body: { type: "form", value: { file_ids: String(id) } } }));

/** Puts one trashed file back where it was. */
export const restoreFile = (id: number) =>
  write("/trash/restore", requestJson(Ok, { method: "POST", path: "/v2/trash/restore", body: { type: "form", value: { file_ids: String(id) } } }));

export const renameFile = (id: number, name: string) =>
  write("/files/rename", requestJson(Ok, { method: "POST", path: "/v2/files/rename", body: { type: "form", value: { file_id: id, name } } }));

const MoveResult = Schema.Struct({ errors: Schema.optional(Schema.Array(Schema.Unknown)) });

/** put.io answers 200 with an `errors` list when a move fails; that is a failure too. */
export const moveFile = (id: number, parentId: number) =>
  write(
    "/files/move",
    requestJson(MoveResult, { method: "POST", path: "/v2/files/move", body: { type: "form", value: { file_ids: String(id), parent_id: parentId } } }),
  ).pipe(Effect.flatMap((r) => ((r.errors ?? []).length > 0 ? Effect.fail(new PutioFailed({ message: "put.io /files/move → refused" })) : Effect.void)));

const Created = Schema.Struct({ file: Schema.Struct({ id: Schema.Finite }) });

export const createFolder = (name: string, parentId: number) =>
  write(
    "/files/create-folder",
    requestJson(Created, { method: "POST", path: "/v2/files/create-folder", body: { type: "form", value: { name, parent_id: parentId } } }),
  ).pipe(Effect.map(({ file }) => file.id));
