/**
 * firebase-messaging-sw.js
 * Kreddlo — Firebase Cloud Messaging service worker
 *
 * Required by Firebase Messaging so getToken() can register a push subscription.
 * Must live at the project root (/firebase-messaging-sw.js).
 *
 * This file is completely independent of /service-worker.js (the PWA cache worker).
 * Neither file touches the other's behaviour.
 */

importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey:            'AIzaSyADHwnG1Im3IF5VetCilku1WeefjUR8Zkk',
  authDomain:        'kreddlo.firebaseapp.com',
  projectId:         'kreddlo',
  storageBucket:     'kreddlo.firebasestorage.app',
  messagingSenderId: '764500458567',
  appId:             '1:764500458567:web:2389d5cf8c688caafd0562',
});

const messaging = firebase.messaging();

/* ── Background message handler ── */
messaging.onBackgroundMessage(function(payload) {
  const title = (payload.notification && payload.notification.title) || 'Kreddlo';
  const body  = (payload.notification && payload.notification.body)  || '';
  const url   = (payload.data && payload.data.url) || '/';

  self.registration.showNotification(title, {
    body:  body,
    icon:  '/assets/kreddlo-192.png',
    badge: '/assets/favicon-32x32.png',
    data:  { url: url },
  });
});

/* ── Notification click: open deep-link URL ── */
self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  var targetUrl = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
      for (var i = 0; i < clientList.length; i++) {
        if (clientList[i].url === targetUrl && 'focus' in clientList[i]) {
          return clientList[i].focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});
