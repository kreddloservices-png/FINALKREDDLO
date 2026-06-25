/**
 * Netlify Scheduled Function: process-email-queue.js
 * Path: netlify/functions/process-email-queue.js
 * Schedule: every 5 minutes (cron: 5-minute interval)
 *
 * Processes delayed emails from the email-queue Firestore collection.
 *
 * Logic per queued document:
 *   1. Check if sendAfter timestamp has passed. (Firestore query handles this.)
 *   2. Resolve the recipient email — uses the `to` field stored on the
 *      queue doc, falling back to a Firestore lookup by userUid for queue
 *      docs that don't carry a top-level recipient (e.g. guest-welcome
 *      emails where userUid IS the recipient). If no email can be
 *      resolved, mark sent=true, skippedReason='no-recipient-email'.
 *   3. Fetch the corresponding in-app notification document.
 *   4. If the user has already READ the notification — skip the email.
 *      Mark queue doc as sent with skippedReason = 'read-by-user'.
 *   5. If not read — send the email via send-email function.
 *      Mark queue doc sent=true, update notification emailSent=true.
 *
 * Firestore email-queue document schema:
 *   {
 *     userUid:    string
 *     notifDocId: string | null
 *     templateId: string
 *     emailData:  object
 *     to:         string         — recipient email address
 *     toName:     string | null  — recipient display name
 *     sendAfter:  number (Unix ms timestamp)
 *     sent:       boolean
 *     createdAt:  Timestamp
 *   }
 *
 * Environment variables required:
 *   FIREBASE_SERVICE_ACCOUNT  — full service account JSON
 *   PLATFORM_URL              — live domain e.g. https://kreddlo.space
 *   INTERNAL_FUNCTION_SECRET  — shared secret sent as x-internal-secret when
 *                               calling send-email (server-to-server call)
 */

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore }                 = require('firebase-admin/firestore');

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

/* ── Call a sibling Netlify function ── */
async function callFunction(name, payload) {
  const platformUrl = (process.env.PLATFORM_URL || 'https://kreddlo.space').replace(/\/$/, '');
  if (!platformUrl) {
    console.warn(`callFunction: PLATFORM_URL not set, cannot call ${name}.`);
    return null;
  }
  try {
    const res = await fetch(`${platformUrl}/.netlify/functions/${name}`, {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-internal-secret': process.env.INTERNAL_FUNCTION_SECRET || '',
      },
      body:    JSON.stringify(payload),
    });
    return res;
  } catch (err) {
    console.warn(`callFunction(${name}) failed:`, err.message);
    return null;
  }
}

