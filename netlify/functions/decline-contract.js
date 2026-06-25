/**
 * Netlify Function: decline-contract.js
 * Path: netlify/functions/decline-contract.js
 *
 * Fix #1 (follow-up) — Real backend for declining a contract.
 *
 * Previously, "Decline" on dashboard-projects.html (declineContract()) was
 * entirely client-side: it showed a success toast and set the project's
 * status to 'cancelled' in local memory only. Nothing was written to
 * Firestore and the buyer was never actually notified — so a declined
 * contract would "come back" on refresh and the buyer had no idea anything
 * happened. This function makes decline a real, persisted action.
 *
 * Either party (buyer or freelancer) may decline a contract while it is
 * still in `pending_payment` (i.e. before escrow has been funded). Once
 * funded/active, declining isn't appropriate — raise-dispute.js or the
 * existing cancellation flow should be used instead, so this function
 * mirrors the same "pre-funding only" guard already used in
 * propose-changes.js.
 *
 * POST body:
 *   {
 *     projectId: string   — Firestore projects doc ID
 *     reason?:   string   — optional short note shown to the other party
 *   }
 *
 * Success response (200):
 *   { ok: true }
 *
 * Error responses:
 *   400 — missing/invalid projectId
 *   401 — not authenticated
 *   403 — caller is not a party to this project
 *   404 — project not found
 *   409 — project is no longer pending (already funded/active/cancelled/etc.)
 *   500 — internal error
 *
 * Environment variables required:
 *   FIREBASE_SERVICE_ACCOUNT  — full service account JSON as one-line string
 *   PLATFORM_URL              — live domain e.g. https://kreddlo.space
 *   INTERNAL_FUNCTION_SECRET  — shared secret for server-to-server calls
 */

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue }      = require('firebase-admin/firestore');
const { verifyCaller }                  = require('./_verify-auth');

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

/* ── Utility: build a Netlify function response ── */
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

/* ── Internal function caller (server-to-server) ── */
async function callFunction(name, payload) {
  const platformUrl = (process.env.PLATFORM_URL || 'https://kreddlo.space').replace(/\/$/, '');
  if (!platformUrl) {
    console.warn(`[decline-contract] PLATFORM_URL not set — cannot call ${name}.`);
    return;
  }
  try {
    const res = await fetch(`${platformUrl}/.netlify/functions/${name}`, {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-internal-secret': process.env.INTERNAL_FUNCTION_SECRET || '',
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.warn(`[decline-contract] ${name} returned ${res.status}: ${await res.text()}`);
    }
  } catch (err) {
    // Non-fatal — core Firestore write already succeeded
    console.error(`[decline-contract] Failed to call ${name}:`, err.message);
  }
}

/* ══════════════════════════════════════════════════════════════
   HANDLER
══════════════════════════════════════════════════════════════ */
exports.handler = async (event) => {

  /* ── Accept POST only ── */
  if (event.httpMethod !== 'POST') {
    return respond(405, { error: 'Method not allowed.' });
  }

  /* ── 1. Verify caller identity ── */
  const callerUid = await verifyCaller(event);
  if (!callerUid) {
    return respond(401, { error: 'Unauthorized. Please log in again.' });
  }

  /* ── 2. Parse and validate request body ── */
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return respond(400, { error: 'Invalid JSON in request body.' });
  }

  const { projectId, reason } = body;

  if (!projectId || typeof projectId !== 'string' || !projectId.trim()) {
    return respond(400, { error: 'projectId is required.' });
  }

  /* ── Init Firestore ── */
  let db;
  try {
    db = getDb();
  } catch (err) {
    console.error('[decline-contract] Firebase Admin init failed:', err.message);
    return respond(500, { error: 'Database not available.' });
  }

  const platformUrl = (process.env.PLATFORM_URL || 'https://kreddlo.space').replace(/\/$/, '');

  /* ── 3. Fetch the project doc ── */
  let projectSnap;
  try {
    projectSnap = await db.collection('projects').doc(projectId.trim()).get();
  } catch (err) {
    console.error(`[decline-contract] Firestore read failed for project ${projectId}:`, err.message);
    return respond(500, { error: 'Database read failed.' });
  }

  if (!projectSnap.exists) {
    return respond(404, { error: 'Project not found.' });
  }

  const project = projectSnap.data();

  /* ── 4. Verify caller is a party to this project ── */
  const isBuyer      = project.buyerUid      === callerUid;
  const isFreelancer = project.freelancerUid === callerUid;

  if (!isBuyer && !isFreelancer) {
    return respond(403, { error: 'You are not a party to this project.' });
  }

  /* ── 5. Guard: can only decline before escrow is funded ──
     Mirrors the same guard used in propose-changes.js. Once a contract is
     funded/active, the proper path is raise-dispute.js, not "decline". */
  if (project.status !== 'pending_payment') {
    return respond(409, {
      error: 'This contract can no longer be declined — it is already ' + project.status + '.',
    });
  }

  const projectTitle   = project.projectTitle || project.title || 'the project';
  const buyerUid        = project.buyerUid;
  const freelancerUid   = project.freelancerUid;
  const buyerName       = project.buyerName      || 'The client';
  const freelancerName  = project.freelancerName || 'The freelancer';

  const callerRole = isBuyer ? 'buyer' : 'freelancer';
  const callerName = isBuyer ? buyerName : freelancerName;
  const otherUid    = isBuyer ? freelancerUid : buyerUid;

  const declineReason = (typeof reason === 'string' ? reason.trim() : '').slice(0, 500);

  /* ── 6. Persist the decline ── */
  try {
    await db.collection('projects').doc(projectId.trim()).update({
      status:           'cancelled',
      cancelledBy:       callerUid,
      cancelledByRole:   callerRole,
      cancelledReason:   declineReason || null,
      cancelledAt:       FieldValue.serverTimestamp(),
      updatedAt:         FieldValue.serverTimestamp(),
    });
    console.log(`[decline-contract] Project ${projectId} declined by ${callerUid} (${callerRole}).`);
  } catch (err) {
    console.error(`[decline-contract] Firestore update failed for project ${projectId}:`, err.message);
    return respond(500, { error: 'Failed to decline the contract. Please try again.' });
  }

  /* ── 7. Notify the other party ── */
  if (otherUid) {
    const dashboardUrl = isBuyer
      ? `${platformUrl}/dashboard-projects.html`
      : `${platformUrl}/buyer-projects.html`;

    await callFunction('send-smart-notification', {
      userUid:    otherUid,
      title:      'Contract Declined',
      body:       declineReason
        ? `${callerName} declined "${projectTitle}": ${declineReason}`
        : `${callerName} declined "${projectTitle}". This contract has been cancelled.`,
      url:        dashboardUrl,
      templateId: 'contract-declined',
      emailMode:  'never',
      emailData: {
        projectTitle,
        declinerName: callerName,
        reason:       declineReason,
      },
    });
  }

  return respond(200, { ok: true });
};
