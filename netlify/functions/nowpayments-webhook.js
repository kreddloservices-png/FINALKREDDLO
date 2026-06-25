/**
 * Netlify Function: nowpayments-webhook.js
 * Path: netlify/functions/nowpayments-webhook.js
 *
 * Receives IPN (Instant Payment Notification) POST requests from NOWPayments
 * whenever a payment status changes. Verifies the HMAC-SHA512 signature,
 * then — on a confirmed or finished payment — updates the Firestore project
 * document and emails the freelancer.
 *
 * Environment variables required:
 *   NOWPAYMENTS_IPN_SECRET      — IPN secret from your NOWPayments dashboard
 *   FIREBASE_SERVICE_ACCOUNT    — full Firebase service account JSON as a
 *                                 single-line string (for server-side Firestore)
 *   PLATFORM_URL                — your live domain, e.g. https://kreddlo.space
 *
 * NOWPayments sends these statuses (in rough order):
 *   waiting → confirming → confirmed → finished
 *   partially_paid → failed → refunded → expired
 *
 * We act on "confirmed" and "finished" only — both mean the funds are secured.
 */

const crypto  = require('crypto');
const https   = require('https');
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue }     = require('firebase-admin/firestore');
const { getSettings } = require('./get-settings');

/* ── Initialise Firebase Admin SDK once (survives warm Lambda invocations) ── */
function getDb() {
  if (!getApps().length) {
    let serviceAccount;
    try {
      serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
    } catch {
      throw new Error('FIREBASE_SERVICE_ACCOUNT env var is not valid JSON.');
    }
    initializeApp({ credential: cert(serviceAccount) });
  }
  return getFirestore();
}

/* ── Statuses that mean "money is in hand" ── */
const FUNDED_STATUSES = new Set(['confirmed', 'finished']);

/* ── Statuses worth logging but requiring no Firestore write ── */
const PENDING_STATUSES = new Set(['waiting', 'confirming', 'partially_paid']);

/* ── Terminal failure statuses ── */
const FAILED_STATUSES = new Set(['failed', 'refunded', 'expired']);


exports.handler = async (event) => {

  /* ── 1. Accept POST only ── */
  if (event.httpMethod !== 'POST') {
    return respond(405, { error: 'Method not allowed.' });
  }

  const rawBody = event.body || '';

  /* ── 2. Verify IPN signature ── */
  const ipnSecret = process.env.NOWPAYMENTS_IPN_SECRET;
  if (!ipnSecret) {
    console.error('NOWPAYMENTS_IPN_SECRET environment variable is not set.');
    return respond(500, { error: 'Webhook not configured.' });
  }

  const receivedSig = (event.headers['x-nowpayments-sig'] || '').toLowerCase();
  if (!receivedSig) {
    console.warn('Webhook received with no x-nowpayments-sig header — rejected.');
    return respond(401, { error: 'Missing signature.' });
  }

  const isValid = verifySignature(rawBody, ipnSecret, receivedSig);
  if (!isValid) {
    console.warn('Webhook signature mismatch — possible spoofed request. Rejected.');
    return respond(401, { error: 'Invalid signature.' });
  }

  /* ── 3. Parse the verified payload ── */
  let payment;
  try {
    payment = JSON.parse(rawBody);
  } catch {
    return respond(400, { error: 'Invalid JSON body.' });
  }

  const {
    payment_id,
    payment_status,
    order_id,          // this is the Firestore project document ID we passed at invoice creation
    pay_amount,        // amount sent by buyer in crypto
    pay_currency,      // crypto coin used
    actually_paid,     // actual amount received (may differ slightly from pay_amount)
    outcome_amount,    // USD value received after conversion
    outcome_currency,
    fee,               // object: { currency, depositFee, withdrawalFee, serviceFee }
    updated_at,
  } = payment;

  console.log(`IPN received — paymentId: ${payment_id}, status: ${payment_status}, orderId: ${order_id}`);

  /* ── 4. Route by status ── */

  if (PENDING_STATUSES.has(payment_status)) {
    // Confirming on-chain — nothing to write yet, just acknowledge
    console.log(`Payment ${payment_id} is pending (${payment_status}). No action taken.`);
    return respond(200, { received: true });
  }

  if (FAILED_STATUSES.has(payment_status)) {
    // Optionally mark the project payment as failed so the buyer can retry
    await handleFailedPayment({ order_id, payment_id, payment_status });
    return respond(200, { received: true });
  }

  if (FUNDED_STATUSES.has(payment_status)) {
    await handleFundedPayment({
      order_id,
      payment_id,
      payment_status,
      pay_amount,
      pay_currency,
      actually_paid,
      outcome_amount,
      outcome_currency,
      fee,
      updated_at,
    });
    return respond(200, { received: true });
  }

  // Unknown status — acknowledge so NOWPayments stops retrying, log for review
  console.warn(`Unhandled payment status "${payment_status}" for order ${order_id}.`);
  return respond(200, { received: true });
};


