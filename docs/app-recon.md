# GSC Application Recon

Verified against the live site on **2026-08-20** with headless Chromium.
Everything here was observed, not assumed. Re-verify before trusting it —
GSC ships to production continuously and this is a third-party target.

---

## 1. The journey crosses two applications

This is the single most important architectural fact about the suite.

| Concern | Host | Stack |
|---|---|---|
| Marketing / browse / movie detail | `www.gsc.com.my` | Server-rendered, Drupal-backed (`/dsites/s3fs-public/…`) |
| Showtimes / seats / checkout | `epaymentwebapp.gsc.com.my` | **Angular v20.3.25** SPA |
| Showtime + movie data | `epaymentapi.gsc.com.my` | ASP.NET `.asmx`, returns **XML** |

A single user journey therefore performs a **cross-origin handoff** partway
through. Page objects are split along that seam, and `baseURL` only applies to
the marketing site.

## 2. URL map

```
www.gsc.com.my/                              Homepage
www.gsc.com.my/movies                        Listing: Now Showing / Advance Sales / Coming Soon
www.gsc.com.my/movie/{slug}                  Movie detail, e.g. /movie/the-odyssey
                                             -> "Buy Tickets Now" hands off to:
epaymentwebapp.gsc.com.my/showtime-by-movies?id={id}
                                             -> canonicalises (client-side) to:
epaymentwebapp.gsc.com.my/showtime-by-movies/{id}/{slug}?id={id}
epaymentwebapp.gsc.com.my/cinemas/showtime-by-cinemas?location={n}&hallGroup={code}
epaymentwebapp.gsc.com.my/login              Auth gate
```

The marketing slug and the booking-engine id are **different identifiers**
(`/movie/the-odyssey` ↔ `id=5116`). The mapping lives only in the `href` on the
marketing page, so tests must follow the link rather than construct the URL.

## 3. No test IDs exist. Anywhere.

`[data-testid]`, `[data-test]`, `[data-cy]` → **0 matches** on the homepage, the
movies listing, and the booking engine.

We do not control this application and cannot add hooks to it. Every locator
must therefore be built from **role, accessible name, heading text, and
structural scoping**. This is a permanent constraint, not a temporary one, and
it is the main source of maintenance risk in the suite.

## 4. The showtime page structure

`/showtime-by-movies?id=5116` renders three stacked sections:

| Section | Heading | Controls |
|---|---|---|
| Date picker | `Select Date` | Buttons: `THU20Aug`, `FRI21Aug`, … (7 days) |
| Experience filter | `Select Experiences` | e.g. IMAX, 2D, GETHA, STUDIO |
| Showtime grid | `Select Cinemas & Time` | `h3` = cinema name, buttons = `10:00AM*IMAX` |

Cinema names are `h3` elements (`Kuala Lumpur - Mid Valley Megamall`, …), and
showtime buttons are siblings beneath them. Scoping a showtime to its cinema
means scoping to the region around its `h3` — there is no wrapping landmark
with an accessible name.

Showtime button labels are the concatenation of time and format, rendered as
`10:00AM*IMAX` in `textContent` (the `*` is a styling artefact of a nested
element, not a literal separator in the visual output).

## 5. There is a public, unauthenticated XML API — use it as the oracle

```
GET https://epaymentapi.gsc.com.my/showtimews/service.asmx/getEpaymentMovie_ParentChild?includeChild=true&parent=
GET https://epaymentapi.gsc.com.my/showtimews/service.asmx/getShowTimesByMovie_ParentChild_V2?parentid={id}&oprndate=YYYY-MM-DD
```

Both return `200 application/xml`, no auth, no API key.

`getShowTimesByMovie_ParentChild_V2` shape:

