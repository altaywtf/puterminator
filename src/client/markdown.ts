import { type Html, inertHtml as ih } from "foldkit/html";
import type { Nodes, Root } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import type { Library } from "../shared/contract";
import { type Index, indexOf, putioUrl, resolve } from "./library";

// Model text is untrusted. Every mdast node becomes an element or a text node; raw HTML stays
// literal text and only http(s)/mailto links become anchors. No innerHTML anywhere.

const processor = unified().use(remarkParse).use(remarkGfm);
const SAFE_URL = /^(https?:|mailto:)/i;

type Child = Html | string;

// Set for the duration of one synchronous render; inline code that names a scanned file becomes a put.io link.
let files: Index | null = null;

const children = (node: { children: ReadonlyArray<Nodes> }): Child[] => node.children.map(render);

function render(node: Nodes): Child {
  switch (node.type) {
    case "text":
    case "html":
      return node.value;
    case "inlineCode":
    {
      const chip = "rounded-md bg-raised px-1.5 py-px font-mono text-mono text-fg-strong box-decoration-clone";
      const found = files ? resolve(files, node.value) : null;
      const hit = found && found.id >= 0 ? found : null;
      return hit
        ? ih.a(
            [
              ih.Href(putioUrl(hit.id)),
              ih.Target("_blank"),
              ih.Rel("noopener noreferrer"),
              ih.Title(`${hit.path} · open on put.io`),
              // Fixed caps only: Safari ignores a percentage cap while sizing the message column, so a long
              // name widened the whole reply past the screen.
              ih.Class(`${chip} inline-flex max-w-full align-bottom no-underline transition-colors duration-160 hover:text-accent`),
            ],
            // The model often quotes whole paths; the chip shows the name and keeps the path in its title.
            [ih.code([ih.Class("max-w-[36ch] truncate border-0! bg-transparent! p-0! text-inherit!")], [hit.name]), ih.span([ih.Class("ms-1 flex-none text-[12px] text-fg-3"), ih.AriaHidden(true)], ["↗"])],
          )
        : ih.code([ih.Class(chip)], [node.value]);
    }
    case "code":
      return ih.pre(
        [ih.Class("m-0 overflow-x-auto rounded-xl border border-line bg-sunk p-3.5 text-mono leading-normal")],
        [ih.code([], [node.value])],
      );
    case "paragraph":
      return ih.p([ih.Class("m-0 max-w-[64ch] text-pretty text-fg")], children(node));
    case "strong":
      return ih.strong([ih.Class("font-semibold text-fg-strong")], children(node));
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
              ih.Class("underline decoration-fg-4 underline-offset-3 transition-colors duration-160 hover:text-accent"),
            ],
            children(node),
          )
        : ih.span([], children(node));
    case "image":
      return node.alt ?? "";
    case "heading":
      return ih.p([ih.Class("m-0 mt-1 font-semibold text-fg-strong")], children(node));
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
        ? ih.ol([ih.Class("m-0 grid max-w-[64ch] text-fg list-decimal gap-1 ps-6 marker:text-fg-3")], items)
        : ih.ul([ih.Class("m-0 grid max-w-[64ch] gap-1 ps-5 text-fg list-disc marker:text-fg-4")], items);
    }
    case "blockquote":
      return ih.blockquote([ih.Class("m-0 grid gap-2 border-s border-line-strong ps-3 text-fg-2")], children(node));
    case "thematicBreak":
      return ih.hr([ih.Class("w-full border-0 border-t border-line")]);
    case "table":
      return ih.div(
        // Cells inherit overflow-wrap:anywhere from the root; tables scroll instead of breaking tokens.
        [ih.Class("overflow-x-auto [overflow-wrap:normal]")],
        [
          ih.table(
            [ih.Class("border-collapse text-meta tabular-nums")],
            [
              ih.tbody(
                [],
                node.children.map((row, r) =>
                  ih.tr(
                    [],
                    row.children.map((cell) =>
                      (r === 0 ? ih.th : ih.td)(
                        [ih.Class(`border-b border-line py-1 pe-4 text-start ${r === 0 ? "text-[12px] font-normal text-fg-3" : ""}`)],
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

const caret = () => ih.span([ih.Class("caret ms-0.5"), ih.AriaHidden(true)], []);

/** `streaming` puts a blinking caret after the last word while the text still grows. */
export const renderMarkdown = (text: string, streaming: boolean, library: Library | null = null): Html => {
  files = library ? indexOf(library) : null;
  const root: Root = processor.parse(text);
  const nodes = children(root);
  const last = root.children.at(-1);
  if (streaming) {
    if (last?.type === "paragraph")
      nodes[nodes.length - 1] = ih.p([ih.Class("m-0 max-w-[64ch] text-pretty text-fg")], [...children(last), caret()]);
    else nodes.push(caret());
  }
  // Bare URLs and release names have no break points; `pre` keeps scrolling since it never wraps.
  return ih.div([ih.Class("grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2.5 [overflow-wrap:anywhere]")], nodes);
};