/* ══════════════════════════════════════════════════════════════
   SIGNATURE VERIFICATION
   NOWPayments signs webhooks with HMAC-SHA512 of the request body
   after sorting the body's top-level keys alphabetically.
   Docs: https://documenter.getpostman.com/view/7907941/2s93JusNJt#callbacks
══════════════════════════════════════════════════════════════ */
function verifySignature(rawBody, secret, receivedSig) {
  let parsed;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return false;
  }

  // Sort keys alphabetically and re-serialise (NOWPayments requirement)
  const sorted = sortObjectKeys(parsed);
  const sortedJson = JSON.stringify(sorted);

  const expectedSig = crypto
    .createHmac('sha512', secret)
    .update(sortedJson)
    .digest('hex')
    .toLowerCase();

  // Timing-safe comparison prevents timing attacks
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expectedSig, 'utf8'),
      Buffer.from(receivedSig, 'utf8'),
    );
  } catch {
    // Buffers of different length — definitely not equal
    return false;
  }
}

/**
 * Recursively sorts object keys alphabetically.
 * NOWPayments sorts the entire nested payload before signing.
 */
function sortObjectKeys(obj) {
  if (Array.isArray(obj)) return obj.map(sortObjectKeys);
  if (obj !== null && typeof obj === 'object') {
    return Object.keys(obj)
      .sort()
      .reduce((acc, key) => {
        acc[key] = sortObjectKeys(obj[key]);
        return acc;
      }, {});
  }
  return obj;
}


