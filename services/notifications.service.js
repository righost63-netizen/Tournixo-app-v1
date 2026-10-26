import { db, doc, collection, query, orderBy, limit, onSnapshot, getDocs, addDoc, updateDoc, serverTimestamp } from '../firebase/firebase-init.js';
import { state } from '../scripts/state.js';
import { showNotifPopup } from '../scripts/notif-popup.js';
import { goTo } from '../config/app-config.js';
import { fetchUpcomingRaw } from './tournaments.service.js';
// ✅ centralized constants
import { STORAGE_KEYS, CACHE_TTL } from '../utils/constants.js';

/*
 * ─────────────────────────────────────────────────────────────
 * FIXES APPLIED:
 * 1. ❌ Hard-coded `30 * 60 * 1000` এবং `86400000` (line 77-79, 106)
 *    ✅ এখন CACHE_TTL.reminderLeadTimeMs / reminderWindowMs থেকে আসে।
 * 2. ❌ REMINDER_KEY = 'ff_reminders_v1' hard-coded string
 *    ✅ এখন STORAGE_KEYS.reminders।
 * 3. ✅ Dead export cleanupNotificationResources সরানো হয়েছে (কোথাও call হতো না)।
 * ─────────────────────────────────────────────────────────────
 */

const REMINDER_KEY = STORAGE_KEYS.reminders;           // ✅ no more magic string
const REMINDER_LEAD_MS  = CACHE_TTL.reminderLeadTimeMs; // ✅ 30 min
const REMINDER_WINDOW_MS = CACHE_TTL.reminderWindowMs;  // ✅ 24 hours

function updateBadge(snap) {
    let unread = 0;
    snap.forEach(d => { if (!d.data().read) unread++; });
    const badge = document.getElementById('notif-badge');
    if (badge) {
        badge.style.display = unread > 0 ? 'flex' : 'none';
        badge.textContent = unread > 9 ? '9+' : unread;
    }
}

// Types the app creates for the user ITSELF while they are looking at the
// screen (payment/withdrawal confirmations, the 30-minute reminder). Those
// already produce immediate feedback, so they don't need a popup too.
const SELF_POPUP_SKIP_TYPES = new Set(['payment_pending', 'withdrawal_pending', 'tournament_soon']);

function popupForDoc(uid, docSnap) {
    const data = docSnap.data() || {};
    if (data.read) return;
    if (SELF_POPUP_SKIP_TYPES.has(data.type)) return;
    const createdMs = data.createdAt?.toMillis ? data.createdAt.toMillis() : 0;
    if (createdMs && Date.now() - createdMs > 120000) return; // stale catch-up, not a live arrival
    showNotifPopup({
        type: data.type,
        title: data.title || 'Notification',
        body: data.body || '',
        onTap: () => {
            markNotificationRead(uid, docSnap.id).catch(() => {});
            goTo('notifications');
        }
    });
}

let _globalPopupStarted = false;
// FIX (2026-10-25, W8): logout-এ listener unsub হলেও এই flag reset হতো
// না — একই page session-এ logout→login করলে broadcast popup আর
// attach হতো না। logoutUser() এখান থেকে reset করে।
export function resetGlobalPopupListener() {
    _globalPopupStarted = false;
}
function listenGlobalNotificationPopups(uid) {
    if (_globalPopupStarted) return;
    _globalPopupStarted = true;
    try {
        // Admin broadcasts land in notifications/global/items — same popup.
        const gq = query(
            collection(db, 'notifications', 'global', 'items'),
            orderBy('createdAt', 'desc'),
            limit(5)
        );
        let baseline = true;
        const unsub = onSnapshot(gq, (snap) => {
            snap.docChanges().forEach(ch => {
                if (ch.type !== 'added' || baseline) return;
                const data = ch.doc.data() || {};
                const createdMs = data.createdAt?.toMillis ? data.createdAt.toMillis() : 0;
                if (createdMs && Date.now() - createdMs > 120000) return;
                showNotifPopup({
                    type: data.type,
                    title: data.title || 'Notification',
                    body: data.body || '',
                    onTap: () => goTo('notifications')
                });
            });
            baseline = false;
        }, () => {
            // FIX (2026-10-25, F-15): global popup listener error-এ flag
            // আটকে থাকত — পরের listenNotifications-এ আর attach হতো না।
            // Reset করলে retry path (নিচে) আবার attach করবে।
            _globalPopupStarted = false;
        });
        state.listeners.push(unsub);
    } catch (e) {}
}

