// ╔══════════════════════════════════════════════════════════════════╗
// ║  notifications.js — NearPop Smart Notification Engine v3.0       ║
// ║  PRODUCTION-READY: Full FCM Integration + Background Support     ║
// ║  ✅ Merged: Core logic + FCM push + trackEng export             ║
// ║  ✅ Features: Smart linger, priority scoring, real notifications║
// ╚══════════════════════════════════════════════════════════════════╝

import { db, LS, SS, distM } from './app.js';
import { updateDoc, doc, increment } from 'https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js';
import { getMessaging, getToken, onMessage } from 'https://www.gstatic.com/firebasejs/12.12.0/firebase-messaging.js';

// ═══════════════════════════════════════════════════════════════════
// CONFIGURATION CONSTANTS
// ═══════════════════════════════════════════════════════════════════
const RULES = {
    LINGER_MS: 5000,                      // 5 seconds wait before firing
    GLOBAL_QUEUE_MS: 3 * 60 * 1000,       // 3 minutes between notifications
    DEAL_COOLDOWN_MS: 48 * 60 * 60 * 1000, // 48 hours before repeating same deal
    MAX_NOTIFS_PER_DAY: 5,                // Default daily limit
    MIN_GPS_ACCURACY: 100,                // Reject poor GPS accuracy
    CLEANUP_INTERVAL: 30000,              // Clean stale entries every 30s
    STALE_THRESHOLD: 60000,               // Remove linger entries older than 60s
    MAX_LINGER_CACHE_SIZE: 100,           // Prevent memory bloat
    WRITE_QUEUE_BATCH_SIZE: 10,           // Batch Firestore writes
    WRITE_QUEUE_FLUSH_INTERVAL: 5000      // Flush write queue every 5s
};

// ═══════════════════════════════════════════════════════════════════
// FIRESTORE WRITE QUEUE (Prevents data loss, handles retries)
// ═══════════════════════════════════════════════════════════════════
class FirestoreWriteQueue {
    constructor() {
        this.queue = [];
        this.isProcessing = false;
        this.flushTimer = null;
        this.startAutoFlush();
    }

    enqueue(operation) {
        this.queue.push({
            operation,
            timestamp: Date.now(),
            attempts: 0,
            maxAttempts: 3
        });

        // Auto-flush if queue is getting large
        if (this.queue.length >= RULES.WRITE_QUEUE_BATCH_SIZE) {
            this.flush();
        }
    }

    startAutoFlush() {
        this.flushTimer = setInterval(() => {
            if (this.queue.length > 0) {
                this.flush();
            }
        }, RULES.WRITE_QUEUE_FLUSH_INTERVAL);
    }

    async flush() {
        if (this.isProcessing || this.queue.length === 0) return;

        this.isProcessing = true;
        const batch = this.queue.splice(0, RULES.WRITE_QUEUE_BATCH_SIZE);

        for (const item of batch) {
            try {
                await item.operation();
                // Success - item removed from queue
            } catch (error) {
                console.warn('[WriteQueue] Operation failed:', error);
                item.attempts++;

                // Retry if under max attempts
                if (item.attempts < item.maxAttempts) {
                    this.queue.push(item); // Re-queue for retry
                } else {
                    console.error('[WriteQueue] Max retries exceeded, dropping operation');
                }
            }
        }

        this.isProcessing = false;

        // Continue processing if more items in queue
        if (this.queue.length > 0) {
            setTimeout(() => this.flush(), 100);
        }
    }

    destroy() {
        if (this.flushTimer) {
            clearInterval(this.flushTimer);
        }
        this.flush(); // Final flush before destruction
    }
}

