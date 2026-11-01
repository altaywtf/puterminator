import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import type { ContentBlock, MessageParam } from "./contract";

const toJson = Schema.decodeUnknownOption(Schema.Json);

const ToolState = Schema.Literals(["running", "done", "error"]);

type ToolState = typeof ToolState.Type;

export const Item = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("user"), key: Schema.String, text: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("text"), key: Schema.String, text: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("thinking"), key: Schema.String, text: Schema.String, streaming: Schema.Boolean }),
  Schema.Struct({
    kind: Schema.Literal("tool"),
    key: Schema.String,
    name: Schema.String,
    input: Schema.Json,
    state: ToolState,
    output: Schema.NullOr(Schema.String),
  }),
]);

export type Item = typeof Item.Type;

export const Turn = Schema.Struct({
  key: Schema.String,
  role: Schema.Literals(["user", "assistant"]),
  items: Schema.Array(Item),
});

export type Turn = typeof Turn.Type;

const str = (b: ContentBlock, field: string) => {
  const v = b[field];

  return Predicate.isString(v) ? v : "";
};

const isTextBlock = Schema.is(Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }));

const resultText = (b: ContentBlock) => {
  const content = b.content;

  if (Predicate.isString(content)) return content;

  return Array.isArray(content) ? content.map((c) => (isTextBlock(c) ? c.text : "")).join("") : "";
};

/**
 * Folds tool_result messages into their tool steps and drops the app's `<context>` block
 * (the second text block of each user message). A tool with no result is running while the
 * agent is busy and failed otherwise.
 */
export function toTurns(
  history: readonly MessageParam[],
  partial: readonly ContentBlock[] | null,
  busy: boolean,
): Turn[] {
  const results = new Map<string, { text: string; error: boolean }>();

  for (const m of history) {
    if (m.role !== "user" || Predicate.isString(m.content)) continue;

    for (const b of m.content) {
      if (b.type === "tool_result") results.set(str(b, "tool_use_id"), { text: resultText(b), error: b.is_error === true });
    }
  }

  const turns: { key: string; role: "user" | "assistant"; items: Item[] }[] = [];

  const assistant = (key: string) => {
    const last = turns.at(-1);

    if (last?.role === "assistant") return last;
    const t: (typeof turns)[number] = { key, role: "assistant", items: [] };
    turns.push(t);

    return t;
  };

  const addBlocks = (blocks: readonly ContentBlock[], key: string, live: boolean) => {
    const turn = assistant(key);
    blocks.forEach((b, i) => {
      const k = `${key}.${i}`;

      if (b.type === "text" && str(b, "text")) turn.items.push({ kind: "text", key: k, text: str(b, "text") });

      if (b.type === "thinking" && str(b, "thinking").trim())
        turn.items.push({ kind: "thinking", key: k, text: str(b, "thinking"), streaming: live && i === blocks.length - 1 });

      if (b.type === "tool_use") {
        const r = results.get(str(b, "id"));
        const state: ToolState = r ? (r.error ? "error" : "done") : busy ? "running" : "error";
        turn.items.push({ kind: "tool", key: k, name: str(b, "name"), input: Option.getOrElse(toJson(b.input), () => ({})), state, output: r?.text ?? null });
      }
    });
  };

  history.forEach((m, i) => {
    const key = `m${i}`;

    if (m.role === "user") {
      if (Predicate.isString(m.content)) {
        turns.push({ key, role: "user", items: [{ kind: "user", key, text: m.content }] });

        return;
      }

      const first = m.content[0];

      if (first?.type === "text") turns.push({ key, role: "user", items: [{ kind: "user", key, text: str(first, "text") }] });

      return;
    }

    if (Predicate.isString(m.content)) assistant(key).items.push({ kind: "text", key, text: m.content });
    else addBlocks(m.content, key, false);
  });

  if (partial) addBlocks(partial, "live", true);

  return turns;
}
