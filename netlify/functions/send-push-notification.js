/**
 * Netlify Function: send-push-notification.js
 * Path: netlify/functions/send-push-notification.js
 *
 * Sends an FCM push notification to a single user AND writes an in-app
 * notification document to Firestore so the bell dot stays in sync even
 * when push delivery fails (user has not granted permission, token expired, etc).
 *
 * POST body:
 *   {
 *     userUid: string   — the Firebase UID of the recipient
 *     title:   string   — notification title
 *     body:    string   — notification body text
 *     url?:    string   — optional deep-link URL (opened on notification tap)
 *   }
 *
 * AUTHENTICATION — two allowed caller types (same pattern as
 * send-smart-notification.js, kept in sync intentionally):
 *   1. Trusted server-to-server callers (Netlify function → Netlify
 *      function, e.g. scheduled-subscriptions.js). These send header
 *      'x-internal-secret: <INTERNAL_FUNCTION_SECRET>' instead of a user
 *      auth token, since there is no signed-in user behind a scheduled job.
 *   2. An authenticated admin calling with a normal Firebase ID token in
 *      the Authorization header, whose users/{uid}.role is 'admin'.
 *   A request must satisfy ONE of the two.
 *
 * FIX (audit finding N1): this endpoint previously had no auth check at
 * all — any caller who knew or guessed a userUid could push an arbitrary
 * title/body/url to that user's device and write it straight into their
 * Firestore notifications subcollection. Gated the same way
 * send-smart-notification.js already is.
 *
 * Environment variables required:
 *   FIREBASE_SERVICE_ACCOUNT  — full Firebase service account JSON as a single-line string
 *   PLATFORM_URL              — live domain e.g. https://kreddlo.space (no trailing slash)
 *   INTERNAL_FUNCTION_SECRET  — shared secret used ONLY for server-to-server
 *                                calls between Netlify functions. Never expose
 *                                this to the browser/client.
 */

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue }     = require('firebase-admin/firestore');
const { verifyCaller }                 = require('./_verify-auth');

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

/* ── Extract project_id from service account for FCM endpoint ── */
function getProjectId() {
  try {
    const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
    return sa.project_id || '';
  } catch {
    return '';
  }
}

/* ── Generate a Google OAuth 2.0 access token from the service account ── */
async function getGoogleAccessToken() {
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');

  const now     = Math.floor(Date.now() / 1000);
  const payload = {
    iss:   sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud:   'https://oauth2.googleapis.com/token',
    iat:   now,
    exp:   now + 3600,
  };

  // Build the JWT manually (header.payload.signature)
  const header   = { alg: 'RS256', typ: 'JWT' };
  const b64url   = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const unsigned = `${b64url(header)}.${b64url(payload)}`;

  // Sign with the private key using Node's crypto
  const crypto = require('crypto');
  const sign   = crypto.createSign('RSA-SHA256');
  sign.update(unsigned);
  const signature = sign.sign(sa.private_key, 'base64url');
  const jwt       = `${unsigned}.${signature}`;

  // Exchange for an access token
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Google OAuth token exchange failed: ${err}`);
  }

  const data = await res.json();
  return data.access_token;
}

/* ── Send the FCM push via HTTP v1 API ── */
async function sendFcmPush({ fcmToken, title, body, url }) {
  const projectId   = getProjectId();
  const accessToken = await getGoogleAccessToken();

  const fcmEndpoint = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;

  const message = {
    message: {
      token: fcmToken,
      notification: { title, body },
      data: {
        url:     url || '',
        title:   title,
        body:    body,
        // click_action is used by older SDKs; url in data works for modern web push
        click_action: url || '',
      },
      webpush: {
        notification: {
          title,
          body,
          icon:  '/assets/kreddlo-192.png',
          badge: '/assets/favicon-32x32.png',
        },
        fcm_options: {
          link: url || '/',
        },
      },
    },
  };

  const res = await fetch(fcmEndpoint, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${accessToken}`,
    },
    body: JSON.stringify(message),
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    // FCM error codes that mean the token is no longer valid
    const staleTokenCodes = ['registration-token-not-registered', 'invalid-registration-token'];
    const fcmError        = errBody?.error?.details?.[0]?.errorCode || '';
    if (staleTokenCodes.includes(fcmError)) {
      return { sent: false, staleToken: true };
    }
    throw new Error(`FCM push failed: ${JSON.stringify(errBody)}`);
  }

  return { sent: true, staleToken: false };
}

/* ── Resolve a templateId to a broad notification category.
   Must match one of the four TYPE_CONFIG keys in notifications.html:
   'payment' | 'project' | 'account' | 'admin'. ── */
const TEMPLATE_TYPE_MAP = {
  'payment-received':           'payment',
  'payment-confirmed-buyer':    'payment',
  'withdrawal-initiated':       'payment',
  'bank-withdrawal-initiated':  'payment',
  'withdrawal-failed':          'payment',
  'referral-credited':          'payment',
  'invoice-escrow-held-seller': 'payment',
  'invoice-escrow-released':    'payment',
  'new-project-request':        'project',
  'contract-active':            'project',
  'contract-sign-requested':    'project',
  'contract-declined':          'project',
  'contract-change-proposed':   'project',
  'contract-change-accepted':   'project',
  'contract-change-rejected':   'project',
  'work-delivered':             'project',
  'delivery-confirmed-buyer':   'project',
  'dispute-raised':             'project',
  'dispute-resolved':           'project',
  'new-review':                 'project',
  'review-request':             'project',
};

