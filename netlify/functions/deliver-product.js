/**
 * Netlify Function: deliver-product.js
 * Path: netlify/functions/deliver-product.js
 *
 * Handles product delivery after a successful payment.
 * Can be called directly via POST or internally by payment webhooks.
 * Idempotent — returns 200 immediately if delivery already completed.
 *
 * Expected POST body (JSON):
 *   { orderId: string }
 *
 * Environment variables required:
 *   FIREBASE_SERVICE_ACCOUNT — full service account JSON as one-line string
 *   PLATFORM_URL             — live domain, e.g. https://kreddlo.space
 */

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue }     = require('firebase-admin/firestore');
const { verifyCaller }                 = require('./_verify-auth');
const { getSettings }                  = require('./get-settings');

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

/* ── Internal function-to-function HTTP caller ── */
async function callFunction(functionName, payload) {
  const platformUrl = (process.env.PLATFORM_URL || 'https://kreddlo.space').replace(/\/$/, '');
  if (!platformUrl) {
    console.warn(`PLATFORM_URL not set — cannot call ${functionName}.`);
    return null;
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
      console.error(`[deliver-product] callFunction(${functionName}) failed — status: ${res.status}, body: ${errText}`);
    }

    return res;
  } catch (err) {
    console.error(`[deliver-product] callFunction(${functionName}) network error:`, err.message);
    return null;
  }
}

