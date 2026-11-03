import type { ProposeInput } from "./changes";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import { describe, expect, it } from "vitest";
import { type ClientEvent, CREDIT_TOKENS, FileFlag, type MessageParam, type ServerEvent } from "../shared/contract";
import { type AgentDeps, makeAgent } from "./conversation";
import { anthropicLayer } from "./runner";
import { makeStore, month } from "./store";
import { makeFakeAnthropic, type Reply, textTurn, toolUseTurn } from "./testing/fake-anthropic";
import { type FakePutioOptions, file, makeFakePutio } from "./testing/fake-putio";
import { memorySql } from "./testing/sqlite";

const library = [
  file(1, 0, "Movies", "FOLDER"),
  file(2, 1, "Heat.1995.1080p.BluRay.x264-GRP.mkv", "VIDEO", 2 ** 30),
  file(3, 1, "RARBG_DO_NOT_MIRROR.exe", "TEXT", 100),
  file(4, 0, "Alien (1979).mkv", "VIDEO", 2 ** 30),
];

const frame = (event: ClientEvent) => JSON.stringify(event);
const send = (text: string) => frame({ type: "send", text, folder: { id: 0, name: "Your Files" } });

type SetupOptions = Partial<Omit<FakePutioOptions, "pageSize">> & {
  cap?: number;
  budget?: number;
  pool?: AgentDeps["pool"];
  unlimited?: ReadonlyArray<string>;
  history?: Array<MessageParam>;
  seed?: (store: ReturnType<typeof makeStore>) => void;
};

const setup = async (replies: Array<Reply>, opts: SetupOptions = {}) => {
  const { cap, budget, pool, unlimited, history, seed, files, ...putioOptions } = opts;
  const sql = memorySql();
  const store = makeStore(sql);
  const poolStore = makeStore(memorySql());

  for (const m of history ?? []) store.append(m);
  seed?.(store);
  const anthropic = makeFakeAnthropic(replies);
  const putio = makeFakePutio({ files: files ?? library, pageSize: 2, ...putioOptions });
  const events: Array<ServerEvent> = [];
  const turns: Array<Promise<unknown>> = [];
  let disconnects = 0;

  const agent = await Effect.runPromise(
    makeAgent({
      store,
      model: "claude-sonnet-5-5",
      monthlyCredits: (cap ?? 1_000_000) / CREDIT_TOKENS,
      poolBudgetCredits: budget ?? 1_000_000,
      pool: pool ?? ((m, tokens) => Effect.sync(() => poolStore.poolReport(m, "putio-1", tokens))),
      unlimitedUsers: unlimited ?? [],
      anthropic: anthropicLayer({ apiKey: Redacted.make("sk-test"), fetch: anthropic.fetch, maxRetries: 0 }),
      putioFetch: putio.fetch,
      broadcast: (e) => events.push(e),
      disconnect: () => disconnects++,
      background: (effect) => turns.push(Effect.runPromiseExit(effect)),
      partialEveryMs: 0,
      restoreRecheckMs: 0,
    }),
  );

  await Effect.runPromise(agent.setAuth("putio-token", "altay", null));
  const settle = () => Promise.all(turns);

  const receive = async (event: string | ClientEvent) => {
    await Effect.runPromise(agent.receive(Predicate.isString(event) ? event : frame(event)));
    await settle();
  };

  const toolOutput = (id: string) => {
    const result = store
      .history()
      .flatMap((m) => (Predicate.isString(m.content) ? [] : m.content))
      .find((b) => b.type === "tool_result" && b.tool_use_id === id);

    return result?.type === "tool_result" ? String(result.content) : "";
  };

  return { sql, store, agent, anthropic, putio, events, settle, receive, toolOutput, disconnects: () => disconnects };
};

const tool = (id: string, name: string, input = "{}", usage = { input: 10, output: 5 }): Reply => ({ kind: "sse", events: toolUseTurn({ id, name, inputJsonChunks: [input] }, usage) });
const say = (text: string, usage = { input: 10, output: 5 }): Reply => ({ kind: "sse", events: textTurn(text, usage) });