```xml
<locations parent_code="5116" parent_title="The Odyssey">
  <location id="236" name="Kuala Lumpur - Aurum, The Exchange TRX" hallgroup="AURUMTRX" …>
    <child code="1000005031" title="(IMAX) The Odyssey" duration="173" lang="ENG" rating="16" …>
      <show id="286326" date="2026-08-20" time="1000" timestr="10:00AM"
            hname="IMAX" hallfull="0" type="IMAX" display_date="Thu 20 Aug" freelist="N" />
```

**Why this matters more than anything else in this document.** A cinema
showtime grid is dynamic data — the set of movies, cinemas, and times changes
every single day. A UI test that only asserts "some showtime buttons appeared"
is nearly worthless: it passes when the grid renders the wrong film's times,
the wrong day's times, or a stale cache.

With this API we can assert the far stronger property: **the times rendered in
the UI for a given movie and date are exactly the times the backend reports for
that movie and date.** That assertion fails when the feature is genuinely
broken, which is the whole point.

Note `oprndate` is a Malaysian *operating* date, hence the pinned
`Asia/Kuala_Lumpur` timezone in `playwright.config.ts`.

## 6. Clicking a showtime redirects anonymous users to /login

Verified: from `/showtime-by-movies?id=5116`, clicking the first showtime
button (`10:00AM*IMAX`) lands on:

```
https://epaymentwebapp.gsc.com.my/login   →   h1 "Log In"
Fields: Mobile Number (+60 prefix), Password
Links:  Forgot Password?, Sign Up now
```

Consequences for step 3 of the flow ("Continue booking"):

- Seat selection is **behind authentication**. It cannot be reached anonymously.
- Without credentials, the honest and still-valuable assertion is the auth gate
  itself: an anonymous user attempting to book is refused and routed to login.
  That is a real permission test, not a consolation prize.
- With credentials, the suite can go one hop further to the seat map.

**Observation worth flagging to GSC:** the redirect to `/login` carries **no
return URL or query parameter**. The selected showtime appears to be dropped,
so a user who logs in at this point cannot be returned to the show they picked.
Confirm against a real session before reporting this as a defect — the app may
persist the selection in local storage rather than in the URL.

## 7. Hard boundaries on a production target

There is no staging environment. Every test runs against the real booking
system that real customers use.

- **Never complete a payment.** Stop at the seat map / order summary.
- **Never hold seats longer than necessary**; release or abandon promptly.
- **Never use real customer accounts or real payment instruments.**
- Keep worker counts low. The suite should look like a few users, not traffic.

## 8. Tag name is not role — the marketing site overrides implicit roles

Discovered by a failing smoke test on 2026-08-20, and worth internalising
before writing step 1.

On `/movies`, the section titles are authored as headings but carry an
explicit ARIA role that **overrides** the implicit one:

```html
<h2 id="now-showing-tab" role="tab" aria-controls="now-showing"
    aria-selected="true" class="nav-link active">Now Showing</h2>
<h2 id="advance-sales-tab" role="tab" aria-selected="false" …>Advance Sales</h2>
<h2 id="coming-soon-tab"   role="tab" aria-selected="false" …>Coming Soon</h2>
<h2 id="layar-malaysia-tab" role="tab" aria-selected="false" …>Layar Malaysia</h2>
```

So `getByRole('heading', { name: 'Now Showing' })` matches **nothing**, while
`getByRole('tab', { name: 'Now Showing' })` matches. Only `Movies` (h1),
`Getha Lux Suite`, `International Screens`, and the FAQ titles are real
headings in the accessibility tree.

**The lesson:** recon that dumps `document.querySelectorAll('h2')` reports tag
names, which are *not* what `getByRole` matches. Verify locators against the
accessibility tree, not the tag soup.

### Catalogue tab structure

Bootstrap tabs. Each tab controls a panel by id:

| Tab | Panel id | Default |
|---|---|---|
| Now Showing | `#now-showing` | `aria-selected="true"` |
| Advance Sales | `#advance-sales` | |
| Coming Soon | `#coming-soon` | |
| Layar Malaysia | `#layar-malaysia` | |

