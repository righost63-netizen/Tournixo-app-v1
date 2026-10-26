import { db, collection, query, where, orderBy, limit, startAfter, getDocs } from '../firebase/firebase-init.js';
import { state } from '../scripts/state.js';
import { formatTimeOnly } from '../utils/formatters.js';

// Short-lived tournament cache for UI/read optimization only.
// Critical join/payment/room authorization must use authoritative Firestore data.
const TOURNAMENT_CACHE_TTL = 45 * 1000;
const tournamentListCache = new Map();
const homeTournamentCache = { at: 0, items: null };
const upcomingRawCache = { at: 0, items: null };

// TOURNAMENT SCHEMA NORMALIZER & HELPERS
export function normalizeTournament(d, id) {
    const teamFormat = (d.teamFormat || (d.mode?.toUpperCase().includes('SOLO') ? 'SOLO' : d.mode?.toUpperCase().includes('DUO') ? 'DUO' : 'SQUAD') || 'SQUAD').toUpperCase();
    const entryFee = Number(d.entryFee || 0);
    const entryType = (d.entryType || (entryFee > 0 ? 'PAID' : 'FREE')).toUpperCase();
    const gameMode = d.gameMode || d.mode || 'BR Ranked';
    const status = (d.status || 'upcoming').toLowerCase();

    let dateObj = null;
    if (d.dateTime) {
        dateObj = d.dateTime.toDate ? d.dateTime.toDate() : new Date(d.dateTime);
    } else if (d.date) {
        dateObj = d.date.toDate ? d.date.toDate() : new Date(d.date);
    }

    const rawRoom = d.roomSettings || {};
    // FIX (2026-10-25, F-17): public tournament doc-এর room secret আর
    // roomSettings-এ কপি হবে না — room ID/password শুধু roomCredentials
    // merge থেকে আসবে (confirmed + participantUids গেট সহ)। Legacy doc-এ
    // secret থাকলে সেটা আর render হবে না; admin re-publish করলে সঠিক
    // roomCredentials লেখা হবে। isPublished/slotAssignments (secret নয়)
    // আগের মতোই থাকবে।
    const roomId = '';
    const roomPassword = '';
    const isRoomPublished = Boolean(rawRoom.roomVisible === true || rawRoom.isPublished === true || d.roomVisible === true);
    const roomSettings = {
        roomId,
        password: roomPassword,
        roomPassword,
        isPublished: isRoomPublished,
        roomVisible: isRoomPublished,
        slotAssignments: rawRoom.slotAssignments || {}
    };

    return {
        id: id || d.tournamentId || d.id,
        tournamentId: id || d.tournamentId || d.id,
        name: d.name || 'Free Fire Tournament',
        gameMode,
        teamFormat,
        entryType,
        entryFee,
        maxTeams: Number(d.maxTeams || (teamFormat === 'SOLO' ? (d.maxPlayers || d.totalSlots || 48) : (d.maxTeams || d.totalSlots || (teamFormat === 'DUO' ? 24 : 12)))),
        maxPlayers: Number(d.maxPlayers || (teamFormat === 'SOLO' ? 48 : teamFormat === 'DUO' ? 48 : 48)),
        filledTeams: Number(d.filledTeams || d.filledSlots || (d.teams ? d.teams.length : (d.participants ? d.participants.length : 0))),
        // v6: pending (unpaid) teams hold seats — the join guard counts them,
        // so the card must too, otherwise "5/12" + Join → "FULL" on submit.
        pendingTeams: Number(d.pendingTeams || 0),
        status,
        map: d.map || 'Bermuda',
        prizePool: Number(d.prizePool || 0),
        perKill: Number(d.perKill || 0),
        prizeDistribution: (Array.isArray(d.prizeDistribution) && d.prizeDistribution.length > 0) ?
            d.prizeDistribution : [
                ...(d.firstPrize ? [{ rank: 1, position: 1, label: '1st', amount: Number(d.firstPrize) }] : []),
                ...(d.secondPrize ? [{ rank: 2, position: 2, label: '2nd', amount: Number(d.secondPrize) }] : []),
                ...(d.thirdPrize ? [{ rank: 3, position: 3, label: '3rd', amount: Number(d.thirdPrize) }] : [])
            ],
        rules: d.rules || '',
        bannerUrl: d.bannerUrl || '',
        roomSettings,
        cancellationReason: d.cancellationReason || '',
        rescheduledDateTime: d.rescheduledDateTime || null,
        // U4 — RESCHEDULE, two admin shapes handled so nothing breaks either way:
        //  • Current admin (BUILD 17) writes status:'cancelled' +
        //    rescheduledInfo / rescheduledDate ('YYYY-MM-DD') / rescheduledTime
        //    and does NOT move dateTime.
        //  • A future admin may instead update dateTime and set
        //    rescheduledAt / rescheduledInfo / rescheduledReason.
        // In the future shape dateObj (from the updated dateTime) already IS
        // the new start; in the current shape the new start is parsed below.
        // A doc is 'rescheduled' only when marked cancelled AND carrying a
        // reschedule marker — genuine pure cancellations stay untouched.
        rescheduledAt: d.rescheduledAt || null,
        rescheduledInfo: d.rescheduledInfo || '',
        rescheduledDate: d.rescheduledDate || null,
        rescheduledTime: d.rescheduledTime || null,
        rescheduledReason: d.rescheduledReason || '',
        rescheduledDateObj: (() => {
            // FIX (#6/#11): legacy rescheduledDate was an IST wall time — parse it
            // AS IST (+05:30), never as device-local time. The v18 shape
            // (rescheduledAt + moved dateTime) does NOT use this field at all:
            // rescheduledAt is the moment the admin clicked, not the match time,
            // and dateObj already carries the new start.
            if (d.rescheduledDate) {
                const dt = new Date(`${d.rescheduledDate}T${d.rescheduledTime || '00:00'}:00+05:30`);
                return isNaN(dt.getTime()) ? null : dt;
            }
            return null;
        })(),
        // FIX (#6, AUD-016): admin BUILD 18 reschedule keeps status 'upcoming',
        // moves dateTime and stamps rescheduledAt — the old gate
        // (status === 'cancelled') therefore NEVER fired and players never saw
        // that a tournament was rescheduled. A doc is rescheduled when it
        // carries rescheduledAt, or when a genuine cancellation carries the
        // legacy reschedule markers.
        isRescheduled: Boolean(d.rescheduledAt) || ((status === 'cancelled') && Boolean(
            d.rescheduledDate || d.rescheduledInfo || d.rescheduledDateTime
        )),
        // FIX (#11): display labels are EXACTLY what the admin set — the stored
        // dateString / timeString are shown verbatim on every device, with no
        // timezone or device-time conversion. dateObj is kept ONLY for the
        // (timezone-independent) countdown math.
        dateLabel: d.dateString || null,
        timeLabel: d.timeString || (d.time ? formatTimeOnly(String(d.time)) : null),
        dateObj,
        raw: d
    };
}

