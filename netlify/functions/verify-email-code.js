// netlify/functions/verify-email-code.js
// Accepts { uid, code } — checks the 6-digit code against Firestore,
// confirms it has not expired, then marks emailVerified: true.

'use strict';

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue }      = require('firebase-admin/firestore');

function getDb() {
  if (!getApps().length) {
    const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    initializeApp({ credential: cert(sa) });
  }
  return getFirestore();
}

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

  let uid, code;
  try {
    ({ uid, code } = JSON.parse(event.body || '{}'));
  } catch {
    return respond(400, { error: 'Invalid request body.' });
  }

  if (!uid)  return respond(400, { error: 'uid is required.' });
  if (!code) return respond(400, { error: 'code is required.' });

  /* ── Fetch user document ── */
  let db, userSnap;
  try {
    db       = getDb();
    userSnap = await db.collection('users').doc(uid).get();
  } catch (err) {
    console.error('[verify-email-code] Firestore read error:', err.message);
    return respond(500, { error: 'Database error.' });
  }

  if (!userSnap.exists) {
    return respond(404, { error: 'User not found.' });
  }

  const user = userSnap.data();

  /* ── Already verified ── */
  if (user.emailVerified === true) {
    return respond(200, { success: true, alreadyVerified: true, role: user.role || null });
  }

  /* ── Check code exists ── */
  if (!user.emailVerificationCode || !user.emailVerificationExpiry) {
    return respond(400, { error: 'No verification code found. Please request a new one.' });
  }

  /* ── Check expiry ── */
  const expiry = user.emailVerificationExpiry.toDate
    ? user.emailVerificationExpiry.toDate()
    : new Date(user.emailVerificationExpiry);

  if (Date.now() > expiry.getTime()) {
    return respond(400, { error: 'This code has expired. Please request a new one.' });
  }

  /* ── Check code matches (constant-time string compare) ── */
  const storedCode  = String(user.emailVerificationCode).trim();
  const suppliedCode = String(code).trim();

  if (storedCode !== suppliedCode) {
    return respond(400, { error: 'Incorrect code. Please check your email and try again.' });
  }

  /* ── Mark verified and clear code fields ── */
  try {
    await db.collection('users').doc(uid).update({
      emailVerified:           true,
      emailVerificationCode:   FieldValue.delete(),
      emailVerificationExpiry: FieldValue.delete(),
      emailVerificationSentAt: FieldValue.delete(),
      emailVerifiedAt:         FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.error('[verify-email-code] Firestore update error:', err.message);
    return respond(500, { error: 'Failed to update verification status.' });
  }

  console.log(`[verify-email-code] uid ${uid} successfully verified.`);
  return respond(200, { success: true, role: user.role || null });
};
