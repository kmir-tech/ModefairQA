import { test, expect } from '@playwright/test';

/**
 * Harness smoke test.
 *
 * Purpose: prove the toolchain can reach and render both applications in the
 * GSC journey before any flow-specific coverage is built on top. If this is
 * red, nothing else in the suite is trustworthy — triage here first.
 *
 * Deliberately thin. It is a harness check, not flow coverage; steps 1-4 own
 * the real assertions.
 */
test.describe('harness smoke @smoke', () => {
  test('marketing site serves the movie catalogue to an anonymous visitor', async ({ page }) => {
    await page.goto('/movies', { waitUntil: 'domcontentloaded' });

    // Proves the catalogue page itself rendered, not merely that a 200 came back.
    await expect(page.getByRole('heading', { name: 'Movies', level: 1 })).toBeVisible();

    // "Now Showing" is authored as <h2 role="tab">, so the explicit role wins
    // and it is a tab in the accessibility tree, not a heading. Assert what it
    // actually is, and assert it is the default-selected tab - that is the
    // behaviour a visitor depends on when landing on /movies.
    const nowShowingTab = page.getByRole('tab', { name: 'Now Showing' });
    await expect(nowShowingTab).toBeVisible();
    await expect(nowShowingTab).toHaveAttribute('aria-selected', 'true');

    // Proves the catalogue has actual bookable content, scoped to the Now
    // Showing panel specifically. Page-wide link counting would also pass on a
    // broken Now Showing tab, since Coming Soon links live in the same DOM.
    const nowShowingPanel = page.locator('#now-showing');
    const movieLinks = nowShowingPanel.locator('a[href*="/movie/"]');
    expect(await movieLinks.count()).toBeGreaterThan(0);
  });

  test('booking engine serves showtimes for a movie reached from the catalogue', async ({ page }) => {
    // The booking-engine id is not derivable from the marketing slug, so it
    // must be followed from the live catalogue rather than constructed.
    await page.goto('/movies', { waitUntil: 'domcontentloaded' });

    const bookingLink = page
      .locator('a[href*="epaymentwebapp.gsc.com.my/showtime-by-movies"]')
      .first();
    await expect(bookingLink).toBeAttached();

    const href = await bookingLink.getAttribute('href');
    expect(href, 'catalogue should link into the booking engine').toBeTruthy();

    await page.goto(href!, { waitUntil: 'domcontentloaded' });

    // Cross-origin handoff landed in the booking engine, not back on marketing.
    await expect(page).toHaveURL(/epaymentwebapp\.gsc\.com\.my\/showtime-by-movies/);

    // The three sections that make the page functional for picking a showtime.
    await expect(page.getByRole('heading', { name: 'Select Date' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Select Cinemas & Time' })).toBeVisible();
  });

  test('showtime API answers unauthenticated requests with well-formed XML', async ({ request }) => {
    const apiUrl = process.env.API_URL ?? 'https://epaymentapi.gsc.com.my';

    const response = await request.get(
      `${apiUrl}/showtimews/service.asmx/getEpaymentMovie_ParentChild?includeChild=true&parent=`,
    );

    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('xml');

    // The suite uses this endpoint as its assertion oracle, so an empty or
    // malformed payload has to fail loudly here rather than silently weaken
    // every downstream showtime comparison.
    const body = await response.text();
    expect(body).toContain('<films>');
    expect(body).toMatch(/<parent code="\d+"/);
  });
});
