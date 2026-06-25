/**
 * Netlify Function: og-meta.js
 * Path: netlify/functions/og-meta.js
 *
 * PURPOSE
 * -------
 * Social media crawlers (Facebook, Twitter/X, WhatsApp, LinkedIn, iMessage,
 * Telegram, Discord, Slack) do NOT execute JavaScript. This means the
 * JS-based og:image / og:title setAttribute() calls in p.html, store.html,
 * and profile.html are invisible to them — they only ever see the empty
 * <meta property="og:image" content=""/> placeholders in the raw HTML.
 *
 * This function is the fix: it reads Firestore server-side (Admin SDK),
 * builds a minimal HTML page with fully-populated OG + Twitter Card meta
 * tags, then immediately redirects human visitors to the real page via
 * <meta http-equiv="refresh"> so the UX is identical for real users.
 *
 * ROUTING (netlify.toml)
 * ----------------------
 * Three redirect rules send crawler User-Agents here:
 *   /p?slug=:slug            → /.netlify/functions/og-meta?type=product&slug=:slug
 *   /store?storeSlug=:slug   → /.netlify/functions/og-meta?type=store&slug=:slug
 *   /profile?uid=:uid        → /.netlify/functions/og-meta?type=profile&uid=:uid
 *
 * The conditions block in netlify.toml matches on User-Agent so only
 * crawlers hit this function; regular browsers get the normal HTML pages.
 *
 * SUPPORTED TYPES
 * ---------------
 *   ?type=product&slug=<productSlug>   — reads products collection by slug
 *   ?type=store&slug=<storeSlug>       — reads publicProfiles by storeSlug
 *   ?type=profile&uid=<uid>            — reads publicProfiles by uid
 *
 * DATA SOURCES
 * ------------
 *   products/{id}          — title, description, coverUrl, uid (sellerUid)
 *   publicProfiles/{uid}   — displayName, name, bio, description, photoURL,
 *                            photoUrl, profilePhoto, storeSlug, username
 *
 * No sensitive data (balances, email, fcmToken) is read or returned.
 *
 * Environment variables required:
 *   FIREBASE_SERVICE_ACCOUNT  — full service account JSON (already used by
 *                               all other Netlify functions in this project)
 *   PLATFORM_URL              — live domain e.g. https://kreddlo.space
 */

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore }                  = require('firebase-admin/firestore');

// ── Firebase Admin init (idempotent) ─────────────────────────────────────────
function getDb() {
  if (!getApps().length) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
    initializeApp({ credential: cert(serviceAccount) });
  }
  return getFirestore();
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const PLATFORM_URL    = (process.env.PLATFORM_URL || 'https://kreddlo.space').replace(/\/$/, '');
const FALLBACK_IMAGE  = `${PLATFORM_URL}/assets/kreddlo-og-banner.png`;
const SITE_NAME       = 'Kreddlo';

