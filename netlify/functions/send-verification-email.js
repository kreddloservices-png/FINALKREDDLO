// netlify/functions/send-verification-email.js
// Generates a 6-digit email verification code, stores it in Firestore
// with a 30-minute expiry, then sends it to the user via Brevo.

'use strict';

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue }      = require('firebase-admin/firestore');
const { checkRateLimit }                = require('./_rate-limit');

/* ── Firebase Admin init (shared pattern across all functions) ── */
function getDb() {
  if (!getApps().length) {
    const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    initializeApp({ credential: cert(sa) });
  }
  return getFirestore();
}

/* ── Generate a cryptographically random 6-digit code ── */
function generateCode() {
  const { randomInt } = require('crypto');
  return String(randomInt(100000, 999999));
}

/* ── CORS / preflight ── */
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

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return respond(200, {});
  if (event.httpMethod !== 'POST')    return respond(405, { error: 'Method not allowed.' });

  let uid;
  try {
    ({ uid } = JSON.parse(event.body || '{}'));
  } catch {
    return respond(400, { error: 'Invalid request body.' });
  }

  if (!uid) return respond(400, { error: 'uid is required.' });

  /* ── Get user from Firestore ── */
  let db, userSnap;
  try {
    db       = getDb();

    /* ── Server-side rate limit: 5 sends per 10 minutes per uid ──
       Guards against email-send spam / OTP enumeration. The existing
       60-second per-request cooldown (checked below against the user doc)
       is per-send; this counter catches burst loops that re-register new
       uids or use automation to call this endpoint repeatedly. */
    const rl = await checkRateLimit(db, `sve::${uid}`, 5, 600);
    if (!rl.allowed) {
      return respond(429, { error: rl.error, retryAfter: rl.retryAfter });
    }

    userSnap = await db.collection('users').doc(uid).get();
  } catch (err) {
    console.error('[send-verification-email] Firestore read error:', err.message);
    return respond(500, { error: 'Database error.' });
  }

  if (!userSnap.exists) {
    return respond(404, { error: 'User not found.' });
  }

  const user = userSnap.data();

  /* ── Rate limit: prevent resend spam (must wait 60s between requests) ── */
  if (user.emailVerificationSentAt) {
    const sentAt = user.emailVerificationSentAt.toDate
      ? user.emailVerificationSentAt.toDate()
      : new Date(user.emailVerificationSentAt);
    const secondsSince = (Date.now() - sentAt.getTime()) / 1000;
    if (secondsSince < 60) {
      return respond(429, {
        error: `Please wait ${Math.ceil(60 - secondsSince)} seconds before requesting another code.`,
      });
    }
  }

  /* ── Generate code and expiry ── */
  const code   = generateCode();
  const expiry = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes from now

  /* ── Write code to Firestore ── */
  try {
    await db.collection('users').doc(uid).update({
      emailVerificationCode:   code,
      emailVerificationExpiry: expiry,
      emailVerificationSentAt: FieldValue.serverTimestamp(),
      emailVerified:           false,
    });
  } catch (err) {
    console.error('[send-verification-email] Firestore write error:', err.message);
    return respond(500, { error: 'Failed to store verification code.' });
  }

  /* ── Send email via send-email function ── */
  const platformUrl = (process.env.PLATFORM_URL || 'https://kreddlo.space').replace(/\/$/, '');
  try {
    const emailRes = await fetch(`${platformUrl}/.netlify/functions/send-email`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-secret': process.env.INTERNAL_FUNCTION_SECRET || '' },
      body:    JSON.stringify({
        to:         user.email,
        templateId: 'email-verification',
        data: {
          name: user.name || 'there',
          code,
        },
      }),
    });
    if (!emailRes.ok) {
      const txt = await emailRes.text();
      console.warn('[send-verification-email] send-email returned non-200:', txt);
    }
  } catch (err) {
    console.warn('[send-verification-email] send-email call failed:', err.message);
    // Non-fatal: code is stored, user can retry
  }

  console.log(`[send-verification-email] Code sent to uid ${uid} at ${user.email}`);
  return respond(200, { success: true });
};
