/**
 * Netlify Function: cancel-subscription.js
 * Path: netlify/functions/cancel-subscription.js
 *
 * Cancels the authenticated user's active Pro subscription.
 * - Reads the user's Firestore doc to confirm they actually have an active Pro plan
 * - Sets premiumStatus → 'cancelled' (benefits remain until premiumEndDate)
 * - Sets cancelledAt timestamp
 * - Does NOT immediately revoke Pro — user keeps Pro until the end of the paid period
 *   (matching the pricing.html FAQ promise)
 *
 * This is idempotent: calling it on an already-cancelled subscription returns 200.
 *
 * Environment variables required:
 *   FIREBASE_SERVICE_ACCOUNT — full service account JSON as one-line string
 *
 * Expected POST body (JSON):
 *   {} — the user is identified from their Firebase ID token (Authorization header)
 *
 * Success response (200):
 *   { ok: true, premiumEndDate: <ISO string>, message: "..." }
 *
 * Error responses:
 *   401 — Missing or invalid auth token
 *   402 — User has no active Pro subscription to cancel
 *   500 — Server/config error
 */

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue }      = require('firebase-admin/firestore');
const { verifyCaller }                  = require('./_verify-auth');

/* ── Firebase Admin — lazy singleton ── */
let _db = null;
function getDb() {
  if (_db) return _db;
  let serviceAccount;
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
  } catch {
    throw new Error('FIREBASE_SERVICE_ACCOUNT is not valid JSON.');
  }
  if (!getApps().length) {
    initializeApp({ credential: cert(serviceAccount) });
  }
  _db = getFirestore();
  return _db;
}

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return respond(405, { error: 'Method not allowed.' });
  }

  /* ── 1. Auth: verify caller's Firebase ID token ── */
  const uid = await verifyCaller(event);
  if (!uid) {
    return respond(401, { error: 'Authentication required.' });
  }

  try {
    const db = getDb();

    /* ── 2. Read the user's current subscription state ── */
    const userRef  = db.collection('users').doc(uid);
    const userSnap = await userRef.get();

    if (!userSnap.exists) {
      return respond(401, { error: 'User not found.' });
    }

    const user = userSnap.data();

    /* ── 3. Idempotency: already cancelled → return success ── */
    if (user.premiumStatus === 'cancelled') {
      const endDate = user.premiumEndDate?.toDate
        ? user.premiumEndDate.toDate().toISOString()
        : (user.premiumEndDate ? new Date(user.premiumEndDate).toISOString() : null);
      return respond(200, {
        ok: true,
        premiumEndDate: endDate,
        message: 'Subscription already cancelled. Pro benefits remain until the end of the billing period.',
      });
    }

    /* ── 4. Guard: only cancel an active Pro plan ── */
    if (user.plan !== 'pro' || user.premiumStatus !== 'active') {
      return respond(402, { error: 'No active Pro subscription found.' });
    }

    /* ── 5. Cancel: mark as cancelled but keep benefits until premiumEndDate ── */
    // We do NOT set plan → 'free' here. The scheduled-subscriptions.js cron
    // handles the actual downgrade when premiumEndDate passes, exactly as it
    // does for natural expiry. This keeps the code path identical and avoids
    // any risk of premature access revocation.
    await userRef.update({
      premiumStatus: 'cancelled',
      cancelledAt:   FieldValue.serverTimestamp(),
    });

    /* ── 6. Also mark the most recent active subscription doc as cancelled ── */
    try {
      const subsSnap = await db.collection('subscriptions')
        .where('uid', '==', uid)
        .where('status', '==', 'active')
        .orderBy('createdAt', 'desc')
        .limit(1)
        .get();
      if (!subsSnap.empty) {
        await subsSnap.docs[0].ref.update({
          status:      'cancelled',
          cancelledAt: FieldValue.serverTimestamp(),
        });
      }
    } catch (subErr) {
      // Non-fatal — user doc is already updated; subscription doc is best-effort
      console.warn('[cancel-subscription] Could not update subscription doc:', subErr.message);
    }

    const endDate = user.premiumEndDate?.toDate
      ? user.premiumEndDate.toDate().toISOString()
      : (user.premiumEndDate ? new Date(user.premiumEndDate).toISOString() : null);

    console.log(`[cancel-subscription] uid ${uid} cancelled — Pro remains active until ${endDate}`);

    return respond(200, {
      ok: true,
      premiumEndDate: endDate,
      message: 'Subscription cancelled. Your Pro benefits remain active until the end of the current billing period.',
    });

  } catch (err) {
    console.error('[cancel-subscription] Error:', err.message);
    return respond(500, { error: 'An unexpected error occurred. Please try again.' });
  }
};
