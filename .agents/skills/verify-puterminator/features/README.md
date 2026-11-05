# puterminator verification map

The maintained recipes for proving each user-facing feature. Read this index, then follow the matching feature file.

## Baseline

- `$V up` and `$V doctor` pass, with `V=.agents/skills/verify-puterminator/verify.ts` and `U=$(node -p "require('./.verify/current/run.json').url")`.
- Signed in: `$V pw open "$U/"`, `$V pw click "getByRole('link', { name: 'continue with put.io' })"`, then wait for `getByRole('heading', { name: /^hi altay/ })`.
- Scanned: wait for `locator('[role=tree]').first()` with `state: 'attached'`. The heading shows about 2 s before the sign-in scan lands, and a plan or link request sent earlier works from an empty snapshot.
- The fake library is the seed in [`dev-fake.ts`](../../../../src/server/testing/dev-fake.ts): Movies, Series, Downloads with six RARBG release folders, loose junk at the root. It resets on every `up`.
- Only drive an instance this run started.

## Driving conventions

- Start each recipe from the baseline unless its preconditions say otherwise.
- Send a message with `$V pw fill "getByRole('textbox', { name: 'message puterminator' })" "<text>"`, then `$V pw click "getByRole('button', { name: 'send' })"`. The fake chooses its reply from keywords in the text, so send the recipe's text as written.
- Before each send, wait for `getByRole('button', { name: 'send' })`. While a reply streams, that button is `stop reply`.
- Wait on a locator with `$V pw run-code "async page => { await <locator>.waitFor({ timeout: 30000 }); }"`.

## Proof and skip reporting

- UI proof: an ARIA snapshot of the card (`$V pw snapshot "<locator>" --filename=…`) and a screenshot, before and after the action.
- Write proof: `$V writes` output, saved into the evidence folder.
- Stored proof: a `$V db` query on the table the feature writes.
- Record the feature ID and entry point beside each artifact.
- Report an entry point you could not reach with the command tried and the unmet precondition. A skipped entry point is not verified through a different one.

## Feature entry contract

Each feature file has an H1, one paragraph on the user-visible behaviour, then four H2s in this order: `Sub-features`, `How to get to it (user POV)`, `Driving it with verify.ts`, `Gotchas`. The driving section starts with `Preconditions:`, then pairs each user action with its exact command and observable result.

## Features

- [Plans](./plans.md): propose, untick, apply, undo, discard and retry library changes.
- [Library audit](./audit.md): scan the library and show the score card and tree.
- [Download links](./download-links.md): ask put.io for links and show them in a card.
- [Chat turns](./chat.md): send, stream, stop a reply, start a new thread.
- [Account](./account.md): sign in, sign out, forget me.
