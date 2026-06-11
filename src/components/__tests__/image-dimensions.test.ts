import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { hasExplicitDimensions, type ImageAttributes } from "@/lib/image-dimensions";

// **Validates: Requirements 7.4**

// --- Property 8: Image elements have explicit dimensions ---

describe("Property 8: Image elements have explicit dimensions", () => {
  it("images with both width > 0 and height > 0 are compliant", () => {
    fc.assert(
      fc.property(
        fc.record({
          src: fc.webUrl(),
          width: fc.integer({ min: 1, max: 4096 }),
          height: fc.integer({ min: 1, max: 4096 }),
        }),
        (attrs: ImageAttributes) => {
          expect(hasExplicitDimensions(attrs)).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("images missing width are non-compliant", () => {
    fc.assert(
      fc.property(
        fc.record({
          src: fc.webUrl(),
          width: fc.constant(undefined),
          height: fc.integer({ min: 1, max: 4096 }),
        }),
        (attrs) => {
          expect(hasExplicitDimensions(attrs as ImageAttributes)).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("images missing height are non-compliant", () => {
    fc.assert(
      fc.property(
        fc.record({
          src: fc.webUrl(),
          width: fc.integer({ min: 1, max: 4096 }),
          height: fc.constant(undefined),
        }),
        (attrs) => {
          expect(hasExplicitDimensions(attrs as ImageAttributes)).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("images missing both dimensions are non-compliant", () => {
    fc.assert(
      fc.property(
        fc.record({
          src: fc.webUrl(),
          width: fc.constant(undefined),
          height: fc.constant(undefined),
        }),
        (attrs) => {
          expect(hasExplicitDimensions(attrs as ImageAttributes)).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("images with null dimensions are non-compliant", () => {
    fc.assert(
      fc.property(
        fc.record({
          src: fc.webUrl(),
          width: fc.constantFrom(null, undefined),
          height: fc.constantFrom(null, undefined),
        }),
        (attrs) => {
          expect(hasExplicitDimensions(attrs as ImageAttributes)).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("images with zero width or height are non-compliant", () => {
    fc.assert(
      fc.property(
        fc.record({
          src: fc.webUrl(),
          width: fc.constantFrom(0, -1),
          height: fc.integer({ min: 1, max: 4096 }),
        }),
        (attrs) => {
          expect(hasExplicitDimensions(attrs as ImageAttributes)).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("compliant iff both width > 0 AND height > 0 (general property)", () => {
    // Generate arbitrary image attributes where width/height may or may not be present
    const optionalDimension = fc.oneof(
      fc.constant(undefined),
      fc.constant(null),
      fc.integer({ min: -10, max: 0 }), // invalid values
      fc.integer({ min: 1, max: 4096 }) // valid values
    );

    fc.assert(
      fc.property(
        fc.record({
          src: fc.webUrl(),
          width: optionalDimension,
          height: optionalDimension,
        }),
        (attrs) => {
          const result = hasExplicitDimensions(attrs as ImageAttributes);
          const expectedCompliant =
            attrs.width != null &&
            attrs.height != null &&
            (attrs.width as number) > 0 &&
            (attrs.height as number) > 0;
          expect(result).toBe(expectedCompliant);
        }
      ),
      { numRuns: 200 }
    );
  });
});
