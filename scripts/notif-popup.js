// ════════════════════════════════════════════════════════════════
// PREMIUM IN-APP NOTIFICATION POPUP (foreground)
// When an admin notification arrives while the player is inside the
// app/website, a premium card slides down from the top (Android/iOS
// style) instead of only updating the bell badge silently.
// The same admin action usually ALSO sends a OneSignal push — the
// mobile notification shade copy — so this module de-dupes identical
// title+body within a few seconds.
// Self-contained: styles are injected once, no page CSS changes.
// ════════════════════════════════════════════════════════════════
// FIX (2026-10-25, F-21): dedupe window (6s) auto-dismiss (6.5s)-এর
// চেয়ে ছোট ছিল — 6.2s-এ একই notification দ্বিতীয় popup হয়ে stack হতো।
// এখন dedupe dismiss-এর চেয়ে বড়।
const DEDUPE_WINDOW_MS = 7000;
const AUTO_DISMISS_MS = 6500;
const _recent = new Map();

function ensureStyles() {
    if (document.getElementById('notif-popup-styles')) return;
    const style = document.createElement('style');
    style.id = 'notif-popup-styles';
    style.textContent = `
    #notif-popup-wrap{position:fixed;top:calc(env(safe-area-inset-top,0px) + 10px);left:50%;transform:translateX(-50%);width:min(94vw,430px);z-index:999990;display:flex;flex-direction:column;gap:8px;pointer-events:none;font-family:inherit;}
    .notif-popup{pointer-events:auto;display:flex;gap:12px;align-items:flex-start;background:linear-gradient(145deg,rgba(26,26,32,.97),rgba(14,14,18,.97));border:1px solid rgba(255,193,7,.35);border-radius:18px;padding:13px 14px 15px;box-shadow:0 18px 44px rgba(0,0,0,.55),0 0 0 1px rgba(255,255,255,.04) inset;backdrop-filter:blur(10px);cursor:pointer;position:relative;overflow:hidden;animation:np-in .45s cubic-bezier(.21,1.02,.55,1.01);}
    .notif-popup.leaving{animation:np-out .3s ease forwards;}
    .notif-popup .np-icon{flex:0 0 40px;width:40px;height:40px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:20px;background:linear-gradient(135deg,rgba(255,193,7,.25),rgba(255,152,0,.12));border:1px solid rgba(255,193,7,.35);}
    .notif-popup .np-main{flex:1;min-width:0;}
    .notif-popup .np-title{font-size:14px;font-weight:800;color:#fff;line-height:1.3;margin-bottom:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    .notif-popup .np-body{font-size:12.5px;color:rgba(255,255,255,.72);line-height:1.45;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}
    .notif-popup .np-app{font-size:10px;letter-spacing:.8px;color:rgba(255,193,7,.85);font-weight:700;text-transform:uppercase;margin-bottom:3px;}
    .notif-popup .np-close{flex:0 0 auto;background:none;border:none;color:rgba(255,255,255,.55);font-size:16px;line-height:1;cursor:pointer;padding:2px 2px 0 4px;}
    .notif-popup .np-bar{position:absolute;left:0;bottom:0;height:2.5px;background:linear-gradient(90deg,#FFC107,#FF9800);animation:np-bar ${AUTO_DISMISS_MS}ms linear forwards;}
    @keyframes np-in{from{transform:translateY(-18px) scale(.97);opacity:0;}to{transform:translateY(0) scale(1);opacity:1;}}
    @keyframes np-out{to{transform:translateY(-14px);opacity:0;}}
    @keyframes np-bar{from{width:100%;}to{width:0%;}}
    `;
    document.head.appendChild(style);
}

function ensureWrap() {
    ensureStyles();
    let wrap = document.getElementById('notif-popup-wrap');
    if (!wrap) {
        wrap = document.createElement('div');
        wrap.id = 'notif-popup-wrap';
        document.body.appendChild(wrap);
    }
    return wrap;
}

function iconForType(type) {
    const t = String(type || '').toLowerCase();
    if (t.includes('payment') || t.includes('join')) return '💳';
    if (t.includes('prize') || t.includes('win') || t.includes('result')) return '🏆';
    if (t.includes('withdraw')) return '💸';
    if (t.includes('room')) return '🔑';
    if (t.includes('warn') || t.includes('reject')) return '⚠️';
    if (t.includes('success') || t.includes('confirm') || t.includes('approv')) return '✅';
    if (t.includes('tournament') || t.includes('match')) return '🎮';
    return '🔔';
}

function escText(str) {
    const div = document.createElement('div');
    div.textContent = String(str ?? '');
    return div.innerHTML;
}

export function showNotifPopup({ icon, title, body, type, onTap } = {}) {
    try {
        const key = `${title || ''}|${body || ''}`;
        const now = Date.now();
        if (_recent.has(key) && now - _recent.get(key) < DEDUPE_WINDOW_MS) return;
        _recent.set(key, now);
        for (const [k, ts] of _recent) { if (now - ts > DEDUPE_WINDOW_MS) _recent.delete(k); }

        const wrap = ensureWrap();
        while (wrap.children.length >= 2) wrap.firstChild.remove();

        const card = document.createElement('div');
        card.className = 'notif-popup';
        card.setAttribute('role', 'alert');
        card.innerHTML = `
            <div class="np-icon">${icon || iconForType(type)}</div>
            <div class="np-main">
                <div class="np-app">Tournixo</div>
                <div class="np-title">${escText(title || 'Notification')}</div>
                <div class="np-body">${escText(body || '')}</div>
            </div>
            <button class="np-close" aria-label="Dismiss">✕</button>
            <div class="np-bar"></div>`;

        let dismissed = false;
        const dismiss = () => {
            if (dismissed) return;
            dismissed = true;
            card.classList.add('leaving');
            setTimeout(() => card.remove(), 320);
        };
        // FIX (2026-10-25, F-21): manual dismiss-এ auto-dismiss timer-ও
        // clear হবে (আগে double remove চলত — harmless হলেও অপরিচ্ছন্ন)।
        let autoTimer = null;
        const dismissAndClear = () => { if (autoTimer) clearTimeout(autoTimer); dismiss(); };
        card.querySelector('.np-close').addEventListener('click', (e) => { e.stopPropagation(); dismissAndClear(); });
        card.addEventListener('click', () => { dismissAndClear(); if (typeof onTap === 'function') onTap(); });
        wrap.appendChild(card);
        autoTimer = setTimeout(dismiss, AUTO_DISMISS_MS);
    } catch (e) { /* popup must never break the page */ }
}
