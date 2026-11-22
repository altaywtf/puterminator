# AGENTS.md

puterminator is a chat agent for one person's put.io library, live at <https://puterminator.com>. The brand is always lowercase. How the pieces fit: [docs/architecture.md](docs/architecture.md).

## Where code goes

| Change | Owner |
| --- | --- |
| Routes, OAuth, session cookies | [`routes.ts`](src/server/routes.ts), [`session.ts`](src/server/session.ts) |
| Conversation, tools, system prompt, plan run steps | [`conversation.ts`](src/server/conversation.ts) |
| Plan lifecycle: states, stop, retry, undo, restart | [`plan-machine.ts`](src/server/plan-machine.ts) |
| What the Durable Object is doing: turn, rescan, plan run | [`activity-machine.ts`](src/server/activity-machine.ts) |
| Standing rules: matching, cap and share checks (pure) | [`rules.ts`](src/server/rules.ts) |
| Rule lifecycle: preview, approve, due, pause, restart | [`rule-machine.ts`](src/server/rule-machine.ts); its alarm is registered in [`agent.ts`](src/server/agent.ts) |
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

- Effect code: read `node_modules/effect/AGENTS.md` first, then `node_modules/effect/src`. Keep the pinned `effect` version.
- Work whose named states matter (resume, stop, retry, inspect) is an XState machine built with `setupEffect`, its side effects in declared `createEffectLogic` actors. Everything else stays plain Effect. Read the pinned `node_modules/xstate` and `node_modules/@xstate/effect` sources first; `xstate`, `@xstate/effect` and `effect` move together.
- Proving behaviour in the browser: [`verify-puterminator`](.agents/skills/verify-puterminator/SKILL.md) drives an isolated `dev:fake` instance and captures proof.
- Plan runs (apply, stop, retry, undo): [`verify-plan-runs`](.agents/skills/verify-plan-runs/SKILL.md) model-checks them with TLA+.

## Lifecycle

```bash
pnpm install --frozen-lockfile   # bootstrap
pnpm dev:fake                    # boot at https://<branch>.puterminator.localhost:1355 (portless) with put.io and Anthropic faked; no secrets needed
pnpm lab                         # every card in every fixture state on :5174/src/client/lab/
pnpm verify                      # the gate: typecheck, lint, knip, test, build
```

Every commit runs `pnpm verify` through the lefthook pre-commit hook, and CI runs it again. [`.pi/extensions/hook-guard`](.pi/extensions/hook-guard) blocks bypasses in Pi and Claude Code.

The Tokenmaxx workshop tools live in the git-ignored `workshop/`: `pnpm pi` and `pnpm ex <id> <command>`.

`pnpm dev` runs on :1337 against the real put.io and Anthropic with a local `.env`; `PORTLESS=0 pnpm dev:fake` also boots on :1337. `alchemy dev` skips typechecking; `pnpm verify` covers it. Stop dev servers by the PID you started.

## Proof map

| Change | Proof |
| --- | --- |
| Docs, copy, lint config | `pnpm verify` |
| Scoring rules, credits, plan validation, apply and undo | Vitest at the owner's boundary: [`audit.test.ts`](src/server/audit.test.ts), [`credits.test.ts`](src/server/credits.test.ts), [`conversation.test.ts`](src/server/conversation.test.ts) against the fakes in [`src/server/testing`](src/server/testing) |
| Tools, turns, routes | [`conversation.test.ts`](src/server/conversation.test.ts), [`routes.test.ts`](src/server/routes.test.ts) |
| Cards and visuals | `pnpm lab`, plus [`verify-puterminator`](.agents/skills/verify-puterminator/SKILL.md) at 375px wide for anything a phone shows |
| User journeys: turns, plans, links, sign-in | [`verify-puterminator`](.agents/skills/verify-puterminator/SKILL.md) |
| Plan run engine | [`verify-plan-runs`](.agents/skills/verify-plan-runs/SKILL.md), plus Vitest |
| Deployed behaviour | CI's smoke step after deploy, then a read-only look at the live site |

Add a test only when it catches something existing coverage misses, and prove it fails with the fix reverted.

## Hazards

- The Durable Object class `Puterminator`, its `putio-<user_id>` instance names, the `pool` instance that sums everyone's credits, and the v1 SQLite tables in [`store.ts`](src/server/store.ts) hold users' data. Renaming any of them strands it.
- Every Anthropic request is charged, stopped ones included, before the next one starts; the shared budget only holds if no path skips the pool.
- Tool input schemas stay valid under strict tool use: no optional keys, no numeric bounds, closed objects (`Schema.Finite`, not `Schema.Int`).
- XState `after` timers live in memory and die with the Durable Object. Anything that must outlive eviction uses a Durable Object alarm.
- A plan snapshot never resumes a run: a run cut off by eviction settles as interrupted on the next activation, and plans saved before the machine load from `record.status`.
- History is append-only; editing a stored message breaks thinking signatures and the prompt cache.
- The model only proposes library changes: trash, rename, move, restore and subtitle uploads start from browser frames (`apply`, `retry`, `undo`) or from the alarm of a rule the person approved, once per due time, and are never retried automatically. The one write a tool makes is asking put.io for download links.
- The `rule-due` callback name in [`agent.ts`](src/server/agent.ts) keys pending alarms; renaming it strands them.
- A deploy deletes any live secret that [`config.ts`](src/server/config.ts) doesn't read through `Config`.
- Roll back by redeploying an earlier commit; `wrangler rollback` fails on this script.
- The `uinaf/no-comments` lint rule fails code comments. Names, types and tests carry intent; the commit message carries the why.

## Needs the user

- Writes against a real put.io library, including Altay's own. `pnpm dev:fake` needs no approval.
- Secrets, the put.io OAuth app's settings, the domain and Cloudflare tokens.
- Showing UI changes: iterate locally and ship once Altay signs off.

A push to `main` deploys to production through [`ci.yml`](.github/workflows/ci.yml); a pull request runs only the gate.
