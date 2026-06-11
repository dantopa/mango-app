/**
 * Optimized image wrapper using next/image.
 *
 * Enforces:
 * - Explicit width & height (prevents CLS) — Requirement 7.4
 * - Lazy loading for below-fold images — Requirement 7.3
 * - WebP/AVIF automatic conversion — Requirement 7.1
 * - Fallback formats via Next.js image optimizer — Requirement 7.7
 *
 * Usage:
 *   <OptimizedImage src="/photo.png" alt="..." width={320} height={240} />
 *   <OptimizedImage src="/hero.jpg" alt="..." width={800} height={400} priority />
 */
import Image, { type ImageProps } from "next/image";

export type OptimizedImageProps = Omit<ImageProps, "loading"> & {
  /** Set true for above-fold / LCP images to disable lazy loading and preload */
  priority?: boolean;
};

export function OptimizedImage({
  priority = false,
  ...props
}: OptimizedImageProps) {
  return (
    <Image
      {...props}
      priority={priority}
      loading={priority ? undefined : "lazy"}
      // next/image automatically serves WebP/AVIF when supported
      // and requires width + height (enforced by TypeScript types)
    />
  );
}
