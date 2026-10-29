import { useAgentChat } from "@cloudflare/ai-chat/react";
import { useAgent } from "agents/react";
import type { UIMessage } from "ai";
import { ArrowUpIcon, ChevronRightIcon, FolderIcon, HistoryIcon, SquareIcon, XCircleIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput, type ToolPart } from "@/components/ai-elements/tool";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { type AgentState, type Audit, creditsLeft } from "../shared/types";
import { fmt, ScoreCard, size } from "./score-card";
import { Shell } from "./shell";

type Folder = { id: number; name: string };
const ROOT: Folder = { id: 0, name: "Your Files" };

const STARTERS = ["Audit my library", "What did I never play?", "Find junk files", "Which duplicates do I have?"];

// ---------- tool steps ----------

type Out = Record<string, unknown> | undefined;
const num = (v: unknown) => (typeof v === "number" ? v : 0);

function describe(name: string, part: ToolPart): { title: string; detail?: string; lines?: string[] } {
  const out = part.state === "output-available" ? (part.output as Out) : undefined;
  const input = (part.input ?? {}) as Record<string, unknown>;
  if (out && typeof out.error === "string") return { title: "Couldn't run " + name, lines: [out.error] };
  if (name === "scan_library") {
    const a = out as Audit | undefined;
    return {
      title: "Read the library",
      detail: a ? `${fmt(a.totals.items)} items · ${size(a.totals.bytes)}` : undefined,
      lines: a && [
        `release names   ${fmt(a.naming.messy)} videos`,
        `wrapper folders   ${fmt(a.structure.wrapperFolders)}`,
        `junk   ${fmt(a.junk.count)} files · ${size(a.junk.bytes)}`,
        `duplicates   ${fmt(a.duplicates.groups)} groups`,
      ],
    };
  }
  if (name === "list_folder") {
    return {
      title: `Open ${String(input.path || "/")}`,
      detail: out ? `${fmt(num(out.count))} items` : undefined,
    };
  }
  if (name === "search_files") {
    const what = [input.category && input.category !== "any" ? String(input.category).replace("_", " ") : null, input.query ? `"${input.query}"` : null]
      .filter(Boolean)
      .join(" ");
    const items = (out?.items as { path: string }[] | undefined) ?? [];
    return {
      title: `Search ${what || "files"}`,
      detail: out ? `${fmt(num(out.total))} matches` : undefined,
      lines: items.slice(0, 6).map((i) => i.path),
    };
  }
  return { title: name };
}

function Step({ part }: { part: ToolPart }) {
  const name = part.type === "dynamic-tool" ? part.toolName : part.type.slice(5);
  const d = describe(name, part);
  return (
    <>
      <Tool>
        <ToolHeader detail={d.detail} state={part.state} title={d.title} />
        <ToolContent>
          <ToolInput input={part.input} name={name} />
          <ToolOutput errorText={part.errorText} lines={d.lines} />
        </ToolContent>
      </Tool>
      {name === "scan_library" && part.state === "output-available" && !(part.output as Out)?.error && (
        <ScoreCard audit={part.output as Audit} />
      )}
    </>
  );
}

// ---------- messages ----------

function AssistantParts({ message, streaming }: { message: UIMessage; streaming: boolean }) {
  return message.parts.map((part, i) => {
    const key = `${message.id}-${i}`;
    if (part.type === "text") return <MessageResponse key={key}>{part.text}</MessageResponse>;
    if (part.type === "reasoning") {
      if (!part.text.trim()) return null;
      return (
        <Reasoning isStreaming={streaming && i === message.parts.length - 1} key={key}>
          <ReasoningTrigger />
          <ReasoningContent>{part.text}</ReasoningContent>
        </Reasoning>
      );
    }
    if (part.type.startsWith("tool-") || part.type === "dynamic-tool") return <Step key={key} part={part as ToolPart} />;
    return null;
  });
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
  const [state, setState] = useState<AgentState | null>(null);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [folder, setFolder] = useState<Folder>(ROOT);
  const folderRef = useRef(folder);
  folderRef.current = folder;

  const agent = useAgent<AgentState>({
    agent: "puterminator",
    basePath: "agent",
    onStateUpdate: (s) => {
      setState(s);
      setFolder((f) => (f.id === ROOT.id && s.folder.id !== ROOT.id ? s.folder : f));
    },
  });
  const { messages, sendMessage, status, stop, error } = useAgentChat({ agent, body: () => ({ folder: folderRef.current }) });

  useEffect(() => {
    fetch("/api/folders")
      .then((r) => (r.ok ? (r.json() as Promise<Folder[]>) : []))
      .then(setFolders)
      .catch(() => setFolders([]));
  }, []);

  const busy = status === "submitted" || status === "streaming";
  const send = (text: string) => sendMessage({ role: "user", parts: [{ type: "text", text }] });
  const signOut = async () => {
    await fetch("/auth/logout", { method: "POST" });
    location.reload();
  };

  const composer = (placeholder: string) => (
    <Composer
      busy={busy}
      credits={state ? creditsLeft(state.credits) : 0}
      folder={folder}
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

  return (
    <Shell
      actions={
        <button className="flex h-7 items-center gap-1 rounded-md px-2 text-muted-foreground hover:bg-secondary hover:text-foreground" onClick={signOut} type="button">
          {state?.username ?? "…"}
          <ChevronRightIcon className="size-3.5 rotate-90" />
        </button>
      }
      crumb={folder.name}
    >
      {messages.length === 0 ? (
        <div className="mx-auto grid w-full max-w-[680px] gap-[18px] px-5 pt-[14vh] pb-10">
          <h1 className="text-balance text-center font-medium text-xl tracking-tight">What should I do with your put.io?</h1>
          <p className="-mt-2.5 text-center text-muted-foreground">
            I read your files, score the library and answer questions. This version changes nothing.
          </p>
          {memory}
          {composer("Ask Puterminator…")}
          <Chips items={STARTERS} onPick={send} />
        </div>
      ) : (
        <>
          <Conversation className="flex-1">
            <ConversationContent className="mx-auto grid w-full max-w-[680px] gap-[18px] px-5 pt-7 pb-[200px]">
              {messages.map((m, i) =>
                m.role === "user" ? (
                  <Message from="user" key={m.id}>
                    <MessageContent className="max-w-[80%] whitespace-pre-wrap rounded-xl px-3 py-2 text-[13px]">
                      {m.parts.map((p) => (p.type === "text" ? p.text : "")).join("")}
                    </MessageContent>
                  </Message>
                ) : (
                  <Message from="assistant" key={m.id}>
                    <MessageContent className="w-full gap-2.5 text-[13px]">
                      <AssistantParts message={m} streaming={busy && i === messages.length - 1} />
                    </MessageContent>
                  </Message>
                ),
              )}
              {status === "submitted" && (
                <div className="flex h-6 items-center gap-2 text-muted-foreground">
                  <span className="size-3 animate-spin rounded-full border-[1.5px] border-border-strong border-t-subtle-foreground" />
                  <span className="shimmer">Working</span>
                </div>
              )}
              {error && (
                <div className="flex items-center gap-2 text-destructive">
                  <XCircleIcon className="size-3.5" />
                  <span>Something broke on my side. Try again in a moment.</span>
                </div>
              )}
              {!busy && !error && messages.at(-1)?.role === "assistant" && (
                <Chips items={STARTERS.filter((s) => !messages.some((m) => m.parts.some((p) => p.type === "text" && p.text === s)))} onPick={send} />
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
