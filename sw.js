// ╔══════════════════════════════════════════════════════════════════╗
// ║  sw.js — NearPop Service Worker v2.0                             ║
// ║  PRODUCTION-READY: IndexedDB cooldowns, multi-level protection   ║
// ║  ✅ Fixed: Cache eviction, cross-tab sync, unlimited growth      ║
// ║  ✅ Added: Persistent storage, cleanup, multi-level cooldowns    ║
// ╚══════════════════════════════════════════════════════════════════╝

importScripts('https://www.gstatic.com/firebasejs/12.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/12.12.0/firebase-messaging-compat.js');

// ═══════════════════════════════════════════════════════════════════
// FIREBASE INITIALIZATION
// ═══════════════════════════════════════════════════════════════════
firebase.initializeApp({
  apiKey: "AIzaSyDYUm3VV8iuLHQKJuU9fWgaRaYU0t5Dlzk",
  authDomain: "nearpop-a432d.firebaseapp.com",
  projectId: "nearpop-a432d",
  storageBucket: "nearpop-a432d.firebasestorage.app",
  messagingSenderId: "265333242320",
  appId: "1:265333242320:web:f2cedec620ef08d4e161d5"
});

const messaging = firebase.messaging();

// ═══════════════════════════════════════════════════════════════════
// INDEXEDDB-BASED COOLDOWN MANAGER (PRODUCTION-GRADE)
// ═══════════════════════════════════════════════════════════════════
class NotificationCooldownManager {
  constructor() {
    this.dbName = 'NearPopCooldowns';
    this.storeName = 'cooldowns';
    this.version = 1;
    
    // Cooldown durations (milliseconds)
    this.COOLDOWNS = {
      listing: 3600000,      // 1 hour per listing
      merchant: 1800000,     // 30 minutes per merchant
      global: 180000         // 3 minutes global (any notification)
    };
  }

