/**
 * Netlify Function: create-product-order.js
 * Path: netlify/functions/create-product-order.js
 * BUILD MARKER: FEE-CHECK-v2
 *
 * Creates a product order and initiates the appropriate payment flow.
 *
 * Expected POST body (JSON):
 *   {
 *     productId:     string  — Firestore products document ID
 *     buyerEmail:    string  — buyer's email address
 *     buyerName:     string  — buyer's display name
 *     paymentMethod: string  — 'crypto' | 'stripe' | 'flutterwave'
 *   }
 *
 * Success response (200):
 *   { checkoutUrl: string, orderId: string }
 *
 * Environment variables required:
 *   FIREBASE_SERVICE_ACCOUNT — full service account JSON as one-line string
 *   PLATFORM_URL             — live domain, e.g. https://kreddlo.space (no trailing slash)
 *   NOWPAYMENTS_API_KEY      — required for crypto payments
 *   STRIPE_SECRET_KEY        — required for stripe payments
 *   FLW_SECRET_KEY           — required for flutterwave payments
 */

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue }     = require('firebase-admin/firestore');
const { getAuth }                      = require('firebase-admin/auth');
const { getSettings }                  = require('./get-settings');
const { verifyCaller }                 = require('./_verify-auth');
const { checkRateLimit }               = require('./_rate-limit');
const { sanitizeString, sanitizeEmail } = require('./_sanitize');

/* ── Payment API endpoints ── */
const NOWPAYMENTS_INVOICE_ENDPOINT = 'https://api.nowpayments.io/v1/invoice';
const STRIPE_CHECKOUT_URL          = 'https://api.stripe.com/v1/checkout/sessions';
const FLW_PAYMENT_URL              = 'https://api.flutterwave.com/v3/payments';
const FLW_API_BASE                 = 'https://api.flutterwave.com/v3';
const FRANKFURTER_URL              = 'https://api.frankfurter.app/latest';

/* ── Currencies Frankfurter/ECB does not price ──
   Frankfurter only covers ~31 ECB-tracked currencies and does not include
   NGN, UGX, RWF, XOF, or TZS — which happen to be exactly the currencies
   Stripe also can't charge in directly (see STRIPE_UNSUPPORTED_CURRENCIES
   below). For these, getUsdRate() uses Flutterwave's own rates endpoint
   instead, since Flutterwave already prices these currencies for the
   Flutterwave checkout flow elsewhere in this file. Previously these always
   fell through to Frankfurter, which silently returned null every time and
   caused Stripe checkout to fail with a 500 for any of these currencies. */
const FX_RATE_USE_FLUTTERWAVE = new Set(['NGN', 'UGX', 'RWF', 'XOF', 'TZS']);

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

/* ── Stripe form-encode helper ── */
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

/* ── Exchange rate cache (Firestore-backed, 1-hour TTL) ── */
const RATE_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Fetches the USD↔currency rate from Flutterwave's transfers/rates endpoint
 * and inverts it to "1 unit of currency = ? USD", matching getUsdRate's
 * return convention. Used only for currencies Frankfurter/ECB doesn't cover
 * (NGN, UGX, RWF, XOF, TZS) — same data source already proven working for
 * the Flutterwave USD→local-currency conversion further down this file.
 * Retries once on failure before giving up, since a single dropped request
 * shouldn't fail someone's checkout.
 *
 * @param {string} currency  e.g. "NGN"
 * @returns {Promise<number|null>}  1 unit of currency in USD, or null on failure
 */
async function getFlwUsdRate(currency) {
  const flwKey = process.env.FLW_SECRET_KEY;
  if (!flwKey) return null;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(
        `${FLW_API_BASE}/transfers/rates?amount=1&destination_currency=${currency}&source_currency=USD`,
        { headers: { Authorization: `Bearer ${flwKey}` } }
      );
      const data = await res.json().catch(() => ({}));
      const r = data?.data?.rate;
      if (r && !isNaN(Number(r)) && Number(r) > 0) {
        return 1 / Number(r); // FLW gives "units of currency per 1 USD" — invert it
      }
    } catch (err) {
      console.warn(`[create-product-order] Flutterwave rate fetch failed for ${currency} (attempt ${attempt + 1}):`, err.message);
    }
  }
  return null;
}

