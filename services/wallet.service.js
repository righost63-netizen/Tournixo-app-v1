import { db, collection, query, where, orderBy, limit, getDocs } from '../firebase/firebase-init.js';

const WALLET_CACHE_TTL = 30 * 1000;
const walletCache = new Map();

// Wallet ledger (prize, refund, entry fee, credit) — newest first.
// Cache is only for display optimization; balance/payment authorization must not use it.
export async function fetchWalletTransactions(uid, userData, forceRefresh = false) {
    if (!uid) return [];

    const cached = walletCache.get(uid);
    if (!forceRefresh && cached && (Date.now() - cached.at) < WALLET_CACHE_TTL) {
        return cached.items;
    }

    let transactions = [];
    try {
        const snap = await getDocs(query(
            collection(db, 'walletTransactions'),
            where('userId', '==', uid),
            orderBy('createdAt', 'desc'),
            limit(50)
        ));

        snap.forEach(d => transactions.push({
            id: d.id,
            ...d.data()
        }));
    } catch (e) {
        // FIX (2026-10-25, F-09): fallback শুধু missing-index-এ
        // (failed-precondition) চলবে — quota/offline/permission-এ নয়, যাতে
        // backend খারাপ থাকলে request volume দ্বিগুণ না হয়।
        if (e?.code !== 'failed-precondition') {
            // FIX (2026-10-25, W3): total failure-এ [] ফেরানো হতো, আর UI
            // "No Transactions Yet" দেখাত — ভুল empty state। এখন cache
            // থাকলে সেটা, না থাকলে throw — UI error + Try Again দেখাবে।
            if (cached?.items) return cached.items;
            throw e;
        }
        try {
            const snap = await getDocs(query(
                collection(db, 'walletTransactions'),
                where('userId', '==', uid),
                limit(50)
            ));
            snap.forEach(d => transactions.push({
                id: d.id,
                ...d.data()
            }));
        } catch (fallbackError) {
            console.warn('[Wallet] Transaction history fetch failed:', fallbackError.message);
            if (cached?.items) return cached.items;
            throw fallbackError;
        }
    }

    // FIX (2026-10-25, W13): legacy prizeHistory আর all-or-nothing নয় —
    // ledger-এ ১টা entry থাকলেও পুরনো ২০টা prize লুকিয়ে যেত। এখন merge:
    // ledger-এ নেই এমন (tournamentName + amount) prize-ই শুধু যোগ হবে।
    // Ledger-ই authoritative; এটা শুধু display compat।
    if (userData?.prizeHistory) {
        const seen = new Set();
        transactions.forEach(tx => {
            if (tx.type === 'prize') seen.add(`${tx.tournamentName || tx.title || ''}|${Number(tx.amount || 0)}`);
        });
        const pHistory = userData.prizeHistory || [];
        pHistory.forEach((p, idx) => {
            const key = `${p.tournamentName || ''}|${Number(p.amount || 0)}`;
            if (!seen.has(key)) {
                seen.add(key);
                transactions.push({
                    id: 'prize-' + idx,
                    amount: p.amount || 0,
                    type: 'prize',
                    title: p.tournamentName || 'Tournament Prize',
                    description: `Won in ${p.tournamentName || 'Tournament'}`,
                    createdAt: p.distributedAt || Date.now()
                });
            }
        });
    }

    transactions.sort((a, b) => {
        const ta = a.createdAt?.toMillis ? a.createdAt.toMillis() : new Date(a.createdAt || 0).getTime();
        const tb = b.createdAt?.toMillis ? b.createdAt.toMillis() : new Date(b.createdAt || 0).getTime();
        return tb - ta;
    });

    walletCache.set(uid, { at: Date.now(), items: transactions });
    return transactions;
}
