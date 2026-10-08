// @vitest-environment jsdom
import * as React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- Hooks the two components read; the network is not what is under test. ---
const useSemaphore = vi.fn();
vi.mock("@/hooks/use-semaphore", () => ({ useSemaphore: () => useSemaphore() }));

const mutateAsync = vi.fn();
const useSettings = vi.fn();
const useUpdateSettings = vi.fn();
vi.mock("@/hooks/use-settings", () => ({
  useSettings: () => useSettings(),
  useUpdateSettings: () => useUpdateSettings(),
}));

import { BudgetSettings } from "../budget-settings";
import { SemaphoreGauge } from "../semaphore-gauge";

const configured = {
  data: { state: "verde", spent: 548, ceiling: 2000, pct: 0.274, expected_pct: 0.226, day: 8, days_in_month: 31, daily_budget: 58 },
  isLoading: false,
  error: null,
};

beforeEach(() => {
  mutateAsync.mockReset().mockResolvedValue(undefined);
  useSettings.mockReturnValue({ data: { budget_ceiling_usd: 2000 }, isLoading: false });
  useUpdateSettings.mockReturnValue({ mutateAsync, isPending: false, error: null });
  useSemaphore.mockReturnValue(configured);
});

afterEach(cleanup);

describe("SemaphoreGauge", () => {
  it("offers to edit a ceiling that is already set — the editor used to exist only before the first save", () => {
    render(<SemaphoreGauge />);

    expect(screen.getByRole("button", { name: "Editar techo mensual" })).toBeTruthy();
    expect(screen.queryByLabelText("Techo mensual en USD")).toBeNull();
  });

  it("opens the editor with the current ceiling, and closes it on cancel", () => {
    render(<SemaphoreGauge />);

    fireEvent.click(screen.getByRole("button", { name: "Editar techo mensual" }));
    expect((screen.getByLabelText("Techo mensual en USD") as HTMLInputElement).value).toBe("2000");
    // One editor at a time: the button is replaced by the form.
    expect(screen.queryByRole("button", { name: "Editar techo mensual" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByLabelText("Techo mensual en USD")).toBeNull();
    expect(screen.getByRole("button", { name: "Editar techo mensual" })).toBeTruthy();
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it("saves a new ceiling and closes the editor", async () => {
    render(<SemaphoreGauge />);
    fireEvent.click(screen.getByRole("button", { name: "Editar techo mensual" }));

    fireEvent.change(screen.getByLabelText("Techo mensual en USD"), { target: { value: "1500" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));

    await waitFor(() => expect(screen.queryByLabelText("Techo mensual en USD")).toBeNull());
    expect(mutateAsync).toHaveBeenCalledWith({ budget_ceiling_usd: 1500 });
  });

  it("shows the editor straight away while no ceiling is configured, with nothing to cancel", () => {
    useSemaphore.mockReturnValue({ data: null, isLoading: false, error: null });
    useSettings.mockReturnValue({ data: { budget_ceiling_usd: null }, isLoading: false });
    render(<SemaphoreGauge />);

    expect(screen.getByLabelText("Techo mensual en USD")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Editar techo mensual" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancelar" })).toBeNull();
  });
});

describe("BudgetSettings", () => {
  it("starts from the saved ceiling", () => {
    render(<BudgetSettings />);
    expect((screen.getByLabelText("Techo mensual en USD") as HTMLInputElement).value).toBe("2000");
  });

  it("saves what was typed, as a number", async () => {
    const onSaved = vi.fn();
    render(<BudgetSettings onSaved={onSaved} />);

    fireEvent.change(screen.getByLabelText("Techo mensual en USD"), { target: { value: "1800.5" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(mutateAsync).toHaveBeenCalledWith({ budget_ceiling_usd: 1800.5 });
  });

  it("does not save a negative or empty value, nor report it as saved", async () => {
    const onSaved = vi.fn();
    render(<BudgetSettings onSaved={onSaved} />);
    const input = screen.getByLabelText("Techo mensual en USD");

    fireEvent.change(input, { target: { value: "-5" } });
    fireEvent.submit(input.closest("form")!);
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.submit(input.closest("form")!);

    // Let any (wrong) async save settle before asserting that none happened.
    await Promise.resolve();
    expect(mutateAsync).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("does not claim success when saving fails", async () => {
    mutateAsync.mockRejectedValue(new Error("boom"));
    const onSaved = vi.fn();
    // The rejection is the component's to surface through `update.error`; here it must not escape as "saved".
    render(<BudgetSettings onSaved={onSaved} />);

    fireEvent.change(screen.getByLabelText("Techo mensual en USD"), { target: { value: "1500" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));

    await Promise.resolve();
    await Promise.resolve();
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.queryByText("Guardado ✓")).toBeNull();
  });

  it("only offers Cancelar when a screen asked for it", () => {
    const { rerender } = render(<BudgetSettings />);
    expect(screen.queryByRole("button", { name: "Cancelar" })).toBeNull();

    rerender(<BudgetSettings onCancel={() => {}} />);
    expect(screen.getByRole("button", { name: "Cancelar" })).toBeTruthy();
  });
});