export function getTournamentCapacity(t) {
    const isSolo = t.teamFormat === 'SOLO';
    // v6: reserved = confirmed + pending-unpaid (matches the join transaction guard).
    const current = Number(t.filledTeams || 0) + Number(t.pendingTeams || 0);
    const max = t.maxTeams;
    const isFull = max > 0 && current >= max;
    const pct = max > 0 ? Math.min((current / max) * 100, 100) : 0;
    const label = isSolo ? `Players: ${current} / ${max}` : `Teams: ${current} / ${max}`;
    return { current, max, isFull, pct, label, isSolo };
}

// Paid/free per-user captain status cache.
export async function ensureCaptainStatusCache(uid, forceRefresh = false) {
    if (!uid) return {};
    const cachedAt = Number(state.captainStatusCacheAt || 0);
    if (state.captainStatusCache && !forceRefresh && (Date.now() - cachedAt) < TOURNAMENT_CACHE_TTL) {
        return state.captainStatusCache;
    }

    try {
        const s = await getDocs(query(collection(db, 'tournamentCaptains'), where('captainUserId', '==', uid)));
        const map = {};
        s.forEach(d => {
            map[d.data().tournamentId] = d.data();
        });
        state.captainStatusCache = map;
        state.captainStatusCacheAt = Date.now();
    } catch (e) {
        state.captainStatusCache = state.captainStatusCache || {};
    }
    return state.captainStatusCache;
}

export function getCaptainStatus(tournamentId) {
    return (state.captainStatusCache && state.captainStatusCache[tournamentId]) || null;
}

function sortByDate(list) {
    list.sort((a, b) => {
        const ta = a.dateObj ? a.dateObj.getTime() : 0;
        const tb = b.dateObj ? b.dateObj.getTime() : 0;
        return ta - tb;
    });
    return list;
}

function cacheIsFresh(entry) {
    return entry && entry.items && (Date.now() - entry.at) < TOURNAMENT_CACHE_TTL;
}

// Tournaments page list (status filter: upcoming / ongoing / completed / all).
// FIX (2026-10-25, F-03): filtered query-তে orderBy('createdAt','desc')
// যোগ হলো — আগে arbitrary 50-এর মধ্যে নতুন tournament হারিয়ে যেত।
// Composite index (status+createdAt) না থাকলে failed-precondition-এ
// পুরনো unordered query-তে fallback। Load More-এর cursor service-এর
// ভেতরেই রাখা হয় (fetchTournamentListMore দেখো)।
const tournamentListCursors = new Map();
const tournamentListHasMore = new Map();
export async function fetchTournamentList(statusFilter, forceRefresh = false) {
    const key = statusFilter || 'all';
    const cached = tournamentListCache.get(key);
    if (!forceRefresh && cacheIsFresh(cached)) return cached.items;

    const buildQuery = (ordered) => {
        if (statusFilter === 'all') {
            return query(collection(db, 'tournaments'), orderBy('createdAt', 'desc'), limit(50));
        }
        return ordered
            ? query(collection(db, 'tournaments'), where('status', '==', statusFilter), orderBy('createdAt', 'desc'), limit(50))
            : query(collection(db, 'tournaments'), where('status', '==', statusFilter), limit(50));
    };

    let snap;
    try {
        snap = await getDocs(buildQuery(true));
    } catch (e) {
        if (e?.code !== 'failed-precondition') throw e;
        snap = await getDocs(buildQuery(false));
    }
    const list = [];
    snap.forEach(d => list.push(normalizeTournament(d.data(), d.id)));

    const result = sortByDate(list);
    tournamentListCache.set(key, { at: Date.now(), items: result });
    tournamentListCursors.set(key, snap.docs.length ? snap.docs[snap.docs.length - 1] : null);
    tournamentListHasMore.set(key, snap.docs.length === 50);
    return result;
}

