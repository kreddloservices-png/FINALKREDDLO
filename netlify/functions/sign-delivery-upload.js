/**
 * Netlify Function: sign-delivery-upload.js
 *
 * Generates a signed Cloudinary upload signature so the browser can upload
 * large delivery files (downloads) and videos DIRECTLY to Cloudinary,
 * bypassing Netlify's function payload limits.
 *
 * Gated to Pro users only — checks users/{uid}.plan === 'pro' in Firestore.
 *
 * POST body (JSON):
 *   {
 *     uid:      string,            // current user's uid
 *     resourceType: 'raw'|'video',  // 'raw' for downloadable files, 'video' for videos
 *   }
 *
 * Response:
 *   200 {
 *     cloudName, apiKey, timestamp, signature,
 *     folder, publicId, resourceType
 *   }
 *   403 { error: 'Pro plan required.' }
 *
 * Env vars required:
 *   FIREBASE_SERVICE_ACCOUNT
 *   CLOUDINARY_CLOUD_NAME
 *   CLOUDINARY_API_KEY
 *   CLOUDINARY_API_SECRET
 */

const crypto = require('crypto');
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore }                 = require('firebase-admin/firestore');
const { verifyCaller }                 = require('./_verify-auth');

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

exports.handler = async function (event) {
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
    return respond(405, { error: 'Method not allowed' });
  }

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch { return respond(400, { error: 'Invalid JSON' }); }

  const { uid, resourceType, existingPublicId } = payload;

  /* ── Verify caller identity (FIX) ──
     Previously `uid` was taken from the request body with no auth check
     at all. The Pro-plan gate below reads users/{uid}.plan — for
     whatever uid the request claimed — and hands back a valid signed
     Cloudinary upload authorization if that uid happens to be Pro. That
     let any free-tier (or anonymous) caller bypass the Pro paywall
     entirely by simply supplying a known Pro user's uid, then using the
     resulting signature for their OWN upload, namespaced under the
     victim's identity. */
  const callerUid = await verifyCaller(event);
  if (!callerUid) {
    return respond(401, { error: 'Unauthorized. Please log in again.' });
  }
  if (!uid || typeof uid !== 'string' || uid !== callerUid) {
    return respond(403, { error: 'Caller identity mismatch.' });
  }
  if (resourceType !== 'raw' && resourceType !== 'video') {
    return respond(400, { error: "resourceType must be 'raw' or 'video'" });
  }
  /* ── FIX: existingPublicId ownership check ──
     Without this, a caller could pass another user's existingPublicId
     (e.g. "{victimUid}-...") and receive a valid signature authorizing a
     direct Cloudinary overwrite of that victim's asset. */
  if (existingPublicId != null) {
    if (typeof existingPublicId !== 'string' || !existingPublicId.startsWith(callerUid + '-')) {
      return respond(403, { error: 'existingPublicId must belong to the authenticated user.' });
    }
  }

  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey    = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;

  if (!cloudName || !apiKey || !apiSecret) {
    return respond(500, { error: 'Cloudinary env vars not configured.' });
  }

  try {
    // ── Pro-plan gate ──
    const db = getDb();
    const userSnap = await db.collection('users').doc(uid).get();
    const plan = userSnap.exists ? (userSnap.data().plan || 'free') : 'free';

    if (plan !== 'pro') {
      return respond(403, { error: 'Pro plan required for file and video uploads.' });
    }

    // ── Build signed params ──
    const folder    = resourceType === 'video' ? 'product-videos' : 'product-files';
    const timestamp  = Math.floor(Date.now() / 1000).toString();

    // Reuse existing publicId when editing so Cloudinary overwrites the asset.
    // Generate a fresh one for new uploads.
    const publicId   = (existingPublicId && typeof existingPublicId === 'string' && existingPublicId.length > 0)
      ? existingPublicId
      : `${uid}-${Date.now()}`;

    // Params must be sorted alphabetically for the signature string
    const sigStr   = `folder=${folder}&public_id=${publicId}&timestamp=${timestamp}${apiSecret}`;
    const signature = crypto.createHash('sha1').update(sigStr).digest('hex');

    return respond(200, {
      cloudName,
      apiKey,
      timestamp,
      signature,
      folder,
      publicId,
      resourceType,
    });

  } catch (err) {
    console.error('sign-delivery-upload error:', err.message);
    return respond(500, { error: err.message });
  }
};

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(body),
  };
}
