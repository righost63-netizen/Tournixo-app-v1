import { db, doc, getDoc } from '../firebase/firebase-init.js';

// ────────────────────────────────────────────────────────────────
// v6.1: DAILY PUBLISHED LEADERBOARD.
// The admin publishes the ranking once a day from the admin panel into
// `leaderboard/current` (one small doc). Every user-app view then costs
// exactly 1 read instead of 50 full user docs.
//
// Doc shape (written by admin):
//   leaderboard/current = {
//     updatedAt: Timestamp,          // when it was published
//     publishedBy: 'admin-uid',
//     totalPlayers: 1234,            // players considered (for context)
//     entries: [                     // top 50, rank precomputed, sorted
//       { rank: 1, name, ffUID, totalEarnings }, ...
//     ]
//   }
//
// U5: there is NO live all-users fallback anymore — 1 published doc (1 read)
// beats scanning the users collection on every view (cost + privacy), and a
// future rules tightening can never break this page. The caller shows
// 'Leaderboard not published yet' when this returns null/empty.
// ────────────────────────────────────────────────────────────────

export async function fetchPublishedLeaderboard() {
    const snap = await getDoc(doc(db, 'leaderboard', 'current'));
    if (!snap.exists()) return null;
    const d = snap.data() || {};
    const entries = Array.isArray(d.entries) ? d.entries : [];
    return {
        entries: entries
            .filter(e => e && typeof e === 'object')
            // Ranking is by lifetime Total Earned, never Winning Balance.
            // The stored rank is only a tie-breaker if an older published
            // document is re-read before the next daily publish.
            .sort((a, b) =>
                (Number(b.totalEarnings || 0) - Number(a.totalEarnings || 0)) ||
                (Number(a.rank || 999) - Number(b.rank || 999))
            ),
        updatedAt: d.updatedAt || null,
        totalPlayers: Number(d.totalPlayers || 0)
    };
}

