import { useAgent } from "agents/react";
import { useEffect, useMemo, useState } from "react";
import type { ToolState } from "@/components/ai-elements/tool";
import type { BetaContentBlockParam } from "@anthropic-ai/sdk/resources/beta/messages";
import type { AgentState, BetaContentBlock, BetaMessageParam, ClientEvent, ServerEvent } from "../shared/types";

export type Folder = { id: number; name: string };

/** What the thread renders. Built from the Anthropic message history the agent keeps. */
export type Item =
  | { kind: "user"; key: string; text: string }
  | { kind: "text"; key: string; text: string }
  | { kind: "thinking"; key: string; text: string; streaming: boolean }
  | { kind: "tool"; key: string; name: string; input: unknown; state: ToolState; output: string | null };

export type Turn = { key: string; role: "user" | "assistant"; items: Item[] };

type Block = BetaContentBlock | BetaContentBlockParam;

const resultText = (content: unknown) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((c: { type: string; text?: string }) => (c.type === "text" ? (c.text ?? "") : "")).join("")
      : "";

export function toTurns(history: BetaMessageParam[], partial: BetaContentBlock[] | null, busy: boolean): Turn[] {
  const results = new Map<string, { text: string; error: boolean }>();
  for (const m of history) {
    if (m.role !== "user" || typeof m.content === "string") continue;
    for (const b of m.content) {
      if (b.type === "tool_result") results.set(b.tool_use_id, { text: resultText(b.content), error: !!b.is_error });
    }
  }

  const turns: Turn[] = [];
  const assistant = (key: string) => {
    const last = turns.at(-1);
    if (last?.role === "assistant") return last;
    const t: Turn = { key, role: "assistant", items: [] };
    turns.push(t);
    return t;
  };

  const addBlocks = (blocks: readonly Block[], key: string, live: boolean) => {
    const turn = assistant(key);
    blocks.forEach((b, i) => {
      const k = `${key}.${i}`;
      if (b.type === "text" && b.text) turn.items.push({ kind: "text", key: k, text: b.text });
      if (b.type === "thinking" && b.thinking.trim())
        turn.items.push({ kind: "thinking", key: k, text: b.thinking, streaming: live && i === blocks.length - 1 });
      if (b.type === "tool_use") {
        const r = results.get(b.id);
        const state: ToolState = r ? (r.error ? "error" : "done") : busy ? "running" : "error";
        turn.items.push({ kind: "tool", key: k, name: b.name, input: b.input, state, output: r?.text ?? null });
      }
    });
  };

  history.forEach((m, i) => {
    const key = `m${i}`;
    if (m.role === "user") {
      if (typeof m.content === "string") return void turns.push({ key, role: "user", items: [{ kind: "user", key, text: m.content }] });
      const first = m.content[0];
      // The second text block is the app's <context>; tool_result messages are folded into their tool steps.
      if (first?.type === "text") turns.push({ key, role: "user", items: [{ kind: "user", key, text: first.text }] });
      return;
    }
    if (m.role !== "assistant") return;
    if (typeof m.content === "string") assistant(key).items.push({ kind: "text", key, text: m.content });
    else addBlocks(m.content as Block[], key, false);
  });
  if (partial) addBlocks(partial, "live", true);
  return turns;
}

export function useThread() {
  const [state, setState] = useState<AgentState | null>(null);
  const [history, setHistory] = useState<BetaMessageParam[]>([]);
  const [partial, setPartial] = useState<BetaContentBlock[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const agent = useAgent<AgentState>({ agent: "puterminator", basePath: "agent", onStateUpdate: setState });

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (typeof e.data !== "string") return;
      let event: ServerEvent;
      try {
        event = JSON.parse(e.data);
      } catch {
        return;
      }
      if (event.type === "history") setHistory(event.messages);
      else if (event.type === "message") setHistory((h) => [...h, event.message]);
      else if (event.type === "partial") setPartial(event.content);
      else if (event.type === "error") setError(event.message);
    };
    agent.addEventListener("message", onMessage);
    return () => agent.removeEventListener("message", onMessage);
  }, [agent]);

  const busy = !!state?.busy;
  const turns = useMemo(() => toTurns(history, partial, busy), [history, partial, busy]);

  const post = (event: ClientEvent) => agent.send(JSON.stringify(event));
  return {
    state,
    turns,
    busy,
    error,
    send: (text: string, folder: Folder) => {
      setError(null);
      post({ type: "send", text, folder });
    },
    stop: () => post({ type: "stop" }),
  };
}
