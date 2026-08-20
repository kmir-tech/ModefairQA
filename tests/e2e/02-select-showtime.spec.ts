import { test, expect } from '@playwright/test';
import { ShowtimePage } from '../../src/pages/ShowtimePage';
import { LoginPage, gscCredentials } from '../../src/pages/LoginPage';
import { SeatSelectionPage } from '../../src/pages/SeatSelectionPage';
import { findMovieWithShowtimes, fetchShowtimes } from '../../src/api/gscApi';
import { malaysianOperatingDate } from '../../src/utils/dates';

/**
 * STEP 2 — Select a showtime, and verify the booking journey continues.
 *
 * The film under test is resolved through the API rather than by clicking
 * through the catalogue: it guarantees a film that actually has screenings on
 * the chosen date, and keeps the browser test focused on showtime selection
 * instead of re-testing step 1.
 */

test.describe('Step 2: select a date and showtime', () => {
  test('the showtime grid for a selected date matches the booking backend @smoke', async ({
    page,
    request,
  }) => {
    // Tomorrow, deliberately: today's grid shrinks through the day as
    // screenings start, so a same-day run is comparing against a moving target.
    const operatingDate = malaysianOperatingDate(1);
    const { movie } = await findMovieWithShowtimes(request, operatingDate);

    const showtimePage = new ShowtimePage(page);
    await showtimePage.goto(movie.code);

    // --- select an available date -----------------------------------------
    expect(
      await showtimePage.availableDates(),
      'the date picker should offer the date under test',
    ).toContain(operatingDate);

    await showtimePage.selectDate(operatingDate);
    expect(await showtimePage.selectedDate()).toBe(operatingDate);

    // --- the grid must belong to that date ---------------------------------
    const panel = await showtimePage.firstCinemaWithShowtimes();
    const cinema = await showtimePage.cinemaName(panel);
    const uiShowtimes = await showtimePage.readShowtimes(panel);

    const apiShowtimes = (await fetchShowtimes(request, movie.code, operatingDate)).filter(
      (showtime) => showtime.cinema === cinema,
    );

    // The assertion that gives this test its value. "Some showtimes rendered"
    // would pass while the page showed another film's times, another date's
    // times, or a stale cache. Comparing the exact set against the backend
    // fails in all three cases.
    const normalise = (times: { time: string }[]) =>
      times.map((showtime) => showtime.time.replace(/\s+/g, '')).sort();

    expect(
      normalise(uiShowtimes),
      `showtimes rendered for "${cinema}" on ${operatingDate} should match the booking API exactly`,
    ).toEqual(normalise(apiShowtimes));

    expect(uiShowtimes.length, 'the chosen cinema should have screenings').toBeGreaterThan(0);
  });
});

test.describe('Step 2: the booking journey continues', () => {
  const credentials = gscCredentials();

  test('selecting a showtime carries a signed-in member into seat selection', async ({ page }) => {
    test.skip(
      credentials === null,
      'Set GSC_MOBILE and GSC_PASSWORD in .env to run the authenticated booking journey.',
    );
    // Signing in and loading the seat map crosses two applications on a
    // production system; the default timeout is not enough.
    test.slow();

    const operatingDate = malaysianOperatingDate(1);
    const { movie } = await findMovieWithShowtimes(page.request, operatingDate);

    // Sign in FIRST. Selecting a showtime while anonymous redirects to /login
    // and the redirect carries no return URL, so the chosen screening would be
    // lost (docs/app-recon.md section 6).
    const loginPage = new LoginPage(page);
    await loginPage.goto();
    await loginPage.login(credentials!.mobile, credentials!.password);

    const showtimePage = new ShowtimePage(page);
    await showtimePage.goto(movie.code);
    await showtimePage.selectDate(operatingDate);

    const panel = await showtimePage.firstCinemaWithShowtimes();
    const cinema = await showtimePage.cinemaName(panel);
    const chosen = await showtimePage.readShowtime(showtimePage.showtimes(panel).first());

    await showtimePage.selectShowtime(showtimePage.showtimes(panel).first());

    // The journey must move ON to seat selection, not bounce back to the auth
    // gate the way an anonymous visitor does.
    await expect(page).toHaveURL(/\/seat-selection/);

    // It must carry the chosen screening through — landing on *a* seat map is
    // not the same as landing on the one for the screening that was picked.
    const seatSelection = new SeatSelectionPage(page);
    await expect(seatSelection.summary).toContainText(new RegExp(escapeForRegExp(cinema), 'i'));
    await expect(seatSelection.summary).toContainText(
      new RegExp(escapeForRegExp(chosen.type), 'i'),
    );

    // The page renders the time with a space ("3:35 PM") in the seat grid and
    // without one ("3:35PM") in the summary strip, so match either.
    const timePattern = chosen.time.replace(/(AM|PM)$/i, '\\s*$1');
    await expect(seatSelection.summary).toContainText(new RegExp(timePattern, 'i'));

    // A seat map that renders no seats is a broken booking page that would
    // still satisfy every assertion above. Waited on rather than counted
    // immediately — the grid renders after the summary strip.
    await expect(seatSelection.seatRows.first()).toBeVisible();
    expect(await seatSelection.seatCount(), 'the seat map should render seats').toBeGreaterThan(0);

    // Nothing selected, nothing held: proof the test stopped where it should.
    await expect(seatSelection.confirmButton).toContainText(/0\s*ticket/i);

    // NOTE: the journey deliberately stops here. GSC has no staging
    // environment, so this suite never holds seat inventory and never proceeds
    // to payment.
  });
});

/** Cinema names contain regex-significant characters such as "(" and "-". */
function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
