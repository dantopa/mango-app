# Implementation Plan: PWA Mobile Performance

## Overview

Holistic performance optimization of the Maquinita PWA for mobile devices. Implementation proceeds in logical layers: build-time optimizations first (bundle analysis, dynamic imports, tree-shaking), then runtime infrastructure (service worker v2, query persistence, offline support), followed by rendering performance (virtual lists, skeletons), mobile UX refinements, asset/font/CSS optimization, and finally CI gates (Lighthouse CI, bundle budgets). Each task builds incrementally on the previous.

## Tasks

- [x] 1. Bundle optimization and code splitting
  - [x] 1.1 Configure bundle analyzer and `optimizePackageImports` in `next.config.ts`
    - Add `webpack-bundle-analyzer` as devDependency
    - Add `ANALYZE=true` conditional BundleAnalyzerPlugin to webpack config
    - Add `experimental.optimizePackageImports` for `lucide-react`, `recharts`, `date-fns`
    - Add `analyze` script to `package.json`
    - _Requirements: 1.1, 1.6, 1.7_

  - [x] 1.2 Create dynamic import wrappers for heavy components
    - Create `src/components/lazy/index.ts` with `next/dynamic` wrappers
    - Wrap: `NetWorthLineChart`, `CompositionAreaChart`, `CategoryPieChart` (with `ChartSkeleton` loading)
    - Wrap: `SyncDialog`, `GoalFormDialog` (with `ssr: false`)
    - Create `src/components/lazy/chart-skeleton.tsx` placeholder component
    - _Requirements: 1.4, 1.5_

  - [x] 1.3 Replace direct chart imports with lazy wrappers across route pages
    - Update `src/app/(app)/page.tsx` to use `LazyNetWorthLineChart` and `LazyCompositionAreaChart`
    - Update `src/app/(app)/gastos/page.tsx` to use lazy chart components
    - Update `src/app/(app)/patrimonio/page.tsx` to use lazy chart components
    - Update `src/app/(app)/objetivos/page.tsx` to use lazy `GoalFormDialog`
    - Verify `/objetivos` and `/cierre` do not include Recharts chunks
    - _Requirements: 1.4, 1.5, 1.6_

- [x] 2. Service Worker enhancement (v2)
  - [x] 2.1 Create SW build script to inject build ID and precache manifest
    - Create `scripts/inject-sw-version.mjs` that reads `.next/BUILD_ID` and injects into `sw.js`
    - Add `postbuild` script to `package.json` that runs the injection
    - Template the SW with `__BUILD_ID__` and `__PRECACHE_URLS__` placeholders
    - _Requirements: 4.5_

  - [x] 2.2 Rewrite `public/sw.js` with versioned caches and differentiated strategies
    - Implement versioned cache names: `maquinita-shell-{BUILD_ID}`, `maquinita-static-{BUILD_ID}`, `maquinita-api-{BUILD_ID}`
    - Cache-first strategy for `/_next/static/**` (immutable, content-hashed)
    - Network-first strategy for navigation requests with cached App Shell fallback
    - Network-first strategy for `/api/*` with 5-minute max-age on cached responses (inject `X-Cache-Time` header)
    - Cross-origin passthrough: do NOT call `event.respondWith()` for non-same-origin requests
    - On activation: delete all caches that don't match current BUILD_ID
    - Preserve existing push notification handlers
    - Remove `self.skipWaiting()` from install (controlled by update toast)
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.7_

  - [x] 2.3 Write property tests for SW route matching and cache expiry logic
    - Extract pure utility functions: `isCacheExpired(timestamp, maxAge)`, `matchRoute(url)`, `isCurrentVersion(cacheName, version)`
    - Create `src/lib/__tests__/sw-utils.test.ts`
    - **Property 2: SW API cache expiry enforcement** — generate random timestamps 0–10 min, verify accept/reject
    - **Property 3: Versioned cache cleanup** — generate random cache name sets with version strings, verify only matching version survives
    - **Property 4: Cross-origin passthrough** — generate random URLs with varying origins, verify correct classification
    - **Validates: Requirements 4.4, 4.5, 4.7**

  - [x] 2.4 Update `src/components/pwa-register.tsx` to handle SW update lifecycle
    - Listen for `controllerchange` to detect new SW waiting
    - Post `SKIP_WAITING` message when user confirms reload
    - Expose `hasUpdate` and `onReload` state for the update toast
    - _Requirements: 4.6_

