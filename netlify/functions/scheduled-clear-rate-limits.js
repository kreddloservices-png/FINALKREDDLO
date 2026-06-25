/**
 * scheduled-clear-rate-limits.js — Netlify Scheduled Function
 *
 * Runs once per hour (schedule defined in netlify.toml).
 *
 * Deletes all expired rateLimits documents — docs where expiresAt is in
 * the past. This is a fallback safety net for when Firestore TTL policy
 * is not enabled on the rateLimits collection.
 *
 * If Firestore TTL IS enabled (rateLimits collection, expiresAt field),
 * this job will simply find nothing to delete on most runs, which is fine —
 * it adds no cost and keeps things tidy without relying solely on TTL
 * propagation (which can take up to 72 h in some regions).
 *
 * netlify.toml entry:
 *   [functions."scheduled-clear-rate-limits"]
 *   schedule = "0 * * * *"
 *
 * Environment variables required:
 *   FIREBASE_SERVICE_ACCOUNT — full service account JSON as single-line string
 */

'use strict';

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, Timestamp }       = require('firebase-admin/firestore');

/* ── Firebase Admin singleton ── */
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

// Delete in batches so a large backlog doesn't blow out function memory or
// Firestore write quota in a single run. Anything left over is caught next hour.
const BATCH_SIZE = 400;

exports.handler = async function () {
  let db;
  try {
    db = getDb();
  } catch (err) {
    console.error('[scheduled-clear-rate-limits] Firebase Admin init failed:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal configuration error.' }) };
  }

  const now = Timestamp.now();
  let totalDeleted = 0;
  let errors = 0;

  try {
    // Query for expired docs. Requires a composite index on (expiresAt ASC)
    // — Firestore creates single-field indexes automatically, so this query
    // works without a manual index entry in firestore.indexes.json.
    const snap = await db.collection('rateLimits')
      .where('expiresAt', '<', now.toDate())
      .limit(BATCH_SIZE)
      .get();

    if (snap.empty) {
      console.log('[scheduled-clear-rate-limits] No expired rate-limit docs found.');
      return { statusCode: 200, body: JSON.stringify({ deleted: 0 }) };
    }

    // Batch delete — Firestore batch max is 500 writes; BATCH_SIZE=400 is safe.
    const batch = db.batch();
    snap.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();

    totalDeleted = snap.size;
    console.log(`[scheduled-clear-rate-limits] Deleted ${totalDeleted} expired rate-limit docs.`);
  } catch (err) {
    console.error('[scheduled-clear-rate-limits] Cleanup failed:', err.message);
    errors++;
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ deleted: totalDeleted, errors }),
  };
};
