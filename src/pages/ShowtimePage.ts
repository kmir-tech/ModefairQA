import { Locator, Page, expect } from '@playwright/test';

/**
 * The showtime picker in the booking engine:
 *   epaymentwebapp.gsc.com.my/showtime-by-movies?id={movieId}
 *
 * Angular 20 + Angular Material. Structure verified 2026-08-20
 * (docs/app-recon.md section 16):
 *
 *   Select Date       -> <button id="2026-08-20" class="date-option-container active">
 *   Select Cinemas    -> <mat-expansion-panel> per venue, <h3> holds the name
 *   Showtimes         -> <div role="button" class="showtime-option-container">
 *                          <p class="showtime"> 3:35PM<span class="hidden">*</span></p>
 *                          <p class="show-type">IMAX</p>
 *
 * Two things to know before changing anything here:
 *
 *  - Showtimes are DIVs with role="button", not <button> elements, so
 *    `locator('button')` finds none of them.
 *  - The accordion header is itself role="button", so showtime lookups are
 *    scoped to the panel's [role=region] body to avoid matching the header.
 */

export interface UiShowtime {
  time: string;
  type: string;
}

export class ShowtimePage {
  constructor(private readonly page: Page) {}

  private get bookingBaseUrl(): string {
    return process.env.BOOKING_URL ?? 'https://epaymentwebapp.gsc.com.my';
  }

  async goto(movieId: string): Promise<void> {
    await this.page.goto(`${this.bookingBaseUrl}/showtime-by-movies?id=${movieId}`, {
      waitUntil: 'domcontentloaded',
    });
    await expect(this.page.getByRole('heading', { name: 'Select Date' })).toBeVisible();
  }

  get filmTitle(): Locator {
    return this.page.getByRole('heading', { level: 1 });
  }

  // ---------------------------------------------------------------- dates

  /**
   * Date chips carry the Malaysian operating date as their DOM id
   * (id="2026-08-20"), which is the most stable handle on this page.
   * An attribute selector is required — a CSS id selector cannot start with a
   * digit.
   */
  dateChip(operatingDate: string): Locator {
    return this.page.locator(`[id="${operatingDate}"]`);
  }

  /** Operating dates offered, oldest first. */
  async availableDates(): Promise<string[]> {
    return this.page
      .locator('.date-option-container')
      .evaluateAll((chips) => chips.map((chip) => chip.id).filter(Boolean));
  }

  async selectedDate(): Promise<string | null> {
    const active = this.page.locator('.date-option-container.active').first();
    return (await active.count()) ? active.getAttribute('id') : null;
  }

  /**
   * Choose a date and wait for the grid to actually belong to it.
   *
   * The showtime grid reloads from the API on selection, so callers must not
   * read showtimes until the chip reports itself active.
   */
  async selectDate(operatingDate: string): Promise<void> {
    const chip = this.dateChip(operatingDate);
    await expect(chip, `date ${operatingDate} should be offered`).toBeVisible();

    // Selecting a date refetches the grid. Synchronising on that response is
    // what makes the rest deterministic: without it the panels are still being
    // re-rendered when the caller starts reading them, and showtime tiles
    // detach mid-click ("Element is not attached to the DOM").
    //
    // Tolerant of no request firing at all — re-selecting the already-active
    // date is a no-op in the app.
    const gridReloaded = this.page
      .waitForResponse(
        (response) =>
          response.url().includes('getShowTimesByMovie_ParentChild_V2') &&
          response.url().includes(`oprndate=${operatingDate}`) &&
          response.status() === 200,
        { timeout: 30_000 },
      )
      .catch(() => undefined);

    await chip.click();
    await expect(chip).toHaveClass(/\bactive\b/);
    await gridReloaded;
  }

  // -------------------------------------------------------------- cinemas

  get cinemaPanels(): Locator {
    return this.page.locator('mat-expansion-panel');
  }

  /**
   * One cinema's accordion, matched on the exact venue name.
   *
   * `exact: true` and `.first()` both matter: accessible-name matching is
   * substring-based by default, so "Kuala Lumpur - Mid Valley Megamall" would
   * also match longer venue names, and a multi-element panel locator breaks
   * every nth() lookup underneath it.
   */
  cinemaPanel(name: string): Locator {
    return this.cinemaPanels
      .filter({ has: this.page.getByRole('heading', { name, level: 3, exact: true }) })
      .first();
  }

  async cinemaName(panel: Locator): Promise<string> {
    return ((await panel.locator('h3').first().textContent()) ?? '').replace(/\s+/g, ' ').trim();
  }

  /**
   * Showtime tiles inside one cinema panel.
   * Scoped to the panel body so the accordion header (also role="button") and
   * neighbouring panels cannot leak in.
   */
  showtimes(panel: Locator): Locator {
    return panel.locator('[role=region] .showtime-option-container');
  }

  /**
   * The first cinema that actually has screenings.
   *
   * Not every venue screens every film, so several panels are legitimately
   * empty. Picking blindly by index is the classic way to make this test fail
   * for a correct application.
   */
  async firstCinemaWithShowtimes(): Promise<Locator> {
    const panels = this.cinemaPanels;
    const total = await panels.count();

    for (let i = 0; i < total; i++) {
      const panel = panels.nth(i);
      if ((await this.showtimes(panel).count()) > 0) return panel;
    }

    throw new Error('No cinema on the showtime page is screening this film on the selected date.');
  }

  /** Read one showtime tile. The "*" is a hidden span and is stripped. */
  async readShowtime(tile: Locator): Promise<UiShowtime> {
    const time = ((await tile.locator('.showtime').textContent()) ?? '')
      .replace(/\*/g, '')
      .replace(/\s+/g, '')
      .trim();

    const type = ((await tile.locator('.show-type').textContent()) ?? '').replace(/\s+/g, ' ').trim();

    return { time, type };
  }

  async readShowtimes(panel: Locator): Promise<UiShowtime[]> {
    const tiles = this.showtimes(panel);
    const total = await tiles.count();
    const results: UiShowtime[] = [];

    for (let i = 0; i < total; i++) {
      results.push(await this.readShowtime(tiles.nth(i)));
    }
    return results;
  }

  /**
   * The first screening of a given format within a cinema panel.
   *
   * Deliberately NOT matched on an exact time from the API. The API read and
   * the UI render happen seconds apart, and a screening can drop out of the
   * grid in between (it sells out, or its start time passes). Requiring an
   * exact time made the test fail for a perfectly healthy application.
   *
   * The format still pins the hall type, which is what the caller actually
   * cares about.
   */
  async findShowtimeOfType(panel: Locator, type: string): Promise<Locator> {
    const tiles = this.showtimes(panel);
    const total = await tiles.count();
    const seen: string[] = [];

    for (let i = 0; i < total; i++) {
      const showtime = await this.readShowtime(tiles.nth(i));
      if (showtime.type === type) return tiles.nth(i);
      seen.push(`${showtime.time}/${showtime.type}`);
    }

    throw new Error(
      `No ${type} screening in this cinema on the selected date. ` +
        `Screenings present: ${seen.join(', ') || '(none)'}`,
    );
  }

  /**
   * Select a screening. Anonymously this redirects to /login; signed in it
   * opens the seat map.
   *
   * No explicit scrollIntoViewIfNeeded — `click()` already scrolls and waits
   * for actionability, and the extra call added a second chance for the tile to
   * detach while the grid was re-rendering.
   */
  async selectShowtime(tile: Locator): Promise<void> {
    await tile.click();
  }
}
