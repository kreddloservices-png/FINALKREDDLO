/**
 * Netlify Function: create-stripe-payment.js
 * Path: netlify/functions/create-stripe-payment.js
 *
 * Creates a Stripe Checkout Session for a Kreddlo project payment.
 * Redirects the buyer to the Stripe-hosted checkout page where they
 * can pay by card (Visa, Mastercard, Amex, UnionPay, JCB, iDEAL,
 * Bancontact, Giropay, EPS, Przelewy24, Sofort, BLIK, Boleto, and
 * others auto-enabled by Stripe based on buyer country and currency).
 *
 * Flow:
 *  1. Validate request body
 *  2. Init Firebase and load platform settings
 *  3. Guard: stripeEnabled must be true in settings
 *  4. Guard: STRIPE_SECRET_KEY must be set
 *  5. If the project's currency is one Stripe cannot charge in directly
 *     (NGN/UGX/RWF/XOF/TZS), convert the amount to USD via a cached
 *     Frankfurter rate + platformFxBuffer, and record originalAmount/
 *     originalCurrency/chargedAmount/chargedCurrency on the project doc
 *  6. Build and POST the Checkout Session to Stripe
 *  7. Return { checkoutUrl, sessionId } to the frontend
 *
 * Environment variables required:
 *   STRIPE_SECRET_KEY        — Stripe secret key (sk_live_... or sk_test_...)
 *   FIREBASE_SERVICE_ACCOUNT — full service account JSON as one-line string
 *   PLATFORM_URL             — live domain, e.g. https://kreddlo.space (no trailing slash)
 *
 * Expected POST body (JSON):
 *   {
 *     orderId:      string   — Firestore project document ID
 *     amount:       number   — payment amount in USD (e.g. 250)
 *     description:  string   — shown on the Stripe checkout page
 *     buyerEmail:   string?  — optional, pre-fills email on checkout
 *     projectTitle: string   — shown as the line item name
 *   }
 *
 * Success response (200):
 *   { checkoutUrl: "https://checkout.stripe.com/...", sessionId: "cs_..." }
 *
 * Error responses:
 *   403 — Stripe payments are not currently enabled
 *   500 — Stripe is not configured / unhandled error
 *   502 — Stripe API error
 */

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore }                 = require('firebase-admin/firestore');
const { getSettings }                  = require('./get-settings');

/* ── Stripe Checkout Sessions endpoint ── */
const STRIPE_CHECKOUT_URL = 'https://api.stripe.com/v1/checkout/sessions';
const FRANKFURTER_URL     = 'https://api.frankfurter.app/latest';

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

/* ── Encode object as application/x-www-form-urlencoded ── */
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

/* ── Currencies Stripe cannot charge in ── */
// Same set used in create-product-order.js (Fix C). buyer-projects.html always
// prefers Flutterwave for these currencies when Flutterwave is enabled, so this
// function only sees one of them if Flutterwave is disabled/unavailable. Rather
// than letting the Stripe API reject the session, we convert to USD below.
const STRIPE_UNSUPPORTED_CURRENCIES = new Set(['NGN', 'UGX', 'RWF', 'XOF', 'TZS']);

/* ── Exchange rate cache (Firestore-backed, 1-hour TTL) ── */
// Shares the same config/exchangeRates cache document as create-product-order.js,
// so a rate fetched by one function is reused by the other within the TTL window.
const RATE_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Returns the USD conversion rate for `currency`.
 * 1. Checks Firestore config/exchangeRates for a cached rate younger than 1 hour.
 * 2. If stale or missing, fetches fresh rates from Frankfurter, writes them to
 *    Firestore, then returns the needed rate.
 * 3. If Frankfurter is unreachable, returns the stale cached rate if one exists,
 *    otherwise returns null (caller should fail safe rather than charge wrong amount).
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} currency  e.g. "NGN"
 * @returns {Promise<number|null>}  rate to multiply by to get USD, or null on total failure
 */
