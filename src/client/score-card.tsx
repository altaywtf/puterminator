import type { Audit } from "../shared/types";

export const fmt = (n: number) => n.toLocaleString("en-US");
export const size = (b: number) =>
  b >= 2 ** 40 ? `${(b / 2 ** 40).toFixed(1)} TB` : b >= 2 ** 30 ? `${(b / 2 ** 30).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 2 ** 20))} MB`;

function Ring({ value }: { value: number }) {
  const c = 2 * Math.PI * 28;
  return (
    <div className="relative size-16" role="img" aria-label={`Library score ${value} out of 100`}>
      <svg className="-rotate-90 size-16" viewBox="0 0 64 64">
        <circle cx="32" cy="32" r="28" fill="none" stroke="var(--secondary)" strokeWidth="5" />
        <circle
          cx="32"
          cy="32"
          r="28"
          fill="none"
          stroke="var(--foreground)"
          strokeWidth="5"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - value / 100)}
          className="transition-[stroke-dashoffset] duration-700 ease-out-quint"
        />
      </svg>
      <b className="absolute inset-0 grid place-items-center font-semibold text-lg tabular-nums tracking-tight">{value}</b>
    </div>
  );
}

function Bar({ label, value, note }: { label: string; value: number; note: string }) {
  return (
    <div className="grid grid-cols-[90px_1fr_28px] items-center gap-2.5 text-subtle-foreground" title={note}>
      <span>{label}</span>
      <span className="h-1 overflow-hidden rounded-full bg-secondary">
        <i
          className="block h-full origin-left animate-in rounded-full bg-subtle-foreground duration-700 ease-out-quint"
          style={{ transform: `scaleX(${value / 100})` }}
        />
      </span>
      <span className="text-right tabular-nums">{value}</span>
    </div>
  );
}

export function ScoreCard({ audit }: { audit: Audit }) {
  const { scores: s } = audit;
  return (
    <div className="fade-in slide-in-from-bottom-1 animate-in overflow-hidden rounded-[10px] bg-card shadow-card duration-300">
      <div className="grid grid-cols-[auto_1fr] items-center gap-5 p-4">
        <Ring value={audit.score} />
        <div className="grid gap-2">
          <Bar label="Naming" value={s.naming} note={`${fmt(audit.naming.messy)} videos keep release names`} />
          <Bar label="Structure" value={s.structure} note={`${fmt(audit.structure.wrapperFolders)} wrapper folders`} />
          <Bar label="Junk" value={s.junk} note={`${fmt(audit.junk.count)} junk files`} />
          <Bar label="Duplicates" value={s.duplicates} note={`${fmt(audit.duplicates.groups)} duplicate groups`} />
        </div>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 border-t bg-muted px-3 py-2 text-muted-foreground tabular-nums">
        <span>{fmt(audit.totals.items)} items</span>
        <span>{size(audit.totals.bytes)}</span>
        <span>{fmt(audit.junk.count)} junk</span>
        <span>{fmt(audit.duplicates.groups)} duplicates</span>
        <span>{fmt(audit.neverPlayed.count)} never played</span>
        {audit.truncated && <span className="text-warn">partial scan</span>}
      </div>
    </div>
  );
}