- [x] 3. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. TanStack Query persistence and offline support
  - [x] 4.1 Install persistence packages and create IndexedDB storage adapter
    - Add `@tanstack/react-query-persist-client` and `@tanstack/query-sync-storage-persister` dependencies
    - Create `src/lib/query-persist.ts` with `IDBStorageAdapter` implementing `getItem`, `setItem`, `removeItem` backed by IndexedDB (`maquinita-query-cache` database)
    - Handle IndexedDB unavailability gracefully (return null / noop)
    - _Requirements: 5.3, 5.4_

  - [x] 4.2 Integrate persistence into `Providers` component
    - Update `src/components/providers.tsx` to use `PersistQueryClientProvider` instead of `QueryClientProvider`
    - Configure: `maxAge: 7 * 24 * 60 * 60 * 1000` (7 days), `buster` from build version
    - Add `gcTime: Infinity` to QueryClient so persisted queries survive garbage collection
    - Configure `retry: 1`, `retryDelay: 2000` for network failure resilience
    - _Requirements: 5.2, 5.3, 5.4, 3.6_

  - [x] 4.3 Write property tests for query persistence round-trip and max age
    - Create `src/lib/__tests__/query-persist.test.ts`
    - **Property 5: Query cache round-trip** — generate random dehydrated state objects, serialize/deserialize, verify deep equality
    - **Property 6: Persisted cache max age** — generate random timestamps 0–14 days, verify correct accept/discard decision
    - **Validates: Requirements 5.3, 5.2**

  - [x] 4.4 Create offline status hook and banner component
    - Create `src/hooks/use-online-status.ts` using `navigator.onLine` + `online`/`offline` events
    - Create `src/components/offline-banner.tsx` — fixed-position top banner showing "sin conexión", pushes content down
    - Add banner to `src/app/(app)/layout.tsx` or `AppShell`
    - Show banner only when offline; auto-hide on reconnection
    - _Requirements: 4.3, 5.6_

  - [x] 4.5 Create SW update toast component
    - Create `src/components/sw-update-toast.tsx` — bottom-positioned dismissible toast
    - Text: "actualización disponible" with reload button
    - Auto-dismiss after 10 seconds if not interacted with
    - Wire to `pwa-register.tsx` state
    - _Requirements: 4.6_

  - [x] 4.6 Implement auto-revalidation on reconnection
    - In `Providers` or a dedicated hook, listen for `online` event and call `queryClient.invalidateQueries()` for stale queries
    - Only revalidate queries whose cached data is older than `staleTime`
    - _Requirements: 5.5_

- [x] 5. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Rendering performance and virtual lists
  - [x] 6.1 Install `@tanstack/react-virtual` and create generic `VirtualList` component
    - Add `@tanstack/react-virtual` dependency
    - Create `src/components/virtual-list.tsx` accepting `items`, `estimateSize`, `overscan` (default: 5), `renderItem`
    - Ensure DOM node count stays within `visibleCount + 2 * overscan`
    - _Requirements: 2.6_

  - [x] 6.2 Integrate virtual list into transaction tables
    - Update `/gastos` page transaction table to use `VirtualList` when items > 50
    - Update any other long lists (snapshots in `/patrimonio`) if applicable
    - Preserve existing row rendering and styling
    - _Requirements: 2.6, 6.3_

  - [x] 6.3 Write property test for virtual list DOM node cap
    - Create `src/components/__tests__/virtual-list.test.ts`
    - **Property 1: Virtual list DOM node cap** — generate random item counts (51–2000), random viewport heights, verify DOM node bound ≤ `visible_count + 20`
    - **Validates: Requirements 2.6**

  - [x] 6.4 Ensure skeleton dimensions match final components
    - Audit and update all existing `loading.tsx` skeletons to match rendered component dimensions within 4px
    - Verify chart skeletons match Recharts container heights (256px)
    - _Requirements: 2.3, 2.2_

- [x] 7. Mobile UX improvements
  - [x] 7.1 Apply `touch-action: manipulation` globally and size touch targets
    - Add global CSS rule: `button, a, [role="tab"], input, select, textarea { touch-action: manipulation; }`
    - Audit and fix any interactive elements smaller than 44×44px (bottom tab bar icons, small buttons)
    - Ensure bottom tab bar items meet 44×44 minimum
    - _Requirements: 6.1, 6.2, 6.4_

  - [x] 7.2 Enhance navigation feedback and route prefetching in `AppShell`
    - Add `prefetch={true}` to all navigation `<Link>` components
    - Add `onTouchStart` handler for immediate prefetch trigger on mobile
    - Add CSS `:active` state with immediate visual feedback (transform/opacity) within 50ms
    - _Requirements: 6.6, 10.1, 10.2_

  - [x] 7.3 Write property test for interactive element UX constraints
    - Create `src/components/__tests__/mobile-ux.test.ts`
    - **Property 7: Interactive elements meet mobile UX constraints** — generate mock DOM elements with random dimensions and styles, verify validation identifies compliant/non-compliant elements (44×44px + touch-action: manipulation)
    - **Validates: Requirements 6.2, 6.4**

