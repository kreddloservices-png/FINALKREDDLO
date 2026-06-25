/**
 * assets/shared.js
 * Kreddlo — Universal page script.
 * Loaded via <script src="/assets/shared.js"></script> in every page <head>.
 *
 * Responsibilities (in order):
 *   A. Favicon injection
 *   B. PWA manifest + Apple meta tags
 *   C. SEO config + applySEO()
 *   D. window.loadComponent()
 *   E. Auto component loading (navbar/footer or dashboard sidebar)
 *   F. Service worker registration
 *   G. FCM push token setup (dashboard pages only)
 *   H. Real-time notification bell dot (dashboard pages only)
 */

(function () {
  'use strict';

  /* ══════════════════════════════════════════════════════════════
     A. FAVICON INJECTION
     Injects link tags before DOMContentLoaded — browsers pick
     them up even if injected slightly after parse.
  ══════════════════════════════════════════════════════════════ */
  (function injectFavicons() {
    const favicons = [
      { rel: 'icon',             type: 'image/x-icon', href: '/assets/favicon.ico' },
      { rel: 'icon',             type: 'image/png',    href: '/assets/favicon-32x32.png', sizes: '32x32' },
      { rel: 'icon',             type: 'image/png',    href: '/assets/favicon-16x16.png', sizes: '16x16' },
      { rel: 'apple-touch-icon', type: null,           href: '/assets/apple-touch-icon.png', sizes: '180x180' },
    ];

    favicons.forEach(function (f) {
      // Skip if already present (prevents duplicates on re-injection)
      if (document.querySelector('link[href="' + f.href + '"]')) return;
      var el = document.createElement('link');
      el.rel  = f.rel;
      if (f.type)  el.type  = f.type;
      if (f.sizes) el.sizes = f.sizes;
      el.href = f.href;
      document.head.appendChild(el);
    });
  })();


  /* ══════════════════════════════════════════════════════════════
     B. PWA MANIFEST + APPLE META TAGS
  ══════════════════════════════════════════════════════════════ */
  (function injectPWA() {
    function addLink(rel, href) {
      if (document.querySelector('link[rel="' + rel + '"]')) return;
      var el = document.createElement('link');
      el.rel  = rel;
      el.href = href;
      document.head.appendChild(el);
    }

    function addMeta(name, content) {
      if (document.querySelector('meta[name="' + name + '"]')) return;
      var el = document.createElement('meta');
      el.name    = name;
      el.content = content;
      document.head.appendChild(el);
    }

    addLink('manifest', '/manifest.json');
    addMeta('apple-mobile-web-app-capable',          'yes');
    addMeta('apple-mobile-web-app-status-bar-style', 'black-translucent');
    addMeta('theme-color',                           '#0d2145');
  })();


  /* ══════════════════════════════════════════════════════════════
     C. SEO CONFIG + applySEO()
  ══════════════════════════════════════════════════════════════ */
  var PAGE_SEO = {
    '/': {
      title:       'Kreddlo - Global Freelance Payments for Verified Professionals',
      description: 'Kreddlo is the Fiverr and Upwork alternative built for global freelancers. Unlike Selar, Gumroad or Payhip, Kreddlo combines KYC verification, escrow contracts and automatic payouts — better than Payoneer or Wise for freelance income.',
      url:         'https://kreddlo.space/',
      type:        'website',
    },
    '/index.html': {
      title:       'Kreddlo - Global Freelance Payments for Verified Professionals',
      description: 'Kreddlo is the Fiverr and Upwork alternative built for global freelancers. Unlike Selar, Gumroad or Payhip, Kreddlo combines KYC verification, escrow contracts and automatic payouts — better than Payoneer or Wise for freelance income.',
      url:         'https://kreddlo.space/',
      type:        'website',
    },
    '/browse.html': {
      title:       'Browse Verified Freelancers - Kreddlo',
      description: 'Find KYC-verified freelancers across design, development, writing and marketing. A trusted Fiverr and Upwork alternative where every professional is identity-verified and paid faster than Payoneer, Wise or Paystack.',
      url:         'https://kreddlo.space/browse.html',
      type:        'website',
    },
    '/pricing.html': {
      title:       'Pricing and Fees - Kreddlo',
      description: 'Simple transparent pricing — lower fees than Fiverr, Upwork and Selar. No hidden charges like Payoneer or Wise. See exactly what freelancers and buyers pay. A fairer alternative to Flutterwave and Paystack for service payments.',
      url:         'https://kreddlo.space/pricing.html',
      type:        'website',
    },
    '/how-it-works.html': {
      title:       'How Kreddlo Works - Verified Global Freelance Payments',
      description: 'Kreddlo connects KYC-verified freelancers with global clients using escrow, digital contracts and automatic payouts. A better alternative to Fiverr, Upwork, Geegpay and Grey for professionals in underserved countries.',
      url:         'https://kreddlo.space/how-it-works.html',
      type:        'website',
    },
    '/about.html': {
      title:       'About Kreddlo - Built for Global Freelancers',
      description: 'Kreddlo was built to give talented freelancers the tools Fiverr, Upwork, Selar and Nestuge never provided — KYC-verified identity, escrow protection and payouts that work where Payoneer, Wise, Geegpay and Grey fall short.',
      url:         'https://kreddlo.space/about.html',
      type:        'website',
    },
    '/privacy.html': {
      title:       'Privacy Policy - Kreddlo',
      description: 'Learn how Kreddlo collects, uses and protects your personal data including identity verification documents and payment information.',
      url:         'https://kreddlo.space/privacy.html',
      type:        'website',
    },
    '/terms.html': {
      title:       'Terms of Service - Kreddlo',
      description: 'Read the Kreddlo terms of service covering platform rules, fees, dispute resolution and user responsibilities.',
      url:         'https://kreddlo.space/terms.html',
      type:        'website',
    },
    '/signup.html': {
      title:       'Create Your Free Account - Kreddlo',
      description: 'Join Kreddlo free and get verified to work with global clients. Get paid faster than Fiverr, Upwork, Selar or Selfany — without the payout limits of Payoneer, Wise, Flutterwave or Paystack.',
      url:         'https://kreddlo.space/signup.html',
      type:        'website',
    },
    '/login.html': {
      title:       'Log In - Kreddlo',
      description: 'Log in to your Kreddlo account to access your dashboard, contracts, earnings and withdrawal tools.',
      url:         'https://kreddlo.space/login.html',
      type:        'website',
    },
    '/store.html': {
      title:       'My Service Store - Kreddlo',
      description: 'Showcase and sell your freelance services on Kreddlo. A verified store that works better than Selar, Selfany or Nestuge — with built-in escrow, contracts and global client discovery.',
      url:         'https://kreddlo.space/store.html',
      type:        'website',
    },
    '/p.html': {
      title:       'Service Listing - Kreddlo',
      description: 'View this verified freelance service on Kreddlo. Hire a KYC-verified professional with secure escrow and guaranteed payouts — no Payoneer, Wise or Flutterwave limits.',
      url:         'https://kreddlo.space/p.html',
      type:        'product',
    },
    '/review.html': {
      title:       'Leave a Review - Kreddlo',
      description: 'Share your experience working with a Kreddlo freelancer. Your review helps build trust across the global freelance community.',
      url:         'https://kreddlo.space/review.html',
      type:        'website',
    },
    '/profile.html': {
      title:       'Freelancer Profile - Kreddlo',
      description: 'View this verified freelancer\'s profile on Kreddlo. Browse their portfolio, services and reviews. Hire with confidence using secure escrow — the better alternative to Fiverr and Upwork.',
      url:         'https://kreddlo.space/profile.html',
      type:        'profile',
    },
  };

  // Default OG image — create a 1200×630 branded image and host at this path.
  // Until then social shares will show no image; any image is better than none.
  var DEFAULT_OG_IMAGE = 'https://kreddlo.space/assets/og-image.png';

  /**
   * Sets a <meta> tag content by element ID.
   */
  function setMeta(id, content, attr) {
    attr = attr || 'content';
    var el = document.getElementById(id);
    if (el) el.setAttribute(attr, content);
  }

  /**
   * Upserts a <meta> tag by property or name attribute.
   * Creates it if it does not already exist in <head>.
   */
  function upsertMeta(attrName, attrValue, content) {
    var sel = 'meta[' + attrName + '="' + attrValue + '"]';
    var el = document.querySelector(sel);
    if (!el) {
      el = document.createElement('meta');
      el.setAttribute(attrName, attrValue);
      document.head.appendChild(el);
    }
    el.setAttribute('content', content);
  }

  /**
   * Injects or replaces the JSON-LD <script> block for structured data.
   * Google and AI crawlers read this first — it is the highest-value SEO tag.
   */
  function injectJSONLD(data) {
    var existing = document.getElementById('kreddlo-jsonld');
    if (existing) existing.parentNode.removeChild(existing);
    var script = document.createElement('script');
    script.type = 'application/ld+json';
    script.id   = 'kreddlo-jsonld';
    script.textContent = JSON.stringify(data);
    document.head.appendChild(script);
  }

  /**
   * window.applySEO(custom?)
   * Reads the current pathname, finds the matching PAGE_SEO entry,
   * optionally overrides with a custom object, then applies to the DOM.
   * Called automatically on every page load. Also exposed globally so
   * profile.html can call it with dynamic freelancer data after a
   * Firestore fetch.
   *
   * @param {Object} [custom] - optional override:
   *   { title, description, url, image, type, jsonld }
   *   - image:  full URL to a 1200×630 image (overrides DEFAULT_OG_IMAGE)
   *   - type:   og:type string e.g. 'profile', 'product', 'website'
   *   - jsonld: a ready-made JSON-LD object (skips auto-generation)
   */
  function applySEO(custom) {
    var pathname = window.location.pathname;
    if (pathname !== '/' && pathname.endsWith('/')) {
      pathname = pathname.slice(0, -1);
    }

    var base = PAGE_SEO[pathname] || PAGE_SEO['/'];

    var config = {
      title:       (custom && custom.title)       || base.title,
      description: (custom && custom.description) || base.description,
      url:         (custom && custom.url)         || base.url,
      image:       (custom && custom.image)       || DEFAULT_OG_IMAGE,
      type:        (custom && custom.type)        || base.type  || 'website',
      jsonld:      (custom && custom.jsonld)      || null,
    };

    /* ── 1. document.title ── */
    document.title = config.title;

    /* ── 2. Meta description (ID-based, already in <head>) ── */
    setMeta('meta-description', config.description);

    /* ── 3. Open Graph — upsert so missing tags are created automatically ── */
    upsertMeta('property', 'og:title',       config.title);
    upsertMeta('property', 'og:description', config.description);
    upsertMeta('property', 'og:url',         config.url);
    upsertMeta('property', 'og:type',        config.type);
    upsertMeta('property', 'og:image',       config.image);
    upsertMeta('property', 'og:image:width',  '1200');
    upsertMeta('property', 'og:image:height', '630');
    upsertMeta('property', 'og:site_name',   'Kreddlo');

    /* ── 4. Twitter Card ── */
    upsertMeta('name', 'twitter:card',        'summary_large_image');
    upsertMeta('name', 'twitter:site',        '@kreddlo');
    upsertMeta('name', 'twitter:title',       config.title);
    upsertMeta('name', 'twitter:description', config.description);
    upsertMeta('name', 'twitter:image',       config.image);

    /* ── 5. Canonical ── */
    setMeta('canonical', config.url, 'href');

    /* ── 6. JSON-LD structured data ── */
    var jsonld = config.jsonld;

    if (!jsonld) {
      // Auto-generate appropriate schema based on page type
      if (config.type === 'profile' && custom && custom.name) {
        // Freelancer profile page — Person + ProfilePage schema
        jsonld = {
          '@context': 'https://schema.org',
          '@type':    'ProfilePage',
          'name':     config.title,
          'url':      config.url,
          'mainEntity': {
            '@type':       'Person',
            'name':        custom.name,
            'url':         config.url,
            'description': config.description,
            'image':       config.image,
            'worksFor': {
              '@type': 'Organization',
              'name':  'Kreddlo',
              'url':   'https://kreddlo.space',
            },
          },
        };
      } else if (config.type === 'product' && custom && custom.name) {
        // Service/product listing page
        jsonld = {
          '@context':   'https://schema.org',
          '@type':      'Service',
          'name':        custom.name || config.title,
          'description': config.description,
          'url':         config.url,
          'image':       config.image,
          'provider': {
            '@type': 'Organization',
            'name':  'Kreddlo',
            'url':   'https://kreddlo.space',
          },
        };
      } else {
        // Default: WebSite + Organization for public pages
        jsonld = {
          '@context': 'https://schema.org',
          '@graph': [
            {
              '@type': 'WebSite',
              '@id':   'https://kreddlo.space/#website',
              'url':   'https://kreddlo.space',
              'name':  'Kreddlo',
              'description': 'Global verified freelance marketplace and payment platform',
              'potentialAction': {
                '@type':       'SearchAction',
                'target':      'https://kreddlo.space/browse.html?q={search_term_string}',
                'query-input': 'required name=search_term_string',
              },
            },
            {
              '@type':       'Organization',
              '@id':         'https://kreddlo.space/#organization',
              'name':        'Kreddlo',
              'url':         'https://kreddlo.space',
              'logo':        'https://kreddlo.space/assets/logo.png',
              'description': 'Kreddlo is a verified global freelance marketplace and payment platform — the Fiverr and Upwork alternative for professionals in underserved countries.',
              'sameAs': [
                'https://twitter.com/kreddlo',
              ],
            },
            {
              '@type':           'WebPage',
              '@id':             config.url + '#webpage',
              'url':             config.url,
              'name':            config.title,
              'description':     config.description,
              'isPartOf':        { '@id': 'https://kreddlo.space/#website' },
              'inLanguage':      'en',
            },
          ],
        };
      }
    }

    injectJSONLD(jsonld);
  }

  // Expose globally for pages with dynamic SEO (e.g. profile.html)
  window.applySEO = applySEO;

  // Auto-apply on every page load
  applySEO();


  /* ══════════════════════════════════════════════════════════════
     D. window.loadComponent(targetId, filePath)
     Fetches an HTML partial and injects it into a target element.
     Also evaluates any <script> tags in the fetched HTML.
  ══════════════════════════════════════════════════════════════ */
  function loadComponent(targetId, filePath) {
    return fetch(filePath)
      .then(function (res) {
        if (!res.ok) {
          throw new Error('loadComponent: failed to fetch ' + filePath + ' (' + res.status + ')');
        }
        return res.text();
      })
      .then(function (html) {
        var target = document.getElementById(targetId);
        if (!target) {
          console.warn('loadComponent: element #' + targetId + ' not found on this page.');
          return;
        }
        target.innerHTML = html;

        // Re-execute any <script> tags in the injected HTML
        // (innerHTML does not execute scripts automatically)
        var scripts = target.querySelectorAll('script');
        scripts.forEach(function (oldScript) {
          var newScript = document.createElement('script');
          // Copy attributes (e.g. type, src)
          Array.from(oldScript.attributes).forEach(function (attr) {
            newScript.setAttribute(attr.name, attr.value);
          });
          newScript.textContent = oldScript.textContent;
          document.body.appendChild(newScript);
          oldScript.parentNode.removeChild(oldScript);
        });
      })
      .catch(function (err) {
        console.error(err.message);
      });
  }

  window.loadComponent = loadComponent;


  /* ══════════════════════════════════════════════════════════════
     E. AUTO COMPONENT LOADING
     Runs after DOMContentLoaded so placeholder elements exist.
     - Dashboard / buyer / admin / notifications pages:
         loads dashboard-sidebar.html → #sidebar-placeholder
         loads bottom-tab.html       → #bottom-tab-placeholder
     - All other pages:
         loads navbar.html  → #navbar-placeholder
         loads footer.html  → #footer-placeholder
  ══════════════════════════════════════════════════════════════ */
  document.addEventListener('DOMContentLoaded', function () {

    var path = window.location.pathname.toLowerCase();

    var isDashboard = (
      path.includes('dashboard') ||
      path.includes('buyer')     ||
      path.includes('admin')     ||
      path.includes('notifications')
    );

    if (isDashboard) {
      // Dashboard layout components
      if (document.getElementById('sidebar-placeholder')) {
        loadComponent('sidebar-placeholder', '/components/dashboard-sidebar.html');
      }
      if (document.getElementById('bottom-tab-placeholder')) {
        loadComponent('bottom-tab-placeholder', '/components/bottom-tab.html');
      }
    } else {
      // Public page components
      if (document.getElementById('navbar-placeholder')) {
        loadComponent('navbar-placeholder', '/components/navbar.html');
      }
      if (document.getElementById('footer-placeholder')) {
        loadComponent('footer-placeholder', '/components/footer.html');
      }
    }

    /* ── F. SERVICE WORKER REGISTRATION ── */
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/service-worker.js')
        .then(function (reg) {
          console.log('Kreddlo SW registered — scope:', reg.scope);
        })
        .catch(function (err) {
          console.warn('Kreddlo SW registration failed:', err.message);
        });
    }

    /* ── G + H. FCM + BELL DOT — dashboard pages only ── */
    if (isDashboard) {
      setupFCMAndBell();
    }

  });


  /* ══════════════════════════════════════════════════════════════
     G. FCM PUSH TOKEN SETUP
     Requests notification permission, gets the FCM token via
     window.fs* helpers (exposed from each page's module script),
     compares with the stored token in Firestore, updates if changed.

     H. REAL-TIME NOTIFICATION BELL DOT
     Sets up a Firestore onSnapshot listener on the current user's
     notifications subcollection (unread only, limit 1).
     Shows/hides the red dot on #bell-dot in real time.
  ══════════════════════════════════════════════════════════════ */
  function setupFCMAndBell() {
    // Firebase is initialized in the page <head> and exposed on window.
    // We wait for auth state to confirm before touching Firestore.
    var authReady = setInterval(function () {
      if (
        typeof window.auth === 'undefined' ||
        typeof window.db   === 'undefined'
      ) {
        return; // Firebase not ready yet — keep waiting
      }

      clearInterval(authReady);
      clearTimeout(authReadyBailout);

      window.onAuthStateChanged(window.auth, function (user) {
        if (!user) return; // Not logged in — nothing to do

        var uid = user.uid;

        /* ── H. Bell dot listener ── */
        var notifQuery = window.fsQuery(
          window.fsCollection(window.db, 'users', uid, 'notifications'),
          window.fsWhere('read', '==', false),
          window.fsLimit(1)
        );

        window.fsOnSnapshot(notifQuery, function (snapshot) {
          var bellDot = document.getElementById('bell-dot');
          if (!bellDot) return;
          bellDot.style.display = snapshot.empty ? 'none' : 'block';
        });

        /* ── G. FCM token setup ── */
        setupFCMToken(uid);
      });

    }, 100); // poll every 100ms until Firebase is ready

    // Bail out after 10 s — prevents infinite loop if Firebase never initialises
    var authReadyBailout = setTimeout(function () {
      clearInterval(authReady);
      console.warn('shared.js: Firebase not ready after 10 s — bell dot and FCM skipped.');
    }, 10000);
  }

  function setupFCMToken(uid) {
    // Only proceed if the browser supports notifications
    if (!('Notification' in window)) return;
    if (typeof window.messaging === 'undefined') return;

    var VAPID_KEY = typeof window.KREDDLO_VAPID_PUBLIC_KEY !== 'undefined'
      ? window.KREDDLO_VAPID_PUBLIC_KEY
      : ''; // window.KREDDLO_VAPID_PUBLIC_KEY is defined further down in this file

    if (!VAPID_KEY) {
      console.warn('shared.js: KREDDLO_VAPID_PUBLIC_KEY not set — skipping FCM token setup.');
      return;
    }

    Notification.requestPermission()
      .then(function (permission) {
        if (permission !== 'granted') {
          console.log('shared.js: Notification permission denied.');
          return;
        }

        // Resolve the already-registered service worker so getToken() can use
        // it. Without this, FCM tries to auto-register /firebase-messaging-sw.js
        // which conflicts with the existing /service-worker.js at scope '/'.
        var tokenPromise;
        if ('serviceWorker' in navigator) {
          tokenPromise = navigator.serviceWorker.ready.then(function(swReg) {
            return window.fsGetToken(window.messaging, {
              vapidKey:                    VAPID_KEY,
              serviceWorkerRegistration:   swReg,
            });
          }).catch(function() {
            // SW not available — fall back without SW registration
            return window.fsGetToken(window.messaging, { vapidKey: VAPID_KEY });
          });
        } else {
          tokenPromise = Promise.resolve(
            window.fsGetToken(window.messaging, { vapidKey: VAPID_KEY })
          );
        }
        return tokenPromise;
      })
      .then(function (newToken) {
        if (!newToken) return;

        // Compare with the stored token; only write if different
        return window.fsGetDoc(
          window.fsDoc(window.db, 'users', uid)
        ).then(function (snap) {
          var existingToken = snap.exists() ? (snap.data().fcmToken || '') : '';
          if (newToken === existingToken) return; // already up to date

          return window.fsSetDoc(
            window.fsDoc(window.db, 'users', uid),
            { fcmToken: newToken },
            { merge: true }
          ).then(function () {
            console.log('shared.js: FCM token updated in Firestore.');
          });
        });
      })
      .catch(function (err) {
        // Non-fatal — never interrupt the page
        console.warn('shared.js: FCM token setup failed:', err.message);
      });
  }

})(); // end IIFE


