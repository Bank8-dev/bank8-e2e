// SPDX-FileCopyrightText: Copyright Logically Magic Inc. <hello@logicallymagic.com>
// SPDX-FileCopyrightText: Copyright Hamid Jahanzad <Hamid@Jahanzad.com>
// SPDX-FileCopyrightText: Copyright Contributors to the Bank8:E2E
// SPDX-License-Identifier: Apache-2.0

// ── bank8 e2e - Playwright TypeScript configuration ──────────────────────
//
// Platform setup happens ONCE in tests/global-setup.ts via the sentin8-cli
// binary (org/env/features/app instances/staff users) - no Dash-driven
// platform setup. UI tests drive ONLY the three bank8 apps (admin, ebank,
// eteller; the recipient app moved to the openfin8-e2e suite). Dash
// coverage lives in the sentin8 e2e suite.
//
// Suites:
//   bank8_lifecycle - serial UI lifecycle across the 4 bank8 apps
//   protocol/       - HTTP-only tenant auth / resolution / token-exchange

import { defineConfig, devices } from '@playwright/test';
import { platformDomain } from './fixtures/env.js';

const DOMAIN = platformDomain();
// Failfast: stop the entire run on the very first test failure.
// Override with PLAYWRIGHT_MAX_FAILURES=0 (unlimited) if needed.
const MAX_FAILURES = Number.parseInt(process.env.PLAYWRIGHT_MAX_FAILURES ?? '1', 10);
// Headed mode: default to headed (visible browser) so failures are visible.
// Override with PLAYWRIGHT_HEADLESS=true for CI.
const HEADLESS = (process.env.PLAYWRIGHT_HEADLESS ?? 'false') === 'true';
const WORKERS = Number.parseInt(process.env.PLAYWRIGHT_WORKERS ?? '1', 10);

export default defineConfig({
  testDir: './tests',
  // Platform setup (org/env/apps/users) via sentin8-cli - runs once.
  globalSetup: './tests/global-setup.ts',
  // Failfast: stop the entire run after MAX_FAILURES test failures.
  // Playwright's --max-failures CLI flag overrides this.
  maxFailures: MAX_FAILURES,
  // The lifecycle spec is serial (state flows between its tests). The
  // user can opt in to parallelism for the protocol suites (which are
  // independent) via PLAYWRIGHT_WORKERS.
  fullyParallel: false,
  workers: WORKERS,
  retries: 0,
  timeout: 300_000,
  expect: {
    timeout: 10_000,
  },
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'playwright-report' }],
    ['json', { outputFile: 'playwright-report/results.json' }],
  ],
  use: {
    // Default to the eBank app URL - the customer app most specs drive.
    // Each spec navigates explicitly anyway.
    baseURL: `https://bank8-ebank.prod.ibank.${DOMAIN}`,
    headless: HEADLESS,
    viewport: { width: 1280, height: 800 },
    colorScheme: 'dark', // Run Chromium in dark theme (prefers-color-scheme: dark)
    ignoreHTTPSErrors: true, // self-signed local CA
    bypassCSP: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Pass the local CA cert to Chromium so cross-origin fetch()
        // calls (app → its bff8.{app}.{env}.{org-domain} proxy) trust the
        // self-signed cert. ignoreHTTPSErrors only covers page navigation,
        // not in-page fetch() calls.
        launchOptions: {
          args: [
            `--ignore-certificate-errors`,
            // Disable Chrome's secure DNS (DNS over HTTPS) so it uses the
            // system DNS resolver - required for local test domains.
            `--disable-features=DnsOverHttps`,
            // Enable Chromium's dark theme:
            //   * WebContentsForceDark auto-darkens light-themed pages
            //   * force-dark-mode / prefers-color-scheme=dark flips the
            //     media query so apps that respect it render dark UI.
            `--enable-features=WebContentsForceDark`,
            `--force-prefers-color-scheme=dark`,
          ],
        },
      },
    },
  ],
  // Per-test artifacts (traces, videos, screenshots).
  outputDir: 'test-results',
});
