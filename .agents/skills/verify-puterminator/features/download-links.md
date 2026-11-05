# Download links

The agent asks put.io for direct download links (the one write a tool makes) and shows them in a card the user expands and copies.

## Sub-features

- `links-request` starts a put.io link job from the `make_download_links` tool.
- `links-show` expands the card into one link per file.
- `links-copy` copies every link at once.

## How to get to it (user POV)

- Choose the `download links for my biggest files` suggestion on an empty thread.
- Type a message containing `download` or `link` and send it.

## Driving it with verify.sh

Preconditions:

- Baseline, with no reply streaming.

- **Ask.** Send `download links for my biggest files`. Wait for `getByRole('region', { name: 'download links' })`. The card reads `3 files` and has a `show links` button.
- **Check the job.** Run `$V writes`. It prints `POST /v2/download_links/create file_ids=1128,1028,1026`.
- **Show links.** Run `$V pw click "getByRole('region', { name: 'download links' }).getByRole('button', { name: 'show links' })"`, then wait for `getByRole('link', { name: 'Heat.1995.2160p.WEB-DL.mkv' })`. Three links point at `https://dl.example.put.io/files/<id>/<name>`, and a `copy all links` button appears.
- **Proof.** Snapshot the `download links` region before and after `show links`, and save the `$V writes` line.

## Gotchas

- The fake's link job reports `PROCESSING` for 1.2 s before `DONE`. Wait on the link, not a sleep.
- Assert links by accessible name: the URL lives in `href`, and text locators on the region miss it.
- After another reply, `send` is `stop reply` until it finishes; wait for `send` first.
