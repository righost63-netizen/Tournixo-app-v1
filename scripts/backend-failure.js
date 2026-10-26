// ════════════════════════════════════════════════════════════════
// FIREBASE BACKEND FAILURE DIALOG (2026-10-25)
// ────────────────────────────────────────────────────────────────
// সার্ভার (quota / outage / config) সমস্যা হলে premium, mobile-friendly
// dialog দেখায়। কোনো ৫/১০ মিনিটের health-check polling নেই — শুধু
// বিদ্যমান Firebase request-এর error + connection event থেকেই detect হয়:
//   • firebase-init.js-এর wrapper প্রতিটা Firestore call-এর error/success
//     এখানে report করে (getDoc/getDocs/runTransaction/onSnapshot/লেখা)।
//   • app.js (user-doc listener) + cache.js (appConfig sync) core
//     permission/config failure reportCoreFailure দিয়ে জানায়।
//
// TRANSIENT vs CONFIRMED:
//   • একটা/দুটো unavailable ভুল = transient — dialog নয় (toast/skeleton-ই
//     যথেষ্ট)। ৬০s-এর মধ্যে ৩টা outage-ধরনের failure = confirmed outage।
//   • resource-exhausted (quota) একবারই conclusive — সাথে সাথে dialog।
//   • permission-denied সাধারণত access control (যেমন room-এর বাইরের
//     viewer) — generic wrapper এটা dialog-এ তোলে না; শুধু core doc
//     (নিজের user doc / appConfig) deny হলেই reportCoreFailure দিয়ে
//     config dialog আসবে।
//   • failed-precondition (missing index) fallbacks-এর কাজ — dialog নয়।
//   • offline (navigator.onLine === false) হলে offline banner-ই মালিক —
//     এই dialog দেখাবে না।
//
// SINGLETON + RECOVERY + SAFE RETRY:
//   • dialog একটাই হবে; খোলা থাকলে kind শুধু escalate হবে (quota সবার উপরে)।
//   • recovery ধরা হয় পরের সফল server roundtrip থেকে (runTransaction
//     success, fromCache=false snapshot, listener snapshot) — তখন dialog
//     নিজে বন্ধ হবে + "সংযোগ ফিরে এসেছে" toast আসবে।
//   • Retry = page reload (শুধু read) — কোনো write resubmit হয় না, তাই
//     duplicate payment/join অসম্ভব। Dismiss করলে ৫ মিনিট suppress
//     থাকবে (quota ছাড়া)।
//   • dialog খোলা থাকলে + dismiss-এর পরেও backendDown flag থাকলে slim
//     stale banner দেখাবে: balance/payment/slot-কে live ধরা যাবে না।
// ════════════════════════════════════════════════════════════════

const OUTAGE_WINDOW_MS = 60 * 1000;
const OUTAGE_THRESHOLD = 3;
const DISMISS_SUPPRESS_MS = 5 * 60 * 1000;

let _outageStamps = [];
let _dialogEl = null;
let _dialogKind = null;
let _dialogOpen = false;
let _backendDown = false;
let _dismissedAt = 0;
let _dismissedKind = null;
let _staleBannerEl = null;

const KIND_PRIORITY = { quota: 3, config: 2, outage: 1 };

const KIND_TEXT = {
    quota: {
        title: 'সার্ভারের সীমা শেষ',
        body: 'Tournixo সার্ভারের আজকের ব্যবহারের সীমা (quota) শেষ হয়ে গেছে। এই সীমা শুধু সার্ভার থেকেই রিসেট হয় — অ্যাপ থেকে রিসেট বা ঠিক করা যাবে না। কিছুক্ষণ পর আবার চেষ্টা করুন, অথবা পরে ফিরে আসুন।',
    },
    outage: {
        title: 'সার্ভারে সাময়িক সমস্যা',
        body: 'সার্ভারে সাময়িক সমস্যা হচ্ছে। অনুগ্রহ করে কিছুক্ষণ পর আবার চেষ্টা করুন।',
    },
    config: {
        title: 'সার্ভার সেটিংসে সমস্যা',
        body: 'সার্ভার সেটিংসে সমস্যা হচ্ছে — আপনার অ্যাকাউন্টের তথ্য লোড করা যাচ্ছে না। কিছুক্ষণ পর আবার চেষ্টা করুন। সমস্যা থাকলে অ্যাডমিনকে জানান।',
    },
};

