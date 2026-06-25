/**
 * create-bank-payout.js — Kreddlo Netlify Function
 *
 * Handles freelancer FIAT (bank) withdrawal requests.
 * Supports multi-currency balances (NGN, USD, GBP, EUR, GHS, KES, ZAR, etc.)
 *
 * Flow:
 *  1. Validate & parse request body (includes withdrawalCurrency)
 *  2. Verify Flutterwave and/or Stripe is enabled in config/platform
 *  3. Verify user exists, is a freelancer, KYC verified, sufficient balance
 *     in the requested currency (reads from user.balances map)
 *  4. Create a /payouts document (type: 'bank', status: 'pending')
 *  5. Atomic balance reservation — deduct BEFORE gateway call so money
 *     is never sent out without the corresponding Firestore debit.
 *     If the transaction fails, the payout is marked 'failed' and we return
 *     early — no real money has moved.
 *  6. Route to Flutterwave or Stripe (or mark pending_manual / pending_review).
 *     If the gateway call throws after the balance is already deducted,
 *     the payout stays in 'pending_review' — the admin team can process it
 *     manually; the balance has been held correctly.
 *     If the entire outer try/catch fires after deduction, a compensating
 *     FieldValue.increment refund is applied so the user is never short.
 *  7. Send a withdrawal confirmation notification
 *  8. Return payout ID + status to the client
 *
 * Environment variables required (set in Netlify dashboard):
 *   FLW_SECRET_KEY            — Flutterwave secret key (FLWSECK_TEST-... or FLWSECK-...)
 *   STRIPE_SECRET_KEY         — Stripe secret key (sk_live_... or sk_test_...)
 *   FIREBASE_SERVICE_ACCOUNT  — Full Firebase service account JSON as one-line string
 *   PLATFORM_URL              — e.g. https://kreddlo.space
 */

const { getSettings }  = require('./get-settings');
const { verifyCaller } = require('./_verify-auth');
const { sanitizeString } = require('./_sanitize');

/* ─────────────────────────────────────────────
   FIREBASE ADMIN (loaded lazily so cold starts
   don't fail if env var is missing in preview)
───────────────────────────────────────────── */
let _db = null;

function getDb() {
  if (_db) return _db;

  const admin = require('firebase-admin');

  if (!admin.apps.length) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
  }

  _db = admin.firestore();
  return _db;
}

/* ─────────────────────────────────────────────
   HELPERS
───────────────────────────────────────────── */

/**
 * Format a number in a given currency using Intl.NumberFormat.
 * Falls back to USD formatting if currency is invalid.
 */
function formatCurrency(amount, currency) {
  try {
    return new Intl.NumberFormat('en', {
      style: 'currency',
      currency: currency || 'USD',
    }).format(Number(amount || 0));
  } catch {
    return '$' + Number(amount || 0).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }
}

/** Mask an account number for display in emails/logs */
function maskAccount(num) {
  if (!num) return '';
  const s = String(num);
  if (s.length <= 4) return s;
  return '••••' + s.slice(-4);
}

const FLW_BASE = 'https://api.flutterwave.com/v3';

/**
 * Currencies Flutterwave can natively transfer to bank accounts.
 * Covers Nigeria, Ghana, Kenya, Uganda, Tanzania, Rwanda, South Africa,
 * Côte d'Ivoire, Senegal, and more.
 * Everything else is routed as pending_manual.
 *
 * Docs: https://developer.flutterwave.com/docs/collecting-payments/transfers
 */
const FLW_TRANSFER_CURRENCIES = [
  'NGN', 'GHS', 'KES', 'UGX', 'TZS', 'RWF',
  'ZAR', 'XOF', 'XAF', 'MWK', 'ZMW',
];

/**
 * Currencies Stripe can natively payout to external bank accounts.
 * Covers major international currencies.
 * Docs: https://stripe.com/docs/payouts
 */
const STRIPE_TRANSFER_CURRENCIES = [
  'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'CHF',
  'DKK', 'NOK', 'SEK', 'NZD', 'SGD', 'HKD',
];

/**
 * Maps a Stripe-supported currency to its bank account country code
 * and the fields required for Stripe bank account tokenization.
 */
const STRIPE_CURRENCY_CONFIG = {
  USD: { country: 'US', currency: 'usd', type: 'routing_account' },
  EUR: { country: 'DE', currency: 'eur', type: 'iban' },        // Generic EU
  GBP: { country: 'GB', currency: 'gbp', type: 'sort_account' },
  CAD: { country: 'CA', currency: 'cad', type: 'routing_account' },
  AUD: { country: 'AU', currency: 'aud', type: 'routing_account' },
  CHF: { country: 'CH', currency: 'chf', type: 'iban' },
  DKK: { country: 'DK', currency: 'dkk', type: 'iban' },
  NOK: { country: 'NO', currency: 'nok', type: 'iban' },
  SEK: { country: 'SE', currency: 'sek', type: 'iban' },
  NZD: { country: 'NZ', currency: 'nzd', type: 'routing_account' },
  SGD: { country: 'SG', currency: 'sgd', type: 'routing_account' },
  HKD: { country: 'HK', currency: 'hkd', type: 'routing_account' },
};

/**
 * Map a currency code to the Flutterwave country code used
 * when looking up banks via GET /v3/banks/:country
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
 * Look up a Flutterwave bank code matching the freeform bank name
 * the freelancer typed in. Uses the currency→country mapping above.
 * Returns null if no confident match is found.
 *
 * Docs: GET /v3/banks/:country
 */
async function findFlutterwaveBankCode(flwKey, bankName, currency) {
  if (!bankName) return null;

  const countryCode = CURRENCY_TO_COUNTRY[(currency || 'NGN').toUpperCase()];
  if (!countryCode) return null;

  const res = await fetch(`${FLW_BASE}/banks/${countryCode}`, {
    headers: { Authorization: `Bearer ${flwKey}` },
  });

  if (!res.ok) {
    throw new Error(`Flutterwave bank lookup returned status ${res.status}`);
  }

  const data = await res.json();
  if (data.status !== 'success' || !Array.isArray(data.data)) return null;

  const needle = bankName.trim().toLowerCase();

  // Exact match first, then "contains" match as a fallback
  let match = data.data.find(b => (b.name || '').toLowerCase() === needle);
  if (!match) {
    match = data.data.find(b =>
      (b.name || '').toLowerCase().includes(needle) ||
      needle.includes((b.name || '').toLowerCase())
    );
  }

  return match ? match.code : null;
}

