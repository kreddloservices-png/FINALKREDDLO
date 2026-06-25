/**
 * Netlify Function: confirm-invoice-delivery.js
 * Path: netlify/functions/confirm-invoice-delivery.js
 *
 * Called when the buyer clicks their confirmation link (token-based, no auth required).
 * - Validates the confirmToken against the invoice doc
 * - Credits sellerAmount (read from invoice.escrowSellerAmount, set by the payment
 *   webhook when funds entered escrow) directly to the seller's balances.${currency}
 *   (and availableBalance for USD). The user doc's escrowBalance field is NOT used
 *   in the invoice flow — escrow is tracked via escrowSellerAmount on the invoice
 *   doc and the escrow-holds collection, both written server-side at payment time.
 * - Updates invoice status → completed
 * - Notifies the freelancer that funds are released
 *
 * POST body:
 *   { invoiceId: string, confirmToken: string }
 *
 * Environment variables required:
 *   FIREBASE_SERVICE_ACCOUNT
 *   PLATFORM_URL
 */

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue }     = require('firebase-admin/firestore');

let _db = null;
function getDb() {
  if (_db) return _db;
  let serviceAccount;
  try { serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}'); }
  catch { throw new Error('FIREBASE_SERVICE_ACCOUNT is not valid JSON.'); }
  if (!getApps().length) initializeApp({ credential: cert(serviceAccount) });
  _db = getFirestore();
  return _db;
}

