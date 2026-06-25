/**
 * get-bank-list.js — Kreddlo Netlify Function
 *
 * Returns the list of banks for a given fiat currency, sourced from
 * Flutterwave's GET /v3/banks/:country endpoint. Used by the affiliate
 * bank withdrawal form (dashboard-affiliate.html) to populate the
 * searchable "Bank" dropdown — same pattern as the freelancer bank
 * payout flow in create-bank-payout.js.
 *
 * For Stripe-supported international currencies (USD, EUR, GBP, etc.)
 * no bank list is returned — instead a `stripeFields` descriptor tells
 * the frontend which input fields to render (routing+account, IBAN, etc.)
 *
 * Query params:
 *   currency  — fiat currency code (NGN, GHS, KES, USD, EUR, GBP …) — required
 *
 * Environment variables required:
 *   FLW_SECRET_KEY — Flutterwave secret key (FLWSECK_TEST-... or FLWSECK-...)
 */

const { verifyCaller } = require('./_verify-auth');

const FLW_BASE    = 'https://api.flutterwave.com/v3';
const STRIPE_BASE = 'https://api.stripe.com/v1';

/**
 * Fetch live USD → targetCurrency FX rate from the appropriate gateway.
 * - Flutterwave currencies  → POST /v3/transfers/rates
 * - Stripe currencies       → GET  /v1/exchange_rates?currency=usd
 * Returns null on any failure (caller should fall back gracefully).
 */
async function fetchGatewayFxRate(currency) {
  currency = currency.toUpperCase();

  // Stripe currencies
  const STRIPE_CURRENCIES_SET = new Set([
    'USD','EUR','GBP','CAD','AUD','NZD','CHF','DKK','NOK','SEK','SGD','HKD',
  ]);
  if (STRIPE_CURRENCIES_SET.has(currency)) {
    if (currency === 'USD') return 1; // no conversion needed
    const stripeKey = process.env.STRIPE_SECRET_KEY;
    if (!stripeKey) return null;
    try {
      const auth = 'Basic ' + Buffer.from(stripeKey + ':').toString('base64');
      const res  = await fetch(`${STRIPE_BASE}/exchange_rates?currency=usd`, {
        headers: { Authorization: auth },
      });
      const data = await res.json().catch(() => ({}));
      // data.rates is an object: { "eur": 0.92, "gbp": 0.79, … }
      const rate = data.rates && data.rates[currency.toLowerCase()];
      return rate ? Number(rate) : null;
    } catch {
      return null;
    }
  }

  // Flutterwave currencies
  const flwKey = process.env.FLW_SECRET_KEY;
  if (!flwKey) return null;
  try {
    // FLW rates endpoint: GET /v3/transfers/rates?amount=1&destination_currency=NGN&source_currency=USD
    const res  = await fetch(
      `${FLW_BASE}/transfers/rates?amount=1&destination_currency=${currency}&source_currency=USD`,
      { headers: { Authorization: `Bearer ${flwKey}` } }
    );
    const data = await res.json().catch(() => ({}));
    // data.data.rate is the units of `currency` you get for 1 USD
    const rate = data.data && data.data.rate;
    return rate ? Number(rate) : null;
  } catch {
    return null;
  }
}

/**
 * Map a currency code to the Flutterwave country code used when
 * looking up banks via GET /v3/banks/:country.
 * Kept identical to the map in create-bank-payout.js so both flows
 * agree on which countries are supported.
 */
const CURRENCY_TO_COUNTRY = {
  NGN: 'NG',
  GHS: 'GH',
  KES: 'KE',
  UGX: 'UG',
  TZS: 'TZ',
  RWF: 'RW',
  ZAR: 'ZA',
  XOF: 'CI',   // Côte d'Ivoire uses XOF
  XAF: 'CM',   // Cameroon uses XAF
  MWK: 'MW',
  ZMW: 'ZM',
  ETB: 'ET',   // Ethiopia
};

/**
 * Stripe-supported international currencies.
 * For these we return stripeFields instead of a bank list —
 * Stripe does not expose a public bank directory like Flutterwave.
 *
 * Each entry describes:
 *   type   — input pattern the frontend should render
 *   fields — ordered list of field IDs the frontend must collect
 *   label  — human-readable description shown to the user
 */
