import { ONESIGNAL_CONFIG } from '../config/onesignal-config.js';
import { STORAGE_KEYS } from '../utils/constants.js';
import { state } from '../scripts/state.js';
import { showNotifPopup } from '../scripts/notif-popup.js';
import { goTo } from '../config/app-config.js';

/*
 * ─────────────────────────────────────────────────────────────
 * FIXES APPLIED:
 * 1. ❌ Line 36: `console.log("Permission: ", permission)` in production
 *    ✅ সরানো হয়েছে → শুধু console.warn শুধু error case এ, dev-এ চাইলে
 *       __DEV__ flag দিয়ে log করা যাবে।
 * 2. ✅ সব console.* guarded — production এ spam হবে না।
 * ─────────────────────────────────────────────────────────────
 */

// ✅ Central dev flag — flip to true only in local dev
const __DEV__ = false;
const log = (...args) => { if (__DEV__) console.log(...args); };
const warn = (...args) => { if (__DEV__) console.warn(...args); };

let _initStarted = false;
let _permWatchStarted = false;
let _toggleBusy = false;
let _pushPromptFlowStarted = false;

let _resolveReady;
let _ready = new Promise(resolve => { _resolveReady = resolve; });
// FIX (2026-10-26): _ready একবার null-এ resolve হলে (SDK load fail)
// আগের কোডে same session-এ retry আর কখনো সফল হতো না — waitForSdk
// সাথে সাথে null ফেরত দিত, script আবার load করার চেষ্টাই হতো না,
// অথচ banner বলত "Tap again to retry"। তাই retry-র জন্য promise
// reset + script re-inject-এর ব্যবস্থা রাখা হলো।
let _sdkLoadFailed = false;

function resetReadyForRetry() {
    _ready = new Promise(resolve => { _resolveReady = resolve; });
    _sdkLoadFailed = false;
}

function injectSdkScript() {
    if (document.querySelector('script[data-onesignal-sdk]')) return false;
    const s = document.createElement('script');
    s.src = ONESIGNAL_CONFIG.sdkUrl;
    s.defer = true;
    s.setAttribute('data-onesignal-sdk', '1');
    s.onerror = () => {
        warn('[OneSignal] SDK failed to load (blocked or offline).');
        _sdkLoadFailed = true;
        _resolveReady(null);
    };
    document.head.appendChild(s);
    return true;
}

// FIX (2026-10-26): প্রথম wait fail করার পরের phase — failed script
// থাকলে fresh load, তারপর আরো 20s wait। init callback
// window.OneSignalDeferred queue-তে আগেই আছে, তাই fresh SDK সেটা
// নিজে চালাবে — আবার push করলে double-init হতো, তাই push করা হয় না।
async function waitForSdkRetryPhase() {
    if (_sdkLoadFailed) {
        const old = document.querySelector('script[data-onesignal-sdk]');
        if (old) old.remove();
        resetReadyForRetry();
        injectSdkScript();
    }
    return waitForSdk(20000);
}

function deferred() {
    window.OneSignalDeferred = window.OneSignalDeferred || [];
    return window.OneSignalDeferred;
}

function waitForSdk(ms = 6000) {
    return Promise.race([
        _ready,
        new Promise(resolve => setTimeout(() => resolve(null), ms))
    ]);
}

function notifSupported() {
    return typeof Notification !== 'undefined';
}

function browserPermission() {
    return notifSupported() ? Notification.permission : 'unsupported';
}

function savedPrefIsOff() {
    try { return localStorage.getItem(STORAGE_KEYS.notifications) === 'off'; }
    catch (e) { return false; }
}

// v8.0 Capacitor: native APK-তে web OneSignal SDK চলে না (service worker
// WebView-এ web push-এর মতো কাজ করে না)। Native push আলাদা — Capacitor
// PushNotifications / OneSignal native SDK-এর কাজ, এই web bundle-এর নয়।
// তাই native-এ web SDK লোডই করা হবে না, আর ভুল "failed to load" popupও
// দেখানো হবে না। Website-এ (Netlify) নিচের web flow-ই চলবে।
export function isCapacitorNative() {
    try {
        if (typeof window !== 'undefined' && window.Capacitor) {
            if (typeof window.Capacitor.isNativePlatform === 'function') return window.Capacitor.isNativePlatform();
            if (typeof window.Capacitor.getPlatform === 'function') return window.Capacitor.getPlatform() !== 'web';
            return true;
        }
    } catch (e) {}
    return false;
}

