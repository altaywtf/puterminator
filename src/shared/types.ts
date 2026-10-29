export type { Audit } from "../server/audit";

export type Credits = { month: string; used: number; cap: number };

export type AgentState = {
  username: string | null;
  folder: { id: number; name: string };
  credits: Credits;
  lastAudit: { at: string; rootName: string; score: number; items: number } | null;
};

/** One credit is 1,000 model tokens. */
export const creditsLeft = (c: Credits) => Math.max(0, Math.floor((c.cap - c.used) / 1000));
