/**
 * Netlify Function: create-flutterwave-subscription.js
 * Path: netlify/functions/create-flutterwave-subscription.js
 *
 * Initialises a Flutterwave transaction for a Kreddlo Pro plan subscription.
 * Called exclusively by create-subscription.js — never directly by the frontend.
 *
 * Key differences from create-flutterwave-payment.js:
 *  - Amount comes from the validated subscriptions/{subscriptionId} Firestore doc
 *    (written by create-subscription.js before calling us), not from a projects doc.
 *  - No KYC freelancer guard — this is a user paying for their own plan.
 *  - redirect_url points to pricing.html, not buyer-payments.html.
 *  - meta.payment_purpose: 'pro_upgrade' so flutterwave-webhook.js can route
 *    the event correctly (see handleProUpgrade in flutterwave-webhook.js).
 *
 * Flow:
 *  1. Validate request body
 *  2. Guard: FLW_SECRET_KEY must be set
 *  3. Init Firebase and load platform settings
 *  4. Guard: flutterwaveEnabled must be true in platform settings
 *  5. Verify subscriptions doc and read authoritative price
 *  6. Build and POST the transaction to the Flutterwave Payment API
 *  7. Return { checkoutUrl, paymentRef } to create-subscription.js
 *
 * Environment variables required:
 *   FLW_SECRET_KEY            — Flutterwave secret key (FLWSECK_TEST-... or FLWSECK-...)
 *   FIREBASE_SERVICE_ACCOUNT  — full service account JSON as one-line string
 *   PLATFORM_URL              — live domain, e.g. https://kreddlo.space (no trailing slash)
 *
 * Expected POST body (JSON) — sent by create-subscription.js:
 *   {
 *     subscriptionId: string   — Firestore subscriptions doc ID (sub_<uid>_<ts>)
 *     uid:            string   — Firebase Auth UID of the subscribing user
 *     amount:         number   — price in USD (e.g. 9.99 or 99.00)
 *     description:    string   — shown on the Flutterwave checkout page
 *     buyerEmail:     string   — required by Flutterwave to initialise a transaction
 *     metadata:       object   — forwarded into meta and read back by flutterwave-webhook.js
 *   }
 *
 * Success response (200):
 *   { checkoutUrl: "https://checkout.flutterwave.com/v3/hosted/pay/...", paymentRef: "kredsub-..." }
 *
 * Error responses:
 *   400 — Missing / invalid fields
 *   403 — Flutterwave payments are not currently enabled
 *   404 — Subscription record not found
 *   500 — Flutterwave is not configured / unhandled error
 *   502 — Flutterwave API error
 */

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore }                 = require('firebase-admin/firestore');
const { getSettings }                  = require('./get-settings');

/* ── Flutterwave Standard Payment endpoint ── */
const FLW_PAYMENT_URL = 'https://api.flutterwave.com/v3/payments';

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

