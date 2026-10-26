import {
    db,
    doc,
    getDoc,
    getDocs,
    addDoc,
    collection,
    query,
    where,
    limit,
    runTransaction,
    serverTimestamp
} from '../firebase/firebase-init.js';
import { normalizeTournament } from './tournaments.service.js';

/*
 * ─────────────────────────────────────────────────────────────
 * FIXES APPLIED:
 * 1. ❌ Hard-coded 'admin@upi' / payee fallback (lines 27-28) ছিল
 *    ✅ সরানো হয়েছে। এখন settings/payment না থাকলে বা অসম্পূর্ণ হলে
 *       payment সম্পূর্ণ disable — কোনো fake destination এ টাকা যাবে না।
 * 2. ✅ Dead export clearPaymentSettingsCache সরানো হয়েছে (কোথাও call হতো না)।
 * 3. ✅ Error handling আরো strict করা হয়েছে — silent fallback নেই।
 * ─────────────────────────────────────────────────────────────
 */

let paymentSettingsCache = null;
const PAYMENT_SETTINGS_TTL = 60 * 1000;

export async function fetchPaymentSettings(forceRefresh = false) {
    const now = Date.now();

    if (
        !forceRefresh &&
        paymentSettingsCache &&
        (now - paymentSettingsCache.at) < PAYMENT_SETTINGS_TTL
    ) {
        return paymentSettingsCache.value;
    }

    try {
        const paySnap = await getDoc(doc(db, 'settings', 'payment'));

        // ✅ Never use a fake/default payment destination.
        if (!paySnap.exists()) {
            paymentSettingsCache = null;
            throw new Error('Payment settings are unavailable. Payment is currently disabled.');
        }

        const pData = paySnap.data() || {};

        const adminUpiId = String(pData.upiId || pData.number || '').trim();
        const payeeName  = String(pData.payeeName || pData.accountName || '').trim();

        // ✅ Both values are required. Never allow incomplete payment config.
        if (!adminUpiId || !payeeName) {
            paymentSettingsCache = null;
            throw new Error('Payment settings are incomplete. Payment is currently disabled.');
        }

        const value = { adminUpiId, payeeName };

        paymentSettingsCache = { at: Date.now(), value };
        return value;
    } catch (e) {
        paymentSettingsCache = null;
        console.error('[Payment] Settings fetch failed:', e);

        if (e instanceof Error && e.message) throw e;
        throw new Error('Unable to load payment settings. Payment is currently disabled.');
    }
}

// Standard UPI Intent URL
export function buildUpiIntentUrl(adminUpiId, payeeName, fee, teamId) {
    const upiId  = String(adminUpiId || '').trim();
    const name   = String(payeeName || '').trim();
    const amount = Number(fee);

    if (!upiId || !name) {
        throw new Error('Payment settings are unavailable. Payment is currently disabled.');
    }
    if (!Number.isFinite(amount) || amount <= 0) {
        throw new Error('Invalid payment amount.');
    }
    if (!teamId) {
        throw new Error('Invalid team information.');
    }

    return `upi://pay?pa=${encodeURIComponent(upiId)}&pn=${encodeURIComponent(name)}&am=${amount}&cu=INR&tn=${encodeURIComponent(teamId)}`;
}

function transactionDocId(trxId) {
    return `trx_${encodeURIComponent(String(trxId).trim().toUpperCase())}`;
}

