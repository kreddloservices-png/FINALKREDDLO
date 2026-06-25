/**
 * Netlify Function: flutterwave-webhook.js
 * Path: netlify/functions/flutterwave-webhook.js
 *
 * Receives POST requests from Flutterwave when payment events occur.
 * Verifies the webhook signature, then on charge.completed (successful)
 * marks the Firestore project/product-order/invoice-order as funded/paid
 * and notifies both parties.
 *
 * Flow:
 *  1. Accept POST only
 *  2. Get raw body as UTF-8 string
 *  3. Verify Flutterwave webhook signature (SHA-256 HMAC, timing-safe)
 *  4. Parse the verified event
 *  5. Only act on charge.completed with status=successful — all others return 200
 *  6. Verify the transaction with Flutterwave's verify endpoint (double-check)
 *  7. Route: pro_upgrade → project → product-order → invoice-order
 *  8. Update Firestore, credit affiliates, trigger delivery, notify parties
 *
 * Environment variables required:
 *   FLW_SECRET_KEY           — Flutterwave secret key (FLWSECK_TEST-... or FLWSECK-...)
 *   FLW_WEBHOOK_HASH         — Flutterwave webhook secret hash (set in FLW dashboard)
 *   FIREBASE_SERVICE_ACCOUNT — full service account JSON as one-line string
 *   PLATFORM_URL             — live domain, e.g. https://kreddlo.space
 *
 * Flutterwave signs all webhook payloads by sending the webhook hash in the
 * verif-hash header. We compare it against FLW_WEBHOOK_HASH.
 * For extra security we also re-verify the transaction via the Flutterwave
 * GET /v3/transactions/:id/verify endpoint before writing to Firestore.
 * Docs: https://developer.flutterwave.com/docs/integration-guides/webhooks/
 */

const crypto                           = require('crypto');
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue }     = require('firebase-admin/firestore');
const { getSettings }                  = require('./get-settings');

/* ── Flutterwave verify endpoint ── */
const FLW_VERIFY_URL = (txId) => `https://api.flutterwave.com/v3/transactions/${txId}/verify`;

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

/* ── Internal function caller (function-to-function via HTTPS) ── */
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
        'Content-Type':     'application/json',
        'x-internal-secret': process.env.INTERNAL_FUNCTION_SECRET || '',
      },
      body:    JSON.stringify(payload),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.warn(`${functionName} returned ${res.status}: ${errText}`);
    }
  } catch (err) {
    // Non-fatal — Firestore is already updated at this point
    console.error(`Failed to call ${functionName}:`, err.message);
  }
}

/* ── Internal function caller WITH RETRY — used for deliver-product ──
   deliver-product.js is what credits the seller's balance, increments
   salesCount, and sends the "You made a sale!" notification. A single
   transient failure (cold start, brief network blip, momentary timeout)
   used to mean that work never ran and never got retried — the order
   stayed marked paid in Firestore, so nothing would ever re-trigger
   delivery. This wrapper retries up to 3 times with a short backoff
   before giving up, and returns whether it ultimately succeeded so the
   caller can record that fact instead of assuming success. ── */
async function callFunctionWithRetry(functionName, payload, maxAttempts = 3) {
  const platformUrl = (process.env.PLATFORM_URL || 'https://kreddlo.space').replace(/\/$/, '');
  if (!platformUrl) {
    console.warn(`PLATFORM_URL not set — cannot call ${functionName}.`);
    return { success: false, reason: 'PLATFORM_URL not set' };
  }

  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(`${platformUrl}/.netlify/functions/${functionName}`, {
        method:  'POST',
        headers: {
          'Content-Type':     'application/json',
          'x-internal-secret': process.env.INTERNAL_FUNCTION_SECRET || '',
        },
        body:    JSON.stringify(payload),
      });

      if (res.ok) {
        return { success: true };
      }

      const errText = await res.text();
      lastError = `HTTP ${res.status}: ${errText}`;
      console.warn(`${functionName} attempt ${attempt}/${maxAttempts} returned ${res.status}: ${errText}`);
    } catch (err) {
      lastError = err.message;
      console.warn(`${functionName} attempt ${attempt}/${maxAttempts} network error: ${err.message}`);
    }

    if (attempt < maxAttempts) {
      const backoffMs = 500 * attempt; // 500ms, 1000ms
      await new Promise(resolve => setTimeout(resolve, backoffMs));
    }
  }

  console.error(`${functionName} failed after ${maxAttempts} attempts — last error: ${lastError}`);
  return { success: false, reason: lastError };
}

/* ══════════════════════════════════════════════════════════════
   FLUTTERWAVE WEBHOOK SIGNATURE VERIFICATION
   Flutterwave sends the webhook secret hash you configured in the
   dashboard in the "verif-hash" header on every webhook call.
   We compare it (timing-safe) against FLW_WEBHOOK_HASH.
   Docs: https://developer.flutterwave.com/docs/integration-guides/webhooks/
══════════════════════════════════════════════════════════════ */
function verifyFlutterwaveSignature(sigHeader, webhookHash) {
  if (!sigHeader || !webhookHash) {
    return { valid: false, reason: 'Missing verif-hash header or FLW_WEBHOOK_HASH env var.' };
  }

  try {
    const receivedBuf = Buffer.from(sigHeader, 'utf8');
    const expectedBuf = Buffer.from(webhookHash, 'utf8');

    if (
      receivedBuf.length === expectedBuf.length &&
      crypto.timingSafeEqual(receivedBuf, expectedBuf)
    ) {
      return { valid: true };
    }
  } catch {
    return { valid: false, reason: 'timingSafeEqual comparison failed.' };
  }

  return { valid: false, reason: 'Signature mismatch.' };
}

