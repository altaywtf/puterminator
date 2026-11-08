import * as Predicate from "effect/Predicate";
import type { Html } from "foldkit/html";
import { describe, expect, it } from "vitest";
import { FileFlag, type Library } from "../shared/contract";
import { renderMarkdown } from "./markdown";

type VNode = NonNullable<Html>;

const elements = (n: Html | undefined): VNode[] => (n?.children ?? []).flatMap((c) => (Predicate.isString(c) ? [] : [c]));
const walk = (n: VNode): VNode[] => [n, ...elements(n).flatMap(walk)];
const nodes = (html: Html) => (html ? walk(html) : []);
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
    const last = elements(renderMarkdown("one\n\ntwo", true)).at(-1);
    expect(last?.sel?.startsWith("p")).toBe(true);
    expect(elements(last).at(-1)?.sel).toContain("span");
  });

  it("links inline code that names one scanned file, and leaves the rest as code", () => {
    const lib = { rootId: 0, rootName: "Your Files", files: [[1, 0, "Movies", 9, FileFlag.folder], [2, 1, "Haze.mkv", 9, FileFlag.video]] } satisfies Library;
    const html = renderMarkdown("keep `Haze.mkv`, not `Alvex.mkv`", false, lib);
    expect(hrefs(html)).toEqual(["https://app.put.io/files/2"]);
    expect(text(html)).toContain("Alvex.mkv");
  });
});