/* ══════════════════════════════════════════════════════════════
   AFFILIATE REF CAPTURE
   Runs on every page load. If a ?ref=USERID param is present in
   the URL, it is stored in localStorage under 'kreddlo_affiliate_ref'
   with a 30-day expiry timestamp. Checkout pages read this value
   and pass it to create-product-order so commissions are attributed.
══════════════════════════════════════════════════════════════ */
(function captureAffiliateRef() {
  try {
    var params = new URLSearchParams(window.location.search);
    var ref    = params.get('ref');

    if (ref && typeof ref === 'string' && ref.trim().length > 0) {
      var refData = {
        ref:       ref.trim(),
        expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000, // 30 days from now
      };
      localStorage.setItem('kreddlo_affiliate_ref', JSON.stringify(refData));
    }
  } catch (e) {
    // Non-fatal — localStorage may be unavailable in private mode on some browsers
    console.warn('shared.js: affiliate ref capture failed:', e.message);
  }
})();

/**
 * getStoredAffiliateRef()
 * Returns the stored affiliate ref string if it exists and has not expired.
 * Returns null if absent or expired (and clears expired entries).
 * Exposed globally so checkout pages can call it before submitting orders.
 *
 * @returns {string|null}
 */
window.getStoredAffiliateRef = function getStoredAffiliateRef() {
  try {
    var raw = localStorage.getItem('kreddlo_affiliate_ref');
    if (!raw) return null;

    var data = JSON.parse(raw);
    if (!data || !data.ref || !data.expiresAt) {
      localStorage.removeItem('kreddlo_affiliate_ref');
      return null;
    }

    if (Date.now() > data.expiresAt) {
      // Expired — clean up and return null
      localStorage.removeItem('kreddlo_affiliate_ref');
      return null;
    }

    return data.ref;
  } catch (e) {
    console.warn('shared.js: getStoredAffiliateRef failed:', e.message);
    return null;
  }
};