/**
 * Ask Flutterwave's live rate engine what `amount` of `currency` is worth
 * in `targetCurrency`. Read-only quote — no money moves, and the result is
 * never stored as a trusted rate (Flutterwave re-applies its own live rate
 * at execution time inside initiateFlutterwaveTransfer).
 *
 * This exists because Flutterwave's /v3/transfers `amount` field is always
 * denominated in the DESTINATION currency — never in whatever currency the
 * freelancer's balance is in. So when withdrawalCurrency !== payoutCurrency,
 * we need to know the destination-currency equivalent before we can tell
 * Flutterwave how much to deliver.
 *
 * Docs: GET /v3/transfers/rates?amount=&destination_currency=&source_currency=
 *   The `amount` query param is always the KNOWN/fixed side — pass it as
 *   `currency`'s amount via destination_currency. `source_currency` is the
 *   currency we want the equivalent value in. The response's
 *   data.source.amount is that equivalent value.
 */
async function getFlutterwaveEquivalentAmount(flwKey, { amount, currency, targetCurrency }) {
  const url = `${FLW_BASE}/transfers/rates?amount=${encodeURIComponent(amount)}` +
              `&destination_currency=${encodeURIComponent(currency)}` +
              `&source_currency=${encodeURIComponent(targetCurrency)}`;

  const res  = await fetch(url, { headers: { Authorization: `Bearer ${flwKey}` } });
  const data = await res.json().catch(() => ({}));

  if (!res.ok || data.status !== 'success' || !data.data || !data.data.source || data.data.source.amount == null) {
    throw new Error(data.message || `Flutterwave rate lookup failed (status ${res.status})`);
  }

  // Round to 2dp — every currency in our FLW_TRANSFER_CURRENCIES list uses 2 decimal places.
  return Math.round(Number(data.data.source.amount) * 100) / 100;
}

/**
 * Initiate a Flutterwave bank transfer.
 * Unlike Paystack, Flutterwave does NOT require a separate recipient creation
 * step — bank details are sent directly in the transfer request.
 * Amount is in the base currency unit (no kobo/smallest-unit conversion needed).
 *
 * Docs: POST /v3/transfers
 */
async function initiateFlutterwaveTransfer(flwKey, {
  amountLocal,
  currency,
  debitCurrency,
  accountNumber,
  accountName,
  bankCode,
  bankName,
  narration,
  reference,
}) {
  /*
   * debit_currency tells Flutterwave which of YOUR wallet balances to debit —
   * this should be settings.flutterwaveSettlementCurrency, i.e. whatever
   * currency your Flutterwave wallet is actually funded in (default NGN),
   * NOT necessarily the freelancer's balance bucket. When it differs from
   * `currency` (the destination the beneficiary receives), Flutterwave
   * performs the FX conversion natively on their side and guarantees the
   * destination amount. We never compute or send our own rate for THIS leg.
   * (Separately, getFlutterwaveEquivalentAmount() handles the read-only
   * quote needed to size `amount` correctly when the freelancer's balance
   * currency differs from the payout currency — see call site below.)
   * Docs: https://developer.flutterwave.com/docs/transfers
   */
  const res = await fetch(`${FLW_BASE}/transfers`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization:  `Bearer ${flwKey}`,
    },
    body: JSON.stringify({
      account_bank:    bankCode,
      account_number:  accountNumber,
      amount:          amountLocal,   // Flutterwave accepts full decimal, not smallest unit
      narration:       narration || 'Kreddlo withdrawal',
      currency:        (currency || 'NGN').toUpperCase(),
      debit_currency:  (debitCurrency || currency || 'NGN').toUpperCase(),
      reference,
      beneficiary_name: accountName,
      meta: [
        { metaname: 'bankName', metavalue: bankName },
        { metaname: 'platform', metavalue: 'kreddlo' },
      ],
    }),
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok || data.status !== 'success') {
    throw new Error(data.message || `Flutterwave transfer failed (status ${res.status})`);
  }

  return {
    transferId:   data.data.id           || null,
    flwRef:       data.data.reference    || reference,
    flwStatus:    data.data.status       || 'NEW',
  };
}

/**
 * Initiate a Stripe bank transfer to an external bank account.
 *
 * Flow:
 *  1. Create a Stripe bank account token from the supplied bank details
 *     (routing + account for USD/CAD/AUD/NZD/SGD/HKD,
 *      sort code + account for GBP,
 *      IBAN for EUR/CHF/DKK/NOK/SEK)
 *  2. The token contains the validated bank_name from Stripe
 *  3. Create a Stripe Payout to the external account using the token
 *
 * Note: Stripe Payouts require the platform to have a Stripe Connect
 * account or a positive Stripe balance in the payout currency.
 *
 * Docs:
 *   POST /v1/tokens     — https://stripe.com/docs/api/tokens/create_bank_account
 *   POST /v1/payouts    — https://stripe.com/docs/api/payouts/create
 */