// FIX (2026-10-25, F-03): Load More — আগের page-এর শেষ doc থেকে
// startAfter দিয়ে পরের 50 আনে; 50-এর বেশি tournament আর unreachable নয়।
export async function fetchTournamentListMore(statusFilter) {
    const key = statusFilter || 'all';
    const cursor = tournamentListCursors.get(key);
    if (!cursor) return { items: [], hasMore: false };
    const buildQuery = (ordered) => {
        if (statusFilter === 'all') {
            return query(collection(db, 'tournaments'), orderBy('createdAt', 'desc'), startAfter(cursor), limit(50));
        }
        return ordered
            ? query(collection(db, 'tournaments'), where('status', '==', statusFilter), orderBy('createdAt', 'desc'), startAfter(cursor), limit(50))
            : query(collection(db, 'tournaments'), where('status', '==', statusFilter), startAfter(cursor), limit(50));
    };
    let snap;
    try {
        snap = await getDocs(buildQuery(true));
    } catch (e) {
        if (e?.code !== 'failed-precondition') throw e;
        snap = await getDocs(buildQuery(false));
    }
    const list = [];
    snap.forEach(d => list.push(normalizeTournament(d.data(), d.id)));
    const result = sortByDate(list);
    tournamentListCursors.set(key, snap.docs.length ? snap.docs[snap.docs.length - 1] : cursor);
    const hasMore = snap.docs.length === 50;
    tournamentListHasMore.set(key, hasMore);
    return { items: result, hasMore };
}

export function tournamentListMoreAvailable(statusFilter) {
    return tournamentListHasMore.get(statusFilter || 'all') === true;
}

// Home page: the 6 SOONEST upcoming tournaments.
// (v6 fix: was limit(6) with no orderBy — Firestore returned 6 arbitrary docs
// and near-term tournaments could be missing from Home. Now we fetch a wider
// window and sort client-side, so no composite index is needed.)
export async function fetchHomeTournaments(forceRefresh = false) {
    if (!forceRefresh && cacheIsFresh(homeTournamentCache)) {
        return homeTournamentCache.items;
    }

    // FIX (2026-10-25, F-04): orderBy('dateTime') দিয়ে আনা হলো — আগে
    // unordered 24-এর মধ্যে সবচেয়ে কাছের tournament হারিয়ে যেত।
    // Composite index (status+dateTime) না থাকলে unordered fallback।
    let snap;
    try {
        snap = await getDocs(query(
            collection(db, 'tournaments'),
            where('status', '==', 'upcoming'),
            orderBy('dateTime', 'asc'),
            limit(24)
        ));
    } catch (e) {
        if (e?.code !== 'failed-precondition') throw e;
        snap = await getDocs(query(
            collection(db, 'tournaments'),
            where('status', '==', 'upcoming'),
            limit(24)
        ));
    }

    const items = [];
    snap.forEach(d => {
        const t = normalizeTournament(d.data(), d.id);
        if (t.status === 'upcoming') items.push(t);
    });

    const result = sortByDate(items).slice(0, 6);
    homeTournamentCache.at = Date.now();
    homeTournamentCache.items = result;
    return result;
}

// Raw upcoming docs used by the 30-minute reminders.
export async function fetchUpcomingRaw(forceRefresh = false) {
    if (!forceRefresh && cacheIsFresh(upcomingRawCache)) {
        return upcomingRawCache.items;
    }

    const upcoming = [];
    // FIX (2026-10-25, F-10): 'date' field tournament doc-এ নেই (আসল field
    // 'dateTime') — ordered query-তে doc-গুলো বাদ পড়ে reminder miss হতো,
    // আর catch-all fallback সেটা লুকিয়ে রাখত। এখন সঠিক field + শুধু
    // failed-precondition-এ fallback।
    try {
        const s = await getDocs(query(
            collection(db, 'tournaments'),
            where('status', '==', 'upcoming'),
            orderBy('dateTime', 'asc'),
            limit(20)
        ));
        s.forEach(d => upcoming.push({ id: d.id, ...d.data() }));
    } catch (e) {
        if (e?.code !== 'failed-precondition') throw e;
        const s = await getDocs(query(
            collection(db, 'tournaments'),
            where('status', '==', 'upcoming'),
            limit(20)
        ));
        s.forEach(d => upcoming.push({ id: d.id, ...d.data() }));
    }

    upcomingRawCache.at = Date.now();
    upcomingRawCache.items = upcoming;
    return upcoming;
}