async function callFunction(functionName, payload) {
  const platformUrl = (process.env.PLATFORM_URL || 'https://kreddlo.space').replace(/\/$/, '');
  if (!platformUrl) return;
  try {
    const res = await fetch(`${platformUrl}/.netlify/functions/${functionName}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-secret': process.env.INTERNAL_FUNCTION_SECRET || '' },
      body:    JSON.stringify(payload),
    });
    if (!res.ok) console.warn(`${functionName} returned ${res.status}: ${await res.text()}`);
  } catch (err) {
    console.error(`Failed to call ${functionName}:`, err.message);
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return respond(405, { error: 'Method not allowed.' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return respond(400, { error: 'Invalid JSON body.' }); }

  const { invoiceId, confirmToken } = body;
  if (!invoiceId || typeof invoiceId !== 'string') return respond(400, { error: 'invoiceId is required.' });
  if (!confirmToken || typeof confirmToken !== 'string') return respond(400, { error: 'confirmToken is required.' });

  let db;
  try { db = getDb(); }
  catch (err) { return respond(500, { error: 'Database not available.' }); }

  /* ── Atomic: validate token, check status, mark completed, credit balance ──
     All reads and writes that must happen together go inside one transaction.
     HTTP calls (notifications) stay outside — Firestore transactions must only
     contain Firestore reads/writes or they'll fail/retry unpredictably. ── */

  let alreadyCompleted = false;
  let sellerUid        = null;
  let sellerAmount     = 0;
  let currency         = 'USD';
  let invoiceNumber    = invoiceId;

  try {
    await db.runTransaction(async (tx) => {
      const invoiceRef  = db.collection('invoices').doc(invoiceId);
      const invoiceSnap = await tx.get(invoiceRef);

      if (!invoiceSnap.exists) {
        const err = new Error('Invoice not found.');
        err.statusCode = 404;
        throw err;
      }

      const invoice = invoiceSnap.data();

      /* Token validation */
      if (!invoice.confirmToken || invoice.confirmToken !== confirmToken) {
        const err = new Error('Invalid or expired confirmation token.');
        err.statusCode = 403;
        throw err;
      }

      /* Idempotency: already completed — set flag and exit transaction cleanly */
      if (invoice.status === 'completed') {
        alreadyCompleted = true;
        return;
      }

      /* Invoice must be in delivered state */
      if (invoice.status !== 'delivered') {
        const err = new Error(`Invoice cannot be confirmed in status "${invoice.status}".`);
        err.statusCode = 400;
        throw err;
      }

      sellerUid     = invoice.uid;
      sellerAmount  = Number(invoice.escrowSellerAmount || 0);
      currency      = (invoice.currency || 'USD').toUpperCase();
      invoiceNumber = invoice.invoiceNumber || invoiceId;

      if (!sellerUid) {
        const err = new Error('Invoice has no seller.');
        err.statusCode = 400;
        throw err;
      }

      /* Mark invoice completed */
      tx.update(invoiceRef, {
        status:      'completed',
        completedAt: FieldValue.serverTimestamp(),
        updatedAt:   FieldValue.serverTimestamp(),
      });

      /* Atomically credit seller balance in the same transaction */
      if (sellerAmount > 0) {
        const userRef = db.collection('users').doc(sellerUid);
        const balanceUpdate = {
          [`balances.${currency}`]:             FieldValue.increment(sellerAmount),
          // Legacy blended figure — kept for older admin tooling only.
          totalEarned:                          FieldValue.increment(sellerAmount),
          // Accurate, currency-separated figure for any seller-facing display.
          [`totalEarnedByCurrency.${currency}`]: FieldValue.increment(sellerAmount),
          updatedAt:                             FieldValue.serverTimestamp(),
        };
        if (currency === 'USD') {
          balanceUpdate.availableBalance = FieldValue.increment(sellerAmount);
        }
        tx.update(userRef, balanceUpdate);
      }
    });
  } catch (err) {
    const code = err.statusCode || 500;
    if (code === 404) return respond(404, { error: err.message });
    if (code === 403) return respond(403, { error: err.message });
    if (code === 400) return respond(400, { error: err.message });
    console.error(`Transaction failed for invoice ${invoiceId}:`, err.message);
    return respond(500, { error: 'Failed to confirm invoice delivery.' });
  }

  /* Idempotency short-circuit — transaction saw it was already completed */
  if (alreadyCompleted) {
    return respond(200, { success: true, message: 'This delivery was already confirmed.' });
  }

  console.log(`Invoice ${invoiceId} confirmed as completed. Released ${sellerAmount} ${currency} to seller ${sellerUid}.`);

  /* ── Update escrow-holds record (outside transaction — query not tx-safe) ── */
  if (sellerAmount > 0) {
    try {
      const holdQuery = await db.collection('escrow-holds')
        .where('invoiceId', '==', invoiceId)
        .where('status', '==', 'held')
        .limit(1)
        .get();
      if (!holdQuery.empty) {
        await holdQuery.docs[0].ref.update({ status: 'released', releasedAt: FieldValue.serverTimestamp() });
      }
    } catch (_) {}
  }

  /* ── Fetch seller details for notification ── */
  let freelancerName  = 'Freelancer';
  let freelancerEmail = null;
  try {
    const fSnap = await db.collection('users').doc(sellerUid).get();
    if (fSnap.exists) {
      freelancerName  = fSnap.data().name || fSnap.data().displayName || 'Freelancer';
      freelancerEmail = fSnap.data().email || null;
    }
  } catch (_) {}

  const platformUrl   = (process.env.PLATFORM_URL || 'https://kreddlo.space').replace(/\/$/, '');
  const amountFormatted = new Intl.NumberFormat('en', { style: 'currency', currency }).format(sellerAmount);

  /* ── Notify freelancer: funds released ── */
  await callFunction('send-smart-notification', {
    userUid:    sellerUid,
    title:      'Invoice Payment Released',
    body:       `Your client confirmed delivery for invoice ${invoiceNumber}. ${amountFormatted} is now available.`,
    url:        `${platformUrl}/dashboard-invoices.html`,
    templateId: 'invoice-escrow-released',
    emailMode:  freelancerEmail ? 'always' : 'never',
    emailData: {
      name:          freelancerName,
      invoiceNumber,
      amount:        amountFormatted,
      dashboardUrl:  `${platformUrl}/dashboard-invoices.html`,
    },
  });

  return respond(200, { success: true, message: 'Delivery confirmed. Funds have been released to the freelancer.' });
};

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(body),
  };
}