**All four panels exist in the DOM simultaneously**; the inactive ones are
hidden by CSS. Counting `a[href*="/movie/"]` page-wide therefore counts Coming
Soon links too, and would pass even if the Now Showing panel were empty. Scope
movie-link assertions to the panel under test.

### Minor accessibility observation (not a blocker)

Using `<h2 role="tab">` removes these section titles from the document
outline, so assistive-technology users lose the catalogue heading structure.
The elements also carry `type="button"`, which is not valid on `<h2>`. Worth
raising with GSC as a low-severity accessibility finding; it does not affect
sighted users and does not block automation.

---

# Step 1 — Browse and select (verified 2026-08-20)

## 9. Movie catalogue: `/movies`

Vue app. Elements carry scoped-CSS attributes like `data-v-96a8a8dc` — these are
build hashes and **must never be used as selectors**.

### Tab panels

All four panels exist in the DOM at once, but exactly one is visible. Clicking a
tab toggles visibility; the **URL does not change**, so tab state is not
deep-linkable and cannot be set up by navigation.

| Tab | Panel | `/movie/` links | `Buy Now` links |
|---|---|---|---|
| Now Showing | `#now-showing` | 33 | 33 |
| Advance Sales | `#advance-sales` | 8 | 8 |
| Coming Soon | `#coming-soon` | 126 | **0** |
| Layar Malaysia | `#layar-malaysia` | 0 | 0 |

Counts are live data and will drift — assert relationships, never these numbers.

Two behaviours worth encoding as tests:

- **Coming Soon has no booking links by design.** Films are not yet bookable.
- **Layar Malaysia renders a real empty state**, not a broken grid:
  `<div class="container text-center">Stay tuned for upcoming movies and events.</div>`

### Movie card — actions are hidden until hover

```html
<div class="card-info ratio ratio-3x2">
  <div class="image">
    <img alt="Spider-Man: Brand New Day  movie poster — GSC Cinemas Malaysia">
  </div>
  <div class="card-info-inner">          <!-- overlay: hidden until hover -->
    <a href="/movie/{slug}">View More</a>
    <div class="font-l fw-bold">{Title}</div>
    <ul class="nav navbar-nav">          <!-- genre / duration / language / subtitles -->
    <a class="btn btn-primary" target="_blank"
       href="https://epaymentwebapp.gsc.com.my/showtime-by-movies?id={id}">Buy Now</a>
```

**Verified:** on a freshly loaded page, `View More`, `Buy Now`, and even the
title report `isVisible() === false`. They become visible only after
`card.hover()`. A test that clicks without hovering fails with an actionability
timeout that looks like a broken locator.

The poster `img` carries a genuine accessible name —
`"{Title} movie poster — GSC Cinemas Malaysia"` — which is the most
semantic handle on a card. Note the source title often has a **trailing space**
(`"Spider-Man: Brand New Day "`), so the alt text contains a double space.
Always normalise whitespace when matching titles.

`.card-info` is a hand-authored class, not a build hash, so it is acceptable for
scoping in the absence of any test IDs. It is still the weakest link in the
suite — if cards break, check here first.

### `Buy Now` opens a new tab

`target="_blank"`. Clicking spawns a popup that must be captured with
`context.waitForEvent('page')`; the opener stays on `/movies`. The popup lands
on the booking engine and renders the matching film
(`h1` = `SPIDER-MAN: BRAND NEW DAY`).

Minor defect worth reporting: the booking engine canonicalises the URL to
`/showtime-by-movies/5099/spider-man%253Abrand-new-day?id=5099`. `%253A` is a
**double-encoded** colon (`%3A` encoded again). Cosmetic — routing still works
because the id query parameter carries the real lookup.

## 10. Cross-layer invariant worth testing