const STRIPE_FIELD_MAP = {
  USD: { type: 'routing_account', fields: ['routingNumber', 'accountNumber'], label: 'Routing number + Account number' },
  CAD: { type: 'routing_account', fields: ['routingNumber', 'accountNumber'], label: 'Institution & transit number + Account number' },
  AUD: { type: 'routing_account', fields: ['routingNumber', 'accountNumber'], label: 'BSB number + Account number' },
  NZD: { type: 'routing_account', fields: ['routingNumber', 'accountNumber'], label: 'Bank branch number + Account number' },
  SGD: { type: 'routing_account', fields: ['routingNumber', 'accountNumber'], label: 'Bank code + Account number' },
  HKD: { type: 'routing_account', fields: ['routingNumber', 'accountNumber'], label: 'Bank code + Account number' },
  GBP: { type: 'sort_account',    fields: ['sortCode',      'accountNumber'], label: 'Sort code + Account number' },
  EUR: { type: 'iban',            fields: ['iban'],                           label: 'IBAN' },
  CHF: { type: 'iban',            fields: ['iban'],                           label: 'IBAN' },
  DKK: { type: 'iban',            fields: ['iban'],                           label: 'IBAN' },
  NOK: { type: 'iban',            fields: ['iban'],                           label: 'IBAN' },
  SEK: { type: 'iban',            fields: ['iban'],                           label: 'IBAN' },
};

const STRIPE_CURRENCIES = Object.keys(STRIPE_FIELD_MAP);

exports.handler = async function (event) {
  const CORS = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed.' }) };
  }

  /* ── Verify caller identity ── */
  const callerUid = await verifyCaller(event);
  if (!callerUid) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Unauthorized. Please log in again.' }) };
  }

  const currency = ((event.queryStringParameters && event.queryStringParameters.currency) || 'NGN')
    .toUpperCase()
    .trim();

  /* ── Stripe international currencies — return field descriptor, no bank list ── */
  if (STRIPE_CURRENCIES.includes(currency)) {
    const stripeFields = STRIPE_FIELD_MAP[currency];
    // Always fetch live rate so the frontend can display/use the converted amount
    const fxRate = await fetchGatewayFxRate(currency);
    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        banks:        [],
        currency,
        stripeFields,
        fxRate,        // USD → currency rate from Stripe (null if unavailable)
        fxSource:      'stripe',
      }),
    };
  }

  /* ── Flutterwave-supported currencies — fetch bank list from FLW ── */
  const countryCode = CURRENCY_TO_COUNTRY[currency];
  if (!countryCode) {
    return {
      statusCode: 400,
      headers: CORS,
      body: JSON.stringify({ error: `Bank transfers are not yet supported for ${currency}.` }),
    };
  }

  const flwKey = process.env.FLW_SECRET_KEY;
  if (!flwKey) {
    console.error('[get-bank-list] FLW_SECRET_KEY not set.');
    return {
      statusCode: 503,
      headers: CORS,
      body: JSON.stringify({ error: 'Bank lookup is temporarily unavailable.' }),
    };
  }

  try {
    const res = await fetch(`${FLW_BASE}/banks/${countryCode}`, {
      headers: { Authorization: `Bearer ${flwKey}` },
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok || data.status !== 'success' || !Array.isArray(data.data)) {
      console.error(
        `[get-bank-list] Flutterwave rejected currency=${currency} country=${countryCode} status=${res.status}:`,
        JSON.stringify(data)
      );
      throw new Error(data.message || `Flutterwave bank list returned status ${res.status}`);
    }

    const banks = data.data
      .map((b) => ({ code: b.code, name: b.name }))
      .filter((b) => b.code && b.name)
      .sort((a, b) => a.name.localeCompare(b.name));

    // Fetch live FLW rate in parallel (best-effort — never blocks bank list)
    const fxRate = await fetchGatewayFxRate(currency).catch(() => null);

    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ banks, currency, country: countryCode, fxRate, fxSource: 'flutterwave' }),
    };
  } catch (err) {
    console.error('[get-bank-list] Failed to fetch bank list:', err.message);
    return {
      statusCode: 502,
      headers: CORS,
      body: JSON.stringify({ error: 'Could not load bank list. Please try again.' }),
    };
  }
};