// ═══════════════════════════════════════════════════════════════════
// SMART NOTIFICATION ENGINE (Production-Ready)
// ═══════════════════════════════════════════════════════════════════
class SmartNotificationEngine {
    constructor() {
        // Linger cache: track deals user is near
        // Structure: { dealId: { timestamp, qualified, distance, firstSeen } }
        this.lingerCache = {};

        // Evaluation lock: prevent concurrent evaluations (race condition fix)
        this._isEvaluating = false;

        // System mute flag
        this.systemMuted = false;

        // Write queue for Firestore operations
        this.writeQueue = new FirestoreWriteQueue();

        // Last cleanup timestamp
        this.lastCleanup = Date.now();

        // ═══ FCM PROPERTIES ═══
        this.messaging = null;
        this.fcmToken = null;
        this.notificationPermission = 'default';

        // Start periodic cleanup
        this.startCleanup();
    }

    // ───────────────────────────────────────────────────────────────
    // FCM INITIALIZATION - Enable push notifications
    // ───────────────────────────────────────────────────────────────
    async initializeFCM() {
        try {
            console.log('[NotifEngine] Initializing FCM...');

            // Check if notifications supported
            if (!('Notification' in window)) {
                console.warn('[NotifEngine] Notifications not supported');
                return false;
            }

            // Check current permission
            this.notificationPermission = Notification.permission;

            if (this.notificationPermission === 'denied') {
                console.warn('[NotifEngine] Notification permission denied');
                return false;
            }

            // Request permission if needed
            if (this.notificationPermission === 'default') {
                this.notificationPermission = await Notification.requestPermission();
                
                if (this.notificationPermission !== 'granted') {
                    console.warn('[NotifEngine] Permission not granted');
                    return false;
                }
            }

            // Check service worker support
            if (!('serviceWorker' in navigator)) {
                console.warn('[NotifEngine] Service Worker not supported');
                return false;
            }

            // Register service worker
            const registration = await navigator.serviceWorker.register('/firebase-messaging-sw.js');
            console.log('[NotifEngine] Service Worker registered');

            // Initialize Firebase Messaging
            this.messaging = getMessaging();

            // Get FCM token with VAPID key
            this.fcmToken = await getToken(this.messaging, {
                vapidKey: 'BJWz7jdnCy1hb-E8M-7-Q2wanQdNY46Rw7T9I8g_EPr02m-AYAxhGCM7QBm7DpL0WgE-nSnud5mqBK6MWd4w6T0',
                serviceWorkerRegistration: registration
            });

            if (this.fcmToken) {
                console.log('[NotifEngine] FCM Token obtained');
                await this.saveFCMToken(this.fcmToken);
                
                // Listen for foreground messages
                onMessage(this.messaging, (payload) => {
                    console.log('[NotifEngine] Foreground message:', payload);
                    this.handleForegroundMessage(payload);
                });

                return true;
            } else {
                console.warn('[NotifEngine] Failed to get FCM token');
                return false;
            }

        } catch (error) {
            console.error('[NotifEngine] FCM initialization error:', error);
            return false;
        }
    }

    async saveFCMToken(token) {
        const uid = LS('uid');
        if (!uid) return;

        try {
            await updateDoc(doc(db, 'users', uid), {
                fcmToken: token,
                fcmTokenUpdated: new Date().toISOString(),
                platform: this.detectPlatform(),
                userAgent: navigator.userAgent
            });
            console.log('[NotifEngine] FCM token saved to Firestore');
        } catch (error) {
            console.error('[NotifEngine] Failed to save FCM token:', error);
        }
    }

    detectPlatform() {
        const ua = navigator.userAgent;
        if (/iPhone|iPad|iPod/.test(ua)) return 'ios';
        if (/Android/.test(ua)) return 'android';
        return 'web';
    }

    handleForegroundMessage(payload) {
        console.log('[NotifEngine] Handling foreground message:', payload);
        
        const { title, body } = payload.notification || {};
        const data = payload.data || {};

        // Show browser notification
        if (Notification.permission === 'granted') {
            const notification = new Notification(title || 'NearPop', {
                body: body || 'New deal nearby!',
                icon: '/icons/icon-192.png',
                badge: '/icons/badge-72.png',
                tag: data.dealId || 'nearpop-notification',
                data: data,
                requireInteraction: false,
                vibrate: [200, 100, 200],
                silent: false
            });

            notification.onclick = () => {
                window.focus();
                if (data.dealId) {
                    window.location.href = `/detail.html?id=${data.dealId}`;
                }
                notification.close();
            };

            // Auto-close after 10 seconds
            setTimeout(() => notification.close(), 10000);
        }
    }

