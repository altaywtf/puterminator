# AGENTS.md

puterminator is a chat agent for one person's put.io library, live at <https://puterminator.com>. The brand is always lowercase. How the pieces fit: [docs/architecture.md](docs/architecture.md).

## Where code goes

| Change | Owner |
| --- | --- |
| Routes, OAuth, session cookies | [`routes.ts`](src/server/routes.ts), [`session.ts`](src/server/session.ts) |
| Conversation, tools, system prompt, plan runs | [`conversation.ts`](src/server/conversation.ts) |
| Tool loop on the Anthropic SDK | [`runner.ts`](src/server/runner.ts) |
| put.io calls and error mapping | [`putio.ts`](src/server/putio.ts) |
| Scoring rules (pure) | [`audit.ts`](src/server/audit.ts) |
| Credits: pace line, caps, what blocks a turn (pure) | [`credits.ts`](src/server/credits.ts) |
| Plan validation, apply and undo steps | [`changes.ts`](src/server/changes.ts) |
| Durable Object SQLite | [`store.ts`](src/server/store.ts) |
| Wire frames and tool outputs | [`src/shared`](src/shared) |
| UI: update in [`main.ts`](src/client/main.ts), view in [`view.ts`](src/client/view.ts), tool cards in the `CARDS` registry of [`cards.ts`](src/client/cards.ts) | [`src/client`](src/client) |
| Infra, secrets, domain | [`alchemy.run.ts`](alchemy.run.ts), [`worker.ts`](src/server/worker.ts), [`config.ts`](src/server/config.ts) |

## Skills

- Effect code: read `node_modules/effect/AGENTS.md` first, then `node_modules/effect/src`. Effect setup: [`effect-ts`](.agents/skills/effect-ts/SKILL.md), keeping the pinned `effect` version.

## Lifecycle

```bash
pnpm install --frozen-lockfile   # bootstrap
pnpm dev:fake                    # boot on :1337 with put.io and Anthropic faked on :8788; no secrets needed
pnpm lab                         # every card in every fixture state on :5174/src/client/lab/
pnpm verify                      # the gate: typecheck, lint, knip, test, build
```

`pnpm dev` runs against the real put.io and Anthropic with a local `.env`. `alchemy dev` doesn't typecheck; `pnpm verify` does. Stop dev servers by the PID you started.

## Proof map

| Change | Proof |
| --- | --- |
| Docs, copy, lint config | `pnpm verify` |
| Scoring rules, credits, plan validation, apply and undo | Vitest at the owner's boundary: [`audit.test.ts`](src/server/audit.test.ts), [`credits.test.ts`](src/server/credits.test.ts), [`conversation.test.ts`](src/server/conversation.test.ts) against the fakes in [`src/server/testing`](src/server/testing) |
| Tools, turns, routes | [`conversation.test.ts`](src/server/conversation.test.ts), [`routes.test.ts`](src/server/routes.test.ts) |
| Cards and visuals | `pnpm lab`, plus `pnpm dev:fake` at 375px wide for anything a phone shows |
| Deployed behaviour | CI's smoke step after deploy, then a read-only look at the live site |

Add a test only when it catches something existing coverage misses, and prove it fails with the fix reverted.

## Don't break

- The Durable Object class `Puterminator`, its `putio-<user_id>` instance names, the `pool` instance that sums everyone's credits, and the v1 SQLite tables in [`store.ts`](src/server/store.ts) hold users' data. Renaming any of them strands it.
- Every Anthropic request is charged, stopped ones included, before the next one starts; the shared budget only holds if no path skips the pool.
- Tool input schemas stay valid under strict tool use: no optional keys, no numeric bounds, closed objects (`Schema.Finite`, not `Schema.Int`).
- History is append-only; editing a stored message breaks thinking signatures and the prompt cache.
- The model only proposes library changes: trash, rename, move, restore and subtitle uploads start from browser frames (`apply`, `retry`, `undo`) and are never retried automatically. The one write a tool makes is asking put.io for download links.
- A deploy deletes any live secret that [`config.ts`](src/server/config.ts) doesn't read through `Config`.
- Roll back by redeploying an earlier commit; `wrangler rollback` fails on this script.
- No code comments: the `uinaf/no-comments` lint rule enforces it. Names, types and tests carry intent; the commit message carries the why.

## Needs the user

- Writes against a real put.io library, including Altay's own. Use `pnpm dev:fake` instead.
- Secrets, the put.io OAuth app's settings, the domain and Cloudflare tokens.
- Showing UI changes: iterate locally and ship once Altay signs off.

A push to `main` deploys to production through [`ci.yml`](.github/workflows/ci.yml); a pull request runs only the gate.
