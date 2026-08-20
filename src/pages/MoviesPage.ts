import { Locator, Page, expect } from '@playwright/test';

/**
 * The GSC movie catalogue at /movies.
 *
 * Two behaviours of this page drive the design below, both verified against
 * the live site (docs/app-recon.md section 9):
 *
 *  1. All four tab panels exist in the DOM simultaneously and only one is
 *     visible. Every card query MUST be scoped to a panel, or it silently
 *     reaches into the hidden tabs.
 *  2. Card actions are revealed on hover. Clicking without hovering fails with
 *     an actionability timeout that reads like a broken locator.
 */

export type CatalogueTab = 'Now Showing' | 'Advance Sales' | 'Coming Soon' | 'Layar Malaysia';

const PANEL_IDS: Record<CatalogueTab, string> = {
  'Now Showing': '#now-showing',
  'Advance Sales': '#advance-sales',
  'Coming Soon': '#coming-soon',
  'Layar Malaysia': '#layar-malaysia',
};

/** Details a visitor can read off a single catalogue card. */
export interface MovieCardInfo {
  title: string;
  posterAlt: string | null;
  detailHref: string | null;
  /** Booking-engine URL behind "Buy Now"; null for films that are not yet bookable. */
  bookingHref: string | null;
}

export class MoviesPage {
  constructor(private readonly page: Page) {}

  async goto(): Promise<void> {
    await this.page.goto('/movies', { waitUntil: 'domcontentloaded' });
    await expect(this.heading).toBeVisible();
  }

  get heading(): Locator {
    return this.page.getByRole('heading', { name: 'Movies', level: 1 });
  }

  /**
   * Catalogue sections are authored as <h2 role="tab">. The explicit role wins,
   * so these are tabs in the accessibility tree, never headings.
   */
  tab(name: CatalogueTab): Locator {
    return this.page.getByRole('tab', { name, exact: true });
  }

  panel(name: CatalogueTab): Locator {
    return this.page.locator(PANEL_IDS[name]);
  }

  /**
   * Switch tabs and wait for the panel to actually be shown, so callers never
   * race the Bootstrap transition.
   */
  async selectTab(name: CatalogueTab): Promise<void> {
    await this.tab(name).click();
    await expect(this.tab(name)).toHaveAttribute('aria-selected', 'true');
    await expect(this.panel(name)).toBeVisible();
  }

  /** Every movie card within one tab panel. */
  cards(tab: CatalogueTab): Locator {
    return this.panel(tab).locator('.card-info');
  }

  /**
   * A single card, addressed by the film title a visitor sees on it.
   * Scoped to the panel so the same film appearing in two tabs is unambiguous.
   */
  cardByTitle(tab: CatalogueTab, title: string): Locator {
    return this.cards(tab).filter({ hasText: title });
  }

  /**
   * Reveal a card's actions. The overlay is hover-driven, so this is required
   * before clicking "View More" or "Buy Now".
   */
  async revealCard(card: Locator): Promise<void> {
    await card.scrollIntoViewIfNeeded();

    // Posters are loading="lazy". While they resolve, the grid reflows and a
    // card that was under the pointer slides away, so the CSS :hover state is
    // lost and the overlay never appears. Letting this card's poster settle
    // removes most of that movement.
    //
    // Best-effort by design: under parallel load the poster CDN can be slower
    // than the wait, and this is only an optimisation — the retrying hover
    // below is the actual synchronisation. Making it mandatory turned a
    // healthy page into three red tests.
    await expect(card.locator('img').first())
      .toHaveJSProperty('complete', true, { timeout: 8_000 })
      .catch(() => undefined);

    // Re-hover on each attempt rather than hovering once and hoping: any
    // remaining reflow from a neighbouring card is simply retried away. This
    // is a synchronisation strategy, not a sleep.
    //
    // The reveal is detected on the detail ANCHOR, not on its "View More"
    // text: that label is a visibility:hidden span behind an icon font and
    // never becomes visible, even once the overlay is fully shown. The same
    // quirk means the link has no accessible name, so getByRole('link', …)
    // cannot address it either — see the accessibility defect in
    // docs/app-recon.md section 13.
    const detailLink = card.locator('a[href^="/movie/"]').first();
    await expect(async () => {
      await card.hover();
      await expect(detailLink).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
  }

  /**
   * Read a card without clicking anything.
   *
   * Deliberately reads from the DOM rather than asserting, so tests can decide
   * what matters. Titles are whitespace-normalised because GSC's source data
   * carries trailing spaces.
   */
  async readCard(card: Locator): Promise<MovieCardInfo> {
    const title = ((await card.locator('.font-l.fw-bold').first().textContent()) ?? '')
      .replace(/\s+/g, ' ')
      .trim();

    const detailLink = card.locator('a[href^="/movie/"]').first();
    const bookingLink = card.locator('a[href*="showtime-by-movies"]').first();

    return {
      title,
      posterAlt: await card.locator('img').first().getAttribute('alt'),
      detailHref: (await detailLink.count()) ? await detailLink.getAttribute('href') : null,
      bookingHref: (await bookingLink.count()) ? await bookingLink.getAttribute('href') : null,
    };
  }

  /** Read the first N cards in a tab. N is capped to keep runs quick and polite. */
  async readCards(tab: CatalogueTab, limit: number): Promise<MovieCardInfo[]> {
    const cards = this.cards(tab);
    const total = await cards.count();
    const results: MovieCardInfo[] = [];

    for (let i = 0; i < Math.min(limit, total); i++) {
      results.push(await this.readCard(cards.nth(i)));
    }
    return results;
  }

  /** Booking-engine movie ids behind every "Buy Now" in a tab. */
  async bookableMovieIds(tab: CatalogueTab): Promise<string[]> {
    const hrefs = await this.panel(tab)
      .locator('a[href*="showtime-by-movies?id="]')
      .evaluateAll((links) =>
        links.map((link) => (link as HTMLAnchorElement).getAttribute('href') ?? ''),
      );

    return hrefs
      .map((href) => {
        try {
          return new URL(href).searchParams.get('id');
        } catch {
          return null;
        }
      })
      .filter((id): id is string => Boolean(id));
  }

  /** Open a card's detail page via "View More", handling the hover overlay. */
  async openDetail(card: Locator): Promise<void> {
    await this.revealCard(card);
    await card.locator('a[href^="/movie/"]').first().click();
  }

  /**
   * Click "Buy Now" and return the tab it opens.
   *
   * The link is target="_blank", so the booking engine arrives as a popup while
   * the opener stays on /movies.
   */
  async openBookingInNewTab(card: Locator): Promise<Page> {
    await this.revealCard(card);

    const [popup] = await Promise.all([
      this.page.context().waitForEvent('page'),
      card.locator('a[href*="showtime-by-movies"]').first().click(),
    ]);

    await popup.waitForLoadState('domcontentloaded');
    return popup;
  }
}
