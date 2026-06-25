/**
 * Netlify Function: create-crypto-payment.js
 * Path: netlify/functions/create-crypto-payment.js
 *
 * Creates a NOWPayments hosted invoice and returns the invoice URL so the
 * frontend can redirect the buyer to complete payment in any crypto.
 *
 * Called from two contexts:
 *   1. Browser (buyer-dashboard.html, buyer-projects.html, profile.html) — a
 *      signed-in buyer paying for a project. Auth: Firebase ID token in the
 *      Authorization header (verified via verifyCaller).
 *   2. create-subscription.js (server-to-server) — initiating a Pro plan
 *      crypto payment. Auth: x-internal-secret header.
 *
 * orderId routing:
 *   - Starts with "sub_" → Pro upgrade; amount read from subscriptions/{orderId}
 *   - Anything else      → Project payment; amount read from projects/{orderId}
 *
 * Environment variables required:
 *   NOWPAYMENTS_API_KEY      — your NOWPayments API key
 *   PLATFORM_URL             — your live domain, e.g. https://kreddlo.space
 *   FIREBASE_SERVICE_ACCOUNT — full service account JSON
 *   INTERNAL_FUNCTION_SECRET — shared secret for server-to-server calls
 *
 * Expected request body (JSON):
 *   {
 *     orderId:     string   — Firestore project doc ID or subscriptions doc ID
 *     amount:      number   — ignored (server reads authoritative value from Firestore)
 *     description: string   — shown on the NOWPayments checkout page
 *     buyerEmail:  string?  — optional, pre-fills email on checkout
 *   }
 *
 * Success response (200):
 *   { invoiceUrl: "https://nowpayments.io/payment/...", checkoutUrl: same }
 *
 * Error response (4xx / 5xx):
 *   { error: "human-readable message" }
 */

const NOWPAYMENTS_INVOICE_ENDPOINT = 'https://api.nowpayments.io/v1/invoice';

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore }                 = require('firebase-admin/firestore');
const { verifyCaller }                 = require('./_verify-auth');

/* ── Firebase Admin — lazy singleton ── */
let _db = null;
function getDb() {
  if (_db) return _db;
  let serviceAccount;
  try { serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}'); }
  catch { throw new Error('FIREBASE_SERVICE_ACCOUNT is not valid JSON.'); }
  if (!getApps().length) { initializeApp({ credential: cert(serviceAccount) }); }
  _db = getFirestore();
  return _db;
}

