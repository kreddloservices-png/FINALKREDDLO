/**
 * Netlify Function: submit-invoice-delivery.js
 * Path: netlify/functions/submit-invoice-delivery.js
 *
 * Called when a freelancer marks an invoice as delivered.
 * - Verifies the caller is the invoice owner (sellerUid)
 * - Updates the invoice: status → delivered, deliveredAt → now
 * - Emails the buyer a confirmation link (token-based, no login required)
 * - Emails the freelancer a "delivery submitted" confirmation
 *
 * POST body:
 *   { invoiceId: string }
 *
 * Environment variables required:
 *   FIREBASE_SERVICE_ACCOUNT
 *   PLATFORM_URL
 */

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue }     = require('firebase-admin/firestore');
const { verifyCaller }                 = require('./_verify-auth');
const { randomBytes }                  = require('crypto');

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

/*
 * FIX: this token is the sole authorization for confirm-invoice-delivery.js
 * to release escrowed funds to the seller — it needed to be unguessable,
 * not just "random enough". The previous implementation used Math.random(),
 * which is not cryptographically secure (predictable PRNG, not meant for
 * security tokens), plus a Date.now() suffix that narrows the search space
 * even further. Now uses crypto.randomBytes for a 256-bit token.
 */
function makeToken() {
  return randomBytes(32).toString('hex');
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return respond(405, { error: 'Method not allowed.' });

  const callerUid = await verifyCaller(event);
  if (!callerUid) return respond(401, { error: 'Unauthorized. Please log in again.' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return respond(400, { error: 'Invalid JSON body.' }); }

  const { invoiceId } = body;
  if (!invoiceId || typeof invoiceId !== 'string') return respond(400, { error: 'invoiceId is required.' });

  let db;
  try { db = getDb(); }
  catch (err) { return respond(500, { error: 'Database not available.' }); }

  /* ── Fetch invoice ── */
  let invoiceSnap;
  try { invoiceSnap = await db.collection('invoices').doc(invoiceId).get(); }
  catch (err) { return respond(500, { error: 'Database read failed.' }); }

  if (!invoiceSnap.exists) return respond(404, { error: 'Invoice not found.' });
  const invoice = invoiceSnap.data();

  /* ── Verify caller is the invoice owner ── */
  if (invoice.uid !== callerUid) return respond(403, { error: 'Not authorised for this invoice.' });

  /* ── Invoice must be in escrow to mark delivered ── */
  if (invoice.status !== 'escrow') {
    return respond(400, { error: `Invoice must be in escrow to mark as delivered (current status: ${invoice.status}).` });
  }

  /* ── Generate a confirmation token for the buyer ── */
  const confirmToken = makeToken();
  const platformUrl  = (process.env.PLATFORM_URL || 'https://kreddlo.space').replace(/\/$/, '');

  /* ── Update invoice ── */
  try {
    await db.collection('invoices').doc(invoiceId).update({
      status:       'delivered',
      deliveredAt:  FieldValue.serverTimestamp(),
      confirmToken,
      updatedAt:    FieldValue.serverTimestamp(),
    });
    console.log(`Invoice ${invoiceId} marked as delivered by ${callerUid}.`);
  } catch (err) {
    return respond(500, { error: 'Failed to update invoice status.' });
  }

  /* ── Fetch user details ── */
  let freelancerName = 'Freelancer';
  let freelancerEmail = null;
  const clientEmail  = (invoice.clientEmail || '').trim().toLowerCase();
  const clientName   = invoice.clientName || 'Client';
  const invoiceNumber = invoice.invoiceNumber || invoiceId;

  try {
    const fSnap = await db.collection('users').doc(callerUid).get();
    if (fSnap.exists) {
      freelancerName  = fSnap.data().name || fSnap.data().displayName || 'Freelancer';
      freelancerEmail = fSnap.data().email || null;
    }
  } catch (_) {}

  const confirmUrl = `${platformUrl}/invoice.html?invoiceId=${encodeURIComponent(invoiceId)}&confirmToken=${encodeURIComponent(confirmToken)}`;

  /* ── Email buyer: delivery confirmation link ── */
  if (clientEmail) {
    await callFunction('send-email', {
      to:     clientEmail,
      toName: clientName,
      type:   'invoice-delivered-buyer',
      data: {
        name:           clientName,
        freelancerName,
        invoiceNumber,
        confirmUrl,
      },
    });
  }

  /* ── Email seller: delivery submitted confirmation ── */
  if (freelancerEmail) {
    await callFunction('send-email', {
      to:     freelancerEmail,
      toName: freelancerName,
      type:   'invoice-delivered-seller',
      data: {
        name:          freelancerName,
        invoiceNumber,
        clientName,
      },
    });
  }

  return respond(200, { success: true, message: 'Invoice marked as delivered. The client has been notified to confirm.' });
};

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(body),
  };
}