/* ══════════════════════════════════════════════════════════════
   HANDLE FUNDED PAYMENT
   - Updates the project document in Firestore
   - Emails the freelancer
══════════════════════════════════════════════════════════════ */
async function handleFundedPayment(data) {
  const {
    order_id, payment_id, payment_status,
    pay_amount, pay_currency,
    actually_paid, outcome_amount, outcome_currency,
    fee, updated_at,
  } = data;

  if (!order_id) {
    console.error('Funded payment arrived with no order_id — cannot update Firestore.');
    return;
  }

  let db;
  try {
    db = getDb();
  } catch (err) {
    console.error('Failed to initialise Firebase Admin:', err.message);
    return;
  }

  /* ── Route: Pro upgrade (order_id starts with "sub_") ── */
  if (order_id.startsWith('sub_')) {
    const subSnap = await db.collection('subscriptions').doc(order_id).get().catch(() => null);
    if (subSnap && subSnap.exists) {
      const sub = subSnap.data();
      await handleProUpgrade({ db, uid: sub.uid, billingPeriod: sub.billingPeriod, subscriptionId: order_id, gateway: 'crypto', amount: Number(outcome_amount || pay_amount || 0) });
    } else {
      console.error(`[pro_upgrade] Subscription doc "${order_id}" not found.`);
    }
    return;
  }

  const projectRef = db.collection('projects').doc(order_id);

  /* ── Try projects collection first ── */
  let projectSnap;
  try {
    projectSnap = await projectRef.get();
  } catch (err) {
    console.error(`Firestore read failed for project ${order_id}:`, err.message);
    return;
  }

  /* ── If not a project, try product-orders ── */
  if (!projectSnap.exists) {
    const orderRef  = db.collection('product-orders').doc(order_id);
    let   orderSnap;
    try {
      orderSnap = await orderRef.get();
    } catch (err) {
      console.error(`Firestore read failed for product-order ${order_id}:`, err.message);
      return;
    }

    if (!orderSnap.exists) {
      // ── Try invoice-orders ──
      const invOrderRef  = db.collection('invoice-orders').doc(order_id);
      let   invOrderSnap;
      try {
        invOrderSnap = await invOrderRef.get();
      } catch (err) {
        console.error(`Firestore read failed for invoice-order ${order_id}:`, err.message);
        return;
      }

      if (!invOrderSnap.exists) {
        console.error(`Order "${order_id}" not found in projects, product-orders, or invoice-orders.`);
        return;
      }

      const invOrder = invOrderSnap.data();
      if (invOrder.paymentStatus === 'paid') {
        console.log(`Invoice order ${order_id} already paid. Skipping duplicate webhook.`);
        return;
      }

      // Fix 11: Don't silently mix a crypto quantity with a fiat label.
      // outcome_amount/outcome_currency are the fiat equivalent after conversion
      // and must be present on a confirmed/finished webhook. If absent, flag the
      // order for manual review rather than crediting a wrong amount.
      let invConfirmedAmount, invConfirmedCurrency;
      if (outcome_amount && outcome_currency) {
        invConfirmedAmount   = Number(outcome_amount);
        invConfirmedCurrency = outcome_currency.toUpperCase();
      } else {
        console.error(
          `[nowpayments-webhook] Missing outcome_amount/outcome_currency on ${payment_status} ` +
          `payment ${payment_id} for invoice-order ${order_id}. ` +
          `pay_amount=${pay_amount} pay_currency=${pay_currency} actually_paid=${actually_paid}. ` +
          `Skipping — needs manual review.`
        );
        await invOrderRef.update({
          paymentStatus:     'needs-review',
          paymentMethod:     'crypto',
          nowpaymentsId:     payment_id || null,
          reviewReason:      'missing-outcome-amount',
          updatedAt:         FieldValue.serverTimestamp(),
        }).catch(() => {});
        return;
      }

      let invSettings;
      try {
        invSettings = await getSettings(db);
      } catch (err) {
        invSettings = { platformFeePercent: 2.5 };
      }

      /*
       * Fix D-2 (crypto) — originalAmount (saved by create-invoice-order.js at
       * order creation) is the invoice total the seller issued — it is ALREADY
       * fee-free. The platform fee was collected up front by charging the client
       * amount = originalAmount / (1 - platformFeePercent/100). The previous code
       * deducted platformFeePercent from invConfirmedAmount (the crypto outcome
       * amount), which is in a different currency from the invoice AND applies
       * the fee a second time, shorting the seller twice over.
       *
       * sellerAmount must equal originalAmount directly. platformFee here is a
       * record/display figure only, reconstructed by inverting the exact markup
       * formula create-invoice-order.js used — same pattern as stripe-webhook.js
       * and flutterwave-webhook.js invoice handlers. Falls back to
       * invConfirmedAmount only for orders predating the originalAmount field —
       * unchanged legacy behavior for those already-historical orders.
       */
      const invFeePercent = invSettings.platformFeePercent;
      let invPlatformFee, invSellerAmount;
      if (typeof invOrder.originalAmount === 'number' && invOrder.originalAmount > 0) {
        invSellerAmount = invOrder.originalAmount;
        const invReconstructedCharge = +(invSellerAmount / (1 - invFeePercent / 100)).toFixed(2);
        invPlatformFee  = +(invReconstructedCharge - invSellerAmount).toFixed(2);
      } else {
        // Legacy fallback — orders created before originalAmount was saved
        invPlatformFee  = +(invConfirmedAmount * (invFeePercent / 100)).toFixed(2);
        invSellerAmount = +(invConfirmedAmount - invPlatformFee).toFixed(2);
      }

      try {
        await invOrderRef.update({
          paymentStatus:      'paid',
          paymentMethod:      'crypto',
          nowpaymentsId:      payment_id   || null,
          payCurrency:        pay_currency || null,
          payAmount:          pay_amount   || null,
          actuallyPaid:       actually_paid || null,
          amount:             invConfirmedAmount,
          currency:           invConfirmedCurrency,
          amountUsd:          invConfirmedCurrency === 'USD' ? invConfirmedAmount : null,
          platformFee:        invPlatformFee,
          sellerAmount:       invSellerAmount,
          paymentConfirmedAt: FieldValue.serverTimestamp(),
          updatedAt:          FieldValue.serverTimestamp(),
        });
        console.log(`Invoice order ${order_id} marked as paid via crypto.`);
      } catch (err) {
        console.error(`Firestore update failed for invoice-order ${order_id}:`, err.message);
        return;
      }

      const invoiceId = invOrder.invoiceId || null;
      const sellerUid = invOrder.sellerUid || null;
      const clientEmail = (invOrder.clientEmail || '').trim().toLowerCase();
      const clientName  = invOrder.clientName || invOrder.payerName || 'A client';

      /* ── Place funds in escrow (not paid directly to seller) ── */
      if (invoiceId) {
        try {
          // deliverBy window is admin-configurable (invoiceDeliverByHours), defaulting to 48h
          const deliverByHours = Number(invSettings.invoiceDeliverByHours) || 48;
          const deliverBy = new Date(Date.now() + deliverByHours * 60 * 60 * 1000);
          await db.collection('invoices').doc(invoiceId).update({
            status:              'escrow',
            escrowHeldAt:        FieldValue.serverTimestamp(),
            escrowSellerAmount:  invSellerAmount,
            paidAt:              FieldValue.serverTimestamp(),
            paidOrder:           order_id,
            deliverBy:           deliverBy,
            updatedAt:           FieldValue.serverTimestamp(),
          });
          console.log(`Invoice ${invoiceId} placed in escrow.`);
        } catch (err) {
          console.error(`Could not place invoice ${invoiceId} in escrow:`, err.message);
        }
      }

      if (sellerUid) {
        /* ── Write escrow-holds record ── */
        try {
          await db.collection('escrow-holds').add({
            invoiceId,
            orderId:     order_id,
            sellerId:    sellerUid,
            buyerEmail:  clientEmail,
            amount:      invSellerAmount,
            currency:    invConfirmedCurrency,
            status:      'held',
            createdAt:   FieldValue.serverTimestamp(),
          });
        } catch (err) {
          console.error(`Could not write escrow-holds for invoice ${invoiceId}:`, err.message);
        }
      }

      /* ── Fetch user details for notifications ── */
      let freelancerEmail = null;
      let freelancerName  = 'Freelancer';
      let invoiceNumber   = '';
      if (sellerUid) {
        try {
          const userSnap = await db.collection('users').doc(sellerUid).get();
          if (userSnap.exists) {
            freelancerEmail = userSnap.data().email || null;
            freelancerName  = userSnap.data().name || userSnap.data().displayName || 'Freelancer';
          }
        } catch (_) {}
      }
      if (invoiceId) {
        try {
          const invSnap = await db.collection('invoices').doc(invoiceId).get();
          if (invSnap.exists) invoiceNumber = invSnap.data().invoiceNumber || '';
        } catch (_) {}
      }

      const platformUrl   = (process.env.PLATFORM_URL || 'https://kreddlo.space').replace(/\/$/, '');
      const invoiceAmount = new Intl.NumberFormat('en', { style: 'currency', currency: invConfirmedCurrency }).format(invConfirmedAmount);

      /* ── Notify seller: payment in escrow ── */
      if (sellerUid) {
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
      }

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

      console.log(`NOWPayments invoice order ${order_id} handled successfully — funds in escrow.`);
      return;
    }

    // Fix 11: Don't silently mix a crypto quantity with a fiat label.
    // outcome_amount/outcome_currency are the fiat equivalent after conversion
    // and must be present on a confirmed/finished webhook. If absent, flag the
    // order for manual review rather than crediting a wrong amount.
    let confirmedAmount, confirmedCurrency;
    if (outcome_amount && outcome_currency) {
      confirmedAmount   = Number(outcome_amount);
      confirmedCurrency = outcome_currency.toUpperCase();
    } else {
      console.error(
        `[nowpayments-webhook] Missing outcome_amount/outcome_currency on ${payment_status} ` +
        `payment ${payment_id} for product-order ${order_id}. ` +
        `pay_amount=${pay_amount} pay_currency=${pay_currency} actually_paid=${actually_paid}. ` +
        `Skipping — needs manual review.`
      );
      await orderRef.update({
        paymentStatus:     'needs-review',
        paymentMethod:     'crypto',
        nowpaymentsId:     payment_id || null,
        reviewReason:      'missing-outcome-amount',
        updatedAt:         FieldValue.serverTimestamp(),
      }).catch(() => {});
      return;
    }

    // Fetch platform settings to calculate fees (outside transaction — no HTTP calls inside tx)
    let productOrderSettings;
    try {
      productOrderSettings = await getSettings(db);
    } catch (err) {
      console.warn('[nowpayments-webhook] Could not fetch settings for product order, using defaults:', err.message);
      productOrderSettings = { platformFeePercent: 2.5 };
    }

    // Fix D-2 — originalAmount (saved by create-product-order.js at order
    // creation) is the seller's listed price and is ALREADY fee-free —
    // the platform fee was collected up front via the buyer's grossed-up
    // charge (see create-product-order.js's "Add platform fee on top of
    // product price" block). sellerAmount must equal originalAmount
    // directly. platformFee here is a record/display figure only,
    // reconstructed in the same currency as originalAmount by inverting
    // the exact markup formula used at order creation, avoiding any
    // mismatch with confirmedAmount/outcome_amount (the actual crypto
    // received, which can drift slightly from the requested amount).
    // Falls back to confirmedAmount only for orders predating the
    // originalAmount field — unchanged legacy behavior for those
    // already-historical, already-paid orders.
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
        if (!freshSnap.exists) throw new Error(`Product order ${order_id} not found inside transaction.`);
        const freshData = freshSnap.data();

        if (freshData.paymentStatus === 'paid') {
          productAlreadyPaid = true;
          return;
        }

        tx.update(orderRef, {
          paymentStatus:      'paid',
          paymentMethod:      'crypto',
          nowpaymentsId:      payment_id  || null,
          payCurrency:        pay_currency || null,
          payAmount:          pay_amount   || null,
          actuallyPaid:       actually_paid || null,
          amount:             confirmedAmount,
          currency:           confirmedCurrency,
          amountUsd:          confirmedCurrency === 'USD' ? confirmedAmount : null,
          platformFee:        productPlatformFee,
          sellerAmount:       productSellerAmount,
          paymentConfirmedAt: FieldValue.serverTimestamp(),
          updatedAt:          FieldValue.serverTimestamp(),
        });

        productOrderDataForDownstream = { ...freshData, sellerAmount: productSellerAmount };
      });
    } catch (err) {
      console.error(`Transaction failed for product-order ${order_id}:`, err.message);
      return; // handleFundedPayment is not expected to throw — caller returns 200
    }

    if (productAlreadyPaid) {
      console.log(`Product order ${order_id} already paid. Skipping duplicate webhook.`);
      return;
    }

    console.log(`Product order ${order_id} marked as paid. Amount: ${confirmedAmount} ${confirmedCurrency}, sellerAmount: ${productSellerAmount}`);

    // Use the order data captured inside the transaction for downstream calls
    const order = productOrderDataForDownstream;

    // Credit affiliate commission if this order was referred
    const { finalSellerAmount } = await creditAffiliateCommission({
      db,
      order,
      orderId:           order_id,
      sellerAmount:      productSellerAmount,
      confirmedAmount,
      confirmedCurrency,
      amountUsd:         confirmedCurrency === 'USD' ? confirmedAmount : null,
      gateway:           'crypto',
    });

    // Trigger delivery with the final seller amount (after any affiliate deduction).
    // Uses the retrying caller — this single call credits the seller's balance,
    // increments salesCount, and sends their sale notification.
    const deliveryDispatch = await callFunctionWithRetry('deliver-product', { orderId: order_id, sellerAmount: finalSellerAmount });
    if (!deliveryDispatch.success) {
      try {
        await orderRef.update({
          deliveryDispatchFailed: true,
          deliveryDispatchError:  deliveryDispatch.reason || 'unknown error',
          deliveryDispatchFailedAt: FieldValue.serverTimestamp(),
        });
      } catch (markErr) {
        console.error(`Could not flag delivery dispatch failure for order ${order_id}:`, markErr.message);
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
          email:     order.buyerEmail || '',
          orderId:   order_id,
        });
      }
    } catch (err) {
      console.warn(`Could not fire pixel for product-order ${order_id}:`, err.message);
    }

    return; // done with product order path
  }

  /* Fetch platform fee settings outside the transaction — no HTTP calls inside tx */
  let settings;
  try {
    settings = await getSettings(db);
  } catch (err) {
    console.warn('[nowpayments-webhook] Could not fetch settings, using defaults:', err.message);
    settings = { platformFeePercent: 2.5, projectProtectionPercent: 1.0 };
  }

  /*
   * Fix D-3 (crypto projects) — use the pre-buffer USD budget as the fee base,
   * not outcome_amount. outcome_amount is the USD-equivalent of what the buyer
   * actually sent in crypto, which can differ from the listed project price due
   * to crypto volatility and NowPayments conversion. More importantly, for any
   * project paid via crypto after a currency conversion, using outcome_amount as
   * the base would calculate fees and netAmount in the wrong currency or against
   * a shifted amount.
   *
   * The correct base is the original USD project budget (set at project creation
   * by create-project.js). approve-delivery.js reads project.netAmount and
   * project.currency to credit the freelancer's balance — those must be in USD
   * at the listed price, not the crypto outcome amount. Falls back to
   * outcome_amount for any project where budget is absent — unchanged legacy
   * behavior for those older records.
   */
  const cryptoProjectData  = projectSnap.data();
  const useProjectBudget   = typeof cryptoProjectData.budget === 'number' && cryptoProjectData.budget > 0;
  const baseAmount         = useProjectBudget ? cryptoProjectData.budget : Number(outcome_amount || pay_amount || 0);
  const baseCurrency       = useProjectBudget ? (cryptoProjectData.currency || 'USD').toUpperCase() : (outcome_currency || 'USD').toUpperCase();
  const platformFeeAmt    = +(baseAmount * (settings.platformFeePercent / 100)).toFixed(2);
  // Project Protection is an optional buyer add-on (see pricing.html) — only
  // deduct it if the buyer actually opted in when the project was created.
  const protectionOptedIn = cryptoProjectData.withProtection === true;
  const protectionFeeAmt  = protectionOptedIn
    ? +(baseAmount * (settings.projectProtectionPercent / 100)).toFixed(2)
    : 0;
  const netAmount         = +(baseAmount - platformFeeAmt - protectionFeeAmt).toFixed(2);

  // Atomic idempotency: read-check-write inside a transaction so concurrent
  // duplicate webhooks cannot both see escrowStatus !== 'funded' and both write.
  let projectAlreadyFunded = false;
  let projectDataForDownstream = null;

  try {
    await db.runTransaction(async (tx) => {
      const freshSnap = await tx.get(projectRef);
      if (!freshSnap.exists) throw new Error(`Project ${order_id} not found inside transaction.`);
      const freshData = freshSnap.data();

      if (freshData.escrowStatus === 'funded') {
        projectAlreadyFunded = true;
        return;
      }

      tx.update(projectRef, {
        escrowStatus:    'funded',
        status:          'in_progress',
        paymentMethod:   'crypto',
        paymentId:       payment_id,
        paymentStatus:   payment_status,
        // currency/netAmount are in the project's original pricing currency (USD
        // when budget was used as base). approve-delivery.js reads these to credit
        // the freelancer, so they must match the currency the project was priced in.
        currency:        baseCurrency,
        platformFee:     platformFeeAmt,
        protectionFee:   protectionFeeAmt,
        netAmount:       netAmount,
        // Crypto payment details — raw amounts exactly as NowPayments reported.
        // These are for auditing/admin display and are NOT used for balance crediting.
        payCurrency:     pay_currency      || null,
        payAmount:       pay_amount        || null,
        actuallyPaid:    actually_paid     || null,
        outcomeAmount:   outcome_amount    || null,
        outcomeCurrency: outcome_currency  || null,
        paymentFee:      fee               || null,
        paymentConfirmedAt: updated_at
          ? new Date(updated_at)
          : FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });

      projectDataForDownstream = freshData;
    });
  } catch (err) {
    console.error(`Transaction failed for project ${order_id}:`, err.message);
    return;
  }

  if (projectAlreadyFunded) {
    console.log(`Project ${order_id} already marked as funded. Skipping duplicate webhook.`);
    return;
  }

  console.log(`Project ${order_id} updated — escrowStatus: funded, status: in_progress.`);

  const project = projectDataForDownstream;

  const platformUrl = (process.env.PLATFORM_URL || 'https://kreddlo.space').replace(/\/$/, '');
  const projectUrl  = `${platformUrl}/dashboard-projects.html?projectId=${encodeURIComponent(order_id)}`;

  /* Fetch freelancer and buyer details for the notification */
  let freelancerEmail = null;
  let freelancerName  = 'there';
  let buyerName       = 'A client';

  try {
    if (project.freelancerUid) {
      const freelancerSnap = await db.collection('users').doc(project.freelancerUid).get();
      if (freelancerSnap.exists) {
        freelancerEmail = freelancerSnap.data().email || null;
        freelancerName  = freelancerSnap.data().name  || 'there';
      }
    }
    if (project.buyerUid) {
      const buyerSnap = await db.collection('users').doc(project.buyerUid).get();
      if (buyerSnap.exists) {
        buyerName = buyerSnap.data().name || 'A client';
      }
    }
  } catch (err) {
    console.warn('Could not fetch user details for notification:', err.message);
  }

  /* Notify the freelancer: payment received (push + email always) */
  await callFunction('send-smart-notification', {
    userUid:    project.freelancerUid || null,
    to:         freelancerEmail,
    title:      'Escrow Funded',
    body:       `Payment has been placed in escrow for "${project.projectTitle || 'Your project'}". You can begin work.`,
    url:        projectUrl,
    templateId: 'payment-received',
    emailMode:  'always',
    emailData: {
      name:         freelancerName,
      buyerName,
      projectTitle: project.projectTitle || 'Your project',
      amount:       (outcome_amount || pay_amount)
                      ? new Intl.NumberFormat('en', { style: 'currency', currency: (outcome_currency || 'USD').toUpperCase() }).format(Number(outcome_amount || pay_amount))
                      : 'the agreed amount',
      dashboardUrl: projectUrl,
    },
  });
}


