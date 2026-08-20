import { Locator, Page } from '@playwright/test';

/**
 * The food & beverage step at epaymentwebapp.gsc.com.my/e-combo — where the
 * booking journey continues after seats are confirmed.
 *
 * Verified 2026-08-20. It carries the full booking summary forward:
 *
 *   SPIDER-MAN: BRAND NEW DAY  13  ENG  2 h 25 m  2D
 *   Kuala Lumpur - Mid Valley Megamall
 *   Fri 21 Aug, 10:00AM at Hall 2
 *   G01   Adult x 1
 *   [F&B catalogue…]                                   RM 0.00
 *
 * This is where the suite STOPS. The next step is payment, and GSC has no
 * staging environment — nothing beyond this page is ever exercised.
 *
 * Like the seat map, this page has no heading elements, so its content is
 * addressed by text.
 */
export class ComboPage {
  constructor(private readonly page: Page) {}

  /** The whole page — the booking summary is plain text near the top. */
  get summary(): Locator {
    return this.page.locator('body');
  }

  /** Running F&B total in the bottom bar; "RM 0.00" when nothing is added. */
  get foodTotal(): Locator {
    return this.page.locator('.btm-btn');
  }
}
