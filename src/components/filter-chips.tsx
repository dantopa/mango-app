"use client";

import { cn } from "@/lib/utils";

export type ChipOption = { value: string; label: string; color?: string };

/**
 * A row of toggleable filter chips (multi-select facet). Touch-friendly and
 * wraps on mobile. `selected` is a Set; `onToggle` flips one value.
 */
export function FilterChips({
  label,
  options,
  selected,
  onToggle,
}: {
  label: string;
  options: ChipOption[];
  selected: Set<string>;
  onToggle: (value: string) => void;
}) {
  if (options.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <div className="flex flex-wrap gap-1.5">
        {options.map((o) => {
          const active = selected.has(o.value);
          return (
            <button
              key={o.value}
              type="button"
              onClick={() => onToggle(o.value)}
              aria-pressed={active}
              className={cn(
                "inline-flex min-h-8 items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                active
                  ? "border-primary bg-primary/15 text-foreground"
                  : "border-border text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
              )}
            >
              {o.color && (
                <span className="size-2 shrink-0 rounded-full" style={{ background: o.color }} />
              )}
              <span className="truncate">{o.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
