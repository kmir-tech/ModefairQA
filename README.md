# GSC Malaysia — Playwright E2E Quality Suite

Automated end-to-end tests for **Golden Screen Cinemas Malaysia**
(<https://www.gsc.com.my>), written in **TypeScript** on **Playwright Test**.

The suite covers the ticket-booking journey:

| # | Step | Where it happens |
|---|---|---|
| 1 | **Browse and select a movie** | `www.gsc.com.my` → `/movies` → `/movie/{slug}` |
| 2 | **Select a showtime** | `epaymentwebapp.gsc.com.my/showtime-by-movies` |
| 3 | **Continue booking** | booking engine → auth gate → seat selection |
| 4 | **Basic navigation validation** | header, footer, and cross-app links |

> **Read `docs/app-recon.md` before writing a test.** It records what was
> actually verified about the target — including two facts that shape every
> design decision: the journey spans two separate applications, and the
> application exposes **no `data-testid` hooks at all**.

---

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Node.js | >= 20 (verified on 22.20.0) | `node --version` |
| npm | >= 10 (verified on 10.9.3) | ships with Node |
| OS | Windows / macOS / Linux | developed on Windows 11 |
| Network | Public internet | tests hit the live GSC production site |

There is **no local application to start**. The system under test is a
third-party production website, so there is no `webServer` block and nothing to
build or seed.

---

## Installation

```bash
# 1. Install dependencies
npm install

# postinstall fetches the Chromium browser automatically.
# For the cross-browser projects (firefox, webkit), also install the rest:
npm run install:browsers

# 2. Create your local environment file
cp .env.example .env
```

On Windows PowerShell, use `copy .env.example .env` for that last step.

`.env` is git-ignored. The defaults in `.env.example` are sufficient to run
everything except the authenticated portion of step 3 — see
[Credentials](#credentials-optional).

Verify the setup compiles before running anything:

```bash
npm run typecheck
```

---

## Execution

### Everyday commands

```bash
npm test                  # full suite, all configured projects
npm run test:chromium     # primary engine only - the usual local loop
npm run test:smoke        # @smoke-tagged critical path only (fastest signal)
npm run report            # open the HTML report from the last run
```

### By layer

```bash
npm run test:e2e          # browser journeys      (tests/e2e)
npm run test:api          # showtime XML API      (tests/api)
```

The API tests are fast and stable and prove backend contract behaviour without
a browser. Run them first when triaging a failure — if they are red, the UI
tests were never going to pass.

### Debugging and authoring

```bash
npm run test:ui                       # Playwright UI mode - best debugging tool here
npm run test:headed                   # watch it drive a real browser
npm run test:debug                    # step through with the inspector
npm run codegen                       # record locators against the live site

npx playwright test tests/e2e/01-browse-and-select.spec.ts   # one file
npx playwright test -g "showtime"                            # by title
npx playwright test --trace on                               # force trace capture
npm run trace test-results/<path>/trace.zip                  # open a trace
```

### Flake hunting

```bash
npm run test:flake        # --repeat-each=3 --workers=1
```

A test that passes alone but fails under `npm test` is a race or a shared-state
problem, not something to paper over with a longer timeout.

### Browser and device coverage

Coverage is deliberately **asymmetric**, because running every test on every
engine multiplies CI time and flakiness without adding much signal:

| Project | Scope | Rationale |
|---|---|---|
| `chromium` | Everything | Primary engine, full suite |
| `firefox`, `webkit` | `@cross-browser` tagged only | Rendering/layout-sensitive paths |

```bash
npm run test:cross-browser
```

---

## Credentials (optional)

Clicking a showtime **redirects anonymous users to `/login`** (verified — see
`docs/app-recon.md` section 6). Seat selection is behind authentication.

The suite is designed to be useful either way:

- **Without credentials** (default) — the authenticated booking-journey test
  **skips, it does not fail**, and prints the reason. Everything else still
  runs, including the full showtime-grid verification.
- **With credentials** — set `GSC_MOBILE` and `GSC_PASSWORD` in `.env` and the
  journey runs end to end: sign in, select a date and showtime, and land on the
  seat map for that exact screening.

```bash
GSC_MOBILE=1123456789          # WITHOUT the national leading zero
GSC_PASSWORD=your-test-account-password
```

> **Mobile number format matters.** The login form pairs a `+60` dial-code
> control with the number field, so the national leading zero must be dropped:
> `011-2345 6789` is entered as `1123456789`. Supplying `01123456789`
> double-prefixes and the sign-in fails with no error message. The suite
> normalises this for you, but the `.env` value is clearer without it.

> ### Rules of engagement — please read
>
> GSC has **no staging environment**. These tests run against the live booking
> system used by real customers.
>
> - **Never complete a payment.** The suite stops at the F&B step (`/e-combo`),
>   one page short of payment.
> - **Step 3 holds real inventory.** Confirming a seat reserves it on the live
>   system until the hold expires. The test takes exactly one seat, on
>   tomorrow's earliest (lowest-demand) screening in a standard hall. Do not
>   widen it without thinking about that impact.
> - Use a **dedicated test account**, never a real customer's.
> - Never commit `.env` or paste credentials into a test file, a CI log, or an issue.
> - Keep worker counts low. The suite should look like a few users, not a load test.

---

## Project structure

```
.
├── playwright.config.ts     Projects, timezone pinning, retries, reporters
├── tsconfig.json            Strict TS + @pages/@api path aliases
├── .env.example             Environment template (copy to .env)
│
├── docs/
│   └── app-recon.md         Verified facts about the target application
│
├── dashboard/               Test Board - run scenarios from the browser
│   ├── server.mjs           API that drives the Playwright CLI
│   └── src/                 React UI
│
├── src/
│   ├── pages/               Page objects, split by application boundary
│   ├── api/                 XML showtime API client - the assertion oracle
│   ├── fixtures/            Custom test fixtures
│   └── utils/               Date/format helpers (Malaysian operating dates)
│
└── tests/
    ├── e2e/                 Browser journeys, one file per flow step
    └── api/                 Showtime/movie API contract tests
```

---

## How this suite decides what to assert

Cinema showtimes are **live data** — the movies, cinemas, and times change
every day. A test that asserts "some showtime buttons appeared" passes even
when the page renders the wrong film's times, yesterday's times, or a stale
cache. That is a test that cannot fail when the feature breaks, which makes it
worse than no test at all.

So the suite uses the public showtime XML API
(`epaymentapi.gsc.com.my`, unauthenticated) as an **oracle**: it asserts that
the times rendered in the UI for a given movie and date match the times the
backend reports for that movie and date. Dynamic data, deterministic assertion.

Two consequences worth knowing up front:

- **Timezone is pinned** to `Asia/Kuala_Lumpur` in the config. Showtimes are
  indexed by Malaysian operating date; without pinning, tests pass on a laptop
  in KL and fail on a UTC CI runner around midnight.
- **Locators are role- and text-based** out of necessity. The application
  exposes no test IDs and we cannot add them, so accessible names and heading
  scoping are the only stable handles available.

---

## Troubleshooting

| Symptom | Likely cause | What to do |
|---|---|---|
| Everything fails at navigation | Network/DNS, or GSC is down | Open <https://www.gsc.com.my> manually first |
| Showtime tests fail after midnight | Timezone drift | Confirm `timezoneId` is still `Asia/Kuala_Lumpur` |
| A movie slug 404s | Film left cinemas | Never hardcode slugs — resolve them from the listing at runtime |
| Redirected to `/login` unexpectedly | Expected for anonymous booking | See [Credentials](#credentials-optional) |
| Locator matches 0 or 2+ elements | GSC shipped a UI change | Re-verify with `npm run codegen`; update `docs/app-recon.md` |
| Passes alone, fails in the suite | Race or shared state | `npm run test:flake` to reproduce |

Before changing a test to make it green, classify the failure first —
**application bug vs. test bug vs. environment vs. timing**. The workflow for
that is in `CLAUDE.md`.

---

## Test Board (dashboard)

A small React dashboard that lists every scenario and runs them individually,
so you can trigger one test without remembering its file path.

```bash
npm run dashboard          # starts the API and the UI together
```

Then open <http://localhost:5173>.

| Piece | Port | What it does |
|---|---|---|
| API (`dashboard/server.mjs`) | 8787 | Drives the Playwright CLI: lists scenarios, runs one |
| UI (Vite + React) | 5173 | The board; proxies `/api` to the API |

Run just the API with `npm run dashboard:api`.

### How it behaves

- **Scenarios come from Playwright itself** (`playwright test --list`), so new
  specs appear on the board without touching the dashboard. Steps are grouped
  and numbered from the spec filenames.
- **Runs are serialised.** These tests hit live production, so the API refuses a
  second run while one is in flight and the board disables the other buttons.
  Clicking Run five times cannot fan out five browsers at GSC.
- **Results are real Playwright output** — status, duration, and the full
  failure message with its code frame.
- **Scenarios with side effects are labelled**: `signs in` for the ones needing
  credentials, and `holds a seat` for the booking test that reserves real
  inventory. Check the badge before you click Run.
- Only scenario ids that Playwright reported are runnable; the API will not pass
  arbitrary input to a spawned process.

The board runs the `chromium` project only. Use the CLI for cross-browser runs.

---

## Reporting

Every run produces:

- `playwright-report/` — HTML report (`npm run report`)
- `test-results/` — traces, screenshots, and video for failures only

Traces are captured on first retry; screenshots and video are retained on
failure. Open a trace with `npm run trace <path-to-trace.zip>` for a full
timeline, DOM snapshots, and network log.
