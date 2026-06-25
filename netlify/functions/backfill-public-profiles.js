/**
 * Netlify Function: backfill-public-profiles.js
 * Path: netlify/functions/backfill-public-profiles.js
 *
 * ONE-TIME MIGRATION SCRIPT. Not called by any page in the app.
 *
 * Copies the public-safe field subset from every existing users/{uid}
 * document into a matching publicProfiles/{uid} document. Needed because
 * browse.html, p.html, store.html, and profile.html are being switched
 * from reading users/{uid} directly to reading publicProfiles/{uid}
 * instead (see firestore.rules comments on both collections for why).
 * Without this backfill, every account created before that switch would
 * have a users doc but no publicProfiles doc, and would silently vanish
 * from the freelancer directory and public profile pages the moment the
 * reads switch over — even though nothing about the account itself
 * changed.
 *
 * Going forward, publicProfiles/{uid} is kept in sync at write time by:
 *   - signup.html                              (create, on signup)
 *   - dashboard-settings.html saveProfile()     (name/title/description/
 *     skills/startingPrice)
 *   - dashboard-settings.html avatar upload     (photoUrl/photoURL/
 *     profilePhoto)
 *   - dashboard-settings.html saveStoreSettings (storeSettings)
 *   - netlify/functions/kyc-approve.js          (kycStatus)
 *   - netlify/functions/submit-review.js        (averageRating/totalReviews)
 * This script only needs to run once, to catch every account that
 * existed before those write-sites were updated. It is safe to run
 * again later if needed — see IDEMPOTENCY note below — but should not
 * be needed more than once in normal operation.
 *
 * HOW TO RUN:
 *   curl -X POST https://kreddlo.space/.netlify/functions/backfill-public-profiles \
 *     -H "Content-Type: application/json" \
 *     -d '{"adminSecret":"<your ADMIN_SECRET value>"}'
 *
 *   Or trigger it once from a terminal with fetch() / Postman / similar —
 *   it is not wired into admin.html since it's meant to run exactly once,
 *   not be a recurring admin action.
 *
 * IDEMPOTENCY:
 *   Re-running this is safe. Each publicProfiles/{uid} write uses `set`
 *   with the fields derived fresh from the current users/{uid} doc, so
 *   running it twice just re-writes the same (or updated) values — it
 *   never duplicates documents or appends to arrays/counters.
 *
 * RESPONSE:
 *   { processed: number, written: number, skipped: number, errors: [...] }
 *   `skipped` = users docs with no role/profile data worth mirroring
 *   (e.g. a buyer account with no public-facing fields at all).
 *
 * Environment variables required:
 *   FIREBASE_SERVICE_ACCOUNT — full service account JSON (single-line string)
 *   ADMIN_SECRET             — same shared secret used by admin.html's
 *                              other admin-only function calls
 */

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore }                 = require('firebase-admin/firestore');

function getDb() {
  if (!getApps().length) {
    let sa;
    try { sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}'); }
    catch { throw new Error('FIREBASE_SERVICE_ACCOUNT is not valid JSON.'); }
    initializeApp({ credential: cert(sa) });
  }
  return getFirestore();
}

/* Same allowlist as the publicProfiles create/update rule in
   firestore.rules — keep these in sync if either changes.
   FIX (Bug 2): added 'bio', 'acceptedPaymentMethods', 'available'
   to match the three fields now permitted by the Firestore rule. */
const PUBLIC_FIELDS = [
  'name', 'displayName', 'title', 'description', 'bio', 'skills',
  'startingPrice', 'photoUrl', 'photoURL', 'profilePhoto',
  'storeSettings', 'kycStatus', 'averageRating', 'totalReviews',
  'role', 'createdAt', 'acceptedPaymentMethods', 'available',
];

function extractPublicFields(userData) {
  const out = {};
  let hasAny = false;
  for (const field of PUBLIC_FIELDS) {
    if (userData[field] !== undefined) {
      out[field] = userData[field];
      hasAny = true;
    }
  }
  return hasAny ? out : null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed.' }) };
  }

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  /* Same fail-closed shared-secret pattern used by kyc-approve.js and
     every other admin-only function in this codebase. */
  const serverSecret = process.env.ADMIN_SECRET;
  if (!serverSecret || payload.adminSecret !== serverSecret) {
    return { statusCode: 403, body: JSON.stringify({ error: 'Forbidden' }) };
  }

  let db;
  try { db = getDb(); }
  catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }

  const result = { processed: 0, written: 0, skipped: 0, errors: [] };

  try {
    const usersSnap = await db.collection('users').get();
    result.processed = usersSnap.size;

    /* Firestore batches cap at 500 writes — chunk accordingly. */
    const BATCH_SIZE = 450;
    let batch = db.batch();
    let opsInBatch = 0;

    for (const userDoc of usersSnap.docs) {
      const userData = userDoc.data();
      const publicData = extractPublicFields(userData);

      if (!publicData) {
        result.skipped++;
        continue;
      }

      const ref = db.collection('publicProfiles').doc(userDoc.id);
      batch.set(ref, publicData, { merge: true });
      opsInBatch++;
      result.written++;

      if (opsInBatch >= BATCH_SIZE) {
        await batch.commit();
        batch = db.batch();
        opsInBatch = 0;
      }
    }

    if (opsInBatch > 0) {
      await batch.commit();
    }

  } catch (err) {
    console.error('[backfill-public-profiles] Error:', err);
    result.errors.push(err.message || String(err));
    return { statusCode: 500, body: JSON.stringify(result) };
  }

  console.log(`[backfill-public-profiles] Done — processed: ${result.processed}, written: ${result.written}, skipped: ${result.skipped}`);
  return { statusCode: 200, body: JSON.stringify(result) };
};
