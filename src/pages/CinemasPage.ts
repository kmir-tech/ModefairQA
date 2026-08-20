import { Locator, Page, expect } from '@playwright/test';

/**
 * The cinema directory at /cinemas/gsc and a single venue at /cinema/{slug}.
 * See docs/app-recon.md section 12.
 */

export interface CinemaEntryInfo {
  name: string;
  location: string;
  detailHref: string | null;
}

export class CinemasPage {
  constructor(private readonly page: Page) {}

  async goto(): Promise<void> {
    await this.page.goto('/cinemas/gsc', { waitUntil: 'domcontentloaded' });
    await expect(this.heading).toBeVisible();
  }

  get heading(): Locator {
    return this.page.getByRole('heading', { name: /Discover GSC Cinemas/i, level: 1 });
  }

  /**
   * One entry per venue. `.desc` is the block holding the venue name, its
   * location, and the link through to the venue page.
   */
  get entries(): Locator {
    return this.page.locator('.desc').filter({ has: this.page.locator('a[href^="/cinema/"]') });
  }

  entryByName(name: string): Locator {
    return this.entries.filter({ hasText: name });
  }

  async readEntry(entry: Locator): Promise<CinemaEntryInfo> {
    const name = ((await entry.locator('.font-m.fw-bold').first().textContent()) ?? '')
      .replace(/\s+/g, ' ')
      .trim();

    const location = ((await entry.locator('li').first().textContent()) ?? '')
      .replace(/\s+/g, ' ')
      .trim();

    return {
      name,
      location,
      detailHref: await entry.locator('a[href^="/cinema/"]').first().getAttribute('href'),
    };
  }

  async readEntries(limit: number): Promise<CinemaEntryInfo[]> {
    const total = await this.entries.count();
    const results: CinemaEntryInfo[] = [];

    for (let i = 0; i < Math.min(limit, total); i++) {
      results.push(await this.readEntry(this.entries.nth(i)));
    }
    return results;
  }

  /**
   * Directory entries use the same hover overlay as the movie cards, so the
   * "Cinema Info" link is not clickable until the entry is hovered.
   */
  async revealEntry(entry: Locator): Promise<void> {
    await entry.scrollIntoViewIfNeeded();

    const infoLink = entry.locator('a[href^="/cinema/"]').first();
    await expect(async () => {
      await entry.hover();
      await expect(infoLink).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
  }

  async openCinema(entry: Locator): Promise<void> {
    await this.revealEntry(entry);
    await entry.locator('a[href^="/cinema/"]').first().click();
  }

  /**
   * The "Filter By" form holding the Locations and Experiences dropdowns.
   *
   * Scoping matters more than it looks: the site header contains its own
   * "Search" control, and an unscoped getByRole('button', { name: 'Search' })
   * matches that instead — which opens a full-screen overlay that then blocks
   * every subsequent click. Always drive the filter through this form.
   */
  private get filterForm(): Locator {
    return this.page.locator('form').filter({ has: this.page.locator('select') }).first();
  }

  get locationFilter(): Locator {
    return this.filterForm.locator('select').first();
  }

  /**
   * Choosing an option does not filter on its own — the form is submit-driven.
   * Selecting and then clicking Search is the real user action.
   */
  async filterByLocation(location: string): Promise<void> {
    await this.locationFilter.selectOption({ label: location });
    await this.filterForm.getByRole('button', { name: /Search/i }).click();
  }

  async resetFilters(): Promise<void> {
    await this.filterForm.getByRole('button', { name: /Reset/i }).click();
  }

  /** Locations shown across the currently listed venues. */
  async listedLocations(): Promise<string[]> {
    return this.entries.evaluateAll((entries) =>
      entries.map((entry) => (entry.querySelector('li')?.textContent ?? '').replace(/\s+/g, ' ').trim()),
    );
  }
}

/** A single venue page at /cinema/{slug}. */
export class CinemaDetailPage {
  constructor(private readonly page: Page) {}

  get name(): Locator {
    return this.page.getByRole('heading', { level: 1 });
  }

  /**
   * Venue facts such as "Number of Halls" and "Seating Capacity". The label and
   * its value sit in sibling divs inside one list item.
   */
  fact(label: string): Locator {
    return this.page.locator('li').filter({ hasText: label }).first();
  }

  async nameText(): Promise<string> {
    return ((await this.name.textContent()) ?? '').replace(/\s+/g, ' ').trim();
  }
}
