/**
 * reconcile-stuck-payouts.js — Scheduled Netlify Function
 * Runs every 20 minutes (see netlify.toml).
 *
 * SAFETY NET for nowpayments-payout-webhook.js. That webhook only fires if
 * NOWPayments' IPN delivery actually reaches us — if their delivery is
 * down, a request gets dropped, or ipn_callback_url was momentarily
 * misconfigured, a payout can sit forever in status:'sent' (crypto) or
 * status:'processing' (affiliate crypto) with the user's balance already
 * deducted and nothing ever confirming or refunding it.
 *
 * This job actively POLLS NOWPayments (GET /v1/payout/{id}) for the true
 * current status of any such "in flight too long" payout, then routes the
 * result through the exact same processPayoutStatusUpdate() function the
 * live webhook uses — same Firestore lookup, same atomic refund
 * transaction, same idempotency guards (confirmed / refunded flags). This
 * guarantees identical behaviour regardless of whether a payout gets
 * resolved by a pushed webhook or a polled reconciliation pass; there is
 * only ONE place that ever decides "this payout failed, refund it."
 *
 * This function never invents a status and never refunds speculatively —
 * it only acts on what NOWPayments' own API reports back, authenticated
 * with our own secret API key (the same trust boundary used to create the
 * payout in the first place). If the poll fails or returns nothing usable,
 * the payout is simply left untouched for the next run.
 *
 * Environment variables required:
 *   NOWPAYMENTS_API_KEY       — NOWPayments API key
 *   FIREBASE_SERVICE_ACCOUNT  — Firebase service account JSON (via getDb()
 *                                imported from nowpayments-payout-webhook.js)
 */

const https = require('https');
const { getDb, processPayoutStatusUpdate } = require('./nowpayments-payout-webhook');

// Give the live webhook this long to resolve a payout on its own before we
// start polling for it — avoids racing a webhook that's simply a few
// seconds slower than this scheduled run.
const STALE_AFTER_MS = 10 * 60 * 1000; // 10 minutes

// Bounded per run so a large backlog can't blow out function runtime/cost.
// Any leftovers are picked up on the next scheduled run.
const BATCH_LIMIT = 50;

function httpsGet(hostname, path, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: 'GET', headers: headers || {} }, (res) => {
      let raw = '';
      res.on('data', (chunk) => (raw += chunk));
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

/**
 * Polls NOWPayments for the live status of a single withdrawal.
 * Returns the parsed status object, or null if it couldn't be retrieved
 * (network error, non-200, unexpected shape) — callers must leave the
 * payout untouched on null rather than guessing.
 */
async function fetchNowPaymentsStatus(withdrawalId) {
  const apiKey = process.env.NOWPAYMENTS_API_KEY;
  if (!apiKey || !withdrawalId) return null;

  try {
    const res = await httpsGet(
      'api.nowpayments.io',
      `/v1/payout/${encodeURIComponent(withdrawalId)}`,
      { 'x-api-key': apiKey },
    );
    if (res.status !== 200 || !res.body || typeof res.body !== 'object') {
      console.warn(`[reconcile-stuck-payouts] Non-200/bad body polling status for ${withdrawalId}: status ${res.status}`);
      return null;
    }
    return res.body;
  } catch (err) {
    console.warn(`[reconcile-stuck-payouts] Status fetch failed for ${withdrawalId}:`, err.message);
    return null;
  }
}

function toDateSafe(value) {
  if (!value) return null;
  if (value.toDate) return value.toDate();
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Scans one collection for payouts that look stuck and pushes any
 * resolvable ones through processPayoutStatusUpdate().
 *
 * @param {string} collectionName  'payouts' or 'affiliate-payouts'
 * @param {string} statusToScan    the in-flight status value used by that
 *                                  collection ('sent' for payouts,
 *                                  'processing' for affiliate-payouts)
 * @param {string} idField         which field holds the NOWPayments
 *                                  withdrawal id ('withdrawalId' or
 *                                  'nowPaymentsId')
 */
async function reconcileCollection(db, collectionName, statusToScan, idField) {
  const result = { scanned: 0, polled: 0, resolved: 0, skipped: 0, errors: 0 };

  let snap;
  try {
    snap = await db.collection(collectionName)
      .where('status', '==', statusToScan)
      .orderBy('createdAt', 'asc')
      .limit(BATCH_LIMIT)
      .get();
  } catch (err) {
    console.error(`[reconcile-stuck-payouts] Query failed for ${collectionName}:`, err.message);
    result.errors++;
    return result;
  }

  for (const doc of snap.docs) {
    result.scanned++;
    const data = doc.data() || {};

    // Already resolved (e.g. by the live webhook moments ago) — skip.
    if (data.confirmed === true || data.refunded === true) {
      result.skipped++;
      continue;
    }

    // Bank/manual payouts and dev-mode mocks have no real NOWPayments
    // withdrawal id to poll — nothing for this job to do with those.
    const withdrawalId = data[idField] || null;
    if (!withdrawalId || String(withdrawalId).startsWith('dev-mock-')) {
      result.skipped++;
      continue;
    }

    // Give the webhook a head start before we start polling for this one.
    const referenceTime = toDateSafe(data.updatedAt) || toDateSafe(data.createdAt);
    if (referenceTime && (Date.now() - referenceTime.getTime()) < STALE_AFTER_MS) {
      result.skipped++;
      continue;
    }

    result.polled++;
    const nowData = await fetchNowPaymentsStatus(withdrawalId);
    if (!nowData) {
      // Couldn't verify this round — leave it exactly as-is for next run.
      continue;
    }

    const rawStatus = (nowData.status || nowData.payout_status || '').toString().toLowerCase().trim();
    if (!rawStatus) continue;

    try {
      const outcome = await processPayoutStatusUpdate(db, {
        withdrawalId: nowData.id || withdrawalId,
        batchId:      nowData.batch_withdrawal_id || data.batchId || null,
        extraId:      doc.id,
        rawStatus,
        txHash:       nowData.hash || nowData.tx_hash || null,
        errorDetail:  nowData.error || nowData.error_msg || null,
      });
      if (outcome && outcome.resolved) result.resolved++;
    } catch (err) {
      console.error(`[reconcile-stuck-payouts] processPayoutStatusUpdate failed for ${doc.id}:`, err.message);
      result.errors++;
    }
  }

  return result;
}

exports.handler = async function () {
  let db;
  try {
    db = getDb();
  } catch (err) {
    console.error('[reconcile-stuck-payouts] Firebase Admin init failed:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal configuration error.' }) };
  }

  if (!process.env.NOWPAYMENTS_API_KEY) {
    console.warn('[reconcile-stuck-payouts] NOWPAYMENTS_API_KEY not set — skipping run.');
    return { statusCode: 200, body: JSON.stringify({ skipped: true, reason: 'no API key configured' }) };
  }

  const [cryptoResult, affiliateResult] = await Promise.all([
    reconcileCollection(db, 'payouts', 'sent', 'withdrawalId'),
    reconcileCollection(db, 'affiliate-payouts', 'processing', 'nowPaymentsId'),
  ]);

  console.log('[reconcile-stuck-payouts] payouts:', cryptoResult, '| affiliate-payouts:', affiliateResult);

  return {
    statusCode: 200,
    body: JSON.stringify({
      payouts:          cryptoResult,
      affiliatePayouts: affiliateResult,
    }),
  };
};