Every `Buy Now` id on the marketing site resolves to a `<parent code>` in
`getEpaymentMovie_ParentChild`. Verified 2026-08-20: 33/33 Now Showing and
8/8 Advance Sales ids present; 0 missing.

This catches a real defect class — the marketing site advertising a film the
booking engine does not know — and is stable because it asserts a *relationship*
rather than any specific film.

Do **not** strengthen this to "the movie has showtimes today": a bookable film
legitimately may have no screenings on a given date, which would make the test
fail for correct behaviour.

## 11. Movie detail: `/movie/{slug}`

Real headings here (unlike the catalogue tabs):

- `h1` — film title
- `h2` — `Director`, `Cast`, `Synopsis`
- Metadata list — `Release Date`, `Spoken Language`, `Running Time`, `Subtitles`,
  `Genre`, `Classification`
- Rating badge `img` with `alt` = classification (e.g. `alt="13"`)
- Primary CTA: `Buy Tickets Now` → `…/showtime-by-movies?id={id}`, `target="_blank"`

**Trap:** the page also carries a related-films carousel whose cards each have
their own `Buy Now` link to *different* movie ids. Any assertion about the
booking CTA must be scoped to the primary CTA, or it will silently follow
another film.

## 12. Cinema directory: `/cinemas/gsc` and `/cinema/{slug}`

Directory: `h1` "Discover GSC Cinemas Near You", 54 `a[href^="/cinema/"]` entries,
plus `Search` and `Reset` controls.

Each entry:

```html
<div class="desc">
  <a href="/cinema/{slug}">Cinema Info</a>
  <div class="font-m fw-bold mb-2">Aurum Theatre, The Exchange TRX</div>
  <ul class="nav navbar-nav">
    <li>Kuala Lumpur</li>                  <!-- location -->
    <li>IMAX, ScreenX, Getha Lux Suites…</li>  <!-- experiences -->
```

Cinema detail (`/cinema/gsc-1-utama`): `h1` = `GSC 1 Utama`, plus
`Number of Halls` (15) and `Seating Capacity` (2103), a Cinema Experiences list,
and a `Buy Tickets Now` section.

**Trap:** the `Buy Tickets Now` section links to
`…/cinemas/showtime-by-cinemas?location={n}&hallGroup={code}` for **many
cinemas, not only the one being viewed** — it is a directory-wide list. Do not
assume the first such link belongs to the current cinema.

## 13. ACCESSIBILITY DEFECT — catalogue card links have no accessible name

Found by automation on 2026-08-20 while building step 1.

Each movie card's detail link is an icon-font anchor whose only label is a span
that CSS keeps permanently hidden:

```html
<a href="/movie/spiderman-brand-new-day" class="twi twi-info twi-l fw-bold mb-3">
  <span>View More</span>   <!-- computed: visibility: hidden, even on hover -->
</a>
```

`visibility: hidden` content is excluded from accessible-name computation, so
the link has **no accessible name at all**. Playwright's aria snapshot of a
fully revealed card:

```yaml
- img "Spider-Man: Brand New Day movie poster — GSC Cinemas Malaysia"
- link:                                    # <- no name
  - /url: /movie/spiderman-brand-new-day
- text: "Spider-Man: Brand New Day"
- link "Buy Now":
  - /url: https://epaymentwebapp.gsc.com.my/showtime-by-movies?id=5099
```

Confirmed: `getByRole('link', { name: 'View More' })` matches **0** elements,
while `getByRole('link', { name: 'Buy Now' })` matches 1.

Impact: a screen-reader user hears an unlabelled link on every film in the
catalogue (33 on Now Showing alone). Likely WCAG 2.1 failures under 2.4.4 Link
Purpose and 4.1.2 Name, Role, Value. The same icon-link pattern is used for
"Cinema Info" in the cinema directory, so it probably applies there too.

Suggested fix: give the anchor an `aria-label`, or make the span
screen-reader-only (clip rect) instead of `visibility: hidden`.

