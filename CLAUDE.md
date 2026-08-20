# CLAUDE.md — Working Agreement for the GSC QA Suite

Guidance for Claude Code when working in this repository. `README.md` explains
how to install and run the suite; this file explains **how we work on it** and
**what we remember between sessions**.

---

## 1. What this project is

A Playwright + TypeScript quality suite for **Golden Screen Cinemas Malaysia**,
a third-party production website we do not own and cannot modify.

That ownership fact drives everything:

- We cannot add `data-testid` hooks. There are none. Locators must be built
  from roles, accessible names, and heading scoping.
- We cannot seed or reset data. Showtimes are live and change daily.
- We cannot break things safely. There is no staging environment.
- We cannot make the app more testable. We adapt to it, not the reverse.

The goal is **meaningful quality signal**, not test count. Twenty tests that go
red when GSC breaks beat two hundred that never do.

---

## 2. The flow under test

| Step | Journey | Primary risk being covered |
|---|---|---|
| 1 | Browse and select a movie | Catalogue renders; a movie is reachable and its detail page is correct |
| 2 | Select a showtime | Correct showtimes for the correct movie on the correct date |
| 3 | Continue booking | The handoff into booking works, and is correctly gated by auth |
| 4 | Basic navigation validation | Header/footer/cross-app links resolve, no dead ends |

Step 1 is the current focus. Later steps build on its page objects.

---

## 3. Non-negotiable rules

These exist because breaking them produces tests that look fine and prove
nothing — or, worse, cause real-world harm on a production system.

**Safety on a live target**

1. **Never complete a payment.** Stop at the seat map or order summary.
2. **Never use real customer accounts or real payment instruments.**
3. Keep worker counts low. The suite should look like a few users.
4. Never commit `.env`, and never echo credentials into a log or report.

**Test quality**

5. **No `waitForTimeout` as a synchronisation strategy.** Ever. Use web-first
   assertions and `waitForResponse`. (Recon scratch scripts are exempt; they
   are not tests and do not live in `tests/`.)
6. **No hardcoded movie slugs, cinema names, dates, or showtimes** in test
   bodies. All of it changes. Resolve at runtime, from the listing page or the
   API.
7. **Every assertion must be able to fail.** Before committing one, answer:
   *if GSC broke this feature in the most likely way, would this go red?* If
   the answer is no, the assertion is decoration — delete or strengthen it.
8. **Assert business outcomes, not page facts.** `toHaveURL` alone is never
   sufficient; pair it with content that proves the right thing loaded.
9. **Tests are independent.** No ordering dependencies, no shared mutable
   state. They must survive `--repeat-each=3` and parallel workers.
10. **Verify locators against the live app** before claiming a test works.
    Hallucinated selectors are the top failure mode here — there are no test
    IDs to fall back on.

**Honesty**

11. **Run the tests before reporting them as done.** Show the command and the
    real output. A file existing is not a passing test.
12. When something is skipped, blocked, or unverified, **say so explicitly**.

---

## 4. Workflow

### 4.1 Adding coverage for a flow step

1. **Recon first.** Read `docs/app-recon.md`. If it does not cover the area,
   probe the live site with a throwaway script in `.recon/` (git-ignored) and
   **write the findings back into `docs/app-recon.md`**. Never design against
   assumptions about a third-party UI.
2. **Risk analysis.** What actually breaks for a customer here? What is the
   blast radius? Rank before writing anything.
3. **Choose the layer.** Push assertions down where they are cheaper and more
   stable. If the showtime XML API can prove it, prove it there and keep one UI
   test for the user-visible result.
4. **State what you will NOT automate, and why.** That is a strategy decision
   and belongs in the report, not silently omitted.
5. **Implement.** Page objects in `src/pages/`, split along the
   marketing-site / booking-engine seam. Add abstraction only when duplication
   is real.
6. **Run it.** Then run it again with `npm run test:flake`.
7. **Audit it** using section 4.2.
8. **Report** using the format in section 6.

### 4.2 The false-positive audit (do this on your own tests too)

The characteristic failure of generated tests is passing for reasons unrelated
to the requirement. For each test, check:

- Could this pass while the feature is broken?
- Does it assert *what* rendered, or merely *that something* rendered?
- Are the locators real? Verified against the live DOM?
- Is any dynamic data hardcoded, so it will rot within days?
- Does it duplicate coverage that already exists?
- Where is the negative case — the empty state, the invalid input, the
  unauthenticated user?

