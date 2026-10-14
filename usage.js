// usage.js
// Server-controlled usage counters using Cloudflare KV.
// The frontend NEVER reports usage — it only ever displays what this
// module tells it, via /api/usage. All increments happen here, keyed by
// the verified uid, never by anything the client sends.

function _todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

function _secondsUntilMidnightUTC() {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setUTCHours(24, 0, 0, 0);
  return Math.floor((midnight - now) / 1000);
}

function _kvKey(uid, resource, day) {
  return 'usage:' + uid + ':' + resource + ':' + (day || _todayKey());
}

/** ISO timestamp of the next daily reset (00:00 UTC). Shown to people as their local time. */
export function nextUsageResetIso() {
  const midnight = new Date();
  midnight.setUTCHours(24, 0, 0, 0);
  return midnight.toISOString();
}

/** Reads current usage for a resource today, without incrementing. */
export async function getUsage(uid, resource, env) {
  if (!env.COGNITA_USAGE) throw new Error('Server misconfiguration: usage KV not bound.');
  const raw = await env.COGNITA_USAGE.get(_kvKey(uid, resource));
  return raw ? parseInt(raw, 10) : 0;
}

/** Reads usage for several resources at once. */
export async function getUsageBatch(uid, resources, env) {
  const out = {};
  for (const r of resources) {
    out[r] = await getUsage(uid, r, env);
  }
  return out;
}

/**
 * Atomically-enough checks quota and increments if allowed.
 * KV doesn't offer true atomic increment, so this accepts a small race
 * window under concurrent bursts — acceptable for per-day soft limits,
 * not for anything financial (payments never use this module).
 *
 * Returns { allowed, used, limit }.
 */
export async function checkAndIncrement(uid, resource, limit, env) {
  if (!env.COGNITA_USAGE) throw new Error('Server misconfiguration: usage KV not bound.');

  const key = _kvKey(uid, resource);
  const current = await env.COGNITA_USAGE.get(key);
  const used = current ? parseInt(current, 10) : 0;

  if (used >= limit) {
    return { allowed: false, used, limit };
  }

  await env.COGNITA_USAGE.put(key, String(used + 1), {
    expirationTtl: _secondsUntilMidnightUTC() + 60, // small buffer
  });

  return { allowed: true, used: used + 1, limit };
}

/**
 * Gives back one unit of today's usage for a resource. Used when we
 * charged the user for something (e.g. one flashcard image) but then the
 * work failed on our side, so a failure never costs them their quota.
 * Never goes below zero.
 */
export async function refundUsage(uid, resource, env) {
  if (!env.COGNITA_USAGE) return;
  const key = _kvKey(uid, resource);
  const current = await env.COGNITA_USAGE.get(key);
  const used = current ? parseInt(current, 10) : 0;
  if (used <= 0) return;
  await env.COGNITA_USAGE.put(key, String(used - 1), {
    expirationTtl: _secondsUntilMidnightUTC() + 60,
  });
}

/**
 * Amount-based counterparts of checkAndIncrement / refundUsage, for resources
 * measured in more than whole units (e.g. seconds of Whisper audio).
 *
 * reserveUsage: denies only when the day's total is ALREADY at or over the
 * limit. A request that starts under the limit is allowed to finish even if it
 * carries the total past it, so the last chunk of someone's allowance is never
 * thrown away half-used. The counter keeps the true total; callers clamp for
 * display. Returns { allowed, used, limit, day }; `day` must be passed back to
 * adjustUsage so a request that straddles midnight UTC never edits the new day.
 */
export async function reserveUsage(uid, resource, amount, limit, env) {
  if (!env.COGNITA_USAGE) throw new Error('Server misconfiguration: usage KV not bound.');
  const day = _todayKey();
  const key = _kvKey(uid, resource, day);
  const raw = await env.COGNITA_USAGE.get(key);
  const used = raw ? parseInt(raw, 10) || 0 : 0;
  if (used >= limit) return { allowed: false, used, limit, day };
  const next = used + Math.max(0, Math.ceil(amount));
  await env.COGNITA_USAGE.put(key, String(next), { expirationTtl: _secondsUntilMidnightUTC() + 60 });
  return { allowed: true, used: next, limit, day };
}

/**
 * Moves today's total by `delta` (negative = give back). Never below zero.
 * Used to true up a reservation once the real amount is known, and to refund
 * it entirely when the work failed on our side. If the day has rolled over
 * since the reservation, does nothing: the old counter has already expired.
 * Returns the new total, or null when nothing was changed.
 */
export async function adjustUsage(uid, resource, delta, day, env) {
  if (!env.COGNITA_USAGE || !delta) return null;
  if (day && day !== _todayKey()) return null;
  const key = _kvKey(uid, resource, day);
  const raw = await env.COGNITA_USAGE.get(key);
  const used = raw ? parseInt(raw, 10) || 0 : 0;
  const next = Math.max(0, used + Math.round(delta));
  await env.COGNITA_USAGE.put(key, String(next), { expirationTtl: _secondsUntilMidnightUTC() + 60 });
  return next;
}

/* ────────────────────────────────────────────────────────────────────
   Monthly counters (live web search: web-search.js)
   Same idea as the daily counters above, but the key carries the UTC month
   (YYYY-MM) and the counter expires shortly after that month ends, so the
   allowance renews on the 1st (00:00 UTC). Used for resources whose real
   cost is billed by the month, where a daily allowance would not map onto it.
──────────────────────────────────────────────────────────────────── */

function _monthKey() {
  return new Date().toISOString().slice(0, 7); // YYYY-MM (UTC)
}

function _secondsUntilNextMonthUTC() {
  const now = new Date();
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  return Math.floor((next - now.getTime()) / 1000);
}

function _monthlyKvKey(uid, resource) {
  return 'usage:' + uid + ':' + resource + ':m:' + _monthKey();
}

/** ISO timestamp of the next monthly reset (the 1st, 00:00 UTC). */
export function nextMonthlyResetIso() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
}

/** Reads this month's usage for a resource, without incrementing. */
export async function getMonthlyUsage(uid, resource, env) {
  if (!env.COGNITA_USAGE) throw new Error('Server misconfiguration: usage KV not bound.');
  const raw = await env.COGNITA_USAGE.get(_monthlyKvKey(uid, resource));
  return raw ? parseInt(raw, 10) || 0 : 0;
}

/** Checks this month's quota and increments if allowed. Returns { allowed, used, limit }. Same small race as checkAndIncrement. */
export async function checkAndIncrementMonthly(uid, resource, limit, env) {
  if (!env.COGNITA_USAGE) throw new Error('Server misconfiguration: usage KV not bound.');
  const key = _monthlyKvKey(uid, resource);
  const raw = await env.COGNITA_USAGE.get(key);
  const used = raw ? parseInt(raw, 10) || 0 : 0;
  if (used >= limit) return { allowed: false, used, limit };
  await env.COGNITA_USAGE.put(key, String(used + 1), { expirationTtl: _secondsUntilNextMonthUTC() + 86400 });
  return { allowed: true, used: used + 1, limit };
}

/** Gives back one unit of this month's usage (the work failed on our side). Never goes below zero. */
export async function refundMonthlyUsage(uid, resource, env) {
  if (!env.COGNITA_USAGE) return;
  const key = _monthlyKvKey(uid, resource);
  const raw = await env.COGNITA_USAGE.get(key);
  const used = raw ? parseInt(raw, 10) || 0 : 0;
  if (used <= 0) return;
  await env.COGNITA_USAGE.put(key, String(used - 1), { expirationTtl: _secondsUntilNextMonthUTC() + 86400 });
}