    // ───────────────────────────────────────────────────────────────
    // CLEANUP: Remove stale linger entries (prevents memory leaks)
    // ───────────────────────────────────────────────────────────────
    startCleanup() {
        this.cleanupTimer = setInterval(() => {
            this.cleanupLingerCache();
        }, RULES.CLEANUP_INTERVAL);
    }

    cleanupLingerCache() {
        const now = Date.now();
        let cleaned = 0;

        // Remove stale entries
        Object.keys(this.lingerCache).forEach(dealId => {
            const entry = this.lingerCache[dealId];
            const age = now - entry.timestamp;

            // Remove if:
            // 1. Older than stale threshold
            // 2. Already qualified but still in cache (should have been deleted)
            if (age > RULES.STALE_THRESHOLD || 
                (entry.qualified && now - entry.qualifiedAt > 10000)) {
                delete this.lingerCache[dealId];
                cleaned++;
            }
        });

        // Safety: If cache grows too large, remove oldest entries
        const cacheSize = Object.keys(this.lingerCache).length;
        if (cacheSize > RULES.MAX_LINGER_CACHE_SIZE) {
            const entries = Object.entries(this.lingerCache)
                .sort((a, b) => a[1].timestamp - b[1].timestamp);
            
            const toRemove = cacheSize - RULES.MAX_LINGER_CACHE_SIZE;
            for (let i = 0; i < toRemove; i++) {
                delete this.lingerCache[entries[i][0]];
                cleaned++;
            }
        }

        if (cleaned > 0) {
            console.log(`[NotifEngine] Cleaned ${cleaned} stale linger entries`);
        }

        this.lastCleanup = now;
    }

    // ───────────────────────────────────────────────────────────────
    // HELPER: Safely parse JSON from localStorage
    // ───────────────────────────────────────────────────────────────
    getArrayPref(key, defaultVal) {
        try {
            const val = localStorage.getItem(key);
            return val ? JSON.parse(val) : defaultVal;
        } catch (e) {
            console.warn(`[NotifEngine] Failed to parse ${key}:`, e);
            return defaultVal;
        }
    }

    // ───────────────────────────────────────────────────────────────
    // CORE: Evaluate position and trigger notifications
    // ───────────────────────────────────────────────────────────────
    async evaluate(position, activeListings, movementContext = {}) {
        // 🔒 CRITICAL: Prevent concurrent evaluations (race condition fix)
        if (this._isEvaluating) {
            console.log('[NotifEngine] Evaluation in progress, skipping');
            return;
        }

        this._isEvaluating = true;

        try {
            await this._evaluateInternal(position, activeListings, movementContext);
        } catch (error) {
            console.error('[NotifEngine] Evaluation error:', error);
        } finally {
            // 🔓 Always release lock
            this._isEvaluating = false;
        }
    }

