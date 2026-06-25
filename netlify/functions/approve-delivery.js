/**
 * Netlify Function: approve-delivery.js
 * Path: netlify/functions/approve-delivery.js
 *
 * Called when a buyer approves a delivered project, OR automatically by
 * scheduled-subscriptions.js after 72 hours of inactivity.
 *
 * - Verifies the caller is the project's buyer (JWT path) OR a trusted
 *   internal function (x-internal-secret path, used by the scheduler)
 * - Updates the project: status → completed, escrowStatus → released
 * - Credits the net amount to the freelancer's availableBalance
 * - Notifies the freelancer (push + in-app + email) that payment is on its way
 *   (the buyer is already notified separately, at delivery-submission time,
 *   by netlify/functions/submit-delivery.js — not duplicated here)
 *
 * POST body:
 *   { projectId: string, buyerUid: string }
 *
 * Auth paths (either one must pass):
 *   1. Firebase ID token in Authorization header — buyer approving manually.
 *      The token uid must match the project's buyerUid.
 *   2. x-internal-secret header matching INTERNAL_FUNCTION_SECRET — trusted
 *      server-to-server call (e.g. scheduled auto-approval after 72 h).
 *      buyerUid must still be supplied in the body; it is validated against
 *      the project document before any write is performed.
 *
 * Environment variables required:
 *   FIREBASE_SERVICE_ACCOUNT    — full service account JSON
 *   PLATFORM_URL                — live domain e.g. https://kreddlo.space
 *   INTERNAL_FUNCTION_SECRET    — shared secret for server-to-server calls
 */

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue }     = require('firebase-admin/firestore');
const { verifyCaller }                 = require('./_verify-auth');

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

