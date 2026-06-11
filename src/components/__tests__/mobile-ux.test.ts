import { describe, it, expect } from "vitest";
import * as fc from "fast-check";

// **Validates: Requirements 6.2, 6.4**

// --- Pure validation function ---

interface InteractiveElementInfo {
  width: number;
  height: number;
  touchAction: string;
}

/**
 * Validates that an interactive element meets mobile UX constraints:
 * - Bounding box at least 44×44 CSS pixels (WCAG 2.5.8)
 * - touch-action includes "manipulation" (eliminates 300ms tap delay)
 */
function isCompliantInteractiveElement(element: InteractiveElementInfo): boolean {
  const meetsMinSize = element.width >= 44 && element.height >= 44;
  const hasTouchManipulation = element.touchAction.includes("manipulation");
  return meetsMinSize && hasTouchManipulation;
}

// --- Property 7: Interactive elements meet mobile UX constraints ---

describe("Property 7: Interactive elements meet mobile UX constraints", () => {
  const touchActionArb = fc.constantFrom(
    "manipulation",
    "auto",
    "none",
    "pan-x",
    "pan-y"
  );

  const elementArb = fc.record({
    width: fc.integer({ min: 20, max: 80 }),
    height: fc.integer({ min: 20, max: 80 }),
    touchAction: touchActionArb,
  });

  it("element is compliant iff width >= 44 AND height >= 44 AND touchAction includes 'manipulation'", () => {
    fc.assert(
      fc.property(elementArb, (element) => {
        const result = isCompliantInteractiveElement(element);
        const expected =
          element.width >= 44 &&
          element.height >= 44 &&
          element.touchAction.includes("manipulation");
        expect(result).toBe(expected);
      }),
      { numRuns: 200 }
    );
  });

  it("elements smaller than 44px in width are always non-compliant", () => {
    const smallWidthArb = fc.record({
      width: fc.integer({ min: 20, max: 43 }),
      height: fc.integer({ min: 20, max: 80 }),
      touchAction: touchActionArb,
    });

    fc.assert(
      fc.property(smallWidthArb, (element) => {
        expect(isCompliantInteractiveElement(element)).toBe(false);
      }),
      { numRuns: 100 }
    );
  });

  it("elements smaller than 44px in height are always non-compliant", () => {
    const smallHeightArb = fc.record({
      width: fc.integer({ min: 20, max: 80 }),
      height: fc.integer({ min: 20, max: 43 }),
      touchAction: touchActionArb,
    });

    fc.assert(
      fc.property(smallHeightArb, (element) => {
        expect(isCompliantInteractiveElement(element)).toBe(false);
      }),
      { numRuns: 100 }
    );
  });

  it("elements without touch-action: manipulation are always non-compliant", () => {
    const noManipulationArb = fc.record({
      width: fc.integer({ min: 20, max: 80 }),
      height: fc.integer({ min: 20, max: 80 }),
      touchAction: fc.constantFrom("auto", "none", "pan-x", "pan-y"),
    });

    fc.assert(
      fc.property(noManipulationArb, (element) => {
        expect(isCompliantInteractiveElement(element)).toBe(false);
      }),
      { numRuns: 100 }
    );
  });

  it("elements meeting all constraints are always compliant", () => {
    const compliantArb = fc.record({
      width: fc.integer({ min: 44, max: 80 }),
      height: fc.integer({ min: 44, max: 80 }),
      touchAction: fc.constant("manipulation"),
    });

    fc.assert(
      fc.property(compliantArb, (element) => {
        expect(isCompliantInteractiveElement(element)).toBe(true);
      }),
      { numRuns: 100 }
    );
  });
});
