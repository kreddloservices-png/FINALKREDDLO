/**
 * Netlify Function: kyc-submit.js
 *
 * Receives a POST from verify.html with base64-encoded images (front, back, selfie).
 * Uploads them to Cloudinary (free tier — no Firebase Storage needed).
 * Saves the permanent Cloudinary URLs to Firestore users/{uid}.kycImages.
 * Sets kycStatus to 'under-review'.
 *
 * Environment variables required (Netlify UI → Site settings → Env vars):
 *   FIREBASE_SERVICE_ACCOUNT   — single-line JSON service account
 *   CLOUDINARY_CLOUD_NAME      — e.g. "my-cloud"
 *   CLOUDINARY_API_KEY         — from Cloudinary dashboard
 *   CLOUDINARY_API_SECRET      — from Cloudinary dashboard
 *
 * Optional:
 *   BREVO_API_KEY, BREVO_SENDER_EMAIL, BREVO_SENDER_NAME, ADMIN_EMAIL, PLATFORM_URL
 */

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue }     = require('firebase-admin/firestore');
const { verifyCaller }                 = require('./_verify-auth');
const { checkRateLimit }               = require('./_rate-limit');
const { sanitizeString }               = require('./_sanitize');
const https                            = require('https');
const crypto                           = require('crypto');

/* ── Firebase Admin singleton ── */
function getDb() {
  if (!getApps().length) {
    let sa;
    try { sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}'); }
    catch { throw new Error('FIREBASE_SERVICE_ACCOUNT is not valid JSON.'); }
    initializeApp({ credential: cert(sa) });
  }
  return getFirestore();
}

/* ── Upload one base64 image to Cloudinary ── */
async function uploadToCloudinary(base64Data, mimeType, publicId) {
  const cloudName  = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey     = process.env.CLOUDINARY_API_KEY;
  const apiSecret  = process.env.CLOUDINARY_API_SECRET;

  if (!cloudName || !apiKey || !apiSecret) {
    throw new Error('Cloudinary env vars not set (CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET).');
  }

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const folder    = 'kyc';

  // Build signature
  const sigStr  = `folder=${folder}&public_id=${publicId}&timestamp=${timestamp}${apiSecret}`;
  const signature = crypto.createHash('sha256').update(sigStr).digest('hex');

  // Build multipart form body
  const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
  const dataUri  = `data:${mimeType};base64,${base64Data}`;

  const fields = {
    file:       dataUri,
    api_key:    apiKey,
    timestamp:  timestamp,
    public_id:  publicId,
    folder:     folder,
    signature:  signature,
  };

  let body = '';
  for (const [key, val] of Object.entries(fields)) {
    body += `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${val}\r\n`;
  }
  body += `--${boundary}--\r\n`;

  const bodyBuf = Buffer.from(body, 'utf8');

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.cloudinary.com',
      path:     `/v1_1/${cloudName}/image/upload`,
      method:   'POST',
      headers:  {
        'Content-Type':   `multipart/form-data; boundary=${boundary}`,
        'Content-Length': bodyBuf.length,
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.secure_url) {
            resolve(parsed.secure_url);
          } else {
            reject(new Error('Cloudinary error: ' + (parsed.error?.message || data)));
          }
        } catch (e) {
          reject(new Error('Cloudinary response parse error: ' + data.slice(0, 200)));
        }
      });
    });
    req.on('error', reject);
    req.write(bodyBuf);
    req.end();
  });
}

