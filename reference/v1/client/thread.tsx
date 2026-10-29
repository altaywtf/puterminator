import { ArrowUpIcon, ChevronRightIcon, FolderIcon, HistoryIcon, SquareIcon, XCircleIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Conversation, ConversationContent, ConversationScrollButton } from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import {
  PromptInput,
  PromptInputBody,
  PromptInputButton,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "@/components/ai-elements/prompt-input";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from "@/components/ai-elements/tool";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { type Audit, creditsLeft } from "../shared/types";
import { fmt, ScoreCard, size } from "./score-card";
import { Shell } from "./shell";
import { type Folder, type Item, useThread } from "./use-thread";

const ROOT: Folder = { id: 0, name: "Your Files" };

const STARTERS = ["Audit my library", "What did I never play?", "Find junk files", "Which duplicates do I have?"];

// ---------- tool steps ----------

type Out = Record<string, unknown> | null;
const num = (v: unknown) => (typeof v === "number" ? v : 0);
const parse = (s: string | null): Out => {
  if (!s) return null;
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return { error: s };
  }
};

function describe(name: string, input: Record<string, unknown>, out: Out): { title: string; detail?: string; lines?: string[] } {
  if (out && typeof out.error === "string") return { title: `Couldn't run ${name}`, lines: [out.error] };
  if (name === "scan_library") {
    const a = out as Audit | null;
    return {
      title: "Read the library",
      detail: a ? `${fmt(a.totals.items)} items · ${size(a.totals.bytes)}` : undefined,
      lines: a
        ? [
            `release names   ${fmt(a.naming.messy)} videos`,
            `wrapper folders   ${fmt(a.structure.wrapperFolders)}`,
            `junk   ${fmt(a.junk.count)} files · ${size(a.junk.bytes)}`,
            `duplicates   ${fmt(a.duplicates.groups)} groups`,
          ]
        : undefined,
    };
  }
  if (name === "list_folder") return { title: `Open ${String(input.path || "/")}`, detail: out ? `${fmt(num(out.count))} items` : undefined };
  if (name === "search_files") {
    const what = [input.category && input.category !== "any" ? String(input.category).replace("_", " ") : null, input.query ? `"${input.query}"` : null]
      .filter(Boolean)
      .join(" ");
    const items = (out?.items as { path: string }[] | undefined) ?? [];
    return { title: `Search ${what || "files"}`, detail: out ? `${fmt(num(out.total))} matches` : undefined, lines: items.slice(0, 6).map((i) => i.path) };
  }
  return { title: name };
}

function Step({ item }: { item: Extract<Item, { kind: "tool" }> }) {
  const out = parse(item.output);
  const input = (item.input ?? {}) as Record<string, unknown>;
  const d = describe(item.name, input, out);
  return (
    <>
      <Tool>
        <ToolHeader detail={d.detail} state={item.state} title={d.title} />
        <ToolContent>
          <ToolInput input={item.input} name={item.name} />
          <ToolOutput lines={d.lines} />
        </ToolContent>
      </Tool>
      {item.name === "scan_library" && item.state === "done" && out && !out.error && <ScoreCard audit={out as unknown as Audit} />}
    </>
  );
}

function AssistantItem({ item }: { item: Item }) {
  if (item.kind === "text") return <MessageResponse>{item.text}</MessageResponse>;
  if (item.kind === "thinking")
    return (
      <Reasoning isStreaming={item.streaming}>
        <ReasoningTrigger />
        <ReasoningContent>{item.text}</ReasoningContent>
      </Reasoning>
    );
  if (item.kind === "tool") return <Step item={item} />;
  return null;
}

function Chips({ items, onPick }: { items: string[]; onPick: (s: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((s) => (
        <button
          className="h-7 rounded-lg bg-card px-2.5 text-[12.5px] text-subtle-foreground shadow-card transition-[background-color,transform] hover:bg-muted hover:text-foreground active:scale-[0.96]"
          key={s}
          onClick={() => onPick(s)}
          type="button"
        >
          {s}
        </button>
      ))}
    </div>
  );
}

// ---------- composer ----------