/* ══════════════════════════════════════════════════════════════
   HANDLER
══════════════════════════════════════════════════════════════ */
exports.handler = async (event) => {

  /* ── Accept POST only ── */
  if (event.httpMethod !== 'POST') {
    return respond(405, { error: 'Method not allowed.' });
  }

  /* ── Verify caller identity (two accepted paths) ── */
  //
  // Path 1 — Internal server-to-server call (e.g. scheduled-subscriptions.js
  //   auto-approving after 72 h). Identified by the x-internal-secret header.
  //   buyerUid must be supplied in the body; it is validated against the
  //   project document before any write is performed.
  //
  // Path 2 — Authenticated buyer calling from the browser. A Firebase ID token
  //   in the Authorization header is verified and its uid used directly.
  //   Any buyerUid in the body must match the verified token uid.
  //
  const incomingSecret  = event.headers['x-internal-secret'] || event.headers['X-Internal-Secret'] || '';
  const expectedSecret  = process.env.INTERNAL_FUNCTION_SECRET || '';
  const isTrustedInternal = !!expectedSecret && incomingSecret === expectedSecret;

  /* ── Parse body ── */
  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return respond(400, { error: 'Invalid JSON body.' });
  }

  const { projectId, buyerUid: bodyBuyerUid } = payload;

  let buyerUid;

  if (isTrustedInternal) {
    // Internal path: trust the buyerUid from the body; validate against Firestore below.
    if (!bodyBuyerUid || typeof bodyBuyerUid !== 'string') {
      return respond(400, { error: 'buyerUid is required for internal calls.' });
    }
    buyerUid = bodyBuyerUid;
  } else {
    // Browser path: verify the Firebase ID token.
    const callerUid = await verifyCaller(event);
    if (!callerUid) {
      return respond(401, { error: 'Unauthorized. Please log in again.' });
    }
    // If client also sent buyerUid in body, it must match the verified token.
    if (bodyBuyerUid && bodyBuyerUid !== callerUid) {
      return respond(403, { error: 'Caller identity mismatch.' });
    }
    buyerUid = callerUid;
  }

  if (!projectId || typeof projectId !== 'string') {
    return respond(400, { error: 'projectId is required.' });
  }

  /* ── Init Firestore ── */
  let db;
  try {
    db = getDb();
  } catch (err) {
    console.error('Firebase Admin init failed:', err.message);
    return respond(500, { error: 'Database not available.' });
  }

  /* ── Fetch project ── */
  let projectSnap;
  try {
    projectSnap = await db.collection('projects').doc(projectId).get();
  } catch (err) {
    console.error(`Firestore read failed for project ${projectId}:`, err.message);
    return respond(500, { error: 'Database read failed.' });
  }

  if (!projectSnap.exists) {
    return respond(404, { error: 'Project not found.' });
  }

  const project = projectSnap.data();

  /* ── Verify caller is the project buyer ── */
  if (project.buyerUid !== buyerUid) {
    return respond(403, { error: 'You are not authorised to approve this delivery.' });
  }

  /* ── Guard against double-approval ── */
  if (project.status === 'completed') {
    return respond(409, { error: 'This delivery has already been approved.' });
  }

  /* ── Guard: project must be in a deliverable state ── */
  if (!['in_progress', 'delivered'].includes(project.status)) {
    return respond(400, { error: `Cannot approve a project with status "${project.status}".` });
  }

  const netAmount      = Number(project.netAmount || 0);
  const projectCurrency = (project.currency || 'USD').toUpperCase();
  const freelancerUid  = project.freelancerUid || null;
  const projectTitle   = project.projectTitle || 'Your project';

  if (!freelancerUid) {
    return respond(400, { error: 'Project has no freelancer assigned.' });
  }
  if (netAmount <= 0) {
    return respond(400, { error: 'Project net amount is zero or not set.' });
  }

  const amountFormatted = new Intl.NumberFormat('en', { style: 'currency', currency: projectCurrency }).format(netAmount);

  /* ── Update project: mark as completed ── */
  try {
    await db.collection('projects').doc(projectId).update({
      status:       'completed',
      escrowStatus: 'released',
      completedAt:  FieldValue.serverTimestamp(),
      updatedAt:    FieldValue.serverTimestamp(),
    });
    console.log(`Project ${projectId} marked completed.`);
  } catch (err) {
    console.error(`Firestore update failed for project ${projectId}:`, err.message);
    return respond(500, { error: 'Failed to update project status.' });
  }

  /* ── Credit the freelancer's per-currency balance ── */
  try {
    const approveUpdate = {
      [`balances.${projectCurrency}`]:             FieldValue.increment(netAmount),
      // totalEarned is a legacy blended (all-currencies-summed) figure kept
      // only for older admin tooling that hasn't been migrated. It must
      // NEVER be shown to a freelancer as "earnings" — it can mix USD+NGN+
      // EUR raw numbers together. Use totalEarnedByCurrency for any
      // freelancer-facing earnings display instead.
      totalEarned:                                 FieldValue.increment(netAmount),
      [`totalEarnedByCurrency.${projectCurrency}`]: FieldValue.increment(netAmount),
      updatedAt:                                    FieldValue.serverTimestamp(),
    };
    if (projectCurrency === 'USD') {
      approveUpdate.availableBalance = FieldValue.increment(netAmount);
    }
    await db.collection('users').doc(freelancerUid).update(approveUpdate);
    console.log(`Credited ${amountFormatted} to freelancer ${freelancerUid}.`);
  } catch (err) {
    console.error(`Failed to credit freelancer ${freelancerUid}:`, err.message);
    // We still continue — the project is marked completed. Admin can manually credit.
  }

  /* ── Fetch user details for notifications and emails ── */
  let freelancerEmail = null;
  let freelancerName  = 'Freelancer';
  let buyerEmail      = null;
  let buyerName       = 'Client';

  try {
    const [fSnap, bSnap] = await Promise.all([
      db.collection('users').doc(freelancerUid).get(),
      db.collection('users').doc(buyerUid).get(),
    ]);
    if (fSnap.exists) {
      freelancerEmail = fSnap.data().email || null;
      freelancerName  = fSnap.data().name  || 'Freelancer';
    }
    if (bSnap.exists) {
      buyerEmail = bSnap.data().email || null;
      buyerName  = bSnap.data().name  || 'Client';
    }
  } catch (err) {
    console.warn('Could not fetch user details for notifications:', err.message);
  }

  const platformUrl  = (process.env.PLATFORM_URL || 'https://kreddlo.space').replace(/\/$/, '');
  const projectUrl   = `${platformUrl}/dashboard-projects.html?projectId=${encodeURIComponent(projectId)}`;
  const buyerProjUrl = `${platformUrl}/buyer-projects.html?projectId=${encodeURIComponent(projectId)}`;

  /* ── Notify the freelancer: work approved, payment on the way ── */
  await callFunction('send-smart-notification', {
    userUid:    freelancerUid,
    title:      'Work Approved',
    body:       `"${projectTitle}" has been approved. Your payment is on its way.`,
    url:        projectUrl,
    templateId: 'payment-received',
    emailMode:  freelancerEmail ? 'always' : 'never',
    emailData: {
      name:         freelancerName,
      projectTitle,
      amount:       amountFormatted,
      buyerName,
    },
  });

  /* ── Notify the buyer: delivery confirmed ── */
  if (buyerUid || buyerEmail) {
    await callFunction('send-smart-notification', {
      userUid:    buyerUid || null,
      title:      'Delivery Confirmed',
      body:       `You have approved the delivery for "${projectTitle}". The project is now complete.`,
      url:        buyerProjUrl,
      templateId: 'delivery-confirmed-buyer',
      emailMode:  buyerEmail ? 'always' : 'never',
      emailData: {
        name:         buyerName,
        freelancerName,
        projectTitle,
        dashboardUrl: buyerProjUrl,
      },
    });
  }

  /* ── B6: Fire-and-forget referral credit check ── */
  try {
    const baseUrl = process.env.PLATFORM_URL || process.env.URL || 'https://kreddlo.space';
    fetch(`${baseUrl}/.netlify/functions/process-referral-credit`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ completedByUid: buyerUid, projectId }),
    }).catch(err => console.warn('[approve-delivery] referral-credit fire-and-forget error:', err.message));
  } catch (refErr) {
    console.warn('[approve-delivery] referral-credit hook failed (non-fatal):', refErr.message);
  }

  return respond(200, {
    success: true,
    message: `Delivery approved. ${amountFormatted} credited to ${freelancerName}.`,
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
