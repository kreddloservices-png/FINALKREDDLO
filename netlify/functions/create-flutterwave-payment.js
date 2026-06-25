/**
 * Netlify Function: create-flutterwave-payment.js
 * Path: netlify/functions/create-flutterwave-payment.js
 *
 * Initialises a Flutterwave transaction for a Kreddlo project payment.
 * Redirects the buyer to the Flutterwave-hosted checkout page where they
 * can pay by card, bank transfer, USSD, mobile money, and more —
 * across Africa and internationally.
 *
 * Flow:
 *  1. Validate request body
 *  2. Init Firebase and load platform settings
 *  3. Guard: flutterwaveEnabled must be true in settings
 *  4. Guard: FLW_SECRET_KEY must be set
 *  5. Read authoritative amount from Firestore (never trust client)
 *  6. KYC guard: freelancer must be verified
 *  7. Build and POST the transaction to the Flutterwave Payment API
 *  8. Return { checkoutUrl, paymentRef } to the frontend
 *
 * Environment variables required:
 *   FLW_SECRET_KEY           — Flutterwave secret key (FLWSECK_TEST-... or FLWSECK-...)
 *   FIREBASE_SERVICE_ACCOUNT — full service account JSON as one-line string
 *   PLATFORM_URL             — live domain, e.g. https://kreddlo.space (no trailing slash)
 *
 * Expected POST body (JSON):
 *   {
 *     orderId:      string   — Firestore project document ID
 *     amount:       number   — ignored; authoritative value read from Firestore
 *     description:  string   — shown on the Flutterwave checkout page
 *     buyerEmail:   string   — required by Flutterwave to initialise a transaction
 *     projectTitle: string   — shown as the transaction title
 *     currency:     string   — optional; overridden by project doc if set
 *   }
 *
 * Success response (200):
 *   { checkoutUrl: "https://checkout.flutterwave.com/v3/hosted/pay/...", paymentRef: "kreddlo-..." }
 *
 * Error responses:
 *   400 — Missing or invalid request fields
 *   403 — Flutterwave payments are not currently enabled / KYC not verified
 *   404 — Project not found
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

  /* ── CORS preflight ── */
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        'Access-Control-Allow-Origin':  '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
      body: '',
    };
  }

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

  const {
    orderId,
    description,
    buyerEmail,
    buyerName,
    buyerPhone,
    projectTitle,
    currency: clientCurrency,
    buyerTimezone,
  } = body;

  if (!orderId || typeof orderId !== 'string' || orderId.trim() === '') {
    return respond(400, { error: 'orderId is required.' });
  }
  if (!description || typeof description !== 'string' || description.trim() === '') {
    return respond(400, { error: 'description is required.' });
  }
  if (!projectTitle || typeof projectTitle !== 'string' || projectTitle.trim() === '') {
    return respond(400, { error: 'projectTitle is required.' });
  }
  if (!buyerEmail || typeof buyerEmail !== 'string' || !buyerEmail.includes('@')) {
    return respond(400, { error: 'buyerEmail is required and must be a valid email address.' });
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

    /* ── 5. Guard: Flutterwave must be enabled in admin settings ── */
    if (!settings.flutterwaveEnabled) {
      return respond(403, { error: 'Flutterwave payments are not currently enabled.' });
    }

    /* ── 6. Guard: FLW_SECRET_KEY must be present ── */
    const flwKey = process.env.FLW_SECRET_KEY;
    if (!flwKey) {
      console.error('FLW_SECRET_KEY environment variable is not set.');
      return respond(500, { error: 'Flutterwave is not configured. Please contact support.' });
    }

    /* ── 7. Read authoritative amount from Firestore — ignore client-supplied value ── */
    const projectSnap = await db.collection('projects').doc(orderId.trim()).get();
    if (!projectSnap.exists) {
      return respond(404, { error: 'Project not found.' });
    }
    const projectDoc = projectSnap.data();
    const amount = Number(projectDoc.totalAmount || projectDoc.budget || projectDoc.amount || 0);
    if (!amount || amount <= 0) {
      return respond(400, { error: 'Project has no valid payment amount set.' });
    }

    /* Read currency from project doc — not from the client */
    const paymentCurrency = ((projectDoc.currency || clientCurrency || 'NGN')).toUpperCase();

    // ── USD → local African currency conversion ───────────────────────────────
    // Projects are always priced in USD. Flutterwave requires a local African
    // currency for African buyers. Convert using Flutterwave's own live rate
    // plus the admin-set FX buffer so the platform never under-collects.
    // The Firestore project doc (originalAmount/budget) stays in USD — seller
    // credit is calculated from that in the webhook, so this conversion is
    // transparent to the freelancer.
    let flwChargeAmount   = amount;
    let flwChargeCurrency = paymentCurrency;

    if (paymentCurrency === 'USD') {
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
            console.warn('[create-flutterwave-payment] FLW rate fetch failed:', rateErr.message);
          }
        }

        if (localRate) {
          const flwFxBuffer     = (typeof settings.platformFxBuffer === 'number' && settings.platformFxBuffer > 0)
            ? settings.platformFxBuffer : 0;
          const flwBufferedRate = localRate * (1 + flwFxBuffer / 100);
          flwChargeAmount   = Math.ceil(amount * flwBufferedRate * 100) / 100;
          flwChargeCurrency = localCurrency;
          console.log(
            `[create-flutterwave-payment] USD→local conversion: ${amount} USD → ${flwChargeAmount} ${flwChargeCurrency} ` +
            `(rate: ${localRate}, fxBuffer: ${flwFxBuffer}%, bufferedRate: ${flwBufferedRate}, buyerTz: ${tz})`
          );
        } else {
          console.warn(
            `[create-flutterwave-payment] Could not fetch FLW rate for ${localCurrency}. Charging in USD.`
          );
        }
      } else if (tz) {
        console.log(
          `[create-flutterwave-payment] USD project: no supported local currency for tz="${tz}". Charging in USD.`
        );
      }
    }

    /* ── 7b. freelancerSigned guard: block payment until the freelancer has accepted ── */
    if (projectDoc.freelancerSigned !== true) {
      return respond(403, { error: 'Waiting for the freelancer to accept this contract before payment can be made.' });
    }

    /* ── 8. KYC guard: verify the freelancer is verified before accepting payment ── */
    const freelancerUid = projectDoc.freelancerUid || projectDoc.sellerUid || null;
    if (freelancerUid) {
      const freelancerSnap = await db.collection('users').doc(freelancerUid).get();
      if (freelancerSnap.exists && freelancerSnap.data().kycStatus !== 'verified') {
        return respond(403, { error: 'This freelancer is not yet verified. Payment cannot be accepted at this time.' });
      }
    }

    /* ── 9. Build a unique transaction reference ── */
    /*
     * Flutterwave requires a unique tx_ref per transaction.
     * Format: kreddlo-<orderId>-<timestamp>
     * This guarantees uniqueness even if a buyer retries payment on the same order.
     */
    const paymentRef = `kreddlo-${orderId.trim()}-${Date.now()}`;

    /* ── 10. Build the Flutterwave payment payload ── */
    /*
     * Flutterwave Standard Payment API accepts JSON.
     * amount is in the base currency unit (no smallest-unit conversion needed —
     * unlike Paystack, Flutterwave accepts the full decimal amount, e.g. 250.00).
     *
     * Flutterwave supports multi-currency including NGN, USD, GBP, EUR, GHS,
     * ZAR, KES, UGX, TZS, RWF, XOF, XAF, and more.
     *
     * payment_options can include:
     *   card          — Visa, Mastercard, Verve, Amex
     *   banktransfer  — direct bank transfer
     *   ussd          — USSD payments (Nigeria)
     *   mobilemoney   — MTN, Airtel, Tigo, Vodafone (Ghana, Uganda, Rwanda, etc.)
     *   account       — direct bank debit
     *   barter        — Barter by Flutterwave
     *   nqr           — NQR QR code payments
     */
    const transactionPayload = {
      tx_ref:          paymentRef,
      amount:          flwChargeAmount,       // converted to local currency if USD product
      currency:        flwChargeCurrency,
      redirect_url:    `${platformUrl}/buyer-payments.html?payment=success&orderId=${encodeURIComponent(orderId.trim())}&method=flutterwave`,
      payment_options: 'card,banktransfer,ussd,mobilemoney,account,barter,nqr',
      customer: {
        email:       buyerEmail.trim().toLowerCase(),
        name:        (buyerName || '').trim() || buyerEmail.trim().toLowerCase(),
        phonenumber: (buyerPhone || '').trim() || undefined,
      },
      customizations: {
        title:       projectTitle.trim(),
        description: description.trim(),
        logo:        `${platformUrl}/assets/kreddlo-logo.png`,
      },
      meta: {
        orderId:      orderId.trim(),
        projectTitle: projectTitle.trim(),
        platform:     'kreddlo',
      },
    };

    /* ── 11. Call the Flutterwave API ── */
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
      console.error('Network error reaching Flutterwave:', networkErr);
      return respond(502, { error: 'Could not reach the payment service. Please try again.' });
    }

    /* ── 12. Handle the Flutterwave response ── */
    let flwData;
    try {
      flwData = await flwRes.json();
    } catch {
      console.error('Flutterwave returned non-JSON response, status:', flwRes.status);
      return respond(502, { error: 'Unexpected response from payment service.' });
    }

    if (!flwRes.ok || flwData.status !== 'success') {
      console.error('Flutterwave API error:', {
        status:  flwRes.status,
        payload: flwData,
      });
      const detail = flwData?.message || 'Unknown error from payment service.';
      return respond(502, { error: `Payment service error: ${detail}` });
    }

    /*
     * Flutterwave returns the hosted payment link in data.link
     * e.g. "https://checkout.flutterwave.com/v3/hosted/pay/xxxxxxxxxxxxxxxx"
     */
    const checkoutUrl = flwData?.data?.link;

    if (!checkoutUrl) {
      console.error('Flutterwave response missing data.link:', flwData);
      return respond(502, { error: 'Payment service did not return a checkout URL.' });
    }

    console.log(`Flutterwave transaction initialised — orderId: ${orderId}, amount: ${flwChargeAmount} ${flwChargeCurrency}, ref: ${paymentRef}`);

    /* ── 13. Return success ── */
    return respond(200, { checkoutUrl, paymentRef });

  } catch (err) {
    console.error('[create-flutterwave-payment] Unhandled error:', err);
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
