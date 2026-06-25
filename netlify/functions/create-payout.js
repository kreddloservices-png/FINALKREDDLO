/**
 * create-payout.js — Kreddlo Netlify Function
 *
 * Handles freelancer withdrawal requests.
 *
 * Flow:
 *  1. Validate & parse request body
 *  2. Verify user exists + has sufficient availableBalance in Firestore
 *  3. Check our NOWPayments outcome wallet actually holds enough of the
 *     requested coin (PRIORITY 2 FIX — runs before any balance is touched)
 *  4. Call NOWPayments Mass Payout API to send chosen coin to wallet
 *  5. Write payout document to Firestore /payouts collection
 *  6. Deduct amount from user's availableBalance + increment totalWithdrawn
 *  7. Call /send-email function to send withdrawal confirmation email
 *  8. Return payout ID and NOWPayments batch ID to the client
 *
 * Note: steps 5/6 above happen before step 4's NOWPayments call completes —
 * see STEP 2 / the atomic balance-reservation transaction further down for
 * the actual ordering. The numbered list here is a high-level summary.
 *
 * Environment variables required (set in Netlify dashboard):
 *   NOWPAYMENTS_API_KEY       — NOWPayments API key
 *   NOWPAYMENTS_IPN_SECRET    — IPN secret (used for payout HMAC if needed)
 *   FIREBASE_SERVICE_ACCOUNT  — Full Firebase service account JSON as one-line string
 *   PLATFORM_URL              — live domain; used to build the ipn_callback_url
 *                                passed to NOWPayments so payout status updates
 *                                (finished/failed/rejected) reach
 *                                nowpayments-payout-webhook.js. See that file
 *                                for what happens when a payout fails after
 *                                this function has already deducted the balance.
 */

const https = require('https');
const { verifyCaller } = require('./_verify-auth');

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

