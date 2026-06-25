/**
 * Netlify Function: send-smart-notification.js
 * Path: netlify/functions/send-smart-notification.js
 *
 * Unified notification dispatcher. Handles:
 *   1. Writing an in-app notification to Firestore (always)
 *   2. Sending an FCM push notification (if user has a token)
 *   3. Sending a transactional email via send-email (emailMode controls timing)
 *
 * POST body:
 *   {
 *     userUid:      string        — Firebase UID of the recipient
 *     title:        string        — notification title
 *     body:         string        — notification body text
 *     url?:         string        — optional deep-link URL
 *     templateId:   string        — email template ID (matches send-email.js)
 *     emailData:    object        — data object passed to the email template
 *     emailMode:    'always' | 'delayed' | 'never'
 *     delayMinutes: number        — delay in minutes for 'delayed' mode (default 15)
 *   }
 *
 * AUTHENTICATION — two allowed caller types:
 *   1. Trusted server-to-server callers (Netlify function → Netlify function,
 *      e.g. payment webhooks, approve-delivery, sign-contract, scheduled jobs).
 *      These send header  'x-internal-secret: <INTERNAL_FUNCTION_SECRET>'
 *      instead of a user auth token, since there is no signed-in user behind
 *      a webhook or scheduled job.
 *   2. An authenticated admin calling from admin.html (broadcast/single-user
 *      notification tool). These send a normal Firebase ID token in the
 *      Authorization header, and the caller's `users/{uid}.role` must be
 *      'admin'.
 *   A request must satisfy ONE of the two — neither grants the other's access.
 *
 * Environment variables required:
 *   FIREBASE_SERVICE_ACCOUNT   — full service account JSON (single-line string)
 *   PLATFORM_URL               — live domain e.g. https://kreddlo.space
 *   INTERNAL_FUNCTION_SECRET   — shared secret used ONLY for server-to-server
 *                                calls between Netlify functions. Never expose
 *                                this to the browser/client. Set it in Netlify
 *                                env vars and reuse the exact same value in
 *                                every function that calls this one internally.
 */

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue }     = require('firebase-admin/firestore');
const crypto                           = require('crypto');
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

/* ── Extract project_id for FCM HTTP v1 endpoint ── */
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

  const header   = { alg: 'RS256', typ: 'JWT' };
  const b64url   = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const unsigned = `${b64url(header)}.${b64url(payload)}`;

  const sign = crypto.createSign('RSA-SHA256');
  sign.update(unsigned);
  const signature = sign.sign(sa.private_key, 'base64url');
  const jwt       = `${unsigned}.${signature}`;

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

