import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { describe, expect, it } from "vitest";
import type { MessageParam, ServerEvent } from "../shared/contract";
import { makeAgent } from "./conversation";
import { anthropicLayer } from "./runner";
import { makeStore, month } from "./store";
import { makeFakeAnthropic, type Reply, textTurn, toolUseTurn } from "./testing/fake-anthropic";
import { file, makeFakePutio } from "./testing/fake-putio";
import { memorySql } from "./testing/sqlite";

const library = [
  file(1, 0, "Movies", "FOLDER"),
  file(2, 1, "Heat.1995.1080p.BluRay.x264-GRP.mkv", "VIDEO", 2 ** 30),
  file(3, 1, "RARBG_DO_NOT_MIRROR.exe", "TEXT", 100),
  file(4, 0, "Alien (1979).mkv", "VIDEO", 2 ** 30),
];

const send = (text: string) => JSON.stringify({ type: "send", text, folder: { id: 0, name: "Your Files" } });

const setup = async (
  replies: Array<Reply>,
  opts: { cap?: number; token?: string | null; putioUnauthorized?: boolean; history?: Array<MessageParam> } = {},
) => {
  const sql = memorySql();
  const store = makeStore(sql);
  for (const m of opts.history ?? []) store.append(m);
  const anthropic = makeFakeAnthropic(replies);
  const putio = makeFakePutio({ files: library, pageSize: 2, unauthorized: opts.putioUnauthorized ?? false });
  const events: Array<ServerEvent> = [];
  const turns: Array<Promise<unknown>> = [];
  const agent = await Effect.runPromise(
    makeAgent({
      store,
      model: "claude-sonnet-5-5",
      monthlyTokenCap: opts.cap ?? 1_000_000,
      anthropic: anthropicLayer({ apiKey: Redacted.make("sk-test"), fetch: anthropic.fetch, maxRetries: 0 }),
      putioFetch: putio.fetch,
      broadcast: (e) => events.push(e),
      background: (effect) => turns.push(Effect.runPromiseExit(effect)),
      partialEveryMs: 0,
    }),
  );
  if (opts.token !== null) await Effect.runPromise(agent.setAuth(opts.token ?? "putio-token", "altay"));
  return { sql, store, agent, anthropic, putio, events, settle: () => Promise.all(turns) };
};