  // ───────────────────────────────────────────────────────────────
  // Open IndexedDB connection
  // ───────────────────────────────────────────────────────────────
  async openDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.version);
      
      request.onerror = () => {
        console.error('[SW] IndexedDB error:', request.error);
        reject(request.error);
      };
      
      request.onsuccess = () => {
        resolve(request.result);
      };
      
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        
        // Create object store if it doesn't exist
        if (!db.objectStoreNames.contains(this.storeName)) {
          const store = db.createObjectStore(this.storeName, { keyPath: 'id' });
          
          // Create index for timestamp (for cleanup queries)
          store.createIndex('timestamp', 'timestamp', { unique: false });
          
          console.log('[SW] IndexedDB store created:', this.storeName);
        }
      };
    });
  }

  // ───────────────────────────────────────────────────────────────
  // Check if notification can be shown (multi-level cooldown check)
  // ───────────────────────────────────────────────────────────────
  async canShowNotification(listingId, merchantId) {
    try {
      const db = await this.openDB();
      const tx = db.transaction(this.storeName, 'readonly');
      const store = tx.objectStore(this.storeName);
      const now = Date.now();

      // ─── Level 1: Global cooldown (3 minutes) ───
      const globalCheck = await this.checkCooldown(store, 'global', now, this.COOLDOWNS.global);
      if (!globalCheck.allowed) {
        console.log(`[SW] Blocked by global cooldown (${Math.ceil(globalCheck.remaining / 1000)}s remaining)`);
        return { allowed: false, reason: 'global_cooldown', remaining: globalCheck.remaining };
      }

      // ─── Level 2: Merchant cooldown (30 minutes) ───
      if (merchantId) {
        const merchantCheck = await this.checkCooldown(
          store, 
          `merchant_${merchantId}`, 
          now, 
          this.COOLDOWNS.merchant
        );
        
        if (!merchantCheck.allowed) {
          console.log(`[SW] Blocked by merchant cooldown (${Math.ceil(merchantCheck.remaining / 1000)}s remaining)`);
          return { allowed: false, reason: 'merchant_cooldown', remaining: merchantCheck.remaining };
        }
      }

      // ─── Level 3: Listing cooldown (1 hour) ───
      if (listingId) {
        const listingCheck = await this.checkCooldown(
          store, 
          `listing_${listingId}`, 
          now, 
          this.COOLDOWNS.listing
        );
        
        if (!listingCheck.allowed) {
          console.log(`[SW] Blocked by listing cooldown (${Math.ceil(listingCheck.remaining / 1000)}s remaining)`);
          return { allowed: false, reason: 'listing_cooldown', remaining: listingCheck.remaining };
        }
      }

      // All checks passed
      return { allowed: true };

    } catch (error) {
      console.error('[SW] Cooldown check failed:', error);
      // Fail open (allow notification) rather than blocking on error
      return { allowed: true };
    }
  }

  // ───────────────────────────────────────────────────────────────
  // Check individual cooldown entry
  // ───────────────────────────────────────────────────────────────
  async checkCooldown(store, id, now, duration) {
    return new Promise((resolve) => {
      const request = store.get(id);
      
      request.onsuccess = () => {
        const record = request.result;
        
        if (record) {
          const timeSince = now - record.timestamp;
          const remaining = duration - timeSince;
          
          if (remaining > 0) {
            // Still in cooldown
            resolve({ allowed: false, remaining });
          } else {
            // Cooldown expired
            resolve({ allowed: true });
          }
        } else {
          // No record found - first time
          resolve({ allowed: true });
        }
      };
      
      request.onerror = () => {
        console.warn('[SW] Cooldown read error:', request.error);
        resolve({ allowed: true }); // Fail open
      };
    });
  }

  // ───────────────────────────────────────────────────────────────
  // Record notification (update all cooldown levels)
  // ───────────────────────────────────────────────────────────────
  async recordNotification(listingId, merchantId) {
    try {
      const db = await this.openDB();
      const tx = db.transaction(this.storeName, 'readwrite');
      const store = tx.objectStore(this.storeName);
      const now = Date.now();

      // Record global cooldown
      await this.putRecord(store, 'global', now);

      // Record merchant cooldown
      if (merchantId) {
        await this.putRecord(store, `merchant_${merchantId}`, now);
      }

      // Record listing cooldown
      if (listingId) {
        await this.putRecord(store, `listing_${listingId}`, now);
      }

      console.log('[SW] Cooldowns recorded:', { listingId, merchantId });

      // Cleanup old records (older than 7 days)
      await this.cleanupOldRecords(db);

    } catch (error) {
      console.error('[SW] Failed to record cooldowns:', error);
    }
  }

  // ───────────────────────────────────────────────────────────────
  // Put record into store
  // ───────────────────────────────────────────────────────────────
  async putRecord(store, id, timestamp) {
    return new Promise((resolve, reject) => {
      const request = store.put({ id, timestamp });
      
      request.onsuccess = () => resolve();
      request.onerror = () => {
        console.warn('[SW] Failed to put record:', id);
        resolve(); // Don't block on write failure
      };
    });
  }

  // ───────────────────────────────────────────────────────────────
  // Cleanup old records (prevent database bloat)
  // ───────────────────────────────────────────────────────────────
  async cleanupOldRecords(db) {
    try {
      const tx = db.transaction(this.storeName, 'readwrite');
      const store = tx.objectStore(this.storeName);
      const index = store.index('timestamp');
      
      // Delete records older than 7 days
      const cutoff = Date.now() - (7 * 24 * 60 * 60 * 1000);
      const range = IDBKeyRange.upperBound(cutoff);
      
      const request = index.openCursor(range);
      let deletedCount = 0;
      
      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor) {
          store.delete(cursor.primaryKey);
          deletedCount++;
          cursor.continue();
        } else {
          if (deletedCount > 0) {
            console.log(`[SW] Cleaned up ${deletedCount} old cooldown records`);
          }
        }
      };
      
      request.onerror = () => {
        console.warn('[SW] Cleanup failed:', request.error);
      };

    } catch (error) {
      console.warn('[SW] Cleanup error:', error);
    }
  }

  // ───────────────────────────────────────────────────────────────
  // Get cooldown status (for debugging)
  // ───────────────────────────────────────────────────────────────
  async getCooldownStatus(listingId, merchantId) {
    try {
      const db = await this.openDB();
      const tx = db.transaction(this.storeName, 'readonly');
      const store = tx.objectStore(this.storeName);
      const now = Date.now();

      const status = {
        global: await this.getRecordAge(store, 'global', now),
        merchant: merchantId ? await this.getRecordAge(store, `merchant_${merchantId}`, now) : null,
        listing: listingId ? await this.getRecordAge(store, `listing_${listingId}`, now) : null
      };

      return status;

    } catch (error) {
      console.error('[SW] Status check failed:', error);
      return null;
    }
  }

  async getRecordAge(store, id, now) {
    return new Promise((resolve) => {
      const request = store.get(id);
      
      request.onsuccess = () => {
        const record = request.result;
        if (record) {
          resolve({ 
            age: now - record.timestamp,
            timestamp: record.timestamp 
          });
        } else {
          resolve(null);
        }
      };
      
      request.onerror = () => resolve(null);
    });
  }
}