    async _evaluateInternal(position, activeListings, movementContext) {
        // System mute check
        if (this.systemMuted) return;

        // ─── 1. USER PREFERENCES ───
        if (localStorage.getItem('pref_paused') === 'true') {
            console.log('[NotifEngine] Notifications paused by user');
            return;
        }

        const prefs = {
            maxDay: parseInt(localStorage.getItem('pref_maxDay')) || RULES.MAX_NOTIFS_PER_DAY,
            interests: this.getArrayPref('pref_interests', ['deal', 'rental', 'pg', 'job']),
            mutedCats: this.getArrayPref('pref_mutedCats', []),
            mutedVendors: this.getArrayPref('pref_mutedVendors', [])
        };

        // ─── 2. GPS VALIDATION ───
        const lat = position.coords.latitude;
        const lng = position.coords.longitude;
        const accuracy = position.coords.accuracy;
        const speed = position.coords.speed; // May be null

        if (accuracy > RULES.MIN_GPS_ACCURACY) {
            console.log(`[NotifEngine] GPS accuracy too low: ${accuracy}m`);
            return;
        }

        // ─── 3. GLOBAL COOLDOWN CHECK ───
        const lastNotifTime = parseInt(LS('np_last_notif_time')) || 0;
        const timeSinceLastNotif = Date.now() - lastNotifTime;
        
        if (timeSinceLastNotif < RULES.GLOBAL_QUEUE_MS) {
            const remainingSec = Math.ceil((RULES.GLOBAL_QUEUE_MS - timeSinceLastNotif) / 1000);
            console.log(`[NotifEngine] Global cooldown active: ${remainingSec}s remaining`);
            return;
        }

        // ─── 4. DAILY LIMIT CHECK ───
        const today = new Date().toDateString();
        let dailyTracker = this.getArrayPref('np_daily_tracker', { date: today, count: 0 });
        
        // Reset if new day
        if (dailyTracker.date !== today) {
            dailyTracker = { date: today, count: 0 };
        }

        if (dailyTracker.count >= prefs.maxDay) {
            console.log(`[NotifEngine] Daily limit reached: ${dailyTracker.count}/${prefs.maxDay}`);
            return;
        }

        // ─── 5. MOVEMENT CONTEXT (for adaptive radius) ───
        const { isStationary = false, densityLevel = 'normal' } = movementContext;
        
        // Adaptive trigger radius based on movement and density
        let triggerRadius = 500; // Default 500m
        
        if (isStationary) {
            triggerRadius = 100; // Tighter radius when stationary
        } else if (speed && speed > 2.0) {
            triggerRadius = 300; // Medium radius for fast walkers
        }

        if (densityLevel === 'high') {
            triggerRadius = Math.min(triggerRadius, 50); // Max 50m in high density
        }

        // Additional density check: if too many active listings, tighten radius
        if (activeListings.length > 20) {
            triggerRadius = Math.min(triggerRadius, 50);
        } else if (activeListings.length > 10) {
            triggerRadius = Math.min(triggerRadius, 200);
        }

        console.log(`[NotifEngine] Trigger radius: ${triggerRadius}m (stationary: ${isStationary}, listings: ${activeListings.length})`);

        // ─── 6. EVALUATE EACH DEAL ───
        const qualifiedDeals = [];
        const now = Date.now();

        for (const deal of activeListings) {
            // Basic validation
            if (!deal.id || !deal.lat || !deal.lng) continue;

            // Merchant budget check
            if (deal.popupsSentToday >= (deal.dailyPopupLimit || 100)) continue;

            // Expiry check
            if (deal.expiryDate && new Date(deal.expiryDate) < new Date()) continue;

            // User interest check
            if (!prefs.interests.includes(deal.type)) continue;

            // Muted category check
            if (prefs.mutedCats.includes(deal.type)) continue;

            // Muted vendor check
            if (prefs.mutedVendors.includes(deal.uid || deal.id)) continue;

            // 48-hour deal cooldown check
            const lastSeenDeal = parseInt(LS(`np_seen_${deal.id}`)) || 0;
            if (now - lastSeenDeal < RULES.DEAL_COOLDOWN_MS) continue;

            // Distance check
            const distance = distM(lat, lng, parseFloat(deal.lat), parseFloat(deal.lng));

            if (distance <= triggerRadius) {
                // ✅ FIXED: Enhanced linger mechanism with race-condition protection
                const cacheEntry = this.lingerCache[deal.id];

                if (!cacheEntry) {
                    // First time seeing this deal - add to linger cache
                    this.lingerCache[deal.id] = {
                        timestamp: now,
                        firstSeen: now,
                        qualified: false,
                        distance: distance,
                        evaluationCount: 1
                    };
                    console.log(`[NotifEngine] New deal in linger: ${deal.title} (${Math.round(distance)}m)`);

                } else if (!cacheEntry.qualified) {
                    // Existing entry - check if linger time met
                    const lingerDuration = now - cacheEntry.timestamp;
                    cacheEntry.evaluationCount++;
                    cacheEntry.distance = distance;

                    if (lingerDuration >= RULES.LINGER_MS) {
                        // ✅ CRITICAL FIX: Mark as qualified immediately to prevent duplicates
                        cacheEntry.qualified = true;
                        cacheEntry.qualifiedAt = now;

                        // Calculate priority score
                        deal.score = this.calculatePriorityScore(deal, distance, movementContext);
                        deal._lingerDuration = lingerDuration;
                        deal._distance = distance;

                        qualifiedDeals.push(deal);
                        console.log(`[NotifEngine] Deal qualified: ${deal.title} (score: ${deal.score.toFixed(1)})`);
                    } else {
                        const remaining = Math.ceil((RULES.LINGER_MS - lingerDuration) / 1000);
                        console.log(`[NotifEngine] Lingering: ${deal.title} (${remaining}s remaining)`);
                    }
                }
                // If already qualified, do nothing (wait for deletion after send)

            } else {
                // Outside trigger radius - remove from cache
                if (this.lingerCache[deal.id]) {
                    console.log(`[NotifEngine] Deal left radius: ${deal.title}`);
                    delete this.lingerCache[deal.id];
                }
            }
        }

        // ─── 7. PROCESS QUALIFIED DEALS ───
        if (qualifiedDeals.length > 0) {
            console.log(`[NotifEngine] Processing ${qualifiedDeals.length} qualified deals`);
            await this.processAndFire(qualifiedDeals, dailyTracker);
        }
    }