function Composer(props: {
  placeholder: string;
  busy: boolean;
  folder: Folder;
  folders: Folder[];
  credits: number;
  onFolder: (f: Folder) => void;
  onSend: (text: string) => void;
  onStop: () => void;
}) {
  const pick = "h-[26px] gap-1 rounded-md px-2 text-[12.5px] font-normal text-subtle-foreground";
  return (
    <PromptInput
      onSubmit={(m) => {
        if (m.text.trim()) props.onSend(m.text.trim());
      }}
    >
      <PromptInputBody>
        <PromptInputTextarea
          className="min-h-[34px] px-3.5 pt-2.5 text-base md:text-[13.5px]"
          placeholder={props.placeholder}
        />
      </PromptInputBody>
      <PromptInputFooter className="px-2 pb-2">
        <PromptInputTools>
          <span className="flex h-[26px] items-center px-2 text-[12.5px] text-subtle-foreground" title="Model">
            Sonnet 5.5
          </span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <PromptInputButton className={pick} size="xs" title="Target folder">
                <FolderIcon className="size-3.5" />
                {props.folder.name}
              </PromptInputButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-72">
              {[ROOT, ...props.folders].map((f) => (
                <DropdownMenuItem key={f.id} onSelect={() => props.onFolder(f)}>
                  <FolderIcon className="size-3.5" />
                  {f.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </PromptInputTools>
        <div className="flex items-center gap-1">
          <span className="px-2 text-[12.5px] text-subtle-foreground tabular-nums">{fmt(props.credits)} credits</span>
          <PromptInputSubmit
            className="size-7 rounded-full"
            onStop={props.onStop}
            status={props.busy ? "streaming" : "ready"}
          >
            {props.busy ? <SquareIcon className="size-3 fill-current" /> : <ArrowUpIcon className="size-3.5" />}
          </PromptInputSubmit>
        </div>
      </PromptInputFooter>
    </PromptInput>
  );
}

// ---------- thread ----------

export function Thread() {
  const { state, turns, busy, error, send: post, stop } = useThread();
  const [folders, setFolders] = useState<Folder[]>([]);
  const [folder, setFolder] = useState<Folder | null>(null);
  const target = folder ?? state?.folder ?? ROOT;

  useEffect(() => {
    fetch("/api/folders")
      .then((r) => (r.ok ? (r.json() as Promise<Folder[]>) : []))
      .then(setFolders)
      .catch(() => setFolders([]));
  }, []);

  const send = (text: string) => post(text, target);
  const signOut = async () => {
    await fetch("/auth/logout", { method: "POST" });
    location.reload();
  };

  const composer = (placeholder: string) => (
    <Composer
      busy={busy}
      credits={state ? creditsLeft(state.credits) : 0}
      folder={target}
      folders={folders}
      onFolder={setFolder}
      onSend={send}
      onStop={stop}
      placeholder={placeholder}
    />
  );

  const last = state?.lastAudit;
  const memory = last && (
    <div className="flex items-center justify-center gap-2 text-[12.5px] text-muted-foreground">
      <HistoryIcon className="size-3.5" />
      <span>
        Last time, {new Date(last.at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}: read {fmt(last.items)} items in{" "}
        {last.rootName}, score {last.score}.
      </span>
    </div>
  );
  const asked = new Set(turns.flatMap((t) => t.items.flatMap((i) => (i.kind === "user" ? [i.text] : []))));
  const waiting = busy && turns.at(-1)?.role === "user";

  return (
    <Shell
      actions={
        <button className="flex h-7 items-center gap-1 rounded-md px-2 text-muted-foreground hover:bg-secondary hover:text-foreground" onClick={signOut} type="button">
          {state?.username ?? "…"}
          <ChevronRightIcon className="size-3.5 rotate-90" />
        </button>
      }
      crumb={target.name}
    >
      {turns.length === 0 ? (
        <div className="mx-auto grid w-full max-w-[680px] gap-[18px] px-5 pt-[14vh] pb-10">
          <h1 className="text-balance text-center font-medium text-xl tracking-tight">What should I do with your put.io?</h1>
          <p className="-mt-2.5 text-center text-muted-foreground">
            I read your files, score the library and answer questions. This version changes nothing.
          </p>
          {memory}
          {composer("Ask puterminator…")}
          <Chips items={STARTERS} onPick={send} />
        </div>
      ) : (
        <>
          <Conversation className="flex-1">
            <ConversationContent className="mx-auto grid w-full max-w-[680px] gap-[18px] px-5 pt-7 pb-[200px]">
              {turns.map((t) =>
                t.role === "user" ? (
                  <Message from="user" key={t.key}>
                    <MessageContent className="max-w-[80%] whitespace-pre-wrap rounded-xl px-3 py-2 text-[13px]">
                      {t.items[0]?.kind === "user" ? t.items[0].text : ""}
                    </MessageContent>
                  </Message>
                ) : (
                  <Message from="assistant" key={t.key}>
                    <MessageContent className="w-full gap-2.5 text-[13px]">
                      {t.items.map((i) => (
                        <AssistantItem item={i} key={i.key} />
                      ))}
                    </MessageContent>
                  </Message>
                ),
              )}
              {waiting && (
                <div className="flex h-6 items-center gap-2 text-muted-foreground">
                  <span className="size-3 animate-spin rounded-full border-[1.5px] border-border-strong border-t-subtle-foreground" />
                  <span className="shimmer">Working</span>
                </div>
              )}
              {error && (
                <div className="flex items-center gap-2 text-destructive">
                  <XCircleIcon className="size-3.5" />
                  <span>{error}</span>
                </div>
              )}
              {!busy && !error && turns.at(-1)?.role === "assistant" && (
                <Chips items={STARTERS.filter((s) => !asked.has(s))} onPick={send} />
              )}
            </ConversationContent>
            <ConversationScrollButton className="bottom-36" />
          </Conversation>
          <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-b from-transparent to-40% to-background px-5 pb-4">
            <div className="pointer-events-auto mx-auto max-w-[680px]">{composer("Reply…")}</div>
          </div>
        </>
      )}
    </Shell>
  );
}