/** Simple HTTPS POST returning parsed JSON */
function httpsPost(hostname, path, data, headers) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const options = {
      hostname,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...headers,
      },
    };

    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', chunk => (raw += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(raw) });
        } catch (e) {
          resolve({ status: res.statusCode, body: raw });
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/** Simple HTTPS GET returning parsed JSON */
function httpsGet(hostname, path, headers) {
  return new Promise((resolve, reject) => {
    const options = { hostname, path, method: 'GET', headers: headers || {} };
    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', chunk => (raw += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(raw) });
        } catch (e) {
          resolve({ status: res.statusCode, body: raw });
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/*
 * Maps the coin IDs used on the withdraw form to CoinGecko's "simple price"
 * IDs, so the server can independently fetch the same USD price the
 * frontend used to compute its display rate. usdt/usd-coin are treated as
 * pegged 1:1 to USD (matches the frontend's static fallback for stables).
 */
const COINGECKO_ID_MAP = {
  usdt:            'tether',
  bitcoin:         'bitcoin',
  ethereum:        'ethereum',
  binancecoin:     'binancecoin',
  'usd-coin':      'usd-coin',
  litecoin:        'litecoin',
  ripple:          'ripple',
  dogecoin:        'dogecoin',
  solana:          'solana',
  cardano:         'cardano',
  tron:            'tron',
  'matic-network': 'matic-network',
};

/**
 * Fetches the current USD price for a coin from CoinGecko and returns it
 * as "USD per 1 coin unit" (exchangeRate), matching the convention used by
 * the frontend's liveRates object. Returns null if the coin is unknown or
 * the fetch fails — callers must handle that by falling back safely
 * (never by trusting the client's number unchecked).
 */
async function fetchServerExchangeRate(coinId) {
  const geckoId = COINGECKO_ID_MAP[coinId];
  if (!geckoId) return null;

  try {
    const result = await httpsGet(
      'api.coingecko.com',
      `/api/v3/simple/price?ids=${geckoId}&vs_currencies=usd`,
    );
    const usdPrice = result?.body?.[geckoId]?.usd;
    if (!usdPrice || isNaN(Number(usdPrice)) || Number(usdPrice) <= 0) return null;
    return 1 / Number(usdPrice); // USD per 1 coin unit, same convention as frontend
  } catch (err) {
    console.warn('[create-payout] CoinGecko rate fetch failed:', err.message);
    return null;
  }
}

/**
 * Normalises the coin selector down to the exact lowercase ticker that
 * NOWPayments expects for both the /v1/payout request and the /v1/balance
 * lookup, so both call sites can never drift out of sync with each other.
 */
function normalizeNowCurrency(coinId, currency) {
  return (coinId || currency || 'usdttrc20').toLowerCase();
}

/**
 * PRIORITY 2 FIX — checks our NOWPayments outcome wallet actually holds
 * enough of the requested coin BEFORE we touch the user's balance.
 * Docs: GET /v1/balance returns { "<ticker>": { amount, pendingAmount } }.
 * Returns the available `amount` for the coin, or null if the lookup
 * couldn't be completed (unknown ticker, network error, bad response).
 * Callers should fail OPEN on null — the payout webhook refund (Priority 1
 * fix) is still the safety net for an actual failed payout — and fail
 * CLOSED only on a confirmed, explicit insufficient-balance reading.
 */
async function fetchPayoutWalletBalance(nowCurrency) {
  const apiKey = process.env.NOWPAYMENTS_API_KEY;
  if (!apiKey) return null;

  try {
    const result = await httpsGet(
      'api.nowpayments.io',
      '/v1/balance',
      { 'x-api-key': apiKey },
    );
    if (result.status !== 200 || typeof result.body !== 'object' || !result.body) {
      console.warn('[create-payout] NOWPayments balance endpoint returned non-200:', result.status);
      return null;
    }
    const entry = result.body[nowCurrency];
    if (!entry || typeof entry.amount !== 'number' || isNaN(entry.amount)) {
      console.warn(`[create-payout] No usable balance entry for "${nowCurrency}" in /v1/balance response.`);
      return null;
    }
    return Number(entry.amount);
  } catch (err) {
    console.warn('[create-payout] NOWPayments balance fetch failed:', err.message);
    return null;
  }
}

/** Truncate wallet address for display in emails */
function shortWallet(addr) {
  if (!addr || addr.length <= 14) return addr;
  return addr.slice(0, 6) + '...' + addr.slice(-6);
}

/** Format a number as USD string */
function usd(n) {
  return '$' + Number(n || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/* ─────────────────────────────────────────────
   NOWPAYMENTS MASS PAYOUT
   Docs: https://documenter.getpostman.com/view/7907941/2s93JqTRWN
───────────────────────────────────────────── */
async function initiateNowPaymentsPayout({
  walletAddress,
  currency,     // e.g. "USDT", "BTC", "ETH"
  coinId,       // e.g. "trc20", "btc", "eth" — maps to NOWPayments currency code
  amountCoin,   // exact coin amount to send (after all fees)
  uid,          // used as unique_external_id
  payoutDocId,  // Firestore doc ID — used as extra_id for reconciliation
}) {
  const apiKey = process.env.NOWPAYMENTS_API_KEY;
  if (!apiKey) throw new Error('NOWPAYMENTS_API_KEY is not set.');

  /*
   * NOWPayments accepts the currency as the coin ticker symbol in lowercase.
   * The coinId from the frontend (e.g. "trc20", "btc", "eth") maps cleanly
   * to what NOWPayments expects. normalizeNowCurrency() is shared with the
   * Priority 2 wallet balance pre-check so both stay in sync.
   */
  const nowCurrency = normalizeNowCurrency(coinId, currency);

  /*
   * PRIORITY 1 FIX — wire up the payout status webhook.
   * Without ipn_callback_url, NOWPayments never sends payout status
   * updates (FINISHED/FAILED/REJECTED) back to us, so a payout that
   * fails AFTER this API call accepts it goes completely unnoticed —
   * the user's balance stays deducted with no crypto ever received.
   * extra_id (payoutDocId) is echoed back in that callback so
   * nowpayments-payout-webhook.js can find the matching Firestore doc.
   */
  const platformUrl    = (process.env.PLATFORM_URL || 'https://kreddlo.space').replace(/\/$/, '');
  const ipnCallbackUrl = platformUrl
    ? `${platformUrl}/.netlify/functions/nowpayments-payout-webhook`
    : undefined;

  const payload = {
    withdrawals: [
      {
        address:             walletAddress,
        currency:            nowCurrency,
        amount:              amountCoin,
        unique_external_id:  `kreddlo-${uid}-${Date.now()}`,
        extra_id:            payoutDocId || '',
        ipn_callback_url:    ipnCallbackUrl,
      },
    ],
  };

  const result = await httpsPost(
    'api.nowpayments.io',
    '/v1/payout',
    payload,
    { 'x-api-key': apiKey },
  );

  if (result.status !== 200 && result.status !== 201) {
    const errMsg =
      (typeof result.body === 'object' && (result.body.message || result.body.error))
        || `NOWPayments returned status ${result.status}`;
    throw new Error(`NOWPayments error: ${errMsg}`);
  }

  /*
   * Response shape:
   * {
   *   id: "batch_id",
   *   withdrawals: [{ id, status, amount, currency, address, ... }]
   * }
   */
  const batchId      = result.body.id || null;
  const withdrawal   = Array.isArray(result.body.withdrawals) ? result.body.withdrawals[0] : null;
  const withdrawalId = withdrawal?.id || null;
  const nowStatus    = withdrawal?.status || 'WAITING';

  return { batchId, withdrawalId, nowStatus };
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
    uid: _bodyUid,  // ignored — we use the verified caller uid
    amount,         // USD amount the freelancer entered
    amountCoin,     // coin amount after fees (sent to wallet)
    amountUsdt,     // equivalent USDT amount (for records)
    currency,       // coin symbol  — e.g. "USDT", "BTC", "ETH"
    coinId,         // NOWPayments currency id — e.g. "trc20", "btc"
    network,        // network label — e.g. "TRC-20", "Bitcoin"
    walletAddress,
    exchangeRate,   // USD per 1 coin unit
    usdtRate,       // USD per 1 USDT
    fees,           // { nowpaymentsFee, platformFee }
  } = payload;

  // Always use the token-verified uid, not the client-supplied one
  const uid = callerUid;

  /* ── Basic input validation ── */
  if (!uid || typeof uid !== 'string') {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing user ID.' }) };
  }
  if (!amount || isNaN(Number(amount)) || Number(amount) < 10) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Minimum withdrawal amount is $10.00.' }) };
  }
  if (!walletAddress || walletAddress.trim().length < 10) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid wallet address.' }) };
  }
  if (!currency || !coinId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing coin selection.' }) };
  }
  if (!amountCoin || Number(amountCoin) <= 0) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Coin amount must be greater than zero.' }) };
  }

  const amtUsd  = Number(amount);
  let   coinAmt = Number(amountCoin); // may be clamped down by server-side rate validation below

  try {
    const db = getDb();

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

    /* Role check */
    if (userData.role !== 'freelancer') {
      return { statusCode: 403, body: JSON.stringify({ error: 'Only freelancers can withdraw funds.' }) };
    }

    /* KYC check */
    if (userData.kycStatus !== 'verified') {
      return { statusCode: 403, body: JSON.stringify({ error: 'KYC verification required before withdrawing.' }) };
    }

    /* Payout freeze check */
    if (userData.payoutsFrozen === true) {
      return {
        statusCode: 403,
        body: JSON.stringify({ error: 'Withdrawals temporarily paused by platform. Please contact support for assistance.' }),
      };
    }

    /* ────────────────────────────────────────
       STEP 1a — OTP verification gate (FIX)
       Server-side enforcement of the 2FA step. Previously a valid Firebase
       auth token alone was enough to call this function and withdraw funds
       — the OTP step lived entirely in the frontend and was trivially
       bypassable. withdrawalOtpVerifiedAt is written by
       verify-withdrawal-otp.js on success and must be within the last 5
       minutes; it is cleared after a successful payout (see FIX #1
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

    /* ────────────────────────────────────────
       STEP 1b — Server-side fee validation
       Load the expected platform fee rate from Firestore config,
       apply Pro rate if the user has an active Pro plan,
       then reject the request if the client-supplied fee is
       more than 5% below what we expect (manipulation guard).
    ──────────────────────────────────────── */
    {
      let expectedFeePct = 1.5; // safe default
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
        console.warn('[create-payout] Could not load fee config, using default:', cfgErr.message);
      }

      const expectedPlatformFee = amtUsd * (expectedFeePct / 100);
      const clientPlatformFee   = Number(fees?.platformFee || 0);

      if (clientPlatformFee < expectedPlatformFee * 0.95) {
        return {
          statusCode: 400,
          body: JSON.stringify({ error: 'Invalid fee calculation. Please refresh and try again.' }),
        };
      }
    }

    /* ────────────────────────────────────────
       STEP 1c — Server-side coin-amount validation (FIX)
       amountCoin is the exact quantity sent to the freelancer's wallet by
       NOWPayments. Previously it was taken from the request body as-is,
       so a tampered request could deduct the correct USD amount from the
       balance while inflating the actual crypto payout. We independently
       fetch the current USD/coin rate from CoinGecko (the same source the
       frontend uses), recompute the expected coin amount from amtUsd and
       the validated fees, and reject if the client's amountCoin exceeds
       that by more than a small tolerance (covers normal price drift
       between page load and submit). We never trust the client's number
       upward — at most we use it if it's within tolerance, and otherwise
       fall back to the server-computed value when a sane rate is available.
    ──────────────────────────────────────── */
    {
      const serverRate = await fetchServerExchangeRate(coinId);

      if (serverRate) {
        const validatedNowFee  = Number(fees?.nowpaymentsFee || 0);
        const validatedPlatFee = Number(fees?.platformFee || 0);
        const expectedAfterFees = amtUsd - validatedNowFee - validatedPlatFee;
        const expectedCoinAmt   = expectedAfterFees > 0 ? expectedAfterFees * serverRate : 0;

        // Allow 3% tolerance for normal market movement between the user
        // loading the page and submitting the withdrawal.
        const TOLERANCE = 0.03;

        if (expectedCoinAmt <= 0 || coinAmt > expectedCoinAmt * (1 + TOLERANCE)) {
          return {
            statusCode: 400,
            body: JSON.stringify({ error: 'Invalid coin amount. Please refresh and try again.' }),
          };
        }

        // Use the lower (safer) of the two values so a stale-but-valid
        // client rate never results in overpaying the user.
        coinAmt = Math.min(coinAmt, expectedCoinAmt);
      } else {
        // Could not independently verify the rate (CoinGecko unreachable,
        // or coinId not in our map). Fail closed rather than trusting an
        // unverified client-supplied coin amount.
        console.error('[create-payout] Could not verify exchange rate server-side for coinId:', coinId);
        return {
          statusCode: 502,
          body: JSON.stringify({ error: 'Unable to verify current exchange rate. Please try again shortly.' }),
        };
      }
    }

    /* ────────────────────────────────────────
       STEP 1d — Wallet outcome-balance pre-check (PRIORITY 2 FIX)
       Checks our NOWPayments payout wallet actually holds enough of the
       requested coin BEFORE we deduct anything from the user's balance.
       This runs before STEP 2 specifically so a known-insufficient wallet
       never causes a balance deduction in the first place — sparing the
       user the deduct/refund round-trip the Priority 1 webhook handles
       for payouts that fail *after* being accepted by NOWPayments.
       Fails OPEN (lets the request proceed) if the check itself can't be
       completed — the webhook refund safety net still covers that case —
       and fails CLOSED only on a confirmed insufficient reading.
    ──────────────────────────────────────── */
    {
      const nowCurrencyForCheck = normalizeNowCurrency(coinId, currency);
      const walletBalance = await fetchPayoutWalletBalance(nowCurrencyForCheck);

      if (walletBalance !== null && walletBalance < coinAmt) {
        console.error(
          `[create-payout] Insufficient payout wallet balance for "${nowCurrencyForCheck}". ` +
          `Have: ${walletBalance}, need: ${coinAmt}.`
        );
        return {
          statusCode: 503,
          body: JSON.stringify({
            error: `Withdrawals in ${currency.toUpperCase()} are temporarily unavailable. Please try a different coin or contact support.`,
          }),
        };
      }
    }

    /* ────────────────────────────────────────
       STEP 2 — Create payout document (status: pending)
       Created OUTSIDE the transaction so we have a doc ID
       to pass to NOWPayments as extra_id for reconciliation.
    ──────────────────────────────────────── */
    const payoutData = {
      userUid:       uid,
      userName:      userData.name        || '',
      userEmail:     userData.email       || '',
      amount:        amtUsd,
      amountCoin:    coinAmt,
      amountUsdt:    Number(amountUsdt    || 0),
      currency:      currency.toUpperCase(),
      coinId:        coinId,
      network:       network              || '',
      walletAddress: walletAddress.trim(),
      exchangeRate:  Number(exchangeRate  || 0),
      usdtRate:      Number(usdtRate      || 0),
      fees: {
        nowpaymentsFee: Number(fees?.nowpaymentsFee || 0),
        platformFee:    Number(fees?.platformFee    || 0),
      },
      status:        'pending',
      batchId:       null,
      withdrawalId:  null,
      nowStatus:     null,
      createdAt:     new Date(),
      updatedAt:     new Date(),
    };

    const payoutRef = await db.collection('payouts').add(payoutData);
    const payoutId  = payoutRef.id;

    /* ────────────────────────────────────────
       FIX #1 — Atomic balance reservation via Firestore transaction
       Re-reads balance inside the transaction to prevent race conditions
       where two simultaneous withdrawals both pass the balance check.
    ──────────────────────────────────────── */
    let reservedBalance;
    try {
      await db.runTransaction(async (tx) => {
        const freshSnap = await tx.get(userRef);
        const freshData = freshSnap.data();

        /*
         * RACE-CONDITION FIX — re-verify the OTP is still unused INSIDE this
         * same atomic transaction, not just in the pre-flight check at STEP
         * 1a above. That earlier check reads a snapshot that can go stale:
         * if two withdrawal requests arrive close together (a double-tap on
         * a slow connection, a client retry, or a deliberate replay), BOTH
         * could pass the pre-flight check before either one commits — the
         * old code then let both transactions through because only balance
         * sufficiency was re-checked here, not the OTP.
         *
         * Firestore transactions serialize per-document: only the FIRST
         * request to commit can ever see withdrawalOtpUsed === true here.
         * The moment it commits, it deletes the OTP fields as part of this
         * same write. Any other concurrent request's tx.get() above is
         * guaranteed to observe that post-commit state and will hit this
         * check and fail loudly — before a single cent of balance moves.
         * One verified OTP can now authorize at most one withdrawal, full
         * stop, regardless of timing.
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

        const availableBalance = Number(freshData.availableBalance || 0);

        if (availableBalance < amtUsd) {
          const err = new Error(
            `Insufficient balance. Available: ${usd(availableBalance)}, Requested: ${usd(amtUsd)}.`
          );
          err.statusCode = 400;
          throw err;
        }

        reservedBalance = availableBalance; // capture for use after transaction

        const newBalance     = Math.max(0, availableBalance - amtUsd);
        const totalWithdrawn = Number(freshData.totalWithdrawn || 0) + amtUsd;

        /*
         * Issue 3 fix — keep balances.USD in sync with availableBalance.
         *
         * deliver-product.js credits both availableBalance AND balances.USD
         * when a USD order is paid. Previously this transaction only decremented
         * availableBalance, leaving balances.USD stale (too high) after a
         * crypto withdrawal — the dashboard crypto card showed the old balance
         * until the next full page load.
         *
         * Fix: also decrement balances.USD by the same amount. Using
         * FieldValue.increment keeps this safe against any concurrent credit
         * that lands between the fresh read and this write.
         */
        tx.update(userRef, {
          availableBalance:  newBalance,
          'balances.USD':    require('firebase-admin').firestore.FieldValue.increment(-amtUsd),
          totalWithdrawn,
          updatedAt: new Date(),
          // Part C of the OTP fix — consume the verification on success so
          // it can't be replayed for a second withdrawal.
          withdrawalOtpUsed:       require('firebase-admin').firestore.FieldValue.delete(),
          withdrawalOtpVerifiedAt: require('firebase-admin').firestore.FieldValue.delete(),
        });
      });
    } catch (txErr) {
      // Mark payout doc as failed so it doesn't appear stuck as 'pending'
      await payoutRef.update({ status: 'failed', errorMsg: txErr.message, updatedAt: new Date() });
      const sc = txErr.statusCode || 500;
      return { statusCode: sc, body: JSON.stringify({ error: txErr.message }) };
    }

    /* ────────────────────────────────────────
       STEP 3 — Call NOWPayments AFTER balance is reserved
       If this fails we refund via compensating update.
    ──────────────────────────────────────── */
    let batchId, withdrawalId, nowStatus;

    try {
      ({ batchId, withdrawalId, nowStatus } = await initiateNowPaymentsPayout({
        walletAddress: walletAddress.trim(),
        currency,
        coinId,
        amountCoin:    coinAmt,
        uid,
        payoutDocId:   payoutId,
      }));
    } catch (nowErr) {
      /*
       * NOWPayments call failed — compensate by refunding the deducted balance
       * and marking the payout doc 'failed'.
       */
      await payoutRef.update({ status: 'failed', errorMsg: nowErr.message, updatedAt: new Date() });
      await userRef.update({
        availableBalance: require('firebase-admin').firestore.FieldValue.increment(amtUsd),  // add back exactly what was deducted
        'balances.USD':   require('firebase-admin').firestore.FieldValue.increment(amtUsd),  // Issue 3 fix — restore balances.USD to match
        totalWithdrawn:   require('firebase-admin').firestore.FieldValue.increment(-amtUsd),
        updatedAt:        new Date(),
      });

      return {
        statusCode: 502,
        body: JSON.stringify({ error: nowErr.message }),
      };
    }

    /* ────────────────────────────────────────
       STEP 4 — Update payout doc to 'sent'
    ──────────────────────────────────────── */
    await payoutRef.update({
      status:       'sent',
      batchId:      batchId      || null,
      withdrawalId: withdrawalId || null,
      nowStatus:    nowStatus    || null,
      updatedAt:    new Date(),
    });

    /* ── Compute newBalance for response/notification ── */
    const newBalance = Math.max(0, reservedBalance - amtUsd);
    // Issue 3 fix — return the updated balances.USD value so the frontend
    // crypto card updates immediately without waiting for a full page reload.
    // The frontend handles this via result.newCurrencyBalance (see dashboard-withdraw.html).
    const newCurrencyBalance = Math.max(0, newBalance);

    /* ────────────────────────────────────────
       STEP 6 — Send withdrawal confirmation email
    ──────────────────────────────────────── */
    try {
      const platformUrl = (process.env.PLATFORM_URL || 'https://kreddlo.space').replace(/\/$/, '');
      await fetch(`${platformUrl}/.netlify/functions/send-smart-notification`, {
        method:  'POST',
        headers: {
          'Content-Type':     'application/json',
          'x-internal-secret': process.env.INTERNAL_FUNCTION_SECRET || '',
        },
        body:    JSON.stringify({
          userUid:    userData.uid || null,
          to:         userData.email || null,
          title:      'Withdrawal Initiated',
          body:       `Your withdrawal of ${usd(amtUsd)} has been processed and is on its way.`,
          url:        `${platformUrl}/dashboard-withdraw.html`,
          templateId: 'withdrawal-initiated',
          emailMode:  'always',
          emailData: {
            name:          userData.name || 'Freelancer',
            amount:        usd(amtUsd),
            coinAmount:    coinAmt.toFixed(coinAmt < 0.01 ? 8 : 4),
            currency:      currency.toUpperCase(),
            network:       network || '',
            walletAddress: shortWallet(walletAddress.trim()),
            payoutId,
            newBalance:    usd(newBalance),
            date:          new Date().toLocaleDateString('en-US', {
              weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
            }),
          },
        }),
      }).catch(err => {
        console.error('[create-payout] send-smart-notification failed:', err.message);
      });
    } catch (emailErr) {
      console.error('[create-payout] Notification block error:', emailErr.message);
    }

    /* ────────────────────────────────────────
       STEP 7 — Return success response
    ──────────────────────────────────────── */
    return {
      statusCode: 200,
      headers: {
        'Content-Type':                'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify({
        success:           true,
        payoutId,
        batchId:           batchId      || null,
        withdrawalId:      withdrawalId || null,
        nowStatus:         nowStatus    || null,
        newBalance,
        // Issue 3 fix — lets the frontend crypto card update balancesMap['USD']
        // immediately after a successful crypto withdrawal (no full reload needed).
        newCurrencyBalance,
        debitedCurrency:   'USD',
        message:           `Withdrawal of ${usd(amtUsd)} initiated successfully.`,
      }),
    };

  } catch (err) {
    console.error('[create-payout] Unhandled error:', err);
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'Internal server error. Please try again.' }),
    };
  }
};
