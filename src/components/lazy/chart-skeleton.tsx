export function ChartSkeleton({ height = 256 }: { height?: number }) {
  return (
    <div
      className="w-full animate-pulse rounded-lg bg-muted"
      style={{ height }}
      aria-hidden="true"
    />
  );
}
