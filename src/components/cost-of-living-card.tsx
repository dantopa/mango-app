import { Wallet } from "lucide-react";

import { formatUsd } from "@/lib/format";
import type { CostOfLiving } from "@/lib/analytics";
import { Card, CardContent } from "@/components/ui/card";

/**
 * Highlights the monthly cost of living: fixed (unavoidable) spend plus the
 * recent average of variable (attackable) spend. Drives savings capacity.
 */
export function CostOfLivingCard({ data }: { data: CostOfLiving }) {
  const fixedPct = data.total > 0 ? (data.fixed / data.total) * 100 : 0;

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-4 sm:p-5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm text-muted-foreground">Costo de vida mensual</span>
          <Wallet className="size-4 text-muted-foreground" />
        </div>

        <div className="flex flex-wrap items-baseline gap-2">
          <span className="text-2xl font-semibold tabular-nums tracking-tight sm:text-3xl">
            {formatUsd(data.total)}
          </span>
          <span className="text-xs text-muted-foreground">
            estimado / mes
          </span>
        </div>

        {/* Fixed vs variable proportion */}
        <div className="flex h-2 w-full overflow-hidden rounded-full bg-secondary">
          <div className="h-full bg-[#3b82f6]" style={{ width: `${fixedPct}%` }} />
          <div className="h-full flex-1 bg-[#f59e0b]" />
        </div>

        <div className="grid grid-cols-2 gap-3 text-sm">
          <div className="flex flex-col gap-0.5">
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <span className="size-2 rounded-full bg-[#3b82f6]" />
              Fijo (inevitable)
            </span>
            <span className="font-medium tabular-nums">{formatUsd(data.fixed)}</span>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <span className="size-2 rounded-full bg-[#f59e0b]" />
              Variable (atacable)
            </span>
            <span className="font-medium tabular-nums">
              {formatUsd(data.variableAvg)}
              {data.monthsAveraged > 1 && (
                <span className="ml-1 text-xs text-muted-foreground">
                  prom. {data.monthsAveraged}m
                </span>
              )}
            </span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
