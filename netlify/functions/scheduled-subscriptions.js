/**
 * Netlify Scheduled Function: scheduled-subscriptions.js
 * Path: netlify/functions/scheduled-subscriptions.js
 *
 * Runs daily at midnight UTC (schedule defined in netlify.toml).
 * Finds all users whose premium plan has expired and:
 *   1. Sets premiumStatus → "inactive"
 *   2. Sends a push notification
 *   3. Sends a "premium-expired" email
 *
 * netlify.toml entry required:
 *   [[plugins]]
 *   package = "@netlify/plugin-functions-install-core"
 *
 *   [functions."scheduled-subscriptions"]
 *   schedule = "0 0 * * *"
 *
 * Environment variables required:
 *   FIREBASE_SERVICE_ACCOUNT — full service account JSON as single-line string
 *   PLATFORM_URL             — live domain e.g. https://kreddlo.space
 */

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue }     = require('firebase-admin/firestore');

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

/* ── Internal function caller ── */
async function callFunction(functionName, payload) {
  const platformUrl = (process.env.PLATFORM_URL || 'https://kreddlo.space').replace(/\/$/, '');
  if (!platformUrl) {
    console.warn(`PLATFORM_URL not set — cannot call ${functionName}.`);
    return;
  }

  try {
    const res = await fetch(`${platformUrl}/.netlify/functions/${functionName}`, {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-internal-secret': process.env.INTERNAL_FUNCTION_SECRET || '',
      },
      body:    JSON.stringify(payload),
    });
    if (!res.ok) {
      const errText = await res.text();
      console.warn(`${functionName} returned ${res.status}: ${errText}`);
    }
  } catch (err) {
    console.error(`Failed to call ${functionName}:`, err.message);
  }
}

/* ══════════════════════════════════════════════════════════════
   HANDLER
   Netlify scheduled functions receive a special context object.
   The handler signature accepts (event, context) but we only
   need event for the trigger check.
══════════════════════════════════════════════════════════════ */
exports.handler = async (event) => {

  /* ── Verify trigger source (FIX) ──
     The header comment above referenced "the trigger check" but no such
     check was actually implemented — this function was reachable by
     anyone at its public URL with no auth at all. It only acts on users
     whose plan has already expired (no attacker-controlled targeting),
     but was still an open door for unauthenticated cost/resource abuse.
     Netlify's own scheduler sends 'X-NF-Event: schedule' on real cron
     invocations; we also accept a valid x-internal-secret for manual/
     internal triggering, matching the rest of this codebase. */
  const nfEvent        = event.headers['x-nf-event'] || event.headers['X-NF-Event'] || '';
  const incomingSecret = event.headers['x-internal-secret'] || event.headers['X-Internal-Secret'] || '';
  const expectedSecret = process.env.INTERNAL_FUNCTION_SECRET || '';
  const isRealSchedule = nfEvent === 'schedule';
  const isTrustedCall  = !!expectedSecret && incomingSecret === expectedSecret;
  if (!isRealSchedule && !isTrustedCall) {
    return respond(401, { error: 'Unauthorized.' });
  }

  console.log('scheduled-subscriptions: running at', new Date().toISOString());

  let db;
  try {
    db = getDb();
  } catch (err) {
    console.error('Firebase Admin init failed:', err.message);
    return respond(500, { error: 'Database not available.' });
  }

  const now = new Date();

  /* ── Query for expired active subscriptions ── */
  let snapshot;
  try {
    snapshot = await db.collection('users')
      .where('premiumStatus',  '==',  'active')
      .where('premiumEndDate', '<=', now)
      .get();
  } catch (err) {
    console.error('Firestore query failed:', err.message);
    return respond(500, { error: 'Database query failed.' });
  }

  if (snapshot.empty) {
    console.log('scheduled-subscriptions: no expired subscriptions found.');
    return respond(200, { processed: 0 });
  }

  console.log(`scheduled-subscriptions: found ${snapshot.size} expired subscription(s).`);

  const results = { processed: 0, failed: 0 };

  /* ── Process each expired user ── */
  for (const docSnap of snapshot.docs) {
    const uid  = docSnap.id;
    const user = docSnap.data();

    try {
      /* 1. Update Firestore */
      await db.collection('users').doc(uid).update({
        premiumStatus: 'inactive',
        plan:          'free',
        planStatus:    'inactive',
        updatedAt:     FieldValue.serverTimestamp(),
      });
      console.log(`uid ${uid} — premiumStatus set to inactive.`);

      /* 2. Push notification */
      await callFunction('send-push-notification', {
        userUid: uid,
        title:   'Subscription Ended',
        body:    'Your Kreddlo Pro plan has ended. Renew anytime from your settings.',
        url:     `${(process.env.PLATFORM_URL || 'https://kreddlo.space').replace(/\/$/, '')}/dashboard-settings.html`,
      });

      /* 3. Email */
      if (user.email) {
        await callFunction('send-email', {
          to:   user.email,
          type: 'premium-expired',
          data: { name: user.name || 'there' },
        });
      }

      results.processed++;

    } catch (err) {
      console.error(`Failed to process uid ${uid}:`, err.message);
      results.failed++;
    }
  }

  console.log(`scheduled-subscriptions: complete — processed: ${results.processed}, failed: ${results.failed}`);

  /* ════════════════════════════════════════════════════════════
     AUTO-APPROVE STALE DELIVERIES
     Query projects where status == 'delivered' and
     deliveredAt is more than 72 hours ago, then call
     approve-delivery for each one.
  ════════════════════════════════════════════════════════════ */

  const cutoff72h = new Date(now.getTime() - 72 * 60 * 60 * 1000);

  let deliverySnapshot;
  try {
    deliverySnapshot = await db.collection('projects')
      .where('status',      '==', 'delivered')
      .where('deliveredAt', '<=', cutoff72h)
      .get();
  } catch (err) {
    // If this is a missing index error, Firebase will print a link in the logs to create it automatically.
    // See FIRESTORE_INDEXES.md at the project root for manual setup instructions.
    console.error('scheduled-subscriptions: delivery query failed (may need composite index on projects.status + projects.deliveredAt — check logs for a Firebase auto-create link):', err.message);
    // Non-fatal — return subscription results already collected above
    return respond(200, results);
  }

  if (deliverySnapshot.empty) {
    console.log('scheduled-subscriptions: no stale deliveries found.');
  } else {
    console.log(`scheduled-subscriptions: found ${deliverySnapshot.size} stale delivery/deliveries to auto-approve.`);

    const deliveryResults = { processed: 0, failed: 0 };

    for (const docSnap of deliverySnapshot.docs) {
      const projectId = docSnap.id;
      const project   = docSnap.data();
      const buyerUid  = project.buyerUid || null;

      if (!buyerUid) {
        console.warn(`scheduled-subscriptions: project ${projectId} has no buyerUid — skipping auto-approve.`);
        deliveryResults.failed++;
        continue;
      }

      try {
        await callFunction('approve-delivery', { projectId, buyerUid });
        console.log(`scheduled-subscriptions: auto-approved project ${projectId}.`);
        deliveryResults.processed++;
      } catch (err) {
        console.error(`scheduled-subscriptions: failed to auto-approve project ${projectId}:`, err.message);
        deliveryResults.failed++;
      }
    }

    console.log(`scheduled-subscriptions: auto-approve complete — processed: ${deliveryResults.processed}, failed: ${deliveryResults.failed}`);

    results.autoApproveProcessed = deliveryResults.processed;
    results.autoApproveFailed    = deliveryResults.failed;
  }

  return respond(200, results);
};

/* ── Utility ── */
function respond(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