export async function submitPaymentRequest({ t, teamData, trxId, uid, uData, authEmail }) {
    const normalizedTrxId = String(trxId || '').trim().toUpperCase();
    if (!normalizedTrxId) throw new Error('Transaction ID is required.');

    const [tournSnap, teamSnap] = await Promise.all([
        getDoc(doc(db, 'tournaments', t.id)),
        getDoc(doc(db, 'tournamentTeams', teamData.teamId))
    ]);

    if (!tournSnap.exists()) throw new Error('Tournament not found or has been removed!');

    const freshTourn = tournSnap.data();
    if (freshTourn.status !== 'upcoming') {
        throw new Error(`Cannot submit payment. Tournament is currently ${String(freshTourn.status).toUpperCase()}`);
    }

    const authoritativeFee = Number(freshTourn.entryFee || 0);
    if (authoritativeFee <= 0) throw new Error('This tournament is free and does not require payment!');

    if (!teamSnap.exists()) throw new Error('Team registration not found. Please register your team first.');

    const freshTeam = teamSnap.data();
    if (freshTeam.captainUserId !== uid) {
        throw new Error('Unauthorized: Only the team captain can submit payment.');
    }
    if (freshTeam.paymentStatus === 'approved' || freshTeam.status === 'confirmed') {
        throw new Error('This team is already confirmed and paid for!');
    }
    if (freshTeam.paymentStatus === 'pending') {
        throw new Error('You already have a payment pending verification for this team!');
    }
    // FIX (2026-10-25, F10): rejected টিমে আবার UTR submit করলে
    // paymentStatus 'pending'-এ ফিরত, কিন্তু status 'rejected'-ই থাকত —
    // admin confirm করতে পারত না, queue-তে dangling pending জমত। এখন
    // rejected টিমকে নতুন join flow-এ পাঠানো হবে।
    if (freshTeam.status === 'rejected') {
        throw new Error('This team was rejected by the admin. Please join again via the new join flow to create a fresh request.');
    }

    const trxRef = doc(db, 'paymentRequests', transactionDocId(normalizedTrxId));
    // FIX (2026-10-25, F13): অন্যের UTR probe করলে getDoc permission-denied
    // দিত — raw SDK error-ই existence oracle হতো। এখন generic message;
    // আসল duplicate check txn-এর ভেতরে থাকবে। (পুরো oracle বন্ধ করা
    // যায় না — success vs failure নিজেই existence জানায় — কিন্তু UTR
    // একা কিছু কেনে না, তাই LOW হিসেবে এটুকুই যথেষ্ট।)
    let directTrxSnap;
    try {
        directTrxSnap = await getDoc(trxRef);
    } catch (e) {
        if (e?.code === 'permission-denied') {
            throw new Error('Could not verify this Transaction ID. Please double-check it and try again.');
        }
        throw e;
    }
    if (directTrxSnap.exists()) throw new Error('This Transaction ID has already been submitted!');

    const legacyDupCheck = await getDocs(
        query(collection(db, 'paymentRequests'),
              where('transactionId', '==', normalizedTrxId),
              limit(1))
    );
    if (!legacyDupCheck.empty) throw new Error('This Transaction ID has already been submitted!');

    const paymentId =
        'PAY-' + Date.now().toString(36).toUpperCase() +
        Math.random().toString(36).substring(2, 6).toUpperCase();

    try {
        await runTransaction(db, async (transaction) => {
            // FIX (#8, AUD-020): tournament status + fee are re-read and
            // re-validated INSIDE the transaction. Previously they were only
            // checked on stale pre-reads, so a tournament cancelled/completed
            // (or a fee changed) in the gap still committed a payment built
            // from old data. The payment doc is now built from the in-txn fee.
            const latestTournSnap = await transaction.get(tournSnap.ref);
            if (!latestTournSnap.exists()) {
                throw new Error('Tournament not found or has been removed!');
            }
            const latestTourn = latestTournSnap.data();
            if (latestTourn.status !== 'upcoming') {
                throw new Error(`Cannot submit payment. Tournament is currently ${String(latestTourn.status).toUpperCase()}`);
            }
            const latestFee = Number(latestTourn.entryFee || 0);
            if (latestFee <= 0) throw new Error('This tournament is free and does not require payment!');

            const latestTeamSnap = await transaction.get(teamSnap.ref);
            if (!latestTeamSnap.exists()) {
                throw new Error('Team registration not found. Please register your team first.');
            }
            const latestTeam = latestTeamSnap.data();
            if (latestTeam.paymentStatus === 'approved' || latestTeam.status === 'confirmed') {
                throw new Error('This team is already confirmed and paid for!');
            }
            if (latestTeam.paymentStatus === 'pending') {
                throw new Error('You already have a payment pending verification for this team!');
            }
            // FIX (2026-10-25, F10): txn-এর ভেতরেও একই rejected guard —
            // pre-check আর commit-এর মাঝে reject হলেও dangling pending নয়।
            if (latestTeam.status === 'rejected') {
                throw new Error('This team was rejected by the admin. Please join again via the new join flow to create a fresh request.');
            }

            // Authoritative duplicate-UTR check INSIDE the transaction.
            const trxSnap = await transaction.get(trxRef);
            if (trxSnap.exists()) {
                throw new Error('This Transaction ID has already been submitted!');
            }

            const paymentDocPayload = {
                paymentId,
                tournamentId: t.id,
                tournamentName: latestTourn.name || t.name,
                teamId: teamData.teamId,
                teamName: latestTeam.teamName || teamData.teamName,
                userId: uid,
                userName: uData.name || 'User',
                userEmail: uData.email || authEmail || '',
                entryFee: latestFee,
                amount: latestFee,
                transactionId: normalizedTrxId,
                paymentMethod: 'upi',
                status: 'pending',
                submittedAt: serverTimestamp(),
                reviewedAt: null,
                reviewedBy: null,
                rejectionReason: null
            };

            transaction.set(trxRef, paymentDocPayload);
            transaction.update(teamSnap.ref, {
                paymentId,
                transactionId: normalizedTrxId,
                paymentStatus: 'pending',
                updatedAt: serverTimestamp()
            });
        });
    } catch (e) {
        if (e && (e.code === 'permission-denied' || e.code === 'already-exists')) {
            throw new Error('This Transaction ID has already been submitted!');
        }
        throw e;
    }

    try {
        await addDoc(collection(db, 'users', uid, 'notifications'), {
            type: 'payment_pending',
            title: 'Payment Submitted ⏳',
            body: `Payment of ₹${authoritativeFee} for "${freshTourn.name}" (Team: ${teamData.teamId}) is waiting for admin verification.`,
            read: false,
            createdAt: serverTimestamp()
        });
    } catch (e) {}

    return authoritativeFee;
}

