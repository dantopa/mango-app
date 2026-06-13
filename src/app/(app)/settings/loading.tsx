import { Skeleton } from "@/components/ui/skeleton";

export default function SettingsLoading() {
  return (
    <div className="space-y-6 animate-in fade-in duration-200">
      {/* PageHeader */}
      <div className="space-y-1">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-5 w-80" />
      </div>

      {/* Notifications card */}
      <div className="rounded-xl border border-border bg-card shadow-sm">
        <div className="flex flex-col gap-1.5 p-6">
          <Skeleton className="h-6 w-36" />
        </div>
        <div className="space-y-6 p-6 pt-0">
          {/* Status grid */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Skeleton className="h-4 w-44" />
              <Skeleton className="h-6 w-24 rounded-md" />
            </div>
            <div className="space-y-1.5">
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-6 w-20 rounded-md" />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Skeleton className="h-4 w-36" />
              <Skeleton className="h-6 w-24 rounded-md" />
            </div>
          </div>
          {/* Action buttons */}
          <div className="flex gap-3">
            <Skeleton className="h-9 w-28 rounded-md" />
            <Skeleton className="h-9 w-28 rounded-md" />
            <Skeleton className="h-9 w-36 rounded-md" />
          </div>
        </div>
      </div>

      {/* Logs card */}
      <div className="rounded-xl border border-border bg-card shadow-sm">
        <div className="flex flex-col gap-1.5 p-6">
          <Skeleton className="h-5 w-16" />
        </div>
        <div className="p-6 pt-0">
          <Skeleton className="h-56 w-full rounded-lg" />
        </div>
      </div>
    </div>
  );
}
