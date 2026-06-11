import { Skeleton } from "@/components/ui/skeleton";

export default function CierreLoading() {
  return (
    <div className="space-y-4 animate-in fade-in duration-200">
      {/* PageHeader: title + description */}
      <div className="mb-6 space-y-1">
        <Skeleton className="h-8 w-44" />
        <Skeleton className="h-5 w-72" />
      </div>

      {/* CloseCard: CardHeader (title + progress) + item list */}
      <div className="rounded-xl border border-border bg-card shadow-sm">
        {/* CardHeader: title row + progress bar */}
        <div className="flex flex-col gap-3 p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-1">
              <Skeleton className="h-6 w-32" />
              <Skeleton className="h-4 w-44" />
            </div>
            <Skeleton className="h-9 w-28 rounded-md" />
          </div>
          <Skeleton className="h-2 w-full rounded-full" />
        </div>

        {/* Checklist items: each ~56px (py-3 + source name + help text + action buttons) */}
        <div className="divide-y divide-border">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="flex items-center justify-between gap-3 px-4 py-3 sm:px-6">
              <div className="flex items-center gap-3">
                <Skeleton className="size-5 rounded-full" />
                <div className="space-y-1">
                  <Skeleton className="h-5 w-28" />
                  <Skeleton className="h-3 w-40" />
                </div>
              </div>
              <Skeleton className="h-8 w-28 rounded-md" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