/* ══════════════════════════════════════════════════════════════
   FLUTTERWAVE TRANSACTION VERIFICATION
   After the webhook passes the hash check, we re-verify the
   transaction via GET /v3/transactions/:id/verify to confirm
   the amount, currency and status are genuine.
   This prevents replay attacks where a fraudster sends a webhook
   body from a cheap transaction to unlock an expensive order.
══════════════════════════════════════════════════════════════ */
async function verifyFlutterwaveTransaction(txId, flwKey) {
  const res = await fetch(FLW_VERIFY_URL(txId), {
    method:  'GET',
    headers: {
      'Authorization': `Bearer ${flwKey}`,
      'Content-Type':  'application/json',
    },
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok || data.status !== 'success') {
    throw new Error(data.message || `Flutterwave verify returned status ${res.status}`);
  }

  return data.data; // verified transaction object
}

/* ══════════════════════════════════════════════════════════════
   HANDLER
══════════════════════════════════════════════════════════════ */
exports.handler = async (event) => {

  /* ── 1. Accept POST only ── */
  if (event.httpMethod !== 'POST') {
    return respond(405, { error: 'Method not allowed.' });
  }

  /* ── 2. Get raw body as UTF-8 string ── */
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : (event.body || '');

  /* ── 3. Verify Flutterwave webhook signature ── */
  const webhookHash = process.env.FLW_WEBHOOK_HASH;
  if (!webhookHash) {
    console.error('FLW_WEBHOOK_HASH environment variable is not set.');
    return respond(500, { error: 'Webhook not configured.' });
  }

  const sigHeader = (
    event.headers['verif-hash'] ||
    event.headers['Verif-Hash'] ||
    ''
  );

  const { valid, reason } = verifyFlutterwaveSignature(sigHeader, webhookHash);

  if (!valid) {
    console.warn(`Flutterwave webhook signature verification failed: ${reason}`);
    return respond(401, { error: 'Invalid webhook signature.' });
  }

  /* ── 4. Parse the verified event ── */
  let flwEvent;
  try {
    flwEvent = JSON.parse(rawBody);
  } catch {
    return respond(400, { error: 'Invalid JSON in webhook body.' });
  }

  const eventType = flwEvent.event || '';
  console.log(`Flutterwave webhook received — event: ${eventType}`);

  /* ── 5. Only act on charge.completed — acknowledge everything else ── */
  if (eventType !== 'charge.completed') {
    console.log(`Flutterwave event "${eventType}" is not handled. Acknowledged.`);
    return respond(200, { received: true });
  }

  /* ── 6. Extract data from the charge.completed event ── */
  const eventData = flwEvent.data || {};

  /*
   * Flutterwave sends the tx_ref we generated in create-flutterwave-payment.js
   * Format: kreddlo-<orderId>-<timestamp>
   * We extract orderId from it.
   */
  const txRef    = eventData?.tx_ref    || null;
  const flwTxId  = eventData?.id        || null;
  const status   = eventData?.status    || null;

  /* Only process successful charges */
  if (status !== 'successful') {
    console.log(`Flutterwave charge.completed with status="${status}" — not successful. Acknowledged.`);
    return respond(200, { received: true });
  }

  if (!txRef) {
    console.error('charge.completed event missing tx_ref. Cannot update Firestore.', eventData);
    return respond(200, { received: true, warning: 'Missing tx_ref in event data.' });
  }

  if (!flwTxId) {
    console.error('charge.completed event missing transaction id. Cannot verify.', eventData);
    return respond(200, { received: true, warning: 'Missing transaction id in event data.' });
  }

  /*
   * Extract orderId from tx_ref.
   * tx_ref format: kreddlo-<orderId>-<timestamp>
   * Split on '-' and take everything between the first and last segments.
   */
  const txRefParts = txRef.split('-');
  // txRefParts[0] = 'kreddlo', txRefParts[last] = timestamp, middle = orderId
  const orderId = txRefParts.length >= 3
    ? txRefParts.slice(1, -1).join('-')
    : null;

  if (!orderId) {
    console.error(`Could not extract orderId from tx_ref="${txRef}". Cannot update Firestore.`);
    return respond(200, { received: true, warning: 'Could not parse orderId from tx_ref.' });
  }

  /* ── 7. Init Firestore ── */
  let db;
  try {
    db = getDb();
  } catch (err) {
    console.error('Firebase Admin init failed:', err.message);
    return respond(500, { error: 'Database not available.' });
  }

  /* ── 8. Re-verify the transaction with Flutterwave ── */
  const flwKey = process.env.FLW_SECRET_KEY;
  if (!flwKey) {
    console.error('FLW_SECRET_KEY environment variable is not set.');
    return respond(500, { error: 'Flutterwave not configured.' });
  }

  let verifiedTx;
  try {
    verifiedTx = await verifyFlutterwaveTransaction(flwTxId, flwKey);
  } catch (err) {
    console.error(`Flutterwave transaction verification failed for tx ${flwTxId}:`, err.message);
    // Return 500 so Flutterwave retries the webhook
    return respond(500, { error: 'Could not verify transaction with Flutterwave.' });
  }

  /* Confirm the verified transaction is also successful */
  if (verifiedTx.status !== 'successful') {
    console.warn(`Verified transaction ${flwTxId} status is "${verifiedTx.status}", not successful. Ignoring.`);
    return respond(200, { received: true, warning: 'Transaction not confirmed as successful by verify endpoint.' });
  }

  /*
   * Flutterwave returns amount in the base currency unit (no smallest-unit conversion).
   * e.g. 250.00 NGN is exactly 250.00 — unlike Paystack which returns 25000 (kobo).
   */
  const confirmedAmount   = Number(verifiedTx.amount)   || 0;
  const confirmedCurrency = (verifiedTx.currency || 'NGN').toUpperCase();
  const customerEmail     = verifiedTx.customer?.email  || null;
  const reference         = verifiedTx.flw_ref          || txRef;

  console.log(
    `Processing charge.completed — orderId: ${orderId}, txId: ${flwTxId}, amount: ${confirmedAmount} ${confirmedCurrency}`
  );

  /* ── 9. Route: Pro upgrade ── */
  const paymentPurpose = verifiedTx.meta?.payment_purpose || eventData?.meta?.payment_purpose || null;
  if (paymentPurpose === 'pro_upgrade') {
    const upgradeUid    = verifiedTx.meta?.uid            || null;
    const upgradePeriod = verifiedTx.meta?.billingPeriod  || 'monthly';
    const upgradeSubId  = verifiedTx.meta?.subscriptionId || orderId;
    await handleProUpgrade({
      db,
      uid:            upgradeUid,
      billingPeriod:  upgradePeriod,
      subscriptionId: upgradeSubId,
      gateway:        'flutterwave',
      amount:         confirmedAmount,
      customerEmail,
    });
    return respond(200, { received: true });
  }

  /* ── 10. Route: try projects first, then product-orders, then invoice-orders ── */
  const projectRef  = db.collection('projects').doc(orderId);
  let   projectSnap;

  try {
    projectSnap = await projectRef.get();
  } catch (err) {
    console.error(`Firestore read failed for project ${orderId}:`, err.message);
    return respond(500, { error: 'Database read failed.' });
  }

  /* ── 10a. Product-order path ── */
  if (!projectSnap.exists) {
    const orderRef  = db.collection('product-orders').doc(orderId);
    let   orderSnap;
    try {
      orderSnap = await orderRef.get();
    } catch (err) {
      console.error(`Firestore read failed for product-order ${orderId}:`, err.message);
      return respond(500, { error: 'Database read failed.' });
    }

    if (!orderSnap.exists) {
      /* ── 10b. Invoice-order path ── */
      const invOrderRef  = db.collection('invoice-orders').doc(orderId);
      let   invOrderSnap;
      try {
        invOrderSnap = await invOrderRef.get();
      } catch (err) {
        console.error(`Firestore read failed for invoice-order ${orderId}:`, err.message);
        return respond(500, { error: 'Database read failed.' });
      }

      if (!invOrderSnap.exists) {
        console.error(`Order "${orderId}" not found in projects, product-orders, or invoice-orders.`);
        return respond(200, { received: true, warning: `Order ${orderId} not found.` });
      }

      await handleInvoiceOrderPaid({
        db,
        orderId,
        invOrderRef,
        invOrderSnap,
        confirmedAmount,
        confirmedCurrency,
        sessionId:      null,
        paymentMethod:  'flutterwave',
        flwRef:         reference,
      });
      return respond(200, { received: true });
    }

    /* Fetch platform settings to calculate fees (outside transaction — no HTTP calls inside tx) */
    let productOrderSettings;
    try {
      productOrderSettings = await getSettings(db);
    } catch (err) {
      console.warn('[flutterwave-webhook] Could not fetch settings for product order, using defaults:', err.message);
      productOrderSettings = { platformFeePercent: 2.5 };
    }

    // Fix D-2 — originalAmount (saved by create-product-order.js at order
    // creation) is the seller's listed price and is ALREADY fee-free —
    // the platform fee was collected up front via the buyer's grossed-up
    // charge (see create-product-order.js's "Add platform fee on top of
    // product price" block). sellerAmount must equal originalAmount
    // directly. platformFee here is a record/display figure only,
    // reconstructed in the same currency as originalAmount by inverting
    // the exact markup formula used at order creation, avoiding any FX
    // mismatch with confirmedAmount (which can be in a different currency
    // when Flutterwave had to convert). Falls back to confirmedAmount only
    // for orders predating the originalAmount field — unchanged legacy
    // behavior for those already-historical, already-paid orders.
    const productOrderData    = orderSnap.data();
    const productFeePercent   = productOrderSettings.platformFeePercent;

    let productSellerAmount, productPlatformFee;
    if (typeof productOrderData.originalAmount === 'number' && productOrderData.originalAmount > 0) {
      productSellerAmount = productOrderData.originalAmount;
      const reconstructedChargeAmount = +(productSellerAmount / (1 - productFeePercent / 100)).toFixed(2);
      productPlatformFee  = +(reconstructedChargeAmount - productSellerAmount).toFixed(2);
    } else {
      const productBaseAmount = Number(confirmedAmount || 0);
      productPlatformFee  = +(productBaseAmount * (productFeePercent / 100)).toFixed(2);
      productSellerAmount = +(productBaseAmount - productPlatformFee).toFixed(2);
    }

    // Atomic idempotency: read-check-write inside a transaction so concurrent
    // duplicate webhooks cannot both see paymentStatus !== 'paid' and both write.
    let productAlreadyPaid = false;
    let productOrderDataForDownstream = null;

    try {
      await db.runTransaction(async (tx) => {
        const freshSnap = await tx.get(orderRef);
        if (!freshSnap.exists) throw new Error(`Product order ${orderId} not found inside transaction.`);
        const freshData = freshSnap.data();

        if (freshData.paymentStatus === 'paid') {
          productAlreadyPaid = true;
          return;
        }

        tx.update(orderRef, {
          paymentStatus:          'paid',
          paymentMethod:          'flutterwave',
          flutterwaveReference:   reference,
          flutterwaveTxId:        flwTxId,
          amount:                 confirmedAmount,
          currency:               confirmedCurrency,
          amountUsd:              confirmedCurrency === 'USD' ? confirmedAmount : null,
          platformFee:            productPlatformFee,
          sellerAmount:           productSellerAmount,
          paymentConfirmedAt:     FieldValue.serverTimestamp(),
          updatedAt:              FieldValue.serverTimestamp(),
        });

        productOrderDataForDownstream = { ...freshData, sellerAmount: productSellerAmount };
      });
    } catch (err) {
      console.error(`Transaction failed for product-order ${orderId}:`, err.message);
      return respond(500, { error: 'Failed to update product order status.' });
    }

    if (productAlreadyPaid) {
      console.log(`Product order ${orderId} already paid. Skipping duplicate webhook.`);
      return respond(200, { received: true });
    }

    console.log(`Product order ${orderId} marked as paid. Amount: ${confirmedAmount} ${confirmedCurrency}, sellerAmount: ${productSellerAmount}`);

    // Use the order data captured inside the transaction for downstream calls
    const order = productOrderDataForDownstream;

    /* Credit affiliate commission if this order was referred */
    const { finalSellerAmount } = await creditAffiliateCommission({
      db,
      order,
      orderId,
      sellerAmount:      productSellerAmount,
      confirmedAmount,
      confirmedCurrency,
      amountUsd:         confirmedCurrency === 'USD' ? confirmedAmount : null,
      gateway:           'flutterwave',
    });

    /* Trigger delivery with the final seller amount (after any affiliate deduction).
       Uses the retrying caller because this single call is what credits the
       seller's balance, increments salesCount, and sends their sale notification —
       a transient failure here used to mean none of that ever happened, with no
       record that anything was missed. */
    const deliveryDispatch = await callFunctionWithRetry('deliver-product', { orderId, sellerAmount: finalSellerAmount });
    if (!deliveryDispatch.success) {
      // Mark the order so it's visible (e.g. in admin/dashboard tooling) that
      // delivery still needs to happen, instead of leaving deliveryStatus
      // stuck at 'pending' with no trace of the failed attempt.
      try {
        await orderRef.update({
          deliveryDispatchFailed: true,
          deliveryDispatchError:  deliveryDispatch.reason || 'unknown error',
          deliveryDispatchFailedAt: FieldValue.serverTimestamp(),
        });
      } catch (markErr) {
        console.error(`Could not flag delivery dispatch failure for order ${orderId}:`, markErr.message);
      }
    }

    /* Fire Facebook pixel if product has a pixelId configured */
    try {
      const productSnap = await db.collection('products').doc(order.productId).get();
      const fbPixelId = productSnap.exists && productSnap.data().integrations && productSnap.data().integrations.facebookPixelId;
      if (fbPixelId) {
        await callFunction('pixel-event', {
          pixelId:   fbPixelId,
          eventName: 'Purchase',
          value:     confirmedAmount,
          currency:  confirmedCurrency,
          email:     order.buyerEmail || customerEmail || '',
          orderId,
        });
      }
    } catch (err) {
      console.warn(`Could not fire pixel for product-order ${orderId}:`, err.message);
    }

    console.log(`Flutterwave product order ${orderId} handled successfully.`);
    return respond(200, { received: true });
  }

  /* ── 10c. Project path ── */

  /* Fetch platform fee settings outside the transaction — no HTTP calls inside tx */
  let settings;
  try {
    settings = await getSettings(db);
  } catch (err) {
    console.warn('[flutterwave-webhook] Could not fetch settings, using defaults:', err.message);
    settings = { platformFeePercent: 2.5, projectProtectionPercent: 1.0 };
  }

  /*
   * Fix D-3 (FLW projects) — use the pre-buffer USD budget as the fee base,
   * not confirmedAmount. confirmedAmount from Flutterwave is in the local
   * currency the buyer was charged in (e.g. NGN when create-flutterwave-payment.js
   * converted a USD project to NGN at checkout). Using NGN confirmedAmount as the
   * fee base produces a fee and netAmount denominated in NGN — but approve-delivery.js
   * reads project.netAmount and project.currency to credit the freelancer's balance,
   * so the freelancer would be credited in NGN instead of USD, receiving far more
   * (in raw number terms) than the project was ever priced at.
   *
   * The correct base is the original USD project budget (set at project creation
   * time, before any FX conversion). Stripe-webhook.js already does this via
   * project.originalAmount (saved by create-stripe-payment.js). For FLW, the
   * equivalent pre-buffer USD amount is project.budget (always USD, set by
   * create-project.js). Falls back to confirmedAmount for any project where
   * budget is absent — unchanged legacy behavior for those older records.
   *
   * The netAmount and currency written below will be in USD (matching budget),
   * and the webhook also sets project.currency = 'USD' when budget is used,
   * so approve-delivery.js correctly credits the freelancer in USD.
   */
  const projectData      = projectSnap.data();
  const useOriginalBudget = typeof projectData.budget === 'number' && projectData.budget > 0;
  const baseAmount       = useOriginalBudget ? projectData.budget : Number(confirmedAmount || 0);
  const baseCurrency     = useOriginalBudget ? (projectData.currency || 'USD').toUpperCase() : confirmedCurrency;
  const platformFeeAmt   = +(baseAmount * (settings.platformFeePercent / 100)).toFixed(2);
  // Project Protection is an optional buyer add-on (see pricing.html) — only
  // deduct it if the buyer actually opted in when the project was created.
  const protectionOptedIn = projectData.withProtection === true;
  const protectionFeeAmt  = protectionOptedIn
    ? +(baseAmount * (settings.projectProtectionPercent / 100)).toFixed(2)
    : 0;
  const netAmount        = +(baseAmount - platformFeeAmt - protectionFeeAmt).toFixed(2);

  // Atomic idempotency: read-check-write inside a transaction so concurrent
  // duplicate webhooks cannot both see escrowStatus !== 'funded' and both write.
  let projectAlreadyFunded = false;
  let projectDataForDownstream = null;

  try {
    await db.runTransaction(async (tx) => {
      const freshSnap = await tx.get(projectRef);
      if (!freshSnap.exists) throw new Error(`Project ${orderId} not found inside transaction.`);
      const freshData = freshSnap.data();

      if (freshData.escrowStatus === 'funded') {
        projectAlreadyFunded = true;
        return;
      }

      tx.update(projectRef, {
        escrowStatus:           'funded',
        status:                 'in_progress',
        paymentMethod:          'flutterwave',
        flutterwaveReference:   reference,
        flutterwaveTxId:        flwTxId,
        paymentStatus:          'paid',
        // currency/netAmount are in the project's original pricing currency (USD
        // when budget was used as base). approve-delivery.js reads these to credit
        // the freelancer, so they must match the currency the project was priced in.
        currency:               baseCurrency,
        platformFee:            platformFeeAmt,
        protectionFee:          protectionFeeAmt,
        netAmount:              netAmount,
        // chargedAmount/chargedCurrency record what Flutterwave actually collected
        // from the buyer — may differ from currency/netAmount when a USD project
        // was converted to local currency at checkout (e.g. NGN). Kept for auditing
        // and admin display; not used for balance crediting.
        chargedAmount:          confirmedAmount,
        chargedCurrency:        confirmedCurrency,
        paymentConfirmedAt:     FieldValue.serverTimestamp(),
        updatedAt:              FieldValue.serverTimestamp(),
      });

      projectDataForDownstream = freshData;
    });
  } catch (err) {
    console.error(`Transaction failed for project ${orderId}:`, err.message);
    return respond(500, { error: 'Failed to update project status.' });
  }

  if (projectAlreadyFunded) {
    console.log(`Project ${orderId} is already funded. Skipping duplicate webhook.`);
    return respond(200, { received: true });
  }

  console.log(`Project ${orderId} updated — escrowStatus: funded, status: in_progress.`);

  const project = projectDataForDownstream;

  /* ── 12. Fetch freelancer and buyer details ── */
  const freelancerUid = project.freelancerUid || null;
  const buyerUid      = project.buyerUid      || null;
  const projectTitle  = project.projectTitle  || 'Your project';

  let freelancerEmail = null;
  let freelancerName  = 'Freelancer';
  let buyerName       = 'Client';
  let buyerEmail      = null;

  try {
    const fetches = [];
    if (freelancerUid) fetches.push(db.collection('users').doc(freelancerUid).get());
    if (buyerUid)      fetches.push(db.collection('users').doc(buyerUid).get());

    const snaps = await Promise.all(fetches);

    if (freelancerUid && snaps[0]?.exists) {
      freelancerEmail = snaps[0].data().email || null;
      freelancerName  = snaps[0].data().name  || 'Freelancer';
    }
    if (buyerUid) {
      const bSnap = freelancerUid ? snaps[1] : snaps[0];
      if (bSnap?.exists) {
        buyerName  = bSnap.data().name  || 'Client';
        buyerEmail = bSnap.data().email || null;
      }
    }
  } catch (err) {
    // Non-fatal — Firestore project is already updated
    console.warn('Could not fetch user details for notifications:', err.message);
  }

  const platformUrl  = (process.env.PLATFORM_URL || 'https://kreddlo.space').replace(/\/$/, '');
  const projectUrl   = `${platformUrl}/dashboard-projects.html?projectId=${encodeURIComponent(orderId)}`;
  const buyerProjUrl = `${platformUrl}/buyer-projects.html?projectId=${encodeURIComponent(orderId)}`;
  const amountFormatted = confirmedAmount
    ? new Intl.NumberFormat('en', { style: 'currency', currency: confirmedCurrency }).format(confirmedAmount)
    : 'the agreed amount';

  /* ── 13. Notify the freelancer: payment received (push + email always) ── */
  if (freelancerUid || freelancerEmail) {
    await callFunction('send-smart-notification', {
      userUid:    freelancerUid  || null,
      to:         freelancerEmail || null,
      title:      'Payment Received',
      body:       `Payment has been placed in escrow for "${projectTitle}". You can begin work.`,
      url:        projectUrl,
      templateId: 'payment-received',
      emailMode:  'always',
      emailData: {
        name:         freelancerName,
        buyerName,
        projectTitle,
        amount:       amountFormatted,
        dashboardUrl: projectUrl,
      },
    });
  } else {
    console.warn(`No freelancer uid or email found for project ${orderId}. Notification not sent.`);
  }

  /* ── 14. Notify the buyer: payment confirmed, project started ── */
  if (buyerUid || buyerEmail) {
    await callFunction('send-smart-notification', {
      userUid:    buyerUid    || null,
      title:      'Payment Confirmed',
      body:       `Your payment of ${amountFormatted} for "${projectTitle}" is secured in escrow. Work has begun.`,
      url:        buyerProjUrl,
      templateId: 'payment-confirmed-buyer',
      emailMode:  buyerEmail ? 'always' : 'never',
      emailData: {
        name:         buyerName,
        freelancerName,
        projectTitle,
        amount:       amountFormatted,
        dashboardUrl: buyerProjUrl,
      },
    });
  } else {
    console.warn(`No buyer uid or email found for project ${orderId}. Buyer notification not sent.`);
  }

  console.log(`Flutterwave charge.completed handled successfully for project ${orderId}.`);
  return respond(200, { received: true });
};

/* ══════════════════════════════════════════════════════════════
   AFFILIATE COMMISSION CREDITING
   Called from the product-order path after the order is marked paid.
   Mirrors the same logic in stripe-webhook.js.
   Always non-fatal — never blocks order delivery.
══════════════════════════════════════════════════════════════ */
async function creditAffiliateCommission({ db, order, orderId, sellerAmount, confirmedAmount, confirmedCurrency, amountUsd, gateway }) {
  const affiliateRef = order.affiliateRef || null;

  if (!affiliateRef) {
    return { finalSellerAmount: sellerAmount };
  }

  try {
    const affiliateUserSnap = await db.collection('users').doc(affiliateRef).get();
    if (!affiliateUserSnap.exists) {
      console.warn(`[affiliate] Referring user "${affiliateRef}" not found — skipping commission for order ${orderId}.`);
      return { finalSellerAmount: sellerAmount };
    }

    const affiliateUser = affiliateUserSnap.data();
    if (affiliateUser.affiliateEnabled !== true) {
      console.warn(`[affiliate] Referring user "${affiliateRef}" has not opted in — skipping commission for order ${orderId}.`);
      return { finalSellerAmount: sellerAmount };
    }

    if (affiliateRef === order.sellerUid) {
      console.warn(`[affiliate] Self-referral detected for order ${orderId}. Skipping.`);
      return { finalSellerAmount: sellerAmount };
    }

    let commissionPercent = 0;
    try {
      const productSnap = await db.collection('products').doc(order.productId).get();
      if (productSnap.exists) {
        const productData = productSnap.data();
        if (productData.affiliateEnabled !== true) {
          console.log(`[affiliate] Product "${order.productId}" does not have affiliateEnabled — skipping for order ${orderId}.`);
          return { finalSellerAmount: sellerAmount };
        }
        commissionPercent = Number(productData.affiliateCommissionPercent) || 0;
      } else {
        console.warn(`[affiliate] Product "${order.productId}" not found — skipping for order ${orderId}.`);
        return { finalSellerAmount: sellerAmount };
      }
    } catch (err) {
      console.warn(`[affiliate] Could not read product doc: ${err.message} — skipping for order ${orderId}.`);
      return { finalSellerAmount: sellerAmount };
    }

    if (commissionPercent <= 0) {
      return { finalSellerAmount: sellerAmount };
    }

    const commissionAmount  = +(sellerAmount * (commissionPercent / 100)).toFixed(2);
    const finalSellerAmount = +(sellerAmount - commissionAmount).toFixed(2);

    if (commissionAmount <= 0) {
      return { finalSellerAmount: sellerAmount };
    }

    /*
     * Issue 2 fix — USD-equivalent for the blended gate field.
     *
     * affiliateBalance is used as a USD-denominated withdrawal gate. Previously
     * the raw native commissionAmount (e.g. NGN 5,000) was added directly to
     * affiliateBalance, making the field a meaningless cross-currency mix.
     *
     * Fix: derive commissionAmountUsd using the same exchange rate implied by
     * the order's amountUsd field (the USD total recorded by the gateway).
     * Formula: (commissionAmount / confirmedAmount) * amountUsd
     * This preserves the exact commission percentage in USD terms without
     * introducing any external FX API call.
     *
     * - confirmedCurrency === 'USD': no conversion needed; use commissionAmount directly.
     * - amountUsd available (non-USD order with stored USD total): convert proportionally.
     * - amountUsd null (no USD reference stored): fall back to raw amount. This means
     *   the gate field remains in native units for this edge-case — acceptable since
     *   the per-currency display map (affiliateBalances.X) is always accurate.
     */
    let commissionAmountUsd;
    if (confirmedCurrency === 'USD') {
      commissionAmountUsd = commissionAmount;
    } else if (amountUsd && Number(amountUsd) > 0 && Number(confirmedAmount) > 0) {
      commissionAmountUsd = +((commissionAmount / confirmedAmount) * Number(amountUsd)).toFixed(6);
    } else {
      // Fallback — no USD reference available (e.g. NGN order without stored amountUsd)
      commissionAmountUsd = commissionAmount;
    }

    const settings    = await getSettings(db);
    const holdingDays = Number(settings.affiliateHoldingDays) || 0;
    const now         = new Date();
    const clearsAt    = new Date(now.getTime() + holdingDays * 24 * 60 * 60 * 1000);
    const isCleared    = holdingDays <= 0; // 0 days = instant, same as legacy behaviour

    const affiliateUserUpdate = {
      // affiliateTotalEarned stays in native units — it's a lifetime counter, not a gate
      affiliateTotalEarned: FieldValue.increment(commissionAmount),
      updatedAt:            FieldValue.serverTimestamp(),
    };
    if (isCleared) {
      // Gate field — always USD-equivalent so withdrawals are meaningful
      affiliateUserUpdate.affiliateBalance = FieldValue.increment(commissionAmountUsd);
      // Per-currency display map — always native amount for accurate display
      affiliateUserUpdate[`affiliateBalances.${confirmedCurrency}`] = FieldValue.increment(commissionAmount);
    } else {
      // Pending gate field — USD-equivalent
      affiliateUserUpdate.affiliatePendingBalance = FieldValue.increment(commissionAmountUsd);
      // Per-currency pending display map — native amount
      affiliateUserUpdate[`affiliatePendingBalances.${confirmedCurrency}`] = FieldValue.increment(commissionAmount);
    }
    await db.collection('users').doc(affiliateRef).update(affiliateUserUpdate);

    await db.collection('affiliate-earnings').add({
      affiliateUid:         affiliateRef,
      sellerUid:            order.sellerUid  || null,
      buyerUid:             order.buyerUid   || null,
      orderId,
      productId:            order.productId  || null,
      commissionPercent,
      commissionAmount,
      // USD-equivalent stored so scheduled-clear-earnings can use it when
      // moving pending → cleared without re-computing the FX rate.
      commissionAmountUsd,
      currency:             confirmedCurrency,
      confirmedAmount,
      gateway,
      paymentMethod:        'fiat',
      status:               'pending',
      cleared:              isCleared,
      clearsAt:             clearsAt,
      createdAt:            FieldValue.serverTimestamp(),
    });

    // Increment the conversions counter on the affiliate-links record
    // (non-fatal — a missed count should never block commission crediting)
    if (order.productId) {
      try {
        await db.collection('affiliate-links').doc(`${affiliateRef}_${order.productId}`).set({
          affiliateUid: affiliateRef,
          productId:    order.productId,
          conversions:  FieldValue.increment(1),
          updatedAt:    FieldValue.serverTimestamp(),
        }, { merge: true });
      } catch (err) {
        console.warn(`[affiliate-links] conversions increment failed for order ${orderId}:`, err.message);
      }
    }

    await db.collection('product-orders').doc(orderId).update({
      affiliateCommissionPaid:    true,
      affiliateCommissionAmount:  commissionAmount,
      affiliateCommissionPercent: commissionPercent,
      sellerAmount:               finalSellerAmount,
    });

    console.log(`[affiliate] Commission credited — order: ${orderId}, affiliate: ${affiliateRef}, amount: ${commissionAmount} ${confirmedCurrency} (~${commissionAmountUsd} USD) (${commissionPercent}%), finalSellerAmount: ${finalSellerAmount}`);

    return { finalSellerAmount };

  } catch (err) {
    console.error(`[affiliate] Commission crediting failed for order ${orderId}:`, err.message);
    return { finalSellerAmount: sellerAmount };
  }
}

/* ══════════════════════════════════════════════════════════════
   PRO UPGRADE HANDLER
   Activates a Pro subscription when payment_purpose === 'pro_upgrade'.
══════════════════════════════════════════════════════════════ */
async function handleProUpgrade({ db, uid, billingPeriod, subscriptionId, gateway, amount, customerEmail }) {
  if (!uid) {
    console.error('[pro_upgrade] Missing uid in metadata — cannot activate Pro.');
    return;
  }

  const now       = new Date();
  const daysToAdd = billingPeriod === 'annual' ? 365 : 30;
  const endDate   = new Date(now.getTime() + daysToAdd * 24 * 60 * 60 * 1000);

  try {
    await db.collection('users').doc(uid).update({
      plan:             'pro',
      premiumStatus:    'active',
      planStatus:       'active',
      premiumStartDate: now,
      premiumEndDate:   endDate,
      updatedAt:        FieldValue.serverTimestamp(),
    });

    if (subscriptionId) {
      await db.collection('subscriptions').doc(subscriptionId).update({
        status:         'active',
        activatedAt:    now,
        premiumEndDate: endDate,
      }).catch(() => {});
    }

    console.log(`[pro_upgrade] uid: ${uid} activated Pro via ${gateway} — expires ${endDate.toISOString()}`);

    const platformUrl = (process.env.PLATFORM_URL || 'https://kreddlo.space').replace(/\/$/, '');
    if (platformUrl) {
      const userSnap = await db.collection('users').doc(uid).get().catch(() => null);
      const userData = userSnap?.exists ? userSnap.data() : {};
      const toEmail  = customerEmail || userData.email || null;
      const name     = userData.displayName || userData.name || 'Freelancer';

      if (toEmail) {
        await fetch(`${platformUrl}/.netlify/functions/send-email`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', 'x-internal-secret': process.env.INTERNAL_FUNCTION_SECRET || '' },
          body:    JSON.stringify({
            to:   toEmail,
            type: 'premium-activated',
            data: {
              name,
              plan:          'Pro',
              billingPeriod: billingPeriod === 'annual' ? 'Annual' : 'Monthly',
              endDate:       endDate.toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' }),
              dashboardUrl:  `${platformUrl}/dashboard.html`,
            },
          }),
        }).catch(e => console.warn('[pro_upgrade] send-email failed:', e.message));
      }
    }
  } catch (err) {
    console.error('[pro_upgrade] Firestore update failed:', err.message);
  }
}

