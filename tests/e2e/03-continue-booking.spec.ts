import { test, expect } from '@playwright/test';
import { ShowtimePage } from '../../src/pages/ShowtimePage';
import { LoginPage, gscCredentials } from '../../src/pages/LoginPage';
import { SeatSelectionPage } from '../../src/pages/SeatSelectionPage';
import { ComboPage } from '../../src/pages/ComboPage';
import { findStandardHallScreening } from '../../src/api/gscApi';
import { malaysianOperatingDate } from '../../src/utils/dates';

/**
 * STEP 3 — Continue booking.
 *
 * Select a seat, verify the order the page reports back, and continue into
 * checkout WITHOUT completing the purchase.
 *
 * ── Rules of engagement ────────────────────────────────────────────────────
 * GSC has no staging environment. Confirming a seat here reserves REAL
 * inventory on the live booking system until the hold expires. This test is
 * therefore deliberately minimal:
 *
 *   - exactly ONE seat, never a block
 *   - a standard 2D hall at an ordinary venue, resolved via the API
 *   - tomorrow's earliest screening, which is the lowest-demand slot available
 *   - it stops at the F&B step (/e-combo); payment is never reached
 *
 * Do not widen this test to select multiple seats or to proceed past
 * /e-combo without a deliberate decision about the production impact.
 */

test.describe('Step 3: continue booking', () => {
  const credentials = gscCredentials();

  test('a member can select a seat, see the order total, and reach checkout @auth @inventory', async ({ page }) => {
    test.skip(
      credentials === null,
      'Set GSC_MOBILE and GSC_PASSWORD in .env to run the authenticated booking journey.',
    );
    // Four page transitions across two applications on a production system.
    test.slow();

    const operatingDate = malaysianOperatingDate(1);
    const screening = await findStandardHallScreening(page.request, operatingDate);

    // --- sign in first ------------------------------------------------------
    // Selecting a showtime while anonymous redirects to /login and loses the
    // selection, so authentication has to come before the journey starts.
    const loginPage = new LoginPage(page);
    await loginPage.goto();
    await loginPage.login(credentials!.mobile, credentials!.password);

    // --- reach the seat map for a known standard-hall screening -------------
    const showtimePage = new ShowtimePage(page);
    await showtimePage.goto(screening.movie.code);
    await showtimePage.selectDate(operatingDate);

    const panel = showtimePage.cinemaPanel(screening.cinema);
    const tile = await showtimePage.findShowtimeOfType(panel, screening.type);
    await showtimePage.selectShowtime(tile);

    await expect(page).toHaveURL(/\/seat-selection/);

    const seatSelection = new SeatSelectionPage(page);
    await expect(seatSelection.seatRows.first()).toBeVisible();

    // Confirms we really are in an ordinary hall: premium houses render
    // recliner images and have no numbered seat cells at all.
    expect(
      await seatSelection.availableSeats.count(),
      'a standard hall should offer numbered, selectable seats',
    ).toBeGreaterThan(0);

    // --- 1. select an available seat ---------------------------------------
    const seatLabel = await seatSelection.selectFirstAvailableSeat();
    expect(seatLabel, 'the selected seat should be labelled').toMatch(/^[A-Z]+\d+$/);

    // --- 2. verify the order the page reports back -------------------------
    const order = seatSelection.orderBar;

    // The seat that was clicked is the seat in the order — not merely "a seat".
    await expect(order).toContainText(seatLabel);
    await expect(order, 'one seat should mean one ticket').toContainText(/Confirm\s*-\s*1\s*ticket/i);
    await expect(order, 'a ticket type should be applied').toContainText(/Adult\s*x\s*1/i);

    // The total must be a real price. "RM 0.00" here would mean a free ticket
    // was about to be issued — the assertion that would catch a pricing bug.
    const totalText = ((await seatSelection.total.textContent()) ?? '').trim();
    expect(totalText, 'the total should be shown in ringgit').toMatch(/^RM\s?\d+\.\d{2}$/);

    const totalValue = Number(totalText.replace(/[^\d.]/g, ''));
    expect(totalValue, 'a selected seat should cost more than nothing').toBeGreaterThan(0);

    // --- 3. continue toward checkout, without paying -----------------------
    await seatSelection.confirm();

    const combo = new ComboPage(page);
    await expect(page, 'confirming seats should advance to the F&B step').toHaveURL(/\/e-combo/);

    // The booking must survive the transition intact. Landing on *a* checkout
    // page proves nothing if the seat, film, or screening were dropped.
    await expect(combo.summary).toContainText(seatLabel);
    await expect(combo.summary).toContainText(new RegExp(escapeForRegExp(screening.cinema), 'i'));
    await expect(combo.summary).toContainText(/Adult\s*x\s*1/i);

    // STOP. The next step is payment and this suite never takes it.
    // Asserting it explicitly documents the boundary and fails loudly if a
    // future edit ever pushes past it.
    //
    // Checked against the PATH, not the whole URL: the booking engine's host is
    // "epaymentwebapp.gsc.com.my", which contains the substring "payment" and
    // makes a naive URL match fail on every single run.
    expect(
      new URL(page.url()).pathname,
      'the suite must never reach payment or confirmation',
    ).not.toMatch(/payment|pay|success|receipt|thank/i);
  });
});

/** Cinema names contain regex-significant characters such as "(" and "-". */
function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
