# Library audit

The agent scans the library, scores naming, junk and duplicates out of 100, and shows a score card plus a browsable tree.

## Sub-features

- `audit-scan` runs `scan_library` and stores the snapshot.
- `audit-score` shows the `library score` card.
- `audit-tree` lists folders with sizes, junk and unplayed counts.

## How to get to it (user POV)

- Choose the `audit my library` suggestion on an empty thread.
- Type a message containing `audit` or `scan` and send it.
- Open `browse library` from the account menu to see the tree.

## Driving it with verify.ts

Preconditions:

- Baseline, on an empty thread.

- **Ask for an audit.** Run `$V pw click "getByRole('button', { name: /^audit my library/ })"`. A `$ scan_library` tool line appears, then a streamed reply starting `Score **`.
- **Score card.** Wait for `getByRole('img', { name: /^library score \d+ out of 100/ })`. It sits in `getByRole('region', { name: 'library score' })`.
- **Stored snapshot.** Run `$V db "SELECT count(*) AS files FROM files"`. It prints more than 0 (the seed has 134 files).
- **Tree.** Open the account menu with `$V pw click "getByRole('button', { name: 'account: altay' })"`, then `$V pw click "getByRole('button', { name: 'browse library' })"`. `getByRole('tree', { name: 'Your Files tree' })` lists `Movies/`, `Series/`, `Downloads/` with sizes. Close it with `$V pw click "getByRole('button', { name: 'close library' })"`.
- **Proof.** Snapshot the `library score` region and the `tree`, and screenshot.

## Gotchas

- Signing in starts a background scan; the tree can fill before any audit. The score card only comes from the audit turn.
- The score depends on the seed. Assert the card's shape, not a number.
- `browse library` shows only after a scan.
- The open tree panel covers the composer, and Escape leaves it open. Choose `close library` before the next send.