Testing consequence: the detail link cannot be addressed by role and name, so
`a[href^="/movie/"]` is used. That is a deliberate concession to a product
defect, not a lazy locator — revisit it if GSC fixes the labelling.

## 14. PERFORMANCE DEFECT — homepage nav takes ~13s to change route

Measured 2026-08-20, headless Chromium, `devices['Desktop Chrome']`:

| Action | Time |
|---|---|
| `page.goto('/movies')` directly | **1.1 - 1.4 s** |
| Click header "Movies" from the homepage | click returns in 245 ms, `framenavigated` at **9.3 s**, URL settles at **13.2 s** |

Reproducible 3/3 at a single client. No navigation request is issued, so this
is a client-side route transition, not server latency — loading the very same
page directly is roughly ten times faster.

Under concurrency it degrades sharply:

| Concurrent clients | Click-to-navigation |
|---|---|
| 1 | 12.9 s |
| 4 | 50.4 s, 45.7 s, 58.5 s, 47.8 s |

**Attribution caveat, stated honestly:** the concurrency figures come from four
headless Chromium instances on one machine, so local CPU contention cannot be
separated from any server-side effect. Do **not** report the 45-58 s numbers as
a server problem. The single-client 13 s figure is the solid finding, and it
stands on its own against 1.2 s for a direct load.

Two consequences for the suite:

1. **Never retry a nav click.** Clicking again while a transition is pending
   cancels it, and the navigation then never completes — this turned a slow
   test into a permanently failing one during development.
2. Homepage-entry tests are marked `test.slow()` with a 90 s navigation
   timeout. That is tolerance for a known product defect, not padding.

## 15. Hover overlays hide more than they appear to

Both the movie cards and the cinema directory entries use a hover overlay, and
`title`, `View More`, and `Buy Now` all report `isVisible() === false` until the
container is hovered.

Two traps, both hit during development:

- **Do not wait on the "View More" text** as the reveal signal. It is
  `visibility: hidden` permanently (see section 13) and never becomes visible,
  even when the overlay is fully shown. Wait on the anchor instead.
- **Posters are `loading="lazy"`.** Until they resolve the grid reflows and a
  hovered card slides out from under the pointer, losing the CSS `:hover` state.
  Wait for the card's own image to complete, then hover, and re-hover on retry.

`textContent` still reads fine on hidden elements, so scraping card details does
not require hovering — only clicking does.

---

# Step 2 — Select a showtime (verified 2026-08-20)

## 16. Showtime picker structure

`/showtime-by-movies?id={movieId}` — Angular 20 + Angular Material.

```html
<!-- Select Date -->
<button id="2026-08-20" class="date-option-container … active">THU 20 Aug</button>

<!-- Select Cinemas & Time: one accordion per venue -->
<mat-expansion-panel>
  <mat-expansion-panel-header role="button">   <!-- careful: role=button -->
    <h3>Kuala Lumpur - Aurum, The Exchange TRX</h3>
  <div role="region" class="mat-expansion-panel-content">
    <div role="button" class="showtime-option-container">
      <p class="showtime"> 3:35PM<span class="hidden">*</span></p>
      <p class="show-type">IMAX</p>
```

Three traps:

- **Date chips carry the operating date as their DOM id** (`id="2026-08-20"`) —
  the most stable handle on the page. A CSS id selector cannot start with a
  digit, so use `[id="2026-08-20"]`.
- **Showtimes are `<div role="button">`, not `<button>`.**
  `locator('button')` finds zero of them.
- **The accordion header is itself `role="button"`**, so showtime lookups must
  be scoped to the panel's `[role=region]` body or the header leaks in.

The `*` in showtime text comes from `<span class="hidden">*</span>` and must be
stripped before comparing against the API.

Not every venue screens every film — several panels are legitimately empty, so
picking a cinema by index is a reliable way to fail against a correct app.

