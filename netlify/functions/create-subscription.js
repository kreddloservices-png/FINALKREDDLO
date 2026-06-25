/**
 * Netlify Function: create-subscription.js
 * Path: netlify/functions/create-subscription.js
 *
 * Creates a Pro plan subscription payment session for a given user.
 * Delegates to create-stripe-subscription, create-flutterwave-subscription,
 * or create-crypto-payment with payment_purpose: 'pro_upgrade' in metadata.
 *
 * Flow:
 *  1. Validate request body: { uid, gateway, billingPeriod }
 *  2. Init Firebase Admin and load platform settings
 *  3. Read Pro plan price from config/platform in Firestore
 *  4. Guard: user must exist and not already have an active Pro plan
 *  5. Delegate to the appropriate gateway function
 *  6. Return { checkoutUrl } to the frontend
 *
 * Environment variables required:
 *   FIREBASE_SERVICE_ACCOUNT — full service account JSON as one-line string
 *   PLATFORM_URL             — live domain, e.g. https://kreddlo.space (no trailing slash)
 *
 * Expected POST body (JSON):
 *   {
 *     uid:           string   — Firebase Auth UID of the subscribing user
 *     gateway:       string   — 'stripe' | 'flutterwave' | 'crypto'
 *     billingPeriod: string   — 'monthly' | 'annual'
 *     userEmail:     string?  — optional, passed to gateway for prefill
 *   }
 *
 * Success response (200):
 *   { checkoutUrl: "https://..." }
 *
 * Error responses:
 *   400 — Missing/invalid fields
 *   402 — User already has active Pro plan
 *   404 — User not found
 *   500 — Config/init error
 *   502 — Gateway error
 */

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue }      = require('firebase-admin/firestore');
const { getSettings }                   = require('./get-settings');
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

/* ── Call a sibling Netlify function (internal server-to-server) ── */
async function callFunction(functionName, payload) {
  const platformUrl = (process.env.PLATFORM_URL || 'https://kreddlo.space').replace(/\/$/, '');
  if (!platformUrl) throw new Error('PLATFORM_URL is not set.');
  const res = await fetch(`${platformUrl}/.netlify/functions/${functionName}`, {
    method:  'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-internal-secret': process.env.INTERNAL_FUNCTION_SECRET || '',
    },
    body:    JSON.stringify(payload),
  });
  let data;
  try { data = await res.json(); } catch { data = {}; }
  if (!res.ok) throw new Error(data.error || `${functionName} returned ${res.status}`);
  return data;
}

