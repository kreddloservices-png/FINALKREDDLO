/**
 * Netlify Function: nowpayments-payout-webhook.js
 * Path: netlify/functions/nowpayments-payout-webhook.js
 *
 * Receives payout status callbacks from NOWPayments after create-payout.js
 * has already (a) deducted the user's USD balance and (b) asked NOWPayments
 * to send crypto from our wallet. create-payout.js only refunds the user if
 * the initial API call itself throws — but NOWPayments queues payouts and
 * can fail them *afterwards* (e.g. our payout wallet ran dry, the address
 * was rejected, etc.), and until now nothing was listening for that.
 *
 * This closes that gap:
 *   - finished                 → payout succeeded, no balance action. We just
 *                                 record the tx hash / completion time.
 *   - waiting / creating /
 *     processing / sending     → still in flight, just record the latest
 *                                 NOWPayments status for visibility.
 *   - failed / rejected /
 *     expired                  → payout did NOT happen. We refund the
 *                                 deducted amount back to the user's
 *                                 availableBalance and mark the payout
 *                                 'failed' so it matches the same status
 *                                 string the admin + earnings dashboards
 *                                 already render as "Failed".
 *
 * Required for this to actually fire: create-payout.js must pass
 * ipn_callback_url pointing at this function when it calls NOWPayments'
 * POST /v1/payout endpoint (see the PRIORITY 1 FIX comment there).
 *
 * RECONCILIATION FIX — the core status-handling logic below is exported as
 * `processPayoutStatusUpdate()` so reconcile-stuck-payouts.js (a scheduled
 * function) can drive the exact same confirm/refund/idempotency logic from
 * a polled GET /v1/payout/{id} response, for the case where this webhook's
 * IPN delivery never arrives (NOWPayments outage, dropped request, etc.).
 * Both entry points funnel into one place so behaviour can never drift
 * between "pushed via webhook" and "pulled via reconciliation poll".
 *
 * Environment variables required:
 *   NOWPAYMENTS_IPN_SECRET    — same IPN secret used by nowpayments-webhook.js
 *   FIREBASE_SERVICE_ACCOUNT  — full Firebase service account JSON, one line
 *   PLATFORM_URL              — live domain, used for the refund notification link
 *   INTERNAL_FUNCTION_SECRET  — shared secret for calling send-smart-notification
 */

const crypto = require('crypto');
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue }     = require('firebase-admin/firestore');

/* ── Initialise Firebase Admin SDK once (survives warm Lambda invocations) ── */
function getDb() {
  if (!getApps().length) {
    let serviceAccount;
    try {
      serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
    } catch {
      throw new Error('FIREBASE_SERVICE_ACCOUNT env var is not valid JSON.');
    }
    initializeApp({ credential: cert(serviceAccount) });
  }
  return getFirestore();
}

/* ── Status buckets (NOWPayments mass-payout statuses, case-insensitive) ── */
const SUCCESS_STATUSES = new Set(['finished']);
const PENDING_STATUSES = new Set(['waiting', 'creating', 'processing', 'sending']);
const FAILED_STATUSES  = new Set(['failed', 'rejected', 'expired']);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return respond(405, { error: 'Method not allowed.' });
  }

  const rawBody = event.body || '';

  /* ── Verify IPN signature — identical scheme to nowpayments-webhook.js ── */
  const ipnSecret = process.env.NOWPAYMENTS_IPN_SECRET;
  if (!ipnSecret) {
    console.error('NOWPAYMENTS_IPN_SECRET environment variable is not set.');
    return respond(500, { error: 'Webhook not configured.' });
  }

  const receivedSig = (event.headers['x-nowpayments-sig'] || '').toLowerCase();
  if (!receivedSig) {
    console.warn('[payout-webhook] Received with no x-nowpayments-sig header — rejected.');
    return respond(401, { error: 'Missing signature.' });
  }

  if (!verifySignature(rawBody, ipnSecret, receivedSig)) {
    console.warn('[payout-webhook] Signature mismatch — possible spoofed request. Rejected.');
    return respond(401, { error: 'Invalid signature.' });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return respond(400, { error: 'Invalid JSON body.' });
  }

  /*
   * Field names are normalised defensively — NOWPayments' payout callback
   * payload mirrors their "Get payout status" response, but we don't trust
   * exact casing/key naming from memory, so we check the common variants.
   */
  const withdrawalId = payload.id || payload.withdrawal_id || null;
  const batchId       = payload.batch_withdrawal_id || payload.batchId || null;
  const extraId        = payload.extra_id || payload.extraId || null;
  const rawStatus       = (payload.status || payload.payout_status || '').toString().toLowerCase().trim();
  const txHash          = payload.hash || payload.tx_hash || null;
  const errorDetail      = payload.error || payload.error_msg || null;

  console.log(`[payout-webhook] received — withdrawalId: ${withdrawalId}, batchId: ${batchId}, extraId: ${extraId}, status: ${rawStatus}`);

  if (!rawStatus) {
    console.warn('[payout-webhook] No status field in payload — acknowledging without action.');
    return respond(200, { received: true });
  }

  let db;
  try {
    db = getDb();
  } catch (err) {
    console.error('[payout-webhook] Firebase Admin init failed:', err.message);
    return respond(500, { error: 'Internal configuration error.' });
  }

  try {
    await processPayoutStatusUpdate(db, { withdrawalId, batchId, extraId, rawStatus, txHash, errorDetail });
  } catch (err) {
    console.error('[payout-webhook] processPayoutStatusUpdate failed:', err.message);
    return respond(500, { error: 'Refund processing failed.' });
  }

  return respond(200, { received: true });
};

