/**
 * Image dimensions validation utility.
 * Validates that image attributes include explicit width and height
 * to prevent CLS during loading.
 */

export interface ImageAttributes {
  src: string;
  width?: number | null;
  height?: number | null;
}

/**
 * Checks whether an image element has explicit dimensions (both width and height > 0).
 * Images without explicit dimensions cause Cumulative Layout Shift (CLS) during loading.
 *
 * @returns true if the image has both width and height defined and > 0
 */
export function hasExplicitDimensions(attrs: ImageAttributes): boolean {
  return (
    attrs.width != null &&
    attrs.height != null &&
    attrs.width > 0 &&
    attrs.height > 0
  );
}
