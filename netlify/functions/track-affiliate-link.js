/**
 * Netlify Function: track-affiliate-link.js
 * Path: netlify/functions/track-affiliate-link.js
 *
 * Fills the missing creation path for the `affiliate-links` collection.
 * Previously nothing in the codebase ever wrote a document here — browse.html's
 * "Get Affiliate Link" button only built a URL client-side, and dashboard-affiliate.html
 * read from a collection that was always empty.
 *
 * Two actions, both upsert the same doc (id: `${affiliateUid}_${productId}`):
 *
 *  action: 'create'  — called when an affiliate clicks "Get Affiliate Link" on
 *                       browse.html. Requires auth; caller must be the affiliate.
 *                       Initialises the link record (clicks: 0, conversions: 0)
 *                       if it doesn't already exist. Idempotent on repeat clicks.
 *
 *  action: 'click'   — called when someone lands on p.html via a ?ref= link.
 *                       No auth (visitors aren't necessarily logged in). Increments
 *                       `clicks`. Creates the doc defensively if it's somehow missing.
 *
 * POST body:
 *   { action: 'create'|'click', affiliateUid: string, productId: string,
 *     productTitle?: string, productSlug?: string }
 *
 * Environment variables required:
 *   FIREBASE_SERVICE_ACCOUNT — full service account JSON
 */

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue }     = require('firebase-admin/firestore');
const { verifyCaller }                 = require('./_verify-auth');

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
  if (event.httpMethod !== 'POST') {
    return respond(405, { error: 'Method not allowed.' });
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return respond(400, { error: 'Invalid JSON body.' });
  }

  const { action, affiliateUid, productId, productTitle, productSlug } = body;

  if (action !== 'create' && action !== 'click') {
    return respond(400, { error: "action must be 'create' or 'click'." });
  }
  if (!affiliateUid || typeof affiliateUid !== 'string') {
    return respond(400, { error: 'affiliateUid is required.' });
  }
  if (!productId || typeof productId !== 'string') {
    return respond(400, { error: 'productId is required.' });
  }

  let db;
  try {
    db = getDb();
  } catch (err) {
    console.error('Firebase Admin init failed:', err.message);
    return respond(500, { error: 'Database not available.' });
  }

  const linkId  = `${affiliateUid}_${productId}`;
  const linkRef = db.collection('affiliate-links').doc(linkId);

  /* ══════════════════════════════════════
     ACTION: create — affiliate generated the link
  ══════════════════════════════════════ */
  if (action === 'create') {
    /* Caller must be the affiliate they claim to be */
    const callerUid = await verifyCaller(event);
    if (!callerUid || callerUid !== affiliateUid) {
      return respond(401, { error: 'Unauthorized. Please log in again.' });
    }

    /* Confirm the affiliate has actually opted into the affiliate program */
    let affiliateSnap;
    try {
      affiliateSnap = await db.collection('users').doc(affiliateUid).get();
    } catch (err) {
      console.error('Firestore read failed for affiliate user:', err.message);
      return respond(500, { error: 'Database read failed.' });
    }
    if (!affiliateSnap.exists || affiliateSnap.data().affiliateEnabled !== true) {
      return respond(403, { error: 'You are not an approved affiliate.' });
    }

    /* Confirm the product exists and allows affiliate links */
    let productSnap;
    try {
      productSnap = await db.collection('products').doc(productId).get();
    } catch (err) {
      console.error('Firestore read failed for product:', err.message);
      return respond(500, { error: 'Database read failed.' });
    }
    if (!productSnap.exists) {
      return respond(404, { error: 'Product not found.' });
    }
    const product = productSnap.data();
    if (product.affiliateEnabled !== true) {
      return respond(403, { error: 'This product does not have affiliate links enabled.' });
    }

    try {
      const resolvedSlug  = productSlug || product.slug || null;
      const platformUrl   = (process.env.PLATFORM_URL || 'https://kreddlo.space').replace(/\/$/, '') || 'https://kreddlo.space';
      // Build the canonical referral URL and persist it — dashboard reads this
      // to let affiliates copy their link without going back to browse.html.
      const refUrl = resolvedSlug
        ? `${platformUrl}/p.html?slug=${encodeURIComponent(resolvedSlug)}&ref=${encodeURIComponent(affiliateUid)}`
        : `${platformUrl}/p.html?id=${encodeURIComponent(productId)}&ref=${encodeURIComponent(affiliateUid)}`;

      const existing = await linkRef.get();
      if (!existing.exists) {
        await linkRef.set({
          affiliateUid,
          productId,
          productTitle:      productTitle || product.title || 'Untitled Product',
          productSlug:       resolvedSlug,
          refUrl,
          commissionPercent: product.affiliateCommissionPercent != null ? product.affiliateCommissionPercent : null,
          clicks:            0,
          conversions:       0,
          createdAt:         FieldValue.serverTimestamp(),
          updatedAt:         FieldValue.serverTimestamp(),
        });
      } else {
        // Already exists — keep title/slug/commission/refUrl fresh, don't touch counters.
        await linkRef.set({
          productTitle:      productTitle || product.title || 'Untitled Product',
          productSlug:       resolvedSlug,
          refUrl,
          commissionPercent: product.affiliateCommissionPercent != null ? product.affiliateCommissionPercent : null,
          updatedAt:         FieldValue.serverTimestamp(),
        }, { merge: true });
      }
    } catch (err) {
      console.error(`Firestore write failed for affiliate-links/${linkId}:`, err.message);
      return respond(500, { error: 'Failed to save affiliate link.' });
    }

    return respond(200, { success: true });
  }

  /* ══════════════════════════════════════
     ACTION: click — someone visited the referral link
  ══════════════════════════════════════ */
  try {
    await linkRef.set({
      affiliateUid,
      productId,
      clicks:    FieldValue.increment(1),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  } catch (err) {
    // Non-fatal — a missed click count should never break the buyer's page load
    console.warn(`[track-affiliate-link] click increment failed for ${linkId}:`, err.message);
    return respond(200, { success: false });
  }

  return respond(200, { success: true });
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
