// ══════════════════════════════════════════════════════════════════
// firebase-messaging-sw.js — Background Notification Handler
// Place this file in the ROOT directory of your app
// ══════════════════════════════════════════════════════════════════

importScripts('https://www.gstatic.com/firebasejs/12.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/12.12.0/firebase-messaging-compat.js');

// ═══ FIREBASE CONFIG ═══
// ⚠️ REPLACE with your Firebase project config
firebase.initializeApp({
  apiKey: "AIzaSyDYUm3VV8iuLHQKJuU9fWgaRaYU0t5Dlzk",
  authDomain: "nearpop-a432d.firebaseapp.com",
  projectId: "nearpop-a432d",
  storageBucket: "nearpop-a432d.firebasestorage.app",
  messagingSenderId: "265333242320",
  appId: "1:265333242320:web:f2cedec620ef08d4e161d5",
  measurementId: "G-71Y2Y75FLQ"
});

const messaging = firebase.messaging();

// ═══ BACKGROUND MESSAGE HANDLER ═══
// Handles notifications when app is in background or closed
messaging.onBackgroundMessage((payload) => {
  console.log('[SW] Background message received:', payload);

  const notificationTitle = payload.notification?.title || 'NearPop';
  const notificationBody = payload.notification?.body || 'New deal nearby!';
  const dealId = payload.data?.dealId;

  const notificationOptions = {
    body: notificationBody,
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-72.png',
    tag: dealId || 'nearpop-notification',
    data: {
      dealId: dealId,
      url: dealId ? `/detail.html?id=${dealId}` : '/map.html',
      ...payload.data
    },
    vibrate: [200, 100, 200],
    requireInteraction: false,
    silent: false,
    actions: [
      { action: 'view', title: '👁️ View Deal', icon: '/icons/view-icon.png' },
      { action: 'dismiss', title: '✕ Dismiss' }
    ]
  };

  return self.registration.showNotification(notificationTitle, notificationOptions);
});

// ═══ NOTIFICATION CLICK HANDLER ═══
self.addEventListener('notificationclick', (event) => {
  console.log('[SW] Notification clicked:', event);
  
  event.notification.close();

  const urlToOpen = event.notification.data?.url || '/map.html';

  if (event.action === 'dismiss') {
    // User dismissed - do nothing
    return;
  }

  // Open or focus the app
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        // Check if app is already open
        for (let i = 0; i < clientList.length; i++) {
          const client = clientList[i];
          if (client.url.includes(self.registration.scope) && 'focus' in client) {
            // Focus existing window and navigate
            return client.focus().then(client => {
              if ('navigate' in client) {
                return client.navigate(urlToOpen);
              }
            });
          }
        }
        
        // No existing window - open new one
        if (clients.openWindow) {
          return clients.openWindow(urlToOpen);
        }
      })
  );
});

// ═══ NOTIFICATION CLOSE HANDLER ═══
self.addEventListener('notificationclose', (event) => {
  console.log('[SW] Notification closed:', event);
  
  // Track notification dismissal (optional)
  // You can add analytics here
});

// ═══ PUSH EVENT HANDLER (Fallback) ═══
self.addEventListener('push', (event) => {
  console.log('[SW] Push event received:', event);

  if (event.data) {
    const data = event.data.json();
    const title = data.notification?.title || 'NearPop';
    const options = {
      body: data.notification?.body || 'New deal nearby!',
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-72.png',
      data: data.data || {}
    };

    event.waitUntil(
      self.registration.showNotification(title, options)
    );
  }
});

console.log('[SW] Firebase Messaging Service Worker loaded');
