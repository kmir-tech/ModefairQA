import { Locator, Page, expect } from '@playwright/test';

/**
 * The seat map at epaymentwebapp.gsc.com.my/seat-selection — the page a
 * signed-in member reaches by choosing a showtime.
 *
 * Verified 2026-08-20. The page renders the chosen screening as a summary
 * strip, the seat grid, then a fixed bottom bar carrying the running order:
 *
 *   SPIDER-MAN: BRAND NEW DAY  13  ENG  2 h 25 m  2D
 *   Kuala Lumpur - Mid Valley Megamall
 *   Fri 21 Aug, 10:00AM at Hall 2
 *   [seat grid]
 *   Seat Selection | Adult x 1 | G01 | RM 15.00 | Confirm - 1 ticket(s)
 *
 * Note there are NO heading elements on this page at all — not even an h1 — so
 * everything is addressed by text or by container class.
 *
 * THIS PAGE HOLDS REAL INVENTORY. Confirming a seat on GSC's production system
 * reserves it until the hold expires. Tests select exactly one seat, on a
 * low-demand early screening, and never proceed to payment.
 */
export class SeatSelectionPage {
  constructor(private readonly page: Page) {}

  /** Everything above the seat grid: film, cinema, date/time, format, hall. */
  get summary(): Locator {
    return this.page.locator('body');
  }

  /** The seat map container. Present whatever the hall type. */
  get seatMap(): Locator {
    return this.page.locator('.seat-selection');
  }

  /**
   * Rows of seats. The most hall-agnostic proof that a seat map rendered —
   * every hall type lays its seats out in `.seating-arrangement` rows.
   */
  get seatRows(): Locator {
    return this.page.locator('.seating-arrangement');
  }

  /**
   * Individual bookable seats.
   *
   * GSC renders seats differently per hall type, verified 2026-08-20:
   *
   *   standard halls  -> a div carrying `seat-style` with a label like "H01"
   *   premium halls   -> a recliner image carrying `two-seater-img`
   *                      (Getha Lux Suite and similar)
   *
   * A locator covering only the first kind passes on ordinary halls and fails
   * on premium ones — which is exactly how this was found. Addressed by class
   * because seats are plain divs and images with no role, label, or test id;
   * `getByText(/^[A-K]\d{2}$/)` matches none of them.
   */
  get seats(): Locator {
    return this.page.locator('.seat-style.not-blank, .two-seater-img');
  }

  /**
   * Seats in a standard hall that are free to pick.
   *
   * Availability is encoded only in the Tailwind background class: free seats
   * are white, and a seat turns `bg-gsc-main-yellow` once selected. There is no
   * disabled attribute, aria-pressed, or any other semantic signal.
   *
   * Because that inference cannot be fully trusted, `selectSeat` verifies the
   * seat actually became selected rather than assuming the click landed on a
   * free one.
   */
  get availableSeats(): Locator {
    return this.page.locator('.seat-style.not-blank[class*="bg-[#FFFFFF]"]');
  }

  /** The fixed bottom bar holding the running order and the Confirm control. */
  get orderBar(): Locator {
    return this.page.locator('.btm-btn');
  }

  /** Order total, e.g. "RM 15.00". */
  get total(): Locator {
    return this.orderBar.locator('.font-montBold');
  }

  /**
   * The Confirm control.
   *
   * ACCESSIBILITY DEFECT: this is a plain <div class="btn-style"> with no
   * role, no tabindex, and no accessible name, so it is neither keyboard
   * reachable nor announced as a control. `getByRole('button', …)` matches
   * nothing on this page — verified. Hence the class-based locator.
   */
  get confirmButton(): Locator {
    return this.orderBar.locator('.btn-style');
  }

  async seatCount(): Promise<number> {
    return this.seats.count();
  }

  /** Every seat cell in a standard hall, free or not. */
  private get allStandardSeats(): Locator {
    return this.page.locator('.seat-style.not-blank');
  }

  /**
   * Select the first free seat and confirm it registered.
   *
   * Returns the seat label (e.g. "G01") so the caller can assert it appears in
   * the order summary and, later, on the checkout page.
   *
   * The seat is pinned BY INDEX into the full seat list, which is the only
   * handle that survives selecting it. `availableSeats.first()` is defined by
   * the white-background class, so the instant the seat turns yellow it stops
   * matching and the locator silently re-resolves to the NEXT free seat —
   * which then reads as "still not selected" forever. Selection changes only
   * the colour class, never `seat-style`/`not-blank`, so the index is stable.
   */
  async selectFirstAvailableSeat(): Promise<string> {
    const classNames = await this.allStandardSeats.evaluateAll((cells) =>
      cells.map((cell) => cell.className),
    );

    const index = classNames.findIndex((className) => className.includes('bg-[#FFFFFF]'));
    expect(index, 'the hall should have at least one free seat').toBeGreaterThan(-1);

    const seat = this.allStandardSeats.nth(index);
    const label = ((await seat.textContent()) ?? '').trim();

    // The grid paints before Angular finishes binding its click handlers, so a
    // click can land on a fully rendered seat and do nothing. Retried until the
    // seat reports itself selected.
    //
    // Toggle-safe on purpose: clicking a selected seat DESELECTS it, so a naive
    // retry loop would flip it back off on the next pass. The click only fires
    // while the seat is still unselected.
    await expect(async () => {
      const className = (await seat.getAttribute('class')) ?? '';
      if (!className.includes('bg-gsc-main-yellow')) {
        await seat.click();
      }

      // Also proves the click landed on a genuinely free seat. Without this the
      // test would sail on after clicking an occupied or blocked one and fail
      // later, somewhere far less obvious.
      await expect(
        seat,
        `seat ${label} should become selected after clicking it`,
      ).toHaveClass(/bg-gsc-main-yellow/, { timeout: 3_000 });
    }).toPass({ timeout: 30_000 });

    return label;
  }

  /** Continue to the next checkout step (the F&B upsell at /e-combo). */
  async confirm(): Promise<void> {
    await this.confirmButton.click();
  }
}
