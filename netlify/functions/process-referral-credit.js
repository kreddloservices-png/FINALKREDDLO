/**
 * process-referral-credit.js
 *
 * Awards a referral credit to the person who referred a new user,
 * the first time that new user completes a paid project.
 *
 * Called internally (fire-and-forget) by:
 *   approve-delivery.js, stripe-webhook.js,
 *   flutterwave-webhook.js, nowpayments-webhook.js
 *
 * Body: { completedByUid: string, projectId: string }
 *
 * Idempotent — uses projectId as the referral-credits doc ID so
 * double-calls for the same project are safe no-ops.
 *
 * Guards:
 *   1. referralProgramEnabled must be true in config/platform
 *   2. completing user must have a referredBy field
 *   3. referralCreditUsed must not already be true on completing user
 *   4. referrer must not be the same uid as the completing user (no self-credit)
 */

'use strict';

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

/* ── Lazy Firebase Admin init ─────────────────────────────────── */
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

const { getSettings } = require('./get-settings');

/* ── Handler ──────────────────────────────────────────────────── */
exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return respond(405, { error: 'Method not allowed.' });
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return respond(400, { error: 'Invalid JSON body.' });
  }

  const { completedByUid, projectId } = body;

  if (!completedByUid || typeof completedByUid !== 'string') {
    return respond(400, { error: 'completedByUid is required.' });
  }
  if (!projectId || typeof projectId !== 'string') {
    return respond(400, { error: 'projectId is required.' });
  }

  const db = getDb();

  /* ── 1. Check referral program is enabled ─────────────────── */
  let settings;
  try {
    settings = await getSettings(db);
  } catch (err) {
    console.error('[referral-credit] getSettings failed:', err.message);
    return respond(500, { error: 'Could not read platform settings.' });
  }

  if (!settings.referralProgramEnabled) {
    console.log('[referral-credit] Referral program is disabled — skipping.');
    return respond(200, { skipped: true, reason: 'referralProgramDisabled' });
  }

  const creditAmount = Number(settings.referralCreditAmount) || 2;

  /* ── 2. Read the completing user ──────────────────────────── */
  let completingUserSnap;
  try {
    completingUserSnap = await db.collection('users').doc(completedByUid).get();
  } catch (err) {
    console.error(`[referral-credit] Could not read user ${completedByUid}:`, err.message);
    return respond(500, { error: 'Could not read completing user.' });
  }

  if (!completingUserSnap.exists) {
    console.warn(`[referral-credit] User ${completedByUid} not found.`);
    return respond(200, { skipped: true, reason: 'completingUserNotFound' });
  }

  const completingUser = completingUserSnap.data();

  /* ── 3. Must have been referred ───────────────────────────── */
  const referrerUid = completingUser.referredBy;
  if (!referrerUid || typeof referrerUid !== 'string') {
    console.log(`[referral-credit] User ${completedByUid} has no referredBy — skipping.`);
    return respond(200, { skipped: true, reason: 'noReferrer' });
  }

  /* ── 4. No self-credit ────────────────────────────────────── */
  if (referrerUid === completedByUid) {
    console.warn(`[referral-credit] Self-referral detected for ${completedByUid} — skipping.`);
    return respond(200, { skipped: true, reason: 'selfReferral' });
  }

  /* ── 5. Credit is one-time only ───────────────────────────── */
  if (completingUser.referralCreditUsed === true) {
    console.log(`[referral-credit] User ${completedByUid} already used their referral credit — skipping.`);
    return respond(200, { skipped: true, reason: 'alreadyCredited' });
  }

  /* ── 6. Idempotency: check if this project was already processed ── */
  const creditDocRef = db.collection('referral-credits').doc(projectId);
  let existingCredit;
  try {
    existingCredit = await creditDocRef.get();
  } catch (err) {
    console.error('[referral-credit] Could not check idempotency doc:', err.message);
    return respond(500, { error: 'Could not check referral-credits doc.' });
  }

  if (existingCredit.exists) {
    console.log(`[referral-credit] Project ${projectId} already processed — skipping.`);
    return respond(200, { skipped: true, reason: 'alreadyProcessed' });
  }

  /* ── 7. Read referrer to get their name for the email ─────── */
  let referrerSnap;
  try {
    referrerSnap = await db.collection('users').doc(referrerUid).get();
  } catch (err) {
    console.error(`[referral-credit] Could not read referrer ${referrerUid}:`, err.message);
    return respond(500, { error: 'Could not read referrer user.' });
  }

  if (!referrerSnap.exists) {
    console.warn(`[referral-credit] Referrer ${referrerUid} not found — skipping credit.`);
    return respond(200, { skipped: true, reason: 'referrerNotFound' });
  }

  const referrer        = referrerSnap.data();
  const referrerName    = referrer.name || 'there';
  const referrerEmail   = referrer.email || null;
  const completingName  = completingUser.name || 'Someone you referred';

  /* ── 8. Atomic writes ────────────────────────────────────────
     a) Increment referrer's referralCreditsBalance
     b) Mark completing user's referralCreditUsed = true
     c) Write audit doc at referral-credits/{projectId}
  ─────────────────────────────────────────────────────────── */
  const batch = db.batch();

  // Credit the referrer
  batch.update(db.collection('users').doc(referrerUid), {
    referralCreditsBalance: FieldValue.increment(creditAmount),
    referralCreditsTotalEarned: FieldValue.increment(creditAmount),
    updatedAt: FieldValue.serverTimestamp(),
  });

  // Mark completing user so credit only fires once
  batch.update(db.collection('users').doc(completedByUid), {
    referralCreditUsed: true,
    updatedAt: FieldValue.serverTimestamp(),
  });

  // Audit trail (doc ID = projectId for idempotency)
  batch.set(creditDocRef, {
    projectId,
    referrerUid,
    referredUid: completedByUid,
    creditAmount,
    creditCurrency: 'USD',
    referrerName,
    referredName: completingName,
    createdAt: FieldValue.serverTimestamp(),
  });

  try {
    await batch.commit();
    console.log(`[referral-credit] Credited $${creditAmount} to referrer ${referrerUid} for project ${projectId}.`);
  } catch (err) {
    console.error('[referral-credit] Batch write failed:', err.message);
    return respond(500, { error: 'Failed to write referral credit.' });
  }

  /* ── 9. Send notification email to referrer ─────────────── */
  if (referrerEmail) {
    try {
      const baseUrl = process.env.PLATFORM_URL || process.env.URL || 'https://kreddlo.space';
      await fetch(`${baseUrl}/.netlify/functions/send-email`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-secret': process.env.INTERNAL_FUNCTION_SECRET || '' },
        body: JSON.stringify({
          to:         referrerEmail,
          toName:     referrerName,
          templateId: 'referral-credited',
          data: {
            name:         referrerName,
            referredName: completingName,
          },
        }),
      });
      console.log(`[referral-credit] Email sent to referrer ${referrerEmail}.`);
    } catch (emailErr) {
      // Non-fatal — credit is already written
      console.warn('[referral-credit] Email send failed (non-fatal):', emailErr.message);
    }
  }

  return respond(200, {
    success: true,
    message: `Referral credit of $${creditAmount} applied to referrer ${referrerUid}.`,
  });
};

/* ── Utility ──────────────────────────────────────────────────── */
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
