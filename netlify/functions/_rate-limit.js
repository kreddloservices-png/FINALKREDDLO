/**
 * _rate-limit.js — Shared server-side rate limiting helper
 *
 * Uses Firestore as the counter store so limits are enforced across
 * every Netlify function instance with no shared memory required.
 *
 * Usage:
 *   const { checkRateLimit } = require('./_rate-limit');
 *
 *   // Inside your handler, after uid / ip is known:
 *   const rlResult = await checkRateLimit(db, `sve::${uid}`, 5, 600);
 *   if (!rlResult.allowed) {
 *     return respond(429, { error: rlResult.error, retryAfter: rlResult.retryAfter });
 *   }
 *
 * Parameters:
 *   db            — Firestore Admin instance (already initialised by caller)
 *   key           — Unique string identifying the limit bucket,
 *                   e.g. 'sve::uid123', 'otp::uid456', 'cpo::1.2.3.4'
 *   maxRequests   — Max allowed requests within the window
 *   windowSeconds — Rolling window length in seconds
 *
 * Returns:
 *   { allowed: true }  — request may proceed
 *   { allowed: false, error: string, retryAfter: number } — block the request
 *
 * Firestore collection: rateLimits/{key}
 *   Fields: count (number), windowStart (Timestamp), expiresAt (Timestamp)
 *
 * Enable Firestore TTL on the rateLimits collection in the Firebase console
 * (Collection: rateLimits, Field: expiresAt) so expired docs are purged
 * automatically. The scheduled-clear-rate-limits.js function is a backup
 * fallback if TTL is not enabled.
 *
 * Firestore rules: rateLimits collection is locked to Admin SDK only
 * (allow read, write: if false) — no client can read or manipulate counters.
 */

'use strict';

const { FieldValue, Timestamp } = require('firebase-admin/firestore');

/**
 * Checks and increments a rate-limit counter in Firestore.
 *
 * The counter is stored at rateLimits/{key}. A Firestore transaction
 * re-reads the counter atomically, so concurrent requests from the same
 * key are serialised by Firestore and the count is always accurate.
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {string}  key            — Unique rate-limit bucket identifier
 * @param {number}  maxRequests    — Max allowed requests in the window
 * @param {number}  windowSeconds  — Window length in seconds
 * @returns {Promise<{allowed: boolean, error?: string, retryAfter?: number}>}
 */
async function checkRateLimit(db, key, maxRequests, windowSeconds) {
  // Sanitise key — Firestore doc IDs cannot contain '/', replace with '::'
  const safeKey = String(key).replace(/\//g, '::').slice(0, 500);
  const ref     = db.collection('rateLimits').doc(safeKey);
  const nowMs   = Date.now();
  const windowMs = windowSeconds * 1000;

  let allowed = true;
  let retryAfterMs = 0;

  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.exists ? snap.data() : null;

      // Derive windowStart from stored Timestamp (handles both Firestore
      // Timestamp objects and plain JS Date stored by older writes).
      let windowStart = 0;
      if (data && data.windowStart) {
        windowStart = data.windowStart.toMillis
          ? data.windowStart.toMillis()
          : new Date(data.windowStart).getTime();
      }

      const inWindow = data && (nowMs - windowStart) < windowMs;
      const count    = inWindow ? (Number(data.count) || 0) : 0;

      if (inWindow && count >= maxRequests) {
        // Still inside the window and at the cap — block the request.
        allowed = false;
        retryAfterMs = windowMs - (nowMs - windowStart);
        // Do not increment the counter further; just return.
        return;
      }

      // Either the window has reset or we're under the cap — allow and
      // increment (or create a fresh doc if this is the first request).
      const newWindowStart = inWindow ? windowStart : nowMs;
      const newCount       = inWindow ? count + 1 : 1;
      const expiresAt      = new Date(newWindowStart + windowMs * 2); // TTL: 2× window

      tx.set(ref, {
        count:       newCount,
        windowStart: Timestamp.fromMillis(newWindowStart),
        expiresAt,
        updatedAt:   new Date(),
      });
    });
  } catch (err) {
    // If the rate-limit check itself fails (e.g. Firestore unavailable),
    // fail open — it is better to let a request through than to block
    // legitimate users because of a transient database error.
    console.warn('[_rate-limit] Rate-limit check failed (failing open):', err.message);
    return { allowed: true };
  }

  if (!allowed) {
    const retryAfterSecs = Math.ceil(retryAfterMs / 1000);
    return {
      allowed:    false,
      retryAfter: retryAfterSecs,
      error:      `Too many requests. Please try again in ${retryAfterSecs} seconds.`,
    };
  }

  return { allowed: true };
}

module.exports = { checkRateLimit };