    // ───────────────────────────────────────────────────────────────
    // ENHANCED PRIORITY SCORING (Production-grade algorithm)
    // ───────────────────────────────────────────────────────────────
    calculatePriorityScore(deal, distance, movementContext = {}) {
        // Component 1: Distance relevance (exponential decay - closer is much better)
        const maxDistance = 500;
        const distanceScore = 100 * Math.exp(-2 * distance / maxDistance);

        // Component 2: Budget influence (reduced weight for fairness)
        const budgetScore = Math.min(100, (deal.budget || 0) / 10);

        // Component 3: Time-of-day relevance
        let temporalScore = 50;
        const hour = new Date().getHours();
        
        // Boost for appropriate times
        const timeBoosts = {
            'deal': [9, 10, 11, 16, 17, 18, 19], // Shopping hours
            'rental': [10, 11, 12, 13, 14, 15],  // Business hours
            'pg': [10, 11, 12, 13, 14, 15],      // Business hours
            'job': [9, 10, 11, 14, 15, 16]       // Work hours
        };

        if (timeBoosts[deal.type]?.includes(hour)) {
            temporalScore += 20;
        }

        // Component 4: Quality signals
        let qualityScore = 50;
        if (deal.imageUrl) qualityScore += 10;
        if (deal.desc && deal.desc.length > 50) qualityScore += 5;
        if (deal.price) qualityScore += 5;

        // Component 5: Movement context adjustment
        let movementMultiplier = 1.0;
        const { isStationary = false } = movementContext;

        if (isStationary && distance < 100) {
            movementMultiplier = 1.3; // Boost nearby deals when stationary
        } else if (isStationary && distance > 200) {
            movementMultiplier = 0.7; // Penalize distant deals when stationary
        }

        // Final weighted score
        const rawScore = 
            (distanceScore * 0.50) +  // Distance is most important
            (temporalScore * 0.20) +  // Time relevance
            (qualityScore * 0.20) +   // Quality signals
            (budgetScore * 0.10);     // Budget has least weight (fairness)

        const finalScore = rawScore * movementMultiplier;

        return Math.max(0, Math.min(100, finalScore));
    }

