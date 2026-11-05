# Chat turns

The user sends a message, the reply streams in with thinking and text, the user can stop it mid-turn, and a new thread archives the conversation.

## Sub-features

- `chat-send` appends the user turn and streams the reply.
- `chat-stop` stops a streaming reply and keeps the text so far.
- `chat-new-thread` archives the history and shows the empty thread.

## How to get to it (user POV)

- Type in the composer and choose `send`, or press Enter.
- Choose `stop reply` while a reply streams.
- Choose `new thread` in the account menu.

## Driving it with verify.sh

Preconditions:

- Baseline.

- **Send.** Send `hello there`. An `article` named `you` holds the text, and the `send` button turns into `stop reply`.
- **Stop.** Wait for `getByRole('button', { name: 'stop reply' })`, then run `$V pw click "getByRole('button', { name: 'stop reply' })"` within a few seconds. The `puterminator` article keeps a partial `Line 1: …` paragraph, and `$V log` shows `messages stream aborted by client`.
- **Charged.** Run `$V db "SELECT month, tokens FROM usage"`. Tokens grew after the stopped turn (9360 to 12350 from a fresh run): stopped requests are charged too.
- **New thread.** Run `$V pw click "getByRole('button', { name: 'account: altay' })"`, then `$V pw click "getByRole('button', { name: 'new thread' })"`. The `hi altay.` heading returns; `$V db "SELECT (SELECT count(*) FROM messages) AS live, (SELECT count(*) FROM archived_messages) AS archived"` shows `live` 0.
- **Proof.** Snapshot the `puterminator` article after the stop, screenshot, and save the `$V log` line.

## Gotchas

- A message with no planner keyword gets the fake's 12-line reply at 120 ms per word: about 10 s, long enough to stop. A keyword message finishes too fast.
- `new thread` is missing from the menu while a reply streams or the thread is empty.
- History is append-only. Prove a stop by the kept text, not by an edited message row.
