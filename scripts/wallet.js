import { initPage, effectiveWinningBalance } from './app.js';
import { state } from './state.js';
import { showToast } from './toast.js';
import { showSkeleton } from './modal.js';
import { goTo } from '../config/app-config.js';
import { formatDate } from '../utils/formatters.js';
import { escHtml } from '../utils/escape.js';
import { fetchWalletTransactions } from '../services/wallet.service.js';
import { fetchWithdrawals } from '../services/withdrawal.service.js';
import { loadMinWithdrawal } from '../services/settings.service.js';
import { APP_CONFIG } from '../utils/constants.js';   // ✅ ADDED

/*
 * ─────────────────────────────────────────────────────────────
 * FIXES APPLIED:
 * 1. ❌ Hard-coded `100` min-withdrawal fallback (line 133)
 *    ✅ APP_CONFIG.defaultMinWithdrawal ব্যবহার করা হচ্ছে।
 * ─────────────────────────────────────────────────────────────
 */

const DEFAULT_MIN_WITHDRAWAL = APP_CONFIG.defaultMinWithdrawal;

let withdrawHistoryLoaded = false;

export function setTxTab(tab, btn) {
    state.txTab = tab;
    document.querySelectorAll('#tab-wallet .tab').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    document.getElementById('tx-prize-list').style.display    = tab === 'prize'    ? 'block' : 'none';
    document.getElementById('tx-withdraw-list').style.display = tab === 'withdraw' ? 'block' : 'none';
    if (tab === 'withdraw' && !withdrawHistoryLoaded) {
        withdrawHistoryLoaded = true;
        loadWithdrawHistory().then(ok => { if (ok === false) withdrawHistoryLoaded = false; });
    }
}

function loadWallet() {
    loadPrizeHistory();
    loadPendingNote();
}

// U2: '⏳ ₹X withdrawal pending approval' — display only; the balance above
// never drops until the admin approves. app.js (U1 live listener) re-calls
// this through window.refreshPendingWithdrawal whenever the user doc updates.
async function loadPendingNote() {
    const el = document.getElementById('wallet-pending-note');
    const uid = state.currentUser?.uid;
    if (!el || !uid) return;
    // FIX (2026-10-25, F-08): আগে আলাদা ≤50 query চলত প্রতিবার (আর
    // user-doc update-এও) — এখন withdrawal history-র 30s shared cache
    // থেকেই pending total ধরা হয়, extra read নয়। Display-only।
    try {
        const items = await fetchWithdrawals(uid);
        const total = items
            .filter(w => w.status === 'pending')
            .reduce((s, w) => s + Number(w.amount || 0), 0);
        if (total > 0) {
            el.textContent = `⏳ ₹${Math.round(total * 100) / 100} withdrawal pending approval`;
            el.style.display = '';
        } else {
            el.style.display = 'none';
        }
    } catch (e) {
        el.style.display = 'none';
    }
}
window.refreshPendingWithdrawal = loadPendingNote;

