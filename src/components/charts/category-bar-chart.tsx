"use client";

import {
  Bar,
  BarChart,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { MoneyTooltip } from "./chart-tooltip";
import type { CategorySpend } from "@/lib/analytics";

export function CategoryBarChart({ data }: { data: CategorySpend[] }) {
  return (
    <ResponsiveContainer width="100%" height={Math.max(220, data.length * 38)}>
      <BarChart
        data={data}
        layout="vertical"
        margin={{ top: 0, right: 16, left: 8, bottom: 0 }}
      >
        <XAxis type="number" hide />
        <YAxis
          type="category"
          dataKey="name"
          width={140}
          tickLine={false}
          axisLine={false}
          tick={{ fill: "hsl(240 5% 64%)", fontSize: 12 }}
        />
        <Tooltip
          content={<MoneyTooltip hideTotal />}
          cursor={{ fill: "hsl(240 5% 15%)", opacity: 0.4 }}
        />
        <Bar dataKey="total" name="Gasto" radius={[4, 4, 4, 4]}>
          {data.map((d, i) => (
            <Cell key={i} fill={d.color} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
