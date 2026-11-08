import type { Html, HtmlBuilder } from "foldkit/html";
import { art } from "./art";
import { toolCard } from "./cards";
import { audit, library } from "./demo";
import logoUrl from "./logo.svg?inline";
import type { Message, Model } from "./main";

type H = HtmlBuilder<Message>;

const WIDE = "mx-auto grid w-full max-w-[72rem] px-5 max-[480px]:px-4";

const signIn = (h: H) => h.a([h.Href("/auth/login"), h.Class("btn btn-primary")], ["continue with put.io ↗"]);

const header = (h: H) =>
  h.header([h.Class(`${WIDE} flex! h-14 items-center gap-4`)], [
    h.span([h.Class("flex items-center gap-2.5 font-display text-[16px] text-accent")], [
      h.img([h.Src(logoUrl), h.Alt(""), h.Width("22"), h.Height("22"), h.Draggable(false), h.Class("block select-none [image-rendering:pixelated]")]),
      "puterminator",
    ]),
    h.span([h.Class("grow")], []),
    h.a([h.Href("/auth/login"), h.Class("text-meta text-fg-3 no-underline transition-colors duration-160 hover:text-fg")], ["sign in"]),
  ]);

const hero = (h: H) =>
  h.section([h.Class(`${WIDE} grid-cols-[minmax(0,1fr)_auto] items-center gap-x-12 pt-14 pb-16 max-[860px]:grid-cols-1 max-[480px]:pt-8 max-[480px]:pb-12`)], [
    h.div([h.Class("grid gap-7")], [
      h.div([h.Class("min-[861px]:hidden")], [art(h, "idle", 72)]),
      h.h1([h.Class("m-0 max-w-[18ch] font-display text-[56px] leading-[1.02] font-medium text-fg-strong max-[480px]:text-[36px]")], [
        "your AI companion for ",
        h.span([h.Class("text-accent")], ["put.io"]),
        " things",
      ]),
      h.p([h.Class("m-0 max-w-[50ch] text-[17px] text-fg-2 max-[480px]:text-[15px]")], [
        "a chat agent for your put.io library. it scores the mess, finds junk and doubles, and turns release names into folders plex, jellyfin, infuse and kodi can read.",
      ]),
      h.div([h.Class("justify-self-start")], [signIn(h)]),
    ]),
    h.div([h.Class("me-6 max-[860px]:hidden")], [art(h, "mop", 224)]),
  ]);

const screen = (h: H, children: Html[]) =>
  h.div([h.Class("-mx-5 -mb-4 grid grow content-start overflow-hidden border-t border-line bg-sunk py-2 font-mono text-mono leading-[1.7] max-[480px]:-mx-4")], children);

const tile = (h: H, span: string, title: string, prompt: string, body: Html[]) =>
  h.section([h.Class(`flex flex-col gap-3 overflow-hidden rounded-xl border border-line bg-raised px-5 pt-4 pb-4 max-[480px]:px-4 ${span}`), h.AriaLabel(title)], [
    h.h2([h.Class("m-0 font-display text-[18px] leading-tight font-medium text-fg-strong")], [title]),
    screen(h, [
      h.span([h.Class("flex min-w-0 gap-2 px-3 pb-1 text-fg-3")], [h.span([h.Class("flex-none text-fg-4"), h.AriaHidden(true)], ["$"]), h.span([h.Class("truncate")], [prompt])]),
      ...body,
    ]),
  ]);

const diff = (h: H, sign: "-" | "+", text: string) =>
  h.span([h.Class(`grid grid-cols-[1.25rem_minmax(0,1fr)] gap-x-2 px-3 ${sign === "-" ? "bg-danger/8" : "bg-ok/8"}`)], [
    h.span([h.Class(`select-none ${sign === "-" ? "text-danger" : "text-ok"}`), h.AriaHidden(true)], [sign]),
    h.span([h.Class("min-w-0 [overflow-wrap:anywhere] text-fg")], [text]),
  ]);