// ── Centralised VAPID public key ─────────────────────────────────────────────
// Used by dashboard.html and dashboard-settings.html for FCM push notifications.
// Source: Firebase Console → Project Settings → Cloud Messaging → Web Push certificates
window.KREDDLO_VAPID_PUBLIC_KEY = 'BAMBTh5A3sX4MsxQD1xlJwgLrFR9bYs-IXJ4Xoq-Orn1gByn81_qvD2lTtbkM1R328JqXe63veD3fyK1ulPDb1c';


/* =============================================================
   SHARED CURRENCY DISPLAY UTILITIES
   Single source of truth for balance rendering across all
   dashboard pages (dashboard.html, dashboard-earnings.html,
   dashboard-withdraw.html, dashboard-affiliate.html).

   Design rules (mobile-first):
   - 1 currency  -> big bold number, full width, no extra UI
   - 2 currencies -> primary (largest) shown big + 1 inline chip
   - 3+ currencies -> primary big + MAX_INLINE inline chips +
     "+N more" chip that opens a floating dropdown panel
     listing every overflow currency. The dropdown is
     position:absolute so it NEVER shifts sibling cards.
     Max-height 240px with touch scroll, 44px min row height.
   - Works at 320px+, no font-shrinking, no text overflow.
============================================================= */
window.kreddloCurrency = (function() {
  'use strict';

  var MAX_INLINE = 2; // max secondary chips shown inline before overflow dropdown

  /* -- fmtCurrency -------------------------------------------
     Formats a number as a currency string using Intl.NumberFormat.
     Falls back gracefully for unsupported currency codes.
  ------------------------------------------------------------ */
  function fmtCurrency(amount, currency) {
    try {
      return new Intl.NumberFormat('en', {
        style: 'currency',
        currency: currency || 'USD',
        maximumFractionDigits: 2
      }).format(Number(amount) || 0);
    } catch(e) {
      return (currency || 'USD') + ' ' + Number(amount || 0).toFixed(2);
    }
  }

  /* -- _closeCurrencyDropdown --------------------------------
     Closes a dropdown by id with a fade+slide-up transition.
  ------------------------------------------------------------ */
  function _closeCurrencyDropdown(dropId, chipId) {
    var drop = document.getElementById(dropId);
    var chip = document.getElementById(chipId);
    if (drop) {
      drop.style.opacity = '0';
      drop.style.transform = 'translateY(-6px)';
      setTimeout(function() {
        var el = document.getElementById(dropId);
        if (el) el.style.display = 'none';
      }, 150);
    }
    if (chip) chip.setAttribute('aria-expanded', 'false');
  }

  /* -- _toggleCurrencyDropdown -------------------------------
     Toggles a dropdown. Closes all other open kcc dropdowns
     on the page first to keep only one open at a time.
  ------------------------------------------------------------ */
  function _toggleCurrencyDropdown(dropId, chipId) {
    // Close every other open kcc dropdown
    var allDrops = document.querySelectorAll('[data-kcc-drop="1"]');
    for (var i = 0; i < allDrops.length; i++) {
      if (allDrops[i].id !== dropId) {
        _closeCurrencyDropdown(allDrops[i].id, allDrops[i].getAttribute('data-chip-id'));
      }
    }

    var drop = document.getElementById(dropId);
    var chip = document.getElementById(chipId);
    if (!drop) return;

    var isOpen = drop.style.display !== 'none' && drop.style.display !== '';
    if (isOpen) {
      _closeCurrencyDropdown(dropId, chipId);
      return;
    }

    // Open
    drop.style.display = 'block';
    drop.getBoundingClientRect(); // force reflow so transition fires
    drop.style.opacity = '1';
    drop.style.transform = 'translateY(0)';
    if (chip) chip.setAttribute('aria-expanded', 'true');

    // Outside-click handler (one-shot, capture phase)
    function outsideHandler(e) {
      var el = document.getElementById(dropId);
      var chipEl = document.getElementById(chipId);
      if (!el) { document.removeEventListener('click', outsideHandler, true); return; }
      if (!el.contains(e.target) && (!chipEl || !chipEl.contains(e.target))) {
        _closeCurrencyDropdown(dropId, chipId);
        document.removeEventListener('click', outsideHandler, true);
      }
    }
    setTimeout(function() {
      document.addEventListener('click', outsideHandler, true);
    }, 0);

    // Escape key handler
    function escHandler(e) {
      if (e.key === 'Escape') {
        _closeCurrencyDropdown(dropId, chipId);
        document.removeEventListener('keydown', escHandler);
      }
    }
    document.addEventListener('keydown', escHandler);
  }

  // Expose toggle globally so inline onclick handlers can reach it
  window._kccToggleDrop = _toggleCurrencyDropdown;

  /* -- renderBalanceCard -------------------------------------
     Returns an HTML string for injecting into a stat card's
     value slot (the big number area).

     Single currency  -> plain big number, no chrome.
     2 currencies     -> primary big + 1 inline tap-chip.
     3+ currencies    -> primary big + MAX_INLINE inline chips
                         + "+N more" chip -> floating dropdown
                         listing all overflow currencies.

     The wrapper uses position:relative so the absolute dropdown
     never shifts page layout.

     @param {Object}  map        { 'NGN': 12000, 'USD': 45.50 }
     @param {Object}  [opts]
       primaryColor  CSS color for the primary number
       chipBg        chip background color
       chipColor     chip text/icon color
       zeroCurrency  currency shown when map is empty
  ------------------------------------------------------------ */
  function renderBalanceCard(map, opts) {
    opts = opts || {};
    var primaryColor = opts.primaryColor || 'inherit';
    var chipBg       = opts.chipBg       || 'rgba(13,33,69,0.07)';
    var chipColor    = opts.chipColor    || 'rgba(13,33,69,0.65)';
    var zeroCur      = opts.zeroCurrency || 'USD';

    var keys = Object.keys(map || {}).filter(function(c) {
      return Number(map[c]) > 0;
    });

    // Empty map
    if (!keys.length) {
      return '<span style="color:' + primaryColor + ';">' + fmtCurrency(0, zeroCur) + '</span>';
    }

    // Single currency
    if (keys.length === 1) {
      return '<span style="color:' + primaryColor + ';">' + fmtCurrency(map[keys[0]], keys[0]) + '</span>';
    }

    // Multi-currency: sort desc by amount; primary = largest
    keys.sort(function(a, b) { return Number(map[b]) - Number(map[a]); });
    var primary      = keys[0];
    var secondaries  = keys.slice(1);

    // Unique id prefix prevents collisions when multiple cards on one page
    var uid          = 'kcc-' + Math.random().toString(36).slice(2, 8);
    var inlineKeys   = secondaries.slice(0, MAX_INLINE);
    var overflowKeys = secondaries.slice(MAX_INLINE);
    var hasOverflow  = overflowKeys.length > 0;

    // Inline chips (always visible)
    var inlineChipsHtml = inlineKeys.map(function(cur, i) {
      var chipId   = uid + '-ic' + i;
      var revealId = uid + '-ir' + i;
      return (
        '<span id="' + chipId + '" role="button" tabindex="0" ' +
          'aria-label="' + cur + ' balance" ' +
          'style="display:inline-flex;align-items:center;gap:4px;' +
            'background:' + chipBg + ';border-radius:20px;' +
            'padding:4px 10px 4px 8px;margin:4px 4px 0 0;' +
            'cursor:pointer;user-select:none;' +
            'border:1px solid rgba(13,33,69,0.10);' +
            'transition:background .15s,border-color .15s;' +
            'min-height:32px;box-sizing:border-box;" ' +
          'onclick="(function(btn,rev){' +
            'var open=rev.style.display!==\'none\';' +
            'rev.style.display=open?\'none\':\'\';' +
            'btn.style.background=open?\'' + chipBg + '\':\'' + 'rgba(45,138,94,0.12)\';' +
            'btn.style.borderColor=open?\'rgba(13,33,69,0.10)\':\'' + 'rgba(45,138,94,0.30)\';' +
          '})(document.getElementById(\'' + chipId + '\'),document.getElementById(\'' + revealId + '\'))" ' +
          'onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();this.click();}">' +
          '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="' + chipColor + '" stroke-width="2.5" stroke-linecap="round" style="flex-shrink:0;"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>' +
          '<span style="font-size:11px;font-weight:700;color:' + chipColor + ';letter-spacing:.3px;">' + cur + '</span>' +
          '<svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="' + chipColor + '" stroke-width="2.5" stroke-linecap="round" style="flex-shrink:0;"><polyline points="6 9 12 15 18 9"/></svg>' +
        '</span>' +
        '<span id="' + revealId + '" ' +
          'style="display:none;font-size:13px;font-weight:700;color:#2d8a5e;' +
            'background:rgba(45,138,94,0.06);border-radius:20px;' +
            'padding:4px 10px;margin:4px 4px 0 0;' +
            'white-space:nowrap;min-height:32px;' +
            'align-items:center;box-sizing:border-box;">' +
          fmtCurrency(map[cur], cur) +
        '</span>'
      );
    }).join('');

    // "+N more" chip + floating dropdown (only when overflow exists)
    var moreHtml = '';
    if (hasOverflow) {
      var dropId     = uid + '-drop';
      var moreChipId = uid + '-more';
      var overCount  = overflowKeys.length;

      var dropRows = overflowKeys.map(function(cur) {
        return (
          '<div style="display:flex;align-items:center;justify-content:space-between;' +
            'padding:10px 14px;min-height:44px;box-sizing:border-box;' +
            'border-bottom:1px solid rgba(13,33,69,0.06);" role="option">' +
            '<span style="display:inline-flex;align-items:center;gap:6px;">' +
              '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="rgba(13,33,69,0.45)" stroke-width="2.5" stroke-linecap="round" style="flex-shrink:0;"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>' +
              '<span style="font-size:12px;font-weight:700;color:rgba(13,33,69,0.55);letter-spacing:.4px;">' + cur + '</span>' +
            '</span>' +
            '<span style="font-size:14px;font-weight:800;color:#0d2145;letter-spacing:-.3px;">' + fmtCurrency(map[cur], cur) + '</span>' +
          '</div>'
        );
      }).join('');

      var dropPanel = (
        '<div id="' + dropId + '" ' +
          'data-kcc-drop="1" data-chip-id="' + moreChipId + '" ' +
          'role="listbox" aria-label="Other currency balances" ' +
          'style="display:none;position:absolute;left:0;right:0;top:calc(100% + 6px);' +
            'z-index:9999;' +
            'background:#fff;' +
            'border:1px solid rgba(13,33,69,0.12);' +
            'border-radius:14px;' +
            'box-shadow:0 8px 32px rgba(13,33,69,0.14),0 2px 8px rgba(13,33,69,0.08);' +
            'overflow:hidden;' +
            'max-height:240px;overflow-y:auto;-webkit-overflow-scrolling:touch;' +
            'opacity:0;transform:translateY(-6px);' +
            'transition:opacity .15s ease,transform .15s ease;">' +
          '<div style="padding:10px 14px 6px;border-bottom:1px solid rgba(13,33,69,0.07);">' +
            '<span style="font-size:10px;font-weight:700;color:rgba(13,33,69,0.40);' +
              'letter-spacing:.6px;text-transform:uppercase;">Other Balances</span>' +
          '</div>' +
          dropRows +
        '</div>'
      );

      moreHtml = (
        '<span id="' + moreChipId + '" role="button" tabindex="0" ' +
          'aria-expanded="false" aria-haspopup="listbox" aria-controls="' + dropId + '" ' +
          'style="display:inline-flex;align-items:center;gap:4px;' +
            'background:rgba(13,33,69,0.07);border-radius:20px;' +
            'padding:4px 10px;margin:4px 0 0 0;' +
            'cursor:pointer;user-select:none;' +
            'border:1px solid rgba(13,33,69,0.10);' +
            'transition:background .15s,border-color .15s;' +
            'min-height:32px;box-sizing:border-box;white-space:nowrap;" ' +
          'onclick="_kccToggleDrop(\'' + dropId + '\',\'' + moreChipId + '\')" ' +
          'onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();_kccToggleDrop(\'' + dropId + '\',\'' + moreChipId + '\');}">' +
          '<span style="font-size:11px;font-weight:700;color:rgba(13,33,69,0.65);letter-spacing:.3px;">+' + overCount + ' more</span>' +
          '<svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="rgba(13,33,69,0.55)" stroke-width="2.5" stroke-linecap="round" style="flex-shrink:0;"><polyline points="6 9 12 15 18 9"/></svg>' +
        '</span>' +
        dropPanel
      );
    }

    // Assemble: position:relative wrapper scopes the absolute dropdown
    return (
      '<div style="position:relative;">' +
        '<span style="display:block;font-size:inherit;color:' + primaryColor + ';">' +
          fmtCurrency(map[primary], primary) +
        '</span>' +
        '<div style="display:flex;flex-wrap:wrap;align-items:center;margin-top:4px;line-height:1;font-size:0;">' +
          inlineChipsHtml +
          moreHtml +
        '</div>' +
      '</div>'
    );
  }

  /* -- renderCompactMulti ------------------------------------
     For tight single-line contexts (This Month earned/withdrawn).
     Single currency = plain text.
     Multi-currency = stacked right-aligned column, each line
     full-size and clearly labeled, no font-shrinking.

     @param {Object}  map      { 'NGN': 3000, 'USD': 12 }
     @param {string}  [color]  optional CSS color for all lines
  ------------------------------------------------------------ */
  function renderCompactMulti(map, color) {
    var keys = Object.keys(map || {}).filter(function(c) {
      return Number(map[c]) !== 0;
    });
    if (!keys.length) return fmtCurrency(0, 'USD');
    var style = color ? 'color:' + color + ';' : '';
    if (keys.length === 1) {
      return '<span style="' + style + '">' + fmtCurrency(map[keys[0]], keys[0]) + '</span>';
    }
    return (
      '<span style="display:flex;flex-direction:column;align-items:flex-end;gap:3px;">' +
      keys.map(function(cur) {
        return (
          '<span style="font-size:13px;font-weight:700;white-space:nowrap;' + style + '">' +
            fmtCurrency(map[cur], cur) +
          '</span>'
        );
      }).join('') +
      '</span>'
    );
  }

  return {
    fmt:            fmtCurrency,
    renderCard:     renderBalanceCard,
    renderCompact:  renderCompactMulti
  };

})();
