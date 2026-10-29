import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

// Secrets arrive as untyped strings; a blank one must stop sign-in, not leak "undefined" into a put.io URL.
const Secret = Schema.String.check(
  Schema.makeFilter((s: string) => {
    const t = s.trim();
    return (t.length > 0 && t !== "undefined" && t !== "null") || "must be set";
  }),
);
const AuthFields = {
  PUTIO_CLIENT_ID: Secret,
  PUTIO_CLIENT_SECRET: Secret,
  SESSION_SECRET: Secret.check(Schema.isMinLength(32)),
} as const;

export type AuthConfig = {
  readonly putioClientId: string;
  readonly putioClientSecret: Redacted.Redacted<string>;
  readonly sessionSecret: Redacted.Redacted<string>;
};

export type AppConfig = {
  /** null when a sign-in secret is invalid: every route but /api/me fails closed. */
  readonly auth: AuthConfig | null;
  readonly anthropicApiKey: Redacted.Redacted<string>;
  readonly model: string;
  readonly monthlyTokenCap: number;
};

/** The keys that fail validation. Names only: values never reach a log. */
export const invalidAuthKeys = (raw: { readonly [K in keyof typeof AuthFields]: string }) =>
  (Object.keys(AuthFields) as Array<keyof typeof AuthFields>).filter((k) => !Schema.is(AuthFields[k])(raw[k]));

export const validateAuth = (raw: { readonly [K in keyof typeof AuthFields]: string }) =>
  Effect.gen(function* () {
    const bad = invalidAuthKeys(raw);
    if (bad.length > 0) {
      yield* Effect.logWarning(`sign-in is not configured: ${bad.join(", ")}`);
      return null;
    }
    const auth: AuthConfig = {
      putioClientId: raw.PUTIO_CLIENT_ID.trim(),
      putioClientSecret: Redacted.make(raw.PUTIO_CLIENT_SECRET.trim()),
      sessionSecret: Redacted.make(raw.SESSION_SECRET),
    };
    return auth;
  });

/**
 * Read in the Worker's construction phase: each key becomes a secret binding on deploy. A missing
 * key fails Init, so a deploy without it stops instead of deleting the live secret; a present but
 * invalid one leaves `auth` null.
 */
export const readConfig = Effect.gen(function* () {
  const PUTIO_CLIENT_ID = yield* Config.String("PUTIO_CLIENT_ID");
  const PUTIO_CLIENT_SECRET = yield* Config.Redacted("PUTIO_CLIENT_SECRET");
  const SESSION_SECRET = yield* Config.Redacted("SESSION_SECRET");
  const anthropicApiKey = yield* Config.Redacted("ANTHROPIC_API_KEY");
  const model = yield* Config.String("MODEL").pipe(Config.withDefault("claude-sonnet-5-5"));
  const monthlyTokenCap = yield* Config.Int("MONTHLY_TOKEN_CAP").pipe(Config.withDefault(1_000_000));
  const auth = yield* validateAuth({
    PUTIO_CLIENT_ID,
    PUTIO_CLIENT_SECRET: Redacted.value(PUTIO_CLIENT_SECRET),
    SESSION_SECRET: Redacted.value(SESSION_SECRET),
  });
  const config: AppConfig = { auth, anthropicApiKey, model, monthlyTokenCap };
  return config;
});
