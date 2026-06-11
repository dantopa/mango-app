import { Skeleton } from "@/components/ui/skeleton";

export default function ObjetivosLoading() {
  return (
    <div className="space-y-4 animate-in fade-in duration-200">
      {/* PageHeader: title + description + "Nuevo objetivo" button */}
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <Skeleton className="h-8 w-36" />
          <Skeleton className="h-5 w-64" />
        </div>
        <Skeleton className="h-9 w-36 rounded-md" />
      </div>

      {/* Active goal cards: p-6 + GoalTracker (~280px total with progress, metrics, projections) */}
      <div className="flex flex-col gap-4">
        <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
          {/* Edit/delete buttons row */}
          <div className="mb-2 flex justify-end gap-1">
            <Skeleton className="size-9 rounded-md" />
            <Skeleton className="size-9 rounded-md" />
          </div>
          {/* GoalTracker: header + progress bar + metrics grid + projection banner */}
          <div className="flex flex-col gap-4">
            <div className="flex items-start justify-between gap-2">
              <div className="space-y-1">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-6 w-40" />
              </div>
              <Skeleton className="h-6 w-28 rounded-full" />
            </div>
            <div className="space-y-1.5">
              <div className="flex justify-between">
                <Skeleton className="h-8 w-24" />
                <Skeleton className="h-4 w-20" />
              </div>
              <Skeleton className="h-3 w-full rounded-full" />
              <div className="flex justify-between">
                <Skeleton className="h-3 w-24" />
                <Skeleton className="h-3 w-28" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Skeleton className="h-[72px] rounded-lg" />
              <Skeleton className="h-[72px] rounded-lg" />
            </div>
            <Skeleton className="h-[52px] rounded-lg" />
          </div>
        </div>
      </div>
    </div>
  );
}
