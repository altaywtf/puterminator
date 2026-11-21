import { checkCommand } from "./policy.ts";

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) {
  chunks.push(Buffer.from(chunk as Buffer));
}

const parse = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
};

const payload = parse(Buffer.concat(chunks).toString("utf8"));
const input =
  typeof payload === "object" && payload !== null && "tool_input" in payload ? payload.tool_input : undefined;
const command =
  typeof input === "object" && input !== null && "command" in input && typeof input.command === "string"
    ? input.command
    : "";
const verdict = checkCommand(command);

if (verdict.action === "block") {
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: verdict.reason,
      },
    })}\n`,
  );
}