/**
 * Returns the USD conversion rate for `currency`.
 * 1. Checks Firestore config/exchangeRates for a cached rate younger than 1 hour.
 * 2. If stale or missing:
 *    - For NGN/UGX/RWF/XOF/TZS (currencies Frankfurter/ECB never has a rate
 *      for), fetches from Flutterwave's rates endpoint instead.
 *    - For every other currency, fetches fresh rates from Frankfurter as before.
 *    Either way, the result is cached to Firestore for future calls.
 * 3. If the live fetch fails, returns the stale cached rate if one exists,
 *    otherwise returns null (caller should skip the cap check rather than block).
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} currency  e.g. "NGN", "GBP"
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
    console.warn('[create-product-order] Cache read failed:', cacheReadErr.message);
  }

  // ── 2a. Currencies Frankfurter/ECB doesn't price — use Flutterwave instead ──
  if (FX_RATE_USE_FLUTTERWAVE.has(currency)) {
    const flwRate = await getFlwUsdRate(currency);
    if (flwRate !== null) {
      // merge:true — never wipes out the Frankfurter-sourced rates cached
      // under the same document by the branch below.
      try {
        await cacheRef.set({ rates: { [currency]: flwRate }, updatedAt: Date.now() }, { merge: true });
      } catch (writeErr) {
        console.warn('[create-product-order] Cache write failed (non-fatal):', writeErr.message);
      }
      return flwRate;
    }
    console.warn('[create-product-order] Flutterwave rate fetch failed for', currency, '— checking stale cache.');
  } else {
    // ── 2b. Fetch fresh rates from Frankfurter (unchanged from before) ──
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

      // Persist to Firestore so future calls skip the network. merge:true —
      // never wipes out Flutterwave-sourced rates (NGN/UGX/RWF/XOF/TZS)
      // cached under the same document by the branch above, since
      // Frankfurter's response never includes those currencies anyway.
      try {
        await cacheRef.set({ rates, updatedAt: Date.now() }, { merge: true });
      } catch (writeErr) {
        console.warn('[create-product-order] Cache write failed (non-fatal):', writeErr.message);
      }

      if (rates[currency] != null) return rates[currency];
    } catch (fetchErr) {
      console.warn('[create-product-order] Frankfurter fetch failed:', fetchErr.message);
    }
  }

  // ── 3. Stale fallback — better than blocking the order ──
  try {
    const snap = await cacheRef.get();
    if (snap.exists && snap.data()?.rates?.[currency]) {
      const staleAgeMs  = Date.now() - (snap.data().updatedAt || 0);
      const MAX_STALE_MS = 24 * 60 * 60 * 1000; // 24 hours — reject rates older than this
      if (staleAgeMs > MAX_STALE_MS) {
        console.error('[create-product-order] Stale rate for', currency, 'is too old (' + Math.round(staleAgeMs / 3600000) + ' hrs) — rejecting to avoid FX debt.');
        return null;
      }
      console.warn('[create-product-order] Using stale cached rate for', currency, '(age: ' + Math.round(staleAgeMs / 60000) + ' min)');
      return snap.data().rates[currency];
    }
  } catch (_) { /* ignore */ }

  return null; // total failure — caller will skip cap check / surface a clean error
}

/* ── Currencies Stripe cannot charge in ── */
// These are currencies from our supported African set that Stripe rejects.
// When an international buyer pays via Stripe for a product priced in one of
// these currencies, we convert the amount to USD before sending to Stripe.
const STRIPE_UNSUPPORTED_CURRENCIES = new Set(['NGN', 'UGX', 'RWF', 'XOF', 'TZS']);

/* ── Price cap check (uses cached rates) ── */
async function checkPriceCap(amount, currency, maxProductPriceUsd, db) {
  if (currency === 'USD') {
    return amount <= maxProductPriceUsd;
  }
  const rate = await getUsdRate(db, currency);
  if (rate === null) return true; // skip cap check if no rate available — don't block orders
  const usdEquivalent = amount * rate;
  return usdEquivalent <= maxProductPriceUsd;
}

/* ══════════════════════════════════════════════════════════════
   PAYMENT CREATORS
══════════════════════════════════════════════════════════════ */