- [x] 8. Font, CSS, and image optimization
  - [x] 8.1 Configure font optimization with `next/font` and preload
    - Replace any manually loaded fonts with `next/font/google` or `next/font/local` for `font-display: swap`
    - Subset to Basic Latin + Latin-1 Supplement (U+0000–00FF)
    - Add `<link rel="preload" as="font" type="font/woff2" crossorigin>` for primary font
    - _Requirements: 8.1, 8.2, 8.6_

  - [x] 8.2 Optimize images and add explicit dimensions
    - Ensure all `<img>` elements have explicit `width` and `height` attributes
    - Add `loading="lazy"` to below-fold images
    - Verify PWA manifest icons are compressed (< 50 KB total for all sizes)
    - Use `next/image` where applicable for WebP/AVIF automatic conversion
    - _Requirements: 7.1, 7.3, 7.4, 7.6_

  - [x] 8.3 Write property test for image explicit dimensions
    - Create `src/components/__tests__/image-dimensions.test.ts`
    - **Property 8: Image elements have explicit dimensions** — generate mock img elements with/without width/height, verify validation catches missing dimensions
    - **Validates: Requirements 7.4**

  - [x] 8.4 Verify and optimize CSS output
    - Confirm Tailwind CSS v4 purges unused utilities in production build
    - Verify final CSS bundle ≤ 50 KB gzipped
    - Ensure critical CSS is inlined by Next.js (App Router does this by default for server components)
    - _Requirements: 8.3, 8.4, 8.5_

- [x] 9. Route prefetching and React Suspense boundaries
  - [x] 9.1 Add React Suspense boundaries at route level
    - Ensure each route page under `(app)/` has a corresponding `loading.tsx` that serves as the Suspense fallback
    - Verify existing `loading.tsx` files render within 16ms (one frame)
    - Confirm `AppShell` layout remains mounted across route transitions (no full re-render)
    - _Requirements: 10.4, 10.5, 10.6_

  - [x] 9.2 Handle prefetch failures gracefully
    - Verify that when `prefetch` fails (offline), navigation still works with on-demand loading + skeleton
    - Test: disable network, tap nav link → skeleton shows → re-enable → content loads
    - _Requirements: 10.7, 10.3_

- [x] 10. Lighthouse CI and bundle budget gates
  - [x] 10.1 Create bundle size budget script
    - Create `scripts/check-bundle-size.mjs` that parses `next build` stdout
    - Assert per-route budgets: `/` < 150KB, `/gastos` < 200KB, `/patrimonio` < 200KB, `/objetivos` < 120KB, `/cierre` < 120KB (gzipped first-load JS)
    - Exit with non-zero code if any budget exceeded
    - Add `check:bundle` script to `package.json`
    - _Requirements: 1.2, 1.3, 9.5_

  - [x] 10.2 Set up Lighthouse CI configuration
    - Create `lighthouserc.js` with mobile emulation settings
    - Configure 3 runs per route, use median scores
    - Assert: Performance ≥ 90, Best Practices ≥ 95, Accessibility ≥ 95, PWA badge
    - Add `lighthouse:ci` script to `package.json` (uses `@lhci/cli`)
    - Add `@lhci/cli` as devDependency
    - _Requirements: 9.1, 9.2, 9.3, 9.4_

  - [x] 10.3 Wire CI gates into build pipeline
    - Update or create CI configuration to run: `build → check:bundle → lighthouse:ci → deploy`
    - Deployment gated on both passing
    - _Requirements: 9.5_

- [x] 11. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- The service worker build script (2.1) must run after `next build` to access the BUILD_ID
- Query persistence (4.x) depends on the service worker being able to serve the app shell offline
- Virtual list (6.x) is independent and can be developed in parallel with SW/persistence work
- Lighthouse CI (10.x) should be the last step since it validates all prior optimizations together

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1", "4.1", "6.1", "7.1"] },
    { "id": 1, "tasks": ["1.2", "2.2", "4.4", "6.4", "8.1"] },
    { "id": 2, "tasks": ["1.3", "2.3", "2.4", "4.2", "4.5", "6.2", "7.2", "8.2"] },
    { "id": 3, "tasks": ["4.3", "4.6", "6.3", "7.3", "8.3", "8.4"] },
    { "id": 4, "tasks": ["9.1", "9.2", "10.1"] },
    { "id": 5, "tasks": ["10.2"] },
    { "id": 6, "tasks": ["10.3"] }
  ]
}
```
