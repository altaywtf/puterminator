import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { checkCommand } from "./policy.ts";

export default function hookGuard(pi: ExtensionAPI): void {
  pi.on("tool_call", (event) => {
    if (!isToolCallEventType("bash", event)) {
      return undefined;
    }
    const verdict = checkCommand(event.input.command);
    return verdict.action === "block" ? { block: true, reason: verdict.reason } : undefined;
  });
}