const STALE_NOTE = 'এই মুহূর্তে দেখানো ব্যালেন্স, পেমেন্ট স্ট্যাটাস বা স্লট সংখ্যা পুরনো হতে পারে — এগুলোকে live তথ্য হিসেবে ধরবেন না।';

function classifyKind(code) {
    if (code === 'resource-exhausted') return 'quota';
    if (code === 'unavailable' || code === 'deadline-exceeded' || code === 'internal' || code === 'data-loss') return 'outage';
    return null; // transient / access-control / index / auth — dialog নয়
}

function ensureStyles() {
    if (document.getElementById('backend-failure-styles')) return;
    const st = document.createElement('style');
    st.id = 'backend-failure-styles';
    st.textContent = `
        .bf-overlay{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;background:rgba(0,0,0,.6);backdrop-filter:blur(3px);}
        .bf-card{width:min(92vw,360px);background:var(--bg3,#1c1c22);border:1px solid rgba(255,215,0,.35);border-radius:20px;padding:22px 20px;text-align:center;box-shadow:0 18px 50px rgba(0,0,0,.5);}
        .bf-icon{font-size:34px;margin-bottom:10px;}
        .bf-title{font-size:17px;font-weight:800;color:var(--text,#fff);margin-bottom:8px;}
        .bf-body{font-size:13.5px;line-height:1.6;color:var(--text2,#ccc);margin-bottom:10px;}
        .bf-stale{font-size:12px;line-height:1.5;color:var(--gold,#ffd700);background:rgba(255,215,0,.08);border:1px solid rgba(255,215,0,.25);border-radius:10px;padding:8px 10px;margin-bottom:16px;}
        .bf-btn{width:100%;padding:12px;border-radius:12px;border:none;font-size:15px;font-weight:700;cursor:pointer;}
        .bf-retry{background:linear-gradient(135deg,#ffd700,#ffaa00);color:#111;margin-bottom:10px;}
        .bf-dismiss{background:transparent;color:var(--text2,#ccc);border:1px solid var(--border,#333);}
        .bf-stale-banner{position:fixed;top:0;left:0;right:0;z-index:9998;text-align:center;font-size:12.5px;font-weight:600;color:#111;background:#ffd700;padding:8px 12px;}
    `;
    document.head.appendChild(st);
}

function setBackendDown(down) {
    _backendDown = down;
    try {
        document.documentElement.classList.toggle('backend-down', down);
    } catch (e) {}
    if (down) {
        if (!_staleBannerEl || !document.body.contains(_staleBannerEl)) {
            _staleBannerEl = document.createElement('div');
            _staleBannerEl.className = 'bf-stale-banner';
            _staleBannerEl.setAttribute('role', 'status');
            _staleBannerEl.textContent = '⚠️ সার্ভার সমস্যা — দেখানো তথ্য পুরনো হতে পারে';
            document.body.appendChild(_staleBannerEl);
        }
    } else if (_staleBannerEl) {
        _staleBannerEl.remove();
        _staleBannerEl = null;
    }
}