/* ══════════════════════════════════════════════════════════════
   HANDLER
══════════════════════════════════════════════════════════════ */
exports.handler = async (event) => {

  /* ── 1. Accept POST only ── */
  if (event.httpMethod !== 'POST') {
    return respond(405, { error: 'Method not allowed.' });
  }

  /* ── 2. Parse body ── */
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return respond(400, { error: 'Invalid JSON in request body.' });
  }

  const { uid, gateway, billingPeriod, userEmail } = body;

  if (!uid || typeof uid !== 'string' || !uid.trim()) {
    return respond(400, { error: 'uid is required.' });
  }
  if (!['stripe', 'flutterwave', 'crypto'].includes(gateway)) {
    return respond(400, { error: 'gateway must be "stripe", "flutterwave", or "crypto".' });
  }
  if (!['monthly', 'annual'].includes(billingPeriod)) {
    return respond(400, { error: 'billingPeriod must be "monthly" or "annual".' });
  }

  /* ── 3. Verify the caller is who they say they are ── */
  // The Firebase ID token must be present and must belong to the uid in the body.
  // This prevents one user from initiating a subscription charge against another
  // user's uid by simply swapping the value in the request body.
  const callerUid = await verifyCaller(event);
  if (!callerUid) {
    return respond(401, { error: 'Unauthorized. Please log in again.' });
  }
  if (callerUid !== uid.trim()) {
    return respond(403, { error: 'Caller identity mismatch.' });
  }

  const platformUrl = (process.env.PLATFORM_URL || 'https://kreddlo.space').replace(/\/$/, '');
  if (!platformUrl) {
    return respond(500, { error: 'PLATFORM_URL is not configured.' });
  }

  try {
    const db       = getDb();
    const settings = await getSettings(db);

    /* ── 3. Read Pro plan price from Firestore config ── */
    const configSnap = await db.collection('config').doc('platform').get();
    const config     = configSnap.exists ? configSnap.data() : {};

    // Prices in USD — fall back to sensible defaults if not configured in admin
    const monthlyPrice = Number(config.proMonthlyPrice || settings.proMonthlyPrice || 9.99);
    const annualPrice  = Number(config.proAnnualPrice  || settings.proAnnualPrice  || 99.00);
    const price        = billingPeriod === 'annual' ? annualPrice : monthlyPrice;

    /* ── 4. Load user and guard against double-upgrade ── */
    const userSnap = await db.collection('users').doc(uid.trim()).get();
    if (!userSnap.exists) {
      return respond(404, { error: 'User not found.' });
    }
    const user = userSnap.data();

    // Guard: KYC must be verified before subscribing to Pro
    if (user.kycStatus !== 'verified') {
      return respond(403, { error: 'Your identity must be verified before upgrading to Pro.' });
    }

    // Guard: already active Pro
    if (user.premiumStatus === 'active' && user.plan === 'pro') {
      const expiry = user.premiumEndDate?.toDate ? user.premiumEndDate.toDate() : new Date(user.premiumEndDate);
      if (expiry > new Date()) {
        return respond(402, { error: 'You already have an active Pro plan.' });
      }
    }

    /* ── 5. Build a stable subscription ID used as the "orderId" across gateways ── */
    // Format: sub_{uid}_{timestamp}
    const subscriptionId = `sub_${uid.trim()}_${Date.now()}`;

    // Write a pending subscription doc to Firestore so webhooks can reference it
    await db.collection('subscriptions').doc(subscriptionId).set({
      uid:           uid.trim(),
      billingPeriod,
      price,
      gateway,
      status:        'pending',
      createdAt:     FieldValue.serverTimestamp(),
    });

    const label       = billingPeriod === 'annual' ? 'Annual' : 'Monthly';
    const description = `Kreddlo Pro Plan — ${label} (${billingPeriod === 'annual' ? '12 months' : '1 month'})`;

    /* ── 6. Delegate to the appropriate gateway ── */
    let checkoutUrl;

    if (gateway === 'stripe') {
      const result = await callFunction('create-stripe-subscription', {
        subscriptionId,
        uid:          uid.trim(),
        amount:       price,
        description,
        projectTitle: `Kreddlo Pro — ${label}`,
        buyerEmail:   userEmail || user.email || '',
        metadata: {
          payment_purpose: 'pro_upgrade',
          uid:             uid.trim(),
          billingPeriod,
          subscriptionId,
        },
      });
      checkoutUrl = result.checkoutUrl;

    } else if (gateway === 'flutterwave') {
      const result = await callFunction('create-flutterwave-subscription', {
        subscriptionId,
        uid:          uid.trim(),
        amount:       price,
        description,
        buyerEmail:   userEmail || user.email || '',
        metadata: {
          payment_purpose: 'pro_upgrade',
          uid:             uid.trim(),
          billingPeriod,
          subscriptionId,
        },
      });
      checkoutUrl = result.checkoutUrl;

    } else {
      // crypto via NOWPayments
      const result = await callFunction('create-crypto-payment', {
        orderId:     subscriptionId,
        amount:      price,
        description,
        buyerEmail:  userEmail || user.email || '',
        metadata: {
          payment_purpose: 'pro_upgrade',
          uid:             uid.trim(),
          billingPeriod,
          subscriptionId,
        },
      });
      checkoutUrl = result.invoiceUrl || result.checkoutUrl;
    }

    if (!checkoutUrl) {
      return respond(502, { error: 'Payment gateway did not return a checkout URL.' });
    }

    console.log(`Pro subscription session created — uid: ${uid}, gateway: ${gateway}, billingPeriod: ${billingPeriod}, subscriptionId: ${subscriptionId}`);
    return respond(200, { checkoutUrl, subscriptionId });

  } catch (err) {
    console.error('[create-subscription] Unhandled error:', err);
    return respond(500, { error: err.message || 'Internal server error.' });
  }
};

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
