import { db, doc, getDoc, onSnapshot } from '../firebase/firebase-init.js';
import { state } from '../scripts/state.js';
import { APP_CONFIG } from '../config/app-config.js';
import { escHtml } from '../utils/escape.js';

const SETTINGS_CACHE_TTL = 60 * 1000;
const settingsCache = new Map();

// Generic settings/{name} reader.
// Cache is UI/read optimization only; security-sensitive actions must re-read authoritative data.
function readSessionSettings(name) {
    try {
        const raw = sessionStorage.getItem('ff_settings_' + name + '_v1');
        if (!raw) return null;
        const entry = JSON.parse(raw);
        if (!entry || typeof entry.t !== 'number' || (Date.now() - entry.t) >= SETTINGS_CACHE_TTL) return null;
        return entry;
    } catch (e) { return null; }
}
function writeSessionSettings(name, data) {
    try {
        sessionStorage.setItem('ff_settings_' + name + '_v1', JSON.stringify({ t: Date.now(), data }));
    } catch (e) { /* storage full/disabled */ }
}

export async function fetchSettingsDoc(name, forceRefresh = false) {
    if (!name) return null;

    const cached = settingsCache.get(name);
    if (!forceRefresh && cached && (Date.now() - cached.at) < SETTINGS_CACHE_TTL) {
        return cached.data;
    }
    // FIX (2026-10-25, F-14 light): in-memory cache navigation-এ মরে
    // যেত — settings doc (plain JSON config) sessionStorage-তেও রাখা
    // হলো, একই 60s TTL-এ। Balance/payment/slot এখানে কখনো থাকে না।
    if (!forceRefresh && !cached) {
        const ssEntry = readSessionSettings(name);
        if (ssEntry !== null && ssEntry.data !== null) {
            // আসল timestamp-ই রাখা হলো — hydrate করলে TTL বাড়বে না।
            settingsCache.set(name, { at: ssEntry.t, data: ssEntry.data });
            return ssEntry.data;
        }
    }

    try {
        const s = await getDoc(doc(db, 'settings', name));
        const data = s.exists() ? s.data() : null;
        settingsCache.set(name, { at: Date.now(), data });
        writeSessionSettings(name, data);
        return data;
    } catch (e) {
        console.warn(`[Settings] ${name} fetch error:`, e.message);
        return cached?.data ?? null;
    }
}

export async function loadMinWithdrawal(forceRefresh = false) {
    try {
        const data = await fetchSettingsDoc('withdrawal', forceRefresh);
        // ✅ FIX (2026-10-24, AUD-026): 0/fraction আর `||` fallback-এ
        // ₹100 হয়ে যেত না — শুধু 1+ পূর্ণসংখ্যাই মানা হবে, বাকি সব
        // default। (Admin এখন 1–10000-এর বাইরে সেভই করতে পারবে না।)
        const _mv = Number(data?.minAmount);
        state.minWithdrawal = (Number.isFinite(_mv) && _mv >= 1)
            ? Math.floor(_mv)
            : APP_CONFIG.defaultMinWithdrawal;

        const wt = document.getElementById('wd-min-text');
        if (wt) wt.textContent = `Minimum withdrawal: ₹${state.minWithdrawal}`;

        const wi = document.getElementById('wd-amount');
        if (wi) wi.placeholder = `Min ₹${state.minWithdrawal}`;
    } catch (e) {
        state.minWithdrawal = APP_CONFIG.defaultMinWithdrawal;
    }
}

export function listenMaintenanceMode() {
    try {
        const unsub = onSnapshot(doc(db, 'settings', 'maintenance'), (snap) => {
            // Maintenance mode is intentionally realtime because it is a global
            // operational state, not ordinary static configuration.
            if (snap.exists() && snap.data()?.isMaintenance === true) {
                const msg = snap.data().message || "অল্প সময়ের জন্য রক্ষণাবেক্ষণ কাজ চলছে। কিছুক্ষণের মধ্যে আমরা ফিরে আসছি!";
                showMaintenanceScreen(msg);
            } else {
                hideMaintenanceScreen();
            }

            // Any realtime update invalidates the cached maintenance document.
            settingsCache.delete('maintenance');
        }, (err) => {
            console.warn('[Maintenance] Listener error:', err.message);
        });

        state.listeners = Array.isArray(state.listeners) ? state.listeners : [];
        state.listeners.push(unsub);
        return unsub;
    } catch (e) {
        console.warn('[Maintenance] Setup failed:', e.message);
        return null;
    }
}

function showMaintenanceScreen(msg) {
    let overlay = document.getElementById('maintenance-lock-screen');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'maintenance-lock-screen';
        overlay.style.cssText = 'position:fixed;inset:0;background:#080808;z-index:999999;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:32px;text-align:center;font-family:-apple-system,BlinkMacSystemFont,sans-serif;color:#fff;';
        document.body.appendChild(overlay);
    }
    overlay.innerHTML = `
        <div style="width:96px;height:96px;background:rgba(255,152,0,0.12);border:1px solid rgba(255,152,0,0.3);border-radius:24px;display:flex;align-items:center;justify-content:center;font-size:44px;margin-bottom:24px;animation: pulse 1.5s infinite;">🚧</div>
        <h1 style="font-size:24px;font-weight:800;margin-bottom:12px;letter-spacing:-0.5px;">সিস্টেম রক্ষণাবেক্ষণ চলছে</h1>
        <p style="font-size:14px;color:rgba(255,255,255,0.7);line-height:1.6;max-width:320px;margin-bottom:24px;">${escHtml(msg)}</p>
        <div style="font-size:11px;color:rgba(255,255,255,0.4);letter-spacing:1px;text-transform:uppercase;">Tournixo Support Team</div>
    `;
}

function hideMaintenanceScreen() {
    const overlay = document.getElementById('maintenance-lock-screen');
    if (overlay) overlay.remove();
}
