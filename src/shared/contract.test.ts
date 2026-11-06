import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { audit } from "../server/audit";
import { buildTree } from "../server/tree";
import { Audit } from "./audit";
import { AgentState, ClientFrame, ServerFrame, type ServerEvent } from "./contract";

const decodeClient = Schema.decodeUnknownExit(ClientFrame);
const encodeServer = Schema.encodeSync(ServerFrame);
const decodeServer = Schema.decodeUnknownSync(ServerFrame);

describe("ClientEvent", () => {
  it("accepts send and stop", () => {
    expect(Exit.isSuccess(decodeClient('{"type":"send","text":"Audit my library","folder":{"id":0,"name":"Your Files"}}'))).toBe(true);
    expect(Exit.isSuccess(decodeClient('{"type":"stop"}'))).toBe(true);
  });

  it("rejects empty or over-long text, a negative or fractional folder id, an unknown type and non-JSON", () => {
    for (const raw of [
      '{"type":"send","text":"","folder":{"id":0,"name":"Your Files"}}',
      `{"type":"send","text":"${"x".repeat(4001)}","folder":{"id":0,"name":"Your Files"}}`,
      '{"type":"send","text":"hi","folder":{"id":-1,"name":"All"}}',
      '{"type":"send","text":"hi","folder":{"id":1.5,"name":"A"}}',
      '{"type":"delete"}',
      "not json",
    ]) {
      expect(Exit.isFailure(decodeClient(raw)), raw).toBe(true);
    }
  });
});

describe("ServerEvent", () => {
  it("round-trips every Anthropic block shape the history holds", () => {
    const events: ServerEvent[] = [
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Scan first.", signature: "sig==" },
            { type: "redacted_thinking", data: "opaque" },
            { type: "tool_use", id: "toolu_1", name: "scan_library", input: {} },
          ],
        },
      },
      {
        type: "message",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "{}" }], is_error: false }],
        },
      },
      { type: "partial", content: null },
      { type: "history", messages: [{ role: "user", content: "hi" }] },
      { type: "error", message: "Something broke on my side. Try again in a moment." },
    ];

    for (const event of events) expect(decodeServer(encodeServer(event))).toEqual(event);
  });

  it("decodes a v1 cf_agents_state row as AgentState", () => {
    const v1 = {
      username: "altay",
      folder: { id: 0, name: "Your Files" },
      credits: { month: "2026-10", used: 12345, cap: 1000000 },
      lastAudit: { at: "2026-10-28T10:00:00.000Z", rootName: "Your Files", score: 71, items: 5120 },
      busy: false,
    };

    expect(Schema.decodeUnknownSync(AgentState)(v1)).toEqual(v1);
  });
});

describe("Audit", () => {
  it("matches what audit() returns, field for field", () => {
    const flat = [
      { id: 1, parent_id: 0, name: "The.Office.S02E01.720p.HDTV.x264", file_type: "FOLDER", size: 0 },
      { id: 2, parent_id: 1, name: "The.Office.S02E01.720p.HDTV.x264.mkv", file_type: "VIDEO", size: 2 ** 30 },
      { id: 3, parent_id: 1, name: "RARBG_DO_NOT_MIRROR.exe", file_type: "FILE", size: 100 },
      { id: 4, parent_id: 0, name: "The Office S02E01 1080p WEB.mkv", file_type: "VIDEO", size: 2 * 2 ** 30 },
    ].map((f) => ({ ...f, content_type: null, extension: null, crc32: null, created_at: "2026-01-01T00:00:00", first_accessed_at: null }));

    const result = audit(buildTree(flat, 0).files, "Your Files", false);
    expect(result.junk.count).toBeGreaterThan(0);
    expect(result.duplicates.groups).toBe(1);
    const decoded = Schema.decodeUnknownSync(Audit)(JSON.parse(JSON.stringify(result)), { onExcessProperty: "error" });
    expect(decoded).toEqual(result);
  });
});