/* ── Write in-app notification to Firestore ── */
async function writeInAppNotification(db, userUid, { title, body, url, type }) {
  await db.collection('users').doc(userUid).collection('notifications').add({
    title,
    body,
    url:       url || null,
    type:      type || 'account',
    read:      false,
    createdAt: FieldValue.serverTimestamp(),
  });
}

/* ══════════════════════════════════════════════════════════════
   HANDLER
══════════════════════════════════════════════════════════════ */
exports.handler = async (event) => {

  /* ── Accept POST only ── */
  if (event.httpMethod !== 'POST') {
    return respond(405, { error: 'Method not allowed.' });
  }

  // Two allowed caller types — see header comment:
  //   1. Trusted internal server-to-server call (shared secret header)
  //   2. Authenticated admin (Firebase ID token + role === 'admin')
  const internalSecretHeader =
    event.headers['x-internal-secret'] || event.headers['X-Internal-Secret'] || '';
  const expectedInternalSecret = process.env.INTERNAL_FUNCTION_SECRET || '';
  const isTrustedInternalCall =
    !!expectedInternalSecret && internalSecretHeader === expectedInternalSecret;

  let db;

  if (isTrustedInternalCall) {
    // Server-to-server call — already trusted, skip user/role checks.
    try {
      db = getDb();
    } catch (err) {
      console.error('getDb() failed for internal call:', err.message);
      return respond(500, { error: 'Database initialization failed.' });
    }
  } else {
    // Fall back to admin-token auth.
    const callerUid = await verifyCaller(event);
    if (!callerUid) {
      return respond(401, { error: 'Unauthorized.' });
    }

    try {
      db = getDb();
      const callerSnap = await db.collection('users').doc(callerUid).get();
      if (!callerSnap.exists || callerSnap.data().role !== 'admin') {
        return respond(403, { error: 'Forbidden — admin role required.' });
      }
    } catch (err) {
      console.error('Caller role check failed:', err.message);
      return respond(500, { error: 'Could not verify caller permissions.' });
    }
  }

  /* ── Parse body ── */
  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return respond(400, { error: 'Invalid JSON body.' });
  }

  const { userUid, title, body, url, type: payloadType, templateId: payloadTemplateId } = payload;
  // Resolve type: explicit type field > templateId lookup > 'account'
  const notifType = payloadType || TEMPLATE_TYPE_MAP[payloadTemplateId] || 'account';

  if (!userUid || typeof userUid !== 'string') {
    return respond(400, { error: 'userUid is required.' });
  }
  if (!title || typeof title !== 'string') {
    return respond(400, { error: 'title is required.' });
  }
  if (!body || typeof body !== 'string') {
    return respond(400, { error: 'body is required.' });
  }

  const platformUrl = (process.env.PLATFORM_URL || 'https://kreddlo.space').replace(/\/$/, '');
  const notifUrl    = url || `${platformUrl}/dashboard.html`;

  /* ── Fetch user document ── */
  let userSnap;
  try {
    userSnap = await db.collection('users').doc(userUid).get();
  } catch (err) {
    console.error(`Firestore read failed for uid ${userUid}:`, err.message);
    return respond(500, { error: 'Database read failed.' });
  }

  if (!userSnap.exists) {
    console.warn(`send-push-notification: user ${userUid} not found.`);
    return respond(404, { error: 'User not found.' });
  }

  const { fcmToken } = userSnap.data();

  /* ── Always write the in-app notification regardless of push status ── */
  try {
    await writeInAppNotification(db, userUid, { title, body, url: notifUrl, type: notifType });
    console.log(`In-app notification written for uid ${userUid}.`);
  } catch (err) {
    // Non-fatal — log and continue
    console.error(`Failed to write in-app notification for uid ${userUid}:`, err.message);
  }

  /* ── Send push if token exists ── */
  if (!fcmToken) {
    console.log(`uid ${userUid} has no fcmToken — in-app notification only.`);
    return respond(200, { success: true, push: false, reason: 'No FCM token on record.' });
  }

  try {
    const result = await sendFcmPush({
      fcmToken,
      title,
      body,
      url: notifUrl,
    });

    if (result.staleToken) {
      // Token expired — clear it from Firestore so we stop trying
      await db.collection('users').doc(userUid).update({ fcmToken: null });
      console.log(`Stale FCM token cleared for uid ${userUid}.`);
      return respond(200, { success: true, push: false, reason: 'Stale token cleared.' });
    }

    console.log(`Push notification sent to uid ${userUid}.`);
    return respond(200, { success: true, push: true });

  } catch (err) {
    // Push failure is non-fatal — in-app notification is already written
    console.error(`FCM push failed for uid ${userUid}:`, err.message);
    return respond(200, { success: true, push: false, reason: err.message });
  }
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
