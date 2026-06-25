/**
 * Netlify Function: stripe-webhook.js
 * Path: netlify/functions/stripe-webhook.js
 *
 * Receives POST requests from Stripe when payment events occur.
 * Verifies the webhook signature, then on checkout.session.completed
 * marks the Firestore project as funded and notifies the freelancer.
 *
 * Flow:
 *  1. Verify Stripe webhook signature (HMAC-SHA256, timing-safe)
 *  2. Parse the event
 *  3. Only act on checkout.session.completed — all others return 200 immediately
 *  4. Extract order_id from event metadata
 *  5. Update Firestore project document
 *  6. Fetch freelancer details
 *  7. Send push notification to freelancer
 *  8. Send payment-received email to freelancer
 *
 * Environment variables required:
 *   STRIPE_WEBHOOK_SECRET    — from Stripe Dashboard > Webhooks > signing secret
 *   FIREBASE_SERVICE_ACCOUNT — full service account JSON as one-line string
 *   PLATFORM_URL             — live domain, e.g. https://kreddlo.space
 *
 * Stripe sends the raw request body as-is for signature verification.
 * Netlify provides the raw body in event.body. isBase64Encoded must be
 * handled so we always work with a UTF-8 string for HMAC computation.
 */

const crypto                           = require('crypto');
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue }     = require('firebase-admin/firestore');
const { getSettings } = require('./get-settings');

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
    // Non-fatal — Firestore is already updated
    console.error(`Failed to call ${functionName}:`, err.message);
  }
}

/* ── Internal function caller WITH RETRY — used for deliver-product ──
   deliver-product.js credits the seller's balance, increments salesCount,
   and sends their sale notification. A single transient failure used to
   mean that work never ran and never got retried, with the order stuck
   showing paid but nothing credited. This retries up to 3 times with a
   short backoff and reports whether it ultimately succeeded. ── */
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
      const backoffMs = 500 * attempt;
      await new Promise(resolve => setTimeout(resolve, backoffMs));
    }
  }

  console.error(`${functionName} failed after ${maxAttempts} attempts — last error: ${lastError}`);
  return { success: false, reason: lastError };
}

