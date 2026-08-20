/**
 * Malaysian operating dates.
 *
 * GSC indexes showtimes by operating date in Asia/Kuala_Lumpur. Playwright's
 * `timezoneId` only affects the BROWSER — Node still runs in the machine's own
 * timezone — so the date must be computed explicitly here, or a CI runner in
 * UTC picks yesterday for most of the Malaysian day.
 */
export function malaysianOperatingDate(offsetDays = 0): string {
  const now = new Date();
  const kualaLumpurToday = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kuala_Lumpur',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now); // en-CA yields YYYY-MM-DD

  if (offsetDays === 0) return kualaLumpurToday;

  const shifted = new Date(`${kualaLumpurToday}T00:00:00Z`);
  shifted.setUTCDate(shifted.getUTCDate() + offsetDays);
  return shifted.toISOString().slice(0, 10);
}