async function loadPrizeHistory(forceRefresh = false) {
    const uid = state.currentUser?.uid;
    const container = document.getElementById('tx-prize-list');
    if (!uid || !container) return;
    showSkeleton('tx-prize-list', 'tx');
    try {
        // FIX (2026-10-25, W3): Try Again এখন forceRefresh দিয়ে চলে —
        // 30s cache-এর পুরনো/খালি result আর ফিরে আসবে না।
        const transactions = await fetchWalletTransactions(uid, state.userData, forceRefresh);
        if (transactions.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <div class="empty-icon">💰</div>
                    <div class="empty-title">No Transactions Yet</div>
                    <div class="empty-sub">Tournament prizes and ledger credits will appear here</div>
                </div>`;
            return;
        }
        container.innerHTML = '';
        transactions.forEach(tx => {
            const isCredit = tx.type === 'prize' || tx.type === 'refund' || tx.type === 'credit' || (Number(tx.amount) > 0);
            const dateFormatted = formatDate(tx.createdAt || tx.date);
            const item = document.createElement('div');
            item.className = 'tx';
            item.innerHTML = `
                <div class="tx-ic ${isCredit ? 'in' : 'out'}">
                    ${tx.type === 'refund' ? '🔄' : isCredit ? '🏆' : '💸'}
                </div>
                <div class="tx-body">
                    <div class="tx-title">${escHtml(tx.title || tx.tournamentName || 'Wallet Event')}</div>
                    <div class="tx-sub">${dateFormatted} · <span style="text-transform:capitalize;">${tx.type || 'Transaction'}</span></div>
                </div>
                <div class="tx-amt ${isCredit ? 'in' : 'out'}">
                    ${isCredit ? '+' : '-'}₹${Math.abs(Number(tx.amount || 0)).toLocaleString()}
                </div>`;
            container.appendChild(item);
        });
    } catch (err) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">⚠️</div>
                <div class="empty-title">Failed to load ledger</div>
                <div class="empty-sub">Please check your connection and try again.</div>
                <button class="btn btn-secondary btn-sm" style="margin-top:8px;" onclick="retryWalletHistory('prize')">Try Again</button>
            </div>`;
    }
}

let _withdrawForceRefresh = false;
async function loadWithdrawHistory() {
    const uid = state.currentUser?.uid;
    const container = document.getElementById('tx-withdraw-list');
    if (!uid || !container) return false;
    showSkeleton('tx-withdraw-list', 'tx');
    try {
        // FIX (2026-10-25, W3): Try Again-এর forceRefresh flag এখানে
        // ধরা হয় (tab-switch path দিয়ে load হলেও কাজ করবে)।
        const forceRefresh = _withdrawForceRefresh;
        _withdrawForceRefresh = false;
        const items = await fetchWithdrawals(uid, forceRefresh);
        if (items.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <div class="empty-icon">💸</div>
                    <div class="empty-title">No Withdrawals Yet</div>
                    <div class="empty-sub">Withdraw your tournament winnings to your UPI account</div>
                </div>`;
            return true;
        }
        container.innerHTML = '';
        const colors = { pending: 'var(--gold)', approved: 'var(--success)', rejected: 'var(--error)' };
        const labels = { pending: 'Pending ⏳', approved: 'Approved ✅', rejected: 'Rejected ❌' };
        items.forEach(w => {
            const item = document.createElement('div');
            item.className = 'tx';
            item.innerHTML = `
                <div class="tx-ic out">💸</div>
                <div class="tx-body">
                    <div class="tx-title">UPI: ${escHtml(w.phoneNumber || w.upiId || 'Account')}</div>
                    <div class="tx-sub">${formatDate(w.requestedAt)} · <span style="color:${colors[w.status] || 'var(--text2)'}; font-weight:600;">${escHtml(labels[w.status] || w.status)}</span></div>
                </div>
                <div class="tx-amt out">-₹${Number(w.amount || 0).toLocaleString()}</div>`;
            container.appendChild(item);
        });
        return true;
    } catch (err) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">⚠️</div>
                <div class="empty-title">Failed to load withdrawals</div>
                <div class="empty-sub">Please check your connection and try again.</div>
                <button class="btn btn-secondary btn-sm" style="margin-top:8px;" onclick="retryWalletHistory('withdraw')">Try Again</button>
            </div>`;
        return false;
    }
}

window.retryWalletHistory = (tab) => {
    if (tab === 'withdraw') {
        withdrawHistoryLoaded = false;
        _withdrawForceRefresh = true;
        setTxTab('withdraw');
    } else {
        loadPrizeHistory(true);
    }
};

export function openWithdraw() {
    // Winning Balance can never exceed Earned Money — gate on the clamped value.
    const bal = effectiveWinningBalance(state.userData);
    // ✅ constant-based fallback, no more hard-coded 100
    const min = Number(state.minWithdrawal || DEFAULT_MIN_WITHDRAWAL);
    if (bal < min) {
        showToast(`Minimum withdrawal is ₹${min}. Your available balance is ₹${bal.toFixed(2)}`, 'error', 4000);
        return;
    }
    goTo('withdrawal');
}

window.setTxTab = setTxTab;
window.openWithdraw = openWithdraw;

initPage({
    page: 'wallet',
    tab: 'wallet',
    onReady: () => {
        loadMinWithdrawal();
        loadWallet();
    }
});