// ╔══════════════════════════════════════════════════════╗
// ║  app.js — NearPop shared foundation v2.0             ║
// ║  Enhanced: Error handling, retry logic, performance   ║
// ╚══════════════════════════════════════════════════════╝

// 🚀 ALL IMPORTS SAFELY CONSOLIDATED AT THE TOP
import { initializeApp }  from "https://www.gstatic.com/firebasejs/12.12.0/firebase-app.js";
import { initializeFirestore, persistentLocalCache, doc, setDoc, updateDoc, getDoc } from "https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js";
import { getAuth, setPersistence, browserLocalPersistence, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.12.0/firebase-auth.js";
import { getMessaging, getToken, onMessage, isSupported } from "https://www.gstatic.com/firebasejs/12.12.0/firebase-messaging.js";

//Mobile Only
(function() {
  // 1. Enhanced Detection (includes touch capability check)
  const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) || 
                   (window.innerWidth <= 800 && 'ontouchstart' in window);

  // 2. Exception for Search Engine Bots (So they can still index your site)
  const isBot = /Googlebot|bingbot|DuckDuckBot/i.test(navigator.userAgent);

  if (!isMobile && !isBot) {
    // Stop the window from loading further resources
    window.stop(); 

    // Replace the content gracefully
    const blockout = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>NearPop — Mobile Only</title>
        <style>
          :root { --bg: #0F0F13; --accent: #FF5722; --text: #9CA3AF; }
          body { 
            margin: 0; padding: 20px; 
            display: flex; flex-direction: column; align-items: center; justify-content: center; 
            height: 100vh; background: var(--bg); color: #fff; 
            font-family: -apple-system, system-ui, sans-serif; text-align: center; 
            overflow: hidden;
          }
          .card {
            background: rgba(255, 255, 255, 0.03);
            padding: 30px 20px;
            border-radius: 24px;
            border: 1px solid rgba(255, 255, 255, 0.1);
            max-width: 360px;
          }
          .logo { width: 180px; margin-bottom: 20px; }
          .ic { 
            font-size: 60px; margin-bottom: 15px; 
            filter: drop-shadow(0 10px 30px rgba(255,87,34,0.4));
            animation: float 3s ease-in-out infinite;
          }
          h1 { font-size: 18px; font-weight: 700; margin: 10px 0; color: #fff; line-height: 1.4; }
          p { font-size: 14px; color: var(--text); line-height: 1.5; margin: 5px 0 15px; }
          .qr-placeholder {
            margin-top: 15px;
            padding: 12px;
            background: #fff;
            display: inline-block;
            border-radius: 12px;
            line-height: 0;
          }
          @keyframes float {
            0%, 100% { transform: translateY(0); }
            50% { transform: translateY(-10px); }
          }
          hr { border: 0; border-top: 1px solid rgba(255,255,255,0.1); margin: 15px 0; }
        </style>
      </head>
      <body>
        <div class="card">
          <img src="https://nearpop.in/icons/logo.png" alt="NearPop" class="logo">
          <div class="ic">📱</div>
          
          <!-- English Section -->
          <h1>NearPop works best on the move!</h1>
          <p>To see live deals in your neighborhood, please switch to your smartphone.</p>

          <hr>

          <!-- Hindi Section -->
          <h1>बेहतरीन ऑफर्स के लिए फोन का इस्तेमाल करें!</h1>
          <p>अपने आस-पास की लाइव डील्स देखने के लिए, कृपया NearPop को अपने स्मार्टफोन पर खोलें।</p>

          <div class="qr-placeholder">
            <img src="https://nearpop.in/icons/playstore-qr-code.png" alt="Scan to open NearPop" style="width:120px; height:120px;">
          </div>
        </div>
      </body>
      </html>
    `;

    document.open();
    document.write(blockout);
    document.close();
    
    throw new Error("NearPop: Mobile-only access enforced.");
  }
})();

// ── Firebase config ──────────────────────────────────────
const FB_CONFIG = {
    apiKey: "AIzaSyDYUm3VV8iuLHQKJuU9fWgaRaYU0t5Dlzk",
    authDomain: "nearpop-a432d.firebaseapp.com",
    projectId: "nearpop-a432d",
    storageBucket: "nearpop-a432d.firebasestorage.app",
    messagingSenderId: "265333242320",
    appId: "1:265333242320:web:f2cedec620ef08d4e161d5"
};

export const app = initializeApp(FB_CONFIG);

// ✅ PRODUCTION: Hard limit offline database to 5MB
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ cacheSizeBytes: 5242880 })
});

export const auth = getAuth(app);

// 🛡️ SAFE START: Only turn on messaging if the browser/app allows it
export let messaging = null;

isSupported().then((supported) => {
  if (supported) {
    messaging = getMessaging(app);
    console.log("[App] Web Push is supported! Messaging initialized.");
    
    onMessage(messaging, (payload) => {
      console.log('[App] Foreground Push Received:', payload);
      toast('🔔', payload.notification?.title || "New Offer Nearby!", 5000);
    });
  } else {
    console.log("[App] Running inside Android App - Skipping Web Push!");
  }
}).catch(e => console.error('[App] Messaging check failed:', e));

// 🚀 ENFORCE INDEFINITE SESSION PERSISTENCE
setPersistence(auth, browserLocalPersistence)
  .then(() => {
    onAuthStateChanged(auth, (user) => {
      if (user) {
        SS('uid', user.uid);
      } else {
        // ✅ Firebase session ended — clear uid so index.html doesn't redirect
        try { localStorage.removeItem('np_uid'); } catch(e) {}
      }
    });
  })
  .catch(e => console.error('[App] Persistence setup failed:', e));

// ═══════════════════════════════════════════════════════════════
// ENHANCED LOCALSTORAGE HELPERS WITH ERROR HANDLING
// ═══════════════════════════════════════════════════════════════
export const LS = k => {
  try { 
    const val = localStorage.getItem('np_' + k);
    return val ? JSON.parse(val) : null;
  }
  catch (e) {
    console.warn(`[LS] Failed to get ${k}:`, e);
    return null;
  }
};

export const SS = (k, v) => {
  try { 
    localStorage.setItem('np_' + k, JSON.stringify(v));
    return true;
  }
  catch (e) {
    console.warn(`[LS] Failed to set ${k}:`, e);
    return false;
  }
};

export const DS = k => {
  try {
    localStorage.removeItem('np_' + k);
    return true;
  }
  catch (e) {
    console.warn(`[LS] Failed to delete ${k}:`, e);
    return false;
  }
};

// ═══════════════════════════════════════════════════════════════
// MULTILINGUAL SUPPORT (Hindi / English)
// ═══════════════════════════════════════════════════════════════
const DICTIONARY = {
  en: {
    rad: "📡 Radius:", any: "Anywhere", all: "All",
    deal: "🏷️ Deals", rental: "🏠 Flats", pg: "🛋️ PG", job: "💼 Jobs",
    list: "📋 List", disc: "🔍 Discover", no_deals: "No offers match your current filters."
  },
  hi: {
    rad: "📡 दायरा:", any: "कहीं भी", all: "सभी",
    deal: "🏷️ सौदे", rental: "🏠 मकान", pg: "🛋️ पीजी", job: "💼 नौकरी",
    list: "📋 सूची", disc: "🔍 खोजें", no_deals: "आपके फ़िल्टर से कोई सौदा नहीं मिला।"
  }
};

export const getLang = () => LS('pref_lang') || 'en';
export const toggleLang = () => { 
  SS('pref_lang', getLang() === 'en' ? 'hi' : 'en'); 
  window.location.reload(); 
};
export const t = (key) => DICTIONARY[getLang()][key] || key;

// ── Type → colour / emoji maps ───────────────────────────
export const TC = t => ({ deal:'#FF5722', rental:'#3B82F6', pg:'#8B5CF6', job:'#10B981' }[t] || '#666');
export const TE = t => ({ deal:'🏷️',    rental:'🏠',       pg:'🛋️',      job:'💼'      }[t] || '📍');

export const TYPE_LABELS = { deal:'Deal', rental:'Flat / Room', pg:'PG / Hostel', job:'Job' };
export const CTAS        = { deal:'🛍️ Get Offer', rental:'📅 Schedule Visit', pg:'📅 Visit PG', job:'📝 Apply Now' };

// ═══════════════════════════════════════════════════════════════
// HAVERSINE DISTANCE CALCULATION
// ═══════════════════════════════════════════════════════════════
export function distM(lat1, lng1, lat2, lng2) {
  try {
    const R = 6371000;
    const dLa = (lat2 - lat1) * Math.PI / 180;
    const dLo = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLa/2)**2 +
              Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) *
              Math.sin(dLo/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  } catch (e) {
    console.error('[distM] Calculation failed:', e);
    return 0;
  }
}

export function fmtDist(l) {
  try {
    const loc = LS('lastLoc');
    if (!loc || !l.lat) return '—';
    const d = distM(loc.lat, loc.lng, l.lat, l.lng);
    return d < 1000 ? Math.round(d) + 'm' : (d / 1000).toFixed(1) + 'km';
  } catch (e) {
    return '—';
  }
}

export function isExpired(l) {
  try {
    if (!l.expiryDate) return false;
    return new Date(l.expiryDate) < new Date();
  } catch (e) {
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════
// ENHANCED TOAST WITH QUEUE SUPPORT
// ═══════════════════════════════════════════════════════════════
let toastQueue = [];
let isShowingToast = false;

export function toast(icon, text, durationMs = 3500) {
  toastQueue.push({ icon, text, durationMs });
  
  if (!isShowingToast) {
    showNextToast();
  }
}

function showNextToast() {
  if (toastQueue.length === 0) {
    isShowingToast = false;
    return;
  }
  
  isShowingToast = true;
  const { icon, text, durationMs } = toastQueue.shift();
  
  const el = document.getElementById('toast');
  if (!el) {
    isShowingToast = false;
    return;
  }
  
  document.getElementById('t-ic').textContent = icon;
  document.getElementById('t-tx').textContent = text;
  el.classList.remove('on');
  requestAnimationFrame(() => el.classList.add('on'));
  
  setTimeout(() => {
    el.classList.remove('on');
    setTimeout(() => showNextToast(), 300);
  }, durationMs);
}

// ═══════════════════════════════════════════════════════════════
// AUTH HELPERS
// ═══════════════════════════════════════════════════════════════
export function requireAuth(role = null) {
  const uid  = LS('uid');
  const r    = LS('role');
  if (!uid || !r)               { location.href = 'index.html'; return false; }
  if (role && r !== role)       { location.href = 'index.html'; return false; }
  return true;
}

// ═══════════════════════════════════════════════════════════════
// ENHANCED CACHE WITH VERSIONING
// ═══════════════════════════════════════════════════════════════
const CACHE_VERSION = '2';
export const CACHE_KEY = 'np_listings_cache_v' + CACHE_VERSION;
export const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export function cacheGet() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const { ts, data, version } = JSON.parse(raw);
    
    // Check version mismatch
    if (version !== CACHE_VERSION) {
      cacheClear();
      return null;
    }
    
    if (Date.now() - ts > CACHE_TTL) return null;
    return data;
  } catch (e) {
    console.warn('[Cache] Get failed:', e);
    return null;
  }
}

export function cacheSet(data) {
  try { 
    localStorage.setItem(CACHE_KEY, JSON.stringify({ 
      ts: Date.now(), 
      data,
      version: CACHE_VERSION
    })); 
  } catch (e) {
    console.warn('[Cache] Set failed:', e);
  }
}

export function cacheClear() { 
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch (e) {}
}

// ═══════════════════════════════════════════════════════════════
// ENHANCED FIRESTORE OPERATIONS WITH RETRY
// ═══════════════════════════════════════════════════════════════
export async function retryOperation(operation, maxRetries = 3, delayMs = 1000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      console.warn(`[Retry] Attempt ${attempt}/${maxRetries} failed:`, error);
      
      if (attempt === maxRetries) {
        throw error;
      }
      
      // Exponential backoff
      await new Promise(resolve => setTimeout(resolve, delayMs * attempt));
    }
  }
}

export async function safeUpdateDoc(docRef, updates) {
  return retryOperation(() => updateDoc(docRef, updates));
}

export async function safeSetDoc(docRef, data, options) {
  return retryOperation(() => setDoc(docRef, data, options));
}

export async function safeGetDoc(docRef) {
  return retryOperation(() => getDoc(docRef));
}

// ═══════════════════════════════════════════════════════════════
// NAVIGATION & ROUTING
// ═══════════════════════════════════════════════════════════════
export const go = href => { location.href = href; };
window.go = go; 

// ✅ PRODUCTION: Enhanced points system with sync
export function addPts(n) { 
  const currentPts = parseInt(LS('points')) || 0;
  const newPts = currentPts + parseInt(n);
  
  SS('points', newPts); 
  
  const uid = LS('uid');
  if (uid) {
    safeUpdateDoc(doc(db, 'users', uid), { points: newPts })
      .catch(e => console.warn("[Points] Sync skipped:", e));
  }
}

export async function loadNavigation() {
  const placeholder = document.getElementById('nav-placeholder');
  if (!placeholder) return; 

  try {
    const response = await fetch('nav.html');
    if (!response.ok) throw new Error('Nav fetch failed');
    
    const html = await response.text();
    placeholder.innerHTML = html;

    if (LS('role') === 'merchant') {
      const mBtn = document.getElementById('nav-merchant');
      if (mBtn) mBtn.style.display = '';
    }

    const path = window.location.pathname;
    if (path.includes('map.html')) {
      document.getElementById('nav-map')?.classList.add('on');
    } else if (path.includes('home.html')) {
      document.getElementById('nav-home')?.classList.add('on');
    } else if (path.includes('profile.html')) {
      document.getElementById('nav-profile')?.classList.add('on');
    }
  } catch (error) { 
    console.error("[Nav] Failed to load:", error); 
  }
}

// ═══════════════════════════════════════════════════════════════
// ANALYTICS
// ═══════════════════════════════════════════════════════════════
const GA_MEASUREMENT_ID = 'G-71Y2Y75FLQ'; 

function initAnalytics() {
  if (window.gtag) return; 

  const script = document.createElement('script');
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`;
  document.head.appendChild(script);

  window.dataLayer = window.dataLayer || [];
  function gtag(){ window.dataLayer.push(arguments); }
  window.gtag = gtag; 
  
  gtag('js', new Date());
  gtag('config', GA_MEASUREMENT_ID, {
    page_path: window.location.pathname
  });
}

initAnalytics();

// ═══════════════════════════════════════════════════════════════
// PUSH NOTIFICATION HANDLING
// ═══════════════════════════════════════════════════════════════
export async function requestPushPermissions(uid) {
  if (!('Notification' in window)) return;
  
  if (Notification.permission === 'granted') {
    fetchAndSaveToken(uid);
    return;
  }
  
  if (Notification.permission === 'denied' || sessionStorage.getItem('push_asked')) return;

  if (document.getElementById('mod-push')) return;

  const modal = document.createElement('div');
  modal.className = 'modal on';
  modal.id = 'mod-push';
  modal.style.cssText = 'z-index:999999; background: rgba(0,0,0,0.6); backdrop-filter: blur(4px); pointer-events: auto;';
  
  modal.innerHTML = `
    <div class="msht" style="text-align:center; padding: 30px 20px 20px; pointer-events: auto;">
      <div class="mh"></div>
      <div style="font-size:54px; margin-bottom:12px; filter: drop-shadow(0 4px 12px rgba(255,87,34,0.3));">🔔</div>
      <h3 style="font-family:'Syne',sans-serif; font-size:22px; font-weight:800; color:var(--deep); margin-bottom:8px;">Never Miss a Deal</h3>
      <p style="font-size:14px; color:var(--gray); margin-bottom:24px; line-height:1.5; font-weight:600;">
        NearPop needs notification access to ping your phone the second you walk past a massive discount.
      </p>
      <button id="btn-allow-push" style="width:100%; padding:14px; background:var(--or); color:#fff; border:none; border-radius:14px; font-size:15px; font-weight:800; cursor:pointer; margin-bottom:10px; box-shadow:0 4px 14px rgba(255,87,34,0.3); font-family:inherit;">Yes, Notify Me!</button>
      <button id="btn-deny-push" style="width:100%; padding:14px; background:var(--light); color:var(--gray); border:none; border-radius:14px; font-size:14px; font-weight:700; cursor:pointer; font-family:inherit;">Maybe Later</button>
    </div>
  `;

  document.body.appendChild(modal);

  modal.querySelector('#btn-allow-push').onclick = async () => {
    modal.remove();
    sessionStorage.setItem('push_asked', 'true');
    
    const permission = await Notification.requestPermission();
    if (permission === 'granted') {
      fetchAndSaveToken(uid);
    } else {
      toast('⚠️', 'Alerts blocked. You can enable them in your browser settings later.');
    }
  };

  modal.querySelector('#btn-deny-push').onclick = () => {
    modal.remove();
    sessionStorage.setItem('push_asked', 'true');
  };
}

async function fetchAndSaveToken(uid) {
  if (!messaging) return;
  
  try {
    const vapidKey = "BJWz7jdnCy1hb-E8M-7-Q2wanQdNY46Rw7T9I8g_EPr02m-AYAxhGCM7QBm7DpL0WgE-nSnud5mqBK6MWd4w6T0"; 
    const currentToken = await getToken(messaging, { vapidKey });
    
    if (currentToken) {
      await safeUpdateDoc(doc(db, 'users', uid), {
        fcmToken: currentToken,
        tokenUpdatedAt: Date.now()
      });
      console.log("[FCM] Token secured and saved.");
    }
  } catch (error) {
    console.warn("[FCM] Failed to get token:", error);
  }
}

export async function triggerLocalBuzz(title, body, url) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (reg) {
      reg.showNotification(title, {
        body: body,
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-192.png',
        vibrate: [200, 100, 200, 100, 200], 
        data: { url: url || '/map.html' },
        requireInteraction: true
      });
    }
  } catch (e) { console.error('[Buzz] Failed:', e); }
}

// ═══════════════════════════════════════════════════════════════
// SERVICE WORKER AUTO-UPDATE
// ═══════════════════════════════════════════════════════════════
let newWorker;

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').then(reg => {
    reg.addEventListener('updatefound', () => {
      newWorker = reg.installing;
      newWorker.addEventListener('statechange', () => {
        if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
          showUpdatePopup();
        }
      });
    });
  });

  let refreshing;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) return;
    window.location.reload();
    refreshing = true;
  });
}

