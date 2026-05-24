const functions = require('firebase-functions');
const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp();
}

// ═══════════════════════════════════════════════════════════════════
// SEND PROXIMITY NOTIFICATION
// ═══════════════════════════════════════════════════════════════════
exports.sendProximityNotification = functions.https.onRequest(async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(204).send('');
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { userId, title, body, data } = req.body;

    if (!userId || !title || !body) {
      return res.status(400).json({ 
        error: 'Missing required fields: userId, title, body' 
      });
    }

    const userDoc = await admin.firestore()
      .collection('users')
      .doc(userId)
      .get();

    if (!userDoc.exists) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userData = userDoc.data();
    const fcmToken = userData.fcmToken;

    if (!fcmToken) {
      return res.status(400).json({ error: 'No FCM token for user' });
    }

    const message = {
      notification: {
        title: title,
        body: body,
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-192.png'
      },
      data: {
        dealId: data?.dealId || '',
        type: data?.type || '',
        distance: String(data?.distance || 0),
        timestamp: String(Date.now())
      },
      token: fcmToken,
      android: {
        priority: 'high',
        notification: {
          sound: 'default',
          channelId: 'nearpop_deals',
          priority: 'high',
          defaultSound: true,
          defaultVibrateTimings: true,
          defaultLightSettings: true,
          clickAction: 'FLUTTER_NOTIFICATION_CLICK'
        }
      },
      apns: {
        payload: {
          aps: {
            sound: 'default',
            badge: 1,
            contentAvailable: true,
            category: 'NEARPOP_DEAL'
          }
        },
        headers: {
          'apns-priority': '10',
          'apns-push-type': 'alert'
        }
      },
      webpush: {
        notification: {
          icon: '/icons/icon-192.png',
          badge: '/icons/icon-192.png',
          vibrate: [200, 100, 200],
          requireInteraction: false,
          tag: data?.dealId || 'nearpop-notification',
          renotify: false
        },
        fcmOptions: {
          link: data?.dealId 
            ? `https://nearpop.in/detail.html?id=${data.dealId}` 
            : 'https://nearpop.in/map.html'
        }
      }
    };

    const response = await admin.messaging().send(message);
    console.log('Notification sent successfully:', response);

    await admin.firestore()
      .collection('users')
      .doc(userId)
      .update({
        notificationsSent: admin.firestore.FieldValue.increment(1),
        lastNotificationSent: admin.firestore.FieldValue.serverTimestamp()
      });

    return res.status(200).json({
      success: true,
      messageId: response,
      timestamp: Date.now()
    });

  } catch (error) {
    console.error('Error sending notification:', error);
    
    if (error.code === 'messaging/invalid-registration-token' || 
        error.code === 'messaging/registration-token-not-registered') {
      try {
        await admin.firestore()
          .collection('users')
          .doc(req.body.userId)
          .update({
            fcmToken: admin.firestore.FieldValue.delete()
          });
        
        return res.status(410).json({ 
          error: 'FCM token expired/invalid', 
          code: 'TOKEN_EXPIRED' 
        });
      } catch (e) {
        console.error('Failed to remove invalid token:', e);
      }
    }

    return res.status(500).json({
      error: 'Failed to send notification',
      message: error.message,
      code: error.code || 'UNKNOWN_ERROR'
    });
  }
});
// ═══════════════════════════════════════════════════════════════════
// SERVER-SIDE RADAR: BACKGROUND PROXIMITY ENGINE (Scheduled)
// ═══════════════════════════════════════════════════════════════════
exports.backgroundProximityEngine = functions.pubsub.schedule('every 5 minutes').onRun(async (context) => {
    const db = admin.firestore();
    const now = Date.now();

    // 1. Get users active in the last 2 hours who have push enabled
    const usersSnap = await db.collection('users')
        .where('lastActive', '>', now - (2 * 60 * 60 * 1000))
        .get();

    if (usersSnap.empty) return null;

    // 2. Get active deals
    const dealsSnap = await db.collection('listings')
        .where('status', '==', 'active')
        .get();

    const deals = dealsSnap.docs.map(d => ({id: d.id, ...d.data()}));
    const pushPromises = [];

    // 3. Radar Check: Compare every active user to every active deal
    usersSnap.forEach(userDoc => {
        const user = userDoc.data();
        if (!user.fcmToken || !user.lastKnownLat) return;

        deals.forEach(deal => {
            if (!deal.lat || !deal.lng) return;
            
            const dist = getDistance(user.lastKnownLat, user.lastKnownLng, deal.lat, deal.lng);
            
            // If user is within 500 meters of a deal, fire the background push!
            if (dist <= 500) {
                const message = {
                    token: user.fcmToken,
                    notification: {
                        title: `🏷️ ${deal.title}`,
                        body: `${Math.round(dist)}m away! Tap to view offer.`
                    },
                    data: {
                        listingId: String(deal.id),
                        merchantId: String(deal.uid || ''),
                        url: `/detail.html?id=${deal.id}`
                    }
                };
                
                // Send push to user's phone. 
                // Don't worry about spam; your sw.js IndexedDB cooldowns will block duplicates perfectly.
                pushPromises.push(admin.messaging().send(message).catch(e => console.log('FCM Error:', e)));
            }
        });
    });

    await Promise.all(pushPromises);
    console.log(`[Radar] Checked ${usersSnap.size} users. Sent ${pushPromises.length} potential background pushes.`);
    return null;
});

// Helper: Haversine distance in meters
function getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3; 
    const p1 = lat1 * Math.PI/180;
    const p2 = lat2 * Math.PI/180;
    const dp = (lat2-lat1) * Math.PI/180;
    const dl = (lon2-lon1) * Math.PI/180;
    const a = Math.sin(dp/2) * Math.sin(dp/2) + Math.cos(p1) * Math.cos(p2) * Math.sin(dl/2) * Math.sin(dl/2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}