/* ══════════════════════════════════════════════════════════════
   AFFILIATE COMMISSION CREDITING
   Called from the product-order path after the order is marked paid.
   See stripe-webhook.js for full documentation of this logic.
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
      paymentMethod:        'crypto',
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
   HANDLE FAILED / EXPIRED / REFUNDED PAYMENT
   Marks the project or product-order payment status so the buyer
   can retry. Checks product-orders first, then falls back to projects.
══════════════════════════════════════════════════════════════ */
async function handleFailedPayment({ order_id, payment_id, payment_status }) {
  if (!order_id) return;

  let db;
  try {
    db = getDb();
  } catch (err) {
    console.error('Firebase Admin init failed (failed payment handler):', err.message);
    return;
  }

  /* ── Check product-orders first ── */
  try {
    const orderSnap = await db.collection('product-orders').doc(order_id).get();
    if (orderSnap.exists) {
      await db.collection('product-orders').doc(order_id).update({
        paymentStatus: payment_status,
        nowpaymentsId: payment_id || null,
        updatedAt:     FieldValue.serverTimestamp(),
      });
      console.log(`Product order ${order_id} payment marked as ${payment_status}.`);
      return;
    }
  } catch (err) {
    console.error(`Firestore read/update failed for product-order ${order_id}:`, err.message);
  }

  /* ── Fall back to projects ── */
  try {
    const projectSnap = await db.collection('projects').doc(order_id).get();
    if (!projectSnap.exists) {
      console.warn(`handleFailedPayment: order_id "${order_id}" not found in product-orders or projects — skipping.`);
      return;
    }
    await db.collection('projects').doc(order_id).update({
      paymentStatus: payment_status,
      paymentId:     payment_id || null,
      updatedAt:     FieldValue.serverTimestamp(),
    });
    console.log(`Project ${order_id} payment marked as ${payment_status}.`);
  } catch (err) {
    console.error(`Firestore update failed for failed payment on project ${order_id}:`, err.message);
  }
}


