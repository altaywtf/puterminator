# Plans

The model proposes library changes as a diff card; only the user's click applies them, one step at a time, and a receipt offers undo.

## Sub-features

- `plan-propose` shows a `plan` card with hunks and a summary line.
- `plan-untick` leaves unticked changes out of the run.
- `plan-apply` applies the picked changes in order, then rescans.
- `plan-undo` reverses a finished run's done steps.
- `plan-discard` collapses the card to a struck-through line.
- `plan-retry` reruns failed steps from the receipt.

## How to get to it (user POV)

- Choose the `clean up my downloads` suggestion on an empty thread.
- Type a message containing `clean` and send it.
- Other planners land on the same card: `subtitle`, `free up` or `space`, `plex` or `layout`, `translate`.

## Driving it with verify.ts

Preconditions:

- Baseline, on an empty thread.
- No plan rows yet: `$V db "SELECT count(*) FROM plans"` prints `0`.

- **Propose.** Choose the suggestion. Run `$V pw click "getByRole('button', { name: /^clean up my downloads/ })"`, then wait for `getByRole('region', { name: 'plan' }).getByRole('button', { name: 'apply', exact: true })`. The card reads `15 changes, 9 trashed, 3 renamed, 3 moved, 90 MB freed`; `$V db "SELECT json_extract(json, '\$.record.status') AS status FROM plans"` prints `proposed`.
- **Apply.** Choose `apply`. Run `$V pw click "getByRole('region', { name: 'plan' }).getByRole('button', { name: 'apply', exact: true })"`, then wait for `getByRole('region', { name: 'receipt' }).getByRole('button', { name: 'undo' })`. The receipt reads `[clean up Downloads] 15 changes, …`.
- **Check the writes.** Run `$V writes`. It prints 9 `/v2/files/delete`, 3 `/v2/files/rename` for the `.mkv` files, then for each folder a `/v2/files/move parent_id=1000` followed by a `/v2/files/rename`: 18 lines in plan order.
- **Undo.** Choose `undo`. Run `$V pw click "getByRole('region', { name: 'receipt' }).getByRole('button', { name: 'undo' })"`, then wait for `getByRole('region', { name: 'receipt' }).getByText(/^\[undo clean up Downloads\]/)`. The receipt reads `3 renamed, 3 moved, 9 restored`; `$V writes` adds 9 `/v2/trash/restore` lines.
- **Discard.** On a fresh proposal (send `clean the downloads`), run `$V pw click "getByRole('region', { name: 'plan' }).getByRole('button', { name: 'discard' })"`. The card becomes a struck-through `clean up Downloads` line ending `discarded`, the plan's status is `discarded`, and `$V writes` adds nothing.
- **Proof.** Snapshot the `plan` and `receipt` regions with `--filename`, screenshot after apply and after undo, save `$V writes` output, and record the final `plans` status.

## Gotchas

- The receipt appears when the steps finish; the stored status turns `done` or `undone` only after the rescan that follows. Poll `$V db` for the status rather than reading it once.
- `apply` waits for its locator inside the `plan` region: the receipt has no `apply`, and a bare `getByRole('button', { name: 'apply' })` also matches nothing once the run starts.
- `plan-retry` needs a failing step. The fake fails any write on a file whose name contains `locked`, and the seed has none, so retry cannot be reached from the baseline: report it as unreachable with that reason.
- Writes are never retried automatically. A step whose response was lost shows as "may have happened" and undo reverses it too.