/* ══════════════════════════════════════════════════════════════
   INVOICE-ORDER PAID HANDLER
   Called when a Flutterwave payment for an invoice-order completes.
   1. Idempotency guard
   2. Calculate platform fee and seller amount
   3. Mark invoice-order as paid
   4. Place parent invoice in escrow (status: 'escrow',
      escrowSellerAmount = sellerAmount written on the invoice doc;
      user doc's escrowBalance field is NOT written — funds are held
      on the invoice doc and released to balances.${currency} by
      confirm-invoice-delivery.js or scheduled-clear-earnings.js)
   5. Write escrow-holds record
   6. Notify the freelancer (push + email)
══════════════════════════════════════════════════════════════ */
async function handleInvoiceOrderPaid({ db, orderId, invOrderRef, invOrderSnap, confirmedAmount, confirmedCurrency, sessionId, paymentMethod, flwRef }) {
  const invOrder = invOrderSnap.data();

  if (invOrder.paymentStatus === 'paid') {
    console.log(`Invoice order ${orderId} already paid. Skipping duplicate webhook.`);
    return;
  }

  let invSettings;
  try {
    invSettings = await getSettings(db);
  } catch (err) {
    console.warn('[invoice-webhook] Could not fetch settings, using defaults:', err.message);
    invSettings = { platformFeePercent: 2.5 };
  }

  // Fix D-2 — originalAmount (saved by create-invoice-order.js at order
  // creation) is the invoice total the seller issued, in the currency
  // they issued it in — it is ALREADY fee-free. create-invoice-order.js's
  // own comment confirms the intent: "seller credit is always calculated
  // from [originalAmount], so this conversion never inflates seller pay."
  // The previous code instead used confirmedAmount directly, which after
  // a Flutterwave USD→local-currency conversion is in the WRONG currency
  // for a USD-issued invoice, and also re-deducted the fee a second time
  // when no conversion happened. sellerAmount must equal originalAmount
  // directly, in the seller's issuing currency. platformFee is a
  // record/display figure only, reconstructed by inverting the exact
  // markup formula create-invoice-order.js used. Falls back to
  // confirmedAmount only for orders predating the originalAmount field.
  const invoiceFeePercent = invSettings.platformFeePercent;

  let sellerAmount, platformFee;
  if (typeof invOrder.originalAmount === 'number' && invOrder.originalAmount > 0) {
    sellerAmount = invOrder.originalAmount;
    const reconstructedChargeAmount = +(sellerAmount / (1 - invoiceFeePercent / 100)).toFixed(2);
    platformFee  = +(reconstructedChargeAmount - sellerAmount).toFixed(2);
  } else {
    platformFee  = +(confirmedAmount * (invoiceFeePercent / 100)).toFixed(2);
    sellerAmount = +(confirmedAmount - platformFee).toFixed(2);
  }

  const orderUpdate = {
    paymentStatus:          'paid',
    paymentMethod,
    amount:                 confirmedAmount,
    currency:               confirmedCurrency,
    // chargedAmount/chargedCurrency record exactly what Flutterwave charged —
    // same shape as the chargedAmount/chargedCurrency fields the Stripe webhook
    // writes for invoice-orders (and product-orders/projects). Flutterwave
    // never converts currencies, so these always equal amount/currency above —
    // kept here purely so the Firestore schema (and any code reading
    // chargedCurrency) is consistent regardless of which gateway was used.
    chargedAmount:           confirmedAmount,
    chargedCurrency:         confirmedCurrency,
    amountUsd:              confirmedCurrency === 'USD' ? confirmedAmount : null,
    platformFee,
    sellerAmount,
    paymentConfirmedAt:     FieldValue.serverTimestamp(),
    updatedAt:              FieldValue.serverTimestamp(),
  };
  if (sessionId) orderUpdate.stripeSessionId        = sessionId;
  if (flwRef)    orderUpdate.flutterwaveReference   = flwRef;

  try {
    await invOrderRef.update(orderUpdate);
    console.log(`Invoice order ${orderId} marked as paid. Amount: ${confirmedAmount} ${confirmedCurrency}, sellerAmount: ${sellerAmount}`);
  } catch (err) {
    console.error(`Firestore update failed for invoice-order ${orderId}:`, err.message);
    return;
  }

  const invoiceId = invOrder.invoiceId || null;
  const sellerUid = invOrder.sellerUid || null;

  const clientEmail = (invOrder.clientEmail || '').trim().toLowerCase();
  const clientName  = invOrder.clientName || invOrder.payerName || 'A client';

  /* ── Place funds in escrow ── */
  if (invoiceId) {
    try {
      const deliverByHours = Number(invSettings.invoiceDeliverByHours) || 48;
      const deliverBy = new Date(Date.now() + deliverByHours * 60 * 60 * 1000);
      await db.collection('invoices').doc(invoiceId).update({
        status:             'escrow',
        escrowHeldAt:       FieldValue.serverTimestamp(),
        escrowSellerAmount: sellerAmount,
        paidAt:             FieldValue.serverTimestamp(),
        paidOrder:          orderId,
        deliverBy:          deliverBy,
        updatedAt:          FieldValue.serverTimestamp(),
      });
      console.log(`Invoice ${invoiceId} placed in escrow.`);
    } catch (err) {
      console.error(`Could not place invoice ${invoiceId} in escrow:`, err.message);
    }
  }

  if (!sellerUid) {
    console.warn(`No sellerUid on invoice-order ${orderId} — skipping escrow credit.`);
    return;
  }

  /* ── Write escrow-holds record ── */
  try {
    await db.collection('escrow-holds').add({
      invoiceId,
      orderId,
      sellerId:   sellerUid,
      buyerEmail: clientEmail,
      amount:     sellerAmount,
      currency:   confirmedCurrency,
      status:     'held',
      createdAt:  FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.error(`Could not write escrow-holds for invoice ${invoiceId}:`, err.message);
  }

  /* ── Fetch seller details for notifications ── */
  let freelancerEmail = null;
  let freelancerName  = 'Freelancer';
  try {
    const userSnap = await db.collection('users').doc(sellerUid).get();
    if (userSnap.exists) {
      freelancerEmail = userSnap.data().email || null;
      freelancerName  = userSnap.data().name || userSnap.data().displayName || 'Freelancer';
    }
  } catch (err) {
    console.warn('[invoice-webhook] Could not fetch freelancer details:', err.message);
  }

  const platformUrl   = (process.env.PLATFORM_URL || 'https://kreddlo.space').replace(/\/$/, '');
  const invoiceAmount = new Intl.NumberFormat('en', { style: 'currency', currency: confirmedCurrency }).format(confirmedAmount);

  let invoiceNumber = '';
  if (invoiceId) {
    try {
      const invSnap = await db.collection('invoices').doc(invoiceId).get();
      if (invSnap.exists) invoiceNumber = invSnap.data().invoiceNumber || '';
    } catch (_) {}
  }

  /* ── Notify seller: payment in escrow ── */
  await callFunction('send-smart-notification', {
    userUid:    sellerUid,
    to:         freelancerEmail || null,
    title:      'Payment Held in Escrow',
    body:       `Payment received for invoice ${invoiceNumber || invoiceId}. Deliver your work and mark complete to release funds.`,
    url:        `${platformUrl}/dashboard-invoices.html`,
    templateId: 'invoice-escrow-held-seller',
    emailMode:  'always',
    emailData: {
      name:          freelancerName,
      invoiceNumber: invoiceNumber || invoiceId,
      amount:        invoiceAmount,
      dashboardUrl:  `${platformUrl}/dashboard-invoices.html`,
    },
  });

  /* ── Email buyer: payment secured in escrow ── */
  if (clientEmail) {
    await callFunction('send-email', {
      to:     clientEmail,
      toName: clientName,
      type:   'invoice-escrow-held-buyer',
      data: {
        name:           clientName,
        freelancerName,
        invoiceNumber:  invoiceNumber || invoiceId,
        amount:         invoiceAmount,
      },
    });
  }

  console.log(`Invoice order ${orderId} handled successfully — funds in escrow for seller ${sellerUid}.`);
}

/* ── Utility: build a Netlify function response ── */
function respond(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  };
}
