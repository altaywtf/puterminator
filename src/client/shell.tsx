import type { ReactNode } from "react";

export function Logo() {
  return (
    <span aria-hidden className="grid size-5 place-items-center rounded-md bg-foreground font-semibold text-[11px] text-chrome">
      P
    </span>
  );
}

/** Gray chrome with one inset white panel, as in design/thread-reference.html. */
export function Shell({ crumb, actions, children }: { crumb?: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="grid h-dvh">
      <main className="relative m-0 flex min-h-0 min-w-0 flex-col overflow-hidden bg-background shadow-card md:m-2 md:rounded-xl">
        <header className="flex h-11 flex-none items-center gap-2 border-b pr-3 pl-4">
          <Logo />
          <span className="font-medium">Puterminator</span>
          {crumb && (
            <>
              <span className="text-faint-foreground">/</span>
              <span className="truncate text-muted-foreground">{crumb}</span>
            </>
          )}
          <span className="grow" />
          {actions}
        </header>
        {children}
      </main>
    </div>
  );
}
