/**
 * affiliate-withdraw.js — Kreddlo Netlify Function
 *
 * Handles affiliate balance withdrawal requests.
 *
 * Flow:
 *  1. Authenticate caller via Firebase ID token
 *  2. Validate amount against available affiliateBalance
 *  3. Verify user has affiliateEnabled: true
 *  4. Read platform settings for affiliateWithdrawFeePercent
 *  5. Deduct fee, compute net amount
 *  6. Write record to affiliate-payouts collection with status: pending
 *  7. Atomically deduct gross amount from user's affiliateBalance in Firestore
 *  8. Increment affiliateTotalPaid
 *  9. Trigger NOWPayments payout (same flow as create-payout.js)
 * 10. Return { payoutId, grossAmount, feeAmount, netAmount }
 *
 * Environment variables required:
 *   FIREBASE_SERVICE_ACCOUNT  — Firebase service account JSON
 *   NOWPAYMENTS_API_KEY       — NOWPayments API key
 */

const https = require('https');
const { sanitizeString } = require('./_sanitize');

/* ─── Firebase Admin ────────────────────────────────────────────────────────── */
let _db   = null;
let _auth = null;

function getAdmin() {
  const admin = require('firebase-admin');
  if (!admin.apps.length) {
    const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({ credential: admin.credential.cert(sa) });
  }
  if (!_db)   _db   = admin.firestore();
  if (!_auth) _auth = admin.auth();
  return { db: _db, auth: _auth, FieldValue: admin.firestore.FieldValue };
}

/* ─── Settings ───────────────────────────────────────────────────────────────── */
const DEFAULTS = {
  affiliateWithdrawFeePercent: 2.0,
  minAffiliateWithdrawalUsd:   5,
  platformCurrency:            'USD',
};

async function getSettings(db) {
  try {
    const snap = await db.collection('config').doc('platform').get();
    return snap.exists ? { ...DEFAULTS, ...snap.data() } : { ...DEFAULTS };
  } catch (e) {
    return { ...DEFAULTS };
  }
}

