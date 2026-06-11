import { Skeleton } from "@/components/ui/skeleton";

export default function DashboardLoading() {
  return (
    <div className="space-y-4 animate-in fade-in duration-200">
      {/* PageHeader: title (text-2xl ~32px) + description (text-sm ~20px) + mb-6 */}
      <div className="mb-6 space-y-1">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-5 w-64" />
      </div>

      {/* Main grid: Net worth card (lg:col-span-2) + Goal card (lg:col-span-1) */}
      <div className="grid gap-4 lg:grid-cols-3">
        {/* Net worth card: CardHeader (~80px) + NetWorthLineChart (280px) + CardContent padding */}
        <Skeleton className="h-[400px] rounded-xl lg:col-span-2" />
        {/* Goal card: p-6 + GoalTracker content (~260px) */}
        <Skeleton className="h-[280px] rounded-xl lg:col-span-1" />
      </div>

      {/* Quick stats: 4 StatCards - padding p-4/p-5 + label + value + hint ≈ 104px */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Skeleton className="h-[104px] rounded-xl" />
        <Skeleton className="h-[104px] rounded-xl" />
        <Skeleton className="h-[104px] rounded-xl" />
        <Skeleton className="h-[104px] rounded-xl" />
      </div>

      {/* Composition chart card: CardHeader (~72px) + CompositionAreaChart (320px) + padding */}
      <Skeleton className="h-[424px] rounded-xl" />
    </div>
  );
}
