"use client";

import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";

import { formatUsd } from "@/lib/format";
import { MoneyTooltip } from "./chart-tooltip";

/** Minimal shape both CategorySpend and DimensionSlice satisfy. */
export type Sliceable = { name: string; color: string; total: number };

export function CategoryPieChart({ data }: { data: Sliceable[] }) {
  const chartData = data.map((d) => ({ name: d.name, value: d.total, color: d.color }));
  const total = data.reduce((s, d) => s + d.total, 0);

  return (
    <div className="relative">
      <ResponsiveContainer width="100%" height={280}>
        <PieChart>
          <Pie
            data={chartData}
            dataKey="value"
            nameKey="name"
            innerRadius={70}
            outerRadius={110}
            paddingAngle={2}
            stroke="hsl(240 8% 6.5%)"
            strokeWidth={2}
          >
            {chartData.map((d, i) => (
              <Cell key={i} fill={d.color} />
            ))}
          </Pie>
          <Tooltip content={<MoneyTooltip hideTotal />} />
        </PieChart>
      </ResponsiveContainer>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-xs text-muted-foreground">Total</span>
        <span className="text-xl font-semibold tabular-nums">{formatUsd(total)}</span>
      </div>
    </div>
  );
}
