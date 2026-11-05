# Account

The user signs in with put.io OAuth, signs out (ending every session), or asks puterminator to forget them.

## Sub-features

- `account-sign-in` runs OAuth and lands on the thread.
- `account-sign-out` ends every session at once.
- `account-forget` deletes the user's data after a confirm dialog.

## How to get to it (user POV)

- Choose `continue with put.io` on the landing page.
- Choose `sign out` or `forget me` in the account menu (`account: altay`).

## Driving it with verify.ts

Preconditions:

- `$V up` passed and the browser is on `$U/`, signed out.

- **Sign in.** Run `$V pw click "getByRole('link', { name: 'continue with put.io' })"`. The page returns to `/` with the heading `hi altay.`; `$V log` shows `authorize client_id=fake-client` and `access_token code=fake-code → 200`.
- **Sign out.** Open the account menu, then run `$V pw click "getByRole('button', { name: 'sign out' })"`. The landing page shows `continue with put.io` again; `$V pw eval "() => fetch('/api/me').then(r => r.json())"` prints `"signedIn": false`.
- **Forget me.** Sign in again, open the menu and run `$V pw click "getByRole('button', { name: 'forget me' })"`. An `alertdialog` asks `make puterminator forget you?`. Run `$V pw click "getByRole('alertdialog').getByRole('button', { name: 'forget me' })"`. The landing page returns, and `$V db "SELECT 1"` fails with `no signed-in user Durable Object yet`.
- **Proof.** Screenshot each end state and save the `$V log` lines.

## Gotchas

- Check `/api/me` from the browser (`$V pw eval`). `curl` carries no session cookie and always prints `signedIn: false`.
- `forget me` answers `busy` while a turn runs. Wait for `send` first.
- Sign-out bumps `session_gen`, so another tab signed in as the same user is signed out too.
