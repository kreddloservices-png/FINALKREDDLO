/**
 * Netlify Function: get-guest-purchases.js
 * Path: netlify/functions/get-guest-purchases.js
 *
 * Called by buyer-purchases.html as a fallback alongside the primary
 * buyerUid query, to surface guest-checkout orders that never got a
 * buyerUid stamped onto them (create-product-order.js stamps buyerUid
 * in a non-fatal try/catch — see that file — so it can fail).
 *
 * FIX (issue 3): the previous approach ran this lookup client-side as
 * `where('buyerEmail', '==', email)` directly against Firestore. That
 * always failed with permission-denied, because firestore.rules only
 * grants read access on product-orders when auth.uid matches buyerUid
 * or sellerUid — there's no clause for buyerEmail, and there
 * deliberately isn't one: email is not an authenticated identity the
 * way a Firebase uid is, so a client-side rule keyed on a
 * client-supplied email string would let anyone read anyone else's
 * orders just by typing in their email.
 *
 * This function does the same query, but server-side via the Admin SDK
 * (which bypasses security rules entirely, like every other function in
 * this codebase) and — critically — using the EMAIL CLAIM FROM THE
 * CALLER'S VERIFIED FIREBASE ID TOKEN, never a client-supplied email
 * string. That's what makes this safe: the email is already an
 * authenticated fact about the caller by the time it reaches the query,
 * not user input.
 *
 * POST body: {} (no body needed — email comes from the verified token)
 *
 * Auth: Firebase ID token in Authorization header. Required — there is
 * no internal-secret path, since this is purely a buyer-facing lookup.
 *
 * Environment variables required:
 *   FIREBASE_SERVICE_ACCOUNT  — full service account JSON
 */

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore }                 = require('firebase-admin/firestore');
const { verifyCallerWithEmail }        = require('./_verify-auth');

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

exports.handler = async (event) => {

  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        'Access-Control-Allow-Origin':  '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      },
    };
  }

  if (event.httpMethod !== 'POST') {
    return respond(405, { error: 'Method not allowed.' });
  }

  /* ── Verify caller and get their AUTHENTICATED email from the token
     claim — never trust a client-supplied email field for this lookup. ── */
  const caller = await verifyCallerWithEmail(event);
  if (!caller) {
    return respond(401, { error: 'Unauthorized. Please log in again.' });
  }

  if (!caller.email) {
    // Some auth providers/accounts may not carry a verified email claim.
    // Nothing to look up; not an error, just no guest orders to find.
    return respond(200, { success: true, orders: [] });
  }

  const normalizedEmail = caller.email.trim().toLowerCase();

  /* ── Init Firestore ── */
  let db;
  try {
    db = getDb();
  } catch (err) {
    console.error('Firebase Admin init failed:', err.message);
    return respond(500, { error: 'Database not available.' });
  }

  /* ── Query product-orders by buyerEmail (Admin SDK — bypasses rules) ── */
  let snap;
  try {
    snap = await db.collection('product-orders')
      .where('buyerEmail', '==', normalizedEmail)
      .where('paymentStatus', '==', 'paid')
      .orderBy('createdAt', 'desc')
      .get();
  } catch (err) {
    console.error('[get-guest-purchases] product-orders query failed (may need composite index on product-orders.buyerEmail + product-orders.paymentStatus + product-orders.createdAt):', err.message);
    return respond(500, { error: 'Could not look up guest orders.' });
  }

  const orders = snap.docs.map((d) => {
    const data = d.data();
    // Serialize any Firestore Timestamp fields to ISO strings — the Admin
    // SDK's Timestamp class doesn't survive JSON.stringify in a form the
    // client's buildPurchase() can parse (it expects either a Timestamp
    // with .toDate(), which only exists client-side, or a value `new
    // Date()` can parse directly).
    Object.keys(data).forEach((key) => {
      const val = data[key];
      if (val && typeof val.toDate === 'function') {
        data[key] = val.toDate().toISOString();
      }
    });
    return { id: d.id, ...data };
  });

  return respond(200, { success: true, orders });
};

/* ── Utility ── */
function respond(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify(body),
  };
}
