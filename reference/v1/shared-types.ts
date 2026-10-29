import type { BetaContentBlock, BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages";
import { z } from "zod";

export type { Audit } from "../server/audit";
export type { BetaContentBlock, BetaMessageParam };

export type Credits = { month: string; used: number; cap: number };

export type AgentState = {
  username: string | null;
  folder: { id: number; name: string };
  credits: Credits;
  lastAudit: { at: string; rootName: string; score: number; items: number } | null;
  busy: boolean;
};

/** One credit is 1,000 input-token equivalents (see weightedTokens in the agent). */
export const creditsLeft = (c: Credits) => Math.max(0, Math.floor((c.cap - c.used) / 1000));

const Folder = z.object({ id: z.number().int().min(0), name: z.string().max(200) });

/** Browser → agent, over the agent's WebSocket. */
export const ClientEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("send"), text: z.string().min(1).max(4000), folder: Folder }),
  z.object({ type: z.literal("stop") }),
]);
export type ClientEvent = z.infer<typeof ClientEvent>;

/** Agent → browser. The conversation is the Anthropic message history itself. */
export type ServerEvent =
  | { type: "history"; messages: BetaMessageParam[] }
  | { type: "message"; message: BetaMessageParam }
  | { type: "partial"; content: BetaContentBlock[] | null }
  | { type: "error"; message: string };
