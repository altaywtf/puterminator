# Puterminator

A conversational agent for your put.io library: it reads the tree, scores naming, structure, junk and duplicates, and answers questions. This version is read-only.

- Worker + one [Agents SDK](https://developers.cloudflare.com/agents/) Durable Object per put.io user: chat history, file snapshot, put.io token, monthly token usage ([`src/server/agent.ts`](src/server/agent.ts)).
- Scoring is deterministic ([`src/server/audit.ts`](src/server/audit.ts)); the model reads the results and explains them.
- UI: React + shadcn [AI Elements](https://ai-sdk.dev/elements), restyled to [`design/thread-reference.html`](design/thread-reference.html).

## Develop

```bash
pnpm install
cp .dev.vars.example .dev.vars   # fill in the values
pnpm dev
```

Register a put.io OAuth app at <https://app.put.io/oauth> with callback `<PUBLIC_URL>/auth/callback`.

## Check and deploy

```bash
pnpm typecheck && pnpm test
pnpm run deploy
```

Secrets (`wrangler secret put`): `ANTHROPIC_API_KEY`, `PUTIO_CLIENT_ID`, `PUTIO_CLIENT_SECRET`, `SESSION_SECRET`. The monthly cap is `MONTHLY_TOKEN_CAP` in [`wrangler.jsonc`](wrangler.jsonc); one credit is 1,000 tokens.
