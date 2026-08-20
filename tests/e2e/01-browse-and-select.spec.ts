import { test, expect } from '@playwright/test';
import { HomePage } from '../../src/pages/HomePage';
import { MoviesPage } from '../../src/pages/MoviesPage';
import { MovieDetailPage } from '../../src/pages/MovieDetailPage';
import { CinemasPage, CinemaDetailPage } from '../../src/pages/CinemasPage';
import { fetchBookableMovies, normaliseTitle } from '../../src/api/gscApi';

/**
 * STEP 1 — Browse and select.
 *
 * A visitor opens the GSC site, sees what is available, and picks either a
 * movie or a cinema to continue with.
 *
 * Everything here is driven by live data. Not one film title, cinema name, or
 * count is hardcoded: the catalogue changes daily, so the suite asserts
 * RELATIONSHIPS ("the page I opened is the film I clicked") rather than values
 * ("the page says The Odyssey"), which would rot within a week.
 */

test.describe('Step 1: browse and select a movie', () => {
  test('visitor can reach the movie catalogue from the homepage @smoke @cross-browser', async ({ page }) => {
    // The homepage's client-side route transition is measured at ~13s alone and
    // 45-58s under parallel load. Marked slow so the suite reports the real
    // behaviour rather than flaking on a product performance defect.
    test.slow();

    const home = new HomePage(page);
    const movies = new MoviesPage(page);

    await home.goto();
    await home.openMovies();

    await expect(page).toHaveURL(/\/movies\/?$/);

    // URL alone proves only that a route resolved. These prove the catalogue
    // itself rendered, and that Now Showing is the tab a visitor lands on.
    await expect(movies.heading).toBeVisible();
    await expect(movies.tab('Now Showing')).toHaveAttribute('aria-selected', 'true');
    await expect(movies.panel('Now Showing')).toBeVisible();
  });

  test('Now Showing displays films with the details needed to choose one', async ({ page }) => {
    const movies = new MoviesPage(page);
    await movies.goto();

    const cards = movies.cards('Now Showing');
    expect(await cards.count(), 'Now Showing should list at least one film').toBeGreaterThan(0);

    // Sample rather than sweep all ~33: enough to catch a systemic rendering
    // fault without hammering a production site.
    const sampled = await movies.readCards('Now Showing', 5);

    for (const card of sampled) {
      expect(card.title, 'every card should show a film title').not.toBe('');
      expect(card.posterAlt, `"${card.title}" should have a described poster`).toContain('movie poster');
      expect(card.detailHref, `"${card.title}" should link to its detail page`).toMatch(/^\/movie\//);

      // A film in Now Showing is by definition on sale, so a missing booking
      // link here is a genuine loss of revenue, not a cosmetic gap.
      expect(card.bookingHref, `"${card.title}" is showing now and must be bookable`).toContain(
        'showtime-by-movies',
      );
    }
  });

  test('every film advertised as bookable is known to the booking engine', async ({ page, request }) => {
    const movies = new MoviesPage(page);
    await movies.goto();

    const advertisedIds = await movies.bookableMovieIds('Now Showing');
    expect(advertisedIds.length, 'Now Showing should advertise bookable films').toBeGreaterThan(0);

    const knownIds = new Set((await fetchBookableMovies(request)).map((movie) => movie.code));

    // Catches the marketing site advertising a film the booking engine cannot
    // sell — a broken journey that renders perfectly and would pass any
    // UI-only assertion.
    const unknown = advertisedIds.filter((id) => !knownIds.has(id));
    expect(unknown, `booking engine does not recognise movie id(s): ${unknown.join(', ')}`).toEqual([]);
  });

  test('selecting a film opens that film’s detail page @smoke', async ({ page }) => {
    const movies = new MoviesPage(page);
    const detail = new MovieDetailPage(page);
    await movies.goto();

    const card = movies.cards('Now Showing').first();
    const { title: selectedTitle, detailHref } = await movies.readCard(card);

    await movies.openDetail(card);

    await expect(page).toHaveURL(new RegExp(`${detailHref}/?$`));

    // The assertion that matters: we landed on the film we picked. Asserting
    // merely that "a detail page loaded" would pass if every card linked to
    // the same wrong film.
    //
    // Polled rather than read once: the heading is rendered client-side and
    // still holds the previous page's text for a moment after the URL changes.
    await expect
      .poll(async () => normaliseTitle(await detail.titleText()), {
        message: `detail page should be for the film selected on the catalogue ("${selectedTitle}")`,
      })
      .toBe(normaliseTitle(selectedTitle));

    await expect(detail.section('Synopsis')).toBeVisible();
    await expect(detail.metadata('Running Time')).toBeVisible();
  });

  test('the detail page books the film being viewed, not a related film', async ({ page }) => {
    const movies = new MoviesPage(page);
    const detail = new MovieDetailPage(page);
    await movies.goto();

    const card = movies.cards('Now Showing').first();
    const { bookingHref } = await movies.readCard(card);
    const expectedId = new URL(bookingHref!).searchParams.get('id');

    await movies.openDetail(card);

    // The page also carries a related-films carousel whose cards link to other
    // movie ids. If the primary CTA ever picked one of those up, booking would
    // quietly send the visitor to the wrong film.
    await expect(detail.bookingCta).toBeVisible();
    expect(await detail.bookingMovieId()).toBe(expectedId);
  });

  test('selecting Buy Now opens the booking engine for the same film', async ({ page, context }) => {
    const movies = new MoviesPage(page);
    await movies.goto();

    const card = movies.cards('Now Showing').first();
    const { title, bookingHref } = await movies.readCard(card);
    const expectedId = new URL(bookingHref!).searchParams.get('id');

    const booking = await movies.openBookingInNewTab(card);

    try {
      // target="_blank": the booking engine arrives as a new tab and the
      // catalogue stays put, so the visitor does not lose their place.
      expect(context.pages()).toHaveLength(2);
      await expect(page).toHaveURL(/\/movies\/?$/);

      await expect(booking).toHaveURL(new RegExp(`id=${expectedId}`));

      // Proves the cross-application handoff carried the right film through,
      // rather than just landing somewhere on the booking domain.
      await expect(booking.getByRole('heading', { level: 1 })).toHaveText(
        new RegExp(escapeForRegExp(title.trim()), 'i'),
      );
    } finally {
      await booking.close();
    }
  });
});

test.describe('Step 1: catalogue sections behave correctly', () => {
  test('switching to Advance Sales replaces the Now Showing listing', async ({ page }) => {
    const movies = new MoviesPage(page);
    await movies.goto();

    await movies.selectTab('Advance Sales');

    await expect(movies.tab('Now Showing')).toHaveAttribute('aria-selected', 'false');
    // All panels share the DOM, so "the other one is hidden" is the real
    // behaviour under test — not merely "the new one appeared".
    await expect(movies.panel('Now Showing')).toBeHidden();
    expect(await movies.cards('Advance Sales').count()).toBeGreaterThan(0);
  });

  test('Coming Soon films are browsable but not yet bookable', async ({ page }) => {
    const movies = new MoviesPage(page);
    await movies.goto();

    await movies.selectTab('Coming Soon');

    const detailLinks = movies.panel('Coming Soon').locator('a[href^="/movie/"]');
    expect(await detailLinks.count(), 'Coming Soon should list upcoming films').toBeGreaterThan(0);

    // Unreleased films must not be on sale. A stray "Buy Now" here would send
    // visitors to a showtime page with nothing to book.
    expect(await movies.bookableMovieIds('Coming Soon')).toEqual([]);
  });

  test('an empty catalogue section explains itself instead of rendering a blank grid', async ({ page }) => {
    const movies = new MoviesPage(page);
    await movies.goto();

    await movies.selectTab('Layar Malaysia');

    const panel = movies.panel('Layar Malaysia');
    const cardCount = await movies.cards('Layar Malaysia').count();

    if (cardCount === 0) {
      await expect(panel).toContainText(/stay tuned/i);
    } else {
      // The section has been populated since this was written. That is fine —
      // but it must then behave like any other populated section.
      await expect(panel.locator('a[href^="/movie/"]').first()).toBeAttached();
    }
  });
});

test.describe('Step 1: browse and select a cinema', () => {
  test('visitor can reach the cinema directory from the homepage @smoke', async ({ page }) => {
    test.slow(); // Same slow homepage navigation as the movie-catalogue route.

    const home = new HomePage(page);
    const cinemas = new CinemasPage(page);

    await home.goto();
    await home.openCinemaBrand('GSC Cinemas');

    await expect(page).toHaveURL(/\/cinemas\/gsc\/?$/);
    await expect(cinemas.heading).toBeVisible();

    expect(await cinemas.entries.count(), 'the directory should list venues').toBeGreaterThan(0);

    // A directory entry is only useful if it says where the cinema is.
    for (const entry of await cinemas.readEntries(5)) {
      expect(entry.name, 'every entry should name the venue').not.toBe('');
      expect(entry.location, `"${entry.name}" should show its location`).not.toBe('');
      expect(entry.detailHref).toMatch(/^\/cinema\//);
    }
  });

  test('filtering the directory by location narrows it to that location', async ({ page }) => {
    const cinemas = new CinemasPage(page);
    await cinemas.goto();

    const totalBefore = await cinemas.entries.count();

    // Read a real location off the page rather than hardcoding one — GSC's
    // labels are Malaysian state names ("Pulau Pinang", not "Penang").
    const location = (await cinemas.readEntry(cinemas.entries.first())).location;

    await cinemas.filterByLocation(location);

    await expect
      .poll(async () => (await cinemas.listedLocations()).length, {
        message: `filtering by "${location}" should leave at least one venue`,
      })
      .toBeGreaterThan(0);

    // The filter must actually exclude other locations. Asserting only that
    // results remain would pass on a filter that does nothing at all — which
    // is exactly how this behaves if the Search button is never clicked.
    const shown = await cinemas.listedLocations();
    expect(Array.from(new Set(shown))).toEqual([location]);
    expect(shown.length).toBeLessThanOrEqual(totalBefore);

    await cinemas.resetFilters();
    await expect.poll(async () => cinemas.entries.count()).toBe(totalBefore);
  });

  test('selecting a cinema opens that venue’s page', async ({ page }) => {
    const cinemas = new CinemasPage(page);
    const venue = new CinemaDetailPage(page);
    await cinemas.goto();

    const entry = cinemas.entries.first();
    const { name: selectedName, detailHref } = await cinemas.readEntry(entry);

    await cinemas.openCinema(entry);

    await expect(page).toHaveURL(new RegExp(`${detailHref}/?$`));

    // Same principle as the movie path: prove we opened the venue we chose.
    // Polled for the same client-side render reason.
    await expect
      .poll(async () => normaliseTitle(await venue.nameText()), {
        message: `venue page should be for the cinema selected in the directory ("${selectedName}")`,
      })
      .toBe(normaliseTitle(selectedName));
  });
});

/** Film titles contain regex-significant characters such as ":" and "(". */
function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