function savePref(value) {
    try { localStorage.setItem(STORAGE_KEYS.notifications, value); } catch (e) {}
}

function pushPromptWasAsked() {
    try { return localStorage.getItem(STORAGE_KEYS.pushPromptAsked) === '1'; }
    catch (e) { return false; }
}

function markPushPromptAsked() {
    try { localStorage.setItem(STORAGE_KEYS.pushPromptAsked, '1'); } catch (e) {}
}

function setToggle(el, on) {
    if (!el) return;
    el.classList.toggle('on', !!on);
    el.setAttribute('aria-checked', on ? 'true' : 'false');
}

export function initOneSignal() {
    if (_initStarted) return;
    _initStarted = true;

    // v8.0: Capacitor native-এ web SDK skip — নইলে WebView-এ init fail করে
    // "push service failed" popup আসত, যদিও native push-এর রাস্তা আলাদা।
    if (isCapacitorNative()) {
        _resolveReady(null);
        syncNotifToggleUI();
        return;
    }

    // ✅ FIX: আসল App ID না বসানো পর্যন্ত OneSignal সম্পূর্ণ skip করা হবে।
    // আগে placeholder ID নিয়ে SDK লোড হতো আর init silently fail করতো।
    const appId = String(ONESIGNAL_CONFIG.appId || '').trim();
    if (!appId || appId.includes('YOUR_')) {
        warn('[OneSignal] Skipped — set a real appId in config/onesignal-config.js to enable push notifications.');
        _resolveReady(null);
        syncNotifToggleUI();
        return;
    }

    injectSdkScript();

    deferred().push(async function(OneSignal) {
        try {
            await OneSignal.init({
                appId: ONESIGNAL_CONFIG.appId,
                allowLocalhostAsSecureOrigin: ONESIGNAL_CONFIG.allowLocalhostAsSecureOrigin,
                // The post-login flow decides when to show this; never auto-nag
                // on every app open.
                promptOptions: {
                    slidedown: {
                        prompts: [{
                            type: 'push',
                            autoPrompt: false,
                            text: {
                                actionMessage: 'Get match, room and prize updates instantly.',
                                acceptButton: 'Allow',
                                cancelButton: 'Later'
                            },
                            delay: { pageViews: 1, timeDelay: 0 }
                        }]
                    }
                },
                // মার্জ করা worker (sw.js-এর মাথায় OneSignal worker import করা):
                // আলাদা OneSignalSDKWorker.js রাখলে একই scope নিয়ে দুই worker
                // পালাবদলি হয় — তখন push এলেও স্ক্রিনে দেখা যায় না।
                // v8.0: '/sw.js' (origin-root) — 'sw.js' লিখলে /pages/profile.html
                // থেকে SDK /pages/sw.js খুঁজত, যেটা নেই, তাই init fail হতো।
                serviceWorkerPath: '/sw.js',
                serviceWorkerParam: { scope: '/' }
            });
        } catch (e) {
            warn('[OneSignal] init failed:', e.message);
            _resolveReady(null);
            return;
        }
        _resolveReady(OneSignal);

        // FIX (notifications): a push that arrives while the app is in the
        // FOREGROUND shows our premium in-app popup (top slide-down) instead
        // of being swallowed. When the app is in the background or closed,
        // the service worker shows the normal Android/iOS-style system
        // notification in the phone's notification panel — untouched here.
        try {
            if (OneSignal.Notifications && typeof OneSignal.Notifications.addEventListener === 'function') {
                OneSignal.Notifications.addEventListener('foregroundWillDisplay', (event) => {
                    try { if (typeof event.preventDefault === 'function') event.preventDefault(); } catch (e) {}
                    const n = event.notification || {};
                    showNotifPopup({
                        type: 'push',
                        title: n.title || 'Tournixo',
                        body: n.body || n.message || '',
                        onTap: () => goTo('notifications')
                    });
                });
            }
        } catch (e) {}

        // Permission is requested once from the post-login Home flow below
        // (maybePromptForPushOnce) and remains available afterwards from the
        // Profile Notifications toggle. There is deliberately no auto-prompt
        // on page load, which used to repeat whenever it was dismissed.
    });

    syncNotifToggleUI();
}

