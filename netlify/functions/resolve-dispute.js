/**
 * Netlify Function: resolve-dispute.js
 * Path: netlify/functions/resolve-dispute.js
 *
 * Called by admin.html when an admin issues a ruling on a dispute
 * (Rule Freelancer Wins / Rule Buyer Wins / Custom Split).
 *
 * - Verifies the request via shared ADMIN_SECRET (same pattern as
 *   kyc-approve.js — fails closed if ADMIN_SECRET is unset).
 * - Loads the disputed record. disputeId is the projects/{id} or
 *   invoices/{id} document ID (the same convention raise-dispute.js
 *   already uses when it writes disputedAt/disputedBy onto that doc
 *   and passes disputeId: projectId / disputeId: invoiceId to the
 *   dispute-raised email — there is no separate disputes/{id} doc to
 *   resolve, project/invoice docs hold dispute state directly).
 * - Splits the escrowed netAmount between freelancer/seller and buyer
 *   per freelancerPercent (0, 50, 100, or any custom split).
 * - Credits each party's balances.{CURRENCY} (+ availableBalance for USD),
 *   matching the exact crediting pattern used by approve-delivery.js and
 *   confirm-invoice-delivery.js for normal escrow release.
 * - Sets status → resolved, escrowStatus → released, records the ruling.
 * - Notifies both parties (push + in-app + 'dispute-resolved' email).
 *
 * POST body:
 *   {
 *     disputeId:         string,            // projects/{id} or invoices/{id}
 *     type:               'project'|'invoice' (default 'project'),
 *     winner:             'freelancer'|'buyer'|'split',
 *     freelancerPercent:  number (0-100),
 *     adminSecret:        string
 *   }
 *
 * Environment variables required:
 *   FIREBASE_SERVICE_ACCOUNT  — full service account JSON
 *   PLATFORM_URL              — live domain e.g. https://kreddlo.space
 *   INTERNAL_FUNCTION_SECRET  — shared secret for the internal
 *                               send-smart-notification call
 *   ADMIN_SECRET              — shared secret the admin frontend sends
 *                               (window.ADMIN_SECRET in admin.html)
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

/* ── Internal function caller (function-to-function via HTTP) ── */
async function callFunction(functionName, payload) {
  const platformUrl = (process.env.PLATFORM_URL || 'https://kreddlo.space').replace(/\/$/, '');
  if (!platformUrl) {
    console.warn(`PLATFORM_URL not set — cannot call ${functionName}.`);
    return;
  }

  try {
    const res = await fetch(`${platformUrl}/.netlify/functions/${functionName}`, {
      method:  'POST',
      headers: {
        'Content-Type':     'application/json',
        'x-internal-secret': process.env.INTERNAL_FUNCTION_SECRET || '',
      },
      body:    JSON.stringify(payload),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.warn(`${functionName} returned ${res.status}: ${errText}`);
    }
  } catch (err) {
    // Non-fatal — the core Firestore update already succeeded
    console.error(`Failed to call ${functionName}:`, err.message);
  }
}

/* ── Credit a per-currency balance onto a user doc ── */
async function creditUser(db, uid, currency, amount) {
  if (!uid || amount <= 0) return;
  const update = {
    [`balances.${currency}`]: FieldValue.increment(amount),
    updatedAt:                FieldValue.serverTimestamp(),
  };
  if (currency === 'USD') {
    update.availableBalance = FieldValue.increment(amount);
  }
  await db.collection('users').doc(uid).update(update);
}

/* ══════════════════════════════════════════════════════════════
   HANDLER
══════════════════════════════════════════════════════════════ */
exports.handler = async (event) => {

  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        'Access-Control-Allow-Origin':  '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    };
  }

  if (event.httpMethod !== 'POST') {
    return respond(405, { error: 'Method not allowed.' });
  }

  /* ── Parse body ── */
  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return respond(400, { error: 'Invalid JSON body.' });
  }

  const {
    disputeId,
    type,
    winner,
    freelancerPercent,
    adminSecret,
  } = payload;

  /* ── Shared-secret admin auth — fails closed, same pattern as
     kyc-approve.js. A missing server secret is a server
     misconfiguration, not an open door. ── */
  const serverSecret = process.env.ADMIN_SECRET;
  if (!serverSecret || adminSecret !== serverSecret) {
    return respond(403, { error: 'Forbidden.' });
  }

  /* ── Validate ── */
  if (!disputeId || typeof disputeId !== 'string') {
    return respond(400, { error: 'disputeId is required.' });
  }
  if (!['freelancer', 'buyer', 'split'].includes(winner)) {
    return respond(400, { error: 'winner must be freelancer, buyer, or split.' });
  }
  const fPct = Number(freelancerPercent);
  if (!Number.isFinite(fPct) || fPct < 0 || fPct > 100) {
    return respond(400, { error: 'freelancerPercent must be a number between 0 and 100.' });
  }
  const recordType = type === 'invoice' ? 'invoice' : 'project';
  const collection  = recordType === 'invoice' ? 'invoices' : 'projects';

  /* ── Init Firestore ── */
  let db;
  try {
    db = getDb();
  } catch (err) {
    console.error('Firebase Admin init failed:', err.message);
    return respond(500, { error: 'Database not available.' });
  }

  /* ── Fetch the disputed record ── */
  let snap;
  try {
    snap = await db.collection(collection).doc(disputeId).get();
  } catch (err) {
    console.error(`Firestore read failed for ${collection}/${disputeId}:`, err.message);
    return respond(500, { error: 'Database read failed.' });
  }

  if (!snap.exists) {
    return respond(404, { error: 'Disputed record not found.' });
  }

  const record = snap.data();

  /* ── Guard: must actually be disputed ── */
  if (record.status !== 'disputed') {
    return respond(409, { error: `This record is not currently disputed (status: "${record.status}").` });
  }

  const currency      = (record.currency || 'USD').toUpperCase();
  /* FIX: previously this read record.netAmount || record.amount, which
     works for projects (netAmount is the correct field there) but is
     wrong for invoices — invoices never have netAmount or amount, they
     have `total` (the gross amount the buyer paid, set at invoice
     creation) and `escrowSellerAmount` (total minus platformFee, set by
     the payment webhook once funds actually land in escrow — see
     stripe-webhook.js / flutterwave-webhook.js / nowpayments-webhook.js).
     Reading `total` here would have let an admin ruling "100% to
     freelancer" pay out the platform's own fee along with it, since
     `total` includes that fee and `escrowSellerAmount` already excludes
     it. raise-dispute.js only allows disputing invoices already in
     'escrow' or 'delivered' status, both set by the same webhook that
     sets escrowSellerAmount, so it's guaranteed present by the time a
     dispute exists. Project disputes are unaffected — netAmount is
     checked first and is unchanged for that path. */
  const grossAmount   = recordType === 'invoice'
    ? Number(record.escrowSellerAmount || record.total || 0)
    : Number(record.netAmount || record.amount || 0);
  const buyerUid       = record.buyerUid || null;
  const freelancerUid  = recordType === 'invoice'
    ? (record.sellerUid || record.uid || null)
    : (record.freelancerUid || null);
  const recordTitle   = record.projectTitle || record.title || record.invoiceNumber || disputeId;

  if (grossAmount <= 0) {
    return respond(400, { error: 'Disputed record has no escrowed amount to distribute.' });
  }

  const freelancerAmount = Math.round(grossAmount * (fPct / 100) * 100) / 100;
  const buyerAmount      = Math.round((grossAmount - freelancerAmount) * 100) / 100;

  /* ── Update the record: resolved + escrow released ── */
  try {
    await db.collection(collection).doc(disputeId).update({
      status:             'resolved',
      escrowStatus:       'released',
      disputeRuling:       winner,
      disputeFreelancerPct: fPct,
      disputeResolvedAt:   FieldValue.serverTimestamp(),
      updatedAt:           FieldValue.serverTimestamp(),
    });
    console.log(`Dispute resolved on ${collection}/${disputeId}: winner=${winner}, freelancerPercent=${fPct}.`);
  } catch (err) {
    console.error(`Firestore update failed for ${collection}/${disputeId}:`, err.message);
    return respond(500, { error: 'Failed to update record status.' });
  }

  /* ── Sync the disputes/{disputeId} record admin.html's table reads from
     (see raise-dispute.js — this is the doc that populates loadDisputes()).
     Without this, the table would still show "Open" on the next reload
     even though the underlying project/invoice was correctly resolved
     above, since admin.html's optimistic local-state update only lasts
     for the current session. Non-fatal: the ruling itself, recorded
     above, is what actually matters — this just keeps the listing
     accurate. ── */
  try {
    await db.collection('disputes').doc(disputeId).update({
      status:    'resolved',
      updatedAt: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.warn(`Could not sync disputes/${disputeId} status (non-fatal — ruling already recorded):`, err.message);
  }

  /* ── Distribute escrow ──
     Errors here are logged but non-fatal: the ruling itself is already
     recorded, so a balance-credit failure doesn't leave the record stuck
     in 'disputed' limbo — it just needs manual reconciliation. ── */
  try {
    await Promise.all([
      creditUser(db, freelancerUid, currency, freelancerAmount),
      creditUser(db, buyerUid, currency, buyerAmount),
    ]);
    console.log(`Distributed ${currency} ${freelancerAmount} to freelancer/seller, ${currency} ${buyerAmount} to buyer.`);
  } catch (err) {
    console.error(`Balance credit failed for dispute ${disputeId}:`, err.message);
  }

  /* ── Fetch user details for notifications ── */
  let freelancerEmail = null;
  let freelancerName  = 'Freelancer';
  let buyerEmail      = null;
  let buyerName       = 'Client';

  try {
    const fetches = [];
    if (buyerUid) fetches.push(db.collection('users').doc(buyerUid).get());
    if (freelancerUid) fetches.push(db.collection('users').doc(freelancerUid).get());
    const snaps = await Promise.all(fetches);
    snaps.forEach((s) => {
      if (!s.exists) return;
      const d = s.data();
      if (s.id === buyerUid) {
        buyerEmail = d.email || null;
        buyerName  = d.name || 'Client';
      } else if (s.id === freelancerUid) {
        freelancerEmail = d.email || null;
        freelancerName  = d.name || 'Freelancer';
      }
    });
  } catch (err) {
    console.warn('Could not fetch user details for notifications:', err.message);
  }

  const platformUrl = (process.env.PLATFORM_URL || 'https://kreddlo.space').replace(/\/$/, '');
  const amountFmt = (amt) => new Intl.NumberFormat('en', { style: 'currency', currency }).format(amt);

  const rulingText = winner === 'split'
    ? `${amountFmt(freelancerAmount)} to ${freelancerName}, ${amountFmt(buyerAmount)} to ${buyerName}.`
    : '';

  /* ── Notify buyer ── */
  if (buyerUid) {
    await callFunction('send-smart-notification', {
      userUid:    buyerUid,
      title:      'Dispute Resolved',
      body:       `A ruling has been issued on "${recordTitle}".`,
      url:        recordType === 'invoice'
        ? `${platformUrl}/invoice.html?invoiceId=${encodeURIComponent(disputeId)}`
        : `${platformUrl}/buyer-projects.html?projectId=${encodeURIComponent(disputeId)}`,
      templateId: 'dispute-resolved',
      emailMode:  buyerEmail ? 'always' : 'never',
      emailData: {
        name:         buyerName,
        projectTitle: recordTitle,
        ruling:       winner,
        rulingText,
        disputeId,
      },
    });
  }

  /* ── Notify freelancer ── */
  if (freelancerUid) {
    await callFunction('send-smart-notification', {
      userUid:    freelancerUid,
      title:      'Dispute Resolved',
      body:       `A ruling has been issued on "${recordTitle}".`,
      url:        recordType === 'invoice'
        ? `${platformUrl}/dashboard-invoices.html`
        : `${platformUrl}/dashboard-projects.html?projectId=${encodeURIComponent(disputeId)}`,
      templateId: 'dispute-resolved',
      emailMode:  freelancerEmail ? 'always' : 'never',
      emailData: {
        name:         freelancerName,
        projectTitle: recordTitle,
        ruling:       winner,
        rulingText,
        disputeId,
      },
    });
  }

  return respond(200, {
    success: true,
    message: `Ruling issued. ${amountFmt(freelancerAmount)} to freelancer, ${amountFmt(buyerAmount)} to buyer.`,
  });
};

/* ── Utility ── */
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