/* ══════════════════════════════════════════════════════════════
   SHARED STATUS-HANDLING LOGIC
   Used by both the live webhook above and reconcile-stuck-payouts.js
   (the scheduled safety-net poller). Identical Firestore lookup,
   identical transaction, identical idempotency guards — only the
   *source* of `rawStatus` differs (pushed callback vs polled GET).

   Returns a small result object describing what happened, purely for
   logging/metrics by callers — neither caller needs to branch on it
   for correctness, since all the safety guarantees live inside this
   function itself.
══════════════════════════════════════════════════════════════ */
async function processPayoutStatusUpdate(db, { withdrawalId, batchId, extraId, rawStatus, txHash, errorDetail }) {
  if (!rawStatus) return { resolved: false, action: 'no_status' };

  /*
   * Find the matching payout doc. extra_id was set to the Firestore payout
   * doc ID when create-payout.js created the payout, so that's the
   * authoritative match. Falls back to a lookup by withdrawalId/batchId in
   * case extra_id isn't echoed back for some reason.
   *
   * Affiliate withdrawals (affiliate-withdraw.js) write to a separate
   * `affiliate-payouts` collection with different field names (uid instead
   * of userUid, grossAmount instead of amount, nowPaymentsId instead of
   * withdrawalId/batchId). If nothing matches in `payouts`, check there too
   * before giving up — isAffiliatePayout tracks which collection matched so
   * the correct user fields get refunded below.
   */
  let payoutRef = null;
  let isAffiliatePayout = false;
  try {
    if (extraId) {
      const directSnap = await db.collection('payouts').doc(extraId).get();
      if (directSnap.exists) payoutRef = directSnap.ref;
    }
    if (!payoutRef && withdrawalId) {
      const q = await db.collection('payouts')
        .where('withdrawalId', '==', String(withdrawalId))
        .limit(1)
        .get();
      if (!q.empty) payoutRef = q.docs[0].ref;
    }
    if (!payoutRef && batchId) {
      const q = await db.collection('payouts')
        .where('batchId', '==', String(batchId))
        .limit(1)
        .get();
      if (!q.empty) payoutRef = q.docs[0].ref;
    }

    if (!payoutRef && extraId) {
      const directAffSnap = await db.collection('affiliate-payouts').doc(extraId).get();
      if (directAffSnap.exists) {
        payoutRef = directAffSnap.ref;
        isAffiliatePayout = true;
      }
    }
    if (!payoutRef && withdrawalId) {
      const q = await db.collection('affiliate-payouts')
        .where('nowPaymentsId', '==', String(withdrawalId))
        .limit(1)
        .get();
      if (!q.empty) {
        payoutRef = q.docs[0].ref;
        isAffiliatePayout = true;
      }
    }
  } catch (err) {
    console.error('[payout-webhook] Firestore lookup failed:', err.message);
    throw err;
  }

  if (!payoutRef) {
    // Acknowledge anyway so NOWPayments stops retrying — log for manual reconciliation.
    console.warn(`[payout-webhook] No matching payout doc found in payouts or affiliate-payouts (extraId: ${extraId}, withdrawalId: ${withdrawalId}, batchId: ${batchId}).`);
    return { resolved: false, action: 'not_found' };
  }

  /* ── Pending — just record the latest status, no balance action ── */
  if (PENDING_STATUSES.has(rawStatus)) {
    await payoutRef.update({
      nowStatus: rawStatus,
      updatedAt: new Date(),
    }).catch(err => console.warn('[payout-webhook] Pending status update failed:', err.message));
    return { resolved: false, action: 'pending' };
  }

  /* ── Success — record completion, balance was already correctly deducted ── */
  if (SUCCESS_STATUSES.has(rawStatus)) {
    try {
      const snap = await payoutRef.get();
      const data = snap.data() || {};
      if (data.confirmed === true) {
        // Already processed this — idempotent no-op on retry/duplicate delivery.
        return { resolved: true, action: 'already_confirmed' };
      }
      await payoutRef.update({
        nowStatus:   rawStatus,
        confirmed:   true,
        txHash:      txHash || null,
        completedAt: new Date(),
        updatedAt:   new Date(),
      });
    } catch (err) {
      console.error('[payout-webhook] Success update failed:', err.message);
      throw err;
    }
    return { resolved: true, action: 'confirmed' };
  }

  /* ── Failed / rejected / expired — refund the user, idempotently ── */
  if (FAILED_STATUSES.has(rawStatus)) {
    let alreadyRefunded = false;
    let refundAmount    = 0;
    let refundUid       = null;

    try {
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(payoutRef);
        const data = snap.data() || {};

        // Idempotency guard — NOWPayments may redeliver the same callback,
        // or both the webhook and the reconciliation poller could observe
        // the same failure in the same time window.
        if (data.refunded === true) {
          alreadyRefunded = true;
          return;
        }

        refundAmount = isAffiliatePayout
          ? Number(data.grossAmount || 0)
          : Number(data.amount || 0);
        refundUid    = isAffiliatePayout
          ? (data.uid || null)
          : (data.userUid || null);

        tx.update(payoutRef, {
          status:    'failed',
          nowStatus: rawStatus,
          errorMsg:  errorDetail || `NOWPayments payout ${rawStatus}`,
          refunded:  true,
          refundedAt: new Date(),
          updatedAt:  new Date(),
        });

        if (refundUid && refundAmount > 0) {
          const userRef = db.collection('users').doc(refundUid);
          if (isAffiliatePayout) {
            /*
             * Issue 4 fix — restore per-currency affiliateBalances buckets.
             *
             * affiliate-withdraw.js (Issue 1 fix) debits each affiliateBalances
             * bucket proportionally and stores the map as currencyDebits on the
             * payout doc. Previously this path only refunded the blended
             * affiliateBalance gate field, leaving the per-currency display map
             * stale (too low) after a delayed NOWPayments failure.
             *
             * Fix: read currencyDebits from the payout doc and restore each
             * bucket by exactly the amount that was deducted. Falls back to
             * restoring affiliateBalances.USD only for legacy payout docs that
             * pre-date the currencyDebits field (written by the Issue 1 fix).
             */
            const storedDebits = (data.currencyDebits && typeof data.currencyDebits === 'object')
              ? data.currencyDebits
              : null;

            const affiliateRefundPayload = {
              affiliateBalance:   FieldValue.increment(refundAmount),
              affiliateTotalPaid: FieldValue.increment(-refundAmount),
              updatedAt:          new Date(),
            };

            if (storedDebits && Object.keys(storedDebits).length > 0) {
              // Restore each currency bucket by the exact amount debited.
              Object.entries(storedDebits).forEach(function([ccy, debit]) {
                const amt = Number(debit) || 0;
                if (amt > 0) {
                  affiliateRefundPayload['affiliateBalances.' + ccy] = FieldValue.increment(amt);
                }
              });
            } else {
              // Legacy fallback — payout doc has no currencyDebits (pre-fix).
              // Restore USD bucket only, matching the old debit behaviour.
              affiliateRefundPayload['affiliateBalances.USD'] = FieldValue.increment(refundAmount);
            }

            tx.update(userRef, affiliateRefundPayload);
          } else {
            tx.update(userRef, {
              availableBalance: FieldValue.increment(refundAmount),
              // Issue 3 fix — balances.USD is decremented by create-payout.js
              // alongside availableBalance, so it must be restored here too.
              'balances.USD':   FieldValue.increment(refundAmount),
              totalWithdrawn:   FieldValue.increment(-refundAmount),
              updatedAt:        new Date(),
            });
          }
        }
      });
    } catch (err) {
      console.error('[payout-webhook] Refund transaction failed:', err.message);
      throw err;
    }

    if (alreadyRefunded) {
      return { resolved: true, action: 'already_refunded' };
    }

    console.log(`[payout-webhook] Payout ${payoutRef.id} ${rawStatus} — refunded ${refundAmount} to uid ${refundUid}.`);

    /* ── Notify the user — fire-and-forget, never blocks the caller ── */
    if (refundUid && refundAmount > 0) {
      notifyRefund({ db, uid: refundUid, amount: refundAmount, payoutId: payoutRef.id })
        .catch(err => console.warn('[payout-webhook] Refund notification failed:', err.message));
    }

    return { resolved: true, action: 'refunded' };
  }

  console.warn(`[payout-webhook] Unhandled status "${rawStatus}" for payout ${payoutRef.id}.`);
  return { resolved: false, action: 'unhandled_status' };
}