### UI and API agree exactly

Verified for two dates on the same film and cinema:

| Date | API | UI | Equal (as sets) |
|---|---|---|---|
| 2026-08-20 (today) | 3:35PM, 9:10PM, 12:35AM, 4:30PM | same four | yes |
| 2026-08-21 (tomorrow) | 10:00AM + the above | same five | yes |

Past screenings are filtered **server-side** — today's 10:00AM is absent from
both API and UI — so the two stay consistent through the day. Set equality is
therefore a valid assertion.

Still prefer **tomorrow** for grid comparisons: today's grid shrinks as
screenings start, so a same-day run races a moving target between the UI read
and the API read.

**Selecting a date refetches the grid** (`getShowTimesByMovie_ParentChild_V2`
with the new `oprndate`). Synchronise on that response — otherwise panels are
still re-rendering when the caller reads them, and showtime tiles detach
mid-click with "Element is not attached to the DOM".

## 17. Login

`/login`. Verified working end to end with a real member account.

```html
<p for="phoneNo" class="form-label">Mobile Number</p>   <!-- NOT a <label> -->
<mat-select formcontrolname="dialCode">+60</mat-select>
<input id="phoneNo"  formcontrolname="mobileNumber" inputmode="numeric">
<input id="password" type="password">
<button>Login</button>
```

**The mobile number must omit its national leading zero.** The dial-code
control already supplies `+60`, so entering `01123456789` double-prefixes and
the sign-in fails. Enter `1123456789`.

**A "Start Your Reward Journey" dialog opens OVER the login form** before the
app routes away, and the URL stays on `/login` until it is dismissed via
**"I Got It"**. Waiting for the login form to disappear is not enough — the
dialog hides it while the login is, in URL terms, still incomplete. The dialog
container is a `<mat-dialog-container>` that does **not** carry
`role="dialog"`, so waiting on `[role=dialog]` silently never matches. Key off
the "I Got It" button instead, and treat the dialog as optional (it does not
appear on every sign-in).

After dismissal the app lands on `/profile`.

### ACCESSIBILITY DEFECT — login fields have no accessible name

The field labels are `<p>` elements carrying a `for` attribute. `for` on a `<p>`
associates nothing, so both inputs are nameless in the accessibility tree —
Playwright's aria snapshot shows two bare `textbox` nodes, and
`getByLabel('Mobile Number')` cannot work. Screen-reader users get two
unlabelled fields on the sign-in form. Fix: use real `<label for>` elements, or
add `aria-label`. Same family of defect as section 13.

## 18. Seat selection — the end of the journey

Signed in, clicking a showtime goes straight to `/seat-selection` (no auth
bounce). The page renders:

```
THE ODYSSEY  16  ENG  2 h 53 m  IMAX
Kuala Lumpur - Aurum, The Exchange TRX
Thu 20 Aug, 3:35PM at IMAX
[seat grid]
Seat Selection - RM 0.00        Confirm - 0 ticket(s)
```

There are **no heading elements at all** on this page, not even an `h1`, so
everything is addressed by text or container class.

**Seat markup differs by hall type** — this broke the first version of the test:

| Hall | Seat element |
|---|---|
| Standard | `<div class="not-blank … seat-style">H01</div>` |
| Premium (Getha Lux Suite, recliners) | `<img alt="twin sofa" class="two-seater-img">` |

A locator covering only `.seat-style` passes on ordinary halls and finds zero
seats on premium ones. Hall-agnostic handles:

- `.seat-selection` — the map container
- `.seating-arrangement` — seat rows (present in every hall type)
- `.seat-style.not-blank, .two-seater-img` — the seats themselves

Time is rendered as `3:35PM` in the summary strip and `3:35 PM` in the
Available Showtimes strip, so match with optional whitespace.

**The suite stops here.** No seat is ever selected, no inventory is held, and
payment is never reached.

---

