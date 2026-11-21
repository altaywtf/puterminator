# Standing rules

The model proposes a rule that trashes videos first opened at least N days ago. The card previews what it would trash today. Nothing runs until the user approves it; each run is an ordinary plan with a receipt that offers undo.

## Sub-features

- `rule-propose` shows a `rule` card with the criteria and today's preview.
- `rule-approve` schedules the rule's alarm. The first run is due right away and trashes exactly the previewed files.
- `rule-undo` reverses a run from its receipt under the rule card.
- `rule-pause` stops the schedule. `preview again` lists today's matches, and the rule waits for a new approval.
- `rule-elsewhere` shows rules from earlier threads at the top of a new thread.

## How to get to it (user POV)

- Type a message containing `every week`, `standing rule` or `old films` and send it.

## Driving it with verify.ts

Preconditions:

- Baseline, scanned, on an empty thread.

- **Propose.** Send `trash old films I watched over a month ago, every week`, then wait for `getByRole('region', { name: 'rule' })`. The card reads `# today: 3 files, 15.0 GB` and lists `Arrowmere (1979).mkv`, `Dunmar (1991).mkv` and `Memora (2003).mkv`. `Pallisters (2015)` was played too, but the rule protects its folder. `$V writes` prints nothing.
- **Approve.** Run `$V pw click "getByRole('region', { name: 'rule' }).getByRole('button', { name: 'approve' })"`, then wait for `getByRole('region', { name: 'receipt' })` and for the rule's `next …` meta, a week out. `$V writes` prints three `/v2/files/delete` lines. `$V db "SELECT json_extract(machine, '\$.snapshot.value') FROM rules"` prints `{"active":"waiting"}`.
- **Undo.** Choose `undo` on the receipt, then wait for `getByText(/\[undo /)`. `$V writes` adds three `/v2/trash/restore` lines.
- **Pause and preview again.** Choose `pause`; the card reads `# paused: paused by you`. Choose `preview again`; the card shows today's preview and `approve`.
- **Elsewhere.** Choose `account: altay`, then `new thread`. The rule card shows under the composer.

## Gotchas

- Approving schedules the first run for right now, so the receipt follows within a second or two.
- The fake's played films date from 2026-02-01; a rule asking for more days than have passed since then matches nothing.