async function getUsdRate(db, currency) {
  if (currency === 'USD') return 1;

  const cacheRef = db.collection('config').doc('exchangeRates');

  // ── 1. Try cache ──
  try {
    const snap = await cacheRef.get();
    if (snap.exists) {
      const cached = snap.data();
      const ageMs  = Date.now() - (cached.updatedAt || 0);
      if (ageMs < RATE_CACHE_TTL_MS && cached.rates?.[currency]) {
        return cached.rates[currency]; // fresh hit — no network call needed
      }
    }
  } catch (cacheReadErr) {
    console.warn('[create-stripe-payment] Cache read failed:', cacheReadErr.message);
  }

  // ── 2. Fetch fresh rates from Frankfurter ──
  try {
    // Fetch all major rates in one call so we can cache them all at once
    const res = await fetch(`${FRANKFURTER_URL}?from=USD`);
    if (!res.ok) throw new Error(`Frankfurter HTTP ${res.status}`);
    const data = await res.json();

    // data.rates has currency → USD-denominated price (i.e. 1 USD = X currency)
    // We need the inverse: 1 X = ? USD
    const rates = {};
    for (const [cur, usdPerCur] of Object.entries(data.rates || {})) {
      rates[cur] = 1 / usdPerCur; // convert to "1 unit of cur = ? USD"
    }

    // Persist to Firestore so future calls (from this or create-product-order.js) skip the network
    try {
      await cacheRef.set({ rates, updatedAt: Date.now() });
    } catch (writeErr) {
      console.warn('[create-stripe-payment] Cache write failed (non-fatal):', writeErr.message);
    }

    return rates[currency] ?? null;
  } catch (fetchErr) {
    console.warn('[create-stripe-payment] Frankfurter fetch failed:', fetchErr.message);

    // ── 3. Stale fallback — better than blocking the payment entirely ──
    try {
      const snap = await cacheRef.get();
      if (snap.exists && snap.data()?.rates?.[currency]) {
        const staleAgeMs  = Date.now() - (snap.data().updatedAt || 0);
        const MAX_STALE_MS = 24 * 60 * 60 * 1000; // 24 hours — reject rates older than this
        if (staleAgeMs > MAX_STALE_MS) {
          console.error('[create-stripe-payment] Stale rate for', currency, 'is too old (' + Math.round(staleAgeMs / 3600000) + ' hrs) — rejecting to avoid FX debt.');
          return null;
        }
        console.warn('[create-stripe-payment] Using stale cached rate for', currency, '(age: ' + Math.round(staleAgeMs / 60000) + ' min)');
        return snap.data().rates[currency];
      }
    } catch (_) { /* ignore */ }

    return null; // total failure — caller will block rather than risk a bad charge
  }
}