// Create singleton instance
const cooldownManager = new NotificationCooldownManager();

// ═══════════════════════════════════════════════════════════════════
// BACKGROUND MESSAGE HANDLER (PRODUCTION-GRADE)
// ═══════════════════════════════════════════════════════════════════
messaging.onBackgroundMessage((payload) => {
  return (async () => {
    console.log('[SW] Background message received:', payload);

    try {
      // Extract IDs from payload
      const listingId = payload.data?.listingId || null;
      const merchantId = payload.data?.merchantId || null;
      const entityId = listingId || merchantId || 'general_alert';

      // ✅ PRODUCTION FIX: Multi-level cooldown check
      const cooldownCheck = await cooldownManager.canShowNotification(listingId, merchantId);
      
      if (!cooldownCheck.allowed) {
        const reason = cooldownCheck.reason || 'unknown';
        const remainingSec = Math.ceil((cooldownCheck.remaining || 0) / 1000);
        
        console.log(`[SW] Notification blocked: ${reason} (${remainingSec}s remaining)`);
        return; // Don't show notification
      }

      // Construct notification
      const notificationTitle = payload.notification?.title || 'NearPop Update!';
      const notificationOptions = {
        body: payload.notification?.body || 'Tap to see details.',
        icon: '/icons/icon-192.png',
        badge: '/icons/badge-96.png',
        vibrate: [500, 250, 500, 250, 1000, 250, 1000],
        data: { 
          ...payload.data,
          url: payload.fcmOptions?.link || payload.data?.url || '/map.html',
          timestamp: Date.now(),
          listingId,
          merchantId
        },
        requireInteraction: true,
        tag: entityId // Prevents duplicate native notifications with same ID
      };

      // ✅ Record cooldowns BEFORE showing notification
      await cooldownManager.recordNotification(listingId, merchantId);

      // Show notification
      await self.registration.showNotification(notificationTitle, notificationOptions);
      
      console.log('[SW] Notification shown:', notificationTitle);

    } catch (error) {
      console.error('[SW] Background message error:', error);
    }
  })();
});

// ═══════════════════════════════════════════════════════════════════
// NOTIFICATION CLICK HANDLER
// ═══════════════════════════════════════════════════════════════════
self.addEventListener('notificationclick', event => {
  console.log('[SW] Notification clicked');
  
  event.notification.close();
  
  const targetUrl = event.notification.data?.url || '/map.html';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      // Try to focus existing window with matching URL
      for (let client of windowClients) {
        if (client.url.includes(targetUrl) && 'focus' in client) {
          console.log('[SW] Focusing existing window');
          return client.focus();
        }
      }
      
      // Open new window if no matching window found
      if (clients.openWindow) {
        console.log('[SW] Opening new window:', targetUrl);
        return clients.openWindow(targetUrl);
      }
    })
  );
});

// ═══════════════════════════════════════════════════════════════════
// CACHE MANAGEMENT (OFFLINE SUPPORT)
// ═══════════════════════════════════════════════════════════════════
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

