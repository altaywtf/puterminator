---
name: verify-puterminator
description: Drive puterminator's browser UI against the local put.io and Anthropic fakes and capture proof. Use to prove a change to chat turns, tool cards, plans (apply, undo, retry), sign-in, or download links the way a user sees it.
---

# Verify puterminator

`verify.sh` (beside this file) runs one isolated instance per checkout and drives it headless with `@playwright/cli`. Every command below runs from the repository root.

```bash
V=.agents/skills/verify-puterminator/verify.sh
```

## Launch

```bash
$V up
```

- Starts `pnpm dev:fake` on private ports: the fake from 18788, the Worker from 11337 (`FAKE_PORT`, `DEV_PORT`). Other sessions own the default 1337 and 8788; a run on them gets driven and killed by those sessions.
- Wipes `.alchemy/local/puterminator-Puterminator` first, so every run starts with no user, no history and no plans. The fake's library resets on every start.
- Ready means the log shows `ready at <url>` and `GET /api/me` answers `"configured":true`. `up` waits for both, up to 120 s.
- `up` refuses when a `dev:fake` it didn't start runs from this checkout. Leave that one alone.

## Doctor

```bash
$V doctor
```

Run it first whenever anything looks off. It checks that the process is alive, the Worker answers `/api/me`, the fake answers, and the fake on that port belongs to this run. It exits non-zero when the instance isn't worth driving.

## Drive

`$V pw <command>` is `playwright-cli` bound to this run's browser session, with its working directory in the run's evidence folder. Target elements with Playwright locators, by role and accessible name:

```bash
U=$(cat .verify/current/url)
$V pw open "$U/"
$V pw click "getByRole('link', { name: 'continue with put.io' })"
$V pw run-code "async page => { await page.getByRole('heading', { name: /^hi altay/ }).waitFor({ timeout: 30000 }); }"
$V pw snapshot
```

- Sign-in goes through the fake OAuth with no form: the click lands back on `/` signed in as `altay` (user id 4242).
- Wait with `run-code` and `locator.waitFor`, never a fixed sleep. Replies stream word by word.
- `$V pw snapshot` prints the accessibility tree with refs. `$V pw find "<text or regexp>"` searches it.
- The fake picks the model's reply from keywords in your message, so the message decides the journey. [`dev-fake.ts`](../../../src/server/testing/dev-fake.ts) `plan()` holds the keyword table. Each feature file names the exact message to send.
- A phone layout: `$V pw resize 375 812` before driving.

Stable handles in the UI:

| Handle | Locator |
| --- | --- |
| Composer | `getByRole('textbox', { name: 'message puterminator' })`, `getByRole('button', { name: 'send' })` |
| Stop a reply | `getByRole('button', { name: 'stop reply' })` |
| Turns | `getByRole('article', { name: 'you' })`, `getByRole('article', { name: 'puterminator' })` |
| Cards | `getByRole('region', { name })`: `plan`, `applying changes`, `undoing changes`, `receipt`, `library score`, `files`, `folder`, `download links`, `feedback draft` |
| Credits | `getByRole('meter', { name: 'credits left this month' })` |
| Account menu | `getByRole('button', { name: 'account: altay' })` |

## Evidence

A proof has three parts, each saved under `.verify/<run>/evidence/`:

1. **The user's view**: `$V pw snapshot "<locator>" --filename=<name>.aria.yml` of the card, plus `$V pw screenshot --filename=<name>.png`. Capture the state before and after the action.
2. **The writes put.io received**: `$V writes` prints every library write the fake logged, in order. `$V log` prints every fake call, Anthropic requests included. Save the output into the evidence folder.
3. **What the Durable Object stored**: `$V db "<SQL>"` runs read-only SQL on the signed-in user's SQLite. Tables are in [`store.ts`](../../../src/server/store.ts). For example: `$V db "SELECT json_extract(json, '\$.record.status') AS status FROM plans"`.

Drive the real path: the composer, the suggestion buttons, the card buttons. A frame sent from `run-code` straight into the WebSocket proves the server, not the feature.

## Cleanup

```bash
$V down
```

Closes the browser, stops the process group `up` started, and drops `.verify/current`. The run folder stays, with `server.log` and `evidence/`. `.verify/` is gitignored; delete old runs by hand.

## Feature map

[`features/README.md`](features/README.md) indexes the user-facing features and the journey that proves each. Prove a change on every entry point its feature file lists.