/* ══════════════════════════════════════════════════════════════
   INTERNAL FUNCTION CALLER
   Calls sibling Netlify functions via HTTP fetch.
   Non-fatal: errors are logged and execution continues.
══════════════════════════════════════════════════════════════ */
async function callFunction(name, payload) {
  const platformUrl = (process.env.PLATFORM_URL || 'https://kreddlo.space').replace(/\/$/, '');
  if (!platformUrl) {
    console.warn(`callFunction: PLATFORM_URL not set, cannot call ${name}.`);
    return;
  }
  try {
    await fetch(`${platformUrl}/.netlify/functions/${name}`, {
      method:  'POST',
      headers: {
        'Content-Type':     'application/json',
        'x-internal-secret': process.env.INTERNAL_FUNCTION_SECRET || '',
      },
      body:    JSON.stringify(payload),
    });
  } catch (err) {
    console.warn(`callFunction(${name}) failed:`, err.message);
  }
}

/* ══════════════════════════════════════════════════════════════
   INTERNAL FUNCTION CALLER WITH RETRY — used for deliver-product
   deliver-product.js credits the seller's balance, increments
   salesCount, and sends their sale notification. A single transient
   failure used to mean that work never ran and never got retried,
   with the order stuck showing paid but nothing credited. This
   retries up to 3 times with a short backoff and reports whether
   it ultimately succeeded.
══════════════════════════════════════════════════════════════ */
async function callFunctionWithRetry(name, payload, maxAttempts = 3) {
  const platformUrl = (process.env.PLATFORM_URL || 'https://kreddlo.space').replace(/\/$/, '');
  if (!platformUrl) {
    console.warn(`callFunctionWithRetry: PLATFORM_URL not set, cannot call ${name}.`);
    return { success: false, reason: 'PLATFORM_URL not set' };
  }

  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(`${platformUrl}/.netlify/functions/${name}`, {
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
      console.warn(`callFunctionWithRetry(${name}) attempt ${attempt}/${maxAttempts} returned ${res.status}: ${errText}`);
    } catch (err) {
      lastError = err.message;
      console.warn(`callFunctionWithRetry(${name}) attempt ${attempt}/${maxAttempts} network error:`, err.message);
    }

    if (attempt < maxAttempts) {
      const backoffMs = 500 * attempt;
      await new Promise(resolve => setTimeout(resolve, backoffMs));
    }
  }

  console.error(`callFunctionWithRetry(${name}) failed after ${maxAttempts} attempts — last error: ${lastError}`);
  return { success: false, reason: lastError };
}


/* ── Pro Upgrade handler ── */
async function handleProUpgrade({ db, uid, billingPeriod, subscriptionId, gateway, amount }) {
  if (!uid) {
    console.error('[pro_upgrade] Missing uid — cannot activate Pro.');
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
      updatedAt:        require('firebase-admin/firestore').FieldValue.serverTimestamp(),
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
      const toEmail  = userData.email || null;
      const name     = userData.displayName || userData.name || 'Freelancer';
      if (toEmail) {
        await fetch(`${platformUrl}/.netlify/functions/send-email`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-internal-secret': process.env.INTERNAL_FUNCTION_SECRET || '' },
          body: JSON.stringify({
            to: toEmail, type: 'premium-activated',
            data: { name, plan: 'Pro', billingPeriod: billingPeriod === 'annual' ? 'Annual' : 'Monthly',
              endDate: endDate.toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' }),
              dashboardUrl: `${platformUrl}/dashboard.html` },
          }),
        }).catch(e => console.warn('[pro_upgrade] send-email failed:', e.message));
      }
    }
  } catch (err) {
    console.error('[pro_upgrade] Firestore update failed:', err.message);
  }
}

/* ── Utility: build a Netlify function response ── */
function respond(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
