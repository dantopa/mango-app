import { describe, it, expect } from "vitest";
import { googleWalletParser, timestampToLocalDate } from "./google-wallet";
import type { PushPayload } from "../types";

describe("timestampToLocalDate", () => {
  it("converts 01:30 UTC to the previous day in America/Bogota (UTC-5)", () => {
    // 2026-06-10 01:30 UTC = 2026-06-09 20:30 Bogotá → should return 2026-06-09
    const utcTimestamp = new Date("2026-06-10T01:30:00Z").getTime();
    expect(timestampToLocalDate(utcTimestamp)).toBe("2026-06-09");
  });

  it("keeps the same day when UTC time is >= 05:00 (i.e. >= 00:00 Bogotá)", () => {
    // 2026-06-10 05:00 UTC = 2026-06-10 00:00 Bogotá → should return 2026-06-10
    const utcTimestamp = new Date("2026-06-10T05:00:00Z").getTime();
    expect(timestampToLocalDate(utcTimestamp)).toBe("2026-06-10");
  });

  it("converts 04:59 UTC to the previous day in Bogotá", () => {
    // 2026-06-10 04:59 UTC = 2026-06-09 23:59 Bogotá → should return 2026-06-09
    const utcTimestamp = new Date("2026-06-10T04:59:00Z").getTime();
    expect(timestampToLocalDate(utcTimestamp)).toBe("2026-06-09");
  });

  it("handles midnight UTC → previous day in Bogotá", () => {
    // 2026-06-10 00:00 UTC = 2026-06-09 19:00 Bogotá → should return 2026-06-09
    const utcTimestamp = new Date("2026-06-10T00:00:00Z").getTime();
    expect(timestampToLocalDate(utcTimestamp)).toBe("2026-06-09");
  });

  it("handles year boundary correctly", () => {
    // 2026-01-01 03:00 UTC = 2025-12-31 22:00 Bogotá → should return 2025-12-31
    const utcTimestamp = new Date("2026-01-01T03:00:00Z").getTime();
    expect(timestampToLocalDate(utcTimestamp)).toBe("2025-12-31");
  });
});

describe("googleWalletParser — timezone handling", () => {
  it("uses Bogotá date when timestamp is 01:30 UTC (previous day locally)", () => {
    // 2026-06-10 01:30 UTC = 2026-06-09 20:30 Bogotá
    const payload: PushPayload = {
      packageName: "com.google.android.apps.walletnfcrel",
      title: "PERGAMINO VIVA ENVIGAD",
      text: "COP7,500.00 con Debito Mastercard ••5685",
      timestamp: new Date("2026-06-10T01:30:00Z").getTime(),
    };

    const result = googleWalletParser(payload);
    expect(result).not.toBeNull();
    expect(result!.tx_date).toBe("2026-06-09");
  });

  it("uses same-day Bogotá date when timestamp is 15:00 UTC", () => {
    // 2026-06-10 15:00 UTC = 2026-06-10 10:00 Bogotá
    const payload: PushPayload = {
      packageName: "com.google.android.apps.walletnfcrel",
      title: "BOLD SA*COYO TAC",
      text: "COP63,400.00 con Debito Mastercard ••5685",
      timestamp: new Date("2026-06-10T15:00:00Z").getTime(),
    };

    const result = googleWalletParser(payload);
    expect(result).not.toBeNull();
    expect(result!.tx_date).toBe("2026-06-10");
  });
});