/* ══════════════════════════════════════════════════════════════
   HANDLER
══════════════════════════════════════════════════════════════ */
exports.handler = async (event) => {

  if (event.httpMethod !== 'POST') {
    return respond(405, { error: 'Method not allowed.' });
  }

  /* ── Verify caller identity (skip if called internally via webhook) ── */
  const authHeader = event.headers['authorization'] || event.headers['Authorization'] || '';
  if (authHeader) {
    const callerUid = await verifyCaller(event);
    if (!callerUid) {
      return respond(401, { error: 'Unauthorized. Please log in again.' });
    }
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return respond(400, { error: 'Invalid JSON in request body.' });
  }

  const { orderId } = body;

  if (!orderId || typeof orderId !== 'string') {
    return respond(400, { error: 'orderId is required.' });
  }

  const platformUrl = (process.env.PLATFORM_URL || 'https://kreddlo.space').replace(/\/$/, '');

  try {
    const db = getDb();

    /* ── Fetch order ── */
    const orderRef  = db.collection('product-orders').doc(orderId);
    const orderSnap = await orderRef.get();

    if (!orderSnap.exists) {
      return respond(404, { error: 'Order not found.' });
    }

    const order = orderSnap.data();

    /* ── Idempotency guard — prevent double delivery ── */
    if (order.deliveryStatus === 'delivered') {
      console.log(`[deliver-product] Order ${orderId} already delivered — skipping.`);
      return respond(200, { success: true, message: 'Already delivered.' });
    }

    /* ── Fetch product ── */
    const productSnap = await db.collection('products').doc(order.productId).get();
    if (!productSnap.exists) {
      return respond(404, { error: 'Product not found.' });
    }
    const product = productSnap.data();

    /* ── Fetch seller user document for seller name ── */
    const sellerSnap = await db.collection('users').doc(order.sellerUid).get();
    const seller     = sellerSnap.exists ? sellerSnap.data() : {};
    const sellerName = seller.displayName || seller.name || 'the seller';

    /* ── Delivery logic by type ── */
    if (product.deliveryType === 'instant-auto') {
      /* Send product-delivery email to buyer immediately */
      await callFunction('send-email', {
        to:         order.buyerEmail,
        toName:     order.buyerName,
        templateId: 'product-delivery',
        data: {
          name:            order.buyerName,
          productTitle:    product.title,
          deliveryType:    product.deliveryType,
          deliveryContent: product.deliveryContent,
          sellerName,
        },
      });

    } else if (product.deliveryType === 'manual-link') {
      /* Notify seller to deliver manually */
      await callFunction('send-smart-notification', {
        userUid:      order.sellerUid,
        title:        'New sale — delivery required',
        body:         `You have a new sale on "${product.title}". The buyer is waiting for delivery.`,
        url:          `${platformUrl}/dashboard.html`,
        templateId:   'product-sale',
        emailMode:    'never',
        emailData: {
          name:         sellerName,
          buyerName:    order.buyerName,
          buyerEmail:   order.buyerEmail,
          productTitle: product.title,
          amount:       order.sellerAmount,
        },
      });

      /* Create a seller task so it appears in their dashboard task list */
      await db.collection('seller-tasks').add({
        sellerUid:    order.sellerUid,
        orderId,
        productId:    order.productId,
        productTitle: product.title,
        buyerEmail:   order.buyerEmail,
        buyerName:    order.buyerName,
        type:         'manual-delivery',
        status:       'pending',
        createdAt:    FieldValue.serverTimestamp(),
      });
    }

    /* ── Mark order as delivered ──
       For instant-auto products, also copy the product's delivery content
       onto the order itself. buyer-purchases.html reads accessUrl straight
       off the product-orders document (data.deliveryContent / fileUrl /
       courseUrl / coachingCalUrl / redirectUrl) — without this, the order
       showed deliveryStatus: 'delivered' with nothing for the buyer to open,
       even though the email was sent. ── */
    const orderDeliveryUpdate = {
      deliveryStatus: 'delivered',
      deliveredAt:    FieldValue.serverTimestamp(),
    };
    if (product.deliveryType === 'instant-auto') {
      orderDeliveryUpdate.deliveryContent = product.deliveryContent || null;
      orderDeliveryUpdate.fileUrl         = product.fileUrl         || null;
      orderDeliveryUpdate.courseUrl       = product.courseUrl       || null;
      orderDeliveryUpdate.coachingCalUrl  = product.coachingCalUrl  || null;
      orderDeliveryUpdate.redirectUrl     = product.redirectUrl     || null;
    }
    await orderRef.update(orderDeliveryUpdate);

    /* ── Increment product salesCount ── */
    await db.collection('products').doc(order.productId).update({
      salesCount: FieldValue.increment(1),
    });

    /* ── Credit seller balance (per-currency map), subject to admin-configured
       holding period (Item 9). Funds are routed through a `product-earnings`
       record rather than hitting availableBalance directly, so create-payout.js
       and create-bank-payout.js — which already gate withdrawals on
       availableBalance / balances.{CURRENCY} — automatically reject anything
       still inside the holding window without needing any changes themselves. ── */
    const sellerAmount  = (typeof body.sellerAmount === 'number' && body.sellerAmount > 0)
      ? body.sellerAmount
      : (order.sellerAmount || 0);
    // Credit in the currency that was actually charged/received, not the
    // seller's original listed currency — sellerAmount above is computed
    // from the confirmed/charged amount, so the balance bucket must match.
    // chargedCurrency is only set when a Stripe currency conversion happened
    // (Fix 1); everything else (crypto, Flutterwave, non-converted Stripe)
    // still has the real charged currency in `currency` as before.
    const orderCurrency = (order.chargedCurrency || order.currency || 'USD').toUpperCase();
    const amountFormatted = new Intl.NumberFormat('en', { style: 'currency', currency: orderCurrency }).format(sellerAmount);

    const settings        = await getSettings(db);
    const holdingDays     = Number(settings.productSaleHoldingDays) || 0;
    const deliveredAt     = new Date();
    const clearsAt        = new Date(deliveredAt.getTime() + holdingDays * 24 * 60 * 60 * 1000);
    const isCleared        = holdingDays <= 0; // 0 days = instant, same as legacy behaviour

    /* totalSales / totalEarned are gross, all-time stats and update immediately
       regardless of holding period — only the spendable balance is gated.
       totalEarned is a legacy blended (all-currencies-summed) figure kept
       only for older admin tooling. It must never be shown to a seller as
       "earnings" since it can mix USD+NGN+EUR raw numbers together.
       totalEarnedByCurrency is the accurate, currency-separated figure that
       any seller-facing earnings display must use instead. */
    const sellerUserUpdate = {
      totalSales:  FieldValue.increment(1),
      totalEarned: FieldValue.increment(sellerAmount),
      [`totalEarnedByCurrency.${orderCurrency}`]: FieldValue.increment(sellerAmount),
    };
    if (isCleared) {
      sellerUserUpdate[`balances.${orderCurrency}`] = FieldValue.increment(sellerAmount);
      if (orderCurrency === 'USD') {
        sellerUserUpdate.availableBalance = FieldValue.increment(sellerAmount);
      }
    } else {
      sellerUserUpdate[`pendingBalances.${orderCurrency}`] = FieldValue.increment(sellerAmount);
      if (orderCurrency === 'USD') {
        sellerUserUpdate.pendingBalance = FieldValue.increment(sellerAmount);
      }
    }
    await db.collection('users').doc(order.sellerUid).update(sellerUserUpdate);

    /* Auditable earning record — the scheduled-clear-earnings.js job flips
       `cleared` to true once `clearsAt` has passed and moves the amount from
       pendingBalance(s) to availableBalance/balances. */
    await db.collection('product-earnings').add({
      sellerUid:   order.sellerUid,
      orderId,
      productId:   order.productId,
      amount:      sellerAmount,
      currency:    orderCurrency,
      cleared:     isCleared,
      clearsAt:    clearsAt,
      deliveredAt: FieldValue.serverTimestamp(),
      createdAt:   FieldValue.serverTimestamp(),
    });

    /* ── Notify buyer that their order has been delivered (Fix 1) ── */
    await callFunction('send-smart-notification', {
      userUid:    order.buyerUid,
      title:      'Your order has been delivered!',
      body:       `"${product.title}" has been delivered. Visit your purchases to access it.`,
      url:        `${platformUrl}/buyer-purchases.html`,
      templateId: 'product-delivery',
      emailMode:  'never',
    });

    /* ── Schedule review-request email (48 hours = 2880 minutes) ── */
    await callFunction('send-smart-notification', {
      userUid:      order.sellerUid, // placeholder — email goes to buyer via emailData.to
      title:        'Review request scheduled',
      body:         `A review request will be sent to ${order.buyerEmail} in 48 hours.`,
      templateId:   'review-request',
      emailMode:    'never',
      delayMinutes: 2880,
      emailTo:      order.buyerEmail,
      emailToName:  order.buyerName,
      emailData: {
        name:         order.buyerName,
        productTitle: product.title,
        reviewUrl:    `${platformUrl}/review.html?orderId=${encodeURIComponent(orderId)}`,
        sellerName,
      },
    });

    /* ── Send seller a product-sale notification ── */
    await callFunction('send-smart-notification', {
      userUid:    order.sellerUid,
      title:      'You made a sale!',
      body:       `${order.buyerName} purchased "${product.title}" for ${amountFormatted}.`,
      url:        `${platformUrl}/dashboard.html`,
      templateId: 'product-sale',
      emailMode:  'never',
      emailData: {
        name:         sellerName,
        buyerName:    order.buyerName,
        buyerEmail:   order.buyerEmail,
        productTitle: product.title,
        amount:       order.sellerAmount,
      },
    });

    console.log(`[deliver-product] Delivered — orderId: ${orderId}, type: ${product.deliveryType}`);

    return respond(200, { success: true, orderId, deliveryType: product.deliveryType });

  } catch (err) {
    console.error('[deliver-product] Error:', err);
    return respond(500, { error: err.message || 'Internal server error.' });
  }
};

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(body),
  };
}