    // ───────────────────────────────────────────────────────────────
    // PROCESS AND FIRE: Send notification to user
    // ───────────────────────────────────────────────────────────────
    async processAndFire(qualifiedDeals, dailyTracker) {
        // Sort by score (highest first)
        qualifiedDeals.sort((a, b) => b.score - a.score);

        // ✅ IMPROVED: Fair distribution - limit deals per merchant
        const MAX_DEALS_PER_MERCHANT = 2;
        const merchantCounts = {};
        const fairDeals = [];

        for (const deal of qualifiedDeals) {
            const count = merchantCounts[deal.uid] || 0;
            
            if (count < MAX_DEALS_PER_MERCHANT) {
                fairDeals.push(deal);
                merchantCounts[deal.uid] = count + 1;
            }

            // Stop after collecting top 3 deals
            if (fairDeals.length >= 3) break;
        }

        if (fairDeals.length === 0) return;

        // Strategy 1: Single deal (most common)
        if (fairDeals.length === 1) {
            const deal = fairDeals[0];
            await this.sendSingleNotification(deal, dailyTracker);
            return;
        }

        // Strategy 2: Multiple deals from same merchant
        if (fairDeals.length > 1 && fairDeals[0].uid === fairDeals[1].uid) {
            await this.sendGroupedNotification(fairDeals, dailyTracker);
            return;
        }

        // Strategy 3: Multiple merchants - send top deal only
        const topDeal = fairDeals[0];
        await this.sendSingleNotification(topDeal, dailyTracker);
    }

    // ───────────────────────────────────────────────────────────────
    // SEND SINGLE NOTIFICATION
    // ───────────────────────────────────────────────────────────────
    async sendSingleNotification(deal, dailyTracker) {
        const emoji = deal.emoji || this.getTypeEmoji(deal.type);
        const title = `${emoji} ${deal.title}`;
        const distance = Math.round(deal._distance || 0);
        const body = deal.price 
            ? `${deal.price} · ${distance}m away`
            : `${distance}m from you`;

        // Send notification (FCM-enabled)
        await this.sendNotification(title, body, deal);

        // Update tracking
        this.updateTrackingData([deal], dailyTracker);
    }

    // ───────────────────────────────────────────────────────────────
    // SEND GROUPED NOTIFICATION
    // ───────────────────────────────────────────────────────────────
    async sendGroupedNotification(deals, dailyTracker) {
        const merchant = deals[0].owner || 'A nearby store';
        const title = `${merchant} has ${deals.length} offers nearby! 🎁`;
        const body = deals.map(d => `• ${d.title}`).slice(0, 2).join('\n');

        // Send notification (FCM-enabled)
        await this.sendNotification(title, body, deals[0]);

        // Update tracking
        this.updateTrackingData(deals, dailyTracker);
    }

    // ───────────────────────────────────────────────────────────────
    // SEND NOTIFICATION (FCM-Enabled)
    // ───────────────────────────────────────────────────────────────
    async sendNotification(title, body, deal) {
        const notificationData = {
            dealId: deal.id,
            type: deal.type,
            distance: Math.round(deal._distance || 0)
        };

        // Method 1: Browser Notification API (foreground)
        if (Notification.permission === 'granted') {
            const notification = new Notification(title, {
                body: body,
                icon: '/icons/icon-192.png',
                badge: '/icons/badge-72.png',
                tag: deal.id,
                data: notificationData,
                vibrate: [200, 100, 200],
                requireInteraction: false,
                silent: false
            });

            notification.onclick = () => {
                window.focus();
                window.location.href = `/detail.html?id=${deal.id}`;
                notification.close();
            };

            setTimeout(() => notification.close(), 10000);
        }

        // Method 2: Cloud Function (works in background via FCM)
        if (this.fcmToken) {
            await this.sendViaCloudFunction(title, body, notificationData);
        }

        console.log(`[NotifEngine] Notification sent: ${title}`);
    }

    async sendViaCloudFunction(title, body, data) {
        const uid = LS('uid');
        if (!uid) return;

        try {
            const response = await fetch('https://us-central1-nearpop-a432d.cloudfunctions.net/sendProximityNotification', {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    userId: uid,
                    title: title,
                    body: body,
                    data: data
                })
            });

