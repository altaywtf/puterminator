# Architecture

puterminator is a chat agent for one person's put.io library: a Cloudflare Worker routes each signed-in user to their own Durable Object, which runs the Claude tool loop against put.io and streams the conversation to the browser.

## Request flow

```mermaid
flowchart LR
  B[Browser] -- "/, /assets/*, /privacy" --> A[Static assets: dist/]
  B -- "/auth/*, /api/*" --> W[Worker: routes.ts]
  B -- "/agent WebSocket" --> W
  W -- "getByName(putio-uid)" --> D[Durable Object Puterminator: agent.ts + conversation.ts]
  W -- OAuth code exchange --> P[put.io API]
  D -- "@putdotio/sdk" --> P
  D -- "Tool Runner (runner.ts)" --> C[Anthropic API]
  D -- "poolReport(month, total)" --> L[Durable Object Puterminator named pool]
  D --- S[(SQLite in the Durable Object: store.ts)]
```

- Assets answer first. Only `WORKER_ROUTES` in [`contract.ts`](../src/shared/contract.ts) reach the Worker, and unknown paths fall back to the SPA.
- Every authenticated route checks the signed session cookie and its `session_gen` against the user's Durable Object, so sign-out ends every session at once.
- The browser and the Durable Object exchange `ClientEvent` and `ServerEvent` JSON frames ([`contract.ts`](../src/shared/contract.ts)). Both sides decode with Effect Schema and drop frames that fail.

## Credits

Each user gets `MONTHLY_CREDITS` a month, and everyone shares `POOL_BUDGET_CREDITS` ([`config.ts`](../src/server/config.ts)); 1 credit is 1 cent of model cost.

- Before each Anthropic request, a user's Durable Object sends its month total to the `pool` instance and gets everyone's total back. The pool keeps the largest total each instance reports, so retries never double count, and it never reads lower than the month's console spend CI passes in at deploy.
- [`credits.ts`](../src/server/credits.ts) decides: under the pace line, run; past it, paused until the line catches up; past the budget or the user's own cap, out until the 1st.
- If the pool doesn't answer, new work is refused. The Anthropic workspace spend limit is the hard stop.

## A turn

```mermaid
sequenceDiagram
  participant B as Browser
  participant D as Durable Object
  participant C as Anthropic
  participant P as put.io
  B->>D: send {text, folder}
  D->>D: append user message + <context>
  loop until end_turn, ask_user, or credits stop it
    D->>C: messages (append-only history)
    C-->>D: streamed thinking, text, tool_use
    D-->>B: partial frames
    D->>P: tool reads (scan, download links)
    D->>D: tool results; snapshot reads from SQLite
    D-->>B: message frames, cards decode tool results
  end
  D-->>B: state {busy: false}
```

- History rows are Anthropic `BetaMessageParam`s, appended and never edited, so thinking signatures and the cached prompt prefix stay valid.
- Tools see only the snapshot of the folder last scanned. The snapshot records its root folder, and tools refuse to answer from a scan of another folder.
- A browser connecting to a snapshot older than 10 minutes, or of another folder, starts a background rescan. The model sees the scan's age in `<context>` and rescans itself past that.

## Plans

The model can only propose library changes; every trash, rename, move and restore starts from a browser frame. The one write a tool makes is asking put.io for download links.

```mermaid
stateDiagram-v2
  [*] --> proposed: propose_changes
  proposed --> discarded: discard
  proposed --> applying: apply
  applying --> done: steps finish or stop
  done --> applying: retry failed steps
  done --> undoing: undo
  undoing --> undone: steps finish or stop
  undone --> undoing: retry failed steps
```

- A run applies the changes one at a time, in order (a move may also create folders and rename), then rescans. Writes are never retried automatically: a lost response could mean put.io already applied it, so the step is marked "may have happened" and undo reverses it too.
- Trash goes to put.io's trash. With trash off in the account, trash steps fail instead of deleting for good.

## Durable Object storage

```mermaid
flowchart TB
  D[Puterminator, one per put.io user]
  D --- st[cf_agents_state: AgentState JSON]
  D --- se[secrets: put.io token, download token, session_gen, snapshot_root]
  D --- us[usage: weighted tokens per month]
  D -. "instance named pool" .- ps[pool_spend: each instance's month total]
  D --- me[messages and archived_messages: chat history]
  D --- fi[files: library snapshot]
  D --- pl[plans: proposals, runs, undo runs]
```

- The class name, the `putio-<user_id>` instance names, the `pool` instance and the v1 tables carry users' data across deploys.
