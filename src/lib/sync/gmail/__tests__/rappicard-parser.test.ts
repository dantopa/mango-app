import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { rappicardDef } from "../sources/rappicard";
import { htmlToText } from "../html-to-text";
import type { ParsedEmail } from "../types";

const FIXTURES_DIR = join(__dirname, "../__fixtures__");

function loadHtmlFixture(name: string): ParsedEmail {
  const html = readFileSync(join(FIXTURES_DIR, name), "utf-8");
  const bodyText = htmlToText(html);
  return {
    messageId: `msg-${name}`,
    internalDate: "1717700000000", // ~2024-06-06 in epoch ms
    subject: "RappiCard - Resumen de transacción",
    bodyText,
  };
}

describe("RappiCard Gmail parser", () => {
  describe("buildQuery", () => {
    it("builds correct query for a given month", () => {
      const query = rappicardDef.buildQuery("2026-06");
      expect(query).toBe(
        'from:(noreply@rappicard.co) subject:("Resumen de transacción") after:2026/06/01 before:2026/07/01'
      );
    });

    it("handles December → January year rollover", () => {
      const query = rappicardDef.buildQuery("2026-12");
      expect(query).toBe(
        'from:(noreply@rappicard.co) subject:("Resumen de transacción") after:2026/12/01 before:2027/01/01'
      );
    });
  });

  describe("parse — transaction email", () => {
    it("extracts correct candidate from transaction email", () => {
      const email = loadHtmlFixture("rappicard-transaccion.html");
      const result = rappicardDef.parse(email);

      expect(result).toHaveLength(1);
      expect(result[0].amount_native).toBe(88443);
      expect(result[0].native_currency).toBe("COP");
      expect(result[0].merchant).toBe("RAPPI");
      expect(result[0].tx_date).toBe("2026-06-09");
      expect(result[0].account_name).toBe("RappiCard");
      expect(result[0].source).toBe("sync_gmail_rappicard");
      expect(result[0].description_raw.length).toBeLessThanOrEqual(200);
    });
  });

  describe("parse — discards", () => {
    it("returns [] for extracto email (no Monto field)", () => {
      const email = loadHtmlFixture("rappicard-extracto.html");
      const result = rappicardDef.parse(email);

      expect(result).toEqual([]);
    });
  });

  describe("parse — fallback date from internalDate", () => {
    it("uses internalDate (America/Bogota) when Fecha field is missing", () => {
      // Simulate a transaction email that has Monto and Comercio but no Fecha
      const bodyText = [
        "Realizaste una compra con tu RappiCard",
        "Monto $55.000",
        "Comercio EXITO",
        "No. de autorización 999888",
      ].join("\n");

      const email: ParsedEmail = {
        messageId: "msg-no-fecha",
        // 2026-06-15T10:00:00Z in epoch ms
        internalDate: String(new Date("2026-06-15T10:00:00Z").getTime()),
        subject: "RappiCard - Resumen de transacción",
        bodyText,
      };

      const result = rappicardDef.parse(email);

      expect(result).toHaveLength(1);
      expect(result[0].amount_native).toBe(55000);
      expect(result[0].merchant).toBe("EXITO");
      // 2026-06-15 10:00 UTC = 2026-06-15 05:00 Bogota → same day
      expect(result[0].tx_date).toBe("2026-06-15");
    });

    it("handles UTC midnight crossing to previous day in Bogota", () => {
      const bodyText = "Monto $10.000\nComercio RAPPI\n";

      const email: ParsedEmail = {
        messageId: "msg-midnight",
        // 2026-07-01T03:00:00Z → 2026-06-30 22:00 Bogota (previous day)
        internalDate: String(new Date("2026-07-01T03:00:00Z").getTime()),
        subject: "RappiCard - Resumen de transacción",
        bodyText,
      };

      const result = rappicardDef.parse(email);

      expect(result).toHaveLength(1);
      expect(result[0].tx_date).toBe("2026-06-30");
    });
  });
});