/* ══════════════════════════════════════════════════════════════
   SIGNATURE VERIFICATION — identical scheme to nowpayments-webhook.js
   NOWPayments signs callbacks with HMAC-SHA512 of the body after
   sorting top-level keys alphabetically.
══════════════════════════════════════════════════════════════ */
function verifySignature(rawBody, secret, receivedSig) {
  let parsed;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return false;
  }

  const sortedJson = JSON.stringify(sortObjectKeys(parsed));
  const expectedSig = crypto
    .createHmac('sha512', secret)
    .update(sortedJson)
    .digest('hex')
    .toLowerCase();

  try {
    return crypto.timingSafeEqual(
      Buffer.from(expectedSig, 'utf8'),
      Buffer.from(receivedSig, 'utf8'),
    );
  } catch {
    return false;
  }
}

function sortObjectKeys(obj) {
  if (Array.isArray(obj)) return obj.map(sortObjectKeys);
  if (obj !== null && typeof obj === 'object') {
    return Object.keys(obj)
      .sort()
      .reduce((acc, key) => {
        acc[key] = sortObjectKeys(obj[key]);
        return acc;
      }, {});
  }
  return obj;
}

/* ══════════════════════════════════════════════════════════════
   REFUND NOTIFICATION — tells the user their withdrawal failed and
   the amount was restored to their balance. Non-fatal: errors here
   never affect the refund itself, which has already been committed.
══════════════════════════════════════════════════════════════ */
async function notifyRefund({ db, uid, amount, payoutId }) {
  const platformUrl = (process.env.PLATFORM_URL || 'https://kreddlo.space').replace(/\/$/, '');
  if (!platformUrl) return;

  let userData = {};
  try {
    const userSnap = await db.collection('users').doc(uid).get();
    if (userSnap.exists) userData = userSnap.data();
  } catch (err) {
    console.warn('[payout-webhook] Could not load user for refund email:', err.message);
  }

  const usd = '$' + Number(amount || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  await fetch(`${platformUrl}/.netlify/functions/send-smart-notification`, {
    method:  'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-internal-secret':  process.env.INTERNAL_FUNCTION_SECRET || '',
    },
    body: JSON.stringify({
      userUid:    uid,
      to:         userData.email || null,
      title:      'Withdrawal Failed — Balance Restored',
      body:       `Your withdrawal of ${usd} could not be completed. The amount has been returned to your available balance.`,
      url:        `${platformUrl}/dashboard-withdraw.html`,
      templateId: 'withdrawal-failed',
      emailMode:  'always',
      emailData: {
        name:     userData.name || 'Freelancer',
        amount:   usd,
        payoutId,
      },
    }),
  });
}

/* ── Utility: build a Netlify function response ── */
function respond(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

module.exports.getDb = getDb;
module.exports.processPayoutStatusUpdate = processPayoutStatusUpdate;
