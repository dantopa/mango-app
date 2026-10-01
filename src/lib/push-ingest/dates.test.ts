import { describe, it, expect } from "vitest";
import { bogotaMonthBounds, bogotaMonthInfo, currentBogotaMonth } from "./dates";

describe("Bogotá month helpers", () => {
  // 30-sep 23:30 UTC is 18:30 in Bogotá; 01-oct 01:00 UTC is still 30-sep 20:00.
  const lastEveningOfSeptember = Date.parse("2026-10-01T01:00:00Z");

  it("keeps the last evening of a month in that month, though UTC is already next month", () => {
    expect(new Date(lastEveningOfSeptember).toISOString().slice(0, 7)).toBe("2026-10");
    expect(currentBogotaMonth(lastEveningOfSeptember)).toBe("2026-09");
  });

  it("reports day, length and bounds of the Bogotá month", () => {
    expect(bogotaMonthInfo(lastEveningOfSeptember)).toEqual({
      month: "2026-09",
      day: 30,
      daysInMonth: 30,
      start: "2026-09-01",
      end: "2026-09-30",
    });
    expect(bogotaMonthInfo(Date.parse("2028-02-15T12:00:00Z")).daysInMonth).toBe(29);
  });

  it("turns a Bogotá month into UTC instants for timestamp columns", () => {
    expect(bogotaMonthBounds("2026-09")).toEqual({
      from: "2026-09-01T05:00:00.000Z",
      to: "2026-10-01T04:59:59.999Z",
    });
    expect(bogotaMonthBounds("2026-12").to).toBe("2027-01-01T04:59:59.999Z");
  });
});
