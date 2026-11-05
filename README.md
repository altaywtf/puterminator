![puterminator](public/og.png)

# puterminator

Chat with your put.io library and clean it up.

**[Try it at puterminator.com](https://puterminator.com)**. Sign in with put.io. It's free.

## What it does

- **Finds the mess.** Junk files, duplicates, release-name clutter and folders wrapped in folders.
- **Finds your stuff.** Ask in plain words, play videos in the browser, get download links.
- **Translates subtitles.** Ask for a language and it adds a translated `.srt` next to the video.
- **Proposes, never acts.** Renames, moves and trash show up as a plan. Nothing changes until you apply it, and you can undo it.

Everyone gets 300 credits a month from a shared budget.

## Privacy

- It reads file names, sizes, dates and play status, plus your put.io username and avatar.
- Your messages, the file names they need, and any subtitles you ask it to translate go to Anthropic's API.
- Trash goes to put.io's trash. Your files stay where they are until you apply a plan.

The [privacy page](https://puterminator.com/privacy) has the rest.

## Run it yourself

Needs Node 24 and pnpm.

```sh
pnpm install
pnpm dev:fake
```

It runs on <http://localhost:1337>, with put.io and Anthropic faked. No keys needed.

To use real APIs, copy `.env.example` to `.env` and run `pnpm dev`. You need a put.io OAuth app with `<origin>/auth/callback` as its callback URL and an Anthropic API key. To deploy to Cloudflare Workers, set your domain in [`worker.ts`](src/server/worker.ts) and run `pnpm deploy`.

## Contributing

`pnpm verify` is the gate: typecheck, lint, knip, tests and build. [AGENTS.md](AGENTS.md) maps the code. [docs/architecture.md](docs/architecture.md) shows how it fits together.

## License

[MIT](LICENSE)
