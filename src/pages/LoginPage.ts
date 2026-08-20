import { Locator, Page, expect } from '@playwright/test';

/**
 * The booking engine's login page: epaymentwebapp.gsc.com.my/login
 *
 * Verified 2026-08-20. The form is:
 *
 *   <p for="phoneNo" class="form-label">Mobile Number</p>
 *   <mat-select formcontrolname="dialCode">  +60  </mat-select>
 *   <input id="phoneNo"  formcontrolname="mobileNumber" inputmode="numeric">
 *   <input id="password" formcontrolname="password" type="password">
 *   <button>Login</button>
 *
 * ACCESSIBILITY DEFECT driving the locators here: the field labels are <p>
 * elements carrying a `for` attribute, not <label> elements. A `for` on a <p>
 * associates nothing, so BOTH inputs have no accessible name — Playwright's
 * aria snapshot shows two bare `textbox` nodes. `getByLabel('Mobile Number')`
 * therefore cannot work, and id selectors are used instead. This is a
 * concession to a product bug, not a shortcut; see docs/app-recon.md § 17.
 */
export class LoginPage {
  constructor(private readonly page: Page) {}

  private get bookingBaseUrl(): string {
    return process.env.BOOKING_URL ?? 'https://epaymentwebapp.gsc.com.my';
  }

  async goto(): Promise<void> {
    await this.page.goto(`${this.bookingBaseUrl}/login`, { waitUntil: 'domcontentloaded' });
    await expect(this.heading).toBeVisible();
  }

  get heading(): Locator {
    return this.page.getByRole('heading', { name: 'Log In' });
  }

  get mobileInput(): Locator {
    return this.page.locator('#phoneNo');
  }

  get passwordInput(): Locator {
    return this.page.locator('#password');
  }

  get submitButton(): Locator {
    return this.page.getByRole('button', { name: 'Login' });
  }

  /** True when the login form is on screen — the auth gate has been reached. */
  async isDisplayed(): Promise<boolean> {
    return this.heading.isVisible().catch(() => false);
  }

  /**
   * Sign in and settle on the post-login page.
   *
   * Two behaviours make this less trivial than it looks, both verified:
   *
   *  1. The number must be entered WITHOUT its national leading zero — the
   *     adjacent dial-code control already supplies +60, so "01123456789"
   *     double-prefixes and the login silently fails.
   *  2. A "Start Your Reward Journey" dialog opens OVER the login form before
   *     the app routes away, and the URL stays on /login until it is
   *     dismissed. Waiting on the form disappearing is not enough — the dialog
   *     hides it while the login is still, in URL terms, incomplete.
   *
   * Credentials are never logged: failures report only that the form is still
   * showing, never what was typed.
   */
  async login(mobile: string, password: string): Promise<void> {
    await expect(this.heading).toBeVisible();

    await this.mobileInput.fill(normaliseMobileNumber(mobile));
    await this.passwordInput.fill(password);
    await this.submitButton.click();

    await this.dismissWelcomeDialog();

    await this.page.waitForURL((url) => !/\/login/.test(url.toString()), { timeout: 60_000 });

    await expect(
      this.page.locator('#phoneNo'),
      'still on the login form after submitting — check GSC_MOBILE / GSC_PASSWORD in .env ' +
        '(the mobile number must omit its leading zero)',
    ).toBeHidden();
  }

  /**
   * Dismiss the post-login welcome dialog if it appears.
   *
   * Conditional on purpose: it is a first-login/rewards promo and does not show
   * on every sign-in, so requiring it would make the test fail for a correct
   * application.
   */
  private async dismissWelcomeDialog(): Promise<void> {
    // Keyed off the acknowledge button rather than a dialog container: the
    // container is a <mat-dialog-container> that does NOT carry role="dialog",
    // so waiting on [role=dialog] silently never matches and the login appears
    // to hang.
    const acknowledge = this.page.getByRole('button', { name: /I Got It/i }).first();

    // Race the dialog against a straight redirect — whichever happens first.
    await Promise.race([
      acknowledge.waitFor({ state: 'visible', timeout: 45_000 }).catch(() => undefined),
      this.page
        .waitForURL((url) => !/\/login/.test(url.toString()), { timeout: 45_000 })
        .catch(() => undefined),
    ]);

    if (await acknowledge.isVisible().catch(() => false)) {
      await acknowledge.click();
      await acknowledge.waitFor({ state: 'hidden', timeout: 30_000 }).catch(() => undefined);
    }
  }
}

/**
 * GSC pairs a "+60" dial-code control with the number field, so the national
 * leading zero must be dropped: 011-2345 6789 is entered as "1123456789".
 * Accepts either form in .env so a natural-looking value still works.
 */
export function normaliseMobileNumber(mobile: string): string {
  return mobile.trim().replace(/\s|-/g, '').replace(/^\+?60/, '').replace(/^0+/, '');
}

/** Credentials from .env, or null when the suite is running unauthenticated. */
export function gscCredentials(): { mobile: string; password: string } | null {
  const mobile = process.env.GSC_MOBILE?.trim();
  const password = process.env.GSC_PASSWORD?.trim();

  if (!mobile || !password) return null;
  return { mobile, password };
}