/* ══════════════════════════════════════════════════════════════
   STRIPE SIGNATURE VERIFICATION
   Stripe signs webhooks using HMAC-SHA256.
   Header format: t=<timestamp>,v1=<hex_signature>[,v0=<deprecated>]
   Signed payload: <timestamp> + "." + <rawBody>
   Docs: https://stripe.com/docs/webhooks/signatures
══════════════════════════════════════════════════════════════ */
function verifyStripeSignature(rawBody, sigHeader, secret) {
  if (!sigHeader || !secret) return { valid: false, reason: 'Missing signature header or secret.' };

  // Parse the header into its components
  const parts     = sigHeader.split(',');
  let timestamp   = null;
  const v1Sigs    = [];

  for (const part of parts) {
    const [key, value] = part.trim().split('=');
    if (key === 't')  timestamp = value;
    if (key === 'v1') v1Sigs.push(value);
  }

  if (!timestamp) {
    return { valid: false, reason: 'Missing timestamp in Stripe-Signature header.' };
  }
  if (v1Sigs.length === 0) {
    return { valid: false, reason: 'No v1 signature found in Stripe-Signature header.' };
  }

  // Guard against replay attacks: reject if timestamp is older than 5 minutes
  const tolerance = 300; // seconds
  const eventAge  = Math.floor(Date.now() / 1000) - parseInt(timestamp, 10);
  if (Math.abs(eventAge) > tolerance) {
    return { valid: false, reason: `Webhook timestamp is too old (${eventAge}s). Possible replay attack.` };
  }

  // Construct the signed payload string as Stripe defines it
  const signedPayload = `${timestamp}.${rawBody}`;

  // Compute the expected HMAC-SHA256
  const expectedSig = crypto
    .createHmac('sha256', secret)
    .update(signedPayload, 'utf8')
    .digest('hex');

  // Check against all v1 signatures (Stripe may send multiple during key rotation)
  for (const receivedSig of v1Sigs) {
    try {
      const receivedBuf = Buffer.from(receivedSig, 'hex');
      const expectedBuf = Buffer.from(expectedSig, 'hex');

      if (
        receivedBuf.length === expectedBuf.length &&
        crypto.timingSafeEqual(receivedBuf, expectedBuf)
      ) {
        return { valid: true };
      }
    } catch {
      // Buffer mismatch (different lengths) — continue checking other sigs
    }
  }

  return { valid: false, reason: 'Signature mismatch.' };
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

  /* ── 3. Verify Stripe webhook signature ── */
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error('STRIPE_WEBHOOK_SECRET environment variable is not set.');
    return respond(500, { error: 'Webhook not configured.' });
  }

  const sigHeader = event.headers['stripe-signature'] || event.headers['Stripe-Signature'] || '';
  const { valid, reason } = verifyStripeSignature(rawBody, sigHeader, webhookSecret);

  if (!valid) {
    console.warn(`Stripe webhook signature verification failed: ${reason}`);
    return respond(401, { error: 'Invalid webhook signature.' });
  }

  /* ── 4. Parse the verified event ── */
  let stripeEvent;
  try {
    stripeEvent = JSON.parse(rawBody);
  } catch {
    return respond(400, { error: 'Invalid JSON in webhook body.' });
  }

  const eventType = stripeEvent.type || '';
  console.log(`Stripe webhook received — type: ${eventType}, id: ${stripeEvent.id}`);

  /* ── 5. Only act on checkout.session.completed ── */
  if (eventType !== 'checkout.session.completed') {
    // Acknowledge all other event types immediately — no action needed
    console.log(`Stripe event type "${eventType}" is not handled. Acknowledged.`);
    return respond(200, { received: true });
  }

  /* ── 6. Extract data from the completed session ── */
  const session = stripeEvent.data?.object || {};

  const orderId            = session.metadata?.order_id || null;
  const sessionId          = session.id                 || null;
  const paymentStatus      = session.payment_status     || null;
  const customerEmail      = session.customer_email     || null;
  // Stripe sends amount_total in the smallest currency unit (e.g. cents for USD)
  const confirmedAmountRaw = session.amount_total       || 0;
  const confirmedCurrency  = (session.currency || 'usd').toUpperCase();
  const confirmedAmount    = confirmedAmountRaw / 100;
  // Keep amountUsd for backward-compat references below (project path uses it)
  const amountUsd          = confirmedCurrency === 'USD' ? confirmedAmount : null;

  if (!orderId) {
    console.error('checkout.session.completed event missing metadata.order_id. Cannot update Firestore.', session);
    // Still return 200 so Stripe stops retrying — we cannot recover without an order ID
    return respond(200, { received: true, warning: 'Missing order_id in metadata.' });
  }

  console.log(`Processing completed checkout — orderId: ${orderId}, sessionId: ${sessionId}, amount: ${confirmedAmount} ${confirmedCurrency}`);

  /* ── 7. Init Firestore ── */
  let db;
  try {
    db = getDb();
  } catch (err) {
    console.error('Firebase Admin init failed:', err.message);
    // Return 500 so Stripe retries this webhook later
    return respond(500, { error: 'Database not available.' });
  }

  /* ── 7b. Route: Pro upgrade ── */
  const paymentPurpose = session.metadata?.payment_purpose || null;
  if (paymentPurpose === 'pro_upgrade') {
    const upgradeUid       = session.metadata?.uid           || null;
    const upgradePeriod    = session.metadata?.billingPeriod || 'monthly';
    const upgradeSubId     = session.metadata?.subscriptionId || orderId;
    await handleProUpgrade({ db, uid: upgradeUid, billingPeriod: upgradePeriod, subscriptionId: upgradeSubId, gateway: 'stripe', amount: confirmedAmount, customerEmail });
    return respond(200, { received: true });
  }

  /* ── 8. Route: try projects first, then product-orders ── */
  const projectRef  = db.collection('projects').doc(orderId);
  let   projectSnap;

  try {
    projectSnap = await projectRef.get();
  } catch (err) {
    console.error(`Firestore read failed for project ${orderId}:`, err.message);
    return respond(500, { error: 'Database read failed.' });
  }

  /* ── 8a. Product-order path ── */
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
      // ── 8b-ii. Invoice-order path ──────────────────────────────────────────
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
        sessionId,
        paymentMethod:  'stripe',
        paystackRef:    null,
      });
      return respond(200, { received: true });
    }

    // Fetch platform settings to calculate fees (outside transaction — no HTTP calls inside tx)
    let productOrderSettings;
    try {
      productOrderSettings = await getSettings(db);
    } catch (err) {
      console.warn('[stripe-webhook] Could not fetch settings for product order, using defaults:', err.message);
      productOrderSettings = { platformFeePercent: 2.5 };
    }

    /*
     * Fix D-2 — originalAmount (saved by create-product-order.js at order
     * creation) is the seller's listed price — it is ALREADY fee-free and
     * ALREADY excludes any FX safety buffer. The platform fee was collected
     * up front by charging the buyer chargeAmount = originalAmount /
     * (1 - platformFeePercent/100) — see create-product-order.js's
     * "Add platform fee on top of product price" block.
     *
     * The previous version of this code treated originalAmount as if it
     * still had the fee baked in and deducted platformFeePercent from it
     * AGAIN, which silently took the fee twice (once via the buyer's
     * grossed-up charge, once more here) and shorted every seller by the
     * fee amount on every single sale. sellerAmount must equal
     * originalAmount directly — nothing further to deduct.
     *
     * platformFee below is kept only as a record/display figure (e.g. the
     * fee column on buyer-payments.html) — it's reconstructed as the
     * markup the buyer actually paid, in the SAME currency as
     * originalAmount, by inverting the exact markup formula
     * create-product-order.js used. This sidesteps any FX conversion
     * mismatch from confirmedAmount, which can be in a different currency
     * (e.g. USD) when Stripe had to convert an unsupported currency like NGN.
     *
     * Falls back to confirmedAmount when originalAmount is absent (orders
     * created before this field existed) — unchanged legacy behavior for
     * those already-historical, already-paid orders only.
     */
    const productOrderOriginal = orderSnap.data();
    const productFeePercent    = productOrderSettings.platformFeePercent;

    let productSellerAmount, productPlatformFee;
    if (typeof productOrderOriginal.originalAmount === 'number' && productOrderOriginal.originalAmount > 0) {
      productSellerAmount = productOrderOriginal.originalAmount;
      const reconstructedChargeAmount = +(productSellerAmount / (1 - productFeePercent / 100)).toFixed(2);
      productPlatformFee  = +(reconstructedChargeAmount - productSellerAmount).toFixed(2);
    } else {
      // Legacy fallback (pre-originalAmount orders) — unchanged from before.
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

        // NOTE: amount/currency are deliberately left untouched here — they hold
        // the seller's original listed price (e.g. NGN), set once at order
        // creation in create-product-order.js. For currencies Stripe can't charge
        // in directly (NGN/UGX/RWF/XOF/TZS), create-product-order.js converts the
        // charge to USD before sending it to Stripe; chargedAmount/chargedCurrency
        // below record that actual charged amount, instead of clobbering the
        // original price the seller and buyer saw.
        tx.update(orderRef, {
          paymentStatus:      'paid',
          paymentMethod:      'stripe',
          stripeSessionId:    sessionId,
          chargedAmount:      confirmedAmount,
          chargedCurrency:    confirmedCurrency,
          amountUsd:          confirmedCurrency === 'USD' ? confirmedAmount : null,
          platformFee:        productPlatformFee,
          sellerAmount:       productSellerAmount,
          paymentConfirmedAt: FieldValue.serverTimestamp(),
          updatedAt:          FieldValue.serverTimestamp(),
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

    console.log(`Product order ${orderId} marked as paid. Charged: ${confirmedAmount} ${confirmedCurrency}, sellerAmount: ${productSellerAmount}`);

    // Use the order data captured inside the transaction for downstream calls
    const order = productOrderDataForDownstream;

    // Credit affiliate commission if this order was referred
    const { finalSellerAmount } = await creditAffiliateCommission({
      db,
      order,
      orderId,
      sellerAmount:      productSellerAmount,
      confirmedAmount,
      confirmedCurrency,
      amountUsd:         confirmedCurrency === 'USD' ? confirmedAmount : null,
      gateway:           'stripe',
    });

    // Trigger delivery with the final seller amount (after any affiliate deduction).
    // Uses the retrying caller — this single call credits the seller's balance,
    // increments salesCount, and sends their sale notification.
    const deliveryDispatch = await callFunctionWithRetry('deliver-product', { orderId, sellerAmount: finalSellerAmount });
    if (!deliveryDispatch.success) {
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

    // Fire Facebook pixel if product has a pixelId configured
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

    console.log(`Stripe product order ${orderId} handled successfully.`);
    return respond(200, { received: true });
  }

  /* ── 8b. Project path (existing logic) ── */

  /* Fetch platform fee settings outside the transaction — no HTTP calls inside tx */
  let settings;
  try {
    settings = await getSettings(db);
  } catch (err) {
    console.warn('[stripe-webhook] Could not fetch settings, using defaults:', err.message);
    settings = { platformFeePercent: 2.5, projectProtectionPercent: 1.0 };
  }

  /*
   * Fix C-3 — use the PRE-BUFFER original price for fee/net calculation,
   * not confirmedAmount. confirmedAmount is what Stripe actually charged
   * the buyer's card — for currencies Stripe can't bill in directly
   * (NGN/UGX/RWF/XOF/TZS), create-stripe-payment.js adds platformFxBuffer
   * on top before charging (see that file's "Currency conversion" block).
   * That buffer is the PLATFORM's margin against rate drift — it must not
   * flow into the freelancer's escrow credit, or the freelancer ends up
   * paid more than the project was ever priced at, silently funded out of
   * the platform's own safety margin.
   *
   * projectSnap.data().originalAmount/originalCurrency (saved at project
   * creation, before any buffer was applied) is the correct basis whenever
   * present. Falls back to confirmedAmount for USD-priced projects or any
   * project created before this field existed — identical behavior to
   * before this fix in those cases.
   */
  const projectOriginal  = projectSnap.data();
  const baseAmount       = (typeof projectOriginal.originalAmount === 'number' && projectOriginal.originalAmount > 0)
    ? projectOriginal.originalAmount
    : Number(confirmedAmount || 0);
  const platformFeeAmt   = +(baseAmount * (settings.platformFeePercent / 100)).toFixed(2);
  // Project Protection is an optional buyer add-on (see pricing.html) — only
  // deduct it if the buyer actually opted in when the project was created.
  const protectionOptedIn = projectSnap.data().withProtection === true;
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
        escrowStatus:       'funded',
        status:             'in_progress',
        paymentMethod:      'stripe',
        stripeSessionId:    sessionId,
        paymentStatus:      paymentStatus,
        currency:           confirmedCurrency,
        // chargedAmount/chargedCurrency record exactly what Stripe charged.
        // For most projects (priced in USD) this matches currency/netAmount
        // above. For a project priced in a currency Stripe can't charge in
        // directly (NGN/UGX/RWF/XOF/TZS), create-stripe-payment.js converts
        // the charge to USD before checkout — these fields keep an explicit
        // record of that actual charged amount, same shape as the
        // chargedAmount/chargedCurrency fields on product-orders.
        chargedAmount:      confirmedAmount,
        chargedCurrency:    confirmedCurrency,
        platformFee:        platformFeeAmt,
        protectionFee:      protectionFeeAmt,
        netAmount:          netAmount,
        paymentConfirmedAt: FieldValue.serverTimestamp(),
        updatedAt:          FieldValue.serverTimestamp(),
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

  /* ── 10. Fetch freelancer and buyer details ── */
  const freelancerUid  = project.freelancerUid  || null;
  const buyerUid       = project.buyerUid       || null;
  const projectTitle   = project.projectTitle   || 'Your project';

  let freelancerEmail = null;
  let freelancerName  = 'Freelancer';
  let buyerName       = 'Client';

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
        buyerName = bSnap.data().name || 'Client';
      }
    }
  } catch (err) {
    // Non-fatal — Firestore is already updated
    console.warn('Could not fetch user details for notifications:', err.message);
  }

  const platformUrl = (process.env.PLATFORM_URL || 'https://kreddlo.space').replace(/\/$/, '');
  const projectUrl  = `${platformUrl}/dashboard-projects.html?projectId=${encodeURIComponent(orderId)}`;

  /* ── 11 + 12. Notify the freelancer: payment received (push + email always) ── */
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
        amount:       confirmedAmount ? new Intl.NumberFormat('en', { style: 'currency', currency: confirmedCurrency }).format(confirmedAmount) : 'the agreed amount',
        dashboardUrl: projectUrl,
      },
    });
  } else {
    console.warn(`No freelancer uid or email found for project ${orderId}. Notification not sent.`);
  }

  console.log(`Stripe checkout.session.completed handled successfully for project ${orderId}.`);
  return respond(200, { received: true });
};

