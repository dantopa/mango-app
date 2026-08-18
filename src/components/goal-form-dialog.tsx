"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { goalSchema, type GoalFormValues } from "@/lib/schemas";
import { useUpsertGoal } from "@/hooks/use-finance";
import type { Goal } from "@/lib/types";

function toDefaults(goal: Goal | null, currentNetWorth: number): GoalFormValues {
  const today = new Date().toISOString().slice(0, 10);
  return {
    name: goal?.name ?? "",
    target_usd: goal?.target_usd ?? 0,
    target_date: goal?.target_date ?? "",
    start_usd: goal?.start_usd ?? Math.round(currentNetWorth),
    start_date: goal?.start_date ?? today,
    is_active: goal?.is_active ?? true,
  };
}

export function GoalFormDialog({
  open,
  onOpenChange,
  goal,
  currentNetWorth,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  goal: Goal | null;
  currentNetWorth: number;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{goal ? "Editar objetivo" : "Nuevo objetivo"}</DialogTitle>
          <DialogDescription>
            Definí cuánto querés juntar y para cuándo. El progreso se mide contra tu
            patrimonio.
          </DialogDescription>
        </DialogHeader>

        {/* Mounted only while open and keyed by goal, so the form state starts
            fresh on every open instead of being reset from an effect. */}
        {open && (
          <GoalForm
            key={goal?.id ?? "new"}
            goal={goal}
            currentNetWorth={currentNetWorth}
            onOpenChange={onOpenChange}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function GoalForm({
  goal,
  currentNetWorth,
  onOpenChange,
}: {
  goal: Goal | null;
  currentNetWorth: number;
  onOpenChange: (open: boolean) => void;
}) {
  const upsert = useUpsertGoal();
  const [values, setValues] = React.useState<GoalFormValues>(() =>
    toDefaults(goal, currentNetWorth),
  );
  const [errors, setErrors] = React.useState<Record<string, string>>({});

  function set<K extends keyof GoalFormValues>(key: K, value: GoalFormValues[K]) {
    setValues((v) => ({ ...v, [key]: value }));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const parsed = goalSchema.safeParse(values);
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        fieldErrors[issue.path[0] as string] = issue.message;
      }
      setErrors(fieldErrors);
      return;
    }
    await upsert.mutateAsync({ id: goal?.id, values: parsed.data });
    onOpenChange(false);
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <Field label="Nombre" error={errors.name}>
        <Input
          value={values.name}
          onChange={(e) => set("name", e.target.value)}
          placeholder="70k Julio 2026"
        />
      </Field>

      <div className="grid grid-cols-2 gap-4">
        <Field label="Meta (USD)" error={errors.target_usd}>
          <Input
            type="number"
            inputMode="decimal"
            value={values.target_usd || ""}
            onChange={(e) => set("target_usd", Number(e.target.value))}
          />
        </Field>
        <Field label="Fecha objetivo" error={errors.target_date}>
          <Input
            type="date"
            value={values.target_date}
            onChange={(e) => set("target_date", e.target.value)}
          />
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Field label="Patrimonio inicial (USD)" error={errors.start_usd}>
          <Input
            type="number"
            inputMode="decimal"
            value={values.start_usd || ""}
            onChange={(e) => set("start_usd", Number(e.target.value))}
          />
        </Field>
        <Field label="Fecha de inicio" error={errors.start_date}>
          <Input
            type="date"
            value={values.start_date}
            onChange={(e) => set("start_date", e.target.value)}
          />
        </Field>
      </div>

      <label className="flex items-center justify-between rounded-lg border border-border p-3">
        <span className="text-sm font-medium">Objetivo activo</span>
        <Switch
          checked={values.is_active}
          onCheckedChange={(c) => set("is_active", c)}
        />
      </label>

      {upsert.error && (
        <p className="text-sm text-destructive">
          {upsert.error instanceof Error ? upsert.error.message : "Error al guardar"}
        </p>
      )}

      <DialogFooter>
        <Button
          type="button"
          variant="ghost"
          onClick={() => onOpenChange(false)}
        >
          Cancelar
        </Button>
        <Button type="submit" disabled={upsert.isPending}>
          {upsert.isPending && <Loader2 className="size-4 animate-spin" />}
          Guardar
        </Button>
      </DialogFooter>
    </form>
  );
}

function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      {children}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
