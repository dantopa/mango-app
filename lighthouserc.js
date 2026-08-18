/** @type {import('@lhci/cli').LighthouseConfig} */
module.exports = {
  ci: {
    collect: {
      numberOfRuns: 3,
      url: [
        'http://localhost:3000/',
        'http://localhost:3000/gastos',
        'http://localhost:3000/patrimonio',
        'http://localhost:3000/objetivos',
        'http://localhost:3000/cierre',
      ],
      startServerCommand: 'npm run start',
      startServerReadyPattern: 'Ready',
      settings: {
        preset: 'desktop',
        emulatedFormFactor: 'mobile',
        // Use default Lighthouse mobile throttling
        throttling: {
          rttMs: 150,
          throughputKbps: 1638.4,
          cpuSlowdownMultiplier: 4,
          requestLatencyMs: 0,
          downloadThroughputKbps: 0,
          uploadThroughputKbps: 0,
        },
        screenEmulation: {
          mobile: true,
          width: 412,
          height: 823,
          deviceScaleFactor: 1.75,
          disabled: false,
        },
      },
    },
    assert: {
      // No 'categories:pwa' — Lighthouse 12 dropped the PWA category.
      assertions: {
        'categories:performance': ['error', { minScore: 0.9, aggregationMethod: 'median-run' }],
        'categories:best-practices': ['error', { minScore: 0.95, aggregationMethod: 'median-run' }],
        'categories:accessibility': ['error', { minScore: 0.95, aggregationMethod: 'median-run' }],
      },
    },
    upload: {
      target: 'temporary-public-storage',
    },
  },
};
