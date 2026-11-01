import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import { describe, expect, it } from "vitest";
import type { ClientEvent, MessageParam, ServerEvent } from "../shared/contract";
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
  opts: {
    cap?: number;
    token?: string | null;
    putioUnauthorized?: boolean;
    history?: Array<MessageParam>;
    trashEnabled?: boolean;
    failWrites?: Array<number>;
    dropWrites?: Array<number>;
    failRenames?: Array<number>;
    restoreLag?: number;
    files?: typeof library;
    seed?: (store: ReturnType<typeof makeStore>) => void;
    holdFirstListing?: Promise<void>;
  } = {},
) => {
  const sql = memorySql();
  const store = makeStore(sql);

  for (const m of opts.history ?? []) store.append(m);
  opts.seed?.(store);
  const anthropic = makeFakeAnthropic(replies);

  const putio = makeFakePutio({
    files: opts.files ?? library,
    pageSize: 2,
    unauthorized: opts.putioUnauthorized ?? false,
    trashEnabled: opts.trashEnabled ?? true,
    failWrites: opts.failWrites ?? [],
    dropWrites: opts.dropWrites ?? [],
    failRenames: opts.failRenames ?? [],
    restoreLag: opts.restoreLag ?? 0,
    holdFirstListing: opts.holdFirstListing ?? Promise.resolve(),
  });

  const events: Array<ServerEvent> = [];
  const turns: Array<Promise<unknown>> = [];
  let disconnects = 0;

  const agent = await Effect.runPromise(
    makeAgent({
      store,
      model: "claude-sonnet-5-5",
      monthlyTokenCap: opts.cap ?? 1_000_000,
      anthropic: anthropicLayer({ apiKey: Redacted.make("sk-test"), fetch: anthropic.fetch, maxRetries: 0 }),
      putioFetch: putio.fetch,
      broadcast: (e) => events.push(e),
      disconnect: () => disconnects++,
      background: (effect) => turns.push(Effect.runPromiseExit(effect)),
      partialEveryMs: 0,
      restoreRecheckMs: 0,
    }),
  );

  if (opts.token !== null) await Effect.runPromise(agent.setAuth(opts.token ?? "putio-token", "altay", null));

  return { sql, store, agent, anthropic, putio, events, settle: () => Promise.all(turns), disconnects: () => disconnects };
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
    expect(history.map((m) => [m.role, Predicate.isString(m.content) ? "text" : m.content.map((b) => b.type).join("+")])).toEqual([
      ["user", "text+text"],
      ["assistant", "thinking+tool_use"],
      ["user", "tool_result"],
      ["assistant", "text"],
    ]);
    expect(history[1]?.content[0]).toMatchObject({ signature: "c2lnLTE=" });
    const result = history[2]?.content[0];
    expect(result).toMatchObject({ tool_use_id: "toolu_1" });
    const audit = JSON.parse(String(Predicate.isObject(result) && JSON.stringify(result.content).match(/\{.*\}/)?.[0]?.replace(/\\"/g, '"')));
    expect(audit.totals.items).toBe(4);
    expect(audit.junk.count).toBeGreaterThan(0);

    expect(t.anthropic.requests).toHaveLength(2);
    expect(t.anthropic.requests[1]?.body.messages).toEqual(JSON.parse(JSON.stringify(history.slice(0, 3))));
    const first = t.anthropic.requests[0];
    expect(first?.headers.get("anthropic-beta")).toBe("server-side-fallback-2026-07-01");
    expect(first?.body.tools.map((x: { name: string; strict: boolean }) => [x.name, x.strict])).toEqual([
      ["scan_library", true],
      ["list_folder", true],
      ["search_files", true],
      ["propose_changes", true],
      ["make_download_links", true],
      ["ask_user", true],
    ]);
    expect(JSON.stringify(first?.body.tools)).not.toMatch(/minimum|maximum/);
    expect(first?.body.messages[0].content[1].text).toMatch(/^<context>Target folder: Your Files \(id 0\)\. No scan yet\./);

    const m = month(Date.now());
    const weightedTokens = (120 + 40 * 5) + (300 + 12 * 5);
    expect(t.store.used(m)).toBe(weightedTokens);
    expect(t.agent.state().credits).toEqual({ month: m, used: weightedTokens, cap: 1_000_000 });

    expect(t.agent.state().busy).toBe(false);
    expect(t.agent.state().lastAudit?.items).toBe(4);
    expect(t.store.snapshot()).toHaveLength(4);
    const lib = t.events.find((e) => e.type === "library");
    expect(lib?.type === "library" && lib.library.files.length).toBe(4);
    expect(lib?.type === "library" && lib.library.rootId).toBe(0);
    const flags = new Map(lib?.type === "library" ? lib.library.files.map((f) => [f[0], f[4]]) : []);
    expect([flags.get(1), flags.get(2), flags.get(3)]).toEqual([1, 2 | 16, 8]);
    expect(t.agent.greeting().map((e) => e.type)).toEqual(["state", "history", "library"]);
    expect(t.putio.log[0]?.url.searchParams.get("parent_id")).toBe("-1");

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
    const sent: Array<{ role: string; content: Array<{ type: string }> }> = t.anthropic.requests[0]?.body.messages;
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

  it("pays for a stopped turn's streamed tokens", async () => {
    const t = await setup([{ kind: "hang" }]);
    await Effect.runPromise(t.agent.receive(send("Audit my library")));
    await t.anthropic.hanging;
    await new Promise((r) => setTimeout(r, 20));
    await Effect.runPromise(t.agent.receive(JSON.stringify({ type: "stop" })));
    await t.settle();
    expect(t.store.used(month(Date.now()))).toBe(1 + 1 * 5);
    expect(t.agent.state().credits.used).toBe(6);
  });

  it("makes no follow-up request once a turn spends the month's credits", async () => {
    const t = await setup(
      [
        { kind: "sse", events: toolUseTurn({ id: "toolu_1", name: "scan_library", inputJsonChunks: ["{}"] }, { input: 200, output: 5 }) },
        { kind: "sse", events: textTurn("done.", { input: 10, output: 5 }) },
      ],
      { cap: 100 },
    );

    await Effect.runPromise(t.agent.receive(send("Audit my library")));
    await t.settle();
    expect(t.anthropic.requests).toHaveLength(1);
    expect(t.agent.state().busy).toBe(false);
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
        disconnect: () => {},
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

describe("previews", () => {
  it("signs streams with the download token, never the OAuth token, and only for snapshot videos", async () => {
    const t = await setup([
      { kind: "sse", events: toolUseTurn({ id: "toolu_1", name: "scan_library", inputJsonChunks: ["{}"] }, { input: 1, output: 1 }) },
      { kind: "sse", events: textTurn("done", { input: 1, output: 1 }) },
    ]);

    await Effect.runPromise(t.agent.receive(send("Audit my library")));
    await t.settle();

    const hls = await Effect.runPromise(t.agent.stream(4));
    expect(hls).toMatch(/\/v2\/files\/4\/hls\/media\.m3u8\?.*oauth_token=dl-token/);
    expect(hls).not.toContain("putio-token");
    const folderId = 1;
    const unscannedId = 999;
    expect(await Effect.runPromise(t.agent.stream(folderId))).toBeNull();
    expect(await Effect.runPromise(t.agent.stream(unscannedId))).toBeNull();
    expect(await Effect.runPromise(t.agent.thumbnail(4))).toBe("https://img.put.io/s/4.jpg");
    expect(await Effect.runPromise(t.agent.thumbnail(unscannedId))).toBeNull();
  });
});


describe("plans", () => {
  const WRITES = ["/v2/files/delete", "/v2/files/rename", "/v2/files/move", "/v2/files/create-folder", "/v2/trash/restore"];

  const writes = (t: Awaited<ReturnType<typeof setup>>) =>
    t.putio.log.filter((r) => WRITES.includes(r.url.pathname)).map((r) => [r.url.pathname, Object.fromEntries(r.body)]);

  const proposal = JSON.stringify({
    title: "clean up Movies",
    changes: [
      { op: "trash", path: "/Movies/RARBG_DO_NOT_MIRROR.exe", to: null },
      { op: "rename", path: "/Movies/Heat.1995.1080p.BluRay.x264-GRP.mkv", to: "Heat (1995).mkv" },
      { op: "move", path: "/Alien (1979).mkv", to: "/Movies/Alien (1979)/Alien (1979).mkv" },
    ],
  });

  const proposeTurn = (input = proposal): Array<Reply> => [
    { kind: "sse", events: toolUseTurn({ id: "toolu_p", name: "scan_library", inputJsonChunks: ["{}"] }, { input: 10, output: 5 }) },
    { kind: "sse", events: toolUseTurn({ id: "toolu_q", name: "propose_changes", inputJsonChunks: [input] }, { input: 10, output: 5 }) },
    { kind: "sse", events: textTurn("plan's up.", { input: 10, output: 5 }) },
  ];

  const planOf = (t: Awaited<ReturnType<typeof setup>>) => {
    const last = t.events.filter((e) => e.type === "plan").at(-1);

    if (last?.type !== "plan") throw new Error("no plan event");

    return last.record;
  };

  const frame = (event: ClientEvent) => JSON.stringify(event);

  it("stores a proposal and writes nothing until the user applies it", async () => {
    const t = await setup(proposeTurn());
    await Effect.runPromise(t.agent.receive(send("clean up")));
    await t.settle();
    const record = planOf(t);
    expect(record.status).toBe("proposed");
    expect(record.plan.changes.map((c) => [c.op, c.path, c.to])).toEqual([
      ["trash", "/Movies/RARBG_DO_NOT_MIRROR.exe", null],
      ["rename", "/Movies/Heat.1995.1080p.BluRay.x264-GRP.mkv", "Heat (1995).mkv"],
      ["move", "/Alien (1979).mkv", "/Movies/Alien (1979)/Alien (1979).mkv"],
    ]);
    expect(writes(t)).toEqual([]);
  });

  it("applies only what the user kept, in order, creating the missing folder", async () => {
    const t = await setup(proposeTurn());
    await Effect.runPromise(t.agent.receive(send("clean up")));
    await t.settle();
    const { plan } = planOf(t);
    await Effect.runPromise(t.agent.receive(frame({ type: "apply", plan: plan.id, exclude: ["c2"] })));
    await t.settle();
    expect(writes(t)).toEqual([
      ["/v2/files/delete", { file_ids: "3" }],
      ["/v2/files/create-folder", { name: "Alien (1979)", parent_id: "1" }],
      ["/v2/files/move", { file_ids: "4", parent_id: expect.any(String) }],
    ]);
    const record = planOf(t);
    expect(record.status).toBe("done");
    expect(record.run?.steps.map((s) => [s.change, s.state])).toEqual([
      ["c1", "done"],
      ["c3", "done"],
    ]);
  });

  it("refuses to trash when put.io's trash is off, since delete would be permanent", async () => {
    const t = await setup(proposeTurn(), { trashEnabled: false });
    await Effect.runPromise(t.agent.receive(send("clean up")));
    await t.settle();
    await Effect.runPromise(t.agent.receive(frame({ type: "apply", plan: planOf(t).plan.id, exclude: [] })));
    await t.settle();
    expect(writes(t).map(([p]) => p)).not.toContain("/v2/files/delete");
    expect(planOf(t).run?.steps.find((s) => s.change === "c1")).toMatchObject({ state: "failed" });
  });

  it("keeps going past a failed change, and retry runs only the failures", async () => {
    const t = await setup(proposeTurn(), { failWrites: [2] });
    await Effect.runPromise(t.agent.receive(send("clean up")));
    await t.settle();
    const id = planOf(t).plan.id;
    await Effect.runPromise(t.agent.receive(frame({ type: "apply", plan: id, exclude: [] })));
    await t.settle();
    expect(planOf(t).run?.steps.map((s) => s.state)).toEqual(["done", "failed", "done"]);
    const before = writes(t).length;
    await Effect.runPromise(t.agent.receive(frame({ type: "retry", plan: id })));
    await t.settle();
    expect(writes(t).slice(before)).toEqual([["/v2/files/rename", { file_id: "2", name: "Heat (1995).mkv" }]]);
  });

  it("undoes the done steps last first, once: restore from trash, rename and move back", async () => {
    const t = await setup(proposeTurn(), { failWrites: [2] });
    await Effect.runPromise(t.agent.receive(send("clean up")));
    await t.settle();
    const id = planOf(t).plan.id;
    await Effect.runPromise(t.agent.receive(frame({ type: "apply", plan: id, exclude: [] })));
    await t.settle();
    const before = writes(t).length;
    await Effect.runPromise(t.agent.receive(frame({ type: "undo", plan: id })));
    await t.settle();
    await Effect.runPromise(t.agent.receive(frame({ type: "undo", plan: id })));
    await t.settle();
    expect(writes(t).slice(before)).toEqual([
      ["/v2/files/move", { file_ids: "4", parent_id: "0" }],
      ["/v2/trash/restore", { file_ids: "3" }],
    ]);
    const record = planOf(t);
    expect(record.status).toBe("undone");
    expect(record.run?.steps.map((s) => s.state)).toEqual(["done", "failed", "done"]);
  });

  it("rescans until put.io's background restore shows the file again", async () => {
    const trash = JSON.stringify({ title: "junk", changes: [{ op: "trash", path: "/Movies/RARBG_DO_NOT_MIRROR.exe", to: null }] });
    const t = await setup(proposeTurn(trash), { restoreLag: 2 });
    await Effect.runPromise(t.agent.receive(send("trash it")));
    await t.settle();
    const id = planOf(t).plan.id;
    await Effect.runPromise(t.agent.receive(frame({ type: "apply", plan: id, exclude: [] })));
    await t.settle();
    const before = t.putio.log.length;
    await Effect.runPromise(t.agent.receive(frame({ type: "undo", plan: id })));
    await t.settle();
    expect(t.putio.log.slice(before).filter((r) => r.url.pathname === "/v2/files/list")).toHaveLength(3);
    expect(t.store.snapshot().some((f) => f.id === 3)).toBe(true);
  });

  it("takes a renamed or moved video's subtitles along, and nothing else", async () => {
    const t = await setup(
      proposeTurn(
        JSON.stringify({
          title: "names",
          changes: [
            { op: "rename", path: "/Movies/Heat.1995.1080p.BluRay.x264-GRP.mkv", to: "Heat (1995).mkv" },
            { op: "move", path: "/Alien (1979).mkv", to: "/Movies/Alien (1979).mkv" },
          ],
        }),
      ),
      {
        files: [
          ...library,
          file(5, 1, "Heat.1995.1080p.BluRay.x264-GRP.eng.srt", "TEXT", 100),
          file(6, 1, "Heat.1995.1080p.BluRay.x264-GRP-forced.en.ass", "TEXT", 100),
          file(7, 1, "Heat.1995.1080p.BluRay.x264-GRP.nfo", "TEXT", 100),
          file(8, 0, "Alien (1979).srt", "TEXT", 100),
        ],
      },
    );

    await Effect.runPromise(t.agent.receive(send("rename")));
    await t.settle();
    expect(planOf(t).plan.changes.map((c) => [c.op, c.path, c.to])).toEqual([
      ["rename", "/Movies/Heat.1995.1080p.BluRay.x264-GRP.mkv", "Heat (1995).mkv"],
      ["rename", "/Movies/Heat.1995.1080p.BluRay.x264-GRP.eng.srt", "Heat (1995).eng.srt"],
      ["rename", "/Movies/Heat.1995.1080p.BluRay.x264-GRP-forced.en.ass", "Heat (1995)-forced.en.ass"],
      ["move", "/Alien (1979).mkv", "/Movies/Alien (1979).mkv"],
      ["move", "/Alien (1979).srt", "/Movies/Alien (1979).srt"],
    ]);
  });

  it("undoes a rename back to the old name", async () => {
    const rename = JSON.stringify({ title: "names", changes: [{ op: "rename", path: "/Movies/Heat.1995.1080p.BluRay.x264-GRP.mkv", to: "Heat (1995).mkv" }] });
    const t = await setup(proposeTurn(rename));
    await Effect.runPromise(t.agent.receive(send("rename")));
    await t.settle();
    const id = planOf(t).plan.id;
    await Effect.runPromise(t.agent.receive(frame({ type: "apply", plan: id, exclude: [] })));
    await t.settle();
    await Effect.runPromise(t.agent.receive(frame({ type: "undo", plan: id })));
    await t.settle();
    expect(writes(t)).toEqual([
      ["/v2/files/rename", { file_id: "2", name: "Heat (1995).mkv" }],
      ["/v2/files/rename", { file_id: "2", name: "Heat.1995.1080p.BluRay.x264-GRP.mkv" }],
    ]);
  });

  const applied = async (input: string, opts: Parameters<typeof setup>[1] = {}) => {
    const t = await setup(proposeTurn(input), opts);
    await Effect.runPromise(t.agent.receive(send("go")));
    await t.settle();
    const id = planOf(t).plan.id;
    await Effect.runPromise(t.agent.receive(frame({ type: "apply", plan: id, exclude: [] })));
    await t.settle();

    return { t, id };
  };

  it("moves into a folder the same plan renamed, without making a second one", async () => {
    const { t } = await applied(
      JSON.stringify({
        title: "films",
        changes: [
          { op: "rename", path: "/Movies", to: "Films" },
          { op: "move", path: "/Alien (1979).mkv", to: "/Films/Alien (1979).mkv" },
        ],
      }),
    );

    expect(writes(t)).toEqual([
      ["/v2/files/rename", { file_id: "1", name: "Films" }],
      ["/v2/files/move", { file_ids: "4", parent_id: "1" }],
    ]);
  });

  it("undoes into the folders files came from, even after those folders moved", async () => {
    const { t, id } = await applied(
      JSON.stringify({
        title: "archive",
        changes: [
          { op: "move", path: "/Movies", to: "/Old/Movies" },
          { op: "move", path: "/Movies/Heat.1995.1080p.BluRay.x264-GRP.mkv", to: "/Heat.mkv" },
        ],
      }),
    );

    const before = writes(t).length;
    await Effect.runPromise(t.agent.receive(frame({ type: "undo", plan: id })));
    await t.settle();
    expect(writes(t).slice(before)).toEqual([
      ["/v2/files/move", { file_ids: "2", parent_id: "1" }],
      ["/v2/files/rename", { file_id: "2", name: "Heat.1995.1080p.BluRay.x264-GRP.mkv" }],
      ["/v2/files/move", { file_ids: "1", parent_id: "0" }],
    ]);
  });

  it("undoes a write whose answer was lost, since put.io may have done it", async () => {
    const { t, id } = await applied(proposal, { dropWrites: [3] });
    expect(planOf(t).run?.steps[0]).toMatchObject({ change: "c1", state: "failed", maybeApplied: true });
    await Effect.runPromise(t.agent.receive(frame({ type: "undo", plan: id })));
    await t.settle();
    expect(writes(t).at(-1)).toEqual(["/v2/trash/restore", { file_ids: "3" }]);
  });

  it("fails a run when the put.io sign-in is gone, instead of leaving it applying", async () => {
    const t = await setup(proposeTurn());
    await Effect.runPromise(t.agent.receive(send("go")));
    await t.settle();
    t.store.deleteToken();
    await Effect.runPromise(t.agent.receive(frame({ type: "apply", plan: planOf(t).plan.id, exclude: [] })));
    await t.settle();
    expect(writes(t)).toEqual([]);
    expect(planOf(t).status).toBe("done");
    expect(planOf(t).run?.steps.map((s) => s.error)).toEqual(Array(3).fill("put.io signed you out; sign in again"));
  });

  it("refuses to apply a plan in another target folder than the one it was made in", async () => {
    const t = await setup([...proposeTurn(), { kind: "sse", events: textTurn("ok.", { input: 10, output: 5 }) }]);
    await Effect.runPromise(t.agent.receive(send("go")));
    await t.settle();
    await Effect.runPromise(t.agent.receive(JSON.stringify({ type: "send", text: "now Movies", folder: { id: 1, name: "Movies" } })));
    await t.settle();
    await Effect.runPromise(t.agent.receive(frame({ type: "apply", plan: planOf(t).plan.id, exclude: [] })));
    await t.settle();
    expect(writes(t)).toEqual([]);
    expect(planOf(t).run?.steps.every((s) => s.state === "failed" && s.error === "made in Your Files; switch back to it first")).toBe(true);
  });

  it("rejects a proposal against a scan of another folder", async () => {
    const t = await setup([
      ...proposeTurn(),
      { kind: "sse", events: toolUseTurn({ id: "toolu_r", name: "propose_changes", inputJsonChunks: [proposal] }, { input: 10, output: 5 }) },
      { kind: "sse", events: textTurn("rescanning.", { input: 10, output: 5 }) },
    ]);

    await Effect.runPromise(t.agent.receive(send("go")));
    await t.settle();
    await Effect.runPromise(t.agent.receive(JSON.stringify({ type: "send", text: "same in Movies", folder: { id: 1, name: "Movies" } })));
    await t.settle();
    expect(t.events.filter((e) => e.type === "plan")).toHaveLength(1);
    expect(JSON.stringify(t.store.history().at(-2))).toContain("The last scan is of another folder");
  });

  it("follows folders the plan already renamed when a later change names their old path", async () => {
    const { t } = await applied(
      JSON.stringify({
        title: "nested",
        changes: [
          { op: "rename", path: "/A", to: "B" },
          { op: "rename", path: "/A/C", to: "D" },
          { op: "move", path: "/x.txt", to: "/B/C/x.txt" },
        ],
      }),
      { files: [file(10, 0, "A", "FOLDER"), file(11, 10, "C", "FOLDER"), file(12, 0, "x.txt", "TEXT", 10)] },
    );

    const created = writes(t).find(([p]) => p === "/v2/files/create-folder");
    expect(created?.[1]).toEqual({ name: "C", parent_id: "10" });
    expect(writes(t).filter(([p]) => p === "/v2/files/move")).not.toContainEqual(["/v2/files/move", { file_ids: "12", parent_id: "11" }]);
  });

  it("knows where a moved folder is when its rename fails", async () => {
    const { t } = await applied(
      JSON.stringify({
        title: "partial",
        changes: [
          { op: "move", path: "/A", to: "/B/C" },
          { op: "move", path: "/x.txt", to: "/A/x.txt" },
        ],
      }),
      { files: [file(10, 0, "A", "FOLDER"), file(13, 0, "B", "FOLDER"), file(12, 0, "x.txt", "TEXT", 10)], failRenames: [10] },
    );

    expect(planOf(t).run?.steps.map((s) => s.state)).toEqual(["failed", "done"]);
    expect(writes(t).find(([p]) => p === "/v2/files/create-folder")?.[1]).toEqual({ name: "A", parent_id: "0" });
  });

  it("rejects a plan whose subtitles would land on one path", async () => {
    const files = [file(20, 0, "A.mkv", "VIDEO", 2 ** 30), file(21, 0, "A.srt", "TEXT", 10), file(22, 0, "B.mp4", "VIDEO", 2 ** 30), file(23, 0, "B.srt", "TEXT", 10)];

    const bad = JSON.stringify({
      title: "x",
      changes: [
        { op: "rename", path: "/A.mkv", to: "X.mkv" },
        { op: "rename", path: "/B.mp4", to: "X.mp4" },
      ],
    });

    const t = await setup(proposeTurn(bad), { files });
    await Effect.runPromise(t.agent.receive(send("go")));
    await t.settle();
    expect(t.events.filter((e) => e.type === "plan")).toHaveLength(0);
    expect(JSON.stringify(t.store.history())).toContain("/X.srt: two changes end there");
  });

  it("still undoes a lost-answer write after a retry put.io refuses", async () => {
    const { t, id } = await applied(proposal, { dropWrites: [3] });
    await Effect.runPromise(t.agent.receive(frame({ type: "retry", plan: id })));
    await t.settle();
    expect(planOf(t).run?.steps[0]).toMatchObject({ state: "failed", maybeApplied: true });
    await Effect.runPromise(t.agent.receive(frame({ type: "undo", plan: id })));
    await t.settle();
    expect(writes(t).at(-1)).toEqual(["/v2/trash/restore", { file_ids: "3" }]);
  });

  it("rejects a proposal naming files outside the snapshot, and stores nothing", async () => {
    const bad = JSON.stringify({ title: "x", changes: [{ op: "trash", path: "/nope.txt", to: null }] });
    const t = await setup(proposeTurn(bad));
    await Effect.runPromise(t.agent.receive(send("clean up")));
    await t.settle();
    expect(t.events.some((e) => e.type === "plan")).toBe(false);
    const result = t.store.history().flatMap((m) => (Predicate.isString(m.content) ? [] : m.content)).find((b) => b.type === "tool_result" && b.tool_use_id === "toolu_q");
    expect(String(result?.content)).toContain("not in the snapshot");
  });

  const rejection = async (changes: Array<{ op: string; path: string; to: string | null }>) => {
    const t = await setup(proposeTurn(JSON.stringify({ title: "x", changes })));
    await Effect.runPromise(t.agent.receive(send("go")));
    await t.settle();
    expect(t.events.some((e) => e.type === "plan")).toBe(false);
    const result = t.store.history().flatMap((m) => (Predicate.isString(m.content) ? [] : m.content)).find((b) => b.type === "tool_result" && b.tool_use_id === "toolu_q");

    return String(result?.content);
  };

  it("rejects changes that collide: into or inside a trashed folder, onto one path, onto an existing name", async () => {
    expect(await rejection([{ op: "trash", path: "/Movies", to: null }, { op: "move", path: "/Alien (1979).mkv", to: "/Movies/Alien (1979).mkv" }])).toContain(
      "lands in /Movies, which this plan trashes",
    );
    expect(await rejection([{ op: "trash", path: "/Movies", to: null }, { op: "trash", path: "/Movies/RARBG_DO_NOT_MIRROR.exe", to: null }])).toContain(
      "inside /Movies, which this plan trashes",
    );
    expect(
      await rejection([
        { op: "move", path: "/Alien (1979).mkv", to: "/Movies/x.mkv" },
        { op: "move", path: "/Movies/Heat.1995.1080p.BluRay.x264-GRP.mkv", to: "/Movies/x.mkv" },
      ]),
    ).toContain("two changes end there");
    expect(await rejection([{ op: "rename", path: "/Movies/Heat.1995.1080p.BluRay.x264-GRP.mkv", to: "RARBG_DO_NOT_MIRROR.exe" }])).toContain("already exists there");
  });

  it("leaves another cut's subtitles alone, and keeps subtitles with their video when it's left out", async () => {
    const t = await setup(
      proposeTurn(JSON.stringify({ title: "names", changes: [{ op: "rename", path: "/Movies/Heat.mkv", to: "Heat (1995).mkv" }] })),
      {
        files: [
          file(1, 0, "Movies", "FOLDER"),
          file(2, 1, "Heat.mkv", "VIDEO", 2 ** 30),
          file(3, 1, "Heat.Extended.mkv", "VIDEO", 2 ** 30),
          file(4, 1, "Heat.Extended.srt", "TEXT", 100),
          file(5, 1, "Heat.en.srt", "TEXT", 100),
        ],
      },
    );

    await Effect.runPromise(t.agent.receive(send("rename")));
    await t.settle();
    const { plan } = planOf(t);
    expect(plan.changes.map((c) => [c.id, c.path])).toEqual([
      ["c1", "/Movies/Heat.mkv"],
      ["c1s1", "/Movies/Heat.en.srt"],
    ]);
    await Effect.runPromise(t.agent.receive(frame({ type: "apply", plan: plan.id, exclude: ["c1"] })));
    await t.settle();
    expect(writes(t)).toEqual([]);
  });

  it("rescans after a stopped run", async () => {
    const t = await setup(proposeTurn(), { restoreLag: 0 });
    await Effect.runPromise(t.agent.receive(send("go")));
    await t.settle();
    const id = planOf(t).plan.id;
    const lists = () => t.putio.log.filter((r) => r.url.pathname === "/v2/files/list").length;
    const before = lists();
    await Effect.runPromise(t.agent.receive(frame({ type: "apply", plan: id, exclude: [] })));
    await Effect.runPromise(t.agent.receive(frame({ type: "stopRun", plan: id })));
    await t.settle();
    expect(planOf(t).status).toBe("done");
    expect(lists()).toBeGreaterThan(before);
  });

  it("tells the model in the next context what happened to the plan", async () => {
    const t = await setup([...proposeTurn(), { kind: "sse", events: textTurn("done.", { input: 10, output: 5 }) }]);
    await Effect.runPromise(t.agent.receive(send("clean up")));
    await t.settle();
    await Effect.runPromise(t.agent.receive(frame({ type: "apply", plan: planOf(t).plan.id, exclude: ["c3"] })));
    await t.settle();
    await Effect.runPromise(t.agent.receive(send("thanks")));
    await t.settle();
    const lastUser = t.store.history().filter((m) => m.role === "user").at(-1);
    const context = JSON.stringify(lastUser?.content);
    expect(context).toContain('applied plan \\"clean up Movies\\": 2 done, 0 failed');
  });

  it("ends the turn once a question is asked, and takes the answer next", async () => {
    const ask = JSON.stringify({ prompt: "which copy?", multi: false, options: [{ label: "a", detail: null }, { label: "b", detail: null }] });

    const t = await setup([
      { kind: "sse", events: toolUseTurn({ id: "toolu_a1", name: "ask_user", inputJsonChunks: [ask] }, { input: 10, output: 5 }) },
      { kind: "sse", events: textTurn("keeping a.", { input: 10, output: 5 }) },
    ]);

    await Effect.runPromise(t.agent.receive(send("which one?")));
    await t.settle();
    expect(t.anthropic.requests).toHaveLength(1);
    expect(t.agent.state().busy).toBe(false);
    const results = t.store.history().flatMap((m) => (Predicate.isString(m.content) ? [] : m.content)).filter((b) => b.type === "tool_result");
    expect(String(results[0]?.content)).toContain('"prompt":"which copy?"');
    await Effect.runPromise(t.agent.receive(send("a")));
    await t.settle();
    expect(t.anthropic.requests).toHaveLength(2);
    expect(t.store.history().at(-1)).toMatchObject({ role: "assistant" });
  });

  it("ignores apply for a discarded plan or an unknown id", async () => {
    const t = await setup(proposeTurn());
    await Effect.runPromise(t.agent.receive(send("clean up")));
    await t.settle();
    const id = planOf(t).plan.id;
    await Effect.runPromise(t.agent.receive(frame({ type: "discard", plan: id })));
    await Effect.runPromise(t.agent.receive(frame({ type: "apply", plan: id, exclude: [] })));
    await Effect.runPromise(t.agent.receive(frame({ type: "apply", plan: "made-up", exclude: [] })));
    await t.settle();
    expect(planOf(t).status).toBe("discarded");
    expect(writes(t)).toEqual([]);
  });
});

describe("library freshness", () => {
  const scanned = (at: string, root = 0) => (store: ReturnType<typeof makeStore>) => {
    store.saveSnapshot([{ id: 4, parent_id: 0, name: "Alien (1979).mkv", path: "/Alien (1979).mkv", depth: 1, size: 1, file_type: "VIDEO", extension: "mkv", crc32: null, created_at: "2026-01-01T00:00:00", first_accessed_at: null }], root);
    store.saveState({ ...store.loadState(Date.now()), lastAudit: { at, rootName: "Your Files", score: 90, items: 1 } });
  };

  const listings = (t: Awaited<ReturnType<typeof setup>>) => t.putio.log.filter((r) => r.url.pathname === "/v2/files/list").length;

  it("rescans in the background when a browser connects to a stale or foreign snapshot, and not when it's fresh", async () => {
    const stale = await setup([], { seed: scanned("2026-01-01T00:00:00.000Z") });
    stale.agent.connected();
    await stale.settle();
    expect(listings(stale)).toBe(1);
    expect(stale.agent.state().lastAudit?.items).toBe(4);

    const foreign = await setup([], { seed: scanned(new Date().toISOString(), 1) });
    foreign.agent.connected();
    await foreign.settle();
    expect(listings(foreign)).toBe(1);

    const fresh = await setup([], { seed: scanned(new Date().toISOString()) });
    fresh.agent.connected();
    await fresh.settle();
    expect(listings(fresh)).toBe(0);
  });

  it("never lets a slow background refresh overwrite a newer scan of another folder", async () => {
    let release = () => {};
    const slow = new Promise<void>((resolve) => (release = resolve));

    const t = await setup(
      [
        { kind: "sse", events: toolUseTurn({ id: "toolu_m", name: "scan_library", inputJsonChunks: ["{}"] }, { input: 10, output: 5 }) },
        { kind: "sse", events: textTurn("scanned.", { input: 10, output: 5 }) },
      ],
      { seed: scanned("2026-01-01T00:00:00.000Z"), holdFirstListing: slow },
    );

    t.agent.connected();
    await Effect.runPromise(t.agent.receive(JSON.stringify({ type: "send", text: "scan movies", folder: { id: 1, name: "Movies" } })));

    for (let i = 0; i < 100 && t.agent.state().lastAudit?.rootName !== "Movies"; i++) await new Promise((r) => setTimeout(r, 10));
    release();
    await t.settle();
    expect(t.store.secret("snapshot_root")).toBe("1");
    expect(t.agent.state().lastAudit?.rootName).toBe("Movies");
  });

  it("tells the model how old the last scan is", async () => {
    const t = await setup([{ kind: "sse", events: textTurn("ok.", { input: 10, output: 5 }) }], { seed: scanned(new Date(Date.now() - 42 * 60_000).toISOString()) });
    await Effect.runPromise(t.agent.receive(send("hi")));
    await t.settle();
    expect(JSON.stringify(t.anthropic.requests[0]?.body.messages.at(-1))).toContain("Last scan: 42 minutes ago, 1 items");
  });
});

describe("download links", () => {
  it("has put.io make them, gives the model only the job, and hands the links to the browser", async () => {
    const t = await setup([
      { kind: "sse", events: toolUseTurn({ id: "toolu_s", name: "scan_library", inputJsonChunks: ["{}"] }, { input: 10, output: 5 }) },
      { kind: "sse", events: toolUseTurn({ id: "toolu_l", name: "make_download_links", inputJsonChunks: [JSON.stringify({ paths: ["/Movies", "/Alien (1979).mkv"] })] }, { input: 10, output: 5 }) },
      { kind: "sse", events: textTurn("links are in the card.", { input: 10, output: 5 }) },
    ]);

    await Effect.runPromise(t.agent.receive(send("download links please")));
    await t.settle();
    const out = t.store.history().flatMap((m) => (Predicate.isString(m.content) ? [] : m.content)).find((b) => b.type === "tool_result" && b.tool_use_id === "toolu_l");
    expect(JSON.parse(String(out?.type === "tool_result" && out.content))).toEqual({ id: 70, files: 3 });
    expect(JSON.stringify(t.anthropic.requests)).not.toContain("dl.put.io");
    expect(await Effect.runPromise(t.agent.downloadLinks(70))).toEqual({
      status: "done",
      links: [
        "https://dl.put.io/files/2/Heat.1995.1080p.BluRay.x264-GRP.mkv",
        "https://dl.put.io/files/3/RARBG_DO_NOT_MIRROR.exe",
        "https://dl.put.io/files/4/Alien%20(1979).mkv",
      ],
    });
  });
});

describe("sign out", () => {
  it("closes every open socket", async () => {
    const t = await setup([]);
    await Effect.runPromise(t.agent.signOut);
    expect(t.disconnects()).toBe(1);
  });
});

describe("threads", () => {
  it("archives the conversation on new thread; the next turn starts empty", async () => {
    const t = await setup([
      { kind: "sse", events: textTurn("hi.", { input: 10, output: 5 }) },
      { kind: "sse", events: textTurn("fresh.", { input: 10, output: 5 }) },
    ]);

    await Effect.runPromise(t.agent.receive(send("hello")));
    await t.settle();
    await Effect.runPromise(t.agent.receive(JSON.stringify({ type: "newThread" })));
    expect(t.events.at(-1)).toEqual({ type: "history", messages: [] });
    expect(t.store.history()).toEqual([]);
    await Effect.runPromise(t.agent.receive(send("again")));
    await t.settle();
    expect(t.store.history().map((m) => m.role)).toEqual(["user", "assistant"]);
  });
});

describe("repeated calls", () => {
  it("answers an identical read call in the same turn with a pointer, not a second result", async () => {
    const search = JSON.stringify({ query: "heat", category: "any", limit: 10 });

    const t = await setup([
      { kind: "sse", events: toolUseTurn({ id: "toolu_s0", name: "scan_library", inputJsonChunks: ["{}"] }, { input: 10, output: 5 }) },
      { kind: "sse", events: toolUseTurn({ id: "toolu_s1", name: "search_files", inputJsonChunks: [search] }, { input: 10, output: 5 }) },
      { kind: "sse", events: toolUseTurn({ id: "toolu_s2", name: "search_files", inputJsonChunks: [search] }, { input: 10, output: 5 }) },
      { kind: "sse", events: textTurn("found it.", { input: 10, output: 5 }) },
    ]);

    await Effect.runPromise(t.agent.receive(send("find heat")));
    await t.settle();
    const results = t.store.history().flatMap((m) => (Predicate.isString(m.content) ? [] : m.content)).filter((b) => b.type === "tool_result");
    expect(String(results[1]?.content)).toContain('"total":1');
    expect(String(results[2]?.content)).toContain("already made this exact call");
  });
});