export function syncNotifToggleUI() {
    const el = document.getElementById('notif-toggle');
    if (!el) return;

    setToggle(el, browserPermission() === 'granted' && !savedPrefIsOff());

    waitForSdk(4000).then(OneSignal => {
        if (!OneSignal) return;
        try {
            const optedIn = OneSignal.User?.PushSubscription?.optedIn;
            if (optedIn === false) setToggle(el, false);
        } catch (e) {}
    });

    if (!_permWatchStarted && navigator.permissions?.query) {
        _permWatchStarted = true;
        navigator.permissions.query({ name: 'notifications' }).then(status => {
            status.onchange = () => syncNotifToggleUI();
        }).catch(() => {});
    }
}

// One-time, post-login invitation from Home. A local flag is written before
// the prompt is shown, so accepting, dismissing or closing it never causes
// the invitation to reappear on later opens. The Profile toggle remains the
// permanent manual route.
export async function maybePromptForPushOnce(uid = state.currentUser?.uid) {
    if (_pushPromptFlowStarted || !uid) return;
    if (!notifSupported() || browserPermission() !== 'default') return;
    if (savedPrefIsOff() || pushPromptWasAsked()) return;

    _pushPromptFlowStarted = true;
    const OneSignal = await waitForSdk(6000);
    if (browserPermission() !== 'default' || savedPrefIsOff()) return;

    markPushPromptAsked();

    try {
        if (typeof OneSignal?.Slidedown?.promptPush === 'function') {
            await OneSignal.Slidedown.promptPush();
            // The SDK creates the subscription after an Allow tap; login is
            // idempotent and keeps the resulting subscription tied to this uid.
            if (browserPermission() === 'granted') {
                try { await OneSignal.login(uid); } catch (e) {}
                savePref('on');
                syncNotifToggleUI();
            }
            return;
        }
    } catch (e) {
        warn('OneSignal slidedown failed:', e.message);
    }

    const finishWithNativePermission = async () => {
        try {
            const perm = await Notification.requestPermission();
            if (perm !== 'granted') return;
            try {
                if (OneSignal?.User?.PushSubscription) await OneSignal.User.PushSubscription.optIn();
                if (OneSignal) await OneSignal.login(uid);
            } catch (e) { /* browser permission is granted; SDK association is best effort */ }
            savePref('on');
            syncNotifToggleUI();
            if (typeof window.showToast === 'function') {
                window.showToast('Notifications enabled', 'success', 3000);
            }
        } catch (e) {
            warn('Notification permission request failed:', e.message);
        }
    };

    // Same custom confirm-dialog pattern used elsewhere in the app when the
    // OneSignal Slidedown API is unavailable in the loaded SDK build.
    if (typeof window.showConfirm === 'function') {
        window.showConfirm(
            'Enable notifications?',
            'Get instant updates for match rooms, results and prize credits. You can change this later in Profile.',
            finishWithNativePermission
        );
    } else {
        await finishWithNativePermission();
    }
}

