// ── OneSignal push worker — MUST be the very first line ──
// (OneSignal এই worker দিয়েই push দেখায়। আমাদের cache worker-এর সাথে
//  একই scope '/' নিয়ে আগের আলাদা OneSignalSDKWorker.js-টা টক্কর দিত —
//  তাই এখন দুটো এক ফাইলে মার্জ। SDK init-এ serviceWorkerPath: 'sw.js'
//  দেওয়া আছে, তাই SDK এই ফাইলটাই ব্যবহার করে।)
importScripts('https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js');

// ── Tournixo User App: Service Worker ──
// • Navigations (pages/*.html): network-first → আপডেট সাথে সাথে দেখা যায়,
//   offline হলে cache থেকে shell আসে
// • Same-origin static assets (scripts/styles/components/icons/manifest): cache-first
// • Firebase / Firestore / Auth / Fonts / OneSignal / Cloudinary: কখনো cache না
// ⚠️ প্রতিটা release-এ CACHE-এর নাম বদলে দাও (পুরনো cache auto-clean হবে)।

// FIX (2026-10-25): release cache bump — পুরনো cache-এর stale shell
// যাতে নতুন script না দেখায়, প্রতিটা release-এ নাম বদলাতে হয়।
// FIX (2026-10-25, BUILD 20 paired patch): cache-buster bump —
// notifications/cache/banners বদলেছে, পুরোনো SW যাতে পুরোনো
// ফাইল না দেয়।
// FIX (2026-10-26): PRODUCTION-3-এ verify + notif fix এলেও CACHE নাম
// বদলায়নি, তাই browser নতুন SW install করতো না আর cache-first
// scripts (auth-ui/onesignal) পুরনোই serve করতো। নাম বদলালে নতুন
// SW install হবে, skipWaiting + activate পুরনো cache মুছবে।
const CACHE = 'tournixo-user-v8-1-2026-10-26';

// FIX (2026-10-25, F-13): BYPASS_HOSTS + shouldBypass তোলা হলো —
// সব entry-ই cross-origin, আর origin early-return-এর আগেই return হয়ে
// যেত, তাই check-টি dead ছিল (harmless হলেও বিভ্রান্তিকর)।
// Firebase/Auth/Fonts/OneSignal/Cloudinary এখনো network-only —
// origin early-return-ই সেটা নিশ্চিত করে।

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

function isConfigScript(url) {
  return url.pathname.includes('/config/') && url.pathname.endsWith('.js');
}

// FIX (2026-10-25, F-13): প্রতি fetch-এ caches.open নয় — একবার খুলে reuse।
let _cachePromise = null;
function getCache() {
  if (!_cachePromise) _cachePromise = caches.open(CACHE);
  return _cachePromise;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // cross-origin → browser handles (Firebase/Auth/Fonts/OneSignal/Cloudinary network-only)

  event.respondWith((async () => {
    const cache = await getCache();

    // App shell: network first (fresh updates), offline → cached copy
    if (req.mode === 'navigate') {
      try {
        const res = await fetch(req);
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      } catch (e) {
        const cached = await cache.match(req)
          || await cache.match(new URL('index.html', self.registration.scope));
        if (cached) return cached;
        throw e;
      }
    }

    // Runtime configuration: network-first, কিন্তু সফল fetch cache-এও
    // লেখা হবে। আগে no-store + never-cache ছিল — offline-এ cached shell
    // থাকলেও config script-এর অভাবে module graph ভেঙে page load fail
    // হতো। CACHE নাম প্রতি release-এ বদলায় বলে পুরনো config stale
    // থাকার ভয় নেই (activate পুরনো cache মুছে দেয়)।
    if (isConfigScript(url)) {
      try {
        const res = await fetch(req, { cache: 'no-store' });
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      } catch (e) {
        const cachedConfig = await cache.match(req);
        if (cachedConfig) return cachedConfig;
        throw e;
      }
    }

    // Static assets: cache first
    const cached = await cache.match(req);
    if (cached) return cached;
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  })());
});