async function initiateStripeTransfer(stripeKey, {
  amountLocal,
  currency,
  accountNumber,
  accountName,
  routingNumber,   // USD/CAD/AUD/NZD/SGD/HKD: ABA/BSB/transit routing number
  sortCode,        // GBP: sort code (6 digits, no dashes)
  iban,            // EUR/CHF/DKK/NOK/SEK: full IBAN
  bankName,
  reference,
}) {
  const cfg = STRIPE_CURRENCY_CONFIG[currency.toUpperCase()];
  if (!cfg) {
    throw new Error(`No Stripe config for currency: ${currency}`);
  }

  const STRIPE_API = 'https://api.stripe.com/v1';
  const authHeader = 'Basic ' + Buffer.from(stripeKey + ':').toString('base64');

  /* ── Step 1: Create bank account token ── */
  const tokenParams = new URLSearchParams();
  tokenParams.append('bank_account[country]',       cfg.country);
  tokenParams.append('bank_account[currency]',       cfg.currency);
  tokenParams.append('bank_account[account_holder_name]', accountName);
  tokenParams.append('bank_account[account_holder_type]', 'individual');

  if (cfg.type === 'iban') {
    // EUR, CHF, DKK, NOK, SEK — IBAN-based
    tokenParams.append('bank_account[account_number]', iban || accountNumber);
  } else if (cfg.type === 'sort_account') {
    // GBP — sort code + account number
    const cleanSort = (sortCode || '').replace(/[-\s]/g, '');
    tokenParams.append('bank_account[routing_number]', cleanSort);
    tokenParams.append('bank_account[account_number]', accountNumber);
  } else {
    // USD/CAD/AUD/NZD/SGD/HKD — routing number + account number
    if (routingNumber) {
      tokenParams.append('bank_account[routing_number]', routingNumber);
    }
    tokenParams.append('bank_account[account_number]', accountNumber);
  }

  const tokenRes = await fetch(`${STRIPE_API}/tokens`, {
    method: 'POST',
    headers: {
      'Authorization': authHeader,
      'Content-Type':  'application/x-www-form-urlencoded',
    },
    body: tokenParams.toString(),
  });

  const tokenData = await tokenRes.json().catch(() => ({}));

  if (!tokenRes.ok || tokenData.error) {
    const errMsg = tokenData.error?.message || `Stripe token creation failed (status ${tokenRes.status})`;
    throw new Error(errMsg);
  }

  const stripeToken  = tokenData.id;
  const stripeBankName = tokenData.bank_account?.bank_name || bankName;

  /* ── Step 2: Create Stripe Payout ── */
  // Stripe amounts are in the smallest currency unit (cents for USD/EUR/GBP, etc.)
  // Most Stripe-supported currencies use 2 decimal places (100 cents = 1 unit)
  // Exceptions: JPY, KRW, etc. (0 decimal). All currencies in our list use 2.
  const amountInSmallestUnit = Math.round(amountLocal * 100);

  const payoutParams = new URLSearchParams();
  payoutParams.append('amount',      amountInSmallestUnit);
  payoutParams.append('currency',    cfg.currency);
  payoutParams.append('method',      'standard');
  payoutParams.append('description', `Kreddlo withdrawal ${reference}`);
  payoutParams.append('statement_descriptor', 'KREDDLO');
  payoutParams.append('destination', stripeToken);
  payoutParams.append('metadata[reference]',  reference);
  payoutParams.append('metadata[platform]',   'kreddlo');
  payoutParams.append('metadata[recipient]',  accountName);

  const payoutRes = await fetch(`${STRIPE_API}/payouts`, {
    method: 'POST',
    headers: {
      'Authorization': authHeader,
      'Content-Type':  'application/x-www-form-urlencoded',
    },
    body: payoutParams.toString(),
  });

  const payoutData = await payoutRes.json().catch(() => ({}));

  if (!payoutRes.ok || payoutData.error) {
    const errMsg = payoutData.error?.message || `Stripe payout failed (status ${payoutRes.status})`;
    throw new Error(errMsg);
  }

  return {
    transferId:    payoutData.id                   || null,
    stripeRef:     payoutData.balance_transaction  || reference,
    stripeStatus:  payoutData.status               || 'pending',
    stripeBankName,
  };
}