// FIX (2026-10-25, F-05/F-15): listener error-এ badge চুপচাপ মরে যেত।
// একবার 30s backoff retry; তারপরও fail হলে পরের page load-এ আবার
// attach হবে — retry loop নয়, যাতে quota/offline-এ hammering না হয়।
let _notifRetryTimer = null;

export function listenNotifications(uid) {
    if (state.notifListenerActive) return;
    state.notifListenerActive = true;
    try {
        const q = query(
            collection(db, 'users', uid, 'notifications'),
            orderBy('createdAt', 'desc'),
            limit(30)
        );
        // FIX (notifications): besides the bell badge, a NEW admin notification
        // arriving while the app is open now shows the premium top popup.
        // The first snapshot is the baseline (history) — never popped.
        let baseline = true;
        const seen = new Set();
        const unsub = onSnapshot(q, (snap) => {
            updateBadge(snap);
            snap.docChanges().forEach(ch => {
                if (ch.type !== 'added') return;
                if (baseline) { seen.add(ch.doc.id); return; }
                if (seen.has(ch.doc.id)) return;
                seen.add(ch.doc.id);
                popupForDoc(uid, ch.doc);
            });
            baseline = false;
        }, () => {
            state.notifListenerActive = false;
            if (_notifRetryTimer) clearTimeout(_notifRetryTimer);
            _notifRetryTimer = setTimeout(() => {
                _notifRetryTimer = null;
                if (state.currentUser?.uid === uid && !state.notifListenerActive) listenNotifications(uid);
            }, 30000);
        });
        state.listeners.push(unsub);
        listenGlobalNotificationPopups(uid);
    } catch (e) {
        state.notifListenerActive = false;
    }
}

let _reminderTimers = [];

function readReminders() {
    try { return JSON.parse(localStorage.getItem(REMINDER_KEY)) || null; }
    catch (e) { return null; }
}

function writeReminders(data) {
    try { localStorage.setItem(REMINDER_KEY, JSON.stringify(data)); } catch (e) {}
}

function getStartDate(t) {
    if (t.dateObj instanceof Date && !isNaN(t.dateObj)) return t.dateObj;
    const v = t.dateTime || t.date;
    if (!v) return null;
    const d = v.toDate ? v.toDate() : new Date(v);
    return isNaN(d.getTime()) ? null : d;
}

export async function scheduleTournamentReminders() {
    const uid = state.currentUser?.uid;
    if (!uid) return;
    try {
        let upcoming = state.tournaments.filter(t => t.status === 'upcoming');
        if (upcoming.length === 0) upcoming = await fetchUpcomingRaw();
        const joinedIds = state.userData?.joinedTournaments || [];
        const items = [];
        upcoming.forEach(t => {
            if (!joinedIds.includes(t.id)) return;
            const td = getStartDate(t);
            if (!td) return;
            // ✅ constant-based lead + window
            const at = td.getTime() - REMINDER_LEAD_MS;
            const delay = at - Date.now();
            if (delay > 0 && delay < REMINDER_WINDOW_MS) {
                items.push({ id: t.id, name: t.name, at, startAt: td.getTime() });
            }
        });
        const old = readReminders();
        const fired = (old && old.uid === uid && old.fired) ? { ...old.fired } : {};
        // U4: the stored list is rebuilt from fresh data on every schedule, so
        // a tournament that moved (rescheduled — new dateTime) or left
        // 'upcoming' (cancelled) drops out and its old-time timer can never
        // fire. If a joined tournament's start CHANGED, also clear its fired
        // flag so the 30-minute alert arms at the NEW time, not the old one.
        const oldItems = (old && old.uid === uid && Array.isArray(old.items)) ? old.items : [];
        items.forEach(it => {
            const prev = oldItems.find(o => o.id === it.id);
            if (prev && prev.at !== it.at) delete fired[it.id];
        });
        writeReminders({ uid, items, fired });
        armReminders();
    } catch (e) {}
}