/* ── Optional admin notification email ── */
async function notifyAdmin({ uid, adminEmail, platformUrl }) {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey || !adminEmail) return;

  const senderEmail = process.env.BREVO_SENDER_EMAIL || 'noreply@kreddlo.com';
  const senderName  = process.env.BREVO_SENDER_NAME  || 'Kreddlo';
  // platformUrl is passed in by the caller (sourced from process.env.PLATFORM_URL);
  // the literal string below is only a last-resort fallback if that env var is unset.
  const reviewUrl   = (platformUrl || process.env.PLATFORM_URL || 'https://kreddlo.space') + '/admin.html';

  try {
    await fetch('https://api.brevo.com/v3/smtp/email', {
      method:  'POST',
      headers: { 'accept': 'application/json', 'api-key': apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({
        sender:      { email: senderEmail, name: senderName },
        to:          [{ email: adminEmail }],
        subject:     'New KYC Submission — Action Required',
        htmlContent: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;">
          <h2 style="color:#0d2145;margin:0 0 12px 0;">New KYC Submission</h2>
          <p style="color:#4a5568;font-size:15px;line-height:1.6;margin:0 0 20px 0;">
            A freelancer (UID: <code>${uid}</code>) has submitted their NIN card and selfie for identity verification.
          </p>
          <a href="${reviewUrl}" style="display:inline-block;background:#2d8a5e;color:#fff;text-decoration:none;padding:13px 28px;border-radius:50px;font-weight:600;font-size:15px;">
            Review in Admin Panel
          </a>
        </div>`,
      }),
    });
  } catch (err) {
    console.warn('Admin notification email failed:', err.message);
  }
}

/* ════════════════════════════════════
   MAIN HANDLER
════════════════════════════════════ */
exports.handler = async function (event) {
  /* CORS preflight */
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        'Access-Control-Allow-Origin':  '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  /* ── Verify caller identity ── */
  const callerUid = await verifyCaller(event);
  if (!callerUid) {
    return respond(401, { error: 'Unauthorized. Please log in again.' });
  }

  /* Parse body */
  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) }; }

  const { uid, frontImage, backImage, selfieImage } = payload;

  // Sanitize free-text KYC fields before any downstream use
  const fullName    = sanitizeString(payload.fullName,    80);
  const address     = sanitizeString(payload.address,     200);
  const idNumber    = sanitizeString(payload.idNumber,    50);
  const phoneNumber = sanitizeString(payload.phoneNumber, 20);

  console.log('KYC submit — uid:', uid, 'frontImage length:', frontImage?.length, 'backImage length:', backImage?.length, 'selfieImage length:', selfieImage?.length);

  /* Validate uid */
  if (!uid || typeof uid !== 'string' || uid.length < 4) {
    console.error('Invalid uid:', uid);
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid uid' }) };
  }

  /* ── FIX: bind uid to the verified caller ──
     Previously `uid` was taken from the request body and used for the
     Firestore lookup, Cloudinary public IDs, and the eventual kycStatus
     write — with no check that it matched the verified token's uid. Any
     authenticated user could submit (or overwrite) another user's KYC
     documents by passing that user's uid in the body. */
  if (uid !== callerUid) {
    return { statusCode: 403, body: JSON.stringify({ error: 'You can only submit verification documents for your own account.' }) };
  }

  /* Validate images present */
  for (const [name, data] of [['frontImage', frontImage], ['backImage', backImage], ['selfieImage', selfieImage]]) {
    if (!data || typeof data !== 'string' || data.length < 100) {
      console.error(name, 'is missing or too short');
      return { statusCode: 400, body: JSON.stringify({ error: name + ' is missing' }) };
    }
  }

  /* Firebase */
  let db;
  try { db = getDb(); }
  catch (err) {
    console.error('Firebase init error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error: ' + err.message }) };
  }

  /* ── Server-side rate limit: 3 KYC submissions per 60 minutes per uid ──
     KYC involves Cloudinary uploads and admin email notifications — an
     abuser resubmitting in a loop would burn through storage, email quota,
     and Cloudinary bandwidth. 3 per hour is generous for legitimate retries
     (e.g. blurry photo) while making abuse impractical. */
  try {
    const rl = await checkRateLimit(db, `kyc::${uid}`, 3, 3600);
    if (!rl.allowed) {
      return { statusCode: 429, body: JSON.stringify({ error: rl.error, retryAfter: rl.retryAfter }) };
    }
  } catch (rlErr) {
    // Non-fatal — if rate-limit check itself errors, fail open so legitimate
    // KYC submissions are never blocked by a transient Firestore hiccup.
    console.warn('[kyc-submit] Rate-limit check error (failing open):', rlErr.message);
  }

  /* Check user exists and isn't already verified */
  try {
    const userSnap = await db.collection('users').doc(uid).get();
    if (!userSnap.exists) {
      return { statusCode: 400, body: JSON.stringify({ error: 'User not found in database' }) };
    }
    if (userSnap.data().kycStatus === 'verified') {
      return { statusCode: 400, body: JSON.stringify({ error: 'User is already verified' }) };
    }
  } catch (err) {
    console.error('Firestore user lookup failed:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: 'Database error: ' + err.message }) };
  }

  /* Upload to Cloudinary */
  let frontUrl, backUrl, selfieUrl;
  try {
    console.log('Uploading to Cloudinary...');
    [frontUrl, backUrl, selfieUrl] = await Promise.all([
      uploadToCloudinary(frontImage,  'image/jpeg', `${uid}-nin-front`),
      uploadToCloudinary(backImage,   'image/jpeg', `${uid}-nin-back`),
      uploadToCloudinary(selfieImage, 'image/jpeg', `${uid}-selfie`),
    ]);
    console.log('Cloudinary upload success. frontUrl:', frontUrl);
  } catch (err) {
    console.error('Cloudinary upload error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: 'Image upload failed: ' + err.message }) };
  }

  /* Write to Firestore */
  try {
    await db.collection('users').doc(uid).update({
      kycStatus:          'under-review',
      kycDocumentType:    'NIN Card',
      kycSubmittedAt:     FieldValue.serverTimestamp(),
      kycImages: { frontUrl, backUrl, selfieUrl },
      kycRejectionReason: FieldValue.delete(),
      // Sanitized identity fields — written only if provided by the user
      ...(fullName    ? { kycFullName:    fullName }    : {}),
      ...(address     ? { kycAddress:     address }     : {}),
      ...(idNumber    ? { kycIdNumber:    idNumber }    : {}),
      ...(phoneNumber ? { kycPhoneNumber: phoneNumber } : {}),
    });
  } catch (err) {
    console.error('Firestore update error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: 'Failed to save submission: ' + err.message }) };
  }

  /* Notify admin */
  await notifyAdmin({ uid, adminEmail: process.env.ADMIN_EMAIL, platformUrl: process.env.PLATFORM_URL });

  console.log('KYC submitted successfully for uid:', uid);
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ok: true }),
  };
};
