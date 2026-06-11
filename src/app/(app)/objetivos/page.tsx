"use client";

import * as React from "react";
import { Pencil, Plus, Trash2, Target } from "lucide-react";

import { useGoals, useSnapshots, useDeleteGoal } from "@/hooks/use-finance";
import { goalProgress, netWorthByDate, netWorthSummary } from "@/lib/analytics";
import { formatDate, formatUsd } from "@/lib/format";
import { PageHeader } from "@/components/page-header";
import { GoalTracker } from "@/components/goal-tracker";
import { LazyGoalFormDialog } from "@/components/lazy";
import { LoadingState, ErrorState, EmptyState } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Card, CardContent } from "@/components/ui/card";
import type { Goal } from "@/lib/types";

export default function ObjetivosPage() {
  const goals = useGoals();
  const snapshots = useSnapshots();
  const del = useDeleteGoal();

  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<Goal | null>(null);

  const { current, series } = React.useMemo(() => {
    if (!snapshots.data) return { current: 0, series: [] };
    return {
      current: netWorthSummary(snapshots.data).current,
      series: netWorthByDate(snapshots.data),
    };
  }, [snapshots.data]);

  if (goals.isLoading || snapshots.isLoading) return <LoadingState rows={2} />;
  if (goals.error) return <ErrorState error={goals.error} />;

  const data = goals.data ?? [];
  const active = data.filter((g) => g.is_active);
  const inactive = data.filter((g) => !g.is_active);

  function openNew() {
    setEditing(null);
    setDialogOpen(true);
  }
  function openEdit(goal: Goal) {
    setEditing(goal);
    setDialogOpen(true);
  }

  return (
    <>
      <PageHeader
        title="Objetivos"
        description="Tus metas de ahorro y la proyección para llegar."
        action={
          <Button onClick={openNew}>
            <Plus className="size-4" /> Nuevo objetivo
          </Button>
        }
      />

      {data.length === 0 ? (
        <EmptyState
          title="Todavía no tenés objetivos"
          description="Creá una meta de ahorro para trackear tu progreso."
        />
      ) : (
        <div className="flex flex-col gap-4">
          {active.map((goal) => (
            <Card key={goal.id}>
              <CardContent className="p-6">
                <div className="mb-2 flex justify-end gap-1">
                  <Button variant="ghost" size="icon" onClick={() => openEdit(goal)}>
                    <Pencil className="size-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => del.mutate(goal.id)}
                    className="text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
                <GoalTracker progress={goalProgress(goal, current, series)} />
              </CardContent>
            </Card>
          ))}

          {inactive.length > 0 && (
            <>
              <h2 className="mt-2 text-sm font-medium text-muted-foreground">
                Inactivos
              </h2>
              {inactive.map((goal) => {
                const p = goalProgress(goal, current, series);
                return (
                  <Card key={goal.id}>
                    <CardContent className="flex items-center justify-between gap-4 p-5">
                      <div className="flex items-center gap-3">
                        <div className="flex size-9 items-center justify-center rounded-lg bg-secondary">
                          <Target className="size-4 text-muted-foreground" />
                        </div>
                        <div>
                          <div className="font-medium">{goal.name}</div>
                          <div className="text-xs text-muted-foreground">
                            {formatUsd(goal.target_usd, { compact: true })} ·{" "}
                            {formatDate(goal.target_date)}
                          </div>
                        </div>
                      </div>
                      <div className="flex w-40 flex-col items-end gap-1">
                        <Badge variant="muted">inactivo</Badge>
                        <Progress value={p.progressPct * 100} className="h-2" />
                      </div>
                      <div className="flex gap-1">
                        <Button variant="ghost" size="icon" onClick={() => openEdit(goal)}>
                          <Pencil className="size-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => del.mutate(goal.id)}
                          className="text-muted-foreground hover:text-destructive"
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </>
          )}
        </div>
      )}

      <LazyGoalFormDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        goal={editing}
        currentNetWorth={current}
      />
    </>
  );
}
