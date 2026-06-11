import { Skeleton } from "@/components/ui/skeleton";

export default function CierreLoading() {
  return (
    <div className="space-y-6 animate-in fade-in duration-200">
      {/* Header */}
      <div className="flex items-center justify-between">
        <Skeleton className="h-8 w-44" />
        <Skeleton className="h-9 w-32 rounded-md" />
      </div>

      {/* Status card */}
      <Skeleton className="h-24 rounded-xl" />

      {/* Checklist items */}
      <div className="space-y-3">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-14 w-full rounded-xl" />
        ))}
      </div>

      {/* Summary */}
      <Skeleton className="h-32 rounded-xl" />
    </div>
  );
}
