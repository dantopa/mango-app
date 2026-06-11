import { Skeleton } from "@/components/ui/skeleton";

export default function PatrimonioLoading() {
  return (
    <div className="space-y-4 animate-in fade-in duration-200">
      {/* PageHeader: title + description */}
      <div className="mb-6 space-y-1">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-5 w-44" />
      </div>

      {/* Main card: CardHeader with total (~88px) + account list items */}
      <div className="rounded-xl border border-border bg-card shadow-sm">
        {/* CardHeader: total label + big number + change indicator */}
        <div className="flex flex-wrap items-baseline justify-between gap-3 p-6">
          <div className="space-y-2">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-9 w-40" />
          </div>
          <Skeleton className="h-6 w-24" />
        </div>

        {/* Account list (mobile): each item ~88px (py-3 + balance + sparkline) */}
        <div className="divide-y divide-border md:hidden">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex flex-col gap-2 px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <Skeleton className="h-5 w-32" />
                <Skeleton className="h-5 w-20" />
              </div>
              <Skeleton className="h-8 w-full rounded" />
            </div>
          ))}
        </div>

        {/* Account table (desktop): each row ~52px */}
        <div className="hidden md:block">
          <div className="space-y-1 p-4">
            <Skeleton className="h-10 w-full rounded-lg" />
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-[52px] w-full rounded-lg" />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