function showDialog(kind) {
    if (!document.body) return;
    // Dismiss suppress (quota ছাড়া, escalate ছাড়া)।
    if (_dialogOpen) {
        if (KIND_PRIORITY[kind] <= KIND_PRIORITY[_dialogKind]) return;
    } else if (_dismissedKind && _dismissedAt && (Date.now() - _dismissedAt) < DISMISS_SUPPRESS_MS) {
        if (kind !== 'quota' && KIND_PRIORITY[kind] <= KIND_PRIORITY[_dismissedKind]) return;
    }
    ensureStyles();
    const text = KIND_TEXT[kind] || KIND_TEXT.outage;
    if (_dialogEl && document.body.contains(_dialogEl)) {
        _dialogEl.querySelector('.bf-title').textContent = text.title;
        _dialogEl.querySelector('.bf-body').textContent = text.body;
        _dialogKind = kind;
        return;
    }
    const overlay = document.createElement('div');
    overlay.className = 'bf-overlay';
    overlay.setAttribute('role', 'alertdialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.innerHTML = `
        <div class="bf-card">
            <div class="bf-icon">⚠️</div>
            <div class="bf-title">${text.title}</div>
            <div class="bf-body">${text.body}</div>
            <div class="bf-stale">${STALE_NOTE}</div>
            <button class="bf-btn bf-retry" type="button">🔄 আবার চেষ্টা করুন</button>
            <button class="bf-btn bf-dismiss" type="button">বন্ধ করুন</button>
        </div>`;
    overlay.querySelector('.bf-retry').addEventListener('click', () => {
        // SAFE retry: শুধু page reload (read-only)। কোনো join/payment/
        // withdrawal resubmit হয় না — সেগুলো user-এর নতুন tap ছাড়া চলে না।
        window.location.reload();
    });
    overlay.querySelector('.bf-dismiss').addEventListener('click', () => {
        _dismissedAt = Date.now();
        _dismissedKind = _dialogKind;
        closeDialog();
    });
    document.body.appendChild(overlay);
    _dialogEl = overlay;
    _dialogKind = kind;
    _dialogOpen = true;
    setBackendDown(true);
}

function closeDialog() {
    if (_dialogEl) {
        _dialogEl.remove();
        _dialogEl = null;
    }
    _dialogOpen = false;
    _dialogKind = null;
}

// Generic reporter — firebase-init wrapper থেকে আসে।
export function reportFirebaseError(err) {
    try {
        if (typeof navigator !== 'undefined' && navigator.onLine === false) return; // offline banner-এর কাজ
        const kind = classifyKind(err?.code);
        if (!kind) return;
        if (kind === 'quota') {
            setBackendDown(true);
            showDialog('quota');
            return;
        }
        const now = Date.now();
        _outageStamps = _outageStamps.filter(ts => now - ts < OUTAGE_WINDOW_MS);
        _outageStamps.push(now);
        if (_outageStamps.length >= OUTAGE_THRESHOLD) {
            setBackendDown(true);
            showDialog('outage');
        }
    } catch (e) { /* dialog কখনো page ভাঙবে না */ }
}

// Core doc (নিজের user doc / appConfig) permission/config failure —
// app.js + cache.js থেকে আসে। সাধারণ access-control denial এখানে আসে না।
export function reportCoreFailure(err) {
    try {
        if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
        if (err?.code === 'permission-denied' || err?.code === 'failed-precondition') {
            setBackendDown(true);
            showDialog('config');
        }
    } catch (e) {}
}

// Recovery signal — শুধু আসল server roundtrip গোনা হবে:
// runTransaction success, fromCache=false snapshot। Offline write-এর
// local resolve বা cached read recovery নয়।
export function reportFirebaseSuccess(snap) {
    try {
        if (snap && snap.metadata && snap.metadata.fromCache === true) return;
        _outageStamps = [];
        if (_dialogOpen) {
            closeDialog();
            setBackendDown(false);
            if (typeof window.showToast === 'function') {
                window.showToast('সংযোগ ফিরে এসেছে ✅', 'success', 3000);
            }
        } else if (_backendDown) {
            setBackendDown(false);
        }
    } catch (e) {}
}

// Dialog খোলা আছে কি না — প্রয়োজনে অন্য module জানতে পারবে।
export function isBackendDialogOpen() {
    return _dialogOpen;
}
