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

function _kvKey(uid, resource) {
  return 'usage:' + uid + ':' + resource + ':' + _todayKey();
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
