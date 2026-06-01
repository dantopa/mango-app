"use client";

import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { formatMonth, formatUsd } from "@/lib/format";
import { MoneyTooltip } from "./chart-tooltip";
import type { NetWorthPoint } from "@/lib/analytics";

export function NetWorthLineChart({ data }: { data: NetWorthPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height={280}>
      <AreaChart data={data} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
        <defs>
          <linearGradient id="nw" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="hsl(263 70% 62%)" stopOpacity={0.5} />
            <stop offset="100%" stopColor="hsl(263 70% 62%)" stopOpacity={0} />
          </linearGradient>
        </defs>
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
          content={<MoneyTooltip labelFormatter={formatMonth} hideTotal />}
          cursor={{ stroke: "hsl(240 5% 30%)" }}
        />
        <Area
          type="monotone"
          dataKey="total"
          name="Patrimonio"
          stroke="hsl(263 70% 62%)"
          strokeWidth={2}
          fill="url(#nw)"
          dot={false}
          activeDot={{ r: 4 }}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
