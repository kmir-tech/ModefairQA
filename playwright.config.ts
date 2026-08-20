import { defineConfig, devices } from '@playwright/test';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '.env'), quiet: true });

/**
 * GSC Malaysia (https://www.gsc.com.my) end-to-end suite.
 *
 * Two things about this target drive most of the configuration below:
 *
 * 1. The journey spans two independent applications on two hosts - the
 *    marketing site (www.gsc.com.my) and the Angular booking engine
 *    (epaymentwebapp.gsc.com.my). `baseURL` points at the marketing site;
 *    page objects for the booking engine use absolute URLs from env.
 *
 * 2. It is a LIVE PRODUCTION SITE. There is no staging environment and no
 *    webServer to start. Worker count is kept deliberately low so the suite
 *    behaves like a handful of users rather than a load test.
 */
export default defineConfig({
  testDir: './tests',

  fullyParallel: true,
  forbidOnly: !!process.env.CI,

  /* Retries locally too: the target is a third-party production site and
   * transient network failures are not test failures. Retries are for
   * infrastructure noise, never a substitute for fixing a flaky test. */
  retries: process.env.CI ? 2 : 1,

  /* Be a polite guest on someone else's production infrastructure. */
  workers: process.env.CI ? 2 : 3,

  /* Generous: real-world third-party site over the public internet. */
  timeout: 90_000,
  expect: { timeout: 15_000 },

  reporter: [
    ['list'],
    ['html', { open: 'never' }],
  ],

  use: {
    baseURL: process.env.BASE_URL ?? 'https://www.gsc.com.my',

    /* Showtimes are indexed by Malaysian operating date. Pinning locale and
     * timezone keeps "today" identical on a laptop in Kuala Lumpur and on a
     * UTC CI runner - otherwise date-chip tests fail nightly around midnight. */
    locale: 'en-MY',
    timezoneId: 'Asia/Kuala_Lumpur',

    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',

    actionTimeout: 20_000,
    navigationTimeout: 60_000,
  },

  projects: [
    /* Primary engine: the whole suite runs here. */
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },

    /* Cross-browser is deliberately a SUBSET, not a full re-run. Only specs
     * tagged @cross-browser execute here - rendering-sensitive and
     * layout-sensitive paths. Running everything everywhere multiplies CI
     * time and flakiness for very little extra signal. */
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
      grep: /@cross-browser/,
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
      grep: /@cross-browser/,
    },

  ],
});
