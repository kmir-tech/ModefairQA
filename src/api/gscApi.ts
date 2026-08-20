import { APIRequestContext, expect } from '@playwright/test';
import { XMLParser } from 'fast-xml-parser';

/**
 * Client for GSC's public showtime web service.
 *
 * The endpoints are unauthenticated and return attribute-heavy XML. The suite
 * uses them as an ORACLE: cinema listings and showtimes are live data that
 * change daily, so UI assertions are expressed as "the UI agrees with the
 * backend" rather than as hardcoded expectations that rot within days.
 *
 * See docs/app-recon.md sections 5 and 10.
 */

const DEFAULT_API_URL = 'https://epaymentapi.gsc.com.my';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  // Attribute values here are codes and times ("1000", "0930"). Left to its own
  // devices the parser coerces them to numbers and eats leading zeros, which
  // silently corrupts time comparisons.
  parseAttributeValue: false,
  trimValues: true,
});

/** A bookable film as the booking engine knows it. */
export interface ApiMovie {
  /** Booking-engine id — the `id` query param behind every "Buy Now" link. */
  code: string;
  title: string;
}

/** Always return a list, whatever the parser produced for a 0/1/many element. */
function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

export function apiBaseUrl(): string {
  return process.env.API_URL ?? DEFAULT_API_URL;
}

/**
 * Fetch the films the booking engine currently knows about.
 *
 * Fails loudly on a non-200 or an unparseable body rather than returning an
 * empty list — an empty oracle would make every comparison against it pass
 * vacuously, which is exactly the false positive this suite exists to avoid.
 */
export async function fetchBookableMovies(request: APIRequestContext): Promise<ApiMovie[]> {
  const url = `${apiBaseUrl()}/showtimews/service.asmx/getEpaymentMovie_ParentChild?includeChild=true&parent=`;
  const response = await request.get(url);

  expect(response.status(), `GSC films API should be reachable at ${url}`).toBe(200);
  expect(response.headers()['content-type'], 'films API should return XML').toContain('xml');

  const parsed = parser.parse(await response.text());
  const parents = asArray<Record<string, string>>(parsed?.films?.parent);

  expect(
    parents.length,
    'films API returned no films — the oracle is empty, so no UI comparison against it would be meaningful',
  ).toBeGreaterThan(0);

  return parents.map((parent) => ({
    code: String(parent['@_code']),
    title: normaliseTitle(String(parent['@_title'] ?? '')),
  }));
}

/**
 * GSC film titles frequently carry trailing spaces in the source data, and the
 * marketing site and booking engine disagree on casing. Normalise both sides
 * before comparing so tests fail on real mismatches, not on whitespace.
 */
export function normaliseTitle(title: string): string {
  return title.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** One screening as the booking engine reports it. */
export interface ApiShowtime {
  /** Cinema name exactly as the booking engine spells it. */
  cinema: string;
  /** Display time, e.g. "3:35PM". Source values carry leading spaces. */
  time: string;
  /** Format/experience, e.g. "IMAX", "2D". */
  type: string;
}

/**
 * Screenings for one film on one Malaysian operating date.
 *
 * This is the oracle behind the showtime-grid assertions: the UI must render
 * exactly these times for the selected date, no more and no fewer.
 */
export async function fetchShowtimes(
  request: APIRequestContext,
  parentId: string,
  operatingDate: string,
): Promise<ApiShowtime[]> {
  const url =
    `${apiBaseUrl()}/showtimews/service.asmx/getShowTimesByMovie_ParentChild_V2` +
    `?parentid=${parentId}&oprndate=${operatingDate}`;

  const response = await request.get(url);
  expect(response.status(), `showtimes API should be reachable at ${url}`).toBe(200);

  const parsed = parser.parse(await response.text());
  const locations = asArray<Record<string, unknown>>(parsed?.locations?.location);

  const showtimes: ApiShowtime[] = [];

  for (const location of locations) {
    // Locations carry TWO names and they usually disagree — 49 of 55 on
    // 2026-08-20. `name` is the internal label ("GSC Mid Valley"); the booking
    // UI renders `epayment_name` ("Kuala Lumpur - Mid Valley Megamall").
    //
    // Using `name` made the showtime-grid comparison pass only for the handful
    // of venues where the two happen to match, and it looked green purely
    // because the first cinema in the list was one of them.
    const cinema = String(location['@_epayment_name'] || location['@_name'] || '');

    // A location holds one <child> per format of the same film (2D, IMAX, …),
    // and each child holds its own <show> list.
    for (const child of asArray<Record<string, unknown>>(location.child as never)) {
      for (const show of asArray<Record<string, string>>(child.show as never)) {
        showtimes.push({
          cinema,
          time: String(show['@_timestr'] ?? '').trim(),
          type: String(show['@_type'] ?? '').trim(),
        });
      }
    }
  }

  return showtimes;
}

/**
 * Pick a film that actually has screenings on the given date.
 *
 * Resolving test data through the API rather than by clicking around the UI
 * keeps the browser test focused on the behaviour under test, and avoids the
 * flakiness of picking a film that happens to have no showings today.
 */
export async function findMovieWithShowtimes(
  request: APIRequestContext,
  operatingDate: string,
): Promise<{ movie: ApiMovie; showtimes: ApiShowtime[] }> {
  const movies = await fetchBookableMovies(request);

  // Bounded so a bad day cannot turn into dozens of API calls against
  // production. Films are returned roughly in release order, so the first few
  // are the widely-screened ones.
  for (const movie of movies.slice(0, 8)) {
    const showtimes = await fetchShowtimes(request, movie.code, operatingDate);
    if (showtimes.length > 0) {
      return { movie, showtimes };
    }
  }

  throw new Error(
    `No film among the first 8 in the catalogue has screenings on ${operatingDate}. ` +
      `If this is genuine (a public holiday closure, say), widen the search; ` +
      `otherwise the showtimes API is likely returning empty results.`,
  );
}

/** A screening in an ordinary hall — no premium venue, no premium format. */
export interface StandardScreening {
  movie: ApiMovie;
  cinema: string;
  time: string;
  type: string;
}

/**
 * Find a 2D screening at an ordinary GSC venue.
 *
 * Premium venues (Aurum, Velvet) and premium formats render a completely
 * different seat map — recliner images instead of numbered seat cells — so the
 * booking test pins itself to a standard hall rather than taking whatever the
 * first cinema happens to be.
 *
 * Resolved through the API so the browser test navigates straight to a known
 * good screening instead of hunting for one through the UI.
 */
export async function findStandardHallScreening(
  request: APIRequestContext,
  operatingDate: string,
): Promise<StandardScreening> {
  const movies = await fetchBookableMovies(request);

  for (const movie of movies.slice(0, 8)) {
    const screenings = await fetchShowtimes(request, movie.code, operatingDate);

    const standard = screenings.find(
      (screening) =>
        screening.type === '2D' && !/aurum|velvet|getha/i.test(screening.cinema),
    );

    if (standard) {
      return {
        movie,
        cinema: standard.cinema,
        time: standard.time,
        type: standard.type,
      };
    }
  }

  throw new Error(
    `No standard-hall 2D screening found among the first 8 films on ${operatingDate}.`,
  );
}