/* ══════════════════════════════════════════════════════════════
   HANDLER
══════════════════════════════════════════════════════════════ */
exports.handler = async (event) => {

  /* ── 1. Accept POST only ── */
  if (event.httpMethod !== 'POST') {
    return respond(405, { error: 'Method not allowed.' });
  }

  /* ── 2. Parse and validate request body ── */
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return respond(400, { error: 'Invalid JSON in request body.' });
  }

  const { orderId, amount: _clientAmount, description, buyerEmail, projectTitle, currency: clientCurrency } = body;

  if (!orderId || typeof orderId !== 'string' || orderId.trim() === '') {
    return respond(400, { error: 'orderId is required.' });
  }
  if (!description || typeof description !== 'string' || description.trim() === '') {
    return respond(400, { error: 'description is required.' });
  }
  if (!projectTitle || typeof projectTitle !== 'string' || projectTitle.trim() === '') {
    return respond(400, { error: 'projectTitle is required.' });
  }

  /* ── 3. Pull environment variables ── */
  const platformUrl = (process.env.PLATFORM_URL || 'https://kreddlo.space').replace(/\/$/, '');
  if (!platformUrl) {
    console.error('PLATFORM_URL environment variable is not set.');
    return respond(500, { error: 'Platform URL is not configured. Please contact support.' });
  }

  try {

    /* ── 4. Init Firebase and load platform settings ── */
    const db       = getDb();
    const settings = await getSettings(db);

    /* ── FIX #2: Read authoritative amount from Firestore — ignore client-supplied value ── */
    const projectSnap = await db.collection('projects').doc(orderId.trim()).get();
    if (!projectSnap.exists) {
      return respond(404, { error: 'Project not found.' });
    }
    const projectDoc = projectSnap.data();
    const rawAmount = Number(projectDoc.totalAmount || projectDoc.budget || projectDoc.amount || 0);
    if (!rawAmount || rawAmount <= 0) {
      return respond(400, { error: 'Project has no valid payment amount set.' });
    }
    // Read currency from project doc too — not from the client
    const rawCurrency = ((projectDoc.currency || clientCurrency || 'USD')).toUpperCase();

    // `amount`/`paymentCurrency` may be overwritten below if rawCurrency is one
    // Stripe cannot charge in directly (see STRIPE_UNSUPPORTED_CURRENCIES block).
    let amount          = rawAmount;
    let paymentCurrency = rawCurrency.toLowerCase();

    /* ── freelancerSigned guard: block payment until the freelancer has accepted ── */
    if (projectDoc.freelancerSigned !== true) {
      return respond(403, { error: 'Waiting for the freelancer to accept this contract before payment can be made.' });
    }

    /* ── KYC guard: verify the freelancer is verified before accepting payment ── */
    const freelancerUid = projectDoc.freelancerUid || projectDoc.sellerUid || null;
    if (freelancerUid) {
      const freelancerSnap = await db.collection('users').doc(freelancerUid).get();
      if (freelancerSnap.exists && freelancerSnap.data().kycStatus !== 'verified') {
        return respond(403, { error: 'This freelancer is not yet verified. Payment cannot be accepted at this time.' });
      }
    }

    /* ── 5. Guard: Stripe must be enabled in admin settings ── */
    if (!settings.stripeEnabled) {
      return respond(403, { error: 'Stripe payments are not currently enabled.' });
    }

    /* ── 6. Guard: STRIPE_SECRET_KEY must be present ── */
    const stripeKey = process.env.STRIPE_SECRET_KEY;
    if (!stripeKey) {
      console.error('STRIPE_SECRET_KEY environment variable is not set.');
      return respond(500, { error: 'Stripe is not configured. Please contact support.' });
    }

    /* ── 6b. Currency conversion: Stripe cannot charge in NGN/UGX/RWF/XOF/TZS ── */
    // Mirrors the Fix C pattern in create-product-order.js. buyer-projects.html
    // already prefers Flutterwave for these currencies when it's enabled, so we
    // only reach here when Flutterwave is disabled/unavailable. Rather than
    // sending an unsupported currency straight to Stripe (hard API error), we
    // convert to USD using a cached Frankfurter rate plus the platform's FX
    // buffer (config/platform.platformFxBuffer — same setting Fix C uses).
    const originalAmount   = rawAmount;
    const originalCurrency = rawCurrency; // upper-case, e.g. "NGN"

    if (STRIPE_UNSUPPORTED_CURRENCIES.has(originalCurrency)) {
      const rate = await getUsdRate(db, originalCurrency);
      if (!rate) {
        return respond(500, { error: 'Could not fetch exchange rate for currency conversion. Please try again.' });
      }

      let fxBuffer = 0;
      if (typeof settings.platformFxBuffer === 'number' && settings.platformFxBuffer > 0) {
        fxBuffer = settings.platformFxBuffer; // e.g. 1.5 = 1.5%
      }

      const bufferedRate = rate * (1 + fxBuffer / 100);
      amount             = Math.ceil(originalAmount * bufferedRate * 100) / 100; // round up, never short-charge
      paymentCurrency    = 'usd';

      console.log(
        `[create-stripe-payment] Currency conversion for project ${orderId}: ` +
        `${originalAmount} ${originalCurrency} → ${amount} USD (rate: ${rate}, fxBuffer: ${fxBuffer}%, bufferedRate: ${bufferedRate})`
      );

      // Record the original asking price and the actual charged amount/currency
      // on the project doc so there's an audit trail, same shape as the
      // chargedAmount/chargedCurrency fields stripe-webhook.js writes once
      // payment is confirmed.
      //
      // This field is NOT cosmetic — stripe-webhook.js's fee/escrow
      // calculation reads it back to credit the freelancer from the
      // pre-buffer price (Fix C-3). If this write is silently dropped, the
      // webhook falls back to the buffered charge amount and the platform's
      // FX buffer leaks into the freelancer's payout — the exact bug Fix C-3
      // closes. So this gets one retry before giving up. Still non-fatal
      // after that: checkout proceeds either way, since the buyer hasn't
      // been charged yet at this point and failing checkout over a logging
      // write would lose the sale for no benefit. A failure here is now
      // logged as an error (not a warning) so it's actually noticed.
      let originalAmountSaved = false;
      for (let attempt = 1; attempt <= 2 && !originalAmountSaved; attempt++) {
        try {
          await projectSnap.ref.update({
            originalAmount:   originalAmount,
            originalCurrency: originalCurrency,
            chargedAmount:    amount,
            chargedCurrency:  paymentCurrency.toUpperCase(),
          });
          originalAmountSaved = true;
        } catch (docErr) {
          if (attempt === 2) {
            console.error(
              `[create-stripe-payment] CRITICAL: could not store originalAmount for project ${orderId} ` +
              `after retry — webhook will fall back to buffered charge amount for fee calc: ${docErr.message}`
            );
          } else {
            console.warn(`[create-stripe-payment] originalAmount save failed (attempt ${attempt}), retrying:`, docErr.message);
          }
        }
      }
    }

    /* ── 7. Build the Checkout Session payload ── */
    /*
     * Stripe's API uses application/x-www-form-urlencoded, not JSON.
     * payment_method_types[]: card enables all card types Stripe supports
     * globally. Additional methods (iDEAL, Bancontact, Giropay, EPS,
     * Przelewy24, Sofort, BLIK, Boleto, etc.) are automatically enabled
     * by Stripe based on the buyer's country and the session currency.
     */
    const sessionParams = {
      'payment_method_types[]': 'card',
      'mode':                   'payment',
      'line_items[0][price_data][currency]':                    paymentCurrency,
      'line_items[0][price_data][product_data][name]':          projectTitle.trim(),
      'line_items[0][price_data][product_data][description]':   description.trim(),
      'line_items[0][price_data][unit_amount]':                 Math.round(amount * 100), // Stripe uses cents
      'line_items[0][quantity]':                                1,
      'metadata[order_id]':                                     orderId.trim(),
      'metadata[platform]':                                     'kreddlo',
      'success_url': `${platformUrl}/buyer-payments.html?payment=success&orderId=${encodeURIComponent(orderId)}&method=stripe`,
      'cancel_url':  `${platformUrl}/buyer-payments.html?payment=cancelled&orderId=${encodeURIComponent(orderId)}`,
    };

    // Pre-fill the buyer's email on the Stripe checkout page if provided
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
      console.error('Network error reaching Stripe:', networkErr);
      return respond(502, { error: 'Could not reach the payment service. Please try again.' });
    }

    /* ── 9. Handle the Stripe response ── */
    let stripeData;
    try {
      stripeData = await stripeRes.json();
    } catch {
      console.error('Stripe returned non-JSON response, status:', stripeRes.status);
      return respond(502, { error: 'Unexpected response from payment service.' });
    }

    if (!stripeRes.ok) {
      // Log full error server-side; return a human-readable message to the client
      console.error('Stripe API error:', {
        status:  stripeRes.status,
        payload: stripeData,
      });
      const detail = stripeData?.error?.message || 'Unknown error from payment service.';
      return respond(502, { error: `Payment service error: ${detail}` });
    }

    const checkoutUrl = stripeData.url;
    const sessionId   = stripeData.id;

    if (!checkoutUrl) {
      console.error('Stripe response missing url field:', stripeData);
      return respond(502, { error: 'Payment service did not return a checkout URL.' });
    }

    console.log(`Stripe session created — orderId: ${orderId}, amount: ${amount} ${paymentCurrency.toUpperCase()}, sessionId: ${sessionId}`);

    /* ── 10. Return success ── */
    return respond(200, { checkoutUrl, sessionId });

  } catch (err) {
    console.error('[create-stripe-payment] Unhandled error:', err);
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