export async function toggleNotifications(el) {
    if (_toggleBusy) return;
    _toggleBusy = true;
    try {
        const turningOn = !el.classList.contains('on');

        if (!turningOn) {
            savePref('off');
            setToggle(el, false);
            window.showToast('Notifications disabled', 'info', 2000);
            waitForSdk(3000).then(async OneSignal => {
                try {
                    if (OneSignal?.User?.PushSubscription) await OneSignal.User.PushSubscription.optOut();
                } catch (e) {}
            });
            return;
        }

        if (!notifSupported()) {
            setToggle(el, false);
            window.showToast('Notifications are not supported on this device or browser', 'warning', 3500);
            return;
        }
        if (Notification.permission === 'denied') {
            setToggle(el, false);
            window.showToast('Notifications are blocked. Allow them in your browser / app settings, then try again.', 'warning', 5000);
            return;
        }

        // Native permission prompt FIRST — this opens the browser/OS dialog
        // (on Android Chrome it IS the Android-style permission sheet; on iOS
        // it is the iOS prompt). It works with or without the OneSignal SDK.
        // A page cannot force the grant — the user must tap "Allow".
        if (Notification.permission !== 'granted') {
            const perm = await Notification.requestPermission();
            if (perm !== 'granted') {
                setToggle(el, false);
                window.showToast('Notification permission was not granted', 'warning', 3500);
                return;
            }
        }

        // v8.0 Capacitor: web SDK-এর বদলে শুধু local pref রাখো — native
        // push Capacitor plugin দিয়ে আলাদাভাবে চালু করতে হবে (CAPACITOR.md দেখো)।
        if (isCapacitorNative()) {
            savePref('on');
            setToggle(el, true);
            window.showToast('Notifications preference saved. Native app-এ push Capacitor plugin দিয়ে চালু হবে — web OneSignal এখানে চলে না।', 'info', 5000);
            return;
        }

        // OneSignal push registration — best effort, only if the SDK loaded
        // (needs a real App ID in config/onesignal-config.js for remote push).
        // v8.0: 2500ms ছিল — slow mobile network-এ (screenshot-এ 4 KB/s)
        // SDK script আসার আগেই timeout হয়ে "failed to load" popup আসত,
        // যদিও permission granted ছিল। এখন 10s পর্যন্ত অপেক্ষা।
        // FIX (2026-10-26): slow network-এ (5 KB/s screenshot) 10s-ও কম
        // পড়ে, তাই fail হলে retry phase-এ আরো 20s (মোট ~30s) অপেক্ষা
        // হবে। অপেক্ষার সময় user যাতে বুঝতে পারে, connecting toast
        // দেখানো হবে — toggle চুপচাপ OFF-এ ফিরবে না।
        let OneSignal = await waitForSdk(10000);
        if (!OneSignal) {
            if (typeof window.showToast === 'function') {
                window.showToast('Push service-এ connect হচ্ছে… একটু অপেক্ষা করো', 'info', 3000);
            }
            OneSignal = await waitForSdkRetryPhase();
        }
        try {
            if (OneSignal?.User?.PushSubscription) await OneSignal.User.PushSubscription.optIn();
            if (OneSignal && state.currentUser?.uid) await OneSignal.login(state.currentUser.uid);
        } catch (e) { /* local permission already granted; remote push optional */ }

        // v8.0: SDK না এলে toggle ON-এ আটকে রাখা হবে না — আগের কোড
        // pref 'on' সেভ করে toggle ON দেখাত, তাই user আবার tap করলে
        // সেটা OFF হতো, retry-র কোনো রাস্তা থাকত না। এখন toggle OFF-এ
        // ফেরে, যাতে আবার tap করে retry করা যায়। Browser permission
        // granted থাকলেও remote push SDK ছাড়া আসবে না; in-app inbox
        // (Notifications পেজ) Firestore দিয়ে আলাদাভাবে চলতে থাকে।
        if (!OneSignal) {
            // Retry-র জন্য pref 'off' রাখো — নইলে পরের page load-এ
            // syncNotifToggleUI (permission granted দেখে) toggle আবার ON দেখাত।
            savePref('off');
            setToggle(el, false);
            const appIdMissing = String(ONESIGNAL_CONFIG.appId || '').indexOf('YOUR_') === 0;
            window.showToast(
                appIdMissing
                    ? 'Notifications allowed on this device. Set your OneSignal App ID to enable remote push.'
                    : 'Push service could not connect (slow/blocked connection or SDK blocked). Tap again to retry remote push — in-app notifications still work.',
                'warning',
                5000
            );
            return;
        }
        savePref('on');
        setToggle(el, true);
        // FIX (2026-10-26): শুধু "enabled" নয় — user যাতে স্পষ্ট
        // দেখতে পায় notification ON হয়েছে এবং এখন থেকে app বন্ধ
        // থাকলেও mobile panel-এ notification আসবে।
        window.showToast('Notifications ON ✅ — এখন app বন্ধ থাকলেও mobile-এর notification panel-এ Tournixo notification আসবে', 'success', 5000);
    } catch (e) {
        warn('toggleNotifications error:', e.message);
        syncNotifToggleUI();
        window.showToast('Could not change notification setting. Please try again.', 'error', 3500);
    } finally {
        _toggleBusy = false;
    }
}

export function oneSignalLogin(uid) {
    deferred().push(async function(OneSignal) {
        try { await OneSignal.login(uid); } catch (e) {}
    });
}

export function oneSignalLogout() {
    deferred().push(async function(OneSignal) {
        try { await OneSignal.logout(); } catch (e) {}
    });
}

window.toggleNotifications = toggleNotifications;