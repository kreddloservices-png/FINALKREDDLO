/**
 * send-withdrawal-otp.js — Kreddlo Netlify Function
 *
 * Generates a 6-digit OTP for withdrawal 2FA, stores it in Firestore
 * with a 10-minute expiry, and sends it to the user's registered email
 * via send-email.js (Brevo).
 *
 * POST body: { uid }
 * Auth: Firebase ID token in Authorization header
 *
 * Rate-limited: 60s between sends per user.
 */

'use strict';

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue }      = require('firebase-admin/firestore');
const { verifyCaller }                  = require('./_verify-auth');
const { checkRateLimit }                = require('./_rate-limit');

function getDb() {
  if (!getApps().length) {
    const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    initializeApp({ credential: cert(sa) });
  }
  return getFirestore();
}

function respond(statusCode, body, headers = {}) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      ...headers,
    },
    body: JSON.stringify(body),
  };
}

function generateOtp() {
  const { randomInt } = require('crypto');
  return String(randomInt(100000, 999999));
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return respond(204, {});
  if (event.httpMethod !== 'POST')    return respond(405, { error: 'Method not allowed.' });

  /* ── Auth ── */
  const callerUid = await verifyCaller(event);
  if (!callerUid) return respond(401, { error: 'Unauthorized. Please log in again.' });

  let uid;
  try {
    ({ uid } = JSON.parse(event.body || '{}'));
  } catch {
    return respond(400, { error: 'Invalid request body.' });
  }

  if (!uid || uid !== callerUid) {
    return respond(403, { error: 'Forbidden.' });
  }

  /* ── Get user from Firestore ── */
  let db, userSnap;
  try {
    db       = getDb();

    /* ── Server-side rate limit: 5 OTP sends per 10 minutes per uid ──
       Complements the existing 60-second per-request cooldown stored on the
       user doc. This counter catches automated burst attempts that rotate
       clients or exploit the 60-second window boundary. */
    const rl = await checkRateLimit(db, `otp::${uid}`, 5, 600);
    if (!rl.allowed) {
      return respond(429, { error: rl.error, retryAfter: rl.retryAfter });
    }

    userSnap = await db.collection('users').doc(uid).get();
  } catch (err) {
    console.error('[send-withdrawal-otp] Firestore read error:', err.message);
    return respond(500, { error: 'Database error.' });
  }

  if (!userSnap.exists) return respond(404, { error: 'User not found.' });
  const user = userSnap.data();

  /* ── Rate limit: 60s between sends ── */
  if (user.withdrawalOtpSentAt) {
    const sentAt = user.withdrawalOtpSentAt.toDate
      ? user.withdrawalOtpSentAt.toDate()
      : new Date(user.withdrawalOtpSentAt);
    const secondsSince = (Date.now() - sentAt.getTime()) / 1000;
    if (secondsSince < 60) {
      return respond(429, {
        error: `Please wait ${Math.ceil(60 - secondsSince)} seconds before requesting another code.`,
        retryAfter: Math.ceil(60 - secondsSince),
      });
    }
  }

  /* ── Generate OTP, 10-minute expiry ── */
  const otp    = generateOtp();
  const expiry = new Date(Date.now() + 10 * 60 * 1000);

  /* ── Store in Firestore ──
     Also resets withdrawalOtpAttempts so a freshly issued code always
     gets the full attempt allowance (paired with the attempt-cap fix in
     verify-withdrawal-otp.js). */
  try {
    await db.collection('users').doc(uid).update({
      withdrawalOtp:         otp,
      withdrawalOtpExpiry:   expiry,
      withdrawalOtpSentAt:   FieldValue.serverTimestamp(),
      withdrawalOtpUsed:     false,
      withdrawalOtpAttempts: 0,
    });
  } catch (err) {
    console.error('[send-withdrawal-otp] Firestore write error:', err.message);
    return respond(500, { error: 'Failed to store OTP.' });
  }

  /* ── Send email ── */
  const platformUrl = (process.env.PLATFORM_URL || 'https://kreddlo.space').replace(/\/$/, '');
  try {
    await fetch(`${platformUrl}/.netlify/functions/send-email`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-secret': process.env.INTERNAL_FUNCTION_SECRET || '' },
      body: JSON.stringify({
        to:         user.email,
        type:       'withdrawal-otp',
        data: {
          name: user.name || 'there',
          code: otp,
        },
      }),
    });
  } catch (err) {
    console.warn('[send-withdrawal-otp] send-email failed:', err.message);
    // Non-fatal — OTP is stored, user can still enter it if email arrives
  }

  console.log(`[send-withdrawal-otp] OTP sent to uid ${uid} at ${user.email}`);
  return respond(200, { success: true });
};
