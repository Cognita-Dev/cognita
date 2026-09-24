// reminders/timezone.js
// Converts a local date/time in a given IANA timezone to a UTC instant.
// DST-safe: uses Intl.DateTimeFormat to read the real UTC offset for the
// zone at that moment, rather than assuming a fixed offset. Verified
// against Africa/Lagos (fixed UTC+1), America/New_York (DST) and
// Europe/London (DST) — see the test suite.

/** Offset (ms) of `timeZone` from UTC at the instant `utcDate`, positive east of UTC. */
function getTimeZoneOffsetMs(timeZone, utcDate) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = dtf.formatToParts(utcDate).reduce((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {});
  // Some environments render midnight as hour "24" instead of "00".
  let hour = parseInt(parts.hour, 10);
  if (hour === 24) hour = 0;
  const asUTC = Date.UTC(
    parseInt(parts.year, 10),
    parseInt(parts.month, 10) - 1,
    parseInt(parts.day, 10),
    hour,
    parseInt(parts.minute, 10),
    parseInt(parts.second, 10)
  );
  return asUTC - utcDate.getTime();
}

/**
 * Converts a local wall-clock date/time in `timeZone` to a UTC Date.
 * y/m/d are calendar values (m is 1-12, matching a <input type="date">
 * value split apart), h/mi are 24-hour local time.
 */
export function zonedTimeToUtc(y, m, d, h, mi, timeZone) {
  const guessMs = Date.UTC(y, m - 1, d, h, mi, 0);
  const offset1 = getTimeZoneOffsetMs(timeZone, new Date(guessMs));
  let utcMs = guessMs - offset1;
  // Refine once more in case the first guess landed near a DST transition,
  // where the offset at guessMs differs from the offset at the real instant.
  const offset2 = getTimeZoneOffsetMs(timeZone, new Date(utcMs));
  if (offset2 !== offset1) utcMs = guessMs - offset2;
  return new Date(utcMs);
}

/** Parses a "YYYY-MM-DD" date string into { y, m, d } integers. */
export function parseDateStr(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
  if (!m) return null;
  return { y: parseInt(m[1], 10), m: parseInt(m[2], 10), d: parseInt(m[3], 10) };
}

/** Parses a "HH:MM" time string into { h, mi } integers. */
export function parseTimeStr(timeStr) {
  const m = /^(\d{2}):(\d{2})$/.exec(String(timeStr || ''));
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const mi = parseInt(m[2], 10);
  if (h > 23 || mi > 59) return null;
  return { h, mi };
}

/** Is this a valid IANA timezone name? Cheapest reliable check available in Workers. */
export function isValidTimeZone(tz) {
  if (!tz || typeof tz !== 'string' || tz.length > 64) return false;
  try {
    Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch (_) {
    return false;
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** "Morning of" local hour — one constant, easy to change. */
export const MORNING_OFFSET_HOUR = 8;

/**
 * Computes the UTC instant for one reminder preset, given the event's
 * local date/time and timezone.
 *
 * @param {string} presetId - '1_week' | '1_day' | 'morning_of' | '1_hour' | 'at_event'
 * @param {Date} eventUtc - the event's own UTC instant (start of day for all-day events)
 * @param {{y:number,m:number,d:number}} eventDate - the event's local calendar date
 * @param {string} timezone - IANA timezone name
 * @param {boolean} [allDay] - all-day events have no clock time, so "1 week / 1 day
 *   before" fire at the morning hour of that earlier day rather than at midnight
 *   (which would buzz people's phones at 00:00).
 * @returns {Date}
 */
export function computeOffsetFireAt(presetId, eventUtc, eventDate, timezone, allDay = false) {
  switch (presetId) {
    case '1_week':
    case '1_day': {
      if (allDay) {
        const daysBefore = presetId === '1_week' ? 7 : 1;
        const earlier = new Date(Date.UTC(eventDate.y, eventDate.m - 1, eventDate.d - daysBefore));
        return zonedTimeToUtc(
          earlier.getUTCFullYear(),
          earlier.getUTCMonth() + 1,
          earlier.getUTCDate(),
          MORNING_OFFSET_HOUR,
          0,
          timezone
        );
      }
      return new Date(eventUtc.getTime() - (presetId === '1_week' ? 7 : 1) * DAY_MS);
    }
    case 'morning_of':
      return zonedTimeToUtc(eventDate.y, eventDate.m, eventDate.d, MORNING_OFFSET_HOUR, 0, timezone);
    case '1_hour':
      return new Date(eventUtc.getTime() - HOUR_MS);
    case 'at_event':
      return new Date(eventUtc.getTime());
    default:
      return null;
  }
}