exports.handler = async (event) => {

  /* ── 1. Only allow POST ── */
  if (event.httpMethod !== 'POST') {
    return respond(405, { error: 'Method not allowed.' });
  }

  /* ── 2. Verify caller — internal secret OR authenticated user ── */
  const incomingSecret = event.headers['x-internal-secret'] || event.headers['X-Internal-Secret'] || '';
  const expectedSecret = process.env.INTERNAL_FUNCTION_SECRET || '';
  const isTrustedInternal = !!expectedSecret && incomingSecret === expectedSecret;

  if (!isTrustedInternal) {
    // Browser path: require a valid Firebase ID token
    const callerUid = await verifyCaller(event);
    if (!callerUid) {
      return respond(401, { error: 'Unauthorized. Please log in again.' });
    }
  }

  /* ── 3. Parse and validate the request body ── */
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return respond(400, { error: 'Invalid JSON in request body.' });
  }

  const { orderId, description, buyerEmail } = body;

  if (!orderId || typeof orderId !== 'string' || orderId.trim() === '') {
    return respond(400, { error: 'orderId is required.' });
  }
  if (!description || typeof description !== 'string' || description.trim() === '') {
    return respond(400, { error: 'description is required.' });
  }

  /* ── 4. Pull environment variables ── */
  const apiKey      = process.env.NOWPAYMENTS_API_KEY;
  const platformUrl = (process.env.PLATFORM_URL || 'https://kreddlo.space').replace(/\/$/, '');

  if (!apiKey) {
    console.error('NOWPAYMENTS_API_KEY environment variable is not set.');
    return respond(500, { error: 'Payment service is not configured. Please contact support.' });
  }
  if (!platformUrl) {
    console.error('PLATFORM_URL environment variable is not set.');
    return respond(500, { error: 'Platform URL is not configured. Please contact support.' });
  }

  /* ── 5. Read authoritative amount from Firestore — ignore client-supplied value ── */
  // Route by orderId prefix: "sub_" = Pro subscription, anything else = project payment.
  let amount;
  let successUrl;
  let cancelUrl;

  try {
    const db = getDb();
    const isSubscription = orderId.trim().startsWith('sub_');

    if (isSubscription) {
      /* ── Pro upgrade path ── */
      const subSnap = await db.collection('subscriptions').doc(orderId.trim()).get();
      if (!subSnap.exists) {
        return respond(404, { error: 'Subscription record not found.' });
      }
      const subDoc = subSnap.data();
      amount = Number(subDoc.price || 0);
      if (!amount || amount <= 0) {
        return respond(400, { error: 'Subscription has no valid price set.' });
      }
      successUrl = `${platformUrl}/pricing.html?sub=success&subscriptionId=${encodeURIComponent(orderId.trim())}&method=crypto`;
      cancelUrl  = `${platformUrl}/pricing.html?sub=cancel`;

    } else {
      /* ── Project payment path ── */
      const projectSnap = await db.collection('projects').doc(orderId.trim()).get();
      if (!projectSnap.exists) {
        return respond(404, { error: 'Project not found.' });
      }
      const projectDoc = projectSnap.data();
      amount = Number(projectDoc.totalAmount || projectDoc.budget || projectDoc.amount || 0);
      if (!amount || amount <= 0) {
        return respond(400, { error: 'Project has no valid payment amount set.' });
      }

      /* freelancerSigned guard: block payment until the freelancer has accepted */
      if (projectDoc.freelancerSigned !== true) {
        return respond(403, { error: 'Waiting for the freelancer to accept this contract before payment can be made.' });
      }

      /* KYC guard: verify the freelancer is verified before accepting payment */
      const freelancerUid = projectDoc.freelancerUid || projectDoc.sellerUid || null;
      if (freelancerUid) {
        const freelancerSnap = await db.collection('users').doc(freelancerUid).get();
        if (freelancerSnap.exists && freelancerSnap.data().kycStatus !== 'verified') {
          return respond(403, { error: 'This freelancer is not yet verified. Payment cannot be accepted at this time.' });
        }
      }

      successUrl = `${platformUrl}/buyer-payments.html?payment=success&orderId=${encodeURIComponent(orderId.trim())}`;
      cancelUrl  = `${platformUrl}/buyer-payments.html?payment=cancelled&orderId=${encodeURIComponent(orderId.trim())}`;
    }
  } catch (dbErr) {
    console.error('[create-crypto-payment] Firestore read failed:', dbErr.message);
    return respond(500, { error: 'Could not verify payment amount. Please try again.' });
  }

  /* ── 6. Build the NOWPayments invoice payload ── */
  const invoicePayload = {
    price_amount:   amount,
    price_currency: 'usd',

    order_id:          orderId.trim(),
    order_description: description.trim().substring(0, 500),

    is_fixed_rate: false,

    success_url:      successUrl,
    cancel_url:       cancelUrl,
    ipn_callback_url: `${platformUrl}/.netlify/functions/nowpayments-webhook`,
  };

  if (buyerEmail && typeof buyerEmail === 'string' && buyerEmail.includes('@')) {
    invoicePayload.customer_email = buyerEmail.trim().toLowerCase();
  }

  /* ── 7. Call the NOWPayments API ── */
  let nowResponse;
  try {
    nowResponse = await fetch(NOWPAYMENTS_INVOICE_ENDPOINT, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key':    apiKey,
      },
      body: JSON.stringify(invoicePayload),
    });
  } catch (networkError) {
    console.error('Network error reaching NOWPayments:', networkError);
    return respond(502, { error: 'Could not reach the payment service. Please try again.' });
  }

  /* ── 8. Handle the NOWPayments response ── */
  let nowData;
  try {
    nowData = await nowResponse.json();
  } catch {
    console.error('NOWPayments returned non-JSON response, status:', nowResponse.status);
    return respond(502, { error: 'Unexpected response from payment service.' });
  }

  if (!nowResponse.ok) {
    console.error('NOWPayments API error:', { status: nowResponse.status, payload: nowData });
    const detail = nowData?.message || nowData?.error || 'Unknown error from payment service.';
    return respond(502, { error: `Payment service error: ${detail}` });
  }

  const invoiceUrl = nowData.invoice_url;

  if (!invoiceUrl) {
    console.error('NOWPayments response missing invoice_url:', nowData);
    return respond(502, { error: 'Payment service did not return a checkout URL.' });
  }

  /* ── 9. Return the invoice URL to the caller ── */
  console.log(`Invoice created — orderId: ${orderId}, amount: $${amount} USD, invoiceId: ${nowData.id}`);

  return respond(200, {
    checkoutUrl: invoiceUrl, // frontend pages expect checkoutUrl
    invoiceUrl,              // kept for backward-compatibility
    invoiceId: nowData.id,
  });
};


/* ── Utility: build a Netlify function response ── */
function respond(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*', // tighten to your domain in production
    },
    body: JSON.stringify(body),
  };
}
