import { Locator, Page } from '@playwright/test';

/**
 * A single film's page at /movie/{slug}.
 *
 * Unlike the catalogue, this page uses real headings (h1 title; h2 Director,
 * Cast, Synopsis) — see docs/app-recon.md section 11.
 *
 * The important trap: a related-films carousel lower down carries its own
 * "Buy Now" links pointing at OTHER movie ids. `bookingCta` is deliberately
 * pinned to the primary "Buy Tickets Now" call to action so assertions cannot
 * silently follow the wrong film.
 */
export class MovieDetailPage {
  constructor(private readonly page: Page) {}

  async goto(slug: string): Promise<void> {
    await this.page.goto(`/movie/${slug}`, { waitUntil: 'domcontentloaded' });
  }

  get title(): Locator {
    return this.page.getByRole('heading', { level: 1 });
  }

  /** The primary booking CTA — never the carousel's "Buy Now" links. */
  get bookingCta(): Locator {
    return this.page.getByRole('link', { name: 'Buy Tickets Now' }).first();
  }

  section(name: 'Director' | 'Cast' | 'Synopsis'): Locator {
    return this.page.getByRole('heading', { name, exact: true });
  }

  /** Metadata row such as "Running Time: 2 hr 25 mins". */
  metadata(label: string): Locator {
    return this.page.locator('li').filter({ hasText: new RegExp(`^\\s*${label}:`) }).first();
  }

  async titleText(): Promise<string> {
    return ((await this.title.textContent()) ?? '').replace(/\s+/g, ' ').trim();
  }

  /** Booking-engine movie id behind the primary CTA, or null if absent. */
  async bookingMovieId(): Promise<string | null> {
    const href = await this.bookingCta.getAttribute('href');
    if (!href) return null;
    try {
      return new URL(href).searchParams.get('id');
    } catch {
      return null;
    }
  }
}
