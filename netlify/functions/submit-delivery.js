/**
 * Netlify Function: submit-delivery.js
 * Path: netlify/functions/submit-delivery.js
 *
 * Called when a freelancer submits a delivery for a project.
 * - Verifies the caller is the project's assigned freelancer
 * - Updates the project: status → delivered, stores delivery note/files/links
 * - Notifies the buyer (push + in-app + email) via send-smart-notification
 *
 * File uploads to Firebase Storage happen client-side before this is called
 * (Storage rules are keyed to the signed-in user's own auth context) — this
 * function only receives the resulting download URLs, not the files.
 *
 * POST body:
 *   {
 *     projectId:      string,
 *     freelancerUid:  string,   // must match the verified caller's uid
 *     deliveryNote:   string,
 *     deliveryFiles:  string[], // download URLs, already uploaded
 *     deliveryLinks:  string
 *   }
 *
 * Environment variables required:
 *   FIREBASE_SERVICE_ACCOUNT   — full service account JSON
 *   PLATFORM_URL               — live domain e.g. https://kreddlo.space
 *   INTERNAL_FUNCTION_SECRET   — shared secret for the internal call to
 *                                send-smart-notification (server-to-server)
 */

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue }     = require('firebase-admin/firestore');
const { verifyCaller }                 = require('./_verify-auth');
const { sanitizeString }               = require('./_sanitize');

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

  /* ── Verify caller identity ── */
  const callerUid = await verifyCaller(event);
  if (!callerUid) {
    return respond(401, { error: 'Unauthorized. Please log in again.' });
  }

  /* ── Parse body ── */
  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return respond(400, { error: 'Invalid JSON body.' });
  }

  const {
    projectId,
    freelancerUid: bodyFreelancerUid,
    deliveryNote  = '',
    deliveryFiles = [],
    deliveryLinks = '',
  } = payload;

  // Sanitize free-text delivery message before Firestore write
  const safeDeliveryNote  = sanitizeString(deliveryNote,  2000);
  const safeDeliveryLinks = sanitizeString(deliveryLinks, 2048);

  // Use verified uid; if client also sent freelancerUid and it mismatches, reject
  if (bodyFreelancerUid && bodyFreelancerUid !== callerUid) {
    return respond(403, { error: 'Caller identity mismatch.' });
  }
  const freelancerUid = callerUid;

  if (!projectId || typeof projectId !== 'string') {
    return respond(400, { error: 'projectId is required.' });
  }
  if (!Array.isArray(deliveryFiles)) {
    return respond(400, { error: 'deliveryFiles must be an array of URLs.' });
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

  /* ── Verify caller is the project's assigned freelancer ── */
  if (project.freelancerUid !== freelancerUid) {
    return respond(403, { error: 'You are not authorised to submit a delivery for this project.' });
  }

  /* ── Guard: project must be in a state that can accept a delivery ── */
  if (!['in_progress', 'delivered', 'funded'].includes(project.status)) {
    return respond(400, { error: `Cannot submit a delivery for a project with status "${project.status}".` });
  }

  const buyerUid      = project.buyerUid || null;
  const projectTitle  = project.projectTitle || project.title || 'Your project';

  /* ── Update project: mark as delivered ── */
  try {
    await db.collection('projects').doc(projectId).update({
      status:        'delivered',
      deliveryNote:  safeDeliveryNote,
      deliveryFiles,
      deliveryLinks: safeDeliveryLinks,
      deliveredAt:   FieldValue.serverTimestamp(),
      updatedAt:     FieldValue.serverTimestamp(),
    });
    console.log(`Project ${projectId} marked delivered by freelancer ${freelancerUid}.`);
  } catch (err) {
    console.error(`Firestore update failed for project ${projectId}:`, err.message);
    return respond(500, { error: 'Failed to update project status.' });
  }

  /* ── Fetch user details for notification/email ── */
  let buyerEmail      = null;
  let buyerName       = 'Client';
  let freelancerName  = 'Your freelancer';

  try {
    const [bSnap, fSnap] = await Promise.all([
      buyerUid ? db.collection('users').doc(buyerUid).get() : Promise.resolve(null),
      db.collection('users').doc(freelancerUid).get(),
    ]);
    if (bSnap && bSnap.exists) {
      buyerEmail = bSnap.data().email || null;
      buyerName  = bSnap.data().name  || 'Client';
    }
    if (fSnap.exists) {
      freelancerName = fSnap.data().name || 'Your freelancer';
    }
  } catch (err) {
    console.warn('Could not fetch user details for notification:', err.message);
  }

  const platformUrl = (process.env.PLATFORM_URL || 'https://kreddlo.space').replace(/\/$/, '');
  const projectUrl  = `${platformUrl}/buyer-projects.html?projectId=${encodeURIComponent(projectId)}`;

  /* ── Notify the buyer: work delivered ── */
  if (buyerUid) {
    await callFunction('send-smart-notification', {
      userUid:    buyerUid,
      title:      'Work Delivered',
      body:       `"${projectTitle}" has been marked as delivered. Please review and approve.`,
      url:        projectUrl,
      templateId: 'work-delivered',
      emailMode:  'never',
      emailData: {
        name:           buyerName,
        projectTitle,
        freelancerName,
        deliveryNote:   safeDeliveryNote,
      },
    });
  }

  return respond(200, {
    success: true,
    message: 'Delivery submitted. The client has been notified.',
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