async function createCryptoCheckout({ orderId, amount, productCurrency, description, buyerEmail, platformUrl }) {
  const apiKey = process.env.NOWPAYMENTS_API_KEY;
  if (!apiKey) throw new Error('NOWPAYMENTS_API_KEY is not set.');

  const payload = {
    price_amount:      amount,
    price_currency:    productCurrency.toLowerCase(),
    order_id:          orderId,
    order_description: description.trim().substring(0, 500),
    is_fixed_rate:     false,
    success_url: `${platformUrl}/buyer-payments.html?payment=success&orderId=${encodeURIComponent(orderId)}&method=crypto`,
    cancel_url:  `${platformUrl}/buyer-payments.html?payment=cancelled&orderId=${encodeURIComponent(orderId)}`,
    ipn_callback_url: `${platformUrl}/.netlify/functions/nowpayments-webhook`,
  };

  if (buyerEmail) payload.customer_email = buyerEmail.trim().toLowerCase();

  const res = await fetch(NOWPAYMENTS_INVOICE_ENDPOINT, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
    body:    JSON.stringify(payload),
  });

  const data = await res.json();
  if (!res.ok || !data.invoice_url) {
    throw new Error(data?.message || 'NOWPayments did not return an invoice URL.');
  }

  return { checkoutUrl: data.invoice_url, paymentRef: data.id };
}

async function createStripeCheckout({ orderId, amount, productCurrency, description, buyerEmail, productTitle, platformUrl }) {
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) throw new Error('STRIPE_SECRET_KEY is not set.');

  const sessionParams = {
    'automatic_payment_methods[enabled]':                        'true',
    'mode':                                                      'payment',
    'line_items[0][price_data][currency]':                       productCurrency.toLowerCase(),
    'line_items[0][price_data][product_data][name]':             productTitle,
    'line_items[0][price_data][product_data][description]':      description,
    'line_items[0][price_data][unit_amount]':                    Math.round(amount * 100),
    'line_items[0][quantity]':                                   1,
    'metadata[order_id]':                                        orderId,
    'metadata[platform]':                                        'kreddlo',
    'success_url': `${platformUrl}/buyer-payments.html?payment=success&orderId=${encodeURIComponent(orderId)}&method=stripe`,
    'cancel_url':  `${platformUrl}/buyer-payments.html?payment=cancelled&orderId=${encodeURIComponent(orderId)}`,
  };

  if (buyerEmail) sessionParams['customer_email'] = buyerEmail.trim().toLowerCase();

  const res = await fetch(STRIPE_CHECKOUT_URL, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${stripeKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    toFormEncoded(sessionParams),
  });

  const data = await res.json();
  if (!res.ok || !data.url) {
    throw new Error(data?.error?.message || 'Stripe did not return a checkout URL.');
  }

  return { checkoutUrl: data.url, paymentRef: data.id };
}

async function createFlutterwaveCheckout({ orderId, amount, productCurrency, description, buyerEmail, productTitle, platformUrl }) {
  const flwKey = process.env.FLW_SECRET_KEY;
  if (!flwKey) throw new Error('FLW_SECRET_KEY is not set.');
  if (!buyerEmail) throw new Error('buyerEmail is required for Flutterwave payments.');

  const paymentRef = `kreddlo-${orderId}-${Date.now()}`;

  const payload = {
    tx_ref:          paymentRef,
    amount:          amount,                // Flutterwave accepts the decimal amount directly
    currency:        productCurrency,
    redirect_url:    `${platformUrl}/buyer-payments.html?payment=success&orderId=${encodeURIComponent(orderId)}&method=flutterwave`,
    payment_options: 'card,banktransfer,ussd,mobilemoney,account,barter,nqr',
    customer: {
      email: buyerEmail.trim().toLowerCase(),
    },
    customizations: {
      title:       productTitle,
      description: description,
      logo:        `${platformUrl}/assets/kreddlo-logo.png`,
    },
    meta: { orderId, productTitle, platform: 'kreddlo' },
  };

  const res = await fetch(FLW_PAYMENT_URL, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${flwKey}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload),
  });

  const data = await res.json();
  if (!res.ok || data.status !== 'success' || !data?.data?.link) {
    throw new Error(data?.message || 'Flutterwave did not return a checkout URL.');
  }

  return { checkoutUrl: data.data.link, paymentRef };
}

