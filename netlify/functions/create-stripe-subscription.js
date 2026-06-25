/**
 * Netlify Function: create-stripe-subscription.js
 * Path: netlify/functions/create-stripe-subscription.js
 *
 * Creates a Stripe Checkout Session for a Kreddlo Pro plan subscription.
 * Called exclusively by create-subscription.js — never directly by the frontend.
 *
 * Key differences from create-stripe-payment.js:
 *  - Amount comes from the validated request body (already written to
 *    subscriptions/{subscriptionId} by create-subscription.js), not from
 *    a projects Firestore doc.
 *  - No KYC freelancer guard — this is a buyer/freelancer paying for a plan.
 *  - Success/cancel URLs point to pricing.html, not buyer-payments.html.
 *  - Metadata carries payment_purpose: 'pro_upgrade' so stripe-webhook.js
 *    can route the payment correctly after Stripe confirms it.
 *
 * Flow:
 *  1. Validate request body
 *  2. Guard: STRIPE_SECRET_KEY must be set
 *  3. Guard: stripeEnabled must be true in platform settings
 *  4. Build and POST the Checkout Session to Stripe
 *  5. Return { checkoutUrl, sessionId } to create-subscription.js
 *
 * Environment variables required:
 *   STRIPE_SECRET_KEY        — Stripe secret key (sk_live_... or sk_test_...)
 *   FIREBASE_SERVICE_ACCOUNT — full service account JSON as one-line string
 *   PLATFORM_URL             — live domain, e.g. https://kreddlo.space (no trailing slash)
 *
 * Expected POST body (JSON) — sent by create-subscription.js:
 *   {
 *     subscriptionId: string   — Firestore subscriptions doc ID (sub_<uid>_<ts>)
 *     uid:            string   — Firebase Auth UID of the subscribing user
 *     amount:         number   — price in USD (e.g. 9.99 or 99.00)
 *     description:    string   — shown on the Stripe checkout page
 *     projectTitle:   string   — shown as the line item name
 *     buyerEmail:     string?  — optional, pre-fills email on Stripe checkout
 *     metadata:       object   — passed through to Stripe session metadata
 *   }
 *
 * Success response (200):
 *   { checkoutUrl: "https://checkout.stripe.com/...", sessionId: "cs_..." }
 *
 * Error responses:
 *   400 — Missing / invalid fields
 *   403 — Stripe payments are not currently enabled
 *   500 — Stripe is not configured / unhandled error
 *   502 — Stripe API error
 */

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore }                 = require('firebase-admin/firestore');
const { getSettings }                  = require('./get-settings');

/* ── Stripe Checkout Sessions endpoint ── */
const STRIPE_CHECKOUT_URL = 'https://api.stripe.com/v1/checkout/sessions';

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

