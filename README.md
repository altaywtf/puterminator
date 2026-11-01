# puterminator

A chat agent for your put.io library: it reads the tree, scores naming, structure, junk and duplicates, answers questions, makes download links, and proposes trash, rename and move changes that you approve as a diff. Live at <https://puterminator.uinaf.dev>.

Built on a Cloudflare Worker with one Durable Object per put.io user ([Alchemy](https://alchemy.run)), [Effect](https://effect.website) 4, [`@putdotio/sdk`](https://github.com/putdotio/putio-sdk-typescript), the Anthropic SDK's Tool Runner and [Foldkit](https://foldkit.dev). How it fits together: [docs/architecture.md](docs/architecture.md). Working on it as an agent: [AGENTS.md](AGENTS.md).

## Develop

```bash
pnpm install
pnpm dev:fake          # http://localhost:1337 with put.io and Anthropic faked on :8788
pnpm lab               # every card in every fixture state on http://localhost:5174/lab.html
pnpm verify            # typecheck, lint, knip, test, build
```

- In the fake, sign-in runs the real OAuth routes. Prompts with "audit", "clean", "junk", "folder", "largest" or "download" call tools; anything else streams a long reply you can stop. `FAKE_UNCONFIGURED=1 pnpm dev:fake` shows the unconfigured state.
- Against the real APIs: `cp .env.example .env`, fill it in, then `pnpm dev`. `pnpm dev:client` adds Vite HMR, proxying the Worker routes to `:1337`.
- The put.io OAuth app is registered at <https://app.put.io/oauth> with the callback `<public URL>/auth/callback`.

## Deploy

A push to `main` deploys: [`ci.yml`](.github/workflows/ci.yml) runs `pnpm verify`, deploys stage `prod` from the GitHub `production` environment, then smokes the live site.

```bash
op run --env-file .env.op -- pnpm run plan     # alchemy plan --stage prod
op run --env-file .env.op -- pnpm run deploy   # manual deploy
```

- Secrets live in 1Password item `uinaf/puterminator`, mapped by [`.env.op`](.env.op). CI reads copies from the `production` environment; after changing a value, copy it over and re-run CI:

  ```bash
  op read op://uinaf/puterminator/<field> | tr -d '\n' | gh secret set <NAME> --env production
  ```

- Every `Config` read in [`config.ts`](src/server/config.ts) becomes a secret binding, and a deploy deletes live secrets that aren't read through `Config`. A missing required key stops the deploy; a short `SESSION_SECRET` leaves the Worker up with sign-in disabled. Rotating `SESSION_SECRET` signs everyone out.
- Alchemy keeps state in memory and re-adopts the live `puterminator` script by its tags on every deploy. Its Cloudflare credentials are the `uinaf-cloudflare-workers-deploy` payload in `uinaf/vault` locally: Workers Scripts Write and Account Settings Read on the account, Workers Routes Write and Zone Read on `uinaf.dev`.
- Rollback is `pnpm run deploy` from an earlier commit. `wrangler rollback` fails on this script.
- Upgrade `effect`, foldkit, alchemy and `@putdotio/sdk` together; [`pnpm-workspace.yaml`](pnpm-workspace.yaml) pins one `effect` for the whole graph.