            if (!response.ok) {
                console.error('[NotifEngine] Cloud Function failed:', await response.text());
            }
        } catch (error) {
            console.error('[NotifEngine] Cloud Function error:', error);
        }
    }

    // ───────────────────────────────────────────────────────────────
    // UPDATE TRACKING DATA
    // ───────────────────────────────────────────────────────────────
    updateTrackingData(deals, dailyTracker) {
        const now = Date.now();

        // Update global tracking
        localStorage.setItem('np_last_notif_time', now);

        // Update daily tracker
        dailyTracker.count += 1;
        localStorage.setItem('np_daily_tracker', JSON.stringify(dailyTracker));

        // Process each deal
        deals.forEach(deal => {
            // Mark as seen (48-hour cooldown)
            localStorage.setItem(`np_seen_${deal.id}`, now);

            // ✅ CRITICAL FIX: Delete from linger cache immediately
            delete this.lingerCache[deal.id];

            // ✅ IMPROVED: Queue Firestore writes (prevents data loss)
            this.writeQueue.enqueue(async () => {
                try {
                    await updateDoc(doc(db, 'listings', deal.id), {
                        popups: increment(1),
                        popupsSentToday: increment(1),
                        lastPopupAt: now
                    });
                    console.log(`[NotifEngine] Updated listing: ${deal.id}`);
                } catch (error) {
                    console.error(`[NotifEngine] Failed to update listing ${deal.id}:`, error);
                    throw error; // Re-throw for retry mechanism
                }
            });

            // Update merchant wallet if applicable
            if (deal.uid) {
                this.writeQueue.enqueue(async () => {
                    try {
                        await updateDoc(doc(db, 'users', deal.uid), {
                            wallet: increment(-0.1),
                            totalSpent: increment(0.1),
                            lastChargeAt: now
                        });
                        console.log(`[NotifEngine] Charged merchant: ${deal.uid} (₹0.10)`);
                    } catch (error) {
                        console.error(`[NotifEngine] Failed to charge merchant ${deal.uid}:`, error);
                        throw error; // Re-throw for retry mechanism
                    }
                });
            }
        });

        console.log(`[NotifEngine] Updated tracking for ${deals.length} deals`);
    }

    // ───────────────────────────────────────────────────────────────
    // TRIGGER UI: Display notification to user
    // ───────────────────────────────────────────────────────────────
    // ───────────────────────────────────────────────────────────────
    // HELPER: Get emoji for deal type
    // ───────────────────────────────────────────────────────────────
    getTypeEmoji(type) {
        const emojis = {
            'deal': '🏷️',
            'rental': '🏠',
            'pg': '🛋️',
            'job': '💼'
        };
        return emojis[type] || '📍';
    }

    // ───────────────────────────────────────────────────────────────
    // CLEANUP: Destroy engine and clean up resources
    // ───────────────────────────────────────────────────────────────
    destroy() {
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
        }
        if (this.writeQueue) {
            this.writeQueue.destroy();
        }
        console.log('[NotifEngine] Engine destroyed');
    }
}

// ═══════════════════════════════════════════════════════════════════
// EXPORT SINGLETON INSTANCE
// ═══════════════════════════════════════════════════════════════════
export const NotificationEngine = new SmartNotificationEngine();

// ═══════════════════════════════════════════════════════════════════
// TRACK ENGAGEMENT FUNCTION (Used by detail.html, map.html, etc.)
// ═══════════════════════════════════════════════════════════════════
export function trackEng(id, value) {
    try {
        // Get UID from localStorage
        const uid = localStorage.getItem('np_uid');
        if (!uid || !id) return;

        // Dynamically import required modules to avoid circular dependencies
        import('./app.js').then(({ db }) => {
            import('https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js')
                .then(({ updateDoc, doc, increment }) => {
                    updateDoc(doc(db, 'users', uid), { 
                        ['eng_' + id]: increment(value) 
                    }).catch(() => {
                        // Silent fail - engagement tracking is non-critical
                    });
                })
                .catch(() => {});
        }).catch(() => {});
    } catch (error) {
        // Silent fail - don't break the app for analytics
        console.debug('trackEng:', error);
    }
}

// Cleanup on page unload
if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', () => {
        NotificationEngine.destroy();
    });
}
