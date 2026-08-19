import dynamic from "next/dynamic";
import { ChartSkeleton } from "./chart-skeleton";

// --- Chart components (lazy-loaded with skeleton placeholder) ---

export const LazyNetWorthLineChart = dynamic(
  () =>
    import("@/components/charts/net-worth-line-chart").then((m) => ({
      default: m.NetWorthLineChart,
    })),
  { loading: () => <ChartSkeleton height={280} /> }
);

export const LazyCompositionAreaChart = dynamic(
  () =>
    import("@/components/charts/composition-area-chart").then((m) => ({
      default: m.CompositionAreaChart,
    })),
  { loading: () => <ChartSkeleton height={320} /> }
);

export const LazyCategoryPieChart = dynamic(
  () =>
    import("@/components/charts/category-pie-chart").then((m) => ({
      default: m.CategoryPieChart,
    })),
  { loading: () => <ChartSkeleton height={280} /> }
);

export const LazyCategoryBarChart = dynamic(
  () =>
    import("@/components/charts/category-bar-chart").then((m) => ({
      default: m.CategoryBarChart,
    })),
  { loading: () => <ChartSkeleton height={280} /> }
);

// --- Dialog components (client-only, no SSR) ---

export const LazySyncDialog = dynamic(
  () =>
    import("@/components/sync-dialog").then((m) => ({
      default: m.SyncDialog,
    })),
  { ssr: false }
);

export const LazyDuplicatesDialog = dynamic(
  () =>
    import("@/components/duplicates-dialog").then((m) => ({
      default: m.DuplicatesDialog,
    })),
  { ssr: false }
);

export const LazyGoalFormDialog = dynamic(
  () =>
    import("@/components/goal-form-dialog").then((m) => ({
      default: m.GoalFormDialog,
    })),
  { ssr: false }
);