/* ── Send FCM push via HTTP v1 API ── */
async function sendFcmPush({ fcmToken, title, body, url }) {
  const projectId   = getProjectId();
  const accessToken = await getGoogleAccessToken();
  const fcmEndpoint = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;

  const message = {
    message: {
      token: fcmToken,
      notification: { title, body },
      data: {
        url:          url || '',
        title,
        body,
        click_action: url || '',
      },
      webpush: {
        notification: {
          title,
          body,
          icon:  '/assets/kreddlo-192.png',
          badge: '/assets/favicon-32x32.png',
        },
        fcm_options: { link: url || '/' },
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
    const fcmError = errBody?.error?.details?.[0]?.errorCode || '';
    const stale    = ['registration-token-not-registered', 'invalid-registration-token'];
    if (stale.includes(fcmError)) return { sent: false, staleToken: true };
    throw new Error(`FCM push failed: ${JSON.stringify(errBody)}`);
  }

  return { sent: true, staleToken: false };
}

/* ── Call a sibling Netlify function by name ── */
async function callFunction(name, payload) {
  const platformUrl = (process.env.PLATFORM_URL || 'https://kreddlo.space').replace(/\/$/, '');
  if (!platformUrl) {
    console.warn(`callFunction: PLATFORM_URL not set, cannot call ${name}.`);
    return null;
  }
  const res = await fetch(`${platformUrl}/.netlify/functions/${name}`, {
    method:  'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-internal-secret': process.env.INTERNAL_FUNCTION_SECRET || '',
    },
    body:    JSON.stringify(payload),
  });
  return res;
}

/* ══════════════════════════════════════════════════════════════
   HANDLER
══════════════════════════════════════════════════════════════ */
exports.handler = async (event) => {

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
    // Fall back to admin-token auth (used by admin.html).
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

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return respond(400, { error: 'Invalid JSON body.' });
  }

  const {
    userUid,
    title,
    body,
    url,
    templateId,
    emailData    = {},
    emailMode    = 'never',
    delayMinutes = 15,
  } = payload;

  if (!userUid) return respond(400, { error: 'userUid is required.' });
  if (!title)   return respond(400, { error: 'title is required.' });
  if (!body)    return respond(400, { error: 'body is required.' });
  // templateId is only required when an email will actually be sent
  if (!templateId && emailMode !== 'never') {
    return respond(400, { error: 'templateId is required when emailMode is not "never".' });
  }

  const platformUrl = (process.env.PLATFORM_URL || 'https://kreddlo.space').replace(/\/$/, '');
  const notifUrl    = url || `${platformUrl}/dashboard.html`;

  /* ── Step 1: Fetch user from Firestore ── */
  let userSnap;
  try {
    userSnap = await db.collection('users').doc(userUid).get();
  } catch (err) {
    console.error('Firestore read failed:', err.message);
    return respond(500, { error: 'Database read failed.' });
  }

  if (!userSnap.exists) {
    console.warn(`send-smart-notification: user ${userUid} not found.`);
    return respond(404, { error: 'User not found.' });
  }

  const { fcmToken, email: recipientEmail, name: recipientName } = userSnap.data();

  /* ── Step 2: Write in-app notification document ── */
  /* Map templateId → broad notification category so notifications.html
     filter tabs (Payments, Projects, Account) work correctly.
     The tab filter matches n.type === currentFilter, so type must be
     one of the four TYPE_CONFIG keys: 'payment' | 'project' | 'account' | 'admin'. */
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
  const notifType = TEMPLATE_TYPE_MAP[templateId] || 'account';

  let notifDocId;
  try {
    const notifRef = await db
      .collection('users')
      .doc(userUid)
      .collection('notifications')
      .add({
        title,
        body,
        url:        notifUrl,
        templateId,
        type:       notifType,
        read:       false,
        emailSent:  false,
        emailMode,
        createdAt:  FieldValue.serverTimestamp(),
      });
    notifDocId = notifRef.id;
    console.log(`In-app notification written for uid ${userUid}, docId ${notifDocId}.`);
  } catch (err) {
    // Non-fatal — log and continue
    console.error(`Failed to write in-app notification for uid ${userUid}:`, err.message);
  }

  /* ── Step 3: Send FCM push if token exists ── */
  if (fcmToken) {
    try {
      const result = await sendFcmPush({ fcmToken, title, body, url: notifUrl });
      if (result.staleToken) {
        await db.collection('users').doc(userUid).update({ fcmToken: null });
        console.log(`Stale FCM token cleared for uid ${userUid}.`);
      } else {
        console.log(`FCM push sent to uid ${userUid}.`);
      }
    } catch (err) {
      // Non-fatal — in-app notification already written
      console.error(`FCM push failed for uid ${userUid}:`, err.message);
    }
  } else {
    console.log(`uid ${userUid} has no fcmToken — in-app only.`);
  }

  /* ── Step 4: Handle email based on emailMode ── */
  if (emailMode === 'never') {
    return respond(200, { received: true, notifDocId });
  }

  if (emailMode === 'always') {
    if (!recipientEmail) {
      console.warn(`uid ${userUid} has no email on file — skipping immediate email send (template ${templateId}).`);
      return respond(200, { received: true, notifDocId });
    }
    try {
      // FIX (audit finding N2): callFunction() resolves normally on a 4xx/5xx
      // response — fetch() only throws on network-level failure — so the
      // result must be checked explicitly before trusting the email actually
      // sent. Previously this awaited the call and unconditionally marked
      // emailSent: true, which meant a bad templateId, a missing
      // BREVO_API_KEY, or a Brevo outage all got silently recorded as a
      // successful send. Same res.ok check process-email-queue.js already
      // uses for this exact call.
      const res = await callFunction('send-email', {
        to:     recipientEmail,
        toName: recipientName || undefined,
        templateId,
        data:   emailData,
      });

      if (res && res.ok) {
        // Mark emailSent on the notification document
        if (notifDocId) {
          await db
            .collection('users').doc(userUid)
            .collection('notifications').doc(notifDocId)
            .update({ emailSent: true, emailSentAt: new Date().toISOString() });
        }
        console.log(`Email sent immediately for uid ${userUid}, template ${templateId}.`);
      } else {
        const status = res ? res.status : 'no response';
        console.error(`send-email returned ${status} for uid ${userUid}, template ${templateId} — not marking emailSent.`);
      }
    } catch (err) {
      console.error(`Email send failed for uid ${userUid}:`, err.message);
    }
    return respond(200, { received: true, notifDocId });
  }

  if (emailMode === 'delayed') {
    if (!recipientEmail) {
      console.warn(`uid ${userUid} has no email on file — skipping delayed email queue (template ${templateId}).`);
      return respond(200, { received: true, notifDocId });
    }
    try {
      await db.collection('email-queue').add({
        userUid,
        notifDocId:  notifDocId || null,
        templateId,
        emailData,
        to:          recipientEmail,
        toName:      recipientName || null,
        sendAfter:   Date.now() + delayMinutes * 60 * 1000,
        sent:        false,
        createdAt:   FieldValue.serverTimestamp(),
      });
      console.log(`Email queued for uid ${userUid} in ${delayMinutes} min, template ${templateId}.`);
    } catch (err) {
      console.error(`Failed to queue email for uid ${userUid}:`, err.message);
    }
    return respond(200, { received: true, notifDocId });
  }

  // Fallback for unknown emailMode
  return respond(200, { received: true, notifDocId });
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
