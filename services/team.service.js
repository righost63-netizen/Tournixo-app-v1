// ── My Team (Profile) — v8.0 ─────────────────────────────────────────
// DUO / SQUAD join-এর আগে user-কে অবশ্যই Profile থেকে নিজের team বানিয়ে
// রাখতে হবে — এটাই v8.0-এর নিয়ম। SOLO-তে team লাগে না, profile FF UID-ই
// যথেষ্ট। এক user = এক team doc (teams/{uid})।
// Rule (firestore.rules v15, teams match): create-এ captainUid == uid এবং
// members.size() <= 3 হতে হবে — তাই doc-এ members array সবসময় থাকে
// (খালি mate বাদ দিয়ে, সর্বোচ্চ 3 জন)। Join-এর সময় roster আর হাতে
// টাইপ হয় না: submit-এর মুহূর্তে এই doc থেকেই players বানানো হয়, যাতে
// DOM বদলে অন্য UID ঢোকানো না যায়। পুরনো manual tournamentTeams entry
// গুলোতে এর কোনো প্রভাব নেই — gate শুধু নতুন join-এ।
import { db, doc, getDoc, setDoc, deleteDoc, serverTimestamp } from '../firebase/firebase-init.js';
import { isNumeric } from '../utils/validators.js';

export function validateTeamInput(teamName, members, captainFFUID) {
    if (!String(teamName || '').trim()) return 'Please enter your Team Name';
    if (String(teamName).trim().length > 25) return 'Team Name must be 25 characters or less';
    const seen = new Set([String(captainFFUID || '').trim()]);
    for (let i = 0; i < members.length; i++) {
        const m = members[i] || {};
        const name = String(m.name || '').trim();
        const uid = String(m.ffUID || '').trim();
        if (!name && !uid) continue; // খালি mate = বাদ
        if (!name) return `Please enter Player ${i + 2} Name`;
        if (name.length > 25) return `Player ${i + 2} Name must be 25 characters or less`;
        if (!uid) return `Please enter Player ${i + 2} Gaming UID`;
        if (!isNumeric(uid) || !/^\d{8,12}$/.test(uid)) return `Player ${i + 2} UID must be 8–12 digits`;
        if (seen.has(uid)) return 'Duplicate Free Fire UIDs detected in your team!';
        seen.add(uid);
    }
    const filled = members.filter(m => String(m.name || '').trim() && String(m.ffUID || '').trim());
    if (filled.length === 0) return 'Please add at least Player 2 (DUO-এর জন্য Mate 1 আবশ্যক)';
    return null;
}

export async function getMyTeam(uid) {
    if (!uid) return null;
    try {
        const snap = await getDoc(doc(db, 'teams', uid));
        if (!snap.exists()) return null;
        const d = snap.data();
        return {
            teamName: d.teamName || '',
            captainUid: d.captainUid || uid,
            captainName: d.captainName || '',
            captainFFUID: d.captainFFUID || '',
            members: Array.isArray(d.members) ? d.members : []
        };
    } catch (e) { return null; }
}

export async function saveMyTeam(uid, captain, teamName, members) {
    const clean = members
        .map(m => ({ name: String(m.name || '').trim(), ffUID: String(m.ffUID || '').trim() }))
        .filter(m => m.name && m.ffUID);
    await setDoc(doc(db, 'teams', uid), {
        captainUid: uid,
        captainName: captain.name || '',
        captainFFUID: captain.ffUID || '',
        teamName: String(teamName || '').trim(),
        members: clean,
        updatedAt: serverTimestamp()
    });
}

export async function deleteMyTeam(uid) {
    await deleteDoc(doc(db, 'teams', uid));
}

// format অনুযায়ী team doc থেকে players বানাও। ভুল থাকলে { error } ফেরে,
// ঠিক থাকলে { teamName, players }। captain সবসময় players[0]।
export function teamPlayersForFormat(team, captain, format) {
    const fmt = String(format || 'SOLO').toUpperCase();
    if (fmt === 'SOLO') {
        return { teamName: captain.name || 'Player', players: [{ userId: captain.uid, playerName: captain.name || 'Player', ffUID: String(captain.ffUID || '') }] };
    }
    if (!team || !team.teamName) {
        return { error: `${fmt} join-এর আগে My Team পেজে গিয়ে নিজের team বানাও।` };
    }
    const members = team.members || [];
        if (fmt === 'DUO') {
        const validMates = members.filter(m => m && m.ffUID && m.name);
        if (validMates.length === 0) return { error: 'DUO-এর জন্য My Team পেজে অন্তত Mate 1 (নাম + FF UID) যোগ করো, তারপর আবার join করো।' };
        // একাধিক mate থাকলে join-এর সময় select করা হবে (join-tournament.js)
        // এখানে শুধু validation — actual player list join flow-এ build হয়
        return { teamName: team.teamName, players: [
            { userId: captain.uid, playerName: captain.name || 'Captain', ffUID: String(captain.ffUID || '') },
            { userId: '', playerName: validMates[0].name, ffUID: String(validMates[0].ffUID) }
        ], validMates };
        }
    // SQUAD
    if (members.length < 3 || members.some(m => !m.ffUID)) {
        return { error: 'SQUAD-এর জন্য My Team পেজে 3 জন teammate-ই (নাম + FF UID) থাকতে হবে। বাকিদের যোগ করে আবার join করো।' };
    }
    return { teamName: team.teamName, players: [
        { userId: captain.uid, playerName: captain.name || 'Captain', ffUID: String(captain.ffUID || '') },
        ...members.slice(0, 3).map((m, i) => ({ userId: '', playerName: m.name || `Player ${i + 2}`, ffUID: String(m.ffUID) }))
    ] };
}
