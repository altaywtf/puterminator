import { describe, expect, it } from "vitest";
import { init, Message, update } from "./main";

describe("sending", () => {
  it("gives the draft back when the message never left", () => {
    const model = init().model;
    const failed = update({ ...model, draft: "" }, Message.FailedFrame({ error: "not connected. try again in a moment.", unsent: "audit my library" }));
    expect(failed.model.draft).toBe("audit my library");
    const typing = update({ ...model, draft: "something new" }, Message.FailedFrame({ error: "x", unsent: "audit my library" }));
    expect(typing.model.draft).toBe("something new");
  });
});

describe("session", () => {
  it("drops a lost connection to the signed-out page and stops reconnecting once the session is gone", () => {
    const model = init().model;
    const lost = update(update(model, Message.GotMe({ me: { signedIn: true, configured: true } })).model, Message.FailedSocket()).model;
    const out = update(lost, Message.GotMe({ me: { signedIn: false, configured: true } })).model;
    expect([out.session._tag, out.connection._tag, out.agent]).toEqual(["SignedOut", "Idle", null]);
  });
});

describe("feedback drafts", () => {
  it("sends a drafted card once and marks it sent from the card or the dialog", () => {
    const model = init().model;
    const clicked = update(model, Message.ClickedSendDraft({ key: "t1", kind: "idea", text: "  show mime types  " }));
    expect([clicked.model.drafts["t1"], clicked.commands?.length]).toEqual([{ state: "sending" }, 1]);
    expect(update(clicked.model, Message.ClickedSendDraft({ key: "t1", kind: "idea", text: "x" })).commands ?? []).toEqual([]);
    expect(update(clicked.model, Message.SentDraft({ key: "t1" })).model.drafts["t1"]).toEqual({ state: "sent" });

    const editing = update(model, Message.ClickedFeedback({ kind: "bug", text: "undo broke", draft: "t2" })).model;
    const sending = update(editing, Message.SubmittedFeedback()).model;
    expect(sending.drafts["t2"]).toEqual({ state: "sending" });

    const other = update(update(sending, Message.ClosedFeedback()).model, Message.ClickedFeedback({ kind: "idea", text: "mime types", draft: "t3" })).model;
    const sent = update(other, Message.SentFeedback({ draft: "t2" })).model;
    expect([sent.drafts["t2"], sent.drafts["t3"], sent.feedback?.status]).toEqual([{ state: "sent" }, undefined, "editing"]);
  });
});
