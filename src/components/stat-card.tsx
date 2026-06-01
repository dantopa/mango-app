import { Card, CardContent } from "@/components/ui/card";

export function StatCard({
  label,
  value,
  hint,
  icon,
  className,
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  icon?: React.ReactNode;
  className?: string;
}) {
  return (
    <Card className={className}>
      <CardContent className="flex flex-col gap-1 p-4 sm:p-5">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-xs text-muted-foreground sm:text-sm">{label}</span>
          {icon && <span className="shrink-0 text-muted-foreground">{icon}</span>}
        </div>
        <span className="text-xl font-semibold tabular-nums tracking-tight sm:text-2xl">
          {value}
        </span>
        {hint && (
          <div className="truncate text-xs text-muted-foreground sm:text-sm">{hint}</div>
        )}
      </CardContent>
    </Card>
  );
}
