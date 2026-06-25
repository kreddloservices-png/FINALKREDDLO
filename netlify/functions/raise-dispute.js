/**
 * Netlify Function: raise-dispute.js
 * Path: netlify/functions/raise-dispute.js
 *
 * Called when a buyer or freelancer raises a dispute on a project.
 * - Verifies the caller is the project's buyer (raisedByRole 'buyer', default)
 *   or the project's freelancer (raisedByRole 'freelancer')
 * - Guards against duplicate disputes
 * - Updates the project: status → disputed, escrowStatus → disputed
 * - Sends notifications to both parties
 *
 * POST body:
 *   (project) { projectId: string, raisedBy: string, raisedByRole: 'buyer'|'freelancer', description: string }
 *   (invoice) { type: 'invoice', invoiceId: string, raisedBy: string, description: string, clientEmail: string }
 *
 * Environment variables required:
 *   FIREBASE_SERVICE_ACCOUNT  — full service account JSON
 *   PLATFORM_URL              — live domain e.g. https://kreddlo.space
 */

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue }     = require('firebase-admin/firestore');
const { verifyCaller }                 = require('./_verify-auth');
const { checkRateLimit }               = require('./_rate-limit');
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

  /* ── Parse body ── */
  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return respond(400, { error: 'Invalid JSON body.' });
  }

  const { type, projectId, invoiceId, raisedBy, raisedByRole, description, clientEmail } = payload;

  /* ── Verify caller identity (FIX) ──
     Previously this check ran unconditionally for every request,
     including invoice disputes — but invoice.html intentionally sends no
     Authorization header for the invoice flow (it's a public, no-login
     page, the same design as confirm-invoice-delivery.js's token-based
     access). That meant every legitimate invoice dispute submission was
     being rejected with 401 before ever reaching the invoice-handling
     code below. Project disputes still require a verified Firebase
     token; invoice disputes are authorised separately via clientEmail
     matching the invoice record (see below). */
  let callerUid = null;
  if (type !== 'invoice') {
    callerUid = await verifyCaller(event);
    if (!callerUid) {
      return respond(401, { error: 'Unauthorized. Please log in again.' });
    }
  }

  if (!raisedBy || typeof raisedBy !== 'string') {
    return respond(400, { error: 'raisedBy is required.' });
  }
  if (!description || typeof description !== 'string' || !description.trim()) {
    return respond(400, { error: 'description is required.' });
  }

  // Sanitize the free-text dispute description before writing to Firestore
  const safeDescription = sanitizeString(description, 2000);

  /* ── Init Firestore ── */
  let db;
  try {
    db = getDb();
  } catch (err) {
    console.error('Firebase Admin init failed:', err.message);
    return respond(500, { error: 'Database not available.' });
  }

  const platformUrl = (process.env.PLATFORM_URL || 'https://kreddlo.space').replace(/\/$/, '');

  /* ══════════════════════════════════════════════════════════════
     INVOICE DISPUTE PATH
     type === 'invoice': look up the invoices collection, verify
     the caller via clientEmail (buyer side only for invoices).
  ══════════════════════════════════════════════════════════════ */
  if (type === 'invoice') {
    if (!invoiceId || typeof invoiceId !== 'string') {
      return respond(400, { error: 'invoiceId is required for invoice disputes.' });
    }
    if (!clientEmail || typeof clientEmail !== 'string') {
      return respond(400, { error: 'clientEmail is required for invoice disputes.' });
    }

    /* ── Bug D fix: rate-limit the invoice dispute path ──
       The project path is protected by verifyCaller (Firebase token) which
       inherently rate-limits via the auth overhead. The invoice path skips
       verifyCaller by design (public page) so without an explicit rate limit
       anyone can spam POST to this endpoint.
       Limit: 3 attempts per invoiceId per IP per hour. This is generous
       enough for a legitimate buyer (one real dispute per invoice) while
       stopping automated replay attacks that combine Bug C + D. */
    const callerIp = (event.headers['x-forwarded-for'] || event.headers['client-ip'] || 'unknown')
      .split(',')[0].trim();
    const rlResult = await checkRateLimit(db, `dispute-inv::${invoiceId}::${callerIp}`, 3, 3600);
    if (!rlResult.allowed) {
      return respond(429, { error: rlResult.error, retryAfter: rlResult.retryAfter });
    }

    /* ── Fetch invoice ── */
    let invoiceSnap;
    try {
      invoiceSnap = await db.collection('invoices').doc(invoiceId).get();
    } catch (err) {
      console.error(`Firestore read failed for invoice ${invoiceId}:`, err.message);
      return respond(500, { error: 'Database read failed.' });
    }

    if (!invoiceSnap.exists) {
      return respond(404, { error: 'Invoice not found.' });
    }

    const invoice = invoiceSnap.data();

    /* ── Verify buyer via clientEmail ── */
    const storedClientEmail = (invoice.clientEmail || '').trim().toLowerCase();
    const suppliedEmail     = clientEmail.trim().toLowerCase();
    if (!storedClientEmail || storedClientEmail !== suppliedEmail) {
      return respond(403, { error: 'You are not authorised to raise a dispute on this invoice.' });
    }

    /* ── Guard: duplicate dispute ── */
    if (invoice.status === 'disputed') {
      return respond(409, { error: 'A dispute has already been raised on this invoice.' });
    }

    /* ── Guard: can only dispute invoices in escrow or delivered ── */
    if (!['escrow', 'delivered'].includes(invoice.status)) {
      return respond(400, { error: `Cannot raise a dispute on an invoice with status "${invoice.status}".` });
    }

    const sellerUid    = invoice.sellerUid || invoice.uid || null;
    const invoiceTitle = invoice.invoiceNumber || invoice.title || invoiceId;

    /* ── Mark invoice as disputed ── */
    try {
      await db.collection('invoices').doc(invoiceId).update({
        status:         'disputed',
        escrowStatus:   'disputed',
        disputeReason:  safeDescription,
        disputedBy:     raisedBy,
        disputedByRole: 'buyer',
        disputedAt:     FieldValue.serverTimestamp(),
        updatedAt:      FieldValue.serverTimestamp(),
      });
      console.log(`Dispute raised on invoice ${invoiceId} by ${raisedBy}.`);
    } catch (err) {
      console.error(`Firestore update failed for invoice ${invoiceId}:`, err.message);
      return respond(500, { error: 'Failed to update invoice status.' });
    }

    /* ── Fetch seller name for the disputes record (separate from the
       notification fetch below, which runs after this write) ── */
    let disputeFreelancerName = 'Freelancer';
    if (sellerUid) {
      try {
        const sellerSnapForDispute = await db.collection('users').doc(sellerUid).get();
        if (sellerSnapForDispute.exists) {
          disputeFreelancerName = sellerSnapForDispute.data().name
            || sellerSnapForDispute.data().displayName
            || 'Freelancer';
        }
      } catch (err) {
        console.warn('Could not fetch seller name for disputes record:', err.message);
      }
    }

    /* ── Create the disputes/{disputeId} record admin.html reads from ──
       FIX: this write never existed — admin.html's disputes table
       (loadDisputes(), reads collection('disputes')) was always empty
       because nothing populated it; only the invoice doc itself was
       updated. Use invoiceId as the doc ID so resolve-dispute.js (which
       takes disputeId and looks it up directly in invoices/{id}) keeps
       working unchanged. firestore.rules already permits this — the
       disputes collection allows admin read, write: if false for
       clients, so this Admin SDK write is the only way it's ever
       populated, as the rules comment already says it should be. ──
       Non-fatal if it fails: the invoice itself is already correctly
       marked disputed above, which is the half that matters for
       blocking auto-release; only the admin table listing would be
       affected, and an admin can still resolve via direct doc lookup.
       amount uses escrowSellerAmount (total minus platformFee) before
       falling back to total, matching the same field resolve-dispute.js
       actually splits — so the figure shown in admin.html's dispute
       panel and split-preview slider is the same one a ruling pays out,
       not the gross pre-fee total. */
    try {
      await db.collection('disputes').doc(invoiceId).set({
        type:               'invoice',
        invoiceId:          invoiceId,
        projectTitle:       invoiceTitle,
        buyerName:          invoice.clientName || invoice.payerName || 'Client',
        freelancerName:     disputeFreelancerName,
        amount:             Number(invoice.escrowSellerAmount || invoice.total || 0),
        contractPdfUrl:     null,
        freelancerEvidence: '',
        buyerEvidence:      safeDescription,
        status:             'open',
        createdAt:          FieldValue.serverTimestamp(),
      });
    } catch (err) {
      console.warn(`Could not create disputes/${invoiceId} record (non-fatal — invoice already marked disputed):`, err.message);
    }

    /* ── Fetch seller details for notification ── */
    let sellerEmail = null;
    let sellerName  = 'Freelancer';
    if (sellerUid) {
      try {
        const sellerSnap = await db.collection('users').doc(sellerUid).get();
        if (sellerSnap.exists) {
          sellerEmail = sellerSnap.data().email || null;
          sellerName  = sellerSnap.data().name || sellerSnap.data().displayName || 'Freelancer';
        }
      } catch (err) {
        console.warn('Could not fetch seller details for notification:', err.message);
      }
    }

    const buyerDisplayName = invoice.clientName || invoice.payerName || 'Client';

    /* ── Notify seller ── */
    if (sellerUid) {
      await callFunction('send-smart-notification', {
        userUid:    sellerUid,
        to:         sellerEmail || null,
        title:      'Dispute Raised',
        body:       `A dispute has been raised on invoice ${invoiceTitle}. Kreddlo support will review shortly.`,
        url:        `${platformUrl}/dashboard-invoices.html`,
        templateId: 'dispute-raised',
        emailMode:  sellerEmail ? 'always' : 'never',
        emailData: {
          name:          sellerName,
          projectTitle:  invoiceTitle,
          raisedByName:  buyerDisplayName,
          disputeId:     invoiceId,
        },
      });
    }

    return respond(200, {
      success: true,
      message: 'Dispute submitted. The Kreddlo team will be in touch.',
    });
  }

  /* ══════════════════════════════════════════════════════════════
     PROJECT DISPUTE PATH (original logic)
  ══════════════════════════════════════════════════════════════ */
  if (!projectId || typeof projectId !== 'string') {
    return respond(400, { error: 'projectId is required.' });
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

  /* ── Verify caller is the project buyer OR the project freelancer ──
     raisedByRole defaults to 'buyer' for backward compatibility with
     existing callers that only ever sent buyer-side disputes.
     FIX: previously this checked `raisedBy` (a client-supplied request
     body field) against the project's stored UIDs — callerUid was
     verified via the Firebase token at the top of this handler but was
     never actually used for the authorization decision. That let any
     authenticated user open a dispute on any project, attributed to
     either party, simply by supplying that party's UID in raisedBy. Now
     the check is against callerUid, the verified identity. */
  const role = raisedByRole === 'freelancer' ? 'freelancer' : 'buyer';
  const isAuthorised = role === 'freelancer'
    ? !!project.freelancerUid && project.freelancerUid === callerUid
    : project.buyerUid === callerUid;

  if (!isAuthorised) {
    return respond(403, { error: 'You are not authorised to raise a dispute on this project.' });
  }

  /* ── Guard against duplicate disputes ── */
  if (project.status === 'disputed') {
    return respond(409, { error: 'A dispute has already been raised on this project.' });
  }

  /* ── Guard: can only dispute active/delivered projects ── */
  if (!['in_progress', 'delivered', 'active'].includes(project.status)) {
    return respond(400, { error: `Cannot raise a dispute on a project with status "${project.status}".` });
  }

  const projectTitle  = project.projectTitle || 'Your project';
  const freelancerUid = project.freelancerUid || null;
  const buyerUid      = project.buyerUid;

  /* ── Update project: mark as disputed ── */
  try {
    await db.collection('projects').doc(projectId).update({
      status:        'disputed',
      escrowStatus:  'disputed',
      disputeReason: safeDescription,
      disputedBy:    raisedBy,
      disputedByRole: raisedByRole || 'buyer',
      disputedAt:    FieldValue.serverTimestamp(),
      updatedAt:     FieldValue.serverTimestamp(),
    });
    console.log(`Dispute raised on project ${projectId} by ${raisedBy}.`);
  } catch (err) {
    console.error(`Firestore update failed for project ${projectId}:`, err.message);
    return respond(500, { error: 'Failed to update project status.' });
  }

  /* ── Fetch user details for notifications ── */
  let freelancerEmail = null;
  let freelancerName  = 'Freelancer';
  let buyerEmail      = null;
  let buyerName       = 'Client';

  try {
    const fetches = [db.collection('users').doc(buyerUid).get()];
    if (freelancerUid) fetches.push(db.collection('users').doc(freelancerUid).get());

    const [bSnap, fSnap] = await Promise.all(fetches);
    if (bSnap.exists) {
      buyerEmail = bSnap.data().email || null;
      buyerName  = bSnap.data().name  || 'Client';
    }
    if (fSnap && fSnap.exists) {
      freelancerEmail = fSnap.data().email || null;
      freelancerName  = fSnap.data().name  || 'Freelancer';
    }
  } catch (err) {
    console.warn('Could not fetch user details for notifications:', err.message);
  }

  /* ── Create the disputes/{disputeId} record admin.html reads from ──
     FIX: this write never existed — admin.html's disputes table
     (loadDisputes(), reads collection('disputes')) was always empty
     because nothing populated it; only the project doc itself was
     updated. Use projectId as the doc ID so resolve-dispute.js (which
     takes disputeId and looks it up directly in projects/{id}) keeps
     working unchanged. Reuses buyerName/freelancerName already fetched
     above for notifications rather than querying users/ a second time.
     Non-fatal if it fails: the project itself is already correctly
     marked disputed above, which is the half that matters for blocking
     auto-release; only the admin table listing would be affected, and
     an admin can still resolve via direct doc lookup. */
  try {
    await db.collection('disputes').doc(projectId).set({
      type:               'project',
      projectId:          projectId,
      projectTitle:       projectTitle,
      buyerName:          buyerName,
      freelancerName:     freelancerName,
      amount:             Number(project.netAmount || project.amount || 0),
      contractPdfUrl:     project.contractPdfUrl || '#',
      freelancerEvidence: role === 'freelancer' ? safeDescription : '',
      buyerEvidence:      role === 'buyer' ? safeDescription : '',
      status:             'open',
      createdAt:          FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.warn(`Could not create disputes/${projectId} record (non-fatal — project already marked disputed):`, err.message);
  }

  const projectUrl  = `${platformUrl}/buyer-projects.html?projectId=${encodeURIComponent(projectId)}`;
  const raiserName  = role === 'freelancer' ? freelancerName : buyerName;

  /* ── Notify the buyer ── */
  await callFunction('send-smart-notification', {
    userUid:    buyerUid,
    title:      role === 'buyer' ? 'Dispute Submitted' : 'Dispute Raised',
    body:       role === 'buyer'
      ? `Your dispute for "${projectTitle}" has been received. The Kreddlo team will be in touch.`
      : `A dispute has been raised on "${projectTitle}". Kreddlo support will review shortly.`,
    url:        projectUrl,
    templateId: 'dispute-raised',
    emailMode:  buyerEmail ? 'always' : 'never',
    emailData: {
      name:         buyerName,
      projectTitle,
      raisedByName: raiserName,
      disputeId:    projectId,
    },
  });

  /* ── Notify the freelancer ── */
  if (freelancerUid) {
    await callFunction('send-smart-notification', {
      userUid:    freelancerUid,
      title:      role === 'freelancer' ? 'Dispute Submitted' : 'Dispute Raised',
      body:       role === 'freelancer'
        ? `Your dispute for "${projectTitle}" has been received. The Kreddlo team will be in touch.`
        : `A dispute has been raised on "${projectTitle}". Kreddlo support will review shortly.`,
      url:        `${platformUrl}/dashboard-projects.html?projectId=${encodeURIComponent(projectId)}`,
      templateId: 'dispute-raised',
      emailMode:  freelancerEmail ? 'always' : 'never',
      emailData: {
        name:         freelancerName,
        projectTitle,
        raisedByName: raiserName,
        disputeId:    projectId,
      },
    });
  }

  return respond(200, {
    success: true,
    message: 'Dispute submitted. The Kreddlo team will be in touch.',
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
