/**
 * Netlify Function: kyc-approve.js
 * Path: netlify/functions/kyc-approve.js
 *
 * Called by admin.html when an admin approves or rejects a KYC submission.
 *
 * POST body:
 *   {
 *     action:  'approve' | 'reject',
 *     uid:     string,           // target user UID
 *     reason:  string,           // required when action === 'reject'
 *     adminUid: string,          // UID of the admin performing the action
 *   }
 *
 * On approve:
 *   - Sets users/{uid}.kycStatus = 'verified'
 *   - Sets users/{uid}.kycReviewedAt = serverTimestamp()
 *   - Sends kyc-approved email to the user via Brevo
 *
 * On reject:
 *   - Sets users/{uid}.kycStatus = 'declined'
 *   - Sets users/{uid}.kycRejectionReason = reason
 *   - Sets users/{uid}.kycReviewedAt = serverTimestamp()
 *   - Sends kyc-declined email to the user via Brevo
 *
 * Environment variables required:
 *   FIREBASE_SERVICE_ACCOUNT  — full service account JSON (single-line string)
 *   BREVO_API_KEY
 *   BREVO_SENDER_EMAIL
 *   BREVO_SENDER_NAME
 *   PLATFORM_URL              — e.g. https://kreddlo.space
 *   ADMIN_SECRET              — a shared secret the admin frontend sends to
 *                               authenticate this request (set in Netlify env vars
 *                               AND in admin.html as window.ADMIN_SECRET)
 */

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue }     = require('firebase-admin/firestore');

function getDb() {
  if (!getApps().length) {
    let sa;
    try { sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}'); }
    catch { throw new Error('FIREBASE_SERVICE_ACCOUNT is not valid JSON.'); }
    initializeApp({ credential: cert(sa) });
  }
  return getFirestore();
}

/* ── Email sender via Brevo ── */
async function sendEmail({ to, toName, subject, htmlContent }) {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) { console.warn('BREVO_API_KEY not set — skipping email.'); return; }

  await fetch('https://api.brevo.com/v3/smtp/email', {
    method:  'POST',
    headers: {
      'accept':       'application/json',
      'api-key':      apiKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      sender: {
        email: process.env.BREVO_SENDER_EMAIL || 'noreply@kreddlo.com',
        name:  process.env.BREVO_SENDER_NAME  || 'Kreddlo',
      },
      to: [{ email: to, name: toName || '' }],
      subject,
      htmlContent,
    }),
  });
}

function approvedEmailHtml(name, platformUrl) {
  return `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;">
      <h2 style="color:#0d2145;margin:0 0 8px 0;">You are verified. 🎉</h2>
      <p style="color:#4a5568;font-size:15px;line-height:1.6;margin:0 0 16px 0;">
        Hi ${name}, your identity has been verified. Your Kreddlo profile is now active
        and visible to clients worldwide.
      </p>
      <p style="color:#4a5568;font-size:15px;line-height:1.6;margin:0 0 24px 0;">
        You can now accept projects, receive escrow payments and withdraw earnings.
      </p>
      <a href="${platformUrl}/dashboard.html"
         style="display:inline-block;background:#2d8a5e;color:#fff;text-decoration:none;padding:13px 28px;border-radius:50px;font-weight:600;font-size:15px;">
        Go to Dashboard
      </a>
    </div>
  `;
}

function rejectedEmailHtml(name, reason, platformUrl) {
  return `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;">
      <h2 style="color:#0d2145;margin:0 0 8px 0;">Verification not approved</h2>
      <p style="color:#4a5568;font-size:15px;line-height:1.6;margin:0 0 16px 0;">
        Hi ${name}, unfortunately we were unable to verify your identity with the documents provided.
      </p>
      <div style="background:#fff5f5;border:1px solid #fed7d7;border-radius:10px;padding:14px 16px;margin-bottom:20px;">
        <p style="color:#c53030;font-size:14px;font-weight:600;margin:0 0 4px 0;">Reason:</p>
        <p style="color:#4a5568;font-size:14px;margin:0;">${reason}</p>
      </div>
      <p style="color:#4a5568;font-size:14px;line-height:1.6;margin:0 0 24px 0;">
        Please log in, correct the issue and resubmit your NIN card photos.
        Make sure both sides are clearly photographed with no glare or blur.
      </p>
      <a href="${platformUrl}/verify.html"
         style="display:inline-block;background:#0d2145;color:#fff;text-decoration:none;padding:13px 28px;border-radius:50px;font-weight:600;font-size:15px;">
        Resubmit Verification
      </a>
    </div>
  `;
}


exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' } };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  /* ── Parse body ── */
  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { action, uid, reason, adminSecret } = payload;

  /* ── Simple shared-secret auth ──
     The admin panel sends window.ADMIN_SECRET (an env var you inject into
     admin.html at build time, or set manually). This prevents anyone who
     discovers the function URL from calling it directly.
     FIX: previously this check was skipped entirely when ADMIN_SECRET was
     unset/empty (`serverSecret &&` short-circuited the whole condition),
     letting anyone approve/reject KYC with an unauthenticated request.
     Now the check fails CLOSED — a missing server secret is a server
     misconfiguration, not an open door — matching the pattern used by
     every other internal-secret check in this codebase (see
     approve-delivery.js, send-smart-notification.js, etc). */
  const serverSecret = process.env.ADMIN_SECRET;
  if (!serverSecret || adminSecret !== serverSecret) {
    return { statusCode: 403, body: JSON.stringify({ error: 'Forbidden' }) };
  }

  /* ── Validate ── */
  if (!uid || typeof uid !== 'string') {
    return { statusCode: 400, body: JSON.stringify({ error: 'uid is required' }) };
  }
  if (action !== 'approve' && action !== 'reject') {
    return { statusCode: 400, body: JSON.stringify({ error: 'action must be approve or reject' }) };
  }
  if (action === 'reject' && (!reason || !reason.trim())) {
    return { statusCode: 400, body: JSON.stringify({ error: 'reason is required for rejection' }) };
  }

  /* ── Firebase ── */
  let db;
  try { db = getDb(); }
  catch (err) { return { statusCode: 500, body: JSON.stringify({ error: 'Server config error' }) }; }

  /* ── Load user ── */
  let userSnap;
  try { userSnap = await db.collection('users').doc(uid).get(); }
  catch (err) { return { statusCode: 500, body: JSON.stringify({ error: 'Database error' }) }; }

  if (!userSnap.exists) {
    return { statusCode: 404, body: JSON.stringify({ error: 'User not found' }) };
  }
  const userData = userSnap.data();

  /* ── Write Firestore ── */
  const updatePayload = {
    kycReviewedAt: FieldValue.serverTimestamp(),
  };

  if (action === 'approve') {
    updatePayload.kycStatus = 'verified';
  } else {
    updatePayload.kycStatus           = 'declined';
    updatePayload.kycRejectionReason  = reason.trim();
  }

  try {
    await db.collection('users').doc(uid).update(updatePayload);
  } catch (err) {
    console.error('Firestore update error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: 'Failed to update user' }) };
  }

  /* Mirror kycStatus to publicProfiles/{uid} — additive, non-blocking.
     browse.html filters on kycStatus === 'verified', so this keeps a
     declined freelancer out of (or a newly-approved one into) the public
     directory without affecting the primary users/{uid} write above. */
  try {
    await db.collection('publicProfiles').doc(uid).set(
      { kycStatus: updatePayload.kycStatus },
      { merge: true }
    );
  } catch (err) {
    console.warn('publicProfiles kycStatus mirror failed (non-fatal):', err.message);
  }

  /* ── Send email to user (non-blocking on error) ── */
  const userName    = userData.displayName || userData.name || 'there';
  const userEmail   = userData.email || '';
  const platformUrl = process.env.PLATFORM_URL || 'https://kreddlo.space';

  if (userEmail) {
    try {
      if (action === 'approve') {
        await sendEmail({
          to:          userEmail,
          toName:      userName,
          subject:     'Your identity has been verified — Kreddlo',
          htmlContent: approvedEmailHtml(userName, platformUrl),
        });
      } else {
        await sendEmail({
          to:          userEmail,
          toName:      userName,
          subject:     'Verification not approved — Kreddlo',
          htmlContent: rejectedEmailHtml(userName, reason.trim(), platformUrl),
        });
      }
    } catch (err) {
      console.warn('Email send failed (non-fatal):', err.message);
    }
  }

  console.log(`KYC ${action}d for uid: ${uid}`);
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ok: true, kycStatus: updatePayload.kycStatus }),
  };
};
