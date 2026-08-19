import { describe, expect, it } from "vitest";

import { buildAlert } from "./alert";
import { computeSemaphore } from "./semaphore";

/** Techo de 1000 en un mes de 30 días: el día 15 lo esperado son 500. */
const sem = (spent: number, day: number) =>
  computeSemaphore({
    accumulated_spend: spent,
    ceiling: 1000,
    current_day: day,
    days_in_month: 30,
  });

describe("buildAlert", () => {
  it("no avisa si el estado no cambió", () => {
    expect(buildAlert(sem(300, 15), sem(400, 15))).toBeNull();
  });

  it("avisa al pasar a amarillo, con el gasto diario que vuelve a verde", () => {
    const alert = buildAlert(sem(400, 15), sem(600, 15));

    expect(alert?.title).toContain("🟡");
    // (1000 - 600) / 16 días restantes = 25 por día
    expect(alert?.body).toContain("25");
  });

  it("avisa al llegar al techo", () => {
    const alert = buildAlert(sem(600, 15), sem(1000, 15));

    expect(alert?.title).toBe("🔴 Llegaste al techo");
    expect(alert?.body).toContain("quedan 16 días");
  });

  it("singulariza el último día del mes", () => {
    const alert = buildAlert(sem(600, 30), sem(1000, 30));

    expect(alert?.body).toContain("queda 1 día");
  });

  it("felicita cuando el mes se acomodó y quedó holgado", () => {
    // Mismo gasto, más días transcurridos: lo esperado sube y el ritmo pasa a sobrar.
    const alert = buildAlert(sem(400, 10), sem(400, 25));

    expect(alert?.title).toBe("🟢 Vas muy bien");
    expect(alert?.body).toContain("Seguí así");
  });

  it("reconoce la vuelta al ritmo sin exagerar cuando el margen es chico", () => {
    const alert = buildAlert(sem(500, 15), sem(500, 17));

    expect(alert?.title).toBe("🟢 Volviste al ritmo");
  });

  it("avisa en el primer gasto del mes aunque no haya estado anterior", () => {
    const alert = buildAlert(null, sem(40, 2));

    expect(alert?.title).toBe("🟢 Arrancó el mes");
  });

  it("si el primer gasto del mes ya se pasa del ritmo, avisa eso y no el arranque", () => {
    const alert = buildAlert(null, sem(600, 2));

    expect(alert?.title).toContain("🟡");
  });
});
