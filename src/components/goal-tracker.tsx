import { CheckCircle2, TrendingUp, AlertTriangle } from "lucide-react";

import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatPercent, formatUsd, formatDate } from "@/lib/format";
import type { GoalProgress } from "@/lib/analytics";

export function GoalTracker({ progress }: { progress: GoalProgress }) {
  const { goal, current, progressPct, remaining, monthsRemaining } = progress;
  const { requiredMonthlyUsd, actualMonthlyUsd, onTrack, projectedDate } = progress;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-sm text-muted-foreground">Objetivo activo</div>
          <div className="text-lg font-semibold">{goal.name}</div>
        </div>
        {onTrack ? (
          <Badge variant="positive" className="gap-1">
            <CheckCircle2 className="size-3.5" /> Vas en ritmo
          </Badge>
        ) : (
          <Badge variant="destructive" className="gap-1">
            <AlertTriangle className="size-3.5" /> Te falta ritmo
          </Badge>
        )}
      </div>

      <div>
        <div className="mb-1.5 flex items-baseline justify-between">
          <span className="text-2xl font-semibold tabular-nums">
            {formatUsd(current, { compact: true })}
          </span>
          <span className="text-sm text-muted-foreground tabular-nums">
            de {formatUsd(goal.target_usd, { compact: true })}
          </span>
        </div>
        <Progress
          value={progressPct * 100}
          indicatorClassName={onTrack ? "bg-positive" : "bg-primary"}
        />
        <div className="mt-1.5 flex justify-between text-xs text-muted-foreground">
          <span>{formatPercent(progressPct)} completado</span>
          <span>Faltan {formatUsd(remaining, { compact: true })}</span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 text-sm">
        <Metric
          label="Ritmo requerido"
          value={`${formatUsd(requiredMonthlyUsd, { compact: true })}/mes`}
          hint={`para llegar el ${formatDate(goal.target_date)}`}
        />
        <Metric
          label="Tu ritmo real"
          value={`${formatUsd(actualMonthlyUsd, { compact: true })}/mes`}
          hint={`${monthsRemaining.toFixed(1)} meses restantes`}
          accent={onTrack ? "positive" : "destructive"}
        />
      </div>

      <div
        className={cn(
          "flex items-start gap-2 rounded-lg border p-3 text-sm",
          onTrack
            ? "border-positive/30 bg-positive/10 text-positive"
            : "border-destructive/30 bg-destructive/10 text-destructive",
        )}
      >
        <TrendingUp className="mt-0.5 size-4 shrink-0" />
        <span>
          {onTrack ? (
            <>
              Mantené tu ritmo y llegás
              {projectedDate ? <> alrededor del {formatDate(projectedDate)}</> : null}.
            </>
          ) : (
            <>
              A tu ritmo actual te quedás corto. Necesitás{" "}
              <strong>
                {formatUsd(Math.max(requiredMonthlyUsd - actualMonthlyUsd, 0), {
                  compact: true,
                })}
                /mes
              </strong>{" "}
              extra.
            </>
          )}
        </span>
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  hint,
  accent,
}: {
  label: string;
  value: string;
  hint?: string;
  accent?: "positive" | "destructive";
}) {
  return (
    <div className="rounded-lg bg-secondary/50 p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        className={cn(
          "text-base font-semibold tabular-nums",
          accent === "positive" && "text-positive",
          accent === "destructive" && "text-destructive",
        )}
      >
        {value}
      </div>
      {hint && <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}
