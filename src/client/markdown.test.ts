import type { Html } from "foldkit/html";
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./markdown";

type Node = { sel?: string; text?: string; data?: { props?: Record<string, unknown>; attrs?: Record<string, unknown> }; children?: Node[] };

const walk = (n: Node): Node[] => [n, ...(n.children ?? []).flatMap(walk)];
const nodes = (html: Html) => walk(html as unknown as Node);
const tags = (html: Html) => nodes(html).flatMap((n) => (n.sel ? [n.sel.split(/[.#]/)[0]] : []));
const text = (html: Html) => nodes(html).map((n) => n.text ?? "").join("");
const hrefs = (html: Html) =>
  nodes(html).flatMap((n) => {
    const href = n.data?.props?.href ?? n.data?.attrs?.href;
    return href === undefined ? [] : [String(href)];
  });

describe("renderMarkdown", () => {
  it("keeps raw HTML as text", () => {
    const html = renderMarkdown("Raw <img src=x onerror=alert(1)> here", false);
    expect(tags(html)).not.toContain("img");
    expect(text(html)).toContain("<img src=x onerror=alert(1)>");
  });

  it("links only http, https and mailto", () => {
    const html = renderMarkdown("[a](javascript:alert(1)) [b](https://put.io) [c](data:text/html,x) [d](mailto:x@y.z)", false);
    expect(hrefs(html)).toEqual(["https://put.io", "mailto:x@y.z"]);
  });

  it("does not treat colons as directives", () => {
    expect(text(renderMarkdown("at 10:30, ratio a:b", false))).toBe("at 10:30, ratio a:b");
  });

  it("puts the streaming caret inside the last paragraph", () => {
    const html = renderMarkdown("one\n\ntwo", true) as unknown as Node;
    const last = html.children!.at(-1)!;
    expect(last.sel?.startsWith("p")).toBe(true);
    expect(last.children!.at(-1)!.sel).toContain("span");
  });
});
