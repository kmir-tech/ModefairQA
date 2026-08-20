import { Locator, Page, expect } from '@playwright/test';

/**
 * The GSC homepage and its primary navigation.
 *
 * The nav mixes links and dropdown buttons, and renders a desktop and a mobile
 * copy into the same DOM, so nav lookups are scoped to <header> to keep them
 * away from the identical links in the footer.
 *
 * SLOW CLIENT-SIDE NAVIGATION (measured 2026-08-20, Desktop Chrome):
 *
 *   page.goto('/movies') directly          ~1.1-1.4s
 *   clicking header "Movies" from home     ~9s to framenavigated, ~13-14s to settle
 *
 * The click itself returns in ~245ms and no navigation request is issued — this
 * is a client-side route transition that takes nine seconds or more. It is
 * consistent across runs (3/3), so the navigation helpers below wait generously
 * and click exactly ONCE.
 *
 * Clicking again while a transition is pending cancels it and the navigation
 * never completes, so a retry loop here is actively harmful — do not
 * reintroduce one. See docs/app-recon.md section 14.
 */
export class HomePage {
  /**
   * Headroom over the observed worst case — ~13s with a single client, 45-58s
   * with four concurrent ones. Deliberately generous so the suite reports the
   * product's real behaviour instead of flaking, NOT because the wait is
   * acceptable: 13s for a primary navigation is a defect, and it is reported as
   * one rather than quietly absorbed here.
   */
  private static readonly NAV_TIMEOUT = 120_000;

  constructor(private readonly page: Page) {}

  async goto(): Promise<void> {
    // "load" never settles reliably on this page — third-party ad and tracker
    // requests keep it pending well past the point the nav is usable.
    await this.page.goto('/', { waitUntil: 'domcontentloaded' });
  }

  /** The site header, so nav lookups cannot drift into the footer. */
  private get header(): Locator {
    return this.page.locator('header').first();
  }

  /** "Movies" is a real link straight to /movies. */
  get moviesNavLink(): Locator {
    return this.header.getByRole('link', { name: 'Movies', exact: true }).first();
  }

  /** "Cinemas" is a dropdown trigger, not a link — it opens a submenu. */
  get cinemasNavButton(): Locator {
    return this.header.getByRole('button', { name: 'Cinemas', exact: true }).first();
  }

  async openMovies(): Promise<void> {
    await this.moviesNavLink.click();
    await this.page.waitForURL(/\/movies\/?$/, { timeout: HomePage.NAV_TIMEOUT });
  }

  /** Open the Cinemas dropdown and choose a cinema brand. */
  async openCinemaBrand(name: 'GSC Cinemas' | 'Aurum Theatre' | 'Velvet Cinemas'): Promise<void> {
    await this.cinemasNavButton.click();

    // Scoped to the header: the footer carries the same brand links, and an
    // unscoped match would click one of those instead of the dropdown item.
    const brandLink = this.header.getByRole('link', { name, exact: true }).first();
    await expect(brandLink).toBeVisible();

    await brandLink.click();
    await this.page.waitForURL(/\/cinemas\/[a-z-]+\/?$/, { timeout: HomePage.NAV_TIMEOUT });
  }
}