// ════════════════════════════════════════════════════════════════
// FIX (flow change): NEW PAID JOIN — one atomic request.
// The player confirms on the payment page with payment details; ONLY
// THEN is anything created:
//   • tournamentTeams doc  (status 'pending', paymentStatus 'pending')
//   • captain lock + player UID locks (status 'pending')
//   • paymentRequests doc  (deterministic UTR doc ID, status 'pending')
// NO seat is reserved (filledTeams/pendingTeams are NOT touched) and
// there is NO expiry — the request waits until the admin accepts
// (confirm → confirmed) or rejects it from the admin panel. The doc
// shapes match exactly what the admin panel's confirm/reject expects.
// ════════════════════════════════════════════════════════════════
function generatePaidTeamId() {
    // Same generator shape as the join flow (TEAM-XXXXX-XXXX).
    const timePart = Date.now().toString(36).toUpperCase().slice(-5);
    const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
    let randomPart = '';
    for (let i = 0; i < 4; i++) randomPart += chars.charAt(Math.floor(Math.random() * chars.length));
    return `TEAM-${timePart}-${randomPart}`;
}

export async function submitPaidJoinRequest({ t, teamName, players, trxId, uid, uData, authEmail }) {
    const normalizedTrxId = String(trxId || '').trim().toUpperCase();
    if (!normalizedTrxId) throw new Error('Transaction ID is required.');

    const teamId = generatePaidTeamId();
    const format = t.teamFormat || 'SOLO';
    const tournRef = doc(db, 'tournaments', t.id);
    const teamRef = doc(db, 'tournamentTeams', teamId);
    const captainLockRef = doc(db, 'tournamentCaptains', `${t.id}_${uid}`);
    const uidLockRefs = players.map(pl => doc(db, 'tournamentPlayerUIDs', `${t.id}_${pl.ffUID}`));
    const trxRef = doc(db, 'paymentRequests', transactionDocId(normalizedTrxId));
    const paymentId =
        'PAY-' + Date.now().toString(36).toUpperCase() +
        Math.random().toString(36).substring(2, 6).toUpperCase();

    let committedFee = 0;
    let committedName = t.name || '';

    await runTransaction(db, async (transaction) => {
        // ── ALL reads first (Firestore transaction rule) ──
        const lockSnap = await transaction.get(captainLockRef);
        if (lockSnap.exists() && lockSnap.data().status !== 'rejected') {
            throw new Error('You already have an active team registered in this tournament!');
        }

        const tournSnap = await transaction.get(tournRef);
        if (!tournSnap.exists()) throw new Error('Tournament not found!');
        const tournData = tournSnap.data();
        if ((tournData.status || 'upcoming') !== 'upcoming') {
            throw new Error(`Cannot join. Tournament is currently ${String(tournData.status).toUpperCase()}`);
        }
        // Fee is authoritative from the tournament doc — never from the client.
        const fee = Number(tournData.entryFee || 0);
        if (fee <= 0) throw new Error('This tournament is free and does not require payment!');
        committedFee = fee;
        committedName = tournData.name || t.name || '';

        // Capacity: only CONFIRMED seats count. Pending join requests hold
        // no seat under the new flow (the admin confirm re-checks capacity
        // again before confirming, so a tournament cannot overfill).
        const maxTeams = normalizeTournament(tournData, t.id).maxTeams;
        const filled = Number(tournData.filledTeams || tournData.filledSlots || 0);
        if (maxTeams > 0 && filled >= maxTeams) {
            throw new Error('Tournament is already FULL! 🔒');
        }

        const teamCollisionSnap = await transaction.get(teamRef);
        if (teamCollisionSnap.exists()) {
            throw new Error('Team ID collision detected. Please tap Confirm again!');
        }

        // FIX (2026-10-25, F1): captain-এর FF UID profile doc থেকে live
        // যাচাই — paid SOLO-তেও editable UID দিয়ে victim block করা যেত।
        const paidUserSnap = await transaction.get(doc(db, 'users', uid));
        const paidProfileFFUID = String(paidUserSnap.data()?.ffUID || '').trim();
        if (!paidProfileFFUID) {
            throw new Error('Your profile has no Free Fire UID saved. Please save it in your profile first, then join.');
        }
        if (String(players[0]?.ffUID || '').trim() !== paidProfileFFUID) {
            throw new Error('Captain Free Fire UID does not match your profile. Please check your profile and try again.');
        }

        // FIX (2026-10-25, F2): free txn-এর মতোই — lock-এর team live
        // দেখে squatted (team নেই / rejected / expired) হলে overwrite হবে;
        // live team থাকলে duplicate error। teamId-হীন lock block থাকবে।
        const uidLockSnaps = await Promise.all(uidLockRefs.map(r => transaction.get(r)));
        for (let i = 0; i < uidLockSnaps.length; i++) {
            const snap = uidLockSnaps[i];
            if (!snap.exists() || snap.data().status === 'rejected') continue;
            const lockTeamId = snap.data().teamId;
            let squatted = false;
            if (lockTeamId) {
                const lockTeamSnap = await transaction.get(doc(db, 'tournamentTeams', lockTeamId));
                if (!lockTeamSnap.exists() || lockTeamSnap.data().status === 'rejected' || lockTeamSnap.data().status === 'expired') {
                    squatted = true;
                }
            }
            if (!squatted) {
                const err = new Error(`Free Fire UID (${players[i].ffUID}) is already registered in this tournament!`);
                err.code = 'duplicate-ff-uid';
                throw err;
            }
        }

        const trxSnap = await transaction.get(trxRef);
        if (trxSnap.exists()) {
            throw new Error('This Transaction ID has already been submitted!');
        }

        // ── Writes ──
        transaction.set(teamRef, {
            teamId,
            tournamentId: t.id,
            tournamentName: committedName,
            teamName,
            teamFormat: format,
            persistentTeamId: null,
            captainUserId: uid,
            captainName: uData.name || 'User',
            // FIX (2026-10-25, M1): captainEmail REMOVED — see
            // join-tournament.js note (team docs are signed-in-readable).
            players,
            playerFFUIDs: players.map(pl => String(pl.ffUID).trim()),
            status: 'pending',
            paymentStatus: 'pending',
            locked: false,
            roomSlot: null,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
        });

        transaction.set(captainLockRef, {
            tournamentId: t.id,
            captainUserId: uid,
            teamId,
            status: 'pending',
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
        });

        uidLockRefs.forEach((ref, i) => {
            transaction.set(ref, {
                tournamentId: t.id,
                ffUID: players[i].ffUID,
                playerName: players[i].playerName,
                teamId,
                captainUserId: uid,
                status: 'pending',
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp()
            });
        });

        transaction.set(trxRef, {
            paymentId,
            tournamentId: t.id,
            tournamentName: committedName,
            teamId,
            teamName,
            userId: uid,
            userName: uData.name || 'User',
            userEmail: uData.email || authEmail || '',
            entryFee: fee,
            amount: fee,
            transactionId: normalizedTrxId,
            paymentMethod: 'upi',
            status: 'pending',
            submittedAt: serverTimestamp(),
            reviewedAt: null,
            reviewedBy: null,
            rejectionReason: null
        });
    });

    try {
        await addDoc(collection(db, 'users', uid, 'notifications'), {
            type: 'payment_pending',
            title: 'Join Request Submitted ⏳',
            body: `Your join request with payment of ₹${committedFee} for "${committedName}" is pending admin approval.`,
            read: false,
            createdAt: serverTimestamp()
        });
    } catch (e) {}

    return { teamId, fee: committedFee };
}