const names = (h: H) =>
  tile(h, "", "release names, fixed", "clean up the names in Downloads", [
    diff(h, "-", "Perfect.Hours.2023.1080p.BluRay.x264-QoXT.mkv"),
    diff(h, "+", "Perfect Hours (2023).mkv"),
    diff(h, "-", "Sevenfold.S02E01.1080p.WEB.H264-AmbitiousEel.mkv"),
    diff(h, "+", "Sevenfold - S02E01.mkv"),
  ]);

const tree = (h: H, lines: Array<[branch: string, name: string, folder: boolean]>) =>
  h.div(
    [h.Class("grid min-w-0")],
    lines.map(([branch, name, folder]) =>
      h.span([h.Class("flex min-w-0 px-3")], [
        h.span([h.Class("flex-none whitespace-pre text-fg-4"), h.AriaHidden(true)], [branch]),
        h.span([h.Class(`truncate ${name.startsWith("#") ? "text-fg-4" : folder ? "text-fg-2" : "text-fg"}`)], [name]),
      ]),
    ),
  );

const layout = (h: H) =>
  tile(h, "col-span-2 max-[860px]:col-span-1", "a layout plex can read", "set it up for plex", [
    h.div([h.Class("grid grid-cols-2 gap-y-3 max-[720px]:grid-cols-1")], [
      tree(h, [
        ["", "# before", false],
        ["", "Downloads/", true],
        ["├─ ", "Dunmar.Part.Two.2024.2160p.WEB-DL.DDP5.1.Atmos.H.265-FLAX/", true],
        ["│  └─ ", "Dunmar.Part.Two.2024.2160p.WEB-DL.DDP5.1.Atmos.H.265-FLAX.mkv", false],
        ["└─ ", "The.Badger.S03E01.1080p.WEB.h264-MABEL.mkv", false],
      ]),
      tree(h, [
        ["", "# after", false],
        ["", "Movies/", true],
        ["└─ ", "Dunmar Part Two (2024)/Dunmar Part Two (2024).mkv", false],
        ["", "Series/", true],
        ["└─ ", "The Badger/Season 03/The Badger - S03E01.mkv", false],
      ]),
    ]),
  ]);

const score = (h: H, model: Model) =>
  h.div([h.Class("grid")], [toolCard(h, { expanded: model.expanded, library, plans: {} }, { name: "scan_library", key: "landing", id: "landing", output: JSON.stringify(audit) }, false) ?? h.span([], [])]);

const examples = (h: H, model: Model) =>
  h.section([h.Class(`${WIDE} pb-20`), h.AriaLabel("examples")], [
    h.div([h.Class("grid grid-cols-2 gap-4 max-[860px]:grid-cols-1")], [score(h, model), names(h), layout(h)]),
  ]);

const FOOTER_LINK = "text-fg-3 underline decoration-fg-4 underline-offset-2 hover:text-fg";

const outro = (h: H) =>
  h.footer([h.Class(`${WIDE} gap-2 border-t border-line pt-8 pb-[max(40px,env(safe-area-inset-bottom))] text-meta text-fg-4`)], [
    h.p([h.Class("m-0 max-w-[72ch]")], ["a uinaf side project, not an official put.io app. AI is involved, so use it at your own risk."]),
    h.p([h.Class("m-0 flex flex-wrap gap-x-4 gap-y-1")], [
      h.a([h.Href("/privacy"), h.Class(FOOTER_LINK)], ["privacy and disclaimer"]),
      h.a([h.Href("https://github.com/altaywtf/puterminator"), h.Class(FOOTER_LINK)], ["open source on GitHub"]),
      h.a([h.Href("mailto:dev@uinaf.dev"), h.Class(FOOTER_LINK)], ["dev@uinaf.dev"]),
    ]),
  ]);

export const landingView = (h: H, model: Model) =>
  h.div([h.Class("h-dvh overflow-y-auto bg-bg text-fg")], [header(h), h.main([], [hero(h), examples(h, model), outro(h)])]);
