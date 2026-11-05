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
