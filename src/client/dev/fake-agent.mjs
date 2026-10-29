// Local stand-in for the Worker on :1337, so `pnpm dev:client` runs with no put.io or Anthropic.
// It speaks the src/shared/contract.ts frames. Not part of the build.
//   FAKE=thread|empty|signed-out|unconfigured node src/client/dev/fake-agent.mjs
// Prompts: "boom" sends an error frame; "hold" leaves a tool running until "stop".
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import * as fixtures from "./fixtures.ts";

const mode = process.env.FAKE ?? "thread";
const port = Number(process.env.PORT ?? 1337);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const folders = [
  { id: 101, name: "movies" },
  { id: 102, name: "series" },
  { id: 103, name: "documentaries" },
  { id: 104, name: "courses" },
  { id: 105, name: "audiobooks" },
];
const history = mode === "thread" ? [...fixtures.history] : [];
const state = {
  username: "altay",
  folder: { id: 0, name: "Your Files" },
  credits: { month: "2026-10", used: 588_000, cap: 1_000_000 },
  lastAudit: { at: fixtures.audit.at, rootName: "Your Files", score: 64, items: 3688 },
  busy: false,
};

const me = {
  thread: { configured: true, signedIn: true },
  empty: { configured: true, signedIn: true },
  "signed-out": { configured: true, signedIn: false },
  unconfigured: { configured: false, signedIn: false },
}[mode];

const server = createServer((req, res) => {
  const json = (body) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.url === "/api/me") return json(me);
  if (req.url === "/api/folders") return me.signedIn ? json(folders) : (res.writeHead(401), res.end());
  if (req.url === "/auth/logout") return (res.writeHead(204), res.end());
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server, path: "/agent" });

wss.on("connection", (socket) => {
  const send = (event) => socket.send(JSON.stringify(event));
  const setState = (patch) => {
    Object.assign(state, patch);
    send({ type: "state", state });
  };
  const append = (message) => {
    history.push(message);
    send({ type: "message", message });
  };
  let stopped = false;

  send({ type: "state", state });
  send({ type: "history", messages: history });

  socket.on("message", async (raw) => {
    const event = JSON.parse(String(raw));
    if (event.type === "stop") return void (stopped = true);
    if (event.type !== "send" || state.busy) return;
    stopped = false;
    append({
      role: "user",
      content: [
        { type: "text", text: event.text },
        { type: "text", text: `<context>Target folder: ${event.folder.name} (id ${event.folder.id}).</context>` },
      ],
    });
    setState({ busy: true, folder: event.folder });
    await sleep(500);
    try {
      if (event.text === "boom") return send({ type: "error", message: "Something broke on my side. Try again in a moment." });

      const thought = "The user wants a fresh look. Scan first, then answer from the numbers.";
      for (let i = 6; i <= thought.length && !stopped; i += 6) {
        send({ type: "partial", content: [{ type: "thinking", thinking: thought.slice(0, i) }] });
        await sleep(90);
      }
      const id = `toolu_${Date.now()}`;
      const call = [
        { type: "thinking", thinking: thought, signature: "sig" },
        { type: "tool_use", id, name: "scan_library", input: {} },
      ];
      send({ type: "partial", content: call });
      await sleep(200);
      append({ role: "assistant", content: call });
      send({ type: "partial", content: null });
      const hold = event.text === "hold";
      for (let t = 0; !stopped && (hold || t < 1600); t += 100) await sleep(100);
      if (stopped) return;
      append({ role: "user", content: [{ type: "tool_result", tool_use_id: id, content: JSON.stringify(fixtures.audit) }] });

      const reply =
        "Same score as last time: **64/100**.\n\n" +
        "- Naming is still the weak spot at 38\n" +
        "- Junk and duplicates look fine\n\n" +
        "Ask me which folders carry the most release names.";
      let shown = "";
      for (let i = 4; i <= reply.length + 4 && !stopped; i += 5) {
        shown = reply.slice(0, i);
        send({ type: "partial", content: [{ type: "text", text: shown }] });
        await sleep(35);
      }
      append({ role: "assistant", content: [{ type: "text", text: stopped ? shown : reply }] });
    } finally {
      send({ type: "partial", content: null });
      setState({ busy: false, credits: { ...state.credits, used: state.credits.used + 4_000 } });
    }
  });
});

// `localhost`, the host the Vite proxy targets.
server.listen(port, "localhost", () => console.log(`fake agent (${mode}) on http://localhost:${port}`));
