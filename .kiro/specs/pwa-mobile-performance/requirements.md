# Requirements Document

## Introduction

Deep performance analysis and optimization of the Maquinita PWA for mobile devices. This covers bundle size reduction, rendering performance, network efficiency, caching strategies, PWA-specific optimizations (offline support, app shell pattern), mobile UX performance (touch responsiveness, scroll performance), and Lighthouse score improvements. The goal is to deliver a fast, responsive, native-like experience on mobile networks and devices.

## Glossary

- **App**: The Maquinita personal finance PWA deployed on Vercel (Next.js 16 App Router).
- **Service_Worker**: The `sw.js` script that intercepts network requests and manages caching.
- **App_Shell**: The minimal HTML, CSS, and JavaScript required to render the navigation skeleton (sidebar/tab bar + layout chrome) without data.
- **Bundle_Analyzer**: Tooling that produces a visual map of JavaScript bundle composition and sizes.
- **LCP**: Largest Contentful Paint — Core Web Vital measuring when the largest visible content element renders.
- **FID**: First Input Delay — Core Web Vital measuring time from first user interaction to browser response.
- **CLS**: Cumulative Layout Shift — Core Web Vital measuring visual stability during page load.
- **TTI**: Time to Interactive — the time until the page is fully interactive.
- **TTFB**: Time to First Byte — time between the browser request and receiving the first byte of the response.
- **INP**: Interaction to Next Paint — Core Web Vital measuring responsiveness to user interactions.
- **Code_Splitting**: Technique of splitting JavaScript into smaller chunks loaded on demand.
- **Route_Prefetch**: Preloading the JavaScript and data for a route before the user navigates to it.
- **Stale_While_Revalidate**: Cache strategy that serves stale content immediately while fetching fresh content in the background.
- **Critical_CSS**: The minimum CSS required to render above-the-fold content, inlined in the HTML document.
- **Image_Optimization**: Process of serving images in modern formats (WebP/AVIF), at appropriate dimensions, with lazy loading.
- **Query_Waterfall**: Sequential data-fetching pattern where queries run one after another instead of in parallel.

## Requirements

### Requirement 1: Bundle Size Analysis and Reduction

**User Story:** As a mobile user, I want the app to load with minimal JavaScript, so that I can start using it quickly even on slow 3G/4G connections.

#### Acceptance Criteria

1. THE Bundle_Analyzer SHALL produce a report showing per-route JavaScript sizes and shared chunks for each route under the `(app)` layout group
2. WHEN the production build completes, THE App SHALL produce a total first-load JavaScript bundle of less than 150 KB gzipped for the dashboard route (`/`)
3. WHEN the production build completes, THE App SHALL produce a total first-load JavaScript bundle of less than 200 KB gzipped for any chart-displaying route (`/`, `/gastos`, `/patrimonio`)
4. THE App SHALL use Code_Splitting to load Recharts and chart components only on routes that display charts (`/`, `/gastos`, `/patrimonio`), ensuring that `/objetivos` and `/cierre` do not include Recharts in their JavaScript chunks
5. THE App SHALL use dynamic imports with `next/dynamic` for components exceeding 20 KB uncompressed that are not required at initial render (dialogs, form editors, sync dialog)
6. WHEN a route does not use a dependency, THE App SHALL exclude that dependency from the route's JavaScript chunk
7. THE App SHALL tree-shake unused exports from `lucide-react` so that the bundled lucide-react contribution does not exceed 15 KB gzipped across any single route

### Requirement 2: Rendering Performance Optimization

**User Story:** As a mobile user, I want pages to render quickly without jank, so that the app feels responsive and native-like.

#### Acceptance Criteria

1. THE App SHALL achieve an LCP of less than 2.5 seconds on a simulated mobile connection (Slow 4G, Moto G Power)
2. THE App SHALL achieve a CLS of less than 0.1 across all page navigations
3. THE App SHALL render loading skeletons whose height and width match the final rendered component dimensions within a 4px tolerance, so that no layout shift occurs when data replaces the skeleton
4. WHEN the dashboard loads, THE App SHALL render the AppShell and skeleton placeholders within the first contentful paint, before any data query response is received
5. THE App SHALL not re-compute net worth series or composition data on re-renders unless the underlying snapshots, accounts, or transactions data has changed, keeping re-render computation time under 16ms on a mid-tier mobile device (Moto G Power)
6. WHEN lists of transactions exceed 50 items, THE App SHALL render no more than 20 DOM nodes beyond the visible viewport at any time during scroll
7. THE App SHALL achieve an Interaction to Next Paint (INP) of less than 200ms across all interactive elements on a simulated mobile connection (Slow 4G, Moto G Power)

### Requirement 3: Network Efficiency and Data Fetching

**User Story:** As a mobile user on a limited data plan, I want the app to minimize redundant network requests, so that pages load fast and data usage stays low.

#### Acceptance Criteria

