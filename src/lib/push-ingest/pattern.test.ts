import { describe, it, expect } from "vitest";

import { extractPattern, isUsablePattern } from "./pattern";

describe("extractPattern", () => {
  it("strips Bancolombia prefixes and trailing location codes", () => {
    expect(extractPattern("COMPRA EN PERGAMINO VIVA ENVIG")).toBe("PERGAMINO VIVA");
    expect(extractPattern("PAGO QR ARES BARBERIA")).toBe("ARES BARBERIA");
    expect(extractPattern("PAGO PSE EMPRESAS PUBLICAS D")).toBe("EMPRESAS PUBLICAS");
  });

  it("leaves a plain brand name alone", () => {
    expect(extractPattern("Anthropic")).toBe("Anthropic");
  });

  it("returns null for something too short to identify anything", () => {
    expect(extractPattern("A")).toBeNull();
    expect(extractPattern("")).toBeNull();
  });
});

describe("isUsablePattern", () => {
  const source = "Bancolombia: Compra en PERGAMINO VIVA ENVIG por $32.000";

  it("accepts a fragment copied from the source", () => {
    expect(isUsablePattern("PERGAMINO VIVA", source)).toBe(true);
    expect(isUsablePattern("pergamino", source)).toBe(true);
  });

  /** The whole point: a model that paraphrases writes a rule that matches nothing. */
  it("rejects a fragment the model invented", () => {
    expect(isUsablePattern("Pergamino Café", source)).toBe(false);
  });

  it("tolerates collapsed whitespace, since patterns are re-joined with single spaces", () => {
    expect(isUsablePattern("PERGAMINO VIVA", "Compra en PERGAMINO   VIVA")).toBe(true);
  });

  it("rejects ILIKE wildcards, which would make the rule a catch-all", () => {
    expect(isUsablePattern("PERGAMINO%", "PERGAMINO%")).toBe(false);
    expect(isUsablePattern("PERGAMIN_", "PERGAMIN_")).toBe(false);
  });

  it("rejects patterns too short to be distinctive or absurdly long", () => {
    expect(isUsablePattern("PER", source)).toBe(false);
    expect(isUsablePattern("x".repeat(61), "x".repeat(61))).toBe(false);
  });
});
