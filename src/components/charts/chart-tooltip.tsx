"use client";

import { formatUsd } from "@/lib/format";

type Item = { name?: string; value?: number; color?: string; dataKey?: string };

/** Shared dark tooltip for the USD charts. */
export function MoneyTooltip({
  active,
  payload,
  label,
  labelFormatter,
  hideTotal,
}: {
  active?: boolean;
  payload?: Item[];
  label?: string;
  labelFormatter?: (label: string) => string;
  hideTotal?: boolean;
}) {
  if (!active || !payload?.length) return null;

  const rows = payload.filter((p) => (p.value ?? 0) !== 0);
  const total = rows.reduce((s, p) => s + (p.value ?? 0), 0);

  return (
    <div className="rounded-lg border border-border bg-popover/95 px-3 py-2 text-xs shadow-xl backdrop-blur">
      {label !== undefined && (
        <div className="mb-1.5 font-medium text-foreground">
          {labelFormatter ? labelFormatter(label) : label}
        </div>
      )}
      <div className="flex flex-col gap-1">
        {rows.map((p, i) => (
          <div key={i} className="flex items-center justify-between gap-4">
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <span
                className="size-2 rounded-full"
                style={{ background: p.color }}
              />
              {p.name}
            </span>
            <span className="tabular-nums font-medium text-foreground">
              {formatUsd(p.value ?? 0)}
            </span>
          </div>
        ))}
      </div>
      {!hideTotal && rows.length > 1 && (
        <div className="mt-1.5 flex items-center justify-between gap-4 border-t border-border pt-1.5">
          <span className="text-muted-foreground">Total</span>
          <span className="tabular-nums font-semibold text-foreground">
            {formatUsd(total)}
          </span>
        </div>
      )}
    </div>
  );
}
