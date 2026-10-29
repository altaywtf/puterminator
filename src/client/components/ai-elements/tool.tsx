"use client";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { ChevronRightIcon, WrenchIcon, XCircleIcon } from "lucide-react";
import type { ComponentProps } from "react";

// Restyled from AI Elements: a folded one-line step (Linear/Cursor style)
// instead of a bordered card with a status badge.

export type ToolProps = ComponentProps<typeof Collapsible>;

export const Tool = ({ className, ...props }: ToolProps) => (
  <Collapsible className={cn("group not-prose grid gap-1", className)} {...props} />
);

export type ToolState = "running" | "done" | "error";

export type ToolHeaderProps = {
  title: string;
  detail?: string;
  state: ToolState;
  className?: string;
};

export const ToolHeader = ({ className, title, detail, state }: ToolHeaderProps) =>
  state === "running" ? (
    <div className={cn("flex h-6 items-center gap-2 text-muted-foreground", className)}>
      <span className="size-3 flex-none animate-spin rounded-full border-[1.5px] border-border-strong border-t-subtle-foreground" />
      <span className="shimmer">{title}</span>
      {detail && <span className="tabular-nums">· {detail}</span>}
    </div>
  ) : (
    <CollapsibleTrigger
      className={cn(
        "flex h-6 w-fit max-w-full items-center gap-2 rounded-md text-muted-foreground [&:hover_.name]:text-foreground",
        className,
      )}
    >
      {state === "error" ? (
        <XCircleIcon className="size-3.5 flex-none text-destructive" />
      ) : (
        <WrenchIcon className="size-3.5 flex-none" />
      )}
      <span className="name text-subtle-foreground transition-colors">{title}</span>
      {detail && <span className="truncate tabular-nums">· {detail}</span>}
      <ChevronRightIcon className="size-3.5 flex-none transition-transform group-data-[state=open]:rotate-90" />
    </CollapsibleTrigger>
  );

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>;

export const ToolContent = ({ className, ...props }: ToolContentProps) => (
  <CollapsibleContent
    className={cn(
      "ms-1.5 grid gap-0.5 border-border-strong border-s py-0.5 ps-3.5 font-mono text-[11.5px] text-muted-foreground",
      className,
    )}
    {...props}
  />
);

export type ToolInputProps = ComponentProps<"div"> & {
  name: string;
  input: unknown;
};

export const ToolInput = ({ className, name, input, ...props }: ToolInputProps) => (
  <div className={cn("truncate text-subtle-foreground", className)} {...props}>
    {name}({input && typeof input === "object" && Object.keys(input).length ? JSON.stringify(input) : ""})
  </div>
);

export type ToolOutputProps = ComponentProps<"div"> & {
  lines?: string[];
  errorText?: string;
};

export const ToolOutput = ({ className, lines, errorText, ...props }: ToolOutputProps) => (
  <div className={cn("grid gap-0.5", className)} {...props}>
    {errorText && <div className="text-destructive">{errorText}</div>}
    {lines?.map((l, i) => (
      <div className="truncate" key={i}>
        {l}
      </div>
    ))}
  </div>
);
