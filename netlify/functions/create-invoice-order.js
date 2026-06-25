/**
 * Netlify Function: create-invoice-order.js
 * Path: netlify/functions/create-invoice-order.js
 *
 * Creates a payment session for an existing invoice and returns a checkout URL.
 * Mirrors create-product-order.js's payment-creation pattern, but reads from
 * the `invoices` collection instead of `products`.
 *
 * After payment is confirmed (via webhook), funds are held in escrow.
 * The freelancer must mark the invoice as delivered; then the buyer confirms
 * (or the scheduled function auto-releases after the admin-configured escrow
 * window starting from deliveredAt).
 *
 * If paymentMethod is 'stripe' and the invoice currency is one Stripe cannot
 * charge in directly (NGN/UGX/RWF/XOF/TZS), the amount is converted to USD
 * using a cached Frankfurter rate plus the platform's platformFxBuffer margin
 * (config/platform, same setting create-product-order.js and create-stripe-
 * payment.js use) before the Stripe Checkout Session is created. The original
 * amount/currency are preserved as originalAmount/originalCurrency on the
 * invoice-orders document.
 *
 * Expected POST body (JSON):
 *   {
 *     invoiceId:     string  — Firestore invoices document ID
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
const { getSettings }                  = require('./get-settings');
const { checkRateLimit }               = require('./_rate-limit');
const { sanitizeString, sanitizeEmail } = require('./_sanitize');

/* ── Payment API endpoints ── */
const NOWPAYMENTS_INVOICE_ENDPOINT = 'https://api.nowpayments.io/v1/invoice';
const STRIPE_CHECKOUT_URL          = 'https://api.stripe.com/v1/checkout/sessions';
const FLW_PAYMENT_URL              = 'https://api.flutterwave.com/v3/payments';
const FRANKFURTER_URL              = 'https://api.frankfurter.app/latest';

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

/* ── Currencies Stripe cannot charge in ── */
// Same set used in create-product-order.js (Fix C) and create-stripe-payment.js.
// invoice.html already routes African-currency invoices to Flutterwave when it's
// enabled, but this is a server-side guard for whenever paymentMethod === 'stripe'
// arrives with one of these currencies anyway (Flutterwave disabled, stale
// frontend state, or a direct API call) — never trust the client pairing blindly.
const STRIPE_UNSUPPORTED_CURRENCIES = new Set(['NGN', 'UGX', 'RWF', 'XOF', 'TZS']);

/* ── Exchange rate cache (Firestore-backed, 1-hour TTL) ── */
// Shares the same config/exchangeRates cache document as create-product-order.js
// and create-stripe-payment.js, so a rate fetched by one is reused by the others.
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
    console.warn('[create-invoice-order] Cache read failed:', cacheReadErr.message);
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

    // Persist to Firestore so future calls (from this or other functions) skip the network
    try {
      await cacheRef.set({ rates, updatedAt: Date.now() });
    } catch (writeErr) {
      console.warn('[create-invoice-order] Cache write failed (non-fatal):', writeErr.message);
    }

    return rates[currency] ?? null;
  } catch (fetchErr) {
    console.warn('[create-invoice-order] Frankfurter fetch failed:', fetchErr.message);

    // ── 3. Stale fallback — better than blocking the payment entirely ──
    try {
      const snap = await cacheRef.get();
      if (snap.exists && snap.data()?.rates?.[currency]) {
        const staleAgeMs  = Date.now() - (snap.data().updatedAt || 0);
        const MAX_STALE_MS = 24 * 60 * 60 * 1000; // 24 hours — reject rates older than this
        if (staleAgeMs > MAX_STALE_MS) {
          console.error('[create-invoice-order] Stale rate for', currency, 'is too old (' + Math.round(staleAgeMs / 3600000) + ' hrs) — rejecting to avoid FX debt.');
          return null;
        }
        console.warn('[create-invoice-order] Using stale cached rate for', currency, '(age: ' + Math.round(staleAgeMs / 60000) + ' min)');
        return snap.data().rates[currency];
      }
    } catch (_) { /* ignore */ }

    return null; // total failure — caller will block rather than risk a bad charge
  }
}

