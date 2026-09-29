// rate-limit.js
//
// Minimal per-IP request throttle for endpoints that are public and
// unauthenticated by necessity (no uid to key off, per usage.js's
// pattern) — right now, just the data-deletion status lookup. Reuses
// the COGNITA_USAGE KV namespace rather than provisioning a new one,
// same non-atomic-but-good-enough approach usage.js already accepts
// for soft per-day limits: a small race window under concurrent bursts
// is fine here too, since this exists to blunt scripted hammering, not
// to be a precise counter.
//
// Deliberately fails OPEN, not closed: if COGNITA_USAGE is unbound or
// KV has a transient error, callers should still be able to check a
// legitimate deletion status. A rate limiter that takes the feature
// down on its own infra hiccup is worse than one that occasionally
// under-limits.

function _windowBucket(windowSeconds) {
  return Math.floor(Date.now() / 1000 / windowSeconds);
}

/**
 * Returns the caller's IP as Cloudflare sees it. Never trust
 * X-Forwarded-For here — CF-Connecting-IP is the one header Cloudflare
 * itself sets and strips/overwrites on the way in, so it can't be
 * spoofed by the client the way X-Forwarded-For can.
 */
export function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || 'unknown';
}

/**
 * Checks and increments a per-IP counter for `bucketName` within a
 * fixed `windowSeconds` window. Returns { allowed, remaining, resetInSeconds }.
 * Fails open (allowed: true) if the KV binding is missing or a KV call
 * throws, logging rather than blocking the request.
 */
export async function checkIpRateLimit(request, env, bucketName, { limit, windowSeconds }) {
  if (!env.COGNITA_USAGE) {
    console.warn('[rate-limit] COGNITA_USAGE not bound; failing open for ' + bucketName);
    return { allowed: true, remaining: limit, resetInSeconds: windowSeconds };
  }

  const ip = clientIp(request);
  const bucket = _windowBucket(windowSeconds);
  const key = 'ratelimit:' + bucketName + ':' + ip + ':' + bucket;

  try {
    const current = await env.COGNITA_USAGE.get(key);
    const used = current ? parseInt(current, 10) : 0;

    if (used >= limit) {
      return { allowed: false, remaining: 0, resetInSeconds: windowSeconds };
    }

    await env.COGNITA_USAGE.put(key, String(used + 1), {
      expirationTtl: windowSeconds + 10, // small buffer past the window
    });

    return { allowed: true, remaining: limit - used - 1, resetInSeconds: windowSeconds };
  } catch (e) {
    console.warn('[rate-limit] KV error for ' + bucketName + ', failing open: ' + e.message);
    return { allowed: true, remaining: limit, resetInSeconds: windowSeconds };
  }
}

/**
 * Checks Cloudflare's built-in Rate Limiting binding (declared under
 * "ratelimits" in wrangler.jsonc). Unlike the KV-based limiter above, this
 * uses no KV reads or writes at all, so it can never eat into the KV daily
 * quota, and it is fast enough to run on every request.
 *
 * `bindingName` is the binding's name (e.g. 'RL_GENERAL'); `key` is what to
 * count by (an IP address, or a verified user id).
 *
 * Fails OPEN: if the binding is missing or errors, the request is allowed,
 * so a limiter problem can never take the whole app down.
 */
export async function checkRateBinding(env, bindingName, key) {
  const binding = env && env[bindingName];
  if (!binding || typeof binding.limit !== 'function') return { allowed: true };
  try {
    const { success } = await binding.limit({ key: String(key) });
    return { allowed: !!success };
  } catch (e) {
    console.warn('[rate-limit] binding ' + bindingName + ' error, failing open: ' + e.message);
    return { allowed: true };
  }
}
