import { describe, expect, it } from "vitest";
import type { MessageParam } from "./contract";
import { toTurns } from "./thread";

const ask: MessageParam = {
  role: "user",
  content: [
    { type: "text", text: "Audit my library" },
    { type: "text", text: "<context>Target folder: Your Files (id 0).</context>" },
  ],
};

const call: MessageParam = {
  role: "assistant",
  content: [
    { type: "thinking", thinking: "Scan first.", signature: "sig" },
    { type: "tool_use", id: "t1", name: "scan_library", input: {} },
  ],
};

const result = (is_error: boolean): MessageParam => ({
  role: "user",
  content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: '{"score":71}' }], is_error }],
});

const answer: MessageParam = { role: "assistant", content: [{ type: "text", text: "Score 71." }] };

describe("toTurns", () => {
  it("keeps a tool call's usable arguments when one value isn't valid JSON", () => {
    const odd: MessageParam = { role: "assistant", content: [{ type: "tool_use", id: "t9", name: "list_folder", input: { path: "/Movies", extra: Number.POSITIVE_INFINITY } }] };
    const item = toTurns([ask, odd], null, false).flatMap((t) => t.items).find((i) => i.kind === "tool");
    expect(item?.kind === "tool" && item.input).toEqual({ path: "/Movies", extra: null });
  });

  it("shows the user's text, not the app's context block", () => {
    const [turn] = toTurns([ask], null, false);
    expect(turn).toEqual({ key: "m0", role: "user", items: [{ kind: "user", key: "m0", text: "Audit my library" }] });
  });

  it("folds tool results into one assistant turn", () => {
    const turns = toTurns([ask, call, result(false), answer], null, false);
    expect(turns.map((t) => t.role)).toEqual(["user", "assistant"]);
    expect(turns[1]!.items).toEqual([
      { kind: "thinking", key: "m1.0", text: "Scan first.", streaming: false },
      { kind: "tool", key: "m1.1", id: "t1", name: "scan_library", input: {}, state: "done", output: '{"score":71}' },
      { kind: "text", key: "m3.0", text: "Score 71." },
    ]);
  });

  it("marks a tool error from is_error", () => {
    const tool = toTurns([ask, call, result(true)], null, false)[1]!.items[1]!;
    expect(tool).toMatchObject({ kind: "tool", state: "error" });
  });

  it("keeps a resultless tool running while busy and failed after", () => {
    expect(toTurns([ask, call], null, true)[1]!.items[1]).toMatchObject({ state: "running", output: null });
    expect(toTurns([ask, call], null, false)[1]!.items[1]).toMatchObject({ state: "error" });
  });

  it("appends a live partial to the assistant turn that holds the finished tool step", () => {
    const turns = toTurns([ask, call, result(false)], [{ type: "text", text: "Your score" }], true);
    expect(turns.map((t) => t.role)).toEqual(["user", "assistant"]);
    expect(turns[1]!.items.map((i) => [i.kind, i.key])).toEqual([
      ["thinking", "m1.0"],
      ["tool", "m1.1"],
      ["text", "live.0"],
    ]);
  });

  it("streams only the last thinking block of the partial", () => {
    const turns = toTurns([ask], [{ type: "thinking", thinking: "Hm" }], true);
    expect(turns[1]!.items).toEqual([{ kind: "thinking", key: "live.0", text: "Hm", streaming: true }]);
  });

  it("drops empty text and blank thinking", () => {
    const turns = toTurns([ask, { role: "assistant", content: [{ type: "text", text: "" }, { type: "thinking", thinking: "  " }] }], null, false);
    expect(turns[1]!.items).toEqual([]);
  });
});
