import { type Html, inertHtml as ih } from "foldkit/html";
import type { Nodes, Root } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

// Model text is untrusted. Every mdast node becomes an element or a text node; raw HTML stays
// literal text and only http(s)/mailto links become anchors. No innerHTML anywhere.

const processor = unified().use(remarkParse).use(remarkGfm);
const SAFE_URL = /^(https?:|mailto:)/i;

type Child = Html | string;

const children = (node: { children: ReadonlyArray<Nodes> }): Child[] => node.children.map(render);

function render(node: Nodes): Child {
  switch (node.type) {
    case "text":
    case "html":
      return node.value;
    case "inlineCode":
      return ih.code([ih.Class("rounded bg-hover px-1 font-mono text-[12px]")], [node.value]);
    case "code":
      return ih.pre(
        [ih.Class("m-0 overflow-x-auto rounded-lg bg-subtle p-3 font-mono text-[12px] leading-normal")],
        [ih.code([], [node.value])],
      );
    case "paragraph":
      return ih.p([ih.Class("m-0 max-w-[62ch] text-pretty")], children(node));
    case "strong":
      return ih.strong([ih.Class("font-semibold")], children(node));
    case "emphasis":
      return ih.em([], children(node));
    case "delete":
      return ih.del([], children(node));
    case "break":
      return ih.br([]);
    case "link":
      return SAFE_URL.test(node.url.trim())
        ? ih.a(
            [
              ih.Href(node.url),
              ih.Target("_blank"),
              ih.Rel("noopener noreferrer nofollow"),
              ih.Class("underline decoration-line-strong underline-offset-2 hover:decoration-fg"),
            ],
            children(node),
          )
        : ih.span([], children(node));
    case "image":
      return node.alt ?? "";
    case "heading":
      return ih.p([ih.Class("m-0 font-semibold")], children(node));
    case "list": {
      const items = node.children.map((item) =>
        ih.li(
          [ih.Class(typeof item.checked === "boolean" ? "list-none" : "")],
          [
            ...(typeof item.checked === "boolean" ? [item.checked ? "☑ " : "☐ "] : []),
            // Tight items wrap their text in a paragraph; keep it inline.
            ...item.children.map((c) => (c.type === "paragraph" && !node.spread ? ih.span([], children(c)) : render(c))),
          ],
        ),
      );
      return node.ordered
        ? ih.ol([ih.Class("m-0 grid max-w-[62ch] list-decimal gap-1 ps-5")], items)
        : ih.ul([ih.Class("m-0 grid max-w-[62ch] list-disc gap-1 ps-5")], items);
    }
    case "blockquote":
      return ih.blockquote([ih.Class("m-0 grid gap-2 border-s-2 border-line-strong ps-3 text-fg-2")], children(node));
    case "thematicBreak":
      return ih.hr([ih.Class("w-full border-0 border-t border-line")]);
    case "table":
      return ih.div(
        [ih.Class("overflow-x-auto")],
        [
          ih.table(
            [ih.Class("border-collapse text-[12.5px] tabular-nums")],
            [
              ih.tbody(
                [],
                node.children.map((row, r) =>
                  ih.tr(
                    [],
                    row.children.map((cell) =>
                      (r === 0 ? ih.th : ih.td)(
                        [ih.Class(`border-b border-line py-1 pe-4 text-start ${r === 0 ? "font-medium text-fg-2" : ""}`)],
                        children(cell),
                      ),
                    ),
                  ),
                ),
              ),
            ],
          ),
        ],
      );
    default:
      return "children" in node ? ih.span([], children(node)) : "value" in node ? String(node.value) : "";
  }
}

const caret = () => ih.span([ih.Class("caret"), ih.AriaHidden(true)], []);

/** `streaming` puts a blinking caret after the last word while the text still grows. */
export const renderMarkdown = (text: string, streaming: boolean): Html => {
  const root: Root = processor.parse(text);
  const nodes = children(root);
  const last = root.children.at(-1);
  if (streaming) {
    if (last?.type === "paragraph")
      nodes[nodes.length - 1] = ih.p([ih.Class("m-0 max-w-[62ch] text-pretty")], [...children(last), caret()]);
    else nodes.push(caret());
  }
  return ih.div([ih.Class("grid min-w-0 gap-2.5")], nodes);
};