1. WHEN a page loads, THE App SHALL issue all queries required by that page's components concurrently using parallel useQuery hooks, avoiding sequential Query_Waterfall patterns where one query waits for another to resolve before firing
2. WHEN the user navigates between tabs within 60 seconds of the previous fetch, THE App SHALL render the page using cached query results without waiting for a network response, then revalidate data in the background via TanStack Query's stale-while-revalidate mechanism (staleTime of at least 60 seconds)
3. THE App SHALL set `Cache-Control: public, max-age=60, stale-while-revalidate=300` headers on read-only API responses that serve account, snapshot, goal, and transaction data to permit Supabase client-side caching
4. WHEN the dashboard loads, THE App SHALL fire the accounts, snapshots, goals, and transactions queries concurrently such that no query depends on the resolved result of another before executing
5. THE App SHALL deduplicate identical in-flight requests using TanStack Query's built-in deduplication so that multiple components requesting the same query key produce at most one network request at a time
6. IF a network request fails due to connectivity loss, THEN THE App SHALL retry the request exactly once after a 2-second delay before reporting failure
7. IF the retry described in criterion 6 also fails, THEN THE App SHALL display a non-blocking toast indicator stating the data could not be loaded, keep the indicator visible for at least 5 seconds or until the user dismisses it, and preserve any previously cached data on screen

### Requirement 4: Service Worker and Caching Strategy

**User Story:** As a mobile user, I want the app to work reliably even on flaky connections, so that I can check my finances anytime.

#### Acceptance Criteria

1. THE Service_Worker SHALL cache the App_Shell (navigation HTML, critical CSS, core JS) using a network-first strategy with cache fallback, caching successful navigation responses for offline use
2. THE Service_Worker SHALL cache static assets under `/_next/static/` using a cache-first strategy with no expiration (assets are content-hashed)
3. WHEN the user is offline and a navigation request is served from cache, THE Service_Worker SHALL serve the cached App_Shell and THE App SHALL display a persistent banner at the top of the viewport with the text "sin conexión" that remains visible until connectivity is restored
4. THE Service_Worker SHALL use a network-first strategy for same-origin API route responses (paths starting with `/api/`), falling back to cached responses no older than 5 minutes; IF a cached API response is older than 5 minutes, THEN THE Service_Worker SHALL return a network error response rather than stale data
5. THE Service_Worker SHALL name each cache with a version identifier matching the build deployment; WHEN a new Service_Worker activates, THE Service_Worker SHALL delete all caches whose name does not match the current version identifier
6. WHEN a new Service_Worker version is installed and waiting to activate, THE App SHALL display a dismissible toast notification with the text "actualización disponible" and a reload action; the toast SHALL appear at the bottom of the viewport and auto-dismiss after 10 seconds if not interacted with
7. THE Service_Worker SHALL NOT intercept cross-origin requests (including Supabase API calls), allowing them to pass through to the network unmodified

### Requirement 5: PWA App Shell and Offline Support

**User Story:** As a mobile user who has installed the PWA, I want instant app launch and basic functionality offline, so that the app feels like a native application.

#### Acceptance Criteria

1. THE App SHALL pre-cache the App_Shell (layout chrome, navigation, and global CSS/JS bundles) during Service_Worker installation so that subsequent launches render the shell in under 1 second on a warm start (device has previously loaded the app at least once)
2. WHILE the device is offline, THE App SHALL display the last-fetched data from TanStack Query's persisted cache, with a maximum cache age of 7 days, and show placeholder states for any query keys that have no cached entry
3. THE App SHALL persist TanStack Query cache to IndexedDB so that data survives app restarts and offline launches
4. IF IndexedDB is unavailable or the persistence write fails, THEN THE App SHALL fall back to in-memory cache only and continue operating without interrupting the user session
5. WHEN the app transitions from offline to online, THE App SHALL automatically revalidate all queries whose cached data is older than the configured staleTime without user intervention
6. WHILE the device has no connectivity, THE App SHALL display a fixed-position banner at the top of the viewport indicating offline status that does not obscure page content (page content is pushed below the banner or the banner overlays only unused space)
7. THE App SHALL include a Web App Manifest with `display: standalone`, a `theme_color` value, a `background_color` value, at least one icon at 192×192 px, and at least one maskable icon at 512×512 px

### Requirement 6: Mobile UX Performance

**User Story:** As a mobile user, I want touch interactions to respond instantly and scrolling to be buttery smooth, so that the app feels native.

#### Acceptance Criteria

1. THE App SHALL respond to touch interactions within 100ms (FID less than 100ms)
2. THE App SHALL apply `touch-action: manipulation` on all interactive elements (buttons, links, tab navigation items, and form inputs) to eliminate the 300ms tap delay
3. WHEN the user scrolls a list containing 50 or more items (transactions table, snapshots), THE App SHALL maintain 60fps scroll performance with no more than 5% of frames exceeding 16ms frame budget, by avoiding layout recalculations during scroll
4. THE App SHALL size all touch targets to at least 44×44 CSS pixels per WCAG 2.5.8 guidelines
5. WHILE the user is performing touch interactions (tap, swipe, scroll), THE App SHALL avoid synchronous JavaScript execution exceeding 50ms on the main thread
6. WHEN bottom tab navigation is tapped, THE App SHALL provide visual feedback (active state change) within 50ms before route transition completes
7. THE App SHALL meet all performance criteria defined in this requirement when measured on a mid-tier mobile device (4× CPU slowdown throttling in DevTools) over a 3G connection simulation

