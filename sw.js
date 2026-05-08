importScripts('https://www.gstatic.com/firebasejs/12.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/12.12.0/firebase-messaging-compat.js');

// 🚀 Initialize Firebase in the Service Worker
firebase.initializeApp({
  apiKey: "AIzaSyDYUm3VV8iuLHQKJuU9fWgaRaYU0t5Dlzk",
  authDomain: "nearpop-a432d.firebaseapp.com",
  projectId: "nearpop-a432d",
  storageBucket: "nearpop-a432d.firebasestorage.app",
  messagingSenderId: "265333242320",
  appId: "1:265333242320:web:f2cedec620ef08d4e161d5"
});

const messaging = firebase.messaging();

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 🚀 SMART NOTIFICATION COOLDOWN ENGINE
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function canShowNotification(notificationId) {
  const COOLDOWN_MS = 60 * 60 * 1000; // 1 hour
  const cache = await caches.open('nearpop-cooldowns');
  const cacheKey = `/cooldown/${notificationId}`;
  
  const existingRecord = await cache.match(cacheKey);
  if (existingRecord) {
    const lastPing = await existingRecord.json();
    if (Date.now() - lastPing < COOLDOWN_MS) {
      return false; 
    }
  }
  
  await cache.put(cacheKey, new Response(JSON.stringify(Date.now())));
  return true;
}

// 🚀 THE UNIFIED BACKGROUND MESSAGE HANDLER (Data-Only Safe)
messaging.onBackgroundMessage((payload) => {
  return (async () => {
    console.log('[sw.js] Received background message ', payload);

    const entityId = payload.data?.merchantId || 'general_alert';
    const isAllowed = await canShowNotification(entityId);
    
    if (isAllowed) {
      const notificationTitle = payload.data?.title || payload.notification?.title || 'NearPop Update!';
      
      const notificationOptions = {
        body: payload.data?.body || payload.notification?.body || 'Tap to see details.',
        icon: '/icons/icon-192.png',
        badge: '/icons/badge-96.png',
        vibrate: [500, 250, 500, 250, 1000, 250, 1000], 
        data: { 
          ...payload.data,
          url: payload.data?.url || payload.fcmOptions?.link || '/map.html' 
        },
        requireInteraction: true 
      };
      
      return self.registration.showNotification(notificationTitle, notificationOptions);
    } else {
      console.log(`Notification blocked: ${entityId} is in 1-hour cooldown.`);
    }
  })();
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/map.html';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      for (let client of windowClients) {
        if (client.url.includes(targetUrl) && 'focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 🚀 THE SMART CACHE ENGINE (TWA Optimized)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const CACHE_NAME = 'nearpop-v1'; 
const MAP_CACHE = 'nearpop-maps-v1';
const IMG_CACHE = 'nearpop-images-v1';

const ASSETS = [
  '/',
  '/index.html',
  '/map.html',
  '/detail.html',
  '/store.html',
  '/profile.html',
  '/css/shared.css',
  '/js/app.js',
  '/js/notifications.js',
  '/js/geohash.js',
  '/js/userSync.js'
];

const limitCacheSize = (name, size) => {
  caches.open(name).then(cache => {
    cache.keys().then(keys => {
      if (keys.length > size) {
        cache.delete(keys[0]).then(() => limitCacheSize(name, size));
      }
    });
  });
};

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS).catch(() => {}))
  );
});

self.addEventListener('activate', event => {
  const allowedCaches = [CACHE_NAME, MAP_CACHE, IMG_CACHE];
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (!allowedCaches.includes(cacheName)) return caches.delete(cacheName);
        })
      );
    }).then(() => self.clients.claim()) 
  );
});

self.addEventListener('fetch', (event) => {
  const url = event.request.url;

  if (
    event.request.method !== 'GET' ||
    url.includes('googletagmanager.com') || 
    url.includes('google-analytics.com')
  ) return; 

  // 🚀 CACHE-FIRST: Map Tiles (Dramatically speeds up UI, saves data)
  if (url.includes('tile.openstreetmap.org')) {
    event.respondWith(
      caches.match(event.request).then(cachedResponse => {
        if (cachedResponse) return cachedResponse;
        return fetch(event.request).then(fetchRes => {
          if (fetchRes.status === 200) {
            caches.open(MAP_CACHE).then(cache => {
              cache.put(event.request, fetchRes.clone());
              limitCacheSize(MAP_CACHE, 100); 
            });
          }
          return fetchRes;
        });
      })
    );
  }
  // 🚀 CACHE-FIRST: Firebase Images
  else if (url.includes('firebasestorage.googleapis.com')) {
    event.respondWith(
      caches.match(event.request).then(cachedResponse => {
        if (cachedResponse) return cachedResponse;
        return fetch(event.request).then(fetchRes => {
          if (fetchRes.status === 200) {
            caches.open(IMG_CACHE).then(cache => {
              cache.put(event.request, fetchRes.clone());
              limitCacheSize(IMG_CACHE, 30); 
            });
          }
          return fetchRes;
        });
      })
    );
  }
  // 🚀 STALE-WHILE-REVALIDATE: App Code (0ms Load Times)
  else {
    event.respondWith(
      caches.match(event.request).then(cachedResponse => {
        const fetchPromise = fetch(event.request).then(networkResponse => {
          if (url.startsWith('http') && networkResponse.status === 200) {
            caches.open(CACHE_NAME).then(cache => {
              cache.put(event.request, networkResponse.clone());
            });
          }
          return networkResponse;
        }).catch(() => {
          if (event.request.mode === 'navigate') return caches.match('/index.html');
        });
        return cachedResponse || fetchPromise;
      })
    );
  }
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 🚀 BACKGROUND SYNC & PERIODIC SYNC 
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-offline-actions') event.waitUntil(Promise.resolve()); 
});

self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'update-deals') event.waitUntil(Promise.resolve()); 
});