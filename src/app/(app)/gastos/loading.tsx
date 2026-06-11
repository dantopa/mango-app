import { Skeleton } from "@/components/ui/skeleton";

export default function GastosLoading() {
  return (
    <div className="space-y-4 animate-in fade-in duration-200">
      {/* PageHeader: title + description + action row (with button, switch, select) */}
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-5 w-72" />
        </div>
        <div className="flex items-center gap-3">
          <Skeleton className="h-9 w-28 rounded-md" />
          <Skeleton className="h-5 w-36" />
          <Skeleton className="h-9 w-40 rounded-md" />
        </div>
      </div>

      {/* Summary StatCards: p-4 + label + value + hint ≈ 104px */}
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <Skeleton className="h-[104px] rounded-xl" />
        <Skeleton className="h-[104px] rounded-xl" />
        <Skeleton className="h-[104px] rounded-xl" />
        <Skeleton className="h-[104px] rounded-xl" />
      </div>

      {/* Cost of living card */}
      <Skeleton className="h-[120px] rounded-xl" />

      {/* Filters card */}
      <Skeleton className="h-[160px] rounded-xl" />

      {/* Category charts: 2-col grid, each card with header + chart (280px) */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-[380px] rounded-xl" />
        <Skeleton className="h-[380px] rounded-xl" />
      </div>

      {/* Dimension breakdowns: 3-col grid */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Skeleton className="h-[360px] rounded-xl" />
        <Skeleton className="h-[360px] rounded-xl" />
        <Skeleton className="h-[360px] rounded-xl" />
      </div>

      {/* Transactions table card */}
      <Skeleton className="h-[400px] rounded-xl" />
    </div>
  );
}
