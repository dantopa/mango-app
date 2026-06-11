import { Skeleton } from "@/components/ui/skeleton";

export default function PatrimonioLoading() {
  return (
    <div className="space-y-6 animate-in fade-in duration-200">
      {/* Header */}
      <div className="space-y-2">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-5 w-24" />
      </div>

      {/* Total card */}
      <Skeleton className="h-28 rounded-xl" />

      {/* Accounts list */}
      <div className="space-y-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full rounded-xl" />
        ))}
      </div>
    </div>
  );
}