/* ─────────────────────────────────────────────
   MAIN HANDLER
───────────────────────────────────────────── */
exports.handler = async function (event) {
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

  /* ── Only allow POST ── */
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed.' }) };
  }

  /* ── Verify caller identity ── */
  const callerUid = await verifyCaller(event);
  if (!callerUid) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized. Please log in again.' }) };
  }

  /* ── Parse body ── */
  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body.' }) };
  }

  const {
    uid: _bodyUid,      // ignored — we use the verified caller uid
    amount,             // amount in the BALANCE currency being withdrawn (always — see below)
    withdrawalCurrency, // which balance bucket to debit (NGN, USD, GBP, etc.)
    payoutCurrency,     // optional: currency the beneficiary's bank account receives, if
                         // different from withdrawalCurrency. Flutterwave converts natively.
    accountName,
    accountNumber,
    bankName,
    bankCode,           // client-supplied Flutterwave bank code (bypasses fuzzy lookup)
    routingNumber,      // Stripe USD/CAD/AUD: ABA routing number
    sortCode,           // Stripe GBP: sort code (6 digits)
    iban,               // Stripe EUR/CHF/DKK/NOK/SEK: full IBAN
    saveDetails,        // boolean — save bank details for future withdrawals
    fees,               // { platformFee }
  } = payload;

  // Always use the token-verified uid, not the client-supplied one
  const uid = callerUid;

  /* ── Sanitize free-text bank detail fields ── */
  const rawAccountName   = accountName;
  const rawAccountNumber = accountNumber;
  const rawBankName      = bankName;
  const safeAccountName   = sanitizeString(rawAccountName,   100);
  const safeAccountNumber = sanitizeString(rawAccountNumber, 30);
  const safeBankName      = sanitizeString(rawBankName,      100);

  /* ── Normalise currency ── */
  const currency = (withdrawalCurrency || 'USD').toUpperCase().trim();

  /*
   * Currency model (Option C — gateway-native conversion only):
   *
   *   withdrawalCurrency — which balance bucket gets debited. `amount` is
   *   ALWAYS denominated in this currency and is the EXACT amount debited.
   *   There is no client-supplied exchange rate anywhere in this flow.
   *
   *   payoutCurrency (optional) — if the freelancer's bank account is in a
   *   different currency than their balance (e.g. balance is USD, bank
   *   account is NGN), we still debit `amount` of `withdrawalCurrency`
   *   exactly as entered, but tell Flutterwave to deliver in payoutCurrency.
   *   Flutterwave performs the conversion on their side and guarantees the
   *   destination amount — we never compute, store, or trust a rate.
   *
   * This means: debitAmountLocal === amountLocal, always. No division by
   * a client rate, no drift between what we debit and what we send.
   */
  const debitCurrency = currency; // the balance bucket — always equals withdrawalCurrency
  const payoutCurrencyNormalized = payoutCurrency
    ? payoutCurrency.toUpperCase().trim()
    : currency;
  const isCrossCurrency = payoutCurrencyNormalized !== currency;

  /* ── Basic input validation ── */
  if (!uid || typeof uid !== 'string') {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing user ID.' }) };
  }
  if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid withdrawal amount.' }) };
  }
  if (!safeAccountName) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Account holder name is required.' }) };
  }
  if (!safeAccountNumber && !iban) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Bank account number or IBAN is required.' }) };
  }
  const isStripeCurrency = STRIPE_TRANSFER_CURRENCIES.includes(payoutCurrencyNormalized);
  if (!safeBankName) {
    // For Stripe IBAN currencies, bank name is resolved from token — not required from client
    const ibanCurrency = isStripeCurrency && STRIPE_CURRENCY_CONFIG[payoutCurrencyNormalized]?.type === 'iban';
    if (!ibanCurrency) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Bank name is required.' }) };
    }
  }

  const amountLocal = Number(amount);

  // Fix 12: track whether balance has been deducted so the outer catch
  // can issue a compensating refund if a catastrophic error fires after deduction.
  let balanceAlreadyDeducted = false;

  try {
    const db         = getDb();
    const settings   = await getSettings(db);
    const FieldValue = require('firebase-admin').firestore.FieldValue;

    /* ── Fiat payouts must be enabled by an admin ── */
    if (!settings.flutterwaveEnabled && !settings.stripeEnabled) {
      return { statusCode: 403, body: JSON.stringify({ error: 'Bank withdrawals are not currently enabled.' }) };
    }

    /* ────────────────────────────────────────
       STEP 1 — Pre-flight: verify user exists, role, KYC
       (outside transaction — read-only, fail fast)
    ──────────────────────────────────────── */
    const userRef  = db.collection('users').doc(uid);
    const userSnap = await userRef.get();

    if (!userSnap.exists) {
      return { statusCode: 404, body: JSON.stringify({ error: 'User not found.' }) };
    }

    const userData = userSnap.data();

    if (userData.role !== 'freelancer') {
      return { statusCode: 403, body: JSON.stringify({ error: 'Only freelancers can withdraw funds.' }) };
    }

    if (userData.kycStatus !== 'verified') {
      return { statusCode: 403, body: JSON.stringify({ error: 'KYC verification required before withdrawing.' }) };
    }

    if (userData.payoutsFrozen === true) {
      return { statusCode: 403, body: JSON.stringify({ error: 'Withdrawals are temporarily paused on your account. Please contact support.' }) };
    }

    /* ────────────────────────────────────────
       STEP 1a — OTP verification gate (FIX)
       Server-side enforcement of the 2FA step. Previously a valid Firebase
       auth token alone was enough to call this function and withdraw funds
       — the OTP step lived entirely in the frontend and was trivially
       bypassable. withdrawalOtpVerifiedAt is written by
       verify-withdrawal-otp.js on success and must be within the last 5
       minutes; it is cleared after a successful payout (see STEP 3
       transaction below) so one verification cannot be reused for
       multiple withdrawals.
    ──────────────────────────────────────── */
    {
      const otpVerifiedAt = userData.withdrawalOtpVerifiedAt
        ? (userData.withdrawalOtpVerifiedAt.toDate
            ? userData.withdrawalOtpVerifiedAt.toDate()
            : new Date(userData.withdrawalOtpVerifiedAt))
        : null;

      const OTP_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
      if (!userData.withdrawalOtpUsed || !otpVerifiedAt || (Date.now() - otpVerifiedAt.getTime()) > OTP_WINDOW_MS) {
        return {
          statusCode: 403,
          body: JSON.stringify({ error: 'Withdrawal requires OTP verification. Please verify your identity and try again.' }),
        };
      }
    }

    /* ── Quick pre-flight balance check (non-transactional — re-checked inside tx below) ── */
    const preflightBalances = userData.balances || {};
    if (!Object.keys(preflightBalances).length && userData.availableBalance) {
      preflightBalances['USD'] = Number(userData.availableBalance || 0);
    }

    // The balance bucket debited is always exactly `amountLocal` of
    // `debitCurrency` — no derived/converted amount, ever.
    const debitAmountLocal = amountLocal;

    if (Number(preflightBalances[debitCurrency] || 0) < debitAmountLocal) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: `Insufficient ${debitCurrency} balance. Available: ${formatCurrency(Number(preflightBalances[debitCurrency] || 0), debitCurrency)}, Requested: ${formatCurrency(debitAmountLocal, debitCurrency)}.`,
        }),
      };
    }

    /* ────────────────────────────────────────
       STEP 1b — Server-side fee validation
       Load expected platform fee rate from Firestore config,
       apply Pro rate if applicable, reject if client fee is manipulated.
    ──────────────────────────────────────── */
    let expectedFeePct = 1.5; // safe default
    let expectedPlatformFee = 0;
    {
      try {
        const cfgSnap = await db.collection('config').doc('platform').get();
        if (cfgSnap.exists) {
          const cfgData = cfgSnap.data();
          if (typeof cfgData.withdrawalFeePercent === 'number') {
            expectedFeePct = cfgData.withdrawalFeePercent;
          }
          // Pro users get a reduced fee rate
          const isPro = userData.plan === 'pro' && userData.premiumStatus === 'active';
          if (isPro && typeof cfgData.withdrawalFeePercentPro === 'number') {
            expectedFeePct = cfgData.withdrawalFeePercentPro;
          }
        }
      } catch (cfgErr) {
        console.warn('[create-bank-payout] Could not load fee config, using default:', cfgErr.message);
      }

      expectedPlatformFee = +(amountLocal * (expectedFeePct / 100)).toFixed(2);
      const clientPlatformFee = Number(fees?.platformFee || 0);

      if (clientPlatformFee < expectedPlatformFee * 0.95) {
        return {
          statusCode: 400,
          body: JSON.stringify({ error: 'Invalid fee calculation. Please refresh and try again.' }),
        };
      }
    }

    /* ────────────────────────────────────────
       STEP 2 — Create payout document (status: pending)
    ──────────────────────────────────────── */
    // FIX: previously the validated platformFee was only stored for display/
    // audit purposes — the full gross amountLocal was both debited from the
    // freelancer's balance AND sent to their bank, so the withdrawal fee was
    // never actually collected. We now always use the server-computed
    // expectedPlatformFee (never the client-supplied value) as the
    // authoritative fee, and net it out of the amount actually transferred.
    // The balance debit stays at the full amountLocal — that's the freelancer's
    // requested withdrawal from their earnings; the fee comes out of the
    // payout they receive, same as the crypto path in create-payout.js.
    const platformFee = expectedPlatformFee;
    const netPayoutAmount = +(amountLocal - platformFee).toFixed(2);
    if (netPayoutAmount <= 0) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Withdrawal amount is too small to cover the platform fee.' }),
      };
    }

    const bankDetails = {
      accountName:   safeAccountName,
      accountNumber: safeAccountNumber,
      bankName:      safeBankName,
      // Country is no longer collected from the user (Bug 5 simplification).
      // Derived from the withdrawal currency for routing/record-keeping until
      // the dynamic Flutterwave bank picker (Bug 6) supplies it directly.
      country:       CURRENCY_TO_COUNTRY[payoutCurrencyNormalized] || STRIPE_CURRENCY_CONFIG[payoutCurrencyNormalized]?.country || '',
      // Stripe-specific fields (populated for international currencies)
      ...(routingNumber ? { routingNumber: routingNumber.trim() } : {}),
      ...(sortCode      ? { sortCode: sortCode.replace(/[-\s]/g, '') } : {}),
      ...(iban          ? { iban: iban.trim().toUpperCase() } : {}),
      ...(bankCode      ? { bankCode: bankCode.trim() } : {}),
    };

    // Fix 16 (low severity) — log a warning if the submitted accountName
    // doesn't match the name last independently resolved via
    // resolve-bank-account.js. Non-blocking — Flutterwave/Stripe route
    // transfers by account number/bank code, not name, and a mismatch could
    // just be a legitimate nickname difference (e.g. "John Doe" vs
    // "JOHN DOE ENTERPRISES"). This gives an audit trail in logs without
    // rejecting a legitimate withdrawal.
    if (userData.lastResolvedAccountName && bankDetails.accountName &&
        userData.lastResolvedAccountName.toLowerCase().trim() !==
        bankDetails.accountName.toLowerCase().trim()) {
      console.warn(`[create-bank-payout] accountName mismatch for uid ${uid}: ` +
        `submitted="${bankDetails.accountName}", resolved="${userData.lastResolvedAccountName}". ` +
        `Proceeding — transfer routes by account number, not name.`);
    }

    const payoutData = {
      userUid:   uid,
      userName:  userData.name  || '',
      userEmail: userData.email || '',
      amount:    amountLocal,
      // The actual amount transferred to the freelancer's bank account,
      // after the platform withdrawal fee is deducted. amount above stays
      // the gross figure debited from their balance (matches create-payout.js's
      // amount/amountCoin split for crypto withdrawals).
      netAmount: netPayoutAmount,
      currency,
      // Cross-currency audit trail — records INTENT only. The actual rate
      // applied lives on the Flutterwave transfer object (flwRef), fetched
      // post-execution if needed. We never store a client- or server-
      // computed rate here, since none was used in the debit math.
      ...(isCrossCurrency ? {
        debitCurrency:   debitCurrency,
        debitAmount:     amountLocal,
        payoutCurrency:  payoutCurrencyNormalized,
        fxSource:        'gateway-native', // converted by Flutterwave at execution time
      } : {}),
      type:      'bank',
      method:    null,   // set below: 'flutterwave', 'pending_manual', or 'manual'
      bankDetails,
      fees: {
        platformFee,
      },
      status:    'pending',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const payoutRef = await db.collection('payouts').add(payoutData);
    const payoutId  = payoutRef.id;

    /* ────────────────────────────────────────
       STEP 3 — Atomic balance reservation (Fix 12: moved BEFORE gateway call)
       Re-reads balance inside transaction to prevent race conditions.
       If this fails, we return early — no real money has moved yet.
    ──────────────────────────────────────── */
    let newCurrencyBalance;
    try {
      await db.runTransaction(async (tx) => {
        const freshSnap     = await tx.get(userRef);
        const freshData     = freshSnap.data();

        /*
         * RACE-CONDITION FIX — re-verify the OTP is still unused INSIDE this
         * same atomic transaction. See the identical fix (and full
         * rationale) in create-payout.js — without this, two concurrent
         * requests could both pass the pre-flight OTP check (STEP 1a above)
         * before either commits, and both would then succeed here since
         * only balance sufficiency was being re-checked. Firestore
         * serializes transactions per-document, so re-checking here means
         * only the first request to commit can ever consume this OTP.
         */
        const freshOtpVerifiedAt = freshData.withdrawalOtpVerifiedAt
          ? (freshData.withdrawalOtpVerifiedAt.toDate
              ? freshData.withdrawalOtpVerifiedAt.toDate()
              : new Date(freshData.withdrawalOtpVerifiedAt))
          : null;
        const OTP_WINDOW_MS_TX = 5 * 60 * 1000; // 5 minutes — matches STEP 1a
        if (!freshData.withdrawalOtpUsed || !freshOtpVerifiedAt || (Date.now() - freshOtpVerifiedAt.getTime()) > OTP_WINDOW_MS_TX) {
          const err = new Error(
            'This withdrawal has already been processed, or your verification has expired. Please verify your identity again to submit a new withdrawal.'
          );
          err.statusCode = 409;
          throw err;
        }

        const freshBalances = freshData.balances || {};
        if (!Object.keys(freshBalances).length && freshData.availableBalance) {
          freshBalances['USD'] = Number(freshData.availableBalance || 0);
        }
        const bucketBalance = Number(freshBalances[debitCurrency] || 0);

        if (bucketBalance < debitAmountLocal) {
          const err = new Error(
            `Insufficient ${debitCurrency} balance. Available: ${formatCurrency(bucketBalance, debitCurrency)}, Requested: ${formatCurrency(debitAmountLocal, debitCurrency)}.`
          );
          err.statusCode = 400;
          throw err;
        }

        newCurrencyBalance = Math.max(0, bucketBalance - debitAmountLocal);

        const txUpdate = {
          [`balances.${debitCurrency}`]: FieldValue.increment(-debitAmountLocal),
          totalWithdrawn:                FieldValue.increment(debitAmountLocal),
          updatedAt:                     new Date(),
          // Part C of the OTP fix — consume the verification on success so
          // it can't be replayed for a second withdrawal.
          withdrawalOtpUsed:             FieldValue.delete(),
          withdrawalOtpVerifiedAt:       FieldValue.delete(),
        };
        // Keep legacy availableBalance in sync if debiting USD
        if (debitCurrency === 'USD') {
          txUpdate.availableBalance = Math.max(0, Number(freshData.availableBalance || 0) - debitAmountLocal);
        }
        if (saveDetails) {
          txUpdate.bankDetails = bankDetails;
        }
        tx.update(userRef, txUpdate);
      });

      // Balance is now safely held in Firestore — set flag for outer catch
      balanceAlreadyDeducted = true;

    } catch (txErr) {
      // Transaction failed — no balance was deducted, no money has moved.
      // Mark the payout doc failed and return early.
      await payoutRef.update({ status: 'failed', errorMsg: txErr.message, updatedAt: new Date() });
      const sc = txErr.statusCode || 500;
      return { statusCode: sc, body: JSON.stringify({ error: txErr.message }) };
    }

    /* ────────────────────────────────────────
       STEP 4 — Route to Flutterwave or mark for manual processing
       (Fix 12: was STEP 3 — balance is already reserved above before we
       attempt any real-money gateway call)

       Flutterwave supports automated transfers for NGN, GHS, KES, UGX,
       TZS, RWF, ZAR, XOF, XAF, MWK, ZMW.
       All other currencies (USD, EUR, GBP, etc.) are flagged as
       pending_manual for wire/SWIFT processing by the team.

       If any gateway call below throws after balance deduction, the payout
       stays pending_review — the admin team processes it manually and the
       balance has already been correctly held.
    ──────────────────────────────────────── */
    let method        = 'manual';
    let payoutStatus  = 'pending_review';
    let transferId    = null;
    let flwRef        = null;
    let stripeRef     = null;
    let flwSettlementCurrency = null; // which FLW wallet actually funded this payout
    let flwPayoutAmount       = null; // the amount actually delivered, in payoutCurrency
    let resultMessage = `Bank transfer request of ${formatCurrency(netPayoutAmount, payoutCurrencyNormalized)} (after fees) received. Our team will process this within 1-3 business days.`;

    // Routing decisions (which gateway, which bank network) are based on
    // payoutCurrencyNormalized — the currency the BENEFICIARY BANK receives —
    // not the balance bucket being debited. These can differ (cross-currency).
    const isFlwCurrency    = FLW_TRANSFER_CURRENCIES.includes(payoutCurrencyNormalized);
    const flwKey           = process.env.FLW_SECRET_KEY;
    const stripeKey        = process.env.STRIPE_SECRET_KEY;

    if (isFlwCurrency && settings.flutterwaveEnabled && flwKey) {
      /* ── Attempt automated Flutterwave transfer for supported currencies ── */
      try {
        /*
         * Bug A3 fix: use client-supplied bankCode directly if provided,
         * only fall back to fuzzy name lookup if bankCode is absent.
         */
        let resolvedBankCode = bankDetails.bankCode || null;
        if (!resolvedBankCode) {
          resolvedBankCode = await findFlutterwaveBankCode(flwKey, bankDetails.bankName, payoutCurrencyNormalized);
        }

        if (resolvedBankCode) {
          /*
           * Fix: fund the transfer from settings.flutterwaveSettlementCurrency
           * (the wallet your FLW account is actually loaded with — default
           * NGN) instead of debitCurrency (the freelancer's balance bucket).
           * These were previously the same thing, which meant any withdrawal
           * from a balance currency your FLW wallet doesn't hold funds in
           * (e.g. USD) would fail even though your NGN wallet was fine.
           * The Firestore debit below is unaffected either way — it never
           * reads debit_currency, only debitCurrency/amountLocal.
           */
          const settlementCurrency = FLW_TRANSFER_CURRENCIES.includes((settings.flutterwaveSettlementCurrency || '').toUpperCase())
            ? settings.flutterwaveSettlementCurrency.toUpperCase()
            : 'NGN';

          /*
           * Fix: Flutterwave's `amount` field is denominated in the
           * DESTINATION currency, not the freelancer's balance currency.
           * When they differ, quote the equivalent value via Flutterwave's
           * own rate engine before calling /v3/transfers — otherwise the
           * beneficiary would receive `amountLocal` units of the WRONG
           * currency (e.g. "1" interpreted as ₦1 instead of $1 worth of ₦).
           */
          let flwAmount = netPayoutAmount;
          if (isCrossCurrency) {
            flwAmount = await getFlutterwaveEquivalentAmount(flwKey, {
              amount:         netPayoutAmount,            // fee-deducted amount, in the freelancer's balance currency
              currency:       debitCurrency,              // ...denominated in their balance currency
              targetCurrency: payoutCurrencyNormalized,    // we need the equivalent in the payout currency
            });

            /*
             * Fix C — FX payout cap: independently verify the FLW quoted amount
             * against a Frankfurter spot rate ceiling. This prevents overpayment
             * in the event the FLW quote is stale, mis-directed, or the rate has
             * moved significantly since collection time.
             *
             * The cap is: maxPayoutAmount = netPayoutAmount * spotRate * (1 + capBuffer)
             *
             * capBuffer now tracks settings.platformFxBuffer (config/platform,
             * admin-configurable) instead of a hardcoded 3%. Rationale: a fixed
             * 3% tolerance only catches a misquoted/stale FLW rate — it does
             * NOT protect against a genuine, legitimate market move (e.g. NGN
             * depreciating 5% between charge time and payout time), because a
             * real depreciation produces a correctly-quoted amount that simply
             * exceeds what was collected for. The same platformFxBuffer that
             * pads the charge-time conversion (create-stripe-payment.js,
             * create-product-order.js, create-invoice-order.js) is the
             * platform's actual margin against rate drift, so the payout-side
             * cap should be bounded by that same number, not a separate
             * hardcoded constant the admin can't see or change.
             *
             * If platformFxBuffer is unset/0 (default, no admin config yet),
             * fall back to 1% — tight enough to still catch real drift instead
             * of silently allowing the old 3% blind spot, while keeping a
             * small allowance for normal Frankfurter/Flutterwave quote noise.
             *
             * This only applies to cross-currency withdrawals (e.g. USD → NGN).
             * Same-currency withdrawals are unaffected.
             */
            try {
              const frankfurterRes = await fetch(
                `https://api.frankfurter.app/latest?from=${encodeURIComponent(debitCurrency)}&to=${encodeURIComponent(payoutCurrencyNormalized)}`
              );
              if (frankfurterRes.ok) {
                const fxData = await frankfurterRes.json();
                const spotRate = fxData?.rates?.[payoutCurrencyNormalized];
                if (spotRate && !isNaN(Number(spotRate))) {
                  const CAP_BUFFER_PCT = (typeof settings.platformFxBuffer === 'number' && settings.platformFxBuffer > 0)
                    ? settings.platformFxBuffer  // admin-configured margin, e.g. 1.5 = 1.5%
                    : 1;                          // safe default if unset — was 3, tightened per Fix C-2
                  const maxPayoutAmount = netPayoutAmount * Number(spotRate) * (1 + CAP_BUFFER_PCT / 100);
                  if (flwAmount > maxPayoutAmount) {
                    console.error(
                      `[create-bank-payout] Fix C — FLW quote (${flwAmount} ${payoutCurrencyNormalized}) exceeds ` +
                      `spot-rate ceiling (${maxPayoutAmount.toFixed(2)} ${payoutCurrencyNormalized}, spot: ${spotRate}, ` +
                      `buffer: ${CAP_BUFFER_PCT}%) for uid ${uid}. Blocking payout — falling to pending_review.`
                    );
                    // Don't throw — fall through to pending_review which is already the default.
                    // Balance is held; team reconciles manually and can re-issue at the correct rate.
                    flwAmount = null; // sentinel: skip FLW transfer below
                  } else {
                    console.log(
                      `[create-bank-payout] Fix C cap check passed — FLW quote: ${flwAmount} ${payoutCurrencyNormalized}, ` +
                      `spot ceiling: ${maxPayoutAmount.toFixed(2)} ${payoutCurrencyNormalized}`
                    );
                  }
                }
              }
            } catch (capErr) {
              // Non-fatal — if Frankfurter is unreachable, proceed with FLW quote as-is.
              // The rate divergence risk is low on any single transaction.
              console.warn('[create-bank-payout] Fix C cap check: Frankfurter fetch failed (non-fatal):', capErr.message);
            }
          }

          // Fix C — skip transfer if cap check blocked it (flwAmount set to null above)
          if (flwAmount === null) {
            console.warn(`[create-bank-payout] Fix C — skipping FLW transfer for payoutId ${payoutId}; falling to pending_review for manual reconciliation.`);
          } else {
          const transferResult = await initiateFlutterwaveTransfer(flwKey, {
            amountLocal:   flwAmount,
            currency:      payoutCurrencyNormalized, // what the beneficiary bank receives
            debitCurrency: settlementCurrency,        // which of OUR wallets actually funds this —
                                                       // FLW converts natively when this differs
                                                       // from the destination currency
            accountNumber: bankDetails.accountNumber,
            accountName:   bankDetails.accountName,
            bankCode:      resolvedBankCode,
            bankName:      bankDetails.bankName,
            narration:     `Kreddlo withdrawal ${payoutId}`,
            reference:     `kreddlo-${uid}-${payoutId}`,
          });

          method        = 'flutterwave';
          payoutStatus  = 'sent';
          transferId    = transferResult.transferId;
          flwRef        = transferResult.flwRef;
          resultMessage = `Withdrawal of ${formatCurrency(netPayoutAmount, debitCurrency)} (after fees) sent to your bank account.`;

          // Store resolved bankCode + actual funding details for audit trail
          bankDetails.bankCode     = resolvedBankCode;
          flwSettlementCurrency    = settlementCurrency;
          flwPayoutAmount          = flwAmount;

          console.log(`[create-bank-payout] Flutterwave transfer initiated — payoutId: ${payoutId}, transferId: ${transferId}, flwRef: ${flwRef}, fundedFrom: ${settlementCurrency} wallet, delivered: ${flwAmount} ${payoutCurrencyNormalized}`);
          } // end Fix C null guard
        } else {
          /*
           * Bank code lookup returned null — bank name didn't match any
           * bank in the FLW list. Fall through to pending_review.
           * Balance is already deducted — team handles manually.
           */
          console.warn(`[create-bank-payout] Could not match bank "${bankDetails.bankName}" for ${currency} — falling back to pending_review.`);
        }
      } catch (flwErr) {
        console.error('[create-bank-payout] Flutterwave transfer failed, falling back to manual review:', flwErr.message);
        // Falls through — payout is recorded, balance already deducted, team handles manually.
      }

    } else if (
      !isCrossCurrency &&
      STRIPE_TRANSFER_CURRENCIES.includes(payoutCurrencyNormalized) &&
      settings.stripeEnabled && stripeKey
    ) {
      /*
       * Stripe branch is same-currency ONLY. initiateStripeTransfer() pays
       * out of our Stripe balance with no native FX conversion wired in —
       * unlike Flutterwave, there is no debit_currency-equivalent here.
       * Cross-currency requests are routed to pending_manual below instead
       * of silently mismatching debit and payout currencies.
       */
      try {
        const stripeResult = await initiateStripeTransfer(stripeKey, {
          amountLocal: netPayoutAmount,
          currency: payoutCurrencyNormalized,
          accountNumber: bankDetails.accountNumber,
          accountName:   bankDetails.accountName,
          routingNumber: bankDetails.routingNumber || routingNumber || null,
          sortCode:      bankDetails.sortCode      || sortCode      || null,
          iban:          bankDetails.iban          || iban          || null,
          bankName:      bankDetails.bankName,
          reference:     `kreddlo-${uid}-${payoutId}`,
        });

        method        = 'stripe';
        payoutStatus  = 'sent';
        transferId    = stripeResult.transferId;
        stripeRef     = stripeResult.stripeRef;
        resultMessage = `Withdrawal of ${formatCurrency(netPayoutAmount, debitCurrency)} (after fees) sent to your bank account via Stripe.`;

        // Back-fill resolved bank name from Stripe token if we didn't have it
        if (stripeResult.stripeBankName && !bankDetails.bankName) {
          bankDetails.bankName = stripeResult.stripeBankName;
        }

        console.log(`[create-bank-payout] Stripe payout initiated — payoutId: ${payoutId}, stripeId: ${transferId}, stripeRef: ${stripeRef}`);
      } catch (stripeErr) {
        console.error('[create-bank-payout] Stripe payout failed, falling back to pending_manual:', stripeErr.message);
        // Balance already deducted — fall to pending_manual so team processes manually via wire.
        method        = 'pending_manual';
        payoutStatus  = 'pending_manual';
        resultMessage = `Withdrawal of ${formatCurrency(netPayoutAmount, debitCurrency)} (after fees) received. International bank transfers are processed within 2-5 business days.`;
      }

    } else if (isCrossCurrency && !isFlwCurrency) {
      /*
       * Cross-currency requested but the payout currency isn't on
       * Flutterwave's native-conversion list (and Stripe never handles
       * cross-currency here). Queue for manual processing rather than
       * guess at a conversion.
       */
      method        = 'pending_manual';
      payoutStatus  = 'pending_manual';
      resultMessage = `Withdrawal of ${formatCurrency(netPayoutAmount, debitCurrency)} (after fees) received. Cross-currency transfers to ${payoutCurrencyNormalized} are processed manually within 2-5 business days.`;

      console.log(`[create-bank-payout] Cross-currency ${debitCurrency} → ${payoutCurrencyNormalized} for ${uid} — queued as pending_manual (no native conversion route).`);

    } else if (!isFlwCurrency && !STRIPE_TRANSFER_CURRENCIES.includes(payoutCurrencyNormalized)) {
      /* ── Truly unsupported currency — queue for manual wire processing ── */
      method        = 'pending_manual';
      payoutStatus  = 'pending_manual';
      resultMessage = `Withdrawal of ${formatCurrency(netPayoutAmount, debitCurrency)} (after fees) received. International bank transfers are processed manually within 2-5 business days.`;

      console.log(`[create-bank-payout] ${payoutCurrencyNormalized} withdrawal for ${uid} — queued as pending_manual (unsupported currency).`);

    } else {
      /* ── Gateway not enabled or key missing — fallback to pending_manual ── */
      method        = 'pending_manual';
      payoutStatus  = 'pending_manual';
      resultMessage = `Withdrawal of ${formatCurrency(netPayoutAmount, debitCurrency)} (after fees) received. International bank transfers are processed manually within 2-5 business days.`;

      console.log(`[create-bank-payout] ${payoutCurrencyNormalized} withdrawal for ${uid} — gateway not configured, queued as pending_manual.`);
    }

    await payoutRef.update({
      method,
      status:      payoutStatus,
      transferId:  transferId || null,
      flwRef:      flwRef     || null,
      stripeRef:   stripeRef  || null,
      // What actually funded/delivered the Flutterwave payout, for audit —
      // null for non-FLW methods or same-currency transfers with no quote.
      flwSettlementCurrency: flwSettlementCurrency || null,
      flwPayoutAmount:       flwPayoutAmount       || null,
      bankDetails,            // update with any resolved fields (bankCode, stripeBankName)
      // Add a processing note for manual review cases
      ...(method === 'pending_manual' ? {
        note: isCrossCurrency
          ? `Cross-currency transfer (${debitCurrency} balance → ${payoutCurrencyNormalized} bank account) — no native conversion route available; requires manual processing.`
          : STRIPE_TRANSFER_CURRENCIES.includes(payoutCurrencyNormalized)
            ? 'International bank transfer — Stripe gateway not configured; requires manual wire/SWIFT processing.'
            : 'International bank transfer — requires manual processing via wire/SWIFT.',
      } : {}),
      updatedAt: new Date(),
    });

    /* ────────────────────────────────────────
       STEP 5 — Send withdrawal confirmation notification
    ──────────────────────────────────────── */
    try {
      const platformUrl     = (process.env.PLATFORM_URL || 'https://kreddlo.space').replace(/\/$/, '');
      const formattedAmount = formatCurrency(amountLocal, currency);

      await fetch(`${platformUrl}/.netlify/functions/send-smart-notification`, {
        method:  'POST',
        headers: {
          'Content-Type':     'application/json',
          'x-internal-secret': process.env.INTERNAL_FUNCTION_SECRET || '',
        },
        body:    JSON.stringify({
          userUid:    userData.uid || null,
          to:         userData.email || null,
          title:      'Bank Withdrawal Initiated',
          body:       (method === 'flutterwave' || method === 'stripe')
            ? `Your withdrawal of ${formattedAmount} has been sent to your bank account.`
            : `Your withdrawal of ${formattedAmount} has been received and is being processed by our team.`,
          url:        `${platformUrl}/dashboard-withdraw.html`,
          templateId: 'bank-withdrawal-initiated',
          emailMode:  'always',
          // FIX (audit finding N3, follow-on): send-smart-notification.js
          // destructures `emailData` from the payload, not `data` — this was
          // previously sent as `data`, so even with the templateId fixed the
          // email would have rendered with every field at its default
          // ('there', '', '') since emailData defaulted to {}. Must match
          // the field name the receiving function actually reads.
          emailData: {
            name:          userData.name || 'Freelancer',
            amount:        formattedAmount,
            currency,
            bankName:      bankDetails.bankName,
            accountNumber: maskAccount(bankDetails.accountNumber),
            payoutId,
            newBalance:    formatCurrency(newCurrencyBalance, currency),
            date:          new Date().toLocaleDateString('en-US', {
              weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
            }),
          },
        }),
      }).catch(err => {
        console.error('[create-bank-payout] send-smart-notification failed:', err.message);
      });
    } catch (notifyErr) {
      console.error('[create-bank-payout] Notification block error:', notifyErr.message);
    }

    /* ────────────────────────────────────────
       STEP 6 — Return success response
    ──────────────────────────────────────── */
    return {
      statusCode: 200,
      headers: {
        'Content-Type':                'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify({
        success:            true,
        payoutId,
        status:             payoutStatus,
        method,
        currency,
        payoutCurrency:     payoutCurrencyNormalized,
        newCurrencyBalance,
        amount:             amountLocal,
        platformFee,
        netAmount:          netPayoutAmount,
        message:            resultMessage,
      }),
    };

  } catch (err) {
    console.error('[create-bank-payout] Unhandled error:', err);

    // Fix 12: compensating refund — if the balance was already deducted before this
    // unhandled error fired, refund it so the user is never permanently short.
    if (balanceAlreadyDeducted) {
      try {
        const db         = getDb();
        const FieldValue = require('firebase-admin').firestore.FieldValue;
        const debitCurrencyForRefund = (withdrawalCurrency || 'USD').toUpperCase().trim();
        const debitAmountForRefund   = Number(amount);

        // Issue 3 fix — the debit path (inside the Firestore transaction above)
        // decrements BOTH balances.${debitCurrency} AND the legacy availableBalance
        // field when debitCurrency === 'USD', because create-payout.js (crypto
        // withdrawals) reads availableBalance directly for its preflight balance
        // check, and dashboard-withdraw.html falls back to availableBalance for
        // legacy users whose balancesMap is empty.
        //
        // Previously this compensating refund restored balances.USD but never
        // restored availableBalance, leaving it permanently too low after an
        // unhandled error. Effect: a subsequent crypto withdrawal would be refused
        // ("Insufficient balance") even when the user had funds, and the legacy
        // balance display on dashboard.html would show $0 for legacy accounts.
        //
        // Fix: mirror the debit path exactly — restore availableBalance alongside
        // balances.USD whenever the debit currency was USD.
        const refundPayload = {
          [`balances.${debitCurrencyForRefund}`]: FieldValue.increment(debitAmountForRefund),
          totalWithdrawn:                          FieldValue.increment(-debitAmountForRefund),
          updatedAt:                               new Date(),
        };
        if (debitCurrencyForRefund === 'USD') {
          refundPayload.availableBalance = FieldValue.increment(debitAmountForRefund);
        }
        await db.collection('users').doc(uid).update(refundPayload);
        console.warn(`[create-bank-payout] Compensating refund applied for uid ${uid}: +${debitAmountForRefund} ${debitCurrencyForRefund}`);
      } catch (refundErr) {
        console.error('[create-bank-payout] CRITICAL: compensating refund failed — manual reconciliation needed for uid', uid, ':', refundErr.message);
      }
    }

    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'Internal server error. Please try again.' }),
    };
  }
};