/* ── Encode object as application/x-www-form-urlencoded (Stripe's format) ── */
function toFormEncoded(obj, prefix) {
  const parts = [];

  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}[${key}]` : key;

    if (value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value)) {
      parts.push(toFormEncoded(value, fullKey));
    } else if (Array.isArray(value)) {
      value.forEach((item, i) => {
        if (typeof item === 'object' && item !== null) {
          parts.push(toFormEncoded(item, `${fullKey}[${i}]`));
        } else {
          parts.push(`${encodeURIComponent(`${fullKey}[]`)}=${encodeURIComponent(item)}`);
        }
      });
    } else {
      parts.push(`${encodeURIComponent(fullKey)}=${encodeURIComponent(value)}`);
    }
  }

  return parts.join('&');
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
    projectTitle,
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
  if (!projectTitle || typeof projectTitle !== 'string' || !projectTitle.trim()) {
    return respond(400, { error: 'projectTitle is required.' });
  }

  /* ── 4. Pull environment variables ── */
  const platformUrl = (process.env.PLATFORM_URL || 'https://kreddlo.space').replace(/\/$/, '');
  if (!platformUrl) {
    console.error('[create-stripe-subscription] PLATFORM_URL is not set.');
    return respond(500, { error: 'Platform URL is not configured. Please contact support.' });
  }

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) {
    console.error('[create-stripe-subscription] STRIPE_SECRET_KEY is not set.');
    return respond(500, { error: 'Stripe is not configured. Please contact support.' });
  }

  try {

    /* ── 5. Init Firebase and check platform settings ── */
    const db       = getDb();
    const settings = await getSettings(db);

    if (!settings.stripeEnabled) {
      return respond(403, { error: 'Stripe payments are not currently enabled.' });
    }

    /* ── 6. Verify the subscriptions doc still exists and is still pending ── */
    /*
     * create-subscription.js writes subscriptions/{subscriptionId} before
     * calling us, so we can trust the amount there rather than blindly trusting
     * the amount passed in the body (which came from create-subscription anyway,
     * but defense-in-depth is good).
     */
    const subSnap = await db.collection('subscriptions').doc(subscriptionId.trim()).get();
    if (!subSnap.exists) {
      return respond(404, { error: 'Subscription record not found.' });
    }
    const subDoc = subSnap.data();

    // Use the server-side amount from Firestore as the authoritative value
    const amount = Number(subDoc.price || clientAmount);
    if (!amount || amount <= 0) {
      return respond(400, { error: 'Subscription has no valid price set.' });
    }

    /* ── 7. Build the Checkout Session payload ── */
    /*
     * mode: 'payment' — single one-time payment that unlocks the Pro plan
     * for the chosen billing period. Recurring billing is handled by our
     * scheduled-subscriptions.js function which checks premiumEndDate.
     *
     * Metadata is forwarded to stripe-webhook.js which reads
     * payment_purpose: 'pro_upgrade' to upgrade the user's Firestore doc.
     */
    const metadataFields = {
      payment_purpose: 'pro_upgrade',
      subscriptionId:  subscriptionId.trim(),
      uid:             uid.trim(),
    };

    // Merge any additional metadata passed from create-subscription.js
    if (clientMetadata && typeof clientMetadata === 'object') {
      Object.assign(metadataFields, clientMetadata);
    }

    // Stripe metadata values must all be strings
    const stripeMetadata = {};
    for (const [k, v] of Object.entries(metadataFields)) {
      stripeMetadata[`metadata[${k}]`] = String(v);
    }

    const sessionParams = {
      'payment_method_types[]':                                    'card',
      'mode':                                                      'payment',
      'line_items[0][price_data][currency]':                       'usd',
      'line_items[0][price_data][product_data][name]':             projectTitle.trim(),
      'line_items[0][price_data][product_data][description]':      description.trim(),
      'line_items[0][price_data][unit_amount]':                    Math.round(amount * 100),
      'line_items[0][quantity]':                                   1,
      'success_url': `${platformUrl}/pricing.html?sub=success&subscriptionId=${encodeURIComponent(subscriptionId.trim())}`,
      'cancel_url':  `${platformUrl}/pricing.html?sub=cancel`,
      ...stripeMetadata,
    };

    // Pre-fill the subscriber's email on Stripe checkout if provided
    if (buyerEmail && typeof buyerEmail === 'string' && buyerEmail.includes('@')) {
      sessionParams['customer_email'] = buyerEmail.trim().toLowerCase();
    }

    /* ── 8. Call the Stripe API ── */
    let stripeRes;
    try {
      stripeRes = await fetch(STRIPE_CHECKOUT_URL, {
        method:  'POST',
        headers: {
          'Authorization': `Bearer ${stripeKey}`,
          'Content-Type':  'application/x-www-form-urlencoded',
        },
        body: toFormEncoded(sessionParams),
      });
    } catch (networkErr) {
      console.error('[create-stripe-subscription] Network error reaching Stripe:', networkErr);
      return respond(502, { error: 'Could not reach the payment service. Please try again.' });
    }

    /* ── 9. Handle the Stripe response ── */
    let stripeData;
    try {
      stripeData = await stripeRes.json();
    } catch {
      console.error('[create-stripe-subscription] Stripe returned non-JSON, status:', stripeRes.status);
      return respond(502, { error: 'Unexpected response from payment service.' });
    }

    if (!stripeRes.ok) {
      console.error('[create-stripe-subscription] Stripe API error:', {
        status:  stripeRes.status,
        payload: stripeData,
      });
      const detail = stripeData?.error?.message || 'Unknown error from payment service.';
      return respond(502, { error: `Payment service error: ${detail}` });
    }

    const checkoutUrl = stripeData.url;
    const sessionId   = stripeData.id;

    if (!checkoutUrl) {
      console.error('[create-stripe-subscription] Stripe response missing url:', stripeData);
      return respond(502, { error: 'Payment service did not return a checkout URL.' });
    }

    console.log(
      `[create-stripe-subscription] Session created — subscriptionId: ${subscriptionId}, ` +
      `uid: ${uid}, amount: $${amount} USD, sessionId: ${sessionId}`
    );

    /* ── 10. Return success ── */
    return respond(200, { checkoutUrl, sessionId });

  } catch (err) {
    console.error('[create-stripe-subscription] Unhandled error:', err);
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