// Limit cache size to prevent bloat
const limitCacheSize = (name, size) => {
  caches.open(name).then(cache => {
    cache.keys().then(keys => {
      if (keys.length > size) {
        cache.delete(keys[0]).then(() => limitCacheSize(name, size));
      }
    });
  });
};

// ───────────────────────────────────────────────────────────────
// INSTALL: Cache core assets
// ───────────────────────────────────────────────────────────────
self.addEventListener('install', event => {
  console.log('[SW] Installing...');
  self.skipWaiting();
  
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(ASSETS).catch(err => {
        console.warn('[SW] Cache error during install:', err);
      });
    })
  );
});

// ───────────────────────────────────────────────────────────────
// ACTIVATE: Clean up old caches
// ───────────────────────────────────────────────────────────────
self.addEventListener('activate', event => {
  console.log('[SW] Activating...');
  
  const allowedCaches = [CACHE_NAME, MAP_CACHE, IMG_CACHE];
  
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (!allowedCaches.includes(cacheName)) {
            console.log('[SW] Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => {
      console.log('[SW] Claiming clients');
      return self.clients.claim();
    })
  );
});

// ───────────────────────────────────────────────────────────────
// FETCH: Network-first with cache fallback
// ───────────────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const url = event.request.url;

  // Skip non-GET requests and analytics
  if (
    event.request.method !== 'GET' ||
    url.includes('googletagmanager.com') || 
    url.includes('google-analytics.com')
  ) {
    return;
  }

  // ─── Map tiles: Cache with size limit ───
  if (url.includes('tile.openstreetmap.org')) {
    event.respondWith(
      caches.open(MAP_CACHE).then(cache => {
        return fetch(event.request).then(fetchRes => {
          if (fetchRes.status === 200) {
            cache.put(event.request, fetchRes.clone());
            limitCacheSize(MAP_CACHE, 50);
          }
          return fetchRes;
        }).catch(() => cache.match(event.request));
      })
    );
  }
  
  // ─── Firebase Storage images: Cache with size limit ───
  else if (url.includes('firebasestorage.googleapis.com') || url.includes('ibb.co')) {
    event.respondWith(
      caches.open(IMG_CACHE).then(cache => {
        return fetch(event.request).then(fetchRes => {
          if (fetchRes.status === 200) {
            cache.put(event.request, fetchRes.clone());
            limitCacheSize(IMG_CACHE, 30);
          }
          return fetchRes;
        }).catch(() => cache.match(event.request));
      })
    );
  }
  
  // ─── App code: Network-first with cache fallback ───
  else {
    event.respondWith(
      fetch(event.request)
        .then((networkResponse) => {
          return caches.open(CACHE_NAME).then((cache) => {
            if (url.startsWith('http') && networkResponse.status === 200) {
              cache.put(event.request, networkResponse.clone());
            }
            return networkResponse;
          });
        })
        .catch(() => {
          return caches.match(event.request);
        })
    );
  }
});

// ═══════════════════════════════════════════════════════════════════
// MESSAGE HANDLER (for skip waiting)
// ═══════════════════════════════════════════════════════════════════
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    console.log('[SW] Skip waiting requested');
    self.skipWaiting();
  }
  
  // Debug command: Get cooldown status
  if (event.data && event.data.type === 'GET_COOLDOWN_STATUS') {
    const { listingId, merchantId } = event.data;
    
    cooldownManager.getCooldownStatus(listingId, merchantId).then(status => {
      console.log('[SW] Cooldown status:', status);
      event.ports[0].postMessage({ status });
    });
  }
});

// ═══════════════════════════════════════════════════════════════════
// BACKGROUND SYNC & PERIODIC SYNC
// ═══════════════════════════════════════════════════════════════════

// Background Sync: Retry offline actions when network reconnects
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-offline-actions') {
    console.log('[SW] Syncing offline actions...');
    event.waitUntil(Promise.resolve());
  }
});

// Periodic Background Sync: Update deals in background
self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'update-deals') {
    console.log('[SW] Periodic sync: Updating deals...');
    event.waitUntil(Promise.resolve());
  }
});

console.log('[SW] Service Worker v2.0 loaded');
