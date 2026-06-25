/**
 * Netlify Function: propose-changes.js
 * Path: netlify/functions/propose-changes.js
 *
 * Fix #10a — Contract renegotiation backend.
 *
 * Handles two actions on a `projects` document that is still in
 * `pending_payment` status (i.e. before escrow has been funded):
 *
 *   action === 'propose'
 *     Either the buyer or freelancer proposes new terms (budget, deadline,
 *     and/or scope). Writes a `pendingProposal` object to the project doc
 *     and notifies the other party.
 *
 *   action === 'respond'
 *     The other party accepts or rejects a pending proposal.
 *     - accept: updates the project's budget/deadline/scope to the proposed
 *               values, clears pendingProposal, notifies the proposer.
 *     - reject: clears pendingProposal, notifies the proposer.
 *
 * POST body:
 *   action === 'propose':
 *   {
 *     action:    'propose'
 *     projectId: string       — Firestore projects doc ID
 *     budget:    number       — proposed budget in USD (must be > 0)
 *     deadline:  string       — proposed deadline ISO date string e.g. "2026-09-01"
 *     scope:     string       — proposed scope / description (min 20 chars)
 *     message?:  string       — optional short note to the other party
 *   }
 *
 *   action === 'respond':
 *   {
 *     action:    'respond'
 *     projectId: string       — Firestore projects doc ID
 *     decision:  'accept' | 'reject'
 *   }
 *
 * Success response (200):
 *   { ok: true, action: string, decision?: string }
 *
 * Error responses:
 *   400 — missing / invalid fields
 *   401 — not authenticated
 *   403 — caller is not a party to this project, or trying to respond
 *          to their own proposal
 *   404 — project not found
 *   409 — conflict (project no longer pending, or no active proposal to respond to)
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
const { sanitizeString }                = require('./_sanitize');

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
    console.warn(`[propose-changes] PLATFORM_URL not set — cannot call ${name}.`);
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
      console.warn(`[propose-changes] ${name} returned ${res.status}: ${await res.text()}`);
    }
  } catch (err) {
    // Non-fatal — core Firestore write already succeeded
    console.error(`[propose-changes] Failed to call ${name}:`, err.message);
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

  const { action, projectId } = body;

  if (!action || !['propose', 'respond'].includes(action)) {
    return respond(400, { error: 'action must be "propose" or "respond".' });
  }
  if (!projectId || typeof projectId !== 'string' || !projectId.trim()) {
    return respond(400, { error: 'projectId is required.' });
  }

  /* ── Init Firestore ── */
  let db;
  try {
    db = getDb();
  } catch (err) {
    console.error('[propose-changes] Firebase Admin init failed:', err.message);
    return respond(500, { error: 'Database not available.' });
  }

  const platformUrl = (process.env.PLATFORM_URL || 'https://kreddlo.space').replace(/\/$/, '');

  /* ── 3. Fetch the project doc ── */
  let projectSnap;
  try {
    projectSnap = await db.collection('projects').doc(projectId.trim()).get();
  } catch (err) {
    console.error(`[propose-changes] Firestore read failed for project ${projectId}:`, err.message);
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

  /* ── 5. Guard: proposals only allowed before escrow is funded ──
     The `pending_payment` status is set by create-project.js and cleared
     by the payment webhooks when they move the project to `in_progress`.
     Once funded, the contract terms are locked in — no more changes. */
  if (project.status !== 'pending_payment') {
    return respond(409, {
      error: 'Changes can only be proposed before the project has been funded. This project is already ' + project.status + '.',
    });
  }

  const projectTitle   = project.projectTitle || project.title || 'your project';
  const buyerUid       = project.buyerUid;
  const freelancerUid  = project.freelancerUid;
  const buyerName      = project.buyerName      || 'The client';
  const freelancerName = project.freelancerName  || 'The freelancer';
  const dashboardUrl   = `${platformUrl}/dashboard-projects.html`;

  const callerRole  = isBuyer ? 'buyer' : 'freelancer';
  const callerName  = isBuyer ? buyerName : freelancerName;
  const otherUid    = isBuyer ? freelancerUid : buyerUid;
  const otherName   = isBuyer ? freelancerName : buyerName;

  /* ════════════════════════════════════════════════════════════
     ACTION: propose
  ════════════════════════════════════════════════════════════ */
  if (action === 'propose') {
    const { budget, deadline, scope, message } = body;

    /* ── Validate proposed fields ── */
    const budgetNum = Number(budget);
    if (!budgetNum || budgetNum <= 0) {
      return respond(400, { error: 'A valid proposed budget greater than 0 is required.' });
    }

    if (!deadline || typeof deadline !== 'string' || !deadline.trim()) {
      return respond(400, { error: 'A proposed deadline is required.' });
    }
    const deadlineDate = new Date(deadline.trim() + 'T00:00:00Z');
    if (isNaN(deadlineDate.getTime()) || deadlineDate <= new Date()) {
      return respond(400, { error: 'Proposed deadline must be a valid future date.' });
    }

    if (!scope || typeof scope !== 'string' || scope.trim().length < 20) {
      return respond(400, { error: 'A proposed scope of at least 20 characters is required.' });
    }

    /* ── Guard: only one active proposal at a time ──
       If there is already a pendingProposal, the parties must respond to it
       (accept or reject) before a new one can be submitted. This prevents
       a race condition where both sides submit proposals simultaneously,
       making it unclear which one governs. */
    if (project.pendingProposal && project.pendingProposal.status === 'pending_acceptance') {
      return respond(409, {
        error: 'There is already a pending proposal on this project. The other party must accept or reject it before a new proposal can be submitted.',
      });
    }

    /* ── Write pendingProposal to the project doc ── */
    const pendingProposal = {
      proposedBy:   callerUid,
      proposerRole: callerRole,
      proposerName: callerName,
      budget:       budgetNum,
      deadline:     deadline.trim(),
      scope:        scope.trim(),
      message:      sanitizeString(typeof message === 'string' ? message : '', 2000),
      proposedAt:   new Date().toISOString(),
      status:       'pending_acceptance',
    };

    try {
      await db.collection('projects').doc(projectId.trim()).update({
        pendingProposal,
        updatedAt: FieldValue.serverTimestamp(),
      });
      console.log(`[propose-changes] Proposal written to project ${projectId} by ${callerUid} (${callerRole}).`);
    } catch (err) {
      console.error(`[propose-changes] Firestore update failed for project ${projectId}:`, err.message);
      return respond(500, { error: 'Failed to save proposal. Please try again.' });
    }

    /* ── Notify the other party ── */
    if (otherUid) {
      await callFunction('send-smart-notification', {
        userUid:    otherUid,
        title:      'New Change Proposal',
        body:       `${callerName} has proposed changes to "${projectTitle}". Review and accept or reject on your dashboard.`,
        url:        dashboardUrl,
        templateId: 'contract-change-proposed',
        emailMode:  'never',
        emailData: {
          projectTitle,
          proposerName: callerName,
          budget:       budgetNum,
          deadline:     deadline.trim(),
          scope:        scope.trim(),
          message:      pendingProposal.message,
        },
      });
    }

    return respond(200, { ok: true, action: 'propose' });
  }

  /* ════════════════════════════════════════════════════════════
     ACTION: respond
  ════════════════════════════════════════════════════════════ */
  if (action === 'respond') {
    const { decision } = body;

    if (!decision || !['accept', 'reject'].includes(decision)) {
      return respond(400, { error: 'decision must be "accept" or "reject".' });
    }

    /* ── Guard: there must be an active pending proposal ── */
    if (!project.pendingProposal || project.pendingProposal.status !== 'pending_acceptance') {
      return respond(409, { error: 'There is no pending proposal to respond to on this project.' });
    }

    const proposal = project.pendingProposal;

    /* ── Guard: you cannot respond to your own proposal ── */
    if (proposal.proposedBy === callerUid) {
      return respond(403, {
        error: 'You cannot accept or reject your own proposal. Wait for the other party to respond.',
      });
    }

    if (decision === 'accept') {
      /* ── Accept: apply the proposed terms to the project ──
         We deliberately do NOT recompute chargeAmount / totalAmount here
         because the Firestore doc stores totalAmount for the payment
         functions to read at checkout time. We update budget/amount (the
         freelancer-facing base) and deadline/scope, and set totalAmount
         proportionally using the same fee uplift formula create-project.js
         used originally. The fee percentages come from the stored project
         doc (we don't re-read config to avoid a race where an admin
         changes fees mid-negotiation). */
      const existingPlatformFeePercent = typeof project.platformFeePercent === 'number'
        ? project.platformFeePercent
        : 2.5;
      const existingProtectionPercent = project.withProtection
        ? (typeof project.projectProtectionPercent === 'number' ? project.projectProtectionPercent : 1.0)
        : 0;

      const totalDeductionPercent = existingPlatformFeePercent + existingProtectionPercent;
      // Guard: if somehow fee config is bad, fall back to keeping the old totalAmount ratio
      const newChargeAmount = (totalDeductionPercent > 0 && totalDeductionPercent < 100)
        ? +(proposal.budget / (1 - totalDeductionPercent / 100)).toFixed(2)
        : +(proposal.budget * (project.totalAmount / (project.budget || 1))).toFixed(2);

      try {
        await db.collection('projects').doc(projectId.trim()).update({
          // Update the agreed terms
          budget:      proposal.budget,
          amount:      proposal.budget,
          totalAmount: newChargeAmount,
          deadline:    proposal.deadline,
          description: proposal.scope,
          scope:       proposal.scope,
          // Clear the proposal
          pendingProposal: null,
          updatedAt:       FieldValue.serverTimestamp(),
        });
        console.log(`[propose-changes] Proposal accepted on project ${projectId} by ${callerUid}.`);
      } catch (err) {
        console.error(`[propose-changes] Firestore accept update failed for project ${projectId}:`, err.message);
        return respond(500, { error: 'Failed to apply the accepted proposal. Please try again.' });
      }

      /* ── Notify the proposer that their changes were accepted ── */
      const proposerUid = proposal.proposedBy;
      if (proposerUid) {
        await callFunction('send-smart-notification', {
          userUid:    proposerUid,
          title:      'Proposal Accepted',
          body:       `${callerName} accepted your proposed changes to "${projectTitle}". The new terms are now in effect.`,
          url:        dashboardUrl,
          templateId: 'contract-change-accepted',
          emailMode:  'never',
          emailData: {
            projectTitle,
            responderName: callerName,
            budget:        proposal.budget,
            deadline:      proposal.deadline,
          },
        });
      }

      return respond(200, { ok: true, action: 'respond', decision: 'accept' });
    }

    /* decision === 'reject' */
    try {
      await db.collection('projects').doc(projectId.trim()).update({
        pendingProposal: null,
        updatedAt:       FieldValue.serverTimestamp(),
      });
      console.log(`[propose-changes] Proposal rejected on project ${projectId} by ${callerUid}.`);
    } catch (err) {
      console.error(`[propose-changes] Firestore reject update failed for project ${projectId}:`, err.message);
      return respond(500, { error: 'Failed to reject the proposal. Please try again.' });
    }

    /* ── Notify the proposer that their changes were rejected ── */
    const proposerUid = proposal.proposedBy;
    if (proposerUid) {
      await callFunction('send-smart-notification', {
        userUid:    proposerUid,
        title:      'Proposal Declined',
        body:       `${callerName} declined your proposed changes to "${projectTitle}". The original terms remain.`,
        url:        dashboardUrl,
        templateId: 'contract-change-rejected',
        emailMode:  'never',
        emailData: {
          projectTitle,
          responderName: callerName,
        },
      });
    }

    return respond(200, { ok: true, action: 'respond', decision: 'reject' });
  }

  // Should never reach here given the action validation above
  return respond(400, { error: 'Unknown action.' });
};