describe("a turn", () => {
  it("runs tool_use -> tool result -> end_turn, appends history in order and charges credits", async () => {
    const t = await setup([
      { kind: "sse", events: toolUseTurn({ id: "toolu_1", name: "scan_library", inputJsonChunks: ["{", "}"] }, { input: 120, output: 40 }) },
      { kind: "sse", events: textTurn("Score 40. Junk in /Movies.", { input: 300, output: 12 }) },
    ]);
    await Effect.runPromise(t.agent.receive(send("Audit my library")));
    await t.settle();

    const history = t.store.history();
    expect(history.map((m) => [m.role, typeof m.content === "string" ? "text" : m.content.map((b) => b.type).join("+")])).toEqual([
      ["user", "text+text"],
      ["assistant", "thinking+tool_use"],
      ["user", "tool_result"],
      ["assistant", "text"],
    ]);
    const thinking = history[1]?.content[0];
    expect(typeof thinking === "object" && thinking.signature).toBe("c2lnLTE=");
    const result = history[2]?.content[0];
    expect(typeof result === "object" && result.tool_use_id).toBe("toolu_1");
    const audit = JSON.parse(String(typeof result === "object" && JSON.stringify(result.content).match(/\{.*\}/)?.[0]?.replace(/\\"/g, '"')));
    expect(audit.totals.items).toBe(4);
    expect(audit.junk.count).toBeGreaterThan(0);

    // The second request carries the first exchange verbatim, thinking signature included.
    expect(t.anthropic.requests).toHaveLength(2);
    expect(t.anthropic.requests[1]?.body.messages).toEqual(JSON.parse(JSON.stringify(history.slice(0, 3))));
    const first = t.anthropic.requests[0];
    expect(first?.headers.get("anthropic-beta")).toBe("server-side-fallback-2026-07-01");
    expect(first?.body.tools.map((x: { name: string; strict: boolean }) => [x.name, x.strict])).toEqual([
      ["scan_library", true],
      ["list_folder", true],
      ["search_files", true],
    ]);
    expect(JSON.stringify(first?.body.tools)).not.toMatch(/minimum|maximum/);
    expect(first?.body.messages[0].content[1].text).toMatch(/^<context>Target folder: Your Files \(id 0\)\. No scan yet\./);

    // Credits: (120 + 40*5) + (300 + 12*5) weighted tokens.
    const m = month(Date.now());
    expect(t.store.used(m)).toBe(680);
    expect(t.agent.state().credits).toEqual({ month: m, used: 680, cap: 1_000_000 });

    expect(t.agent.state().busy).toBe(false);
    expect(t.agent.state().lastAudit?.items).toBe(4);
    expect(t.store.snapshot()).toHaveLength(4);
    expect(t.putio.log[0]?.url.searchParams.get("parent_id")).toBe("-1");

    // Every appended message went out in order; partials streamed and were cleared.
    const sent = t.events.flatMap((e) => (e.type === "message" ? [e.message] : []));
    expect(sent).toEqual(history);
    expect(t.events.some((e) => e.type === "partial" && e.content !== null)).toBe(true);
    expect(t.events.at(-1)).toMatchObject({ type: "state", state: { busy: false } });
    expect(t.events.filter((e) => e.type === "state").map((e) => e.type === "state" && e.state.busy)).toContain(true);
  });

  it("stops: the Anthropic stream aborts, busy clears and no error goes out", async () => {
    const t = await setup([{ kind: "hang" }]);
    await Effect.runPromise(t.agent.receive(send("Audit my library")));
    await t.anthropic.hanging;
    expect(t.agent.state().busy).toBe(true);
    await Effect.runPromise(t.agent.receive(JSON.stringify({ type: "stop" })));
    await t.settle();
    expect(t.anthropic.wasAborted()).toBe(true);
    expect(t.agent.state().busy).toBe(false);
    expect(t.events.some((e) => e.type === "error")).toBe(false);
    expect(t.store.history().map((m) => m.role)).toEqual(["user"]);
  });

  it("ends the turn when put.io rejects the token, closing the unanswered tool_use", async () => {
    const t = await setup(
      [{ kind: "sse", events: toolUseTurn({ id: "toolu_9", name: "scan_library", inputJsonChunks: ["{}"] }, { input: 10, output: 2 }) }],
      { putioUnauthorized: true },
    );
    await Effect.runPromise(t.agent.receive(send("Audit my library")));
    await t.settle();
    expect(t.anthropic.requests).toHaveLength(1);
    const history = t.store.history();
    expect(history.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(history[2]?.content).toEqual([
      { type: "tool_result", tool_use_id: "toolu_9", content: "Stopped before this tool finished.", is_error: true },
    ]);
    expect(t.events.filter((e) => e.type === "error")).toEqual([{ type: "error", message: "put.io signed you out. sign in again." }]);
    expect(t.store.token()).toBeNull();
    expect(t.agent.state().busy).toBe(false);
  });

  it("closes a tool_use left unanswered by an earlier activation before the next user message", async () => {
    const t = await setup([{ kind: "sse", events: textTurn("Hi.", { input: 5, output: 1 }) }], {
      history: [
        { role: "user", content: [{ type: "text", text: "Audit my library" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_old", name: "scan_library", input: {} }] },
      ],
    });
    await Effect.runPromise(t.agent.receive(send("hi")));
    await t.settle();
    const sent = t.anthropic.requests[0]?.body.messages as Array<{ role: string; content: Array<{ type: string }> }>;
    expect(sent.map((m) => [m.role, m.content.map((b) => b.type)])).toEqual([
      ["user", ["text"]],
      ["assistant", ["tool_use"]],
      ["user", ["tool_result"]],
      ["user", ["text", "text"]],
    ]);
    expect(sent[2]?.content).toEqual([
      { type: "tool_result", tool_use_id: "toolu_old", content: "Stopped before this tool finished.", is_error: true },
    ]);
  });

  it("answers from the app without calling Claude once the month's credits are spent", async () => {
    const t = await setup([], { cap: 0 });
    await Effect.runPromise(t.agent.receive(send("hi")));
    await t.settle();
    expect(t.anthropic.requests).toHaveLength(0);
    expect(t.store.history().map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("clears a busy flag left by an evicted turn and drops frames that fail to decode", async () => {
    const sql = memorySql();
    const store = makeStore(sql);
    store.saveState({ ...store.loadState(Date.now()), busy: true, username: "altay" });
    const agent = await Effect.runPromise(
      makeAgent({
        store,
        model: "m",
        monthlyTokenCap: 1,
        anthropic: anthropicLayer({ apiKey: Redacted.make("sk-test"), fetch: makeFakeAnthropic([]).fetch }),
        broadcast: () => {},
        background: () => {
          throw new Error("no turn may start");
        },
      }),
    );
    expect(makeStore(sql).loadState(Date.now())).toMatchObject({ busy: false, username: "altay" });
    for (const bad of ["nope", '{"type":"send","text":"","folder":{"id":0,"name":"x"}}', '{"type":"delete"}']) {
      await Effect.runPromise(agent.receive(bad));
    }
    expect(agent.greeting().map((e) => e.type)).toEqual(["state", "history"]);
  });
});
