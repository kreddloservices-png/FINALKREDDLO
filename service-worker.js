/**
 * service-worker.js
 * Kreddlo PWA Service Worker
 * Handles install, fetch (cache strategy), activate (cleanup), and push events.
 */

const CACHE_NAME = 'kreddlo-v6';

const PRECACHE_URLS = [
  // Core shell
  '/',
  '/index.html',
  '/manifest.json',

  // Shared assets — cached once, used by every page
  '/assets/shared.js',
  '/assets/kreddlo-logo.png',
  '/assets/kreddlo-192.png',
  '/assets/kreddlo-512.png',
  '/assets/kreddlo-192-maskable.png',
  '/assets/kreddlo-512-maskable.png',

  // Key app shells — instant navigation after first visit
  '/browse.html',
  '/login.html',
  '/signup.html',
  '/dashboard.html',
  '/dashboard-products.html',
  '/dashboard-earnings.html',
  '/dashboard-projects.html',
  '/dashboard-invoices.html',
  '/dashboard-withdraw.html',
  '/buyer-dashboard.html',
  '/buyer-purchases.html',
  '/notifications.html',
  '/404.html',
  '/profile.html',
  '/dashboard-settings.html',
  '/dashboard-affiliate.html',
  '/pricing.html',
  '/store.html',
  '/invoice.html',
  '/course-viewer.html',


  // Fonts — eliminates font flash on repeat visits
  'https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap',
];

/* ── INSTALL: pre-cache core assets ── */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(PRECACHE_URLS);
    }).then(() => {
      // Force this SW to become active immediately
      return self.skipWaiting();
    })
  );
});

/* ── ACTIVATE: delete old caches ── */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
    }).then(() => {
      // Take control of all open clients immediately
      return self.clients.claim();
    })
  );
});

/* ── FETCH: routing strategy ── */
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Network-first: Netlify functions, Firestore, Firebase auth/API calls
  const isApiCall = (
    url.pathname.startsWith('/.netlify/functions/') ||
    url.hostname.includes('firestore.googleapis.com') ||
    url.hostname.includes('firebase') ||
    url.hostname.includes('identitytoolkit.googleapis.com') ||
    url.hostname.includes('securetoken.googleapis.com')
  );

  if (isApiCall) {
    event.respondWith(networkFirst(request));
    return;
  }

  // Network-first: HTML page navigations — must always be fresh so
  // auth redirects and post-login pages are never served stale from cache.
  const acceptHeader = request.headers.get('accept') || '';
  const isNavigation = request.mode === 'navigate' ||
    (request.method === 'GET' && acceptHeader.includes('text/html'));

  if (isNavigation) {
    event.respondWith(networkFirst(request));
    return;
  }

  // Cache-first: static assets (images, fonts, CDN JS/CSS)
  event.respondWith(cacheFirst(request));
});

/* ── Network-first strategy ── */
async function networkFirst(request) {
  try {
    const networkResponse = await fetch(request);
    // Cache successful responses
    if (networkResponse.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch (_err) {
    const cached = await caches.match(request);
    return cached || new Response('Offline', { status: 503 });
  }
}

/* ── Cache-first strategy ── */
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const networkResponse = await fetch(request);
    if (networkResponse.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch (_err) {
    return new Response('Offline', { status: 503 });
  }
}

/* ── PUSH: show notification ── */
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_) {
    data = { title: 'Kreddlo', body: event.data ? event.data.text() : 'You have a new notification.' };
  }

  const title   = data.title   || 'Kreddlo';
  const options = {
    body:  data.body  || '',
    icon:  '/assets/kreddlo-192.png',
    badge: '/assets/favicon-32x32.png',
    data:  { url: data.url || '/' },
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

/* ── NOTIFICATION CLICK: open deep-link URL ── */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const targetUrl = event.notification.data?.url || '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // Focus an existing tab if one is already open at this URL
      for (const client of clientList) {
        if (client.url === targetUrl && 'focus' in client) {
          return client.focus();
        }
      }
      // Otherwise open a new tab
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});