/* ─── NOWPayments payout ─────────────────────────────────────────────────────── */
function httpsPost(hostname, path, data, headers) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const opts = {
      hostname,
      path,
      method: 'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...headers,
      },
    };
    const req = https.request(opts, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch (e) { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function sendNowPaymentsPayout(walletAddress, amount, currency, payoutId) {
  const apiKey = process.env.NOWPAYMENTS_API_KEY;
  if (!apiKey) {
    console.warn('[affiliate-withdraw] NOWPAYMENTS_API_KEY not set — skipping payout call in dev mode');
    return { id: 'dev-mock-' + payoutId };
  }

  // Convert currency to NOWPayments coin ticker (same logic as create-payout.js)
  const coinMap = {
    BTC: 'btc', ETH: 'eth', USDT: 'usdttrc20', USDC: 'usdcerc20',
    BNB: 'bnb', SOL: 'sol', TRX: 'trx', XRP: 'xrp', LTC: 'ltc',
  };
  const coin = coinMap[currency] || 'usdttrc20';

  // Affiliate payouts land in the `affiliate-payouts` collection, not `payouts`,
  // so delayed gateway failures must be reported to nowpayments-payout-webhook.js
  // (the payout-status webhook), not nowpayments-webhook.js (the payment webhook
  // for incoming purchases) — the latter never looked at this collection.
  const payoutWebhookUrl = (process.env.PLATFORM_URL || process.env.URL || 'https://kreddlo.space').replace(/\/$/, '')
    + '/.netlify/functions/nowpayments-payout-webhook';

  const res = await httpsPost(
    'api.nowpayments.io',
    '/v1/payout',
    {
      ipn_callback_url: payoutWebhookUrl,
      withdrawals: [{
        address:  walletAddress,
        currency: coin,
        amount:   amount,
        ipn_callback_url: payoutWebhookUrl,
        extra_id: payoutId,
      }],
    },
    { 'x-api-key': apiKey }
  );

  if (res.status !== 200 && res.status !== 201) {
    throw new Error('NOWPayments payout failed: ' + JSON.stringify(res.body));
  }
  return res.body;
}

/* ─── Handler ────────────────────────────────────────────────────────────────── */
exports.handler = async function(event) {
  const CORS = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    // 1. Auth
    const authHeader = event.headers.authorization || event.headers.Authorization || '';
    const idToken    = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (!idToken) {
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Unauthorized' }) };
    }

    const { db, auth, FieldValue } = getAdmin();
    let decoded;
    try {
      decoded = await auth.verifyIdToken(idToken);
    } catch (e) {
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Invalid auth token' }) };
    }

    const uid = decoded.uid;

    // 2. Parse body
    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch (e) { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON body' }) }; }

    const requestedAmount = parseFloat(body.amount) || 0;

    /*
     * Currency model (Option C — gateway-native conversion only):
     *
     * affiliateBalance is stored as a single USD figure. `amount` in the
     * request is ALWAYS denominated in USD and is the EXACT amount debited
     * from affiliateBalance — there is no client-supplied exchange rate
     * anywhere in this flow.
     *
     * payoutCurrency (optional) — if the affiliate wants their bank payout
     * in a non-USD currency, we still debit exactly `amount` USD from
     * affiliateBalance, but tell Flutterwave to deliver in payoutCurrency
     * via debit_currency: 'USD'. Flutterwave converts on their side and
     * guarantees the destination amount — we never compute or trust a rate.
     */
    const usdDebitAmount  = requestedAmount; // always USD, always exact
    const payoutCurrency  = (body.payoutCurrency || 'USD').toUpperCase().trim();
    const isCrossCurrency = payoutCurrency !== 'USD';

    // 3. Fetch settings
    const settings = await getSettings(db);
    const feePct   = Number(settings.affiliateWithdrawFeePercent) || 2;
    const minWd    = Number(settings.minAffiliateWithdrawalUsd)   || 5;
    const cur      = settings.platformCurrency || 'USD'; // storage currency (USD)

    // Minimum withdrawal check is always in USD (the debit currency)
    if (usdDebitAmount < minWd) {
      return {
        statusCode: 400, headers: CORS,
        body: JSON.stringify({ error: 'Minimum withdrawal is ' + cur + ' ' + minWd.toFixed(2) }),
      };
    }

    // 4. Fetch user doc
    const userRef  = db.collection('users').doc(uid);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
      return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'User not found' }) };
    }

    const userData = userSnap.data();

    // 5. Gate: affiliateEnabled
    if (userData.affiliateEnabled !== true) {
      return {
        statusCode: 403, headers: CORS,
        body: JSON.stringify({ error: 'Affiliate program not enabled for this account' }),
      };
    }

    // 5b. Gate: payoutsFrozen
    if (userData.payoutsFrozen === true) {
      return {
        statusCode: 403, headers: CORS,
        body: JSON.stringify({ error: 'Withdrawals temporarily paused by platform. Please contact support for assistance.' }),
      };
    }

    // 5c. OTP verification gate (FIX) — server-side enforcement of the 2FA
    // step. Previously a valid Firebase auth token alone was enough to call
    // this function and withdraw funds — the OTP step lived entirely in the
    // frontend and was trivially bypassable. withdrawalOtpVerifiedAt is
    // written by verify-withdrawal-otp.js on success and must be within the
    // last 5 minutes; it is cleared after a successful payout (step 10
    // transaction below) so one verification cannot be reused for multiple
    // withdrawals.
    {
      const otpVerifiedAt = userData.withdrawalOtpVerifiedAt
        ? (userData.withdrawalOtpVerifiedAt.toDate
            ? userData.withdrawalOtpVerifiedAt.toDate()
            : new Date(userData.withdrawalOtpVerifiedAt))
        : null;

      const OTP_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
      if (!userData.withdrawalOtpUsed || !otpVerifiedAt || (Date.now() - otpVerifiedAt.getTime()) > OTP_WINDOW_MS) {
        return {
          statusCode: 403, headers: CORS,
          body: JSON.stringify({ error: 'Withdrawal requires OTP verification. Please verify your identity and try again.' }),
        };
      }
    }

    // 6. Check balance (affiliateBalance is stored in USD) — informational
    // pre-check only; the authoritative check happens inside the atomic
    // transaction in step 10 below (see FIX note there).
    const available = Number(userData.affiliateBalance) || 0;
    if (usdDebitAmount > available) {
      return {
        statusCode: 400, headers: CORS,
        body: JSON.stringify({ error: 'Insufficient affiliate balance. Available: ' + cur + ' ' + available.toFixed(2) }),
      };
    }

    // 7. Check wallet / bank details based on method
    const method = body.method || 'crypto';

    let walletAddress = null;
    let bankPayload   = null;

    if (method === 'bank') {
      const bankCode      = body.bankCode      || null;
      const accountNumber = body.accountNumber || null;
      const accountName   = body.accountName   || null;
      if (!bankCode || !accountNumber || !accountName) {
        return {
          statusCode: 400, headers: CORS,
          body: JSON.stringify({ error: 'Bank details incomplete. Please provide bank, account number, and account name.' }),
        };
      }
      bankPayload = {
        bankCode,
        accountNumber: sanitizeString(accountNumber, 30),
        accountName:   sanitizeString(accountName,   100),
        bankName:      sanitizeString(body.bankName || '', 100),
      };
    } else {
      walletAddress = userData.walletAddress ? sanitizeString(userData.walletAddress, 200) : null;
      if (!walletAddress) {
        return {
          statusCode: 400, headers: CORS,
          body: JSON.stringify({ error: 'No withdrawal wallet set. Add one in Settings.' }),
        };
      }
    }

    // 8. Calculate amounts — all in USD, the currency actually debited.
    // Flutterwave/NOWPayments handle any conversion to payoutCurrency
    // natively at execution time; we never compute or store that figure.
    const grossUsd = parseFloat(usdDebitAmount.toFixed(6));
    const feeUsd   = parseFloat((grossUsd * feePct / 100).toFixed(6));
    const netUsd   = parseFloat((grossUsd - feeUsd).toFixed(6));

    const grossAmount = parseFloat(grossUsd.toFixed(2));
    const feeAmount   = parseFloat(feeUsd.toFixed(2));
    const netAmount   = parseFloat(netUsd.toFixed(2));

    // Determine paymentMethod bucket for this withdrawal
    const earningsBucket = (method === 'bank') ? 'fiat' : 'crypto';

    // 9. Create payout record in Firestore (status: pending).
    // Created up front so we have a payoutId, but NOT yet treated as
    // authorization to spend funds — the transaction in step 10 is the
    // actual gate.
    const payoutRef = await db.collection('affiliate-payouts').add({
      uid,
      grossAmount,
      feeAmount,
      netAmount,
      feePct,
      currency:      'USD', // always the debited currency — exact, no conversion
      // Cross-currency audit trail — records INTENT only. The actual rate
      // applied (if any) lives on the Flutterwave transfer object, fetched
      // post-execution if needed. We never store an invented rate here.
      ...(isCrossCurrency ? {
        payoutCurrency: payoutCurrency,
        fxSource:       'gateway-native', // converted by Flutterwave at execution time
      } : {}),
      method,
      paymentMethod: earningsBucket,
      walletAddress: walletAddress || null,
      bankCode:      bankPayload ? bankPayload.bankCode      : null,
      bankName:      bankPayload ? bankPayload.bankName      : null,
      accountNumber: bankPayload ? bankPayload.accountNumber : null,
      accountName:   bankPayload ? bankPayload.accountName   : null,
      status:        'pending',
      createdAt:     new Date(),
    });
    const payoutId = payoutRef.id;

    /* ────────────────────────────────────────
       10. FIX — Atomic balance reservation via Firestore transaction.
       Previously the balance was checked once (step 6, against a snapshot
       read at step 4) and then decremented later with a bare
       FieldValue.increment, with no re-check in between. Two concurrent
       withdrawal requests could both read the same starting balance, both
       pass the check, and both succeed — overdrawing affiliateBalance.
       This re-reads the balance inside the transaction immediately before
       deducting, closing that race. Mirrors the equivalent fix already
       applied in create-payout.js for the crypto withdrawal flow.
    ──────────────────────────────────────── */
    // Populated inside the transaction and used by the compensating refund below.
    let currencyDebits = {}; // e.g. { NGN: 45000, USD: 10 }

    try {
      await db.runTransaction(async (tx) => {
        const freshSnap = await tx.get(userRef);
        const freshData = freshSnap.data() || {};

        /*
         * RACE-CONDITION FIX — re-verify the OTP is still unused INSIDE this
         * same atomic transaction. See the identical fix (and full
         * rationale) in create-payout.js — without this, two concurrent
         * requests could both pass the pre-flight OTP check (step 5c above)
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
        const OTP_WINDOW_MS_TX = 5 * 60 * 1000; // 5 minutes — matches step 5c
        if (!freshData.withdrawalOtpUsed || !freshOtpVerifiedAt || (Date.now() - freshOtpVerifiedAt.getTime()) > OTP_WINDOW_MS_TX) {
          const err = new Error(
            'This withdrawal has already been processed, or your verification has expired. Please verify your identity again to submit a new withdrawal.'
          );
          err.statusCode = 409;
          throw err;
        }

        const freshAvailable = Number(freshData.affiliateBalance) || 0;

        if (grossUsd > freshAvailable) {
          const err = new Error(
            'Insufficient affiliate balance. Available: ' + cur + ' ' + freshAvailable.toFixed(2)
          );
          err.statusCode = 400;
          throw err;
        }

        /*
         * Issue 1 fix — per-currency proportional debit.
         *
         * Webhooks credit affiliateBalances.${confirmedCurrency} in the native
         * payment currency (NGN, GBP, USD, etc.) while affiliateBalance is a
         * blended display total. Previously this block always debited
         * affiliateBalances.USD — causing the USD bucket to go negative when
         * the affiliate had earned in NGN or GBP.
         *
         * Fix: read the affiliateBalances map inside the transaction, compute
         * each currency's share of the blended total, and deduct proportionally.
         * If the map is missing or empty we fall back to a single USD debit so
         * the gate field (affiliateBalance) is always correctly reduced.
         */
        const balancesMap = (freshData.affiliateBalances && typeof freshData.affiliateBalances === 'object')
          ? freshData.affiliateBalances
          : {};
        const mapTotal = Object.values(balancesMap).reduce((sum, v) => sum + (Number(v) || 0), 0);

        const updatePayload = {
          // Legacy blended field — kept for backward compat
          affiliateBalance:   FieldValue.increment(-grossUsd),
          affiliateTotalPaid: FieldValue.increment(grossUsd),
          // Part C of the OTP fix — consume the verification on success so
          // it can't be replayed for a second withdrawal.
          withdrawalOtpUsed:       FieldValue.delete(),
          withdrawalOtpVerifiedAt: FieldValue.delete(),
        };

        if (mapTotal > 0) {
          // Deduct from each currency bucket proportionally.
          currencyDebits = {};
          Object.entries(balancesMap).forEach(([ccy, rawVal]) => {
            const bucketAmt = Number(rawVal) || 0;
            if (bucketAmt <= 0) return;
            // Proportion of this bucket in the blended total × gross withdrawal amount.
            const debit = parseFloat(((bucketAmt / mapTotal) * grossUsd).toFixed(6));
            if (debit === 0) return;
            currencyDebits[ccy] = debit;
            updatePayload[`affiliateBalances.${ccy}`] = FieldValue.increment(-debit);
          });
        } else {
          // Fallback: map is absent (legacy user) — debit USD bucket only.
          currencyDebits = { USD: grossUsd };
          updatePayload['affiliateBalances.USD'] = FieldValue.increment(-grossUsd);
        }

        tx.update(userRef, updatePayload);

        // Issue 2 fix — persist currencyDebits INSIDE the transaction so it
        // is atomic with the balance deduction. Previously this was a separate
        // best-effort payoutRef.update() after the transaction committed, which
        // could silently fail (network blip, Firestore unavailability) and leave
        // the payout doc without currencyDebits. If the NOWPayments payout then
        // failed, nowpayments-payout-webhook.js would fall back to restoring
        // affiliateBalances.USD only — incorrect for non-USD earnings — causing
        // the per-currency balance display on dashboard-affiliate.html to show a
        // stale (too-low) amount until the next page load re-derived it from
        // the blended affiliateBalance total.
        //
        // By writing currencyDebits here, inside the same transaction that
        // debits the user's balance, the two writes are guaranteed to both
        // commit or both roll back. There is no window in which the balance is
        // deducted but currencyDebits is absent from the payout doc.
        if (Object.keys(currencyDebits).length > 0) {
          tx.update(payoutRef, { currencyDebits });
        }
      });
    } catch (txErr) {
      // Mark the payout doc as failed so it doesn't appear stuck as 'pending'
      await payoutRef.update({ status: 'failed', errorMsg: txErr.message }).catch(() => {});
      const sc = txErr.statusCode || 500;
      return { statusCode: sc, headers: CORS, body: JSON.stringify({ error: txErr.message }) };
    }

    // 11. Trigger payout via appropriate provider
    let nowPaymentsId = null;
    let flutterwaveId = null;
    try {
      if (method === 'bank' && bankPayload) {
        // Flutterwave bank transfer.
        // amount is the NET USD figure — what we actually debited (minus fee).
        // debit_currency: 'USD' tells Flutterwave to pull from our USD wallet
        // and convert natively to payoutCurrency if they differ. This must
        // match what was debited from affiliateBalance above — no separate
        // client-supplied rate is ever used here.
        const fwKey = process.env.FLW_SECRET_KEY;
        if (fwKey) {
          const fwRes = await httpsPost(
            'api.flutterwave.com',
            '/v3/transfers',
            {
              account_bank:    bankPayload.bankCode,
              account_number:  bankPayload.accountNumber,
              amount:          netAmount,
              currency:        payoutCurrency,   // what the beneficiary bank receives
              narration:       'Kreddlo affiliate payout ' + payoutId,
              reference:       'aff-' + payoutId,
              debit_currency:  'USD',            // what's pulled from our wallet — FLW converts natively
            },
            { 'Authorization': 'Bearer ' + fwKey }
          );
          if (fwRes.status !== 200 && fwRes.status !== 201) {
            throw new Error('Flutterwave transfer failed: ' + JSON.stringify(fwRes.body));
          }
          flutterwaveId = (fwRes.body.data && fwRes.body.data.id) ? String(fwRes.body.data.id) : null;
          await payoutRef.update({ flutterwaveId, status: 'processing' });
        } else {
          console.warn('[affiliate-withdraw] FLW_SECRET_KEY not set — skipping bank payout in dev mode');
          await payoutRef.update({ status: 'processing', devMode: true });
        }
      } else {
        // NOWPayments crypto payout
        const npRes   = await sendNowPaymentsPayout(walletAddress, netAmount, cur, payoutId);
        nowPaymentsId = npRes.id || null;
        await payoutRef.update({ nowPaymentsId, status: 'processing' });
      }
    } catch (npErr) {
      console.error('[affiliate-withdraw] Payout call failed:', npErr.message);

      // Compensating refund — balance was already deducted in step 10.
      // Re-credit it so the affiliate doesn't permanently lose funds.
      try {
        // Build the refund payload mirroring the exact debits made in the transaction.
        const refundPayload = {
          // Legacy blended field
          affiliateBalance:   FieldValue.increment(grossUsd),
          affiliateTotalPaid: FieldValue.increment(-grossUsd),
        };
        // Restore each currency bucket by exactly the amount that was deducted.
        Object.entries(currencyDebits).forEach(([ccy, debit]) => {
          refundPayload[`affiliateBalances.${ccy}`] = FieldValue.increment(debit);
        });
        await db.collection('users').doc(uid).update(refundPayload);
      } catch (refundErr) {
        console.error('[affiliate-withdraw] CRITICAL: compensating refund failed — manual reconciliation needed for payout ' + payoutId + ':', refundErr.message);
      }

      await payoutRef.update({
        status:   'failed',
        npError:  npErr.message,
        failedAt: new Date(),
      }).catch(() => {});

      return {
        statusCode: 502,
        headers:    { ...CORS, 'Content-Type': 'application/json' },
        body:       JSON.stringify({ error: 'Payout gateway failed. Your balance has been refunded. Please try again.' }),
      };
    }

    // 12. Mark pending earnings in the matching bucket as paid (best-effort, non-fatal).
    // Runs only after a successful gateway call (moved from before step 11) so
    // earnings are never marked paid for a payout that ultimately failed.
    // Only crypto earnings are marked when withdrawing via crypto; only fiat earnings
    // when withdrawing via bank — so funds never get mixed across buckets.
    try {
      const pendingQ    = db.collection('affiliate-earnings')
        .where('affiliateUid',  '==', uid)
        .where('status',        '==', 'pending')
        .where('paymentMethod', '==', earningsBucket)
        .limit(200);
      const pendingSnap = await pendingQ.get();
      const batch       = db.batch();
      pendingSnap.forEach(function(d) {
        batch.update(d.ref, { status: 'paid', paidAt: new Date(), payoutId });
      });
      await batch.commit();
    } catch (batchErr) {
      console.warn('[affiliate-withdraw] Could not mark earnings as paid:', batchErr.message);
    }

    return {
      statusCode: 200,
      headers:    { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ok:           true,
        payoutId,
        grossAmount,
        feeAmount,
        netAmount,
        method,
        nowPaymentsId,
        flutterwaveId,
      }),
    };

  } catch (err) {
    console.error('[affiliate-withdraw] Unhandled error:', err);
    return {
      statusCode: 500,
      headers:    CORS,
      body:       JSON.stringify({ error: 'Internal server error' }),
    };
  }
};
