"use client";

import * as React from "react";
import { Check, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSettings, useUpdateSettings } from "@/hooks/use-settings";

/**
 * Inline form to configure the monthly budget ceiling.
 * Shows current value or "No configurado", with an input + save button.
 */
export function BudgetSettings() {
  const { data: settings, isLoading } = useSettings();
  const update = useUpdateSettings();
  const [value, setValue] = React.useState("");
  const [syncedCeiling, setSyncedCeiling] = React.useState<number | null>(null);
  const [saved, setSaved] = React.useState(false);

  // Adjust the input when a newly loaded ceiling arrives. Done during render
  // instead of in an effect (see "Adjusting some state when a prop changes" in
  // the React docs) so there is no extra render pass.
  const ceiling = settings?.budget_ceiling_usd ?? null;
  if (ceiling !== null && ceiling !== syncedCeiling) {
    setSyncedCeiling(ceiling);
    setValue(String(ceiling));
  }

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    const parsed = parseFloat(value);
    if (isNaN(parsed) || parsed < 0) return;

    await update.mutateAsync({ budget_ceiling_usd: parsed || null });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        Cargando...
      </div>
    );
  }

  return (
    <form onSubmit={onSave} className="flex items-center gap-2">
      <Input
        type="number"
        inputMode="decimal"
        min={0}
        step="any"
        placeholder="Ej: 2000"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="w-28 sm:w-32"
        aria-label="Techo mensual en USD"
      />
      <span className="text-sm text-muted-foreground">USD</span>
      <Button
        type="submit"
        size="sm"
        disabled={update.isPending || !value}
      >
        {update.isPending ? (
          <Loader2 className="size-4 animate-spin" />
        ) : saved ? (
          <Check className="size-4" />
        ) : (
          "Guardar"
        )}
      </Button>
      {saved && (
        <span className="text-xs text-emerald-600">Guardado ✓</span>
      )}
      {update.error && (
        <span className="text-xs text-destructive">Error al guardar</span>
      )}
    </form>
  );
}