export function armReminders() {
    const uid = state.currentUser?.uid;
    if (!uid) return;
    const data = readReminders();
    if (!data || data.uid !== uid) return;
    _reminderTimers.forEach(t => clearTimeout(t));
    _reminderTimers = [];
    (data.items || []).forEach(r => {
        if (data.fired && data.fired[r.id]) return;
        const delay = r.at - Date.now();
        // ✅ constant-based window
        if (delay <= 0 || delay >= REMINDER_WINDOW_MS) return;
        const timer = setTimeout(async () => {
            const cur = readReminders() || data;
            cur.fired = cur.fired || {};
            cur.fired[r.id] = true;
            writeReminders(cur);
            try {
                await addDoc(collection(db, 'users', uid, 'notifications'), {
                    type: 'tournament_soon',
                    title: '⏰ Tournament Starting Soon!',
                    body: `"${r.name}" starts in 30 minutes!`,
                    read: false,
                    createdAt: serverTimestamp()
                });
            } catch (e) {}
            if (window.showToast) window.showToast(`⏰ "${r.name}" starts in 30 minutes!`, 'info', 6000);
        }, delay);
        _reminderTimers.push(timer);
    });
}

export async function fetchNotifications(uid, isAdmin = false) {
    const userItems = [], globalItems = [];
    // FIX (2026-10-25, F-09): সব fallback শুধু failed-precondition-এ —
    // quota/offline/permission-এ double query নয়।
    const orderedOrPlain = async (orderedQ, plainQ) => {
        try {
            return await getDocs(orderedQ);
        } catch (e) {
            if (e?.code !== 'failed-precondition') throw e;
            return await getDocs(plainQ);
        }
    };
    try {
        const s = await orderedOrPlain(
            query(collection(db, 'users', uid, 'notifications'), orderBy('createdAt', 'desc'), limit(30)),
            query(collection(db, 'users', uid, 'notifications'), limit(30))
        );
        s.forEach(d => userItems.push({ id: d.id, _src: 'user', ...d.data() }));
    } catch (e) {}
    try {
        const g = await orderedOrPlain(
            query(collection(db, 'notifications', 'global', 'items'), orderBy('createdAt', 'desc'), limit(20)),
            query(collection(db, 'notifications', 'global', 'items'), limit(20))
        );
        g.forEach(d => globalItems.push({ id: d.id, _src: 'global', ...d.data() }));
    } catch (e) {}
    // FIX (2026-10-25, F-05): adminNotifications normal user-এর জন্য
    // rules-এ denied — প্রতি open-এ দুই roundtrip বৃথা যেত। শুধু admin-ই
    // এই query চালাবে (admin-এর content normal user দেখতেই পেত না)।
    if (isAdmin) {
        try {
            const a = await orderedOrPlain(
                query(collection(db, 'adminNotifications'), orderBy('createdAt', 'desc'), limit(20)),
                query(collection(db, 'adminNotifications'), limit(20))
            );
            a.forEach(d => globalItems.push({ id: d.id, _src: 'admin', ...d.data() }));
        } catch (e) {}
    }
    return [...userItems, ...globalItems].sort((a, b) => {
        const toMs = v => v?.toMillis?.() ?? (v instanceof Date ? v.getTime() : Number(v) || 0);
        return toMs(b.createdAt) - toMs(a.createdAt);
    });
}

export function markNotificationRead(uid, id) {
    return updateDoc(doc(db, 'users', uid, 'notifications', id), { read: true });
}