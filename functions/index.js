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