function showUpdatePopup() {
  if (document.getElementById('np-update-pill')) return; 

  const ui = document.createElement('div');
  ui.id = 'np-update-pill';
  ui.innerHTML = `
    <div style="position:fixed; bottom:24px; left:50%; transform:translateX(-50%); background:var(--or, #FF5722); color:#fff; padding:12px 18px; border-radius:100px; font-weight:800; font-size:14px; box-shadow:0 6px 20px rgba(255,87,34,0.4); z-index:999999; cursor:pointer; display:flex; align-items:center; gap:10px; font-family:'Nunito', sans-serif; white-space:nowrap; animation: slideUp 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);">
      🚀 Update Available! 
      <span style="background:#fff; color:var(--deep, #0F0F13); padding:5px 12px; border-radius:100px; font-size:12px; font-weight:900;">Refresh</span>
    </div>
    <style>@keyframes slideUp { from { opacity: 0; transform: translate(-50%, 20px); } to { opacity: 1; transform: translate(-50%, 0); } }</style>
  `;
  
  ui.onclick = () => {
    ui.style.opacity = '0.5';
    ui.style.pointerEvents = 'none';
    if (newWorker) newWorker.postMessage({ type: 'SKIP_WAITING' });
  };
  
  document.body.appendChild(ui);
}

// ═══════════════════════════════════════════════════════════════
// PWA INSTALL PROMPT
// ═══════════════════════════════════════════════════════════════
window.deferredPWA = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); 
  window.deferredPWA = e; 
});

console.log('[App] NearPop Foundation v2.0 loaded');
