"use client";

import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { formatMonth, formatUsd } from "@/lib/format";
import { paletteColor } from "@/lib/colors";
import { MoneyTooltip } from "./chart-tooltip";
import type { CompositionPoint } from "@/lib/analytics";

export function CompositionAreaChart({
  data,
  accountNames,
}: {
  data: CompositionPoint[];
  accountNames: string[];
}) {
  return (
    <ResponsiveContainer width="100%" height={320}>
      <AreaChart data={data} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(240 5% 15%)" vertical={false} />
        <XAxis
          dataKey="date"
          tickFormatter={formatMonth}
          tickLine={false}
          axisLine={false}
          tick={{ fill: "hsl(240 5% 64%)", fontSize: 12 }}
          minTickGap={24}
        />
        <YAxis
          tickFormatter={(v) => formatUsd(v, { compact: true })}
          tickLine={false}
          axisLine={false}
          width={56}
          tick={{ fill: "hsl(240 5% 64%)", fontSize: 12 }}
        />
        <Tooltip
          content={<MoneyTooltip labelFormatter={formatMonth} />}
          cursor={{ stroke: "hsl(240 5% 30%)" }}
        />
        <Legend
          iconType="circle"
          wrapperStyle={{ fontSize: 12, color: "hsl(240 5% 64%)", paddingTop: 8 }}
        />
        {accountNames.map((name, i) => (
          <Area
            key={name}
            type="monotone"
            dataKey={name}
            stackId="1"
            stroke={paletteColor(i)}
            fill={paletteColor(i)}
            fillOpacity={0.55}
            strokeWidth={1.5}
          />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  );
}