# Step 3 — Continue booking (verified 2026-08-20)

## 19. The API has TWO cinema names and they usually disagree

Each `<location>` in the showtimes API carries both:

```xml
<location name="GSC Mid Valley" epayment_name="Kuala Lumpur - Mid Valley Megamall" …>
```

**49 of 55 locations differ.** The booking UI renders `epayment_name`; `name`
is an internal label.

This mattered more than it looks. The step-2 showtime-grid comparison filtered
API results by `name`, which meant it only lined up for the six venues where
the two happen to coincide — and it looked green purely because the first
cinema in the list (Aurum, The Exchange TRX) is one of them. Any reordering, or
any film not screening at Aurum, would have turned a correct application red.

Always read `epayment_name`, falling back to `name`. Verified after the fix:
10/10 sampled cinemas match the UI exactly, including six with differing names.

## 20. Selecting a seat

Standard hall, `/seat-selection`:

| State | Seat class |
|---|---|
| Free | `not-blank bg-[#FFFFFF] seat-style` |
| Selected | `bg-gsc-main-yellow not-blank seat-style` |

Availability is encoded **only in the Tailwind background colour**. There is no
`disabled`, no `aria-pressed`, no data attribute — so "is this seat free?" is an
inference, and the test verifies the seat actually turned yellow rather than
trusting it.

### Locator trap that cost real debugging time

`availableSeats.first()` — where `availableSeats` is filtered on the white
background class — is **not a stable handle**. Playwright re-resolves locators
on every action, so the instant the seat is selected it turns yellow, stops
matching, and the locator silently points at the *next* free seat. The
follow-up assertion then reads that seat as "still not selected" and loops
forever.

Pin the seat by its **index into `.seat-style.not-blank`**, which selection does
not change. Matching on the seat label via `filter({ hasText })` did not work
reliably either.

Clicking a selected seat **deselects** it, so any retry loop must check the
current state before clicking again.

### The order bar

```html
<div class="btm-btn">
  <div class="btn-title">Seat Selection</div>
  <div>Adult x 1</div>
  <div>G01</div>
  <span class="font-montBold">RM 15.00</span>
  <div class="btn-style"><span>Confirm</span> - 1 ticket(s)</div>
```

Selecting one seat yields `Adult x 1`, the seat label, and a real price
(RM 15.00 at Mid Valley). Ticket type defaults to Adult — there is no separate
ticket-type step to complete first.

### ACCESSIBILITY DEFECT — Confirm is not a control

The Confirm affordance is a plain `<div class="btn-style">` with no `role`, no
`tabindex`, and no accessible name. It is not keyboard reachable and is not
announced as a button; `getByRole('button', …)` matches **nothing** on this
page. Third instance of the same pattern, after sections 13 and 17.

## 21. Checkout continues at `/e-combo`

Confirming seats advances to the F&B upsell, which carries the booking forward:

```
SPIDER-MAN: BRAND NEW DAY  13  ENG  2 h 25 m  2D
Kuala Lumpur - Mid Valley Megamall
Fri 21 Aug, 10:00AM at Hall 2
G01    Adult x 1
[F&B catalogue…]                                RM 0.00
```

**This is where the suite stops.** The next step is payment.

Guard carefully if asserting "we did not reach payment": the booking host is
`epaymentwebapp.gsc.com.my`, which contains the substring "payment", so a naive
`not.toHaveURL(/payment/)` fails on every run. Match against
`new URL(page.url()).pathname` instead.

## 22. Production impact of this test

Confirming a seat **holds real inventory** on the live system until the hold
expires. The test is scoped to limit that:

- exactly one seat, never a block
- a standard 2D hall at an ordinary venue
- tomorrow's earliest screening — the lowest-demand slot on offer
- stops at `/e-combo`; payment is never reached

Holds are left to expire naturally; no cancel affordance was found on the seat
map. Do not widen this test without a deliberate decision about that impact.
