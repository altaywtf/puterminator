<p align="center">
  <img src="public/icon-192.png" width="72" alt="" />
</p>

<h1 align="center">puterminator</h1>

<p align="center">
  Chat with your put.io library and clean it up.
  <br />
  <a href="https://puterminator.com"><b>puterminator.com</b></a> · <a href="https://puterminator.com/privacy">privacy</a> · <a href="LICENSE">MIT</a>
</p>

<p align="center">
  <img src=".github/readme/score.png" width="49%" alt="A library scored 55 out of 100" />
  <img src=".github/readme/plan.png" width="49%" alt="A cleanup plan shown as a diff" />
</p>

- Scores a folder for junk, duplicates, release names and wrapper folders.
- Finds files, plays videos and makes download links.
- Translates subtitles.
- Proposes renames, moves and trash as a diff. Nothing changes until you apply it.

## Run it locally

```sh
pnpm install
pnpm dev:fake
```

Opens <http://localhost:1337> with put.io and Anthropic faked. Needs Node 24.

For the real APIs, fill `.env` from `.env.example` and run `pnpm dev`. The put.io OAuth app's callback is `<origin>/auth/callback`.

To deploy on Cloudflare Workers, set your domain in [`worker.ts`](src/server/worker.ts), attach it to the Worker, and run `pnpm deploy`.

## Contributing

Run `pnpm verify` before you push. [AGENTS.md](AGENTS.md) maps the code.