/* ══════════════════════════════════════════════════════════════
   AFFILIATE COMMISSION CREDITING
   Called from the product-order path of each webhook after the
   order is marked paid. Handles the full attribution flow:
     1. Skip if no affiliateRef on the order (non-referred purchase)
     2. Verify the referring user has affiliateEnabled: true
     3. Read affiliateCommissionPercent from the product doc
     4. Calculate commission amount
     5. Deduct commission from seller's net payout
     6. Atomically increment affiliate's affiliateBalance in Firestore
     7. Write a pending record to affiliate-earnings collection
     8. Update the order doc with affiliate commission fields

   Returns { finalSellerAmount } — the seller amount after affiliate deduction.
   Always non-fatal: any error is logged and the original sellerAmount is returned
   so the order delivery is never blocked by affiliate logic.
══════════════════════════════════════════════════════════════ */
async function creditAffiliateCommission({ db, order, orderId, sellerAmount, confirmedAmount, confirmedCurrency, amountUsd, gateway }) {
  const affiliateRef = order.affiliateRef || null;

  // No ref on this order — nothing to do
  if (!affiliateRef) {
    return { finalSellerAmount: sellerAmount };
  }

  try {
    // 1. Verify the referring user exists and has opted in to the affiliate program
    const affiliateUserSnap = await db.collection('users').doc(affiliateRef).get();
    if (!affiliateUserSnap.exists) {
      console.warn(`[affiliate] Referring user "${affiliateRef}" not found — skipping commission for order ${orderId}.`);
      return { finalSellerAmount: sellerAmount };
    }

    const affiliateUser = affiliateUserSnap.data();
    if (affiliateUser.affiliateEnabled !== true) {
      console.warn(`[affiliate] Referring user "${affiliateRef}" has not opted into the affiliate program — skipping commission for order ${orderId}.`);
      return { finalSellerAmount: sellerAmount };
    }

    // 2. Prevent self-referral (affiliate cannot earn commission on their own product)
    if (affiliateRef === order.sellerUid) {
      console.warn(`[affiliate] Self-referral detected — affiliateRef matches sellerUid for order ${orderId}. Skipping.`);
      return { finalSellerAmount: sellerAmount };
    }

    // 3. Read commission percentage from the product doc
    let commissionPercent = 0;
    try {
      const productSnap = await db.collection('products').doc(order.productId).get();
      if (productSnap.exists) {
        const productData = productSnap.data();
        // Only credit commission if the product itself has affiliate enabled
        if (productData.affiliateEnabled !== true) {
          console.log(`[affiliate] Product "${order.productId}" does not have affiliateEnabled — skipping commission for order ${orderId}.`);
          return { finalSellerAmount: sellerAmount };
        }
        commissionPercent = Number(productData.affiliateCommissionPercent) || 0;
      } else {
        console.warn(`[affiliate] Product "${order.productId}" not found — skipping commission for order ${orderId}.`);
        return { finalSellerAmount: sellerAmount };
      }
    } catch (err) {
      console.warn(`[affiliate] Could not read product doc for commission percent: ${err.message} — skipping for order ${orderId}.`);
      return { finalSellerAmount: sellerAmount };
    }

    if (commissionPercent <= 0) {
      console.log(`[affiliate] Commission percent is 0 for product "${order.productId}" — no commission to credit for order ${orderId}.`);
      return { finalSellerAmount: sellerAmount };
    }

    // 4. Calculate commission — taken from the seller's net amount
    const commissionAmount  = +(sellerAmount * (commissionPercent / 100)).toFixed(2);
    const finalSellerAmount = +(sellerAmount - commissionAmount).toFixed(2);

    if (commissionAmount <= 0) {
      return { finalSellerAmount: sellerAmount };
    }

    /*
     * Issue 2 fix — USD-equivalent for the blended gate field.
     * See flutterwave-webhook.js creditAffiliateCommission for full comment.
     */
    let commissionAmountUsd;
    if (confirmedCurrency === 'USD') {
      commissionAmountUsd = commissionAmount;
    } else if (amountUsd && Number(amountUsd) > 0 && Number(confirmedAmount) > 0) {
      commissionAmountUsd = +((commissionAmount / confirmedAmount) * Number(amountUsd)).toFixed(6);
    } else {
      commissionAmountUsd = commissionAmount;
    }

    // 5. Atomically increment the affiliate's balance in their user doc,
    //    subject to the admin-configured affiliate holding period (Item 9).
    //    Funds are routed through the affiliate-earnings record rather than
    //    hitting affiliateBalance directly when holding days > 0, so
    //    affiliate-withdraw.js — which already gates on affiliateBalance —
    //    automatically rejects anything still inside the holding window.
    const settings    = await getSettings(db);
    const holdingDays = Number(settings.affiliateHoldingDays) || 0;
    const now         = new Date();
    const clearsAt    = new Date(now.getTime() + holdingDays * 24 * 60 * 60 * 1000);
    const isCleared    = holdingDays <= 0; // 0 days = instant, same as legacy behaviour

    const affiliateUserUpdate = {
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

    // 6. Write a record to the affiliate-earnings collection
    //    NOTE: `status` ('pending'/'paid') tracks WITHDRAWAL status (unchanged
    //    meaning). `cleared` / `clearsAt` are new fields tracking the holding
    //    period — scheduled-clear-earnings.js flips `cleared` to true once
    //    clearsAt has passed and moves the amount to affiliateBalance.
    await db.collection('affiliate-earnings').add({
      affiliateUid:         affiliateRef,
      sellerUid:            order.sellerUid      || null,
      buyerUid:             order.buyerUid       || null,
      orderId,
      productId:            order.productId      || null,
      commissionPercent,
      commissionAmount,
      commissionAmountUsd,
      currency:             confirmedCurrency,
      confirmedAmount,
      gateway,
      paymentMethod:        'fiat',
      status:               'pending',  // becomes 'paid' when affiliate withdraws
      cleared:              isCleared,
      clearsAt:             clearsAt,
      createdAt:            FieldValue.serverTimestamp(),
    });

    // 6b. Increment the conversions counter on the affiliate-links record
    //     (non-fatal — a missed count should never block commission crediting)
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

    // 7. Stamp the affiliate fields onto the order for auditability
    await db.collection('product-orders').doc(orderId).update({
      affiliateCommissionPaid:    true,
      affiliateCommissionAmount:  commissionAmount,
      affiliateCommissionPercent: commissionPercent,
      sellerAmount:               finalSellerAmount,
    });

    console.log(`[affiliate] Commission credited — order: ${orderId}, affiliate: ${affiliateRef}, amount: ${commissionAmount} ${confirmedCurrency} (~${commissionAmountUsd} USD) (${commissionPercent}%), finalSellerAmount: ${finalSellerAmount}`);

    return { finalSellerAmount };

  } catch (err) {
    // Non-fatal — never block order delivery over affiliate logic
    console.error(`[affiliate] Commission crediting failed for order ${orderId}:`, err.message);
    return { finalSellerAmount: sellerAmount };
  }
}

/* ── Pro Upgrade handler (shared logic) ── */
async function handleProUpgrade({ db, uid, billingPeriod, subscriptionId, gateway, amount, customerEmail }) {
  if (!uid) {
    console.error('[pro_upgrade] Missing uid in metadata — cannot activate Pro.');
    return;
  }

  const now         = new Date();
  const daysToAdd   = billingPeriod === 'annual' ? 365 : 30;
  const endDate     = new Date(now.getTime() + daysToAdd * 24 * 60 * 60 * 1000);

  try {
    // Activate Pro on the user document
    await db.collection('users').doc(uid).update({
      plan:             'pro',
      premiumStatus:    'active',
      planStatus:       'active',
      premiumStartDate: now,
      premiumEndDate:   endDate,
      updatedAt:        require('firebase-admin/firestore').FieldValue.serverTimestamp(),
    });

    // Mark the subscription doc as active
    if (subscriptionId) {
      await db.collection('subscriptions').doc(subscriptionId).update({
        status:    'active',
        activatedAt: now,
        premiumEndDate: endDate,
      }).catch(() => {}); // non-fatal if sub doc doesn't exist
    }

    console.log(`[pro_upgrade] uid: ${uid} activated Pro via ${gateway} — expires ${endDate.toISOString()}`);

    // Send welcome email
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
   Called when a payment for an invoice-order completes via Stripe.
   1. Idempotency guard
   2. Calculate platform fee and seller amount
   3. Mark invoice-order as paid
   4. Place parent invoice in escrow (status: 'escrow',
      escrowSellerAmount = sellerAmount written on the invoice doc)
   5. Write escrow-holds record (tracks the held amount server-side;
      the user doc's escrowBalance field is NOT written here — funds
      are held on the invoice doc via escrowSellerAmount and released
      directly to balances.${currency} by confirm-invoice-delivery.js
      or scheduled-clear-earnings.js when delivery is confirmed)
   6. Notify seller (payment in escrow) and email buyer (escrow confirmation)
══════════════════════════════════════════════════════════════ */
async function handleInvoiceOrderPaid({ db, orderId, invOrderRef, invOrderSnap, confirmedAmount, confirmedCurrency, sessionId, paymentMethod, paystackRef }) {
  const invOrder = invOrderSnap.data();

  // Idempotency guard
  if (invOrder.paymentStatus === 'paid') {
    console.log(`Invoice order ${orderId} already paid. Skipping duplicate webhook.`);
    return;
  }

  // Fetch platform settings for fee calculation
  let invSettings;
  try {
    invSettings = await getSettings(db);
  } catch (err) {
    console.warn('[invoice-webhook] Could not fetch settings, using defaults:', err.message);
    invSettings = { platformFeePercent: 2.5 };
  }

  /*
   * Fix D-2 — originalAmount (saved by create-invoice-order.js at order
   * creation) is the invoice total the seller issued — it is ALREADY
   * fee-free. The platform fee was collected up front by charging the
   * client amount = originalAmount / (1 - platformFeePercent/100) — see
   * create-invoice-order.js's "buyer pays invoiceListedAmount + platformFee"
   * block. The previous version deducted platformFeePercent from
   * originalAmount again, taking the fee twice and shorting every seller
   * on every paid invoice. sellerAmount must equal originalAmount
   * directly. platformFee below is a record/display figure only,
   * reconstructed in the same currency as originalAmount to avoid any FX
   * mismatch with confirmedAmount. Falls back to confirmedAmount only for
   * orders predating the originalAmount field — unchanged legacy behavior
   * for those already-historical, already-paid orders.
   */
  const invoiceFeePercent = invSettings.platformFeePercent;

  let sellerAmount, platformFee;
  if (typeof invOrder.originalAmount === 'number' && invOrder.originalAmount > 0) {
    sellerAmount = invOrder.originalAmount;
    const reconstructedChargeAmount = +(sellerAmount / (1 - invoiceFeePercent / 100)).toFixed(2);
    platformFee  = +(reconstructedChargeAmount - sellerAmount).toFixed(2);
  } else {
    const invoiceBaseAmount = Number(confirmedAmount || 0);
    platformFee  = +(invoiceBaseAmount * (invoiceFeePercent / 100)).toFixed(2);
    sellerAmount = +(invoiceBaseAmount - platformFee).toFixed(2);
  }

  // Mark invoice-order as paid
  const orderUpdate = {
    paymentStatus:      'paid',
    paymentMethod,
    amount:             confirmedAmount,
    currency:           confirmedCurrency,
    // chargedAmount/chargedCurrency record exactly what Stripe charged — same
    // shape as the chargedAmount/chargedCurrency fields on product-orders and
    // projects. For most invoices (priced in USD, or paid via Flutterwave)
    // this matches amount/currency above. For an invoice priced in a currency
    // Stripe can't charge in directly (NGN/UGX/RWF/XOF/TZS), create-invoice-
    // order.js converts the charge to USD before checkout — these fields keep
    // an explicit record of that actual charged amount.
    chargedAmount:      confirmedAmount,
    chargedCurrency:    confirmedCurrency,
    amountUsd:          confirmedCurrency === 'USD' ? confirmedAmount : null,
    platformFee,
    sellerAmount,
    paymentConfirmedAt: FieldValue.serverTimestamp(),
    updatedAt:          FieldValue.serverTimestamp(),
  };
  if (sessionId)   orderUpdate.stripeSessionId  = sessionId;
  if (paystackRef) orderUpdate.paystackReference = paystackRef;

  try {
    await invOrderRef.update(orderUpdate);
    console.log(`Invoice order ${orderId} marked as paid. Amount: ${confirmedAmount} ${confirmedCurrency}, sellerAmount: ${sellerAmount}`);
  } catch (err) {
    console.error(`Firestore update failed for invoice-order ${orderId}:`, err.message);
    return;
  }

  const invoiceId   = invOrder.invoiceId || null;
  const sellerUid   = invOrder.sellerUid || null;
  const clientEmail = (invOrder.clientEmail || '').trim().toLowerCase();
  const clientName  = invOrder.clientName || invOrder.payerName || 'A client';

  // Place funds in escrow (status: 'escrow', not 'paid')
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

  // Write escrow-holds record
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

  // Fetch seller details for notifications
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

  // Notify seller: payment in escrow
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

  // Email buyer: payment secured in escrow
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