/** Escape HTML special characters for safe meta content attribute injection */
function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Build and return the final OG HTML response */
function buildResponse(meta) {
  const {
    title       = SITE_NAME,
    description = 'Global freelance marketplace — get paid anywhere.',
    image       = FALLBACK_IMAGE,
    url         = PLATFORM_URL,
    type        = 'website',
  } = meta;

  const safeTitle       = esc(title);
  const safeDescription = esc(String(description).slice(0, 200));
  const safeImage       = esc(image);
  const safeUrl         = esc(url);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <title>${safeTitle}</title>
  <meta name="description" content="${safeDescription}"/>

  <!-- Open Graph -->
  <meta property="og:site_name"   content="${esc(SITE_NAME)}"/>
  <meta property="og:type"        content="${esc(type)}"/>
  <meta property="og:url"         content="${safeUrl}"/>
  <meta property="og:title"       content="${safeTitle}"/>
  <meta property="og:description" content="${safeDescription}"/>
  <meta property="og:image"       content="${safeImage}"/>
  <meta property="og:image:width"  content="1200"/>
  <meta property="og:image:height" content="630"/>
  <meta property="og:image:alt"   content="${safeTitle}"/>

  <!-- Twitter Card -->
  <meta name="twitter:card"        content="summary_large_image"/>
  <meta name="twitter:title"       content="${safeTitle}"/>
  <meta name="twitter:description" content="${safeDescription}"/>
  <meta name="twitter:image"       content="${safeImage}"/>
  <meta name="twitter:image:alt"   content="${safeTitle}"/>

  <!-- Redirect humans immediately to the real page -->
  <meta http-equiv="refresh" content="0; url=${safeUrl}"/>
  <link rel="canonical" href="${safeUrl}"/>
</head>
<body>
  <p>Redirecting to <a href="${safeUrl}">${safeTitle}</a>…</p>
</body>
</html>`;

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // Let CDN/crawlers cache this for 5 minutes; revalidate after
      'Cache-Control': 'public, max-age=300, stale-while-revalidate=60',
    },
    body: html,
  };
}

/** Fallback response — still returns valid OG tags pointing at the site default */
function fallbackResponse(redirectUrl) {
  return buildResponse({ url: redirectUrl || PLATFORM_URL });
}

// ── Firestore data fetchers ───────────────────────────────────────────────────

/**
 * Product — looks up by slug field in the products collection.
 * Returns meta for the product page (/p.html?slug=<slug>).
 */
async function fetchProductMeta(db, slug) {
  const realUrl = `${PLATFORM_URL}/p.html?slug=${encodeURIComponent(slug)}`;
  try {
    const snap = await db
      .collection('products')
      .where('slug', '==', slug)
      .limit(1)
      .get();

    if (snap.empty) return fallbackResponse(realUrl);

    const p     = snap.docs[0].data();
    const uid   = p.uid || p.sellerUid || '';
    let sellerName = '';

    // Try to get seller display name for richer title
    if (uid) {
      try {
        const profileSnap = await db.collection('publicProfiles').doc(uid).get();
        if (profileSnap.exists) {
          const pd = profileSnap.data();
          sellerName = pd.displayName || pd.name || '';
        }
      } catch (_) { /* non-fatal — title degrades gracefully without seller name */ }
    }

    const title = sellerName
      ? `${p.title || 'Product'} — ${sellerName} | ${SITE_NAME}`
      : `${p.title || 'Product'} | ${SITE_NAME}`;

    return buildResponse({
      title,
      description : (p.description || `Buy "${p.title}" on ${SITE_NAME} — the global freelance marketplace.`).slice(0, 200),
      image       : p.coverUrl || FALLBACK_IMAGE,
      url         : realUrl,
      type        : 'product',
    });
  } catch (err) {
    console.error('[og-meta] fetchProductMeta error:', err.message);
    return fallbackResponse(realUrl);
  }
}

/**
 * Store — looks up publicProfiles by storeSlug field.
 * Returns meta for the store page (/store.html?storeSlug=<slug>).
 */
async function fetchStoreMeta(db, slug) {
  const realUrl = `${PLATFORM_URL}/store.html?storeSlug=${encodeURIComponent(slug)}`;
  try {
    // Try storeSettings.storeSlug first (newer format), then storeSlug (flat)
    let snap = await db
      .collection('publicProfiles')
      .where('storeSettings.storeSlug', '==', slug)
      .limit(1)
      .get();

    if (snap.empty) {
      snap = await db
        .collection('publicProfiles')
        .where('storeSlug', '==', slug)
        .limit(1)
        .get();
    }

    if (snap.empty) return fallbackResponse(realUrl);

    const d           = snap.docs[0].data();
    const displayName = d.displayName || d.name || 'Freelancer';
    const bio         = d.bio || d.description || `Browse ${displayName}'s services on ${SITE_NAME}.`;
    const photo       = d.photoURL || d.photoUrl || d.profilePhoto || FALLBACK_IMAGE;

    return buildResponse({
      title       : `${displayName} — ${SITE_NAME} Store`,
      description : String(bio).slice(0, 200),
      image       : photo,
      url         : realUrl,
      type        : 'profile',
    });
  } catch (err) {
    console.error('[og-meta] fetchStoreMeta error:', err.message);
    return fallbackResponse(realUrl);
  }
}

/**
 * Profile — looks up publicProfiles by uid directly.
 * Returns meta for the profile page (/profile.html?uid=<uid>).
 */
async function fetchProfileMeta(db, uid) {
  const realUrl = `${PLATFORM_URL}/profile.html?uid=${encodeURIComponent(uid)}`;
  try {
    const snap = await db.collection('publicProfiles').doc(uid).get();

    if (!snap.exists) return fallbackResponse(realUrl);

    const d           = snap.data();
    const displayName = d.displayName || d.name || 'Freelancer';
    const bio         = d.bio || d.description || d.title || `Hire ${displayName} on ${SITE_NAME}.`;
    const photo       = d.photoURL || d.photoUrl || d.profilePhoto || FALLBACK_IMAGE;

    return buildResponse({
      title       : `${displayName} | ${SITE_NAME}`,
      description : String(bio).slice(0, 200),
      image       : photo,
      url         : realUrl,
      type        : 'profile',
    });
  } catch (err) {
    console.error('[og-meta] fetchProfileMeta error:', err.message);
    return fallbackResponse(realUrl);
  }
}

// ── Handler ───────────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  const params = event.queryStringParameters || {};
  const type   = (params.type  || '').toLowerCase();
  const slug   = (params.slug  || '').trim();
  const uid    = (params.uid   || '').trim();

  // Must have a type
  if (!type) {
    return fallbackResponse(PLATFORM_URL);
  }

  let db;
  try {
    db = getDb();
  } catch (err) {
    console.error('[og-meta] Firebase init error:', err.message);
    return fallbackResponse(PLATFORM_URL);
  }

  if (type === 'product' && slug) return fetchProductMeta(db, slug);
  if (type === 'store'   && slug) return fetchStoreMeta(db, slug);
  if (type === 'profile' && uid)  return fetchProfileMeta(db, uid);

  // Unknown type or missing param — return site-level fallback
  return fallbackResponse(PLATFORM_URL);
};