/* ══════════════════════════════════════════════════════════════
   HANDLER
══════════════════════════════════════════════════════════════ */
exports.handler = async (event) => {

  if (event.httpMethod !== 'POST') {
    return respond(405, { error: 'Method not allowed.' });
  }

  /* ── Fix E — capture the logged-in buyer's verified UID up front, if any.
     Previously this function never looked at the Authorization header at
     all, so even a fully logged-in buyer was treated as an anonymous guest:
     buyerUid only got attached afterward via auth.getUserByEmail(typedEmail),
     wrapped in a non-blocking try/catch. Any mismatch between the typed
     email and the logged-in account's real email (or any transient lookup
     failure) meant the purchase was silently never linked to the buyer's
     real account, and buyer-purchases.html (which queries by buyerUid) would
     never show it.

     This is intentionally non-blocking: an invalid/expired token does not
     fail the request — it just falls back to the existing guest-checkout
     behavior below, exactly as before. Guest checkout with no Authorization
     header at all is completely unaffected. ── */
  let verifiedCallerUid = null;
  const authHeader = event.headers['authorization'] || event.headers['Authorization'] || '';
  if (authHeader.startsWith('Bearer ')) {
    try {
      verifiedCallerUid = await verifyCaller(event);
    } catch (err) {
      console.warn('[create-product-order] Caller token present but verification failed, proceeding as guest:', err.message);
    }
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return respond(400, { error: 'Invalid JSON in request body.' });
  }

  const { productId, buyerEmail: rawBuyerEmail, buyerName: rawBuyerName, paymentMethod, affiliateRef, buyerTimezone } = body;

  // Sanitize free-text fields before validation and downstream use
  const buyerEmail = sanitizeEmail(rawBuyerEmail);
  const buyerName  = sanitizeString(rawBuyerName, 80);
  const note       = sanitizeString(body.note, 2000);

  if (!productId || typeof productId !== 'string') {
    return respond(400, { error: 'productId is required.' });
  }
  if (!buyerEmail) {
    return respond(400, { error: 'buyerEmail is required and must be a valid email address.' });
  }
  if (!buyerName) {
    return respond(400, { error: 'buyerName is required.' });
  }
  if (!['crypto', 'stripe', 'flutterwave'].includes(paymentMethod)) {
    return respond(400, { error: 'paymentMethod must be crypto, stripe, or flutterwave.' });
  }

  const platformUrl = (process.env.PLATFORM_URL || 'https://kreddlo.space').replace(/\/$/, '');
  if (!platformUrl) {
    return respond(500, { error: 'Platform URL is not configured.' });
  }

  try {
    const db = getDb();

    /* ── Server-side rate limit: 20 order attempts per 5 minutes per IP ──
       Keyed on IP rather than uid because product orders allow guest
       checkout — there may be no uid. Prevents automated purchase-flow
       probing or payment-gateway enumeration from a single source. */
    const clientIp = (
      event.headers['x-forwarded-for'] || event.headers['client-ip'] || 'unknown'
    ).split(',')[0].trim();
    const rl = await checkRateLimit(db, `cpo::${clientIp}`, 20, 300);
    if (!rl.allowed) {
      return respond(429, { error: rl.error, retryAfter: rl.retryAfter });
    }

    /* FIX: suspended accounts could still transact via a live session even
       though login.html now blocks sign-in. Only applies when the buyer is
       actually logged in (verifiedCallerUid set) — guest checkout has no
       account to check and is untouched. */
    if (verifiedCallerUid) {
      const callerSnap = await db.collection('users').doc(verifiedCallerUid).get();
      if (callerSnap.exists && callerSnap.data().suspended === true) {
        return respond(403, { error: 'Your account has been suspended. Please contact support for assistance.' });
      }
    }

    /* ── Fetch product ── */
    // FIX: this previously checked a boolean `active` field that products
    // never actually have (the real visibility flag is the `status` string
    // — 'active' | 'inactive' | 'draft' | 'removed_by_admin' | 'deleted',
    // same as every other page in the codebase checks). Because `active`
    // is always undefined, the old condition could never trigger, so a
    // deactivated, draft, deleted, or admin-removed product could still be
    // checked out and charged via a stale link or direct productId. Now
    // checks the real field.
    const productSnap = await db.collection('products').doc(productId).get();
    if (!productSnap.exists) {
      return respond(404, { error: 'Product not found or is no longer available.' });
    }
    const product = productSnap.data();
    if (['inactive', 'draft', 'deleted', 'removed_by_admin'].includes(product.status)) {
      return respond(404, { error: 'Product not found or is no longer available.' });
    }

    /* ── Determine currency and amount based on payment method ── */
    const productCurrency = (product.currency || 'USD').toUpperCase();

    let amount;
    if (paymentMethod === 'crypto') {
      amount = product.cryptoPrice || product.cardPrice || product.price;
    } else {
      amount = product.cardPrice || product.price;
    }

    if (!amount || amount <= 0) {
      return respond(400, { error: 'This product does not have a price set for the selected payment method.' });
    }

    /* ── Enforce price cap on backend ── */
    const settings = await getSettings(db);
    const withinCap = await checkPriceCap(amount, productCurrency, settings.maxProductPriceUsd || 1800, db);
    if (!withinCap) {
      return respond(400, { error: 'Product price exceeds the platform maximum.' });
    }

    /* ── Add platform fee on top of product price ──
       The buyer pays: amount + platformFee (fee is on top, not deducted from seller).
       The webhook then receives this total as confirmedAmount and calculates:
         platformFee  = confirmedAmount * (platformFeePercent / 100)
         sellerAmount = confirmedAmount - platformFee
       Which correctly credits the seller the original listed price net of rounding.
       We store the original listed amount/currency on the order for seller reference;
       the charge sent to the payment gateway includes the fee on top.
    ── */
    const platformFeePercent = typeof settings.platformFeePercent === 'number' ? settings.platformFeePercent : 2.5;
    // charge = amount / (1 - feePercent/100) so that after the webhook deducts
    // feePercent from the charge, the seller receives exactly the listed price.
    const chargeAmount = +(amount / (1 - platformFeePercent / 100)).toFixed(2);

    // ── FEE-MARKER v2 — unmissable log line, fires unconditionally right after
    // chargeAmount is computed. If this exact marker is absent from the logs
    // for a real request, the deployed function is not running this source file.
    console.log('===== KREDDLO-FEE-CHECK-v2 =====');
    console.log(`  productId:          ${productId}`);
    console.log(`  listed amount:       ${amount} ${productCurrency}`);
    console.log(`  platformFeePercent:  ${platformFeePercent}`);
    console.log(`  chargeAmount:        ${chargeAmount} ${productCurrency}`);
    console.log('=================================');

    // ── Hard guard: never let chargeAmount silently equal amount when a real
    // fee is configured. If this ever fires, something upstream (settings load,
    // a stale require cache, etc.) produced a 0% fee unexpectedly — fail loudly
    // instead of quietly under-charging.
    if (platformFeePercent > 0 && chargeAmount === amount) {
      console.error(
        `[create-product-order] FEE GUARD TRIPPED — chargeAmount equals listed amount ` +
        `despite platformFeePercent=${platformFeePercent}. Refusing to proceed. orderId would have been for product ${productId}.`
      );
      return respond(500, { error: 'Pricing calculation error. Please try again or contact support.' });
    }

    /* ── Sanitise and validate affiliateRef (optional) ── */
    const sanitisedRef = (typeof affiliateRef === 'string' && affiliateRef.trim().length > 0)
      ? affiliateRef.trim()
      : null;

    /* ── Create product-orders document ── */
    const orderRef = db.collection('product-orders').doc();
    const orderId  = orderRef.id;

    await orderRef.set({
      productId,
      sellerUid:      product.uid,
      buyerEmail:     buyerEmail,   // already lowercased by sanitizeEmail
      buyerName:      buyerName,    // already trimmed/stripped by sanitizeString
      // amount/currency = the total charged to the buyer (listed price + platform fee).
      // Webhooks deduct platformFeePercent from this to derive sellerAmount.
      amount:         chargeAmount,
      currency:       productCurrency,
      // Original list price/currency as the seller set it — never overwritten.
      // Used for display and as a stable reference for downstream code.
      originalAmount:   amount,
      originalCurrency: productCurrency,
      amountUsd:      null,    // filled in by webhook after confirmed exchange rate
      platformFee:    null,    // calculated by webhook from confirmed amount
      sellerAmount:   null,    // calculated by webhook from confirmed amount
      paymentMethod,
      paymentStatus:  'pending',
      deliveryStatus: 'pending',
      reviewLeft:     false,
      affiliateRef:   sanitisedRef,   // null if no referral; webhook uses this to credit affiliate
      // Netlify stamps the buyer's country on every request — used for Top Locations analytics.
      buyerCountry:   event.headers['x-country'] || event.headers['cf-ipcountry'] || '',
      createdAt:      FieldValue.serverTimestamp(),
    });

    /* ── Initiate payment ── */

    // For Stripe, check if the product currency is one Stripe cannot charge in
    // (e.g. NGN). If so, convert the amount to USD so the checkout doesn't fail
    // for international buyers. The original productCurrency is kept on the order
    // for seller reference; chargedCurrency/chargedAmount reflect what Stripe sees.
    let stripeAmount = chargeAmount;
    let stripeCurrency = productCurrency;
    if (paymentMethod === 'stripe' && STRIPE_UNSUPPORTED_CURRENCIES.has(productCurrency)) {
      const rate = await getUsdRate(db, productCurrency);
      if (!rate) {
        return respond(500, { error: 'Could not fetch exchange rate for currency conversion. Please try again.' });
      }

      // Fix C — FX buffer: read platformFxBuffer from settings (already loaded above
      // via getSettings(db)). This adds a small percentage margin on top of the live
      // rate so the platform collects slightly more USD than the bare spot-rate
      // equivalent. The buffer absorbs exchange-rate movement between collection time
      // and the freelancer's withdrawal time, preventing the NGN payout from exceeding
      // what was collected. Default 0 (no buffer) — set platformFxBuffer: 1.5 in
      // config/platform for 1.5%. The seller always receives their NGN price worth of
      // USD net of platform fee; the buffer is extra margin on the gross amount, not
      // taken from seller earnings.
      const fxBuffer = (typeof settings.platformFxBuffer === 'number' && settings.platformFxBuffer > 0)
        ? settings.platformFxBuffer : 0;

      const bufferedRate = rate * (1 + fxBuffer / 100);
      stripeAmount   = Math.ceil(chargeAmount * bufferedRate * 100) / 100; // round up to 2 dp, never short-charge
      stripeCurrency = 'USD';
      console.log(
        `[create-product-order] Stripe currency conversion: ${chargeAmount} ${productCurrency} → ${stripeAmount} USD ` +
        `(rate: ${rate}, fxBuffer: ${fxBuffer}%, bufferedRate: ${bufferedRate})`
      );
    }

    // ── Flutterwave USD → local African currency conversion ──────────────────
    // Flutterwave does not process USD for African buyers — it requires a local
    // currency (NGN, GHS, KES, etc.). When the product is priced in USD and the
    // buyer is on Flutterwave, convert the charge to their local currency using
    // Flutterwave's own live rate plus the admin-set FX buffer so we never
    // collect less local currency than the USD equivalent is worth at payout.
    //
    // originalAmount on the order stays in USD — the seller's credit (fix5) is
    // always calculated from that, so the FX conversion never inflates seller pay.
    let flwAmount   = chargeAmount;
    let flwCurrency = productCurrency;

    if (paymentMethod === 'flutterwave' && productCurrency === 'USD') {
      // Map buyer's timezone → their likely local currency.
      // Same map as p.html's _TZ_LOCAL_CURRENCY — kept in sync here.
      const TZ_TO_CURRENCY = {
        'Africa/Lagos':         'NGN',
        'Africa/Abuja':         'NGN',
        'Africa/Nairobi':       'KES',
        'Africa/Johannesburg':  'ZAR',
        'Africa/Accra':         'GHS',
        'Africa/Cairo':         'EGP',
        'Africa/Kampala':       'UGX',
        'Africa/Dar_es_Salaam': 'TZS',
        'Africa/Kigali':        'RWF',
        'Africa/Abidjan':       'XOF',
        'Africa/Dakar':         'XOF',
        'Africa/Douala':        'XAF',
        'Africa/Libreville':    'XAF',
        'Africa/Blantyre':      'MWK',
        'Africa/Lusaka':        'ZMW',
        'Africa/Harare':        'ZWL',
        'Africa/Addis_Ababa':   'ETB',
        'Africa/Casablanca':    'MAD',
        'Africa/Tunis':         'TND',
        'Africa/Tripoli':       'LYD',
        'Africa/Khartoum':      'SDG',
        'Africa/Mogadishu':     'SOS',
        'Africa/Maputo':        'MZN',
        'Africa/Windhoek':      'NAD',
        'Africa/Gaborone':      'BWP',
        'Africa/Maseru':        'LSL',
        'Africa/Mbabane':       'SZL',
        'Africa/Monrovia':      'LRD',
        'Africa/Freetown':      'SLL',
        'Africa/Conakry':       'GNF',
        'Africa/Bamako':        'XOF',
        'Africa/Ouagadougou':   'XOF',
        'Africa/Niamey':        'XOF',
        'Africa/Lome':          'XOF',
        'Africa/Porto-Novo':    'XOF',
        'Africa/Ndjamena':      'XAF',
        'Africa/Bangui':        'XAF',
        'Africa/Brazzaville':   'XAF',
        'Africa/Kinshasa':      'CDF',
        'Africa/Lubumbashi':    'CDF',
        'Africa/Bujumbura':     'BIF',
        'Africa/Djibouti':      'DJF',
        'Africa/Asmara':        'ERN',
        'Africa/Juba':          'SSP',
        'Africa/Dar_es_Salaam': 'TZS',
        'Africa/Antananarivo':  'MGA',
        'Africa/Moroni':        'KMF',
        'Africa/Noumea':        'XPF',
        'Africa/Sao_Tome':      'STD',
        'Africa/Malabo':        'XAF',
      };

      // Flutterwave-supported collection currencies (those it can actually
      // process card/bank payments in — subset of full African currency list).
      const FLW_COLLECTION_CURRENCIES = new Set([
        'NGN', 'GHS', 'KES', 'UGX', 'TZS', 'RWF', 'ZAR', 'XOF', 'XAF', 'MWK', 'ZMW',
      ]);

      const tz            = (typeof buyerTimezone === 'string') ? buyerTimezone.trim() : '';
      const localCurrency = TZ_TO_CURRENCY[tz] || null;

      if (localCurrency && FLW_COLLECTION_CURRENCIES.has(localCurrency)) {
        // Fetch USD → localCurrency rate from Flutterwave's own rates endpoint.
        // rate = units of localCurrency per 1 USD (e.g. 1600 for NGN).
        // Retries once on failure — a single dropped request shouldn't fail
        // the buyer's checkout when the rate is genuinely available.
        const flwKey    = process.env.FLW_SECRET_KEY;
        let   localRate = null;

        if (flwKey) {
          for (let attempt = 0; attempt < 2 && !localRate; attempt++) {
            try {
              const rateRes  = await fetch(
                `${FLW_API_BASE}/transfers/rates?amount=1&destination_currency=${localCurrency}&source_currency=USD`,
                { headers: { Authorization: `Bearer ${flwKey}` } }
              );
              const rateData = await rateRes.json().catch(() => ({}));
              const r        = rateData?.data?.rate;
              if (r && !isNaN(Number(r))) localRate = Number(r);
            } catch (rateErr) {
              console.warn(`[create-product-order] FLW rate fetch failed (attempt ${attempt + 1}):`, rateErr.message);
            }
          }
        }

        if (localRate) {
          // Load fxBuffer from settings (already fetched above).
          const flwFxBuffer    = (typeof settings.platformFxBuffer === 'number' && settings.platformFxBuffer > 0)
            ? settings.platformFxBuffer : 0;
          const flwBufferedRate = localRate * (1 + flwFxBuffer / 100);
          flwAmount   = Math.ceil(chargeAmount * flwBufferedRate * 100) / 100; // round up, never short-charge
          flwCurrency = localCurrency;
          console.log(
            `[create-product-order] Flutterwave USD→local conversion: ${chargeAmount} USD → ${flwAmount} ${flwCurrency} ` +
            `(rate: ${localRate}, fxBuffer: ${flwFxBuffer}%, bufferedRate: ${flwBufferedRate}, buyerTz: ${tz})`
          );
        } else {
          // Rate fetch failed even after a retry. Flutterwave does not accept
          // USD for African buyers using bank transfer/USSD/mobile money — the
          // payment options this checkout is configured with — so silently
          // falling back to a USD charge here produced a checkout link that
          // looked fine but failed when the buyer actually tried to pay.
          // Fail cleanly instead, same pattern as the Stripe conversion above,
          // so the buyer sees a clear "try again" message instead of a dead
          // checkout page. The order doc stays 'pending' and is harmless.
          console.warn(`[create-product-order] Could not fetch FLW rate for ${localCurrency} after retry — aborting checkout.`);
          return respond(500, { error: 'Could not fetch exchange rate for your local currency. Please try again.' });
        }
      } else if (tz) {
        console.log(
          `[create-product-order] Flutterwave USD product: no supported local currency for tz="${tz}" ` +
          `(localCurrency=${localCurrency}). Charging in USD.`
        );
      }
    }

    const paymentArgs = {
      orderId,
      amount:          paymentMethod === 'stripe' ? stripeAmount
                     : paymentMethod === 'flutterwave' ? flwAmount
                     : chargeAmount,
      productCurrency: paymentMethod === 'stripe' ? stripeCurrency
                     : paymentMethod === 'flutterwave' ? flwCurrency
                     : productCurrency,
      description:  product.title || 'Kreddlo Product',
      productTitle: product.title || 'Kreddlo Product',
      buyerEmail,   // already sanitized above
      platformUrl,
    };

    let result;
    if (paymentMethod === 'crypto') {
      result = await createCryptoCheckout(paymentArgs);
    } else if (paymentMethod === 'stripe') {
      result = await createStripeCheckout(paymentArgs);
    } else {
      result = await createFlutterwaveCheckout(paymentArgs);
    }

    /* ── Store paymentRef on order ── */
    await orderRef.update({ paymentRef: result.paymentRef || null });

    /* ── Link order to a buyer account (create one if needed) ── */
    try {
      let buyerUid;

      if (verifiedCallerUid) {
        // Logged-in buyer — we already have their real, verified UID from
        // the Authorization header. No email lookup needed, and nothing
        // here can mismatch a typed email against the account's real one.
        buyerUid = verifiedCallerUid;
      } else {
        const auth            = getAuth();
        const normalizedEmail = buyerEmail.trim().toLowerCase();

        try {
          // Try to find an existing Firebase Auth user with this email
          const existingUser = await auth.getUserByEmail(normalizedEmail);
          buyerUid = existingUser.uid;
        } catch (lookupErr) {
          if (lookupErr.code === 'auth/user-not-found') {
            // No account yet — create a passwordless account for the guest
            const newUser = await auth.createUser({
              email:         normalizedEmail,
              displayName:   buyerName,   // already sanitized/trimmed
              emailVerified: false,
            });
            buyerUid = newUser.uid;

            // Write a minimal user profile so buyer-purchases.html can find them
            await db.collection('users').doc(buyerUid).set({
              uid:        buyerUid,
              email:      normalizedEmail,
              name:       buyerName,      // already sanitized/trimmed
              role:       'buyer',
              createdAt:  FieldValue.serverTimestamp(),
              createdVia: 'guest-purchase',
            });

            // Queue a "set your password" welcome email via email-queue
            try {
              const resetLink = await auth.generatePasswordResetLink(normalizedEmail);
              await db.collection('email-queue').add({
                userUid:    buyerUid,
                templateId: 'guest-purchase-welcome',
                emailData: {
                  name:      buyerName.trim(),
                  email:     normalizedEmail,
                  resetLink,
                },
                sendAfter:  Date.now(),   // send immediately on next queue run
                sent:       false,
                createdAt:  FieldValue.serverTimestamp(),
              });
            } catch (emailErr) {
              // Non-fatal — order still succeeds even if welcome email fails
              console.warn('[create-product-order] Failed to queue guest welcome email:', emailErr.message);
            }
          } else {
            // Re-throw unexpected auth errors
            throw lookupErr;
          }
        }
      }

      // Stamp buyerUid onto the order
      await orderRef.update({ buyerUid });

    } catch (accountErr) {
      // Non-fatal — don't block the checkout if account linking fails
      console.warn('[create-product-order] Buyer account linking failed:', accountErr.message);
    }

    console.log(`Product order created — orderId: ${orderId}, product: ${productId}, method: ${paymentMethod}, currency: ${productCurrency}, amount: ${amount}`);

    return respond(200, { checkoutUrl: result.checkoutUrl, orderId });

  } catch (err) {
    console.error('[create-product-order] Error:', err);
    return respond(500, { error: err.message || 'Internal server error.' });
  }
};

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(body),
  };
}
