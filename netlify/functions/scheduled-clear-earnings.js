/**
 * Netlify Scheduled Function: scheduled-clear-earnings.js
 * Path: netlify/functions/scheduled-clear-earnings.js
 *
 * Runs hourly (schedule defined in netlify.toml).
 *
 * Item 9 — Earnings Holding Period (product sales + affiliate commissions).
 *
 * Finds `product-earnings` and `affiliate-earnings` records where
 * `cleared === false` and `clearsAt <= now`, then:
 *   1. Moves the held amount from the user's pendingBalance(s) into their
 *      availableBalance / balances.{CURRENCY} (product sales) or from
 *      affiliatePendingBalance into affiliateBalance (affiliate commissions).
 *   2. Flips the earning record's `cleared` flag to true.
 *
 * This is the only place uncleared funds ever become withdrawable — both
 * create-payout.js / create-bank-payout.js (freelancer payouts) and
 * affiliate-withdraw.js already gate on availableBalance / affiliateBalance,
 * so once this job has run, those existing functions enforce the holding
 * period automatically with no changes of their own required.
 *
 * If a holding period of 0 days is configured, deliver-product.js and the
 * payment webhooks mark earnings `cleared: true` immediately at creation —
 * this job will simply find nothing to do for those records.
 *
 * netlify.toml entry required:
 *   [functions."scheduled-clear-earnings"]
 *   schedule = "0 * * * *"
 *
 * Environment variables required:
 *   FIREBASE_SERVICE_ACCOUNT — full service account JSON as single-line string
 */

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue }     = require('firebase-admin/firestore');

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

  /* ── Verify trigger source (FIX) ──
     This function does substantial Firestore reads/writes and was
     previously reachable by anyone at its public function URL with no
     auth check at all. The records it acts on are time-gated (clearsAt /
     deliverBy / cutoff already in the past), so this couldn't be used to
     release funds early or target a specific user — but it was still an
     open door for cost/resource abuse (repeated unauthenticated triggers
     forcing full collection scans and writes).
     Netlify's own scheduler sends 'X-NF-Event: schedule' on real cron
     invocations. We also accept a valid x-internal-secret so this can
     still be triggered manually/for testing (e.g. from the admin panel
     or another internal function), consistent with every other
     server-to-server check in this codebase. */
  const nfEvent       = event.headers['x-nf-event'] || event.headers['X-NF-Event'] || '';
  const incomingSecret = event.headers['x-internal-secret'] || event.headers['X-Internal-Secret'] || '';
  const expectedSecret = process.env.INTERNAL_FUNCTION_SECRET || '';
  const isRealSchedule = nfEvent === 'schedule';
  const isTrustedCall  = !!expectedSecret && incomingSecret === expectedSecret;
  if (!isRealSchedule && !isTrustedCall) {
    return respond(401, { error: 'Unauthorized.' });
  }

  console.log('scheduled-clear-earnings: running at', new Date().toISOString());

  let db;
  try {
    db = getDb();
  } catch (err) {
    console.error('Firebase Admin init failed:', err.message);
    return respond(500, { error: 'Database not available.' });
  }

  const now = new Date();
  const results = {
    productEarningsCleared:   0,
    productEarningsFailed:    0,
    affiliateEarningsCleared: 0,
    affiliateEarningsFailed:  0,
  };

  /* ════════════════════════════════════════════════════════════
     1. CLEAR PRODUCT-SALE EARNINGS
  ════════════════════════════════════════════════════════════ */
  try {
    const snap = await db.collection('product-earnings')
      .where('cleared',  '==', false)
      .where('clearsAt', '<=', now)
      .get();

    if (snap.empty) {
      console.log('scheduled-clear-earnings: no product earnings ready to clear.');
    } else {
      console.log(`scheduled-clear-earnings: found ${snap.size} product earning(s) ready to clear.`);

      for (const docSnap of snap.docs) {
        try {
          await db.runTransaction(async (tx) => {
            // Re-read the earning doc fresh inside the transaction so a second
            // overlapping run sees cleared: true and skips — closing the race.
            const freshSnap = await tx.get(docSnap.ref);
            if (!freshSnap.exists) return; // deleted between query and tx — skip

            const earning = freshSnap.data();
            if (earning.cleared === true) return; // another run already claimed it

            const currency = (earning.currency || 'USD').toUpperCase();
            const amount   = Number(earning.amount) || 0;
            if (amount <= 0) {
              // Nothing to credit — just flip the flag so this record is skipped next time
              tx.update(docSnap.ref, { cleared: true, clearedAt: FieldValue.serverTimestamp() });
              return;
            }

            const userRef = db.collection('users').doc(earning.sellerUid);
            const clearUpdate = {
              [`balances.${currency}`]:        FieldValue.increment(amount),
              [`pendingBalances.${currency}`]: FieldValue.increment(-amount),
            };
            if (currency === 'USD') {
              clearUpdate.availableBalance = FieldValue.increment(amount);
              clearUpdate.pendingBalance   = FieldValue.increment(-amount);
            }
            tx.update(userRef, clearUpdate);
            tx.update(docSnap.ref, { cleared: true, clearedAt: FieldValue.serverTimestamp() });
          });

          results.productEarningsCleared++;
        } catch (err) {
          console.error(`scheduled-clear-earnings: failed to clear product earning ${docSnap.id}:`, err.message);
          results.productEarningsFailed++;
        }
      }
    }
  } catch (err) {
    // Likely a missing composite index (cleared + clearsAt) — see FIRESTORE_INDEXES.md
    console.error('scheduled-clear-earnings: product-earnings query failed (may need composite index on product-earnings.cleared + product-earnings.clearsAt — check logs for a Firebase auto-create link):', err.message);
  }

  /* ════════════════════════════════════════════════════════════
     2. CLEAR AFFILIATE-COMMISSION EARNINGS
  ════════════════════════════════════════════════════════════ */
  try {
    const snap = await db.collection('affiliate-earnings')
      .where('cleared',  '==', false)
      .where('clearsAt', '<=', now)
      .get();

    if (snap.empty) {
      console.log('scheduled-clear-earnings: no affiliate earnings ready to clear.');
    } else {
      console.log(`scheduled-clear-earnings: found ${snap.size} affiliate earning(s) ready to clear.`);

      for (const docSnap of snap.docs) {
        try {
          await db.runTransaction(async (tx) => {
            // Re-read fresh inside the transaction so a second overlapping run
            // sees cleared: true and skips — closing the race.
            const freshSnap = await tx.get(docSnap.ref);
            if (!freshSnap.exists) return; // deleted between query and tx — skip

            const earning = freshSnap.data();
            if (earning.cleared === true) return; // another run already claimed it

            const amount = Number(earning.commissionAmount) || 0;
            if (amount <= 0) {
              // Nothing to credit — just flip the flag so this record is skipped next time
              tx.update(docSnap.ref, { cleared: true, clearedAt: FieldValue.serverTimestamp() });
              return;
            }

            const userRef  = db.collection('users').doc(earning.affiliateUid);
            const currency = (earning.currency || 'USD').toUpperCase();

            /*
             * Issue 2 fix — use the stored USD-equivalent for the gate field.
             * commissionAmountUsd is written by the webhooks (post-fix) using the
             * order's gateway-derived exchange rate. For earnings written before
             * this fix (no commissionAmountUsd field), fall back to commissionAmount
             * so behaviour is unchanged for legacy records.
             */
            const amountUsd = Number(earning.commissionAmountUsd != null ? earning.commissionAmountUsd : earning.commissionAmount) || 0;

            const clearUpdate = {
              // Gate field — always USD-equivalent so withdrawals are meaningful
              affiliateBalance:        FieldValue.increment(amountUsd),
              affiliatePendingBalance: FieldValue.increment(-amountUsd),
              // Per-currency display maps — always native amount
              [`affiliateBalances.${currency}`]:        FieldValue.increment(amount),
              [`affiliatePendingBalances.${currency}`]: FieldValue.increment(-amount),
            };
            tx.update(userRef, clearUpdate);
            tx.update(docSnap.ref, { cleared: true, clearedAt: FieldValue.serverTimestamp() });
          });

          results.affiliateEarningsCleared++;
        } catch (err) {
          console.error(`scheduled-clear-earnings: failed to clear affiliate earning ${docSnap.id}:`, err.message);
          results.affiliateEarningsFailed++;
        }
      }
    }
  } catch (err) {
    // Likely a missing composite index (cleared + clearsAt) — see FIRESTORE_INDEXES.md
    console.error('scheduled-clear-earnings: affiliate-earnings query failed (may need composite index on affiliate-earnings.cleared + affiliate-earnings.clearsAt — check logs for a Firebase auto-create link):', err.message);
  }

  /* ════════════════════════════════════════════════════════════
     3. AUTO-MARK INVOICE AS DELIVERED (48hr window)
     Any invoice in `escrow` status with deliverBy <= now gets
     auto-marked as `delivered` so the escrow countdown starts.
  ════════════════════════════════════════════════════════════ */
  try {
    const escrowSnap = await db.collection('invoices')
      .where('status', '==', 'escrow')
      .where('deliverBy', '<=', now)
      .get();

    if (!escrowSnap.empty) {
      console.log(`scheduled-clear-earnings: auto-marking ${escrowSnap.size} invoice(s) as delivered.`);
      for (const docSnap of escrowSnap.docs) {
        try {
          await docSnap.ref.update({
            status:      'delivered',
            deliveredAt: now,
            autoDelivered: true,
            updatedAt:   now,
          });
          console.log(`Auto-marked invoice ${docSnap.id} as delivered.`);
        } catch (err) {
          console.error(`Failed to auto-mark invoice ${docSnap.id} as delivered:`, err.message);
        }
      }
    }
  } catch (err) {
    console.error('scheduled-clear-earnings: invoice auto-deliver query failed (may need composite index on invoices.status + invoices.deliverBy):', err.message);
  }

  /* ════════════════════════════════════════════════════════════
     4. AUTO-RELEASE INVOICE ESCROW (admin-configured escrow days)
     Any invoice in `delivered` status with deliveredAt older than
     holdingPeriodDays gets funds released to the seller's availableBalance.
  ════════════════════════════════════════════════════════════ */
  try {
    const settings = await db.collection('config').doc('platform').get();
    const escrowDays = (settings.exists && settings.data().holdingPeriodDays != null)
      ? Number(settings.data().holdingPeriodDays)
      : 7;

    const cutoff = new Date(now.getTime() - escrowDays * 24 * 60 * 60 * 1000);

    const deliveredSnap = await db.collection('invoices')
      .where('status', '==', 'delivered')
      .where('deliveredAt', '<=', cutoff)
      .get();

    if (!deliveredSnap.empty) {
      console.log(`scheduled-clear-earnings: auto-releasing escrow for ${deliveredSnap.size} delivered invoice(s).`);
      for (const docSnap of deliveredSnap.docs) {
        const inv = docSnap.data();
        const sellerUid    = inv.uid;
        const sellerAmount = Number(inv.escrowSellerAmount || 0);
        const currency     = (inv.currency || 'USD').toUpperCase();

        try {
          if (sellerUid && sellerAmount > 0) {
            const autoReleaseUpdate = {
              [`balances.${currency}`]:             FieldValue.increment(sellerAmount),
              // Legacy blended figure — kept for older admin tooling only.
              totalEarned:                          FieldValue.increment(sellerAmount),
              // Accurate, currency-separated figure for any seller-facing display.
              [`totalEarnedByCurrency.${currency}`]: FieldValue.increment(sellerAmount),
              updatedAt:                             FieldValue.serverTimestamp(),
            };
            if (currency === 'USD') {
              autoReleaseUpdate.availableBalance = FieldValue.increment(sellerAmount);
            }
            await db.collection('users').doc(sellerUid).update(autoReleaseUpdate);
          }

          await docSnap.ref.update({
            status:          'completed',
            completedAt:     FieldValue.serverTimestamp(),
            autoReleased:    true,
            updatedAt:       FieldValue.serverTimestamp(),
          });

          /* ── Update escrow-holds record ── */
          try {
            const holdQuery = await db.collection('escrow-holds')
              .where('invoiceId', '==', docSnap.id)
              .where('status', '==', 'held')
              .limit(1)
              .get();
            if (!holdQuery.empty) {
              await holdQuery.docs[0].ref.update({ status: 'released', releasedAt: FieldValue.serverTimestamp() });
            }
          } catch (_) {}

          console.log(`Auto-released escrow for invoice ${docSnap.id}, seller ${sellerUid}, amount ${sellerAmount} ${currency}.`);
          results.invoiceEscrowReleased = (results.invoiceEscrowReleased || 0) + 1;
        } catch (err) {
          console.error(`Failed to auto-release escrow for invoice ${docSnap.id}:`, err.message);
          results.invoiceEscrowFailed = (results.invoiceEscrowFailed || 0) + 1;
        }
      }
    }
  } catch (err) {
    console.error('scheduled-clear-earnings: invoice escrow-release query failed (may need composite index on invoices.status + invoices.deliveredAt):', err.message);
  }

  console.log('scheduled-clear-earnings: complete —', JSON.stringify(results));

  return respond(200, results);
};

/* ── Utility ── */
function respond(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
