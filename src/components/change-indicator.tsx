import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";

import { cn } from "@/lib/utils";
import { formatPercent, formatUsd } from "@/lib/format";

/** Colored delta chip: green up / red down. `invert` flips semantics (for spend). */
export function ChangeIndicator({
  changeAbs,
  changePct,
  invert = false,
  compact = false,
  className,
}: {
  changeAbs: number | null;
  changePct: number | null;
  invert?: boolean;
  /** Show only the % (no absolute amount). Useful in tight rows. */
  compact?: boolean;
  className?: string;
}) {
  if (changeAbs === null) {
    return <span className={cn("text-sm text-muted-foreground", className)}>—</span>;
  }

  const up = changeAbs > 0;
  const flat = changeAbs === 0;
  const good = invert ? !up : up;

  const Icon = flat ? Minus : up ? ArrowUpRight : ArrowDownRight;
  const color = flat
    ? "text-muted-foreground"
    : good
      ? "text-positive"
      : "text-destructive";

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-sm font-medium tabular-nums",
        color,
        className,
      )}
    >
      <Icon className="size-4 shrink-0" />
      {compact ? (
        changePct !== null ? formatPercent(Math.abs(changePct)) : "nuevo"
      ) : (
        <>
          {formatUsd(Math.abs(changeAbs), { compact: Math.abs(changeAbs) >= 10000 })}
          {changePct !== null && (
            <span className="opacity-80">({formatPercent(Math.abs(changePct))})</span>
          )}
        </>
      )}
    </span>
  );
}