/* ══════════════════════════════════════════════════════════════
   HANDLER
══════════════════════════════════════════════════════════════ */
exports.handler = async (event) => {

  /* ── Verify trigger source (FIX) ──
     Previously this function had no auth check at all (and didn't even
     accept the `event` parameter needed to check one). It only acts on
     already-due queue entries (no attacker-controlled targeting), but
     was still an open door for unauthenticated cost/resource abuse —
     repeated triggers could force excess email sends. Netlify's own
     scheduler sends 'X-NF-Event: schedule' on real cron invocations; we
     also accept a valid x-internal-secret for manual/internal
     triggering, matching the rest of this codebase. */
  const nfEvent        = (event && event.headers && (event.headers['x-nf-event'] || event.headers['X-NF-Event'])) || '';
  const incomingSecret = (event && event.headers && (event.headers['x-internal-secret'] || event.headers['X-Internal-Secret'])) || '';
  const expectedSecret = process.env.INTERNAL_FUNCTION_SECRET || '';
  const isRealSchedule = nfEvent === 'schedule';
  const isTrustedCall  = !!expectedSecret && incomingSecret === expectedSecret;
  if (!isRealSchedule && !isTrustedCall) {
    return respond(401, { error: 'Unauthorized.' });
  }

  let db;
  try {
    db = getDb();
  } catch (err) {
    console.error('Firebase Admin init failed:', err.message);
    return respond(500, { error: 'Database not available.' });
  }

  const now = Date.now();

  /* ── Query: unsent docs whose sendAfter has passed ── */
  let snapshot;
  try {
    snapshot = await db
      .collection('email-queue')
      .where('sent', '==', false)
      .where('sendAfter', '<=', now)
      .limit(20)
      .get();
  } catch (err) {
    console.error('Firestore email-queue query failed:', err.message);
    return respond(500, { error: 'Queue query failed.' });
  }

  if (snapshot.empty) {
    console.log('process-email-queue: no pending items.');
    return respond(200, { processed: 0 });
  }

  console.log(`process-email-queue: processing ${snapshot.size} item(s).`);

  let processed = 0;
  let skipped   = 0;
  let errors    = 0;

  for (const queueDoc of snapshot.docs) {
    const queueData = queueDoc.data();
    const { userUid, notifDocId, templateId, emailData } = queueData;
    let   { to: recipientEmail, toName: recipientName } = queueData;

    const queueRef = db.collection('email-queue').doc(queueDoc.id);

    /* ── Backward compat / sender-vs-recipient cases: some queue docs
       (e.g. create-product-order.js's guest-welcome email) don't store a
       top-level `to` field at all — userUid IS the recipient there, so
       look the user up. This also covers any older queue docs written
       before the `to` field existed. ── */
    if (!recipientEmail && userUid) {
      try {
        const userSnap = await db.collection('users').doc(userUid).get();
        if (userSnap.exists) {
          recipientEmail = userSnap.data().email || null;
          recipientName  = userSnap.data().name  || null;
        }
      } catch (err) {
        console.warn(`Could not look up email for uid ${userUid}:`, err.message);
      }
    }

    /* ── Skip cleanly if we still have no recipient email — this item can
       never succeed, so don't let it loop in the queue indefinitely. ── */
    if (!recipientEmail) {
      try {
        await queueRef.update({
          sent:          true,
          skippedReason: 'no-recipient-email',
          processedAt:   new Date().toISOString(),
        });
        console.warn(`Skipped email for uid ${userUid} (no recipient email found), queueDocId ${queueDoc.id}.`);
        skipped++;
      } catch (err) {
        console.error(`Failed to mark queue doc ${queueDoc.id} as skipped:`, err.message);
        errors++;
      }
      continue;
    }

    /* ── Check if notification was already read ── */
    let notificationRead = false;

    if (notifDocId && userUid) {
      try {
        const notifSnap = await db
          .collection('users').doc(userUid)
          .collection('notifications').doc(notifDocId)
          .get();

        if (notifSnap.exists && notifSnap.data().read === true) {
          notificationRead = true;
        }
      } catch (err) {
        // If we can't read the notification doc, err on the side of sending
        console.warn(`Could not read notification doc ${notifDocId} for uid ${userUid}:`, err.message);
      }
    }

    /* ── Skip if already read ── */
    if (notificationRead) {
      try {
        await queueRef.update({
          sent:          true,
          skippedReason: 'read-by-user',
          processedAt:   new Date().toISOString(),
        });
        console.log(`Skipped email for uid ${userUid} (notification already read), queueDocId ${queueDoc.id}.`);
        skipped++;
      } catch (err) {
        console.error(`Failed to mark queue doc ${queueDoc.id} as skipped:`, err.message);
        errors++;
      }
      continue;
    }

    /* ── Retry cap: abandon docs that have failed too many times ──────────
       Without this, a doc that can never succeed (e.g. permanent Brevo
       rejection, mismatched secret) fills every batch run indefinitely and
       blocks new legitimate entries from being processed. After MAX_RETRIES
       failed send attempts we mark it sent=true with skippedReason so it
       leaves the active queue. retryCount is incremented on every failure. ── */
    const MAX_RETRIES = 5;
    const retryCount  = typeof queueData.retryCount === 'number' ? queueData.retryCount : 0;

    if (retryCount >= MAX_RETRIES) {
      try {
        await queueRef.update({
          sent:          true,
          skippedReason: 'max-retries-exceeded',
          processedAt:   new Date().toISOString(),
        });
        console.warn(`Abandoned queue doc ${queueDoc.id} after ${retryCount} failed attempts (uid ${userUid}, template ${templateId}).`);
        skipped++;
      } catch (err) {
        console.error(`Failed to abandon queue doc ${queueDoc.id}:`, err.message);
        errors++;
      }
      continue;
    }

    /* ── Send the email ── */
    try {
      const res = await callFunction('send-email', {
        to:     recipientEmail,
        toName: recipientName || undefined,
        templateId,
        data:   emailData || {},
      });

      if (res && res.ok) {
        // Mark queue doc as sent
        await queueRef.update({
          sent:        true,
          sentAt:      new Date().toISOString(),
          processedAt: new Date().toISOString(),
        });

        // Update the notification document too
        if (notifDocId && userUid) {
          try {
            await db
              .collection('users').doc(userUid)
              .collection('notifications').doc(notifDocId)
              .update({ emailSent: true, emailSentAt: new Date().toISOString() });
          } catch (err) {
            // Non-fatal
            console.warn(`Could not update emailSent on notification ${notifDocId}:`, err.message);
          }
        }

        console.log(`Email sent for uid ${userUid}, template ${templateId}, queueDocId ${queueDoc.id}.`);
        processed++;
      } else {
        const status    = res ? res.status : 'no response';
        const nextRetry = retryCount + 1;
        console.error(`send-email returned ${status} for uid ${userUid}, queueDocId ${queueDoc.id}. Retry ${nextRetry}/${MAX_RETRIES}.`);
        try {
          await queueRef.update({
            retryCount:  nextRetry,
            lastError:   `send-email HTTP ${status}`,
            lastAttempt: new Date().toISOString(),
          });
        } catch (updateErr) {
          console.error(`Failed to update retryCount on queue doc ${queueDoc.id}:`, updateErr.message);
        }
        errors++;
      }
    } catch (err) {
      const nextRetry = retryCount + 1;
      console.error(`Error sending email for queueDocId ${queueDoc.id} (retry ${nextRetry}/${MAX_RETRIES}):`, err.message);
      try {
        await queueRef.update({
          retryCount:  nextRetry,
          lastError:   err.message,
          lastAttempt: new Date().toISOString(),
        });
      } catch (updateErr) {
        console.error(`Failed to update retryCount on queue doc ${queueDoc.id}:`, updateErr.message);
      }
      errors++;
    }
  }

  console.log(`process-email-queue done. processed=${processed} skipped=${skipped} errors=${errors}`);
  return respond(200, { processed, skipped, errors });
};

/* ── Utility ── */
function respond(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
