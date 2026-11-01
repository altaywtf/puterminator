import { describe, expect, it } from "vitest";
import { MessageParam } from "../shared/contract";
import { toTurns } from "../shared/thread";
import { emptyClock, onMessage, onPartial, thoughtSeconds } from "./thinking";

const thinking = (text: string) => ({ type: "thinking", thinking: text });
const tool = { type: "tool_use", id: "t1", name: "scan_library", input: {} };

describe("thinking clock", () => {
  it("times a block from its first partial until the next block starts", () => {
    let c = onPartial(emptyClock, [thinking("Sc")], 1_000);
    expect(thoughtSeconds(c, "live.0")).toBeNull();
    c = onPartial(c, [thinking("Scan first.")], 2_000);
    c = onPartial(c, [thinking("Scan first."), tool], 4_400);
    expect(thoughtSeconds(c, "live.0")).toBe(3);
  });

  it("moves the time to the key toTurns gives the landed message", () => {
    const history: MessageParam[] = [{ role: "user", content: "Audit my library" }];
    let c = onPartial(emptyClock, [thinking("Scan first.")], 1_000);
    c = onMessage(c, history.length, 3_000);
    const landed = toTurns([...history, { role: "assistant", content: [thinking("Scan first."), tool] }], null, true);
    const item = landed[1]!.items[0]!;
    expect(item.kind).toBe("thinking");
    expect(thoughtSeconds(c, item.key)).toBe(2);
    expect(c.started).toEqual({});
  });

  it("knows nothing about history it never saw stream", () => {
    expect(thoughtSeconds(emptyClock, "m1.0")).toBeNull();
  });
});

describe("toTurns with a live partial", () => {
  it("appends the partial to the assistant turn that holds the finished tool step", () => {
    const history: MessageParam[] = [
      { role: "user", content: [{ type: "text", text: "Audit my library" }] },
      { role: "assistant", content: [tool] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "{}" }] },
    ];

    const turns = toTurns(history, [{ type: "text", text: "Your score" }], true);
    expect(turns.map((t) => t.role)).toEqual(["user", "assistant"]);
    expect(turns[1]!.items.map((i) => [i.kind, i.key])).toEqual([
      ["tool", "m1.0"],
      ["text", "live.0"],
    ]);
  });
});
