import { Schema } from "effect";
import { Runtime } from "foldkit";
import type { Document, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";

// Stub: the frontend stage replaces this with the thread UI from design/thread-reference.html.

export const Model = Schema.Struct({ title: Schema.String });
export type Model = typeof Model.Type;

export const Message = defineMessageUnion({ Noop: {} });
export type Message = typeof Message.Type;

export const init: Runtime.ApplicationInit<Model, Message> = () => ({ model: { title: "puterminator" } });

export const update = (model: Model, _message: Message) => ({ model });

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: model.title,
  body: h.main([h.Class("grid h-dvh place-items-center bg-bg text-fg")], [model.title]),
});