describe("a turn", () => {
  it("runs a tool call to end_turn: history in order, strict tools, weighted credits, the library frame", async () => {
    const t = await setup([
      { kind: "sse", events: toolUseTurn({ id: "toolu_1", name: "scan_library", inputJsonChunks: ["{", "}"] }, { input: 120, output: 40 }) },
      say("Score 40. Junk in /Movies.", { input: 300, output: 12 }),
    ]);

    await t.receive(send("Audit my library"));

    const history = t.store.history();
    expect(history.map((m) => [m.role, Predicate.isString(m.content) ? "text" : m.content.map((b) => b.type).join("+")])).toEqual([
      ["user", "text+text"],
      ["assistant", "thinking+tool_use"],
      ["user", "tool_result"],
      ["assistant", "text"],
    ]);
    expect(history[1]?.content[0]).toMatchObject({ signature: "c2lnLTE=" });
    const audit = JSON.parse(t.toolOutput("toolu_1"));
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
      ["plan_layout", true],
      ["propose_translation", true],
      ["find_untranslated", true],
      ["plan_subtitles", true],
      ["plan_free_space", true],
      ["make_download_links", true],
      ["ask_user", true],
    ]);
    expect(JSON.stringify(first?.body.tools)).not.toMatch(/minimum|maximum/);
    expect(first?.body.messages[0].content[1].text).toMatch(/^<context>Target folder: Your Files \(id 0\)\. No scan yet\./);

    const m = month(Date.now());
    const weightedTokens = (120 + 40 * 5) + (300 + 12 * 5);
    expect(t.store.used(m)).toBe(weightedTokens);
    expect(t.agent.state().credits).toEqual({ month: m, used: weightedTokens, cap: 1_000_000, blocked: null });

    expect(t.agent.state().busy).toBe(false);
    expect(t.agent.state().lastAudit?.items).toBe(4);
    expect(t.store.snapshot()).toHaveLength(4);
    const lib = t.events.find((e) => e.type === "library");
    expect(lib?.type === "library" && lib.library.files.length).toBe(4);
    expect(lib?.type === "library" && lib.library.rootId).toBe(0);
    const flags = new Map(lib?.type === "library" ? lib.library.files.map((f) => [f[0], f[4]]) : []);
    expect([flags.get(1), flags.get(2), flags.get(3)]).toEqual([FileFlag.folder, FileFlag.video | FileFlag.messy, FileFlag.junk]);
    expect(t.agent.greeting().map((e) => e.type)).toEqual(["state", "history", "library"]);

    const sent = t.events.flatMap((e) => (e.type === "message" ? [e.message] : []));
    expect(sent).toEqual(history);
    expect(t.events.some((e) => e.type === "partial" && e.content !== null)).toBe(true);
    expect(t.events.at(-1)).toMatchObject({ type: "state", state: { busy: false } });
    expect(t.events.filter((e) => e.type === "state").map((e) => e.type === "state" && e.state.busy)).toContain(true);
  });

  it("stop aborts the Anthropic stream, clears busy and sends no error", async () => {
    const t = await setup([{ kind: "hang" }]);
    await Effect.runPromise(t.agent.receive(send("Audit my library")));
    await t.anthropic.hanging;
    expect(t.agent.state().busy).toBe(true);
    await t.receive({ type: "stop" });
    expect(t.anthropic.wasAborted()).toBe(true);
    expect(t.agent.state().busy).toBe(false);
    expect(t.events.some((e) => e.type === "error")).toBe(false);
    expect(t.store.history().map((m) => m.role)).toEqual(["user"]);
  });

  it("ends the turn when put.io rejects the token, closing the unanswered tool_use", async () => {
    const t = await setup(
      [tool("toolu_9", "scan_library", "{}", { input: 10, output: 2 })],
      { unauthorized: true },
    );

    await t.receive(send("Audit my library"));
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
    const t = await setup([say("Hi.", { input: 5, output: 1 })], {
      history: [
        { role: "user", content: [{ type: "text", text: "Audit my library" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_old", name: "scan_library", input: {} }] },
      ],
    });

    await t.receive(send("hi"));
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

  it("charges a stopped turn the usage its message_start reported", async () => {
    const t = await setup([{ kind: "hang" }]);
    await Effect.runPromise(t.agent.receive(send("Audit my library")));
    await t.anthropic.hanging;
    await new Promise((r) => setTimeout(r, 20));
    await t.receive({ type: "stop" });
    expect(t.store.used(month(Date.now()))).toBe(1 + 1 * 5);
    expect(t.agent.state().credits.used).toBe(6);
  });

  it("makes no follow-up request once a turn spends the month's credits", async () => {
    const t = await setup(
      [
        tool("toolu_1", "scan_library", "{}", { input: 200, output: 5 }),
        say("done."),
      ],
      { cap: 100 },
    );

    await t.receive(send("Audit my library"));
    expect(t.anthropic.requests).toHaveLength(1);
    expect(t.agent.state().busy).toBe(false);
  });

  it("answers from the app without calling Claude once the month's credits are spent", async () => {
    const t = await setup([], { cap: 0 });
    await t.receive(send("hi"));
    expect(t.anthropic.requests).toHaveLength(0);
    expect(t.store.history().map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("refuses new work without calling Claude while the shared pool can't be reached", async () => {
    const t = await setup([], { pool: () => Effect.fail("down") });
    await t.receive(send("hi"));
    expect(t.anthropic.requests).toHaveLength(0);
    expect(t.store.history().at(-1)?.content).toEqual([{ type: "text", text: "can't check credits right now. try again in a minute." }]);
  });

  it("stops everyone, unlimited users too, once the month's shared budget is spent", async () => {
    const t = await setup([], { budget: 1, unlimited: ["altay"], pool: () => Effect.succeed(CREDIT_TOKENS) });
    await t.receive(send("hi"));
    expect(t.anthropic.requests).toHaveLength(0);
    expect(JSON.stringify(t.store.history().at(-1)?.content)).toMatch(/out of credits until [a-z]{3} 1\./);
  });

  it("says the user is out of credits when Anthropic refuses for the workspace spend limit", async () => {
    const t = await setup([{ kind: "error", status: 400, message: "You have reached your specified workspace API usage limits. You will regain access on 2026-12-01 at 00:00 UTC." }]);
    await t.receive(send("hi"));
    expect(t.events.filter((e) => e.type === "error")).toEqual([{ type: "error", message: expect.stringMatching(/^out of credits until [a-z]{3} 1\.$/) }]);
  });

  it("charges a stopped turn for the text it streamed, before the stop returns", async () => {
    const t = await setup([{ kind: "hang", text: "x".repeat(400) }]);
    await Effect.runPromise(t.agent.receive(send("Audit my library")));
    await t.anthropic.hanging;
    await new Promise((r) => setTimeout(r, 20));
    await t.receive({ type: "stop" });
    expect(t.store.used(month(Date.now()))).toBeGreaterThanOrEqual(1 + (400 / 4) * 5);
  });

  it("keeps answering with Claude for a user on the unlimited list after the cap", async () => {
    const t = await setup([say("Hi.", { input: 5, output: 1 })], { cap: 0, unlimited: ["altay"] });
    await t.receive(send("hi"));
    expect(t.anthropic.requests).toHaveLength(1);
  });

  it("clears a busy flag left by an evicted turn and drops frames that fail to decode", async () => {
    const sql = memorySql();
    const store = makeStore(sql);
    store.saveState({ ...store.loadState(Date.now()), busy: true, username: "altay" });

    const agent = await Effect.runPromise(
      makeAgent({
        store,
        model: "m",
        monthlyCredits: 1,
        poolBudgetCredits: 1,
        pool: () => Effect.succeed(0),
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
      tool("toolu_1", "scan_library"),
      say("done"),
    ]);

    await t.receive(send("Audit my library"));

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
  it("reuses the download token, and asks put.io again after a new sign-in in case it was reset", async () => {
    const t = await setup([
      tool("toolu_1", "scan_library"),
      say("done"),
    ]);

    await t.receive(send("Audit my library"));
    const tokenFetches = () => t.putio.log.filter((r) => r.url.searchParams.get("download_token") === "1").length;
    await Effect.runPromise(t.agent.stream(4));
    await Effect.runPromise(t.agent.stream(4));
    expect(tokenFetches()).toBe(1);
    await Effect.runPromise(t.agent.setAuth("putio-token-2", "altay", null));
    await Effect.runPromise(t.agent.stream(4));
    expect(tokenFetches()).toBe(2);
  });
});

describe("plans", () => {
  const heat = "/Movies/Heat.1995.1080p.BluRay.x264-GRP.mkv";
  const WRITES = ["/v2/files/delete", "/v2/files/rename", "/v2/files/move", "/v2/files/create-folder", "/v2/trash/restore"];

  const writes = (t: Awaited<ReturnType<typeof setup>>) =>
    t.putio.log.filter((r) => WRITES.includes(r.url.pathname)).map((r) => [r.url.pathname, Object.fromEntries(r.body)]);

  const proposal = JSON.stringify({
    title: "clean up Movies",
    changes: [
      { op: "trash", path: "/Movies/RARBG_DO_NOT_MIRROR.exe", to: null },
      { op: "rename", path: heat, to: "Heat (1995).mkv" },
      { op: "move", path: "/Alien (1979).mkv", to: "/Movies/Alien (1979)/Alien (1979).mkv" },
    ],
  });

  const proposeTurn = (input = proposal): Array<Reply> => [
    tool("toolu_p", "scan_library"),
    tool("toolu_q", "propose_changes", input),
    say("plan's up."),
  ];

  const planOf = (t: Awaited<ReturnType<typeof setup>>) => {
    const last = t.events.filter((e) => e.type === "plan").at(-1);

    if (last?.type !== "plan") throw new Error("no plan event");

    return last.record;
  };

  const recordOf = (t: Awaited<ReturnType<typeof setup>>, id: string) => t.events.flatMap((e) => (e.type === "plan" && e.record.plan.id === id ? [e.record] : [])).at(-1);

  it("stores a proposal and writes nothing until the user applies it", async () => {
    const t = await setup(proposeTurn());
    await t.receive(send("clean up"));
    const record = planOf(t);
    expect(record.status).toBe("proposed");
    expect(record.plan.changes.map((c) => [c.op, c.path, c.to])).toEqual([
      ["trash", "/Movies/RARBG_DO_NOT_MIRROR.exe", null],
      ["rename", heat, "Heat (1995).mkv"],
      ["move", "/Alien (1979).mkv", "/Movies/Alien (1979)/Alien (1979).mkv"],
    ]);
    expect(writes(t)).toEqual([]);
  });

  it("applies only what the user kept, in order, creating the missing folder", async () => {
    const t = await setup(proposeTurn());
    await t.receive(send("clean up"));
    const { plan } = planOf(t);
    await t.receive({ type: "apply", plan: plan.id, exclude: ["c2"] });
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
    await t.receive(send("clean up"));
    await t.receive({ type: "apply", plan: planOf(t).plan.id, exclude: [] });
    expect(writes(t).map(([p]) => p)).not.toContain("/v2/files/delete");
    expect(planOf(t).run?.steps.find((s) => s.change === "c1")).toMatchObject({ state: "failed" });
  });

  it("keeps going past a failed change, and retry runs only the failures", async () => {
    const t = await setup(proposeTurn(), { failWrites: [2] });
    await t.receive(send("clean up"));
    const id = planOf(t).plan.id;
    await t.receive({ type: "apply", plan: id, exclude: [] });
    expect(planOf(t).run?.steps.map((s) => s.state)).toEqual(["done", "failed", "done"]);
    const before = writes(t).length;
    await t.receive({ type: "retry", plan: id });
    expect(writes(t).slice(before)).toEqual([["/v2/files/rename", { file_id: "2", name: "Heat (1995).mkv" }]]);
  });

  it("undoes the done steps last first, once: restore from trash, rename and move back", async () => {
    const t = await setup(proposeTurn(), { failWrites: [2] });
    await t.receive(send("clean up"));
    const id = planOf(t).plan.id;
    await t.receive({ type: "apply", plan: id, exclude: [] });
    const before = writes(t).length;
    await t.receive({ type: "undo", plan: id });
    await t.receive({ type: "undo", plan: id });
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
    const t = await setup(proposeTurn(trash), { restoreLagListings: 2 });
    await t.receive(send("trash it"));
    const id = planOf(t).plan.id;
    await t.receive({ type: "apply", plan: id, exclude: [] });
    const before = t.putio.log.length;
    await t.receive({ type: "undo", plan: id });
    expect(t.putio.log.slice(before).filter((r) => r.url.pathname === "/v2/files/list")).toHaveLength(4);
    expect(t.store.snapshot().some((f) => f.id === 3)).toBe(true);
  });

  it("takes a renamed or moved video's subtitles along, and nothing else", async () => {
    const t = await setup(
      proposeTurn(
        JSON.stringify({
          title: "names",
          changes: [
            { op: "rename", path: heat, to: "Heat (1995).mkv" },
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

    await t.receive(send("rename"));
    expect(planOf(t).plan.changes.map((c) => [c.op, c.path, c.to])).toEqual([
      ["rename", heat, "Heat (1995).mkv"],
      ["rename", "/Movies/Heat.1995.1080p.BluRay.x264-GRP.eng.srt", "Heat (1995).eng.srt"],
      ["rename", "/Movies/Heat.1995.1080p.BluRay.x264-GRP-forced.en.ass", "Heat (1995)-forced.en.ass"],
      ["move", "/Alien (1979).mkv", "/Movies/Alien (1979).mkv"],
      ["move", "/Alien (1979).srt", "/Movies/Alien (1979).srt"],
    ]);
  });

  it("undoes a rename back to the old name", async () => {
    const rename = JSON.stringify({ title: "names", changes: [{ op: "rename", path: heat, to: "Heat (1995).mkv" }] });
    const t = await setup(proposeTurn(rename));
    await t.receive(send("rename"));
    const id = planOf(t).plan.id;
    await t.receive({ type: "apply", plan: id, exclude: [] });
    await t.receive({ type: "undo", plan: id });
    expect(writes(t)).toEqual([
      ["/v2/files/rename", { file_id: "2", name: "Heat (1995).mkv" }],
      ["/v2/files/rename", { file_id: "2", name: "Heat.1995.1080p.BluRay.x264-GRP.mkv" }],
    ]);
  });

  const applied = async (input: string, opts: Parameters<typeof setup>[1] = {}) => {
    const t = await setup(proposeTurn(input), opts);
    await t.receive(send("go"));
    const id = planOf(t).plan.id;
    await t.receive({ type: "apply", plan: id, exclude: [] });

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
          { op: "move", path: heat, to: "/Heat.mkv" },
        ],
      }),
    );

    const before = writes(t).length;
    await t.receive({ type: "undo", plan: id });
    expect(writes(t).slice(before)).toEqual([
      ["/v2/files/move", { file_ids: "2", parent_id: "1" }],
      ["/v2/files/rename", { file_id: "2", name: "Heat.1995.1080p.BluRay.x264-GRP.mkv" }],
      ["/v2/files/move", { file_ids: "1", parent_id: "0" }],
    ]);
  });

  it("undoes a write whose answer was lost, even after put.io refuses its retry, since the first try may have landed", async () => {
    const failWrites: number[] = [];
    const { t, id } = await applied(proposal, { loseWriteAnswers: [2], failWrites });
    expect(planOf(t).run?.steps[1]).toMatchObject({ change: "c2", state: "failed", maybeApplied: true });
    failWrites.push(2);
    await t.receive({ type: "retry", plan: id });
    expect(planOf(t).run?.steps[1]).toMatchObject({ state: "failed", error: "put.io /files/rename → 400", maybeApplied: true });
    await t.receive({ type: "undo", plan: id });
    expect(writes(t).at(-2)).toEqual(["/v2/files/rename", { file_id: "2", name: "Heat.1995.1080p.BluRay.x264-GRP.mkv" }]);
  });

  it("fails a run when the put.io sign-in is gone, instead of leaving it applying", async () => {
    const t = await setup(proposeTurn());
    await t.receive(send("go"));
    t.store.deleteToken();
    await t.receive({ type: "apply", plan: planOf(t).plan.id, exclude: [] });
    expect(writes(t)).toEqual([]);
    expect(planOf(t).status).toBe("done");
    expect(planOf(t).run?.steps.map((s) => s.error)).toEqual(Array(3).fill("put.io signed you out; sign in again"));
  });

  it("refuses to apply a plan in another target folder than the one it was made in", async () => {
    const t = await setup([...proposeTurn(), say("ok.")]);
    await t.receive(send("go"));
    await t.receive({ type: "send", text: "now Movies", folder: { id: 1, name: "Movies" } });
    await t.receive({ type: "apply", plan: planOf(t).plan.id, exclude: [] });
    expect(writes(t)).toEqual([]);
    expect(planOf(t).run?.steps.every((s) => s.state === "failed" && s.error === "made in Your Files; switch back to it first")).toBe(true);
  });

  it("rejects a proposal against a scan of another folder", async () => {
    const t = await setup([
      ...proposeTurn(),
      tool("toolu_r", "propose_changes", proposal),
      say("rescanning."),
    ]);

    await t.receive(send("go"));
    await t.receive({ type: "send", text: "same in Movies", folder: { id: 1, name: "Movies" } });
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
    await t.receive(send("go"));
    expect(t.events.filter((e) => e.type === "plan")).toHaveLength(0);
    expect(JSON.stringify(t.store.history())).toContain("/X.srt: two changes end there");
  });

  it("plans a media server layout in code, keeps the change list out of the model's context, and applies it", async () => {
    const layoutInput = JSON.stringify({ movies: "/Movies", shows: "/TV Shows", within: "" });

    const t = await setup([
      tool("toolu_s", "scan_library"),
      tool("toolu_l", "plan_layout", layoutInput),
      say("plan's up."),
    ]);

    await t.receive(send("make it work with plex"));
    const record = planOf(t);

    expect(record.plan.changes.map((c) => [c.op, c.path, c.to])).toEqual([
      ["move", "/Alien (1979).mkv", "/Movies/Alien (1979)/Alien (1979).mkv"],
      ["move", heat, "/Movies/Heat (1995)/Heat (1995).mkv"],
    ]);
    const sentToModel = JSON.stringify(t.anthropic.requests.at(-1)?.body.messages.at(-1));

    expect(sentToModel).toContain(`\\"changes\\":2`);
    expect(sentToModel).not.toContain("Heat (1995).mkv");
    await t.receive({ type: "apply", plan: record.plan.id, exclude: [] });
    expect(planOf(t).run?.steps.map((s) => s.state)).toEqual(["done", "done"]);
    expect(t.putio.log.filter((r) => r.url.pathname === "/v2/files/create-folder").map((r) => r.body.get("name"))).toEqual(["Alien (1979)", "Heat (1995)"]);
  });

  const twoPlans = async (first: [string, string], second: [string, string], opts: Parameters<typeof setup>[1] = {}) => {
    const rename = ([path, to]: [string, string]) => JSON.stringify({ title: to, changes: [{ op: "rename", path, to }] });

    const t = await setup(
      [
        tool("toolu_s", "scan_library"),
        tool("toolu_a", "propose_changes", rename(first)),
        tool("toolu_b", "propose_changes", rename(second)),
        say("two plans."),
      ],
      opts,
    );

    await t.receive(send("go"));
    const [a, b] = t.events.flatMap((e) => (e.type === "plan" && e.record.status === "proposed" ? [e.record.plan.id] : []));

    return { t, a: a ?? "", b: b ?? "" };
  };

  it("refuses to apply a plan the library has moved on from", async () => {
    const { t, a, b } = await twoPlans([heat, "Heat (1995).mkv"], [heat, "Heat.mkv"]);
    await t.receive({ type: "apply", plan: a, exclude: [] });
    const before = writes(t).length;

    await t.receive({ type: "apply", plan: b, exclude: [] });
    expect(writes(t).length).toBe(before);
    expect(recordOf(t, b)?.run?.steps[0]?.error).toMatch(/^the library changed since this plan/);
  });

  it("checks put.io itself before a run, so a rename made elsewhere since the scan stops it", async () => {
    const t = await setup(proposeTurn(JSON.stringify({ title: "x", changes: [{ op: "rename", path: heat, to: "Heat (1995).mkv" }] })));
    await t.receive(send("go"));
    await t.putio.fetch("https://api.put.io/v2/files/rename", { method: "POST", body: new URLSearchParams({ file_id: "2", name: "Heat.mkv" }) });
    const before = writes(t).length;

    await t.receive({ type: "apply", plan: planOf(t).plan.id, exclude: [] });
    expect(writes(t).length).toBe(before);
    expect(planOf(t).run?.steps[0]?.error).toBe(`the library changed since this plan (${heat} moved or is gone); ask for a new one`);
  });

  it("won't retry onto a name another plan took since", async () => {
    const { t, a, b } = await twoPlans([heat, "Heat (1995).mkv"], ["/Movies/RARBG_DO_NOT_MIRROR.exe", "Heat (1995).mkv"], { failWrites: [2] });
    await t.receive({ type: "apply", plan: a, exclude: [] });
    await t.receive({ type: "apply", plan: b, exclude: [] });
    const before = writes(t).length;

    await t.receive({ type: "retry", plan: a });
    expect(writes(t).length).toBe(before);
    expect(recordOf(t, a)?.run?.steps[0]?.error).toBe("the library changed since this plan (/Movies/Heat (1995).mkv is taken); ask for a new one");
  });

  const oneAfterAnother = async (first: ProposeInput, second: ProposeInput, opts: Parameters<typeof setup>[1] = {}) => {
    const t = await setup(
      [
        ...proposeTurn(JSON.stringify(first)),
        tool("toolu_b", "propose_changes", JSON.stringify(second)),
        say("plan's up."),
      ],
      opts,
    );

    await t.receive(send("first"));
    const firstId = planOf(t).plan.id;
    await t.receive({ type: "apply", plan: firstId, exclude: [] });
    await t.receive(send("second"));
    await t.receive({ type: "apply", plan: planOf(t).plan.id, exclude: [] });

    return { t, first: firstId, before: writes(t).length };
  };

  it("won't undo onto a name another plan took since, and says to undo it by hand", async () => {
    const { t, first, before } = await oneAfterAnother(
      { title: "a", changes: [{ op: "rename", path: heat, to: "Heat (1995).mkv" }] },
      { title: "b", changes: [{ op: "rename", path: "/Movies/RARBG_DO_NOT_MIRROR.exe", to: "Heat.1995.1080p.BluRay.x264-GRP.mkv" }] },
    );

    await t.receive({ type: "undo", plan: first });
    expect(writes(t).length).toBe(before);
    expect(planOf(t).undo?.steps.map((s) => [s.state, s.error])).toEqual([["failed", `the library changed since this plan (${heat} is taken); undo it by hand`]]);
  });

  it("won't undo a file another plan has moved on since", async () => {
    const { t, first, before } = await oneAfterAnother(
      { title: "a", changes: [{ op: "rename", path: heat, to: "Heat (1995).mkv" }] },
      { title: "b", changes: [{ op: "move", path: "/Movies/Heat (1995).mkv", to: "/Heat (1995).mkv" }] },
    );

    await t.receive({ type: "undo", plan: first });
    expect(writes(t).length).toBe(before);
    expect(planOf(t).undo?.steps[0]?.error).toBe("the library changed since this plan (/Movies/Heat (1995).mkv moved or is gone); undo it by hand");
  });

  it("won't retry a file another plan has moved since it failed", async () => {
    const { t, first, before } = await oneAfterAnother(
      { title: "a", changes: [{ op: "rename", path: heat, to: "Heat (1995).mkv" }] },
      { title: "b", changes: [{ op: "move", path: heat, to: "/Heat.1995.1080p.BluRay.x264-GRP.mkv" }] },
      { failRenames: [2] },
    );

    await t.receive({ type: "retry", plan: first });
    expect(writes(t).length).toBe(before);
    expect(recordOf(t, first)?.run?.steps[0]?.error).toBe(`the library changed since this plan (${heat} moved or is gone); ask for a new one`);
  });

  it("leaves a subtitle where it is when its video's move fails", async () => {
    const { t } = await applied(
      JSON.stringify({ title: "x", changes: [{ op: "move", path: heat, to: "/Heat/Heat (1995).mkv" }] }),
      { files: [...library, file(5, 1, "heat.1995.1080p.bluray.x264-grp.EN.srt", "TEXT", 100)], failWrites: [2] },
    );

    expect(planOf(t).run?.steps.map((s) => [s.change, s.state, s.error])).toEqual([
      ["c1", "failed", "put.io /files/move → 400"],
      ["c1s1", "failed", "its video didn’t move"],
    ]);
    expect(t.putio.log.some((r) => r.body.get("file_ids") === "5")).toBe(false);
  });

  const rejection = async (changes: Array<{ op: string; path: string; to: string | null }>) => {
    const t = await setup(proposeTurn(JSON.stringify({ title: "x", changes })));
    await t.receive(send("go"));
    expect(t.events.some((e) => e.type === "plan")).toBe(false);

    return t.toolOutput("toolu_q");
  };

  it("rejects a proposal naming files outside the snapshot, and stores nothing", async () => {
    expect(await rejection([{ op: "trash", path: "/nope.txt", to: null }])).toContain("not in the snapshot");
  });

  it("rejects changes that collide: into or inside a trashed folder, onto one path, onto an existing name in any case", async () => {
    expect(await rejection([{ op: "trash", path: "/Movies", to: null }, { op: "move", path: "/Alien (1979).mkv", to: "/Movies/Alien (1979).mkv" }])).toContain(
      "lands in /Movies, which this plan trashes",
    );
    expect(await rejection([{ op: "trash", path: "/Movies", to: null }, { op: "trash", path: "/Movies/RARBG_DO_NOT_MIRROR.exe", to: null }])).toContain(
      "inside /Movies, which this plan trashes",
    );
    expect(
      await rejection([
        { op: "move", path: "/Alien (1979).mkv", to: "/Movies/x.mkv" },
        { op: "move", path: heat, to: "/Movies/X.mkv" },
      ]),
    ).toContain("two changes end there");
    expect(await rejection([{ op: "rename", path: heat, to: "rarbg_do_not_mirror.EXE" }])).toContain("already exists there");
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

    await t.receive(send("rename"));
    const { plan } = planOf(t);
    expect(plan.changes.map((c) => [c.id, c.path])).toEqual([
      ["c1", "/Movies/Heat.mkv"],
      ["c1s1", "/Movies/Heat.en.srt"],
    ]);
    await t.receive({ type: "apply", plan: plan.id, exclude: ["c1"] });
    expect(writes(t)).toEqual([]);
  });

  it("rescans after a stopped run", async () => {
    const t = await setup(proposeTurn());
    await t.receive(send("go"));
    const id = planOf(t).plan.id;
    const lists = () => t.putio.log.filter((r) => r.url.pathname === "/v2/files/list").length;
    const before = lists();
    await Effect.runPromise(t.agent.receive(frame({ type: "apply", plan: id, exclude: [] })));
    await t.receive({ type: "stopRun", plan: id });
    expect(planOf(t).status).toBe("done");
    expect(lists()).toBeGreaterThan(before);
  });

  it("tells the model in the next context what happened to the plan", async () => {
    const t = await setup([...proposeTurn(), say("done.")]);
    await t.receive(send("clean up"));
    await t.receive({ type: "apply", plan: planOf(t).plan.id, exclude: ["c3"] });
    await t.receive(send("thanks"));
    const lastUser = t.store.history().filter((m) => m.role === "user").at(-1);
    const context = JSON.stringify(lastUser?.content);
    expect(context).toContain('applied plan \\"clean up Movies\\": 2 done, 0 failed');
  });

  it("ends the turn once a question is asked, and takes the answer next", async () => {
    const ask = JSON.stringify({ prompt: "which copy?", multi: false, options: [{ label: "a", detail: null }, { label: "b", detail: null }] });

    const t = await setup([
      tool("toolu_a1", "ask_user", ask),
      say("keeping a."),
    ]);

    await t.receive(send("which one?"));
    expect(t.anthropic.requests).toHaveLength(1);
    expect(t.agent.state().busy).toBe(false);
    expect(t.toolOutput("toolu_a1")).toContain('"prompt":"which copy?"');
    await t.receive(send("a"));
    expect(t.anthropic.requests).toHaveLength(2);
    expect(t.store.history().at(-1)).toMatchObject({ role: "assistant" });
  });

  it("ignores apply for a discarded plan or an unknown id", async () => {
    const t = await setup(proposeTurn());
    await t.receive(send("clean up"));
    const id = planOf(t).plan.id;
    await Effect.runPromise(t.agent.receive(frame({ type: "discard", plan: id })));
    await Effect.runPromise(t.agent.receive(frame({ type: "apply", plan: id, exclude: [] })));
    await t.receive({ type: "apply", plan: "made-up", exclude: [] });
    expect(planOf(t).status).toBe("discarded");
    expect(writes(t)).toEqual([]);
  });
});

const scanned = (at: string, root = 0) => (store: ReturnType<typeof makeStore>) => {
  store.saveSnapshot([{ id: 4, parent_id: 0, name: "Alien (1979).mkv", path: "/Alien (1979).mkv", depth: 1, size: 1, file_type: "VIDEO", extension: "mkv", crc32: null, created_at: "2026-01-01T00:00:00", first_accessed_at: null }], root);
  store.saveState({ ...store.loadState(Date.now()), lastAudit: { at, rootName: "Your Files", score: 90, items: 1 } });
};

describe("library freshness", () => {
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
        tool("toolu_m", "scan_library"),
        say("scanned."),
      ],
      { seed: scanned("2026-01-01T00:00:00.000Z"), holdFirstListing: slow },
    );

    t.agent.connected();
    await Effect.runPromise(t.agent.receive(frame({ type: "send", text: "scan movies", folder: { id: 1, name: "Movies" } })));

    await new Promise((r) => setTimeout(r, 50));
    release();
    await t.settle();
    expect(t.store.secret("snapshot_root")).toBe("1");
    expect(t.agent.state().lastAudit?.rootName).toBe("Movies");
  });

  it("never lets a slow background refresh overwrite a newer scan of the same folder", async () => {
    let release = () => {};
    const slow = new Promise<void>((resolve) => (release = resolve));

    const t = await setup(
      [
        tool("toolu_n", "scan_library"),
        say("scanned."),
      ],
      { seed: scanned("2026-01-01T00:00:00.000Z"), holdFirstListing: slow },
    );

    t.agent.connected();
    await t.putio.fetch("https://api.put.io/v2/files/rename", { method: "POST", body: new URLSearchParams({ file_id: "4", name: "Aliens (1986).mkv" }) });
    await Effect.runPromise(t.agent.receive(send("rescan")));
    await new Promise((r) => setTimeout(r, 50));
    release();
    await t.settle();
    expect(t.store.snapshot().map((f) => f.name)).toContain("Aliens (1986).mkv");
  });

  it("tells the model how old the last scan is", async () => {
    const t = await setup([say("ok.")], { seed: scanned(new Date(Date.now() - 42 * 60_000).toISOString()) });
    await t.receive(send("hi"));
    expect(JSON.stringify(t.anthropic.requests[0]?.body.messages.at(-1))).toContain("Last scan: 42 minutes ago, 1 items");
  });
});

describe("translate subtitles", () => {
  const files = [file(1, 0, "Movies", "FOLDER"), file(2, 1, "Heat (1995).mkv", "VIDEO", 2 ** 30)];
  const english = "1\n00:00:01,000 --> 00:00:02,000\nHello.\n\n2\n00:00:03,000 --> 00:00:04,500\n<i>Run!</i>\n";

  const scan = tool("toolu_s", "scan_library");
  const done = say("plan's up.");
  const proposeTurns = [scan, tool("toolu_t", "propose_translation", JSON.stringify({ paths: ["/Movies/Heat (1995).mkv", "/movies/HEAT (1995).mkv"], language: "tur" })), done];
  const matches = (yes: boolean) => say(JSON.stringify({ matches: yes }), { input: 1, output: 1 });
  const proposeChecking = (...checks: ReadonlyArray<ReturnType<typeof matches>>) => [...proposeTurns.slice(0, 2), ...checks, ...proposeTurns.slice(2)];

  const proposeAndApply = async (t: Awaited<ReturnType<typeof setup>>) => {
    await t.receive(send("turkish subtitles for heat"));
    const planId = t.store.plans()[0]?.record.plan.id ?? "";
    const m = month(Date.now());
    const before = t.store.used(m);
    await t.receive({ type: "apply", plan: planId, exclude: [] });

    return { planId, charged: t.store.used(m) - before };
  };

  it("translates the English subtitle with Haiku, keeps every timing, uploads it beside the video, and undo trashes only that file", async () => {
    const t = await setup([...proposeChecking(matches(true)), matches(true), say(JSON.stringify({ sentences: [{ id: 0, english: "Hello.", text: "Merhaba.\n\nNasılsın?" }, { id: 1, english: "<i>Run!</i>", text: "<i>Koş!</i>" }] }), { input: 1000, output: 1000 })], {
      files,
      subtitles: { 2: [{ key: "k1", language_code: "eng", source: "opensubtitles_rest", name: "English", srt: english }] },
    });

    const { planId, charged } = await proposeAndApply(t);

    expect(t.putio.uploads).toEqual([
      { name: "Heat (1995).tur.srt", parentId: 1, text: "1\n00:00:01,000 --> 00:00:02,000\nMerhaba.\nNasılsın?\n\n2\n00:00:03,000 --> 00:00:04,500\n<i>Koş!</i>\n" },
    ]);
    expect(t.anthropic.requests.at(-1)?.body.model).toBe("claude-haiku-5-5");
    expect(t.store.plans()[0]?.record.status).toBe("done");

    await t.receive({ type: "undo", plan: planId });
    const deleted = t.putio.log.filter((r) => r.url.pathname === "/v2/files/delete").map((r) => r.body.get("file_ids"));
    const uploadedId = t.store.snapshot().find((f) => f.name === "Heat (1995).tur.srt")?.id;

    expect(deleted).toHaveLength(1);
    expect(deleted[0]).not.toBe("2");
    expect([uploadedId, charged]).toEqual([undefined, Math.ceil((1 + 1 * 5) / 20) + Math.ceil((1000 + 1000 * 5) / 20)]);
  });

  it("translates a sentence split across cues as one and spreads it back over those cues by length, re-asking for any sentence whose echoed English isn't its own", async () => {
    const split = "1\n00:00:01,000 --> 00:00:02,000\nThe\n\n2\n00:00:02,000 --> 00:00:04,000\ntools we use are good.\n\n3\n00:00:05,000 --> 00:00:06,000\n<i>Run!</i>\n";
    const reply = (sentences: ReadonlyArray<{ id: number; english: string; text: string }>) => say(JSON.stringify({ sentences }));

    const t = await setup([...proposeTurns, reply([{ id: 0, english: "Run!", text: "Koş!" }, { id: 1, english: "<i>Run!</i>", text: "<i>Koş!</i>" }]), reply([{ id: 0, english: "The tools we use are good.", text: "Kullandığımız araçlar çok iyi." }])], {
      files,
      subtitles: { 2: [{ key: "k1", language_code: "eng", source: "mkv", name: "English", srt: split }] },
    });

    await proposeAndApply(t);

    expect([t.anthropic.requests.at(-1)?.body.messages.at(-1)?.content, t.putio.uploads.map((u) => u.text)]).toEqual([
      JSON.stringify({ sentences: [{ id: 0, text: "The tools we use are good." }] }),
      ["1\n00:00:01,000 --> 00:00:02,000\nKullandığımız\n\n2\n00:00:02,000 --> 00:00:04,000\naraçlar çok iyi.\n\n3\n00:00:05,000 --> 00:00:06,000\n<i>Koş!</i>\n"],
    ]);
  });

  it("translates every episode under a season folder in one plan, leaving out ones that already have the language", async () => {
    const season = [
      file(30, 0, "Medici", "FOLDER"),
      file(31, 30, "Season 2", "FOLDER"),
      file(32, 31, "Medici S02E01.mkv", "VIDEO", 2 ** 30),
      file(33, 31, "Medici S02E02.mkv", "VIDEO", 2 ** 30),
      file(34, 31, "Medici S02E02.tur.srt", "TEXT", 100),
      file(35, 31, "Medici S02E03.mkv", "VIDEO", 2 ** 30),
    ];

    const sub = [{ key: "k1", language_code: "eng", source: "mkv", name: "English", srt: english }];
    const translated = say(JSON.stringify({ sentences: [{ id: 0, english: "Hello.", text: "Merhaba." }, { id: 1, english: "<i>Run!</i>", text: "<i>Koş!</i>" }] }));

    const t = await setup(
      [
        scan,
        tool("toolu_t", "propose_translation", JSON.stringify({ paths: ["/Medici/Season 2"], language: "tur" })),
        done,
        translated,
        translated,
      ],
      { files: season, subtitles: { 32: sub, 35: sub } },
    );

    await proposeAndApply(t);
    expect([
      JSON.parse(t.toolOutput("toolu_t")).already_translated,
      t.putio.uploads.map((u) => [u.name, u.parentId]).toSorted(),
      t.store.plans()[0]?.record.status,
    ]).toEqual([
      1,
      [
        ["Medici S02E01.tur.srt", 31],
        ["Medici S02E03.tur.srt", 31],
      ],
      "done",
    ]);
  });

  it("skips an OpenSubtitles match Haiku says is for another video and translates the next one", async () => {
    const drama = "1\n00:00:01,000 --> 00:00:02,000\nPut it down now!\n";

    const t = await setup(
      [
        ...proposeChecking(matches(false), matches(true)),
        matches(false),
        matches(true),
        say(JSON.stringify({ sentences: [{ id: 0, english: "Hello.", text: "Merhaba." }, { id: 1, english: "<i>Run!</i>", text: "<i>Koş!</i>" }] })),
      ],
      {
        files,
        subtitles: {
          2: [
            { key: "k1", language_code: "eng", source: "opensubtitles_rest", name: "English", srt: drama },
            { key: "k2", language_code: "eng", source: "opensubtitles_rest", name: "English", srt: english },
          ],
        },
      },
    );

    await proposeAndApply(t);

    expect([JSON.parse(String(t.anthropic.requests.at(-3)?.body.messages.at(-1)?.content)), t.putio.uploads.map((u) => u.text)]).toEqual([
      { video: "/Movies/Heat (1995).mkv", lines: ["Put it down now!"] },
      ["1\n00:00:01,000 --> 00:00:02,000\nMerhaba.\n\n2\n00:00:03,000 --> 00:00:04,500\n<i>Koş!</i>\n"],
    ]);
  });

  it("leaves out, when proposing, videos whose English subtitle is missing or for another video, and says why", async () => {
    const three = [...files, file(3, 1, "Alien (1979).mkv", "VIDEO", 2 ** 30), file(4, 1, "Ronin (1998).mkv", "VIDEO", 2 ** 30)];
    const propose = tool("toolu_t", "propose_translation", JSON.stringify({ paths: ["/Movies"], language: "tur" }));

    const t = await setup([scan, propose, matches(false), done], {
      files: three,
      subtitles: {
        2: [{ key: "k1", language_code: "eng", source: "opensubtitles_rest", name: "English", srt: english }],
        3: [{ key: "k2", language_code: "spa", source: "opensubtitles_rest", name: "Spanish", srt: english }],
        4: [{ key: "k3", language_code: "eng", source: "mkv", name: "English", srt: english }],
      },
    });

    await t.receive(send("turkish subtitles for my movies"));
    const out = JSON.parse(t.toolOutput("toolu_t"));

    expect([out.cant_translate, t.store.plans()[0]?.record.plan.changes.map((c) => c.path), t.putio.uploads]).toEqual([
      [
        { path: "/Movies/Alien (1979).mkv", why: "put.io has no English subtitle for this video" },
        { path: "/Movies/Heat (1995).mkv", why: "put.io’s English subtitles are for a different video" },
      ],
      ["/Movies/Ronin (1998).mkv"],
      [],
    ]);
  });
});

describe("tidy subtitles", () => {
  const files = [
    file(1, 0, "Heat (1995)", "FOLDER"),
    file(2, 1, "Heat (1995).mkv", "VIDEO", 2 ** 30),
    file(3, 1, "Subs", "FOLDER"),
    file(4, 3, "English.srt", "TEXT", 100),
    file(18, 1, "Heat (1995)-trailer.mkv", "VIDEO", 120 * 2 ** 20),
    file(5, 0, "Alien (1979)", "FOLDER"),
    file(6, 5, "Alien (1979).mkv", "VIDEO", 2 ** 30),
    file(7, 5, "alien-eng.srt", "TEXT", 100),
    file(8, 0, "Drive (2011)", "FOLDER"),
    file(9, 8, "Drive (2011).mkv", "VIDEO", 2 ** 30),
    file(10, 8, "Drive (2011).srt", "TEXT", 100),
    file(11, 8, "forced.srt", "TEXT", 100),
    file(12, 0, "Dune (2021)", "FOLDER"),
    file(13, 12, "Dune (2021).mkv", "VIDEO", 2 ** 30),
    file(14, 12, "Subs", "FOLDER"),
    file(15, 14, "1_English.srt", "TEXT", 100),
    file(16, 14, "2_Turkish.srt", "TEXT", 100),
    file(17, 0, "random.srt", "TEXT", 100),
  ];

  const run = async (within: string) => {
    const t = await setup(
      [
        tool("toolu_s", "scan_library"),
        tool("toolu_t", "plan_subtitles", JSON.stringify({ within })),
        say("plan's up."),
      ],
      { files },
    );

    await t.receive(send("fix my subtitles"));
    const result = JSON.parse(t.toolOutput("toolu_t"));

    return { result, plan: t.store.plans().find((p) => p.record.plan.id === result.plan)?.record.plan };
  };

  it("puts each lone stray .srt beside its video under the video's name, and leaves the unclear ones alone", async () => {
    const { result, plan } = await run("");

    expect(plan?.changes.map((c) => [c.op, c.path, c.to])).toEqual([
      ["move", "/Heat (1995)/Subs/English.srt", "/Heat (1995)/Heat (1995).srt"],
      ["rename", "/Alien (1979)/alien-eng.srt", "Alien (1979).srt"],
    ]);
    expect(result.skipped).toBe(4);
  });

  it("matches the folder it's limited to the way plan_layout does", async () => {
    const { plan } = await run("heat (1995)/");

    expect(plan?.changes.map((c) => c.path)).toEqual(["/Heat (1995)/Subs/English.srt"]);
  });
});

describe("free up space", () => {
  const GB = 1e9;

  const files = [
    file(1, 0, "Movies", "FOLDER"),
    file(2, 1, "Heat (1995).mkv", "VIDEO", 4 * GB, { crc32: "aaaa0001", playedAt: "2026-02-01T00:00:00" }),
    file(3, 0, "Heat.1995.1080p.BluRay.x264-GRP.mkv", "VIDEO", 4 * GB, { crc32: "aaaa0001" }),
    file(4, 1, "Alien (1979).mkv", "VIDEO", 2 * GB, { crc32: "bbbb0001" }),
    file(5, 0, "Alien.1979.720p.WEB.x264-GRP.mkv", "VIDEO", GB, { crc32: "bbbb0002" }),
    file(6, 0, "RARBG_DO_NOT_MIRROR.exe", "TEXT", 100),
    file(7, 1, "Dune (2021).mkv", "VIDEO", 8 * GB, { crc32: "cccc0001" }),
    file(8, 0, "__MACOSX", "FOLDER"),
    file(9, 8, "Heat (1995).mkv", "VIDEO", 4 * GB, { crc32: "aaaa0001" }),
    file(10, 0, "Old", "FOLDER"),
    file(11, 10, "Alien.1979.720p.WEB.x264-GRP.mkv", "VIDEO", GB, { crc32: "bbbb0002" }),
  ];

  const run = async (freeGb: number) => {
    const t = await setup(
      [
        tool("toolu_s", "scan_library"),
        tool("toolu_f", "plan_free_space", JSON.stringify({ free_gb: freeGb })),
        say("plan's up."),
      ],
      { files },
    );

    await t.receive(send("free up space"));
    const result = JSON.parse(t.toolOutput("toolu_f"));

    return { result, plan: t.store.plans().find((p) => p.record.plan.id === result.plan)?.record.plan };
  };

  it("trashes the messier exact copy and junk, asks about versions, and only hints at unplayed files", async () => {
    const { result, plan } = await run(0);

    expect(plan?.changes.map((c) => [c.op, c.path])).toEqual([
      ["trash", "/Heat.1995.1080p.BluRay.x264-GRP.mkv"],
      ["trash", "/Old/Alien.1979.720p.WEB.x264-GRP.mkv"],
      ["trash", "/__MACOSX/Heat (1995).mkv"],
      ["trash", "/RARBG_DO_NOT_MIRROR.exe"],
    ]);
    expect(result).toMatchObject({
      freed: 9 * GB + 100,
      disk: { avail: 5e9, size: 1e12 },
      choices: [{ options: [{ path: "/Movies/Alien (1979).mkv" }, { path: "/Alien.1979.720p.WEB.x264-GRP.mkv" }] }],
    });
    expect(result.hints.map((h: { path: string }) => h.path)).toEqual(["/Movies/Dune (2021).mkv"]);
  });

  it("stops once the target is met", async () => {
    const { result, plan } = await run(1);

    expect([plan?.changes.map((c) => c.path), result.freed, result.left]).toEqual([["/Heat.1995.1080p.BluRay.x264-GRP.mkv"], 4 * GB, 3]);
  });
});

describe("download links", () => {
  it("has put.io make them, gives the model only the job, and hands the links to the browser", async () => {
    const t = await setup([
      tool("toolu_s", "scan_library"),
      tool("toolu_l", "make_download_links", JSON.stringify({ paths: ["/Movies", "/Alien (1979).mkv"] })),
      say("links are in the card."),
    ]);

    await t.receive(send("download links please"));
    expect(JSON.parse(t.toolOutput("toolu_l"))).toEqual({ id: 70, files: 3 });
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

describe("delete data", () => {
  const proposed = JSON.stringify({ title: "x", changes: [{ op: "trash", path: "/Movies/RARBG_DO_NOT_MIRROR.exe", to: null }] });

  it("keeps only the month's token count and a newer session generation, and ends every session", async () => {
    const t = await setup([
      tool("toolu_s", "scan_library"),
      tool("toolu_p", "propose_changes", proposed),
      say("plan's up."),
    ]);

    await t.receive(send("tidy"));
    await Effect.runPromise(t.agent.receive(frame({ type: "newThread" })));
    const m = month(Date.now());
    const used = t.store.used(m);
    t.store.charge("2020-01", 7);
    const gen = await Effect.runPromise(t.agent.sessionGen);

    expect(await Effect.runPromise(t.agent.deleteData)).toBe(true);
    expect(t.disconnects()).toBe(1);
    expect(await Effect.runPromise(t.agent.sessionGen)).toBe(gen + 1);

    const tables = ["messages", "archived_messages", "files", "plans", "cf_agents_state"].map((table) => [table, t.sql.exec(`SELECT COUNT(*) AS n FROM ${table}`)[0]?.n]);
    expect(tables).toEqual(["messages", "archived_messages", "files", "plans", "cf_agents_state"].map((table) => [table, 0]));
    expect(t.sql.exec("SELECT key FROM secrets").map((r) => r.key)).toEqual(["session_gen"]);
    expect([used > 0, t.store.used(m), t.store.used("2020-01")]).toEqual([true, used, 0]);
    expect(t.agent.greeting()).toEqual([{ type: "state", state: { ...t.agent.state(), username: null, avatarUrl: null, lastAudit: null } }, { type: "history", messages: [] }]);
  });

  it("lets a rescan that was already listing finish without bringing the snapshot back", async () => {
    let release = () => {};
    const slow = new Promise<void>((resolve) => (release = resolve));

    const t = await setup([], { seed: scanned("2026-01-01T00:00:00.000Z"), holdFirstListing: slow });

    t.agent.connected();
    await new Promise((r) => setTimeout(r, 20));
    expect(await Effect.runPromise(t.agent.deleteData)).toBe(true);
    release();
    await t.settle();
    expect([t.sql.exec("SELECT COUNT(*) AS n FROM files")[0]?.n, t.store.secret("snapshot_root"), t.agent.state().lastAudit]).toEqual([0, null, null]);
  });

  it("refuses while a reply is still running", async () => {
    let release = () => {};
    const slow = new Promise<void>((resolve) => (release = resolve));

    const t = await setup(
      [
        tool("toolu_s", "scan_library"),
        say("scanned."),
      ],
      { holdFirstListing: slow },
    );

    await Effect.runPromise(t.agent.receive(send("scan")));
    await new Promise((r) => setTimeout(r, 50));
    expect(await Effect.runPromise(t.agent.deleteData)).toBe(false);
    release();
    await t.settle();
    expect(t.store.history().length).toBeGreaterThan(0);
  });
});

describe("threads", () => {
  it("archives the conversation on new thread; the next turn starts empty", async () => {
    const t = await setup([
      say("hi."),
      say("fresh."),
    ]);

    await t.receive(send("hello"));
    await Effect.runPromise(t.agent.receive(frame({ type: "newThread" })));
    expect(t.events.at(-1)).toEqual({ type: "history", messages: [] });
    expect(t.store.history()).toEqual([]);
    await t.receive(send("again"));
    expect(t.store.history().map((m) => m.role)).toEqual(["user", "assistant"]);
  });
});

describe("repeated calls", () => {
  it("answers an identical read call in the same turn with a pointer, not a second result", async () => {
    const search = JSON.stringify({ query: "heat", category: "any", limit: 10 });

    const t = await setup([
      tool("toolu_s0", "scan_library"),
      tool("toolu_s1", "search_files", search),
      tool("toolu_s2", "search_files", search),
      say("found it."),
    ]);

    await t.receive(send("find heat"));
    expect(t.toolOutput("toolu_s1")).toContain('"total":1');
    expect(t.toolOutput("toolu_s2")).toContain("already made this exact call");
  });
});
