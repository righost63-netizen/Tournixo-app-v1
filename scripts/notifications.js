import { initPage } from './app.js';
import { state } from './state.js';
import { timeAgo } from '../utils/formatters.js';
import { escHtml } from '../utils/escape.js';
import { fetchNotifications, markNotificationRead } from '../services/notifications.service.js';

let currentUid = null;
let currentItems = [];

async function loadNotifications(uid) {
    currentUid = uid;
    const container = document.getElementById('notif-list');
    container.innerHTML = '<div class="empty-state"><div class="spinner"></div></div>';
    try {
        // FIX (2026-10-25, F-05): admin না হলে adminNotifications query
        // চলবে না (service-এ skip) — প্রতি open-এ denied roundtrip বাঁচবে।
        const items = await fetchNotifications(uid, state.userData?.role === 'admin');
        currentItems = items;
        if (items.length === 0) {
            container.innerHTML = '<div class="empty-state"><div class="empty-icon">🔔</div><div class="empty-title">No notifications yet</div></div>';
            return;
        }
        const icons = {
            join_confirmed: '✅',
            payment_pending: '⏳',
            room_published: '🔑',
            prize_credited: '💰',
            prize: '🏆',
            tournament_soon: '⏰',
            withdrawal_pending: '⏳',
            withdrawal_approved: '✅',
            announcement: '📢',
            info: 'ℹ️',
            success: '✅',
            warning: '⚠️',
            default: '🔔'
        };
        container.innerHTML = '';
        const fragment = document.createDocumentFragment();
        for (const n of items) {
            // FIX (2026-10-25, BUILD 20 paired patch): global broadcast
            // item-এর read ফিল্ড নেই → সবসময় unread dot দেখাত, আর tap-এ
            // dot কখনো clear হতো না (mark-read শুধু _src 'user'-এ
            // বাঁধা ছিল)। এখন দেখা global id localStorage-এ (শেষ 50টা)
            // রাখা হয় — tap করলে dot clear হবে, পরের বার আর দেখাবে না।
            if (n._src === 'global' && _globalSeenHas(n.id)) n.read = true;
            const item = document.createElement('div');
            item.className = 'notif-item' + (!n.read ? ' unread' : '');
            item.innerHTML = `<div class="notif-icon">${icons[n.type]||icons.default}</div><div class="notif-content"><div class="notif-title">${escHtml(n.title||'Notification')}</div><div class="notif-body">${escHtml(n.body||n.message||'')}</div><div class="notif-time">${timeAgo(n.createdAt)}</div></div>${!n.read?'<div class="unread-dot"></div>':''}`;
            // Opening the page no longer marks notifications as read.
            // A notification is marked read when the user actually taps it.
            if (!n.read && n._src === 'user') {
                item.addEventListener('click', () => markOneRead(n, item), { once: true });
            } else if (!n.read && n._src === 'global') {
                item.addEventListener('click', () => {
                    n.read = true;
                    item.classList.remove('unread');
                    const dot = item.querySelector('.unread-dot');
                    if (dot) dot.remove();
                    _globalSeenAdd(n.id);
                }, { once: true });
            }
            fragment.appendChild(item);
        }
        container.appendChild(fragment);
    } catch (e) {
        container.innerHTML = '<div class="empty-state"><div class="empty-icon">🔔</div><div class="empty-title">No notifications yet</div></div>';
    }
}

// FIX (2026-10-25, BUILD 20 paired patch): global broadcast item-এর
// seen-state localStorage-এ (backend-এ write নেই — global doc সবার
// জন্য একটাই, per-user read ফিল্ড নেই)।
function _globalSeenHas(id) {
    try { return (JSON.parse(localStorage.getItem('tx_global_seen') || '[]')).includes(id); }
    catch (e) { return false; }
}
function _globalSeenAdd(id) {
    try {
        const arr = JSON.parse(localStorage.getItem('tx_global_seen') || '[]');
        if (!arr.includes(id)) { arr.push(id); localStorage.setItem('tx_global_seen', JSON.stringify(arr.slice(-50))); }
    } catch (e) {}
}

function markOneRead(n, item) {
    if (n.read) return;
    n.read = true;
    item.classList.remove('unread');
    // FIX (2026-10-25, W7): dot আগে সরিয়ে ফেলা হতো, আর write fail হলে
    // শুধু class ফিরত — dot আর ফিরত না (phantom unread)। এখন dot
    // শুধু write সফল হলেই সরবে; fail হলে dot + class দুটোই থাকে।
    markNotificationRead(currentUid, n.id).then(() => {
        const dot = item.querySelector('.unread-dot');
        if (dot) dot.remove();
    }).catch(() => {
        // Revert local state on failure so it doesn't drift from the backend
        n.read = false;
        item.classList.add('unread');
    });
}

initPage({
    page: 'notifications',
    onReady: (user) => {
        if (user) loadNotifications(user.uid);
    }
});