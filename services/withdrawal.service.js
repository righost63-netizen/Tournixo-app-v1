import {
    db,
    doc,
    collection,
    query,
    where,
    orderBy,
    limit,
    getDoc,
    getDocs,
    addDoc,
    runTransaction,
    serverTimestamp
} from '../firebase/firebase-init.js';
import { APP_CONFIG } from '../config/app-config.js';
import { isValidUpiId } from '../utils/validators.js';

const WITHDRAWAL_CACHE_TTL = 30 * 1000;
const withdrawalCache = new Map();

// Withdrawal history (permanent audit — no deletion), newest first.
// This cache is display-only and is never used to authorize a withdrawal.
export async function fetchWithdrawals(uid, forceRefresh = false) {
    if (!uid) return [];

    const cached = withdrawalCache.get(uid);
    if (!forceRefresh && cached && (Date.now() - cached.at) < WITHDRAWAL_CACHE_TTL) {
        return cached.items;
    }

    let items = [];
    try {
        const s = await getDocs(query(
            collection(db, 'withdrawalRequests'),
            where('userId', '==', uid),
            orderBy('requestedAt', 'desc'),
            limit(50)
        ));

        s.forEach(d => items.push({
            id: d.id,
            ...d.data()
        }));
    } catch (e) {
        // FIX (2026-10-25, F-09 + W3): fallback শুধু failed-precondition-এ;
        // total failure-এ cache থাকলে সেটা, না থাকলে throw (UI "No
        // Withdrawals Yet" না দেখিয়ে error + Try Again দেখাবে)।
        if (e?.code !== 'failed-precondition') {
            if (cached?.items) return cached.items;
            throw e;
        }
        try {
            const s = await getDocs(query(
                collection(db, 'withdrawalRequests'),
                where('userId', '==', uid),
                limit(50)
            ));

            s.forEach(d => items.push({
                id: d.id,
                ...d.data()
            }));
        } catch (fallbackError) {
            console.warn('[Withdrawal] History fetch failed:', fallbackError.message);
            if (cached?.items) return cached.items;
            throw fallbackError;
        }
    }

    items.sort((a, b) => {
        const ta = a.requestedAt?.toMillis ? a.requestedAt.toMillis() : new Date(a.requestedAt || 0).getTime();
        const tb = b.requestedAt?.toMillis ? b.requestedAt.toMillis() : new Date(b.requestedAt || 0).getTime();
        return tb - ta;
    });

    withdrawalCache.set(uid, { at: Date.now(), items });
    return items;
}

// U2: total of the user's PENDING withdrawal requests, for the Wallet card
// note ('⏳ ₹X withdrawal pending approval'). Display-only: a pending
// request NEVER deducts the balance client-side.
// FIX (2026-10-25, W12): আগে userId-only 50-cap query ছিল — ৫০+ পুরনো
// doc-এর আড়ালে পুরনো pending হারিয়ে undercount হতে পারত। এখন
// server-side status filter চেষ্টা হবে; composite index না থাকলে
// failed-precondition-এ পুরনো userId-only query-তে fallback।
export async function fetchPendingWithdrawalTotal(uid) {
    if (!uid) return 0;
    let s;
    try {
        s = await getDocs(query(
            collection(db, 'withdrawalRequests'),
            where('userId', '==', uid),
            where('status', '==', 'pending'),
            limit(50)
        ));
    } catch (e) {
        if (e?.code !== 'failed-precondition') throw e;
        s = await getDocs(query(
            collection(db, 'withdrawalRequests'),
            where('userId', '==', uid),
            limit(50)
        ));
    }
    let total = 0;
    s.forEach(d => {
        const w = d.data();
        if (w.status === 'pending') total += Number(w.amount || 0);
    });
    return Math.round(total * 100) / 100;
}

// Withdrawal request — Tournixo money flow (matches Staff Panel v2):
//   • Request time:  NO balance deduction. The request is created with status
//                    'pending' and the Winning Balance stays untouched.
//   • On approve:    Admin/Staff deducts the amount atomically from the panel.
//   • On reject:     status → 'rejected'. No balance is added back because
//                    nothing was ever deducted (no double-credit).
// The transaction below only VALIDATES (never writes to the user doc):
//   • amount is sane and ≥ the admin-configured minimum
//   • balance covers the amount
//   • max 3 pending requests per user (spam guard)
export async function requestWithdrawal({ uid, userName, amount, phone, method }) {
    const userRef = doc(db, 'users', uid);
    const withdrawRef = doc(collection(db, 'withdrawalRequests'));

    const amt = Math.round((Number(amount) || 0) * 100) / 100;
    if (!Number.isFinite(amt) || amt <= 0) {
        throw new Error('Invalid withdrawal amount.');
    }

    // FIX (#9, AUD-027): method + receiving UPI ID are validated HERE, in the
    // service — previously only the withdrawal screen checked them, so a
    // crafted call could file a request with a junk method / non-UPI "phone"
    // and staff would pay out to a wrong destination.
    const normMethod = String(method || 'upi').trim().toLowerCase();
    if (normMethod !== 'upi') {
        throw new Error('Unsupported withdrawal method.');
    }
    const upi = String(phone || '').trim();
    if (!isValidUpiId(upi)) {
        throw new Error('Please enter a valid UPI ID (e.g. 9876543210@upi)');
    }

    // ✅ FIX: spam guard — OUTSIDE the transaction. Firestore's transaction.get()
    // accepts ONLY a DocumentReference, never a Query: running a query inside
    // runTransaction threw "Cannot read properties of undefined (reading 'path')"
    // and broke every withdrawal. (Tiny race if two tabs submit in the same
    // millisecond — acceptable for a UX spam guard; the money check below
    // stays atomic.)
    const pendingSnap = await getDocs(query(
        collection(db, 'withdrawalRequests'),
        where('userId', '==', uid),
        where('status', '==', 'pending'),
        limit(10)
    ));
    if (pendingSnap.size >= 3) {
        throw new Error('You already have 3 pending withdrawal requests. Please wait for them to be reviewed.');
    }
    // v6: the count guard alone lets a ₹500-balance user file three ₹500
    // requests (nothing is deducted until approval — staff would have to
    // manually reject the extras). Cap the TOTAL pending amount instead.
    // Advisory read (same accepted race as the count guard); the authoritative
    // per-request balance check still runs inside the transaction below.
    let pendingTotal = 0;
    pendingSnap.forEach(d => { pendingTotal += Number(d.data()?.amount || 0); });
    try {
        const uSnap = await getDoc(userRef);
        if (uSnap.exists()) {
            const u = uSnap.data();
            const avail = Math.max(0, Math.min(Number(u.walletBalance || 0), Number(u.totalEarnings || 0)));
            if (pendingTotal + amt > avail) {
                throw new Error(`Insufficient balance: you already have ₹${pendingTotal.toFixed(2)} pending, available is ₹${avail.toFixed(2)}.`);
            }
        }
    } catch (e) {
        // If our own advisory message was thrown, keep it; a failed read
        // must not block — the transaction below is authoritative.
        if (e && e.message && e.message.indexOf('Insufficient balance') === 0) throw e;
    }

    // FIX (#7, AUD-013): the pending caps used to be advisory pre-reads ONLY —
    // parallel requests from two tabs/devices could both pass them. They are
    // now ALSO enforced inside the transaction through a per-user counter doc
    // (withdrawalCounters/{uid}) that lists this user's request IDs. Inside
    // the transaction each listed request is re-read, so IDs the admin has
    // already approved/rejected drop out and the caps are computed from the
    // requests that are STILL pending — atomically, with no race.
    // (Requests filed before this fix are not in the list; the counter starts
    // covering the user from their first new request.)
    const counterRef = doc(db, 'withdrawalCounters', uid);

    await runTransaction(db, async (transaction) => {
        const snap = await transaction.get(userRef);
        if (!snap.exists()) throw new Error('User account not found');

        const counterSnap = await transaction.get(counterRef);
        const trackedIds = Array.isArray(counterSnap.data()?.ids) ? counterSnap.data().ids : [];
        let livePendingCount = 0;
        let livePendingTotal = 0;
        const liveIds = [];
        for (const rid of trackedIds.slice(0, 10)) {
            const rSnap = await transaction.get(doc(db, 'withdrawalRequests', rid));
            if (rSnap.exists() && rSnap.data().status === 'pending') {
                livePendingCount++;
                livePendingTotal += Number(rSnap.data().amount || 0);
                liveIds.push(rid);
            }
        }
        // FIX (2026-10-25, W10): binary float যোগে 100.10+100.20 =
        // 200.30000000000001 হয়ে ঠিক balance থাকলেও false "Insufficient"
        // দেখাত। তুলনার আগে paise-এ round করা হলো।
        livePendingTotal = Math.round(livePendingTotal * 100) / 100;
        if (livePendingCount >= 3) {
            throw new Error('You already have 3 pending withdrawal requests. Please wait for them to be reviewed.');
        }

        // ✅ FIX: min-withdrawal এখন transaction-এর ভেতরে authoritative settings
        // থেকে যাচাই করা হচ্ছে — UI bypass করে কম amount পাঠানো যাবে না।
        const settingsSnap = await transaction.get(doc(db, 'settings', 'withdrawal'));
        // v6: was hard-coded 100 here while the UI used APP_CONFIG.defaultMinWithdrawal —
        // one source of truth now (same value today, can't silently diverge).
        // ✅ FIX (2026-10-24, AUD-026): settings-এর minAmount 0 বা
        // fraction হলে `||` fallback-এ চুপচাপ default হয়ে যেত — এখন
        // শুধু 1+ সংখ্যাই মানা হবে।
        const _minRaw = Number(settingsSnap.data()?.minAmount);
        const min = (Number.isFinite(_minRaw) && _minRaw >= 1)
            ? Math.floor(_minRaw)
            : APP_CONFIG.defaultMinWithdrawal;
        if (amt < min) {
            throw new Error(`Minimum withdrawal amount is ₹${min}`);
        }

        // Winning Balance can never exceed Earned Money — validate the clamped value.
        const uData = snap.data();
        const currentBalance = Math.max(0, Math.min(Number(uData.walletBalance || 0), Number(uData.totalEarnings || 0)));
        if (currentBalance < amt) {
            throw new Error(`Insufficient balance: Available ₹${currentBalance.toFixed(2)}`);
        }
        // FIX (#7): total-pending cap, atomic version of the advisory check.
        if (livePendingTotal + amt > currentBalance) {
            throw new Error(`Insufficient balance: you already have ₹${livePendingTotal.toFixed(2)} pending, available is ₹${currentBalance.toFixed(2)}.`);
        }

        // NOTE: walletBalance / totalEarnings are intentionally NOT touched here.
        // U3: the admin withdrawal card shows the player's FF UID — carry it
        // from the user doc (read inside this same transaction) on the request.
        transaction.set(withdrawRef, {
            userId: uid,
            userName: userName || 'User',
            ffUid: uData.ffUID || '',
            amount: amt,
            method: normMethod,
            phoneNumber: upi,
            upiId: upi,
            status: 'pending',
            requestedAt: serverTimestamp()
        });

        // Keep the counter in the SAME transaction so the caps above can
        // never be raced: resolved IDs are pruned, the new one is appended.
        transaction.set(counterRef, {
            uid,
            ids: [...liveIds, withdrawRef.id],
            updatedAt: serverTimestamp()
        });
    });

    // The newly-created history is no longer safe to display from the old cache.
    withdrawalCache.delete(uid);

    // U3: inbox note at request time (same doc shape as the payment note in
    // payment.service.js). No push here — admin sends push on approve/reject.
    try {
        await addDoc(collection(db, 'users', uid, 'notifications'), {
            type: 'withdrawal_pending',
            title: '💸 Withdrawal Requested',
            body: `Your withdrawal of ₹${amt.toFixed(2)} is pending admin approval. Your Winning Balance stays unchanged until it is approved.`,
            read: false,
            createdAt: serverTimestamp()
        });
    } catch (e) {}
}