### Requirement 7: Image and Asset Optimization

**User Story:** As a mobile user, I want images and icons to load efficiently without consuming excess bandwidth.

#### Acceptance Criteria

1. THE App SHALL serve all raster images in WebP or AVIF format with a quality setting between 75 and 85 for photographic content and between 60 and 70 for non-photographic graphics
2. THE App SHALL use SVG for all UI icons (lucide-react) and inline any icon SVGs rendered on the initial viewport (above-the-fold) to avoid extra network requests
3. WHEN images are below the viewport fold, THE App SHALL lazy-load them using `loading="lazy"` or Intersection Observer
4. THE App SHALL specify explicit `width` and `height` attributes on all image elements to prevent CLS during loading
5. THE App SHALL preload assets identified as the Largest Contentful Paint (LCP) element on each route's initial viewport using `<link rel="preload">`
6. THE App SHALL compress PWA manifest icons to under 50 KB total for all sizes combined
7. IF the client browser does not support WebP or AVIF, THEN THE App SHALL serve a PNG or JPEG fallback for raster images

### Requirement 8: Font and CSS Optimization

**User Story:** As a mobile user, I want text to appear immediately without flashing unstyled content, so that the page feels stable from first paint.

#### Acceptance Criteria

1. THE App SHALL use `font-display: swap` for all custom fonts so that fallback text is visible within 100ms of navigation and custom glyphs replace them once loaded
2. THE App SHALL subset custom fonts to include only the Basic Latin (U+0000–007F) and Latin-1 Supplement (U+0080–00FF) Unicode ranges
3. THE App SHALL inline critical CSS for above-the-fold content into the HTML document head so that the first contentful paint occurs without any render-blocking CSS network requests
4. THE App SHALL produce a production CSS bundle that contains no unused utility classes, verified by a final CSS file size no larger than 50 KB (gzipped)
5. WHEN a page loads, THE App SHALL ensure all critical styles are parsed before first render so that no layout shift or flash of unstyled content occurs, measured by a Cumulative Layout Shift (CLS) score of 0.1 or less attributable to font or style loading
6. THE App SHALL preload the primary font file using `<link rel="preload" as="font" type="font/woff2" crossorigin>` so that font download begins before the CSS that references it is parsed

### Requirement 9: Lighthouse Score Targets

**User Story:** As a developer, I want the app to achieve high Lighthouse scores, so that I have a measurable benchmark for mobile performance.

#### Acceptance Criteria

1. THE App SHALL achieve a Lighthouse Performance score of 90 or above on mobile emulation (default Lighthouse throttling) for the dashboard route, measured as the median of 3 consecutive runs
2. THE App SHALL achieve a Lighthouse Best Practices score of 95 or above on mobile emulation for all routes under /(app)/, measured as the median of 3 consecutive runs
3. THE App SHALL achieve a Lighthouse Accessibility score of 95 or above on mobile emulation for all routes under /(app)/, measured as the median of 3 consecutive runs
4. THE App SHALL achieve a Lighthouse PWA badge (installable, service worker registered, cached offline page displayed when network is unavailable, served over HTTPS)
5. IF the median Lighthouse score for any audited route falls below the target thresholds defined in criteria 1–3, THEN THE App SHALL NOT be deployed to production until the scores meet or exceed the targets
6. THE App SHALL achieve a TTFB at the 95th percentile of less than 600ms for all server-rendered routes under /(app)/, measured from Vercel's edge network in the deployment region

### Requirement 10: Route Prefetching and Navigation Performance

**User Story:** As a mobile user navigating between sections, I want transitions to feel instant, so that the app responds as fast as switching tabs in a native app.

#### Acceptance Criteria

1. THE App SHALL prefetch visible navigation links using Next.js built-in Route_Prefetch on viewport intersection
2. WHEN the user hovers or touches a navigation link, THE App SHALL begin loading the target route's JavaScript chunk within 50ms of the interaction event
3. WHEN the user navigates to a route whose TanStack Query data is fresh (not stale), THE App SHALL complete the client-side route transition within 300ms measured from the navigation event to the first contentful paint of the target route
4. WHEN the user navigates to a route whose data is not yet cached or is stale, THE App SHALL display a route-level loading skeleton within 16ms (one animation frame) of the navigation event
5. WHEN navigating between tabs with cached data, THE App SHALL avoid a full-page re-render by reusing the shared App_Shell layout, keeping the navigation bar and header mounted in the DOM throughout the transition
6. THE App SHALL use React Suspense boundaries at the route level to enable streaming and incremental rendering of page sections
7. IF a route prefetch fails due to network unavailability, THEN THE App SHALL fall back to on-demand loading upon navigation and display the route-level loading skeleton until the route chunk is ready