/* ══════════════════════════════════════════════════════════════
   PAYMENT CREATORS — same shape as create-product-order.js,
   redirect targets point back to invoice.html (no buyer login required)
══════════════════════════════════════════════════════════════ */

async function createCryptoCheckout({ invoiceId, orderId, amount, currency, description, clientEmail, platformUrl }) {
  const apiKey = process.env.NOWPAYMENTS_API_KEY;
  if (!apiKey) throw new Error('NOWPAYMENTS_API_KEY is not set.');

  // BUG 1 FIX: order_id must be the invoice-orders Firestore document ID (orderId),
  // NOT the invoices document ID (invoiceId). nowpayments-webhook.js uses the
  // incoming order_id to look up the document in the invoice-orders collection —
  // using invoiceId here meant the lookup always failed and crypto invoice payments
  // were silently dropped. The success/cancel redirect URLs still use invoiceId
  // so the buyer lands on the correct invoice page after payment.
  const payload = {
    price_amount:      amount,
    price_currency:    currency.toLowerCase(),
    order_id:          orderId,
    order_description: description.trim().substring(0, 500),
    is_fixed_rate:     false,
    success_url: `${platformUrl}/invoice.html?invoiceId=${encodeURIComponent(invoiceId)}&payment=success&method=crypto`,
    cancel_url:  `${platformUrl}/invoice.html?invoiceId=${encodeURIComponent(invoiceId)}&payment=cancelled`,
    ipn_callback_url: `${platformUrl}/.netlify/functions/nowpayments-webhook`,
  };

  if (clientEmail) payload.customer_email = clientEmail.trim().toLowerCase();

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

async function createStripeCheckout({ invoiceId, orderId, amount, currency, description, clientEmail, invoiceTitle, platformUrl }) {
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) throw new Error('STRIPE_SECRET_KEY is not set.');

  const sessionParams = {
    'payment_method_types[]':                                    'card',
    'mode':                                                      'payment',
    'line_items[0][price_data][currency]':                       currency.toLowerCase(),
    'line_items[0][price_data][product_data][name]':             invoiceTitle,
    'line_items[0][price_data][product_data][description]':      description,
    'line_items[0][price_data][unit_amount]':                    Math.round(amount * 100),
    'line_items[0][quantity]':                                   1,
    'metadata[order_id]':                                        orderId,
    'metadata[invoice_id]':                                      invoiceId,
    'metadata[platform]':                                        'kreddlo',
    'metadata[order_type]':                                      'invoice',
    'success_url': `${platformUrl}/invoice.html?invoiceId=${encodeURIComponent(invoiceId)}&payment=success&method=stripe`,
    'cancel_url':  `${platformUrl}/invoice.html?invoiceId=${encodeURIComponent(invoiceId)}&payment=cancelled`,
  };

  if (clientEmail) sessionParams['customer_email'] = clientEmail.trim().toLowerCase();

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

async function createFlutterwaveCheckout({ invoiceId, amount, currency, description, clientEmail, invoiceTitle, platformUrl }) {
  const flwKey = process.env.FLW_SECRET_KEY;
  if (!flwKey) throw new Error('FLW_SECRET_KEY is not set.');
  if (!clientEmail) throw new Error('clientEmail is required for Flutterwave payments.');

  const paymentRef = `kreddlo-inv-${invoiceId}-${Date.now()}`;

  const payload = {
    tx_ref:          paymentRef,
    amount:          amount,
    currency:        currency,
    redirect_url:    `${platformUrl}/invoice.html?invoiceId=${encodeURIComponent(invoiceId)}&payment=success&method=flutterwave`,
    payment_options: 'card,banktransfer,ussd,mobilemoney,account,barter,nqr',
    customer: {
      email: clientEmail.trim().toLowerCase(),
    },
    customizations: {
      title:       invoiceTitle,
      description: description,
      logo:        `${platformUrl}/assets/kreddlo-logo.png`,
    },
    meta: { invoiceId, invoiceTitle, orderType: 'invoice', platform: 'kreddlo' },
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

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return respond(400, { error: 'Invalid JSON in request body.' });
  }

  const { invoiceId, paymentMethod, payerName: rawPayerName, buyerTimezone } = body;

  // Sanitize free-text fields before validation and downstream use
  const payerName = sanitizeString(rawPayerName, 80);
  const note      = sanitizeString(body.note, 2000);

  if (!invoiceId || typeof invoiceId !== 'string') {
    return respond(400, { error: 'invoiceId is required.' });
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

    /* ── Server-side rate limit: 20 invoice order attempts per 5 min per IP ──
       Invoice payment is unauthenticated (public pay-link) so IP is the
       only available key. Prevents payment-gateway probing and brute-force
       invoice-ID enumeration from a single source. */
    const clientIp = (
      event.headers['x-forwarded-for'] || event.headers['client-ip'] || 'unknown'
    ).split(',')[0].trim();
    const rl = await checkRateLimit(db, `cio::${clientIp}`, 20, 300);
    if (!rl.allowed) {
      return respond(429, { error: rl.error, retryAfter: rl.retryAfter });
    }

    /* ── Fetch invoice ── */
    const invoiceRef  = db.collection('invoices').doc(invoiceId);
    const invoiceSnap = await invoiceRef.get();
    if (!invoiceSnap.exists) {
      return respond(404, { error: 'Invoice not found.' });
    }
    const invoice = invoiceSnap.data();

    if (['paid', 'escrow', 'delivered', 'completed'].includes(invoice.status)) {
      return respond(400, { error: 'This invoice has already been paid.' });
    }
    if (invoice.status === 'void' || invoice.status === 'cancelled') {
      return respond(400, { error: 'This invoice is no longer payable.' });
    }

    /* FIX: suspended accounts could still transact even without an active
       session, since this endpoint never authenticates the payer. The only
       account in this flow that can be checked is the issuing freelancer
       (invoice.uid) — block payment if they've been suspended since the
       invoice was issued. */
    if (invoice.uid) {
      const issuerSnap = await db.collection('users').doc(invoice.uid).get();
      if (issuerSnap.exists && issuerSnap.data().suspended === true) {
        return respond(403, { error: 'This invoice is currently unavailable for payment. Please contact support.' });
      }
    }

    /* ── Respect platform gateway availability ── */
    const settings = await getSettings(db);
    if (paymentMethod === 'stripe'   && settings.stripeEnabled   !== true) {
      return respond(400, { error: 'Card payments are not currently available.' });
    }
    if (paymentMethod === 'flutterwave' && settings.flutterwaveEnabled !== true) {
      return respond(400, { error: 'Flutterwave payments are not currently available.' });
    }
    if (paymentMethod === 'crypto'   && settings.cryptoEnabled   !== true) {
      return respond(400, { error: 'Crypto payments are not currently available.' });
    }

    const currency = (invoice.currency || 'USD').toUpperCase();
    const invoiceListedAmount = invoice.total;

    if (!invoiceListedAmount || invoiceListedAmount <= 0) {
      return respond(400, { error: 'This invoice does not have a valid total.' });
    }

    /* ── Add platform fee on top of the invoice total ──
       Same pattern as create-product-order.js / create-project.js: the
       buyer pays invoiceListedAmount + platformFee (fee is on top, not
       deducted from the seller). The webhook then receives this total as
       confirmedAmount and deducts platformFeePercent from it to derive
       sellerAmount — which correctly nets the freelancer their original
       invoice total. originalAmount below stays the true issued total,
       used for display and as a stable seller-facing reference.
    ── */
    const platformFeePercent = typeof settings.platformFeePercent === 'number' ? settings.platformFeePercent : 2.5;
    const amount = +(invoiceListedAmount / (1 - platformFeePercent / 100)).toFixed(2);

    // ── Hard guard: never let amount silently equal the listed invoice
    // total when a real fee is configured. If this ever fires, something
    // upstream (settings load, a stale require cache, etc.) produced a 0%
    // fee unexpectedly — fail loudly instead of quietly under-charging.
    if (platformFeePercent > 0 && amount === invoiceListedAmount) {
      console.error(
        `[create-invoice-order] FEE GUARD TRIPPED — amount equals listed invoice total ` +
        `despite platformFeePercent=${platformFeePercent}. Refusing to proceed. invoiceId: ${invoiceId}.`
      );
      return respond(500, { error: 'Pricing calculation error. Please try again or contact support.' });
    }

    /* ── Create invoice-orders document (mirrors product-orders shape) ── */
    const orderRef = db.collection('invoice-orders').doc();
    const orderId   = orderRef.id;

    await orderRef.set({
      invoiceId,
      sellerUid:      invoice.uid,
      clientEmail:    (invoice.clientEmail || '').trim().toLowerCase(),
      clientName:     invoice.clientName || '',
      payerName:      payerName || invoice.clientName || '',
      // amount/currency = the total charged to the buyer (listed invoice
      // total + platform fee). Webhooks deduct platformFeePercent from
      // this to derive sellerAmount.
      amount,
      currency,
      // Original list price/currency, captured before any Stripe currency
      // conversion happens below, and before the platform fee markup above.
      // amount/currency above continue to be overwritten by the webhook
      // with the confirmed charged values (existing behavior, unchanged) —
      // these are kept as an explicit, unambiguous record of what the
      // invoice was originally issued for.
      originalAmount:   invoiceListedAmount,
      originalCurrency: currency,
      amountUsd:      null,
      platformFee:    null,
      sellerAmount:   null,
      paymentMethod,
      paymentStatus:  'pending',
      createdAt:      FieldValue.serverTimestamp(),
    });

    /* ── Initiate payment ── */

    // For Stripe, check if the invoice currency is one Stripe cannot charge in
    // (e.g. NGN). If so, convert the amount to USD so the checkout doesn't fail.
    // The original currency/amount stay on the order doc (originalAmount/
    // originalCurrency above); chargedAmount/chargedCurrency reflect what Stripe
    // actually sees, and are recorded by stripe-webhook.js once payment confirms.
    let stripeAmount   = amount;
    let stripeCurrency = currency;
    if (paymentMethod === 'stripe' && STRIPE_UNSUPPORTED_CURRENCIES.has(currency)) {
      const rate = await getUsdRate(db, currency);
      if (!rate) {
        return respond(500, { error: 'Could not fetch exchange rate for currency conversion. Please try again.' });
      }

      // Fix C — FX buffer: settings.platformFxBuffer (config/platform, already
      // loaded above) adds a small percentage margin on top of the live rate so
      // the platform collects slightly more USD than the bare spot-rate
      // equivalent. The buffer absorbs exchange-rate movement between
      // collection time and the freelancer's withdrawal time, preventing the
      // NGN payout from exceeding what was collected. Default 0 (no buffer) —
      // set platformFxBuffer: 1.5 in config/platform for 1.5%. The seller
      // always receives their NGN price worth of USD net of platform fee; the
      // buffer is extra margin on the gross amount, not taken from seller
      // earnings. Same setting used by create-product-order.js and
      // create-stripe-payment.js, so this stays consistent across all flows.
      let fxBuffer = 0;
      if (typeof settings.platformFxBuffer === 'number' && settings.platformFxBuffer > 0) {
        fxBuffer = settings.platformFxBuffer; // e.g. 1.5 = 1.5%
      }

      const bufferedRate = rate * (1 + fxBuffer / 100);
      stripeAmount   = Math.ceil(amount * bufferedRate * 100) / 100; // round up to 2dp, never short-charge
      stripeCurrency = 'USD';
      console.log(
        `[create-invoice-order] Stripe currency conversion: ${amount} ${currency} → ${stripeAmount} USD ` +
        `(rate: ${rate}, fxBuffer: ${fxBuffer}%, bufferedRate: ${bufferedRate})`
      );
    }

    // ── Flutterwave USD → local African currency conversion ──────────────────
    // Flutterwave requires a local African currency, not USD. When the invoice
    // is in USD and the buyer is on Flutterwave, convert to their local currency
    // using Flutterwave's own live rate plus the admin-set FX buffer.
    // originalAmount on the order stays in USD — seller credit is always
    // calculated from that, so this conversion never inflates seller pay.
    let flwAmount   = amount;
    let flwCurrency = currency;

    if (paymentMethod === 'flutterwave' && currency === 'USD') {
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
        'Africa/Antananarivo':  'MGA',
        'Africa/Moroni':        'KMF',
        'Africa/Sao_Tome':      'STD',
        'Africa/Malabo':        'XAF',
      };

      const FLW_COLLECTION_CURRENCIES = new Set([
        'NGN', 'GHS', 'KES', 'UGX', 'TZS', 'RWF', 'ZAR', 'XOF', 'XAF', 'MWK', 'ZMW',
      ]);

      const tz            = (typeof buyerTimezone === 'string') ? buyerTimezone.trim() : '';
      const localCurrency = TZ_TO_CURRENCY[tz] || null;

      if (localCurrency && FLW_COLLECTION_CURRENCIES.has(localCurrency)) {
        const FLW_BASE  = 'https://api.flutterwave.com/v3';
        const flwKey    = process.env.FLW_SECRET_KEY;
        let   localRate = null;

        if (flwKey) {
          try {
            const rateRes  = await fetch(
              `${FLW_BASE}/transfers/rates?amount=1&destination_currency=${localCurrency}&source_currency=USD`,
              { headers: { Authorization: `Bearer ${flwKey}` } }
            );
            const rateData = await rateRes.json().catch(() => ({}));
            const r        = rateData?.data?.rate;
            if (r && !isNaN(Number(r))) localRate = Number(r);
          } catch (rateErr) {
            console.warn('[create-invoice-order] FLW rate fetch failed:', rateErr.message);
          }
        }

        if (localRate) {
          const flwFxBuffer    = (typeof settings.platformFxBuffer === 'number' && settings.platformFxBuffer > 0)
            ? settings.platformFxBuffer : 0;
          const flwBufferedRate = localRate * (1 + flwFxBuffer / 100);
          flwAmount   = Math.ceil(amount * flwBufferedRate * 100) / 100;
          flwCurrency = localCurrency;
          console.log(
            `[create-invoice-order] Flutterwave USD→local conversion: ${amount} USD → ${flwAmount} ${flwCurrency} ` +
            `(rate: ${localRate}, fxBuffer: ${flwFxBuffer}%, bufferedRate: ${flwBufferedRate}, buyerTz: ${tz})`
          );
        } else {
          console.warn(
            `[create-invoice-order] Could not fetch FLW rate for ${localCurrency}. ` +
            `Falling back to USD charge.`
          );
        }
      } else if (tz) {
        console.log(
          `[create-invoice-order] Flutterwave USD invoice: no supported local currency for tz="${tz}". Charging in USD.`
        );
      }
    }

    const paymentArgs = {
      invoiceId,
      orderId,      // BUG 1 FIX: pass the invoice-orders doc ID so the NOWPayments
                    // webhook (which uses order_id to look up invoice-orders) finds
                    // the correct document. Previously invoiceId was passed here,
                    // causing the webhook to search invoice-orders.doc(invoiceId)
                    // which never exists — silently dropping every crypto payment.
      amount:       paymentMethod === 'stripe'       ? stripeAmount
                  : paymentMethod === 'flutterwave'  ? flwAmount
                  : amount,
      currency:     paymentMethod === 'stripe'       ? stripeCurrency
                  : paymentMethod === 'flutterwave'  ? flwCurrency
                  : currency,
      description:  `Invoice ${invoice.invoiceNumber || invoiceId} — ${invoice.clientName || 'Client'}`,
      invoiceTitle: `Invoice ${invoice.invoiceNumber || ''}`.trim(),
      clientEmail:  (invoice.clientEmail || '').trim().toLowerCase(),
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

    /* ── Store paymentRef on order + link order id back on the invoice ── */
    await orderRef.update({ paymentRef: result.paymentRef || null });
    await invoiceRef.update({
      lastOrderId:     orderId,
      lastPaymentTry:  FieldValue.serverTimestamp(),
      status:          invoice.status === 'draft' ? 'sent' : invoice.status,
    });

    console.log(`Invoice order created — orderId: ${orderId}, invoice: ${invoiceId}, method: ${paymentMethod}, currency: ${currency}, amount: ${amount}`);

    return respond(200, { checkoutUrl: result.checkoutUrl, orderId });

  } catch (err) {
    console.error('[create-invoice-order] Error:', err);
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
