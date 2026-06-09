"use client";

import { Card, CardContent } from "@/components/ui/card";
import { useSemaphore } from "@/hooks/use-semaphore";
import { BudgetSettings } from "@/components/budget-settings";

const STATE_CONFIG = {
  verde: {
    label: "En buen ritmo",
    color: "bg-emerald-500",
    textColor: "text-emerald-600",
    trackColor: "bg-emerald-100",
  },
  amarillo: {
    label: "Cuidado — por encima del ritmo",
    color: "bg-amber-500",
    textColor: "text-amber-600",
    trackColor: "bg-amber-100",
  },
  rojo: {
    label: "Presupuesto agotado",
    color: "bg-red-500",
    textColor: "text-red-600",
    trackColor: "bg-red-100",
  },
} as const;

function formatUSD(value: number): string {
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

export function SemaphoreGauge() {
  const { data, isLoading, error } = useSemaphore();

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex flex-col gap-3 p-4 sm:p-5">
          <div className="h-4 w-32 animate-pulse rounded bg-muted" />
          <div className="h-3 w-full animate-pulse rounded bg-muted" />
          <div className="h-4 w-48 animate-pulse rounded bg-muted" />
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardContent className="p-4 sm:p-5">
          <span className="text-sm text-muted-foreground">
            No se pudo cargar el semáforo
          </span>
        </CardContent>
      </Card>
    );
  }

  // No ceiling configured — show CTA to set it up
  if (!data) {
    return (
      <Card>
        <CardContent className="flex flex-col gap-3 p-4 sm:p-5">
          <span className="text-xs text-muted-foreground sm:text-sm">
            Presupuesto mensual
          </span>
          <p className="text-sm font-medium">
            Configurá tu techo mensual para activar el semáforo
          </p>
          <BudgetSettings />
        </CardContent>
      </Card>
    );
  }

  const config = STATE_CONFIG[data.state];
  const pctClamped = Math.min(data.pct, 1); // clamp for visual bar (can exceed 100%)

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-4 sm:p-5">
        {/* Header */}
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-xs text-muted-foreground sm:text-sm">
            Presupuesto mensual
          </span>
          <span className={`text-xs font-medium sm:text-sm ${config.textColor}`}>
            {config.label}
          </span>
        </div>

        {/* Progress bar */}
        <div className={`h-3 w-full overflow-hidden rounded-full ${config.trackColor}`}>
          <div
            className={`h-full rounded-full transition-all duration-500 ${config.color}`}
            style={{ width: `${Math.round(pctClamped * 100)}%` }}
          />
        </div>

        {/* Stats row */}
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-lg font-semibold tabular-nums tracking-tight sm:text-xl">
            {formatUSD(data.spent)}
            <span className="text-sm font-normal text-muted-foreground">
              {" "}/ {formatUSD(data.ceiling)}
            </span>
          </span>
          <span className="text-sm tabular-nums text-muted-foreground">
            {Math.round(data.pct * 100)}%
          </span>
        </div>

        {/* Rolling daily budget */}
        <div className="text-sm text-muted-foreground">
          Hoy podés gastar:{" "}
          <span className={`font-medium ${config.textColor}`}>
            {formatUSD(data.daily_budget)} USD/día
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
