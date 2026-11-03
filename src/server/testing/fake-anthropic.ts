import * as Predicate from "effect/Predicate";
import type { Json } from "effect/Schema";

type Ev = { readonly type: string; readonly [field: string]: Json };

const enc = new TextEncoder();
const frame = (e: Ev) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;

const DEFAULT_MODEL = "claude-sonnet-5-5";

const asModel = (e: Ev, model: string) => frame(e).replace(`"model":"${DEFAULT_MODEL}"`, `"model":${JSON.stringify(model)}`);

const start = (id: string, inputTokens: number) => ({
  type: "message_start",
  message: {
    id,
    type: "message",
    role: "assistant",
    model: DEFAULT_MODEL,
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: inputTokens, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  },
});

/** Thinking with a signature, then one tool_use whose input arrives in chunks. */
export const toolUseTurn = (tool: { id: string; name: string; inputJsonChunks: Array<string> }, usage: { input: number; output: number }): Array<Ev> => [
  start("msg_1", usage.input),
  { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Scan first." } },
  { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "c2lnLTE=" } },
  { type: "content_block_stop", index: 0 },
  { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: tool.id, name: tool.name, input: {} } },
  ...tool.inputJsonChunks.map((c) => ({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: c } })),
  { type: "content_block_stop", index: 1 },
  { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: usage.output } },
  { type: "message_stop" },
];

export const textTurn = (text: string, usage: { input: number; output: number }): Array<Ev> => [
  start("msg_2", usage.input),
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  ...text.split(/(?<= )/).map((t) => ({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } })),
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: usage.output } },
  { type: "message_stop" },
];

/** `hang`: message_start, then nothing until the request signal aborts. */
export type Reply = { kind: "sse"; events: Array<Ev> } | { kind: "hang"; text?: string } | { kind: "error"; status: number; message: string };

type AnthropicRequest = { body: any; headers: Headers };

export const makeFakeAnthropic = (replies: Array<Reply>) => {
  const requests: Array<AnthropicRequest> = [];
  let aborted = false;
  let onHang: () => void = () => {};

  const hanging = new Promise<void>((resolve) => {
    onHang = resolve;
  });

  const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = { body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) };
    requests.push(request);
    const model: string = Predicate.isString(request.body?.model) ? request.body.model : DEFAULT_MODEL;
    const reply = replies.shift();

    if (!reply) throw new Error("fake anthropic: no reply scripted");

    if (reply.kind === "error") {
      return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: reply.message } }), { status: reply.status, headers: { "content-type": "application/json" } });
    }

    const signal = init?.signal;

    const body = new ReadableStream<Uint8Array>({
      start(c) {
        if (reply.kind === "sse") {
          for (const e of reply.events) c.enqueue(enc.encode(asModel(e, model)));
          c.close();

          return;
        }

        c.enqueue(enc.encode(asModel(start("msg_hang", 1), model)));

        if (reply.text) {
          c.enqueue(enc.encode(frame({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })));
          c.enqueue(enc.encode(frame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: reply.text } })));
        }

        signal?.addEventListener("abort", () => {
          aborted = true;
          c.error(new DOMException("aborted", "AbortError"));
        });
        onHang();
      },
    });

    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  };

  return { fetch: fetchImpl, requests, wasAborted: () => aborted, hanging };
};
