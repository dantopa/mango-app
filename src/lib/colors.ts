/** Categorical palette for charts that don't carry their own color (accounts). */
export const CHART_PALETTE = [
  "#8b5cf6", // violet
  "#22c55e", // green
  "#3b82f6", // blue
  "#f97316", // orange
  "#ec4899", // pink
  "#06b6d4", // cyan
  "#eab308", // yellow
  "#ef4444", // red
  "#14b8a6", // teal
  "#a855f7", // purple
];

export function paletteColor(index: number): string {
  return CHART_PALETTE[index % CHART_PALETTE.length];
}