Where cheap, prove it: break the expectation locally, confirm the test goes
red, then restore. A test that has never failed has never been verified.

### 4.3 Investigating a failure

Diagnose before editing. Raising a timeout as the first move is how real bugs
get buried. Classify explicitly:

| Category | Signal |
|---|---|
| **Application bug** | Reproducible by hand; API and UI disagree |
| **Test bug** | Wrong assumption, wrong expected value |
| **Selector drift** | Element is there; locator no longer matches (expect this — no test IDs) |
| **Live-data drift** | Film left cinemas, no showtimes that day, midnight rollover |
| **Race / timing** | Passes alone, fails under parallelism |
| **Environment** | Network, DNS, GSC outage, geo-blocking |

State the conclusion unambiguously and attach evidence:

```
APPLICATION BUG — /showtime-by-movies?id=5116 renders a 4:30PM STUDIO show
that getShowTimesByMovie_ParentChild_V2 does not return for 2026-08-20.
Reproduced against the API with curl, independently of the test.
Trace: test-results/select-showtime/trace.zip
```

versus

```
TEST FAILURE — locator getByRole('button', { name: /PM/ }) matched both a
showtime and the "PM Sessions" filter after GSC's filter redesign.
Product behaviour is correct.
```

### 4.4 Definition of done

Not "the file exists". Done means:

- [ ] `npm run typecheck` passes
- [ ] Tests were **actually run**, and the command and output are shown
- [ ] Locators verified against the live site
- [ ] Assertions verify business behaviour, not incidental page facts
- [ ] No hardcoded live data; no `waitForTimeout`
- [ ] Passes under `npm run test:flake`
- [ ] Negative / empty-state cases covered where relevant
- [ ] `docs/app-recon.md` updated if anything new was learned
- [ ] Deliberate coverage gaps named out loud

---

## 5. Memory

Work on this repo spans sessions, and Claude starts each one cold. Memory is
what stops us re-deriving the same facts — and, worse, re-deriving them
*wrongly* against a site that changes underneath us.

### 5.1 Three tiers

| Tier | Lives in | Holds | Lifetime |
|---|---|---|---|
| **Application memory** | `docs/app-recon.md` | Verified facts about the GSC app: URLs, DOM structure, API shapes, auth behaviour | Until GSC changes; re-verify on failure |
| **Project memory** | `~/.claude/projects/C--Users-User-Downloads-modefair/memory/` + `MEMORY.md` | Decisions, constraints, and user preferences not derivable from the code | Long-lived |
| **Session memory** | The conversation | Current task state | Discarded |

### 5.2 `docs/app-recon.md` is the important one

It is the load-bearing memory for this project. Every fact in it was
**observed**, not assumed, and it carries the date it was verified.

Rules:

- **Read it before designing any test.** It will save a recon cycle.
- **Write to it whenever you learn something new** about the target — a URL
  pattern, a DOM structure, an API parameter, a redirect behaviour.
- **Record evidence, not conclusions.** "0 `[data-testid]` matches on
  /movies" beats "the site is hard to test".
- **Treat it as stale on failure.** If a locator breaks, the document is a
  suspect. Re-verify, then correct it. A confidently wrong memory is worse
  than no memory.

### 5.3 Project memory

Use the persistent memory directory for things the repository cannot tell a
future session:

- **Constraints and boundaries** — e.g. no staging environment exists; never
  complete a payment; credentials are optional and tests skip without them.
- **Decisions and their rationale** — e.g. why the XML API is used as an
  oracle; why cross-browser coverage is a tagged subset.
- **User preferences** — how the user wants work sequenced and reported.

Do **not** put there what the repo already records: file layout, npm scripts,
locator syntax, or anything reconstructible by reading the code. One fact per
file, with a pointer line added to `MEMORY.md`.

### 5.4 Keeping memory honest

The target is a third-party production site that ships without telling us. Any
remembered fact about it is a **hypothesis with an expiry date**.

- Attach the verification date to application facts.
- On unexplained failure, re-verify the memory before editing the test.
- Delete memories found to be wrong. Do not annotate them into ambiguity.

---

## 6. Report format

Close every task with this:

```markdown
## What was tested
## Tests added/modified
## Scenarios covered
## Scenarios deliberately not automated (and why)
## Commands executed
## Test results
## Bugs discovered — APPLICATION BUG vs TEST FAILURE, with evidence
## Remaining coverage gaps
## Recommended next steps
```

If a product defect was found, lead with it. It is the most valuable thing in
the report.