/* ══════════════════════════════════════════════════════════════
   HANDLER
══════════════════════════════════════════════════════════════ */
exports.handler = async (event) => {

  /* ── 1. Accept POST only ── */
  if (event.httpMethod !== 'POST') {
    return respond(405, { error: 'Method not allowed.' });
  }

  /* ── 2. Verify internal caller — this function is never called directly by the browser ── */
  const incomingSecret = event.headers['x-internal-secret'] || event.headers['X-Internal-Secret'] || '';
  const expectedSecret = process.env.INTERNAL_FUNCTION_SECRET || '';
  if (!expectedSecret || incomingSecret !== expectedSecret) {
    return respond(401, { error: 'Unauthorized.' });
  }

  /* ── 3. Parse and validate request body ── */
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return respond(400, { error: 'Invalid JSON in request body.' });
  }

  const {
    subscriptionId,
    uid,
    amount: clientAmount,
    description,
    buyerEmail,
    metadata: clientMetadata,
  } = body;

  if (!subscriptionId || typeof subscriptionId !== 'string' || !subscriptionId.trim()) {
    return respond(400, { error: 'subscriptionId is required.' });
  }
  if (!uid || typeof uid !== 'string' || !uid.trim()) {
    return respond(400, { error: 'uid is required.' });
  }
  if (!clientAmount || isNaN(Number(clientAmount)) || Number(clientAmount) <= 0) {
    return respond(400, { error: 'amount must be a positive number.' });
  }
  if (!description || typeof description !== 'string' || !description.trim()) {
    return respond(400, { error: 'description is required.' });
  }
  if (!buyerEmail || typeof buyerEmail !== 'string' || !buyerEmail.includes('@')) {
    return respond(400, { error: 'buyerEmail is required and must be a valid email address.' });
  }

  /* ── 4. Pull environment variables ── */
  const platformUrl = (process.env.PLATFORM_URL || 'https://kreddlo.space').replace(/\/$/, '');
  if (!platformUrl) {
    console.error('[create-flutterwave-subscription] PLATFORM_URL is not set.');
    return respond(500, { error: 'Platform URL is not configured. Please contact support.' });
  }

  const flwKey = process.env.FLW_SECRET_KEY;
  if (!flwKey) {
    console.error('[create-flutterwave-subscription] FLW_SECRET_KEY is not set.');
    return respond(500, { error: 'Flutterwave is not configured. Please contact support.' });
  }

  try {

    /* ── 5. Init Firebase and check platform settings ── */
    const db       = getDb();
    const settings = await getSettings(db);

    if (!settings.flutterwaveEnabled) {
      return respond(403, { error: 'Flutterwave payments are not currently enabled.' });
    }

    /* ── 6. Verify subscriptions doc and read authoritative price ── */
    /*
     * create-subscription.js writes subscriptions/{subscriptionId} before
     * calling us. We read the price back from there so the amount is always
     * server-authoritative — the clientAmount is a fallback only.
     */
    const subSnap = await db.collection('subscriptions').doc(subscriptionId.trim()).get();
    if (!subSnap.exists) {
      return respond(404, { error: 'Subscription record not found.' });
    }
    const subDoc = subSnap.data();

    const amount = Number(subDoc.price || clientAmount);
    if (!amount || amount <= 0) {
      return respond(400, { error: 'Subscription has no valid price set.' });
    }

    /*
     * Flutterwave supports multi-currency: USD, GBP, EUR, NGN, GHS, ZAR, KES, etc.
     * We default to USD for Pro plan subscriptions since prices are defined in USD.
     * If the platform is configured with a different currency, we use that.
     */
    const currency = (settings.platformCurrency || 'USD').toUpperCase();

    /* ── 7. Build a unique transaction reference ── */
    /*
     * Flutterwave requires a unique tx_ref per transaction.
     * Prefix with 'kredsub-' to distinguish subscription payments
     * from project payments ('kreddlo-') in the Flutterwave dashboard and webhooks.
     */
    const paymentRef = `kredsub-${subscriptionId.trim()}-${Date.now()}`;

    /* ── 8. Build the meta object — read back verbatim by flutterwave-webhook.js ── */
    const meta = {
      payment_purpose: 'pro_upgrade',
      subscriptionId:  subscriptionId.trim(),
      uid:              uid.trim(),
      platform:        'kreddlo',
    };

    // Merge any additional metadata from create-subscription.js (e.g. billingPeriod)
    if (clientMetadata && typeof clientMetadata === 'object') {
      for (const [k, v] of Object.entries(clientMetadata)) {
        if (Object.prototype.hasOwnProperty.call(meta, k)) continue; // don't clobber the fields above
        meta[k] = String(v);
      }
    }

    /* ── 9. Build the Flutterwave payment payload ── */
    const transactionPayload = {
      tx_ref:          paymentRef,
      amount:          amount,                // Flutterwave accepts decimal amount directly
      currency,
      redirect_url:    `${platformUrl}/pricing.html?sub=success&subscriptionId=${encodeURIComponent(subscriptionId.trim())}&method=flutterwave`,
      payment_options: 'card,banktransfer,ussd,mobilemoney,account,barter,nqr',
      customer: {
        email: buyerEmail.trim().toLowerCase(),
        name:  buyerEmail.trim().toLowerCase(),
      },
      customizations: {
        title:       'Kreddlo Pro Plan',
        description: description.trim(),
        logo:        `${platformUrl}/assets/kreddlo-logo.png`,
      },
      meta,
    };

    /* ── 10. Call the Flutterwave API ── */
    let flwRes;
    try {
      flwRes = await fetch(FLW_PAYMENT_URL, {
        method:  'POST',
        headers: {
          'Authorization': `Bearer ${flwKey}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify(transactionPayload),
      });
    } catch (networkErr) {
      console.error('[create-flutterwave-subscription] Network error reaching Flutterwave:', networkErr);
      return respond(502, { error: 'Could not reach the payment service. Please try again.' });
    }

    /* ── 11. Handle the Flutterwave response ── */
    let flwData;
    try {
      flwData = await flwRes.json();
    } catch {
      console.error('[create-flutterwave-subscription] Flutterwave returned non-JSON, status:', flwRes.status);
      return respond(502, { error: 'Unexpected response from payment service.' });
    }

    if (!flwRes.ok || flwData.status !== 'success') {
      console.error('[create-flutterwave-subscription] Flutterwave API error:', {
        status:  flwRes.status,
        payload: flwData,
      });
      const detail = flwData?.message || 'Unknown error from payment service.';
      return respond(502, { error: `Payment service error: ${detail}` });
    }

    const checkoutUrl = flwData?.data?.link;

    if (!checkoutUrl) {
      console.error('[create-flutterwave-subscription] Flutterwave response missing data.link:', flwData);
      return respond(502, { error: 'Payment service did not return a checkout URL.' });
    }

    console.log(
      `[create-flutterwave-subscription] Transaction initialised — subscriptionId: ${subscriptionId}, ` +
      `uid: ${uid}, amount: ${amount} ${currency}, ref: ${paymentRef}`
    );

    /* ── 12. Return success ── */
    return respond(200, { checkoutUrl, paymentRef });

  } catch (err) {
    console.error('[create-flutterwave-subscription] Unhandled error:', err);
    return respond(500, { error: 'Internal server error. Please try again.' });
  }
};

/* ── Utility: build a Netlify function response ── */
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
