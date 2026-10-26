// Join flow. Loaded on demand by scripts/tournament-details.js
// (window.startTournamentJoin → import('./join-tournament.js')).
import { state } from './state.js';
import { showToast, flashToast } from './toast.js';
import { openModal, closeModal } from './modal.js';
import {
    db,
    doc,
    getDoc,
    getDocs,
    collection,
    query,
    where,
    runTransaction,
    serverTimestamp,
    arrayUnion,
    arrayRemove
} from '../firebase/firebase-init.js';
import { goTo, goReplace } from '../config/app-config.js';
import { mountComponent } from '../utils/dom-helpers.js';
import { escHtml } from '../utils/escape.js';
import { isNumeric } from '../utils/validators.js';
import { normalizeTournament, getTournamentCapacity } from '../services/tournaments.service.js';
import { getMyTeam, teamPlayersForFormat } from '../services/team.service.js';

// ════════════════════════════════════════════════════════════════
// COLLISION-PROOF UNIQUE TEAM ID GENERATOR
// ════════════════════════════════════════════════════════════════
export function generateTeamId() {
    // বর্তমান টাইমস্ট্যাম্পের Base36 + ৪ অক্ষরের র‍্যান্ডম ক্যারেক্টার
    // উদাহরণ: TEAM-M3K9P-X8F4 (কখনোই দুটি টিমের আইডি এক হবে না)
    const timePart = Date.now().toString(36).toUpperCase().slice(-5);
    const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // বিভ্রান্তিকর 0, 1, O, I বাদ দেওয়া হয়েছে
    let randomPart = '';
    for (let i = 0; i < 4; i++) {
        randomPart += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return `TEAM-${timePart}-${randomPart}`;
}

// The join form (components/join-tournament-modal.html) is mounted once, when first needed
async function ensureJoinModal() {
    if (document.getElementById('modal-join-tournament')) return;
    await mountComponent('join-tournament-modal', document.getElementById('app') || document.body);
}

// ════════════════════════════════════════════════════════════════
// START TOURNAMENT JOIN (SOLO / DUO / SQUAD DYNAMIC FORM)
// ════════════════════════════════════════════════════════════════
export async function startTournamentJoin(id) {
    const uid = state.currentUser?.uid;
    if (!uid) {
        showToast('Please sign in to join tournaments', 'error');
        goReplace('login');
        return;
    }
    // Fetch latest tournament document
    let t = null;
    try {
        const snap = await getDoc(doc(db, 'tournaments', id));
        if (!snap.exists()) {
            showToast('Tournament not found', 'error');
            return;
        }
        t = normalizeTournament(snap.data(), snap.id);
    } catch (e) {
        showToast('Failed to load tournament: ' + e.message, 'error');
        return;
    }
    if (t.status !== 'upcoming') {
        showToast(`Cannot join. Tournament is ${t.status.toUpperCase()}`, 'error');
        return;
    }
    const cap = getTournamentCapacity(t);
    if (cap.isFull) {
        showToast('Tournament is already FULL 🔒', 'error');
        return;
    }
    // Check duplicate active team by current captain
    try {
        const existingTeamSnap = await getDocs(query(
            collection(db, 'tournamentTeams'),
            where('tournamentId', '==', t.id),
            where('captainUserId', '==', uid)
        ));
        if (!existingTeamSnap.empty) {
            // FIX (2026-10-25, F7): docs[0] ছিল arbitrary — rejected পুরনো
            // টিম থাকলে live pending টিম লুকিয়ে যেত। এখন status priority
            // (confirmed → pending → rejected/expired) + newest first।
            const _ms = v => (v && typeof v.toMillis === 'function') ? v.toMillis() : (v ? new Date(v).getTime() : 0);
            const _rank = s => (s === 'confirmed' ? 0 : (s === 'pending' ? 1 : 2));
            const _docs = existingTeamSnap.docs.map(d => ({ id: d.id, ...d.data() }));
            _docs.sort((a, b) => (_rank(a.status) - _rank(b.status)) || (_ms(b.createdAt) - _ms(a.createdAt)));
            const existing = _docs[0];
            // Legacy only (pre-flow-change teams): a pending team whose payment
            // was never submitted opens the payment page in legacy-team mode.
            if (existing.status === 'pending' && existing.paymentStatus === 'unpaid' && t.entryFee > 0) {
                showToast(`Resuming payment for Team ${existing.teamName || existing.teamId}...`, 'info', 3000);
                goTo('payment', { id: t.id, team: existing.teamId });
                return;
            }
            // যদি ইতোমধ্যে পেমেন্ট সাবমিট করা থাকে
            if (existing.status === 'pending' && existing.paymentStatus === 'pending') {
                showToast(`Payment for Team ${existing.teamId} is pending admin verification.`, 'info', 4000);
                return;
            }
            if (existing.status !== 'rejected') {
                showToast(`You have already registered (${existing.teamId})`, 'info', 4000);
                return;
            }
        }
    } catch (e) {}

    // v8.0 TEAM GATE: DUO/SQUAD-এ join করতে হলে Profile-এ বানানো team
    // থাকতেই হবে। SOLO-তে team লাগে না। এই gate free + paid দুই flow-কেই
    // আটকায় (paid-এর ক্ষেত্রে payment page-এ যাওয়ার আগেই)।
    const _fmtGate = String(t.teamFormat || 'SOLO').toUpperCase();
    let _savedTeam = null;
    if (_fmtGate === 'DUO' || _fmtGate === 'SQUAD') {
        _savedTeam = await getMyTeam(uid);
        const _chk = teamPlayersForFormat(_savedTeam, { uid, name: state.userData?.name || '', ffUID: state.userData?.ffUID || '' }, _fmtGate);
        if (_chk.error) {
            showToast(_chk.error, 'warning', 4500);
            goReplace('myTeam', { team: _fmtGate.toLowerCase() });
            return;
        }
    }

    // FIX (flow change + My Team removed): there is no saved-team step anymore.
    // PAID tournament → straight to the payment page; the join request is only
    // created there, when the player confirms with payment details.
    // FREE tournament → the manual entry form below (captain + teammates typed
    // in by hand: DUO = 1 more player, SQUAD = 3 more players).
    const isFreeJoin = t.entryType === 'FREE' || Number(t.entryFee || 0) === 0;
    if (!isFreeJoin) {
        goTo('payment', { id: t.id });
        return;
    }

    await ensureJoinModal();
    state.activeJoinTournament = t;

    // Update Mini Summary in Join Modal
    const isFree = t.entryType === 'FREE' || t.entryFee === 0;
    document.getElementById('join-summary-name').textContent = t.name;
    document.getElementById('join-summary-mode').textContent = t.gameMode;
    document.getElementById('join-summary-fee').textContent = isFree ? 'FREE' : '₹' + t.entryFee;
    document.getElementById('join-summary-format').textContent = t.teamFormat;

    const formContainer = document.getElementById('join-form-container');
    // v8.0: DUO/SQUAD-এ manual form নয় — My Team পেজের saved team-ই দেখাও।
    // Submit-এর সময় team doc থেকে আবার players বানানো হয় (নিচে দেখো)।
        if (_savedTeam && (_fmtGate === 'DUO' || _fmtGate === 'SQUAD')) {
        const captain = { uid, name: state.userData?.name || '', ffUID: state.userData?.ffUID || '' };
        const _tp = teamPlayersForFormat(_savedTeam, captain, _fmtGate);

        if (_fmtGate === 'DUO') {
            // DUO: valid mate গুলো থেকে একজন select করতে দাও
            const validMates = (_savedTeam.members || []).filter(m => m && m.name && m.ffUID);
            const mateOptions = validMates.map((m, i) => `
                <label class="duo-mate-option" style="display:flex;align-items:center;gap:12px;padding:12px 14px;background:var(--bg4);border:1.5px solid var(--border);border-radius:12px;cursor:pointer;margin-bottom:8px;transition:border-color 0.2s;">
                    <input type="radio" name="duo-mate-select" value="${i}" style="width:18px;height:18px;accent-color:var(--accent);cursor:pointer;" ${i === 0 ? 'checked' : ''}>
                    <div>
                        <div style="font-size:14px;font-weight:700;color:var(--text);">${escHtml(m.name)}</div>
                        <div style="font-size:12px;color:var(--text2);font-family:monospace;">UID: ${escHtml(m.ffUID)}</div>
                    </div>
                </label>`).join('');

            formContainer.innerHTML = `
                <div style="background:var(--bg3);border-radius:14px;padding:16px;border:1px solid var(--border);margin-bottom:12px;">
                    <div style="font-size:14px;font-weight:800;margin-bottom:4px;color:var(--accent);">🛡️ ${escHtml(_savedTeam.teamName)}</div>
                    <div style="font-size:12px;color:var(--text2);">DUO টুর্নামেন্ট — তোমার সাথে কে খেলবে?</div>
                </div>

                <!-- Captain (fixed) -->
                <div style="background:var(--bg3);border-radius:14px;padding:13px 14px;border:1px solid var(--border);margin-bottom:12px;display:flex;align-items:center;gap:10px;">
                    <span style="font-size:18px;">👑</span>
                    <div>
                        <div style="font-size:13px;font-weight:800;color:var(--gold);">Captain (তুমি)</div>
                        <div style="font-size:13px;color:var(--text);font-weight:600;">${escHtml(captain.name)}</div>
                        <div style="font-size:11.5px;color:var(--text2);font-family:monospace;">UID: ${escHtml(captain.ffUID)}</div>
                    </div>
                </div>

                <!-- Mate selector -->
                <div style="font-size:13px;font-weight:700;color:var(--text2);margin-bottom:10px;">Teammate বেছে নাও:</div>
                <div id="duo-mate-list">${mateOptions}</div>`;

            // Radio select visual highlight
            formContainer.querySelectorAll('input[name="duo-mate-select"]').forEach(radio => {
                const updateHighlight = () => {
                    formContainer.querySelectorAll('.duo-mate-option').forEach((lbl, i) => {
                        const r = lbl.querySelector('input[type="radio"]');
                        lbl.style.borderColor = r?.checked ? 'var(--accent)' : 'var(--border)';
                        lbl.style.background  = r?.checked ? 'rgba(0,210,106,0.07)' : 'var(--bg4)';
                    });
                };
                radio.addEventListener('change', updateHighlight);
                updateHighlight();
            });

        } else {
            // SQUAD: সব player দেখাও (select নেই, সবাই যাবে)
            formContainer.innerHTML = `
                <div style="background:var(--bg3);border-radius:14px;padding:16px;border:1px solid var(--border);">
                    <div style="font-size:14px;font-weight:800;margin-bottom:10px;color:var(--accent);">🛡️ Your Squad</div>
                    <div style="font-size:15px;font-weight:800;margin-bottom:10px;">${escHtml(_savedTeam.teamName)}</div>
                    ${_tp.players.map((pl, i) => `
                        <div style="display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid var(--border);">
                            <span style="font-size:14px;">${i === 0 ? '👑' : '🎮'}</span>
                            <div>
                                <div style="font-size:13px;font-weight:700;color:var(--text);">${escHtml(pl.playerName)}</div>
                                <div style="font-size:11.5px;color:var(--text2);font-family:monospace;">UID: ${escHtml(pl.ffUID)}</div>
                            </div>
                        </div>`).join('')}
                </div>`;
        }

        openModal('modal-join-tournament');
        return;
    }
    const uData = state.userData || {};
    const uName = uData.name || '';
    const uFFUID = uData.ffUID || '';

    if (t.teamFormat === 'SOLO') {
        formContainer.innerHTML = `
            <div style="background:var(--bg3); border-radius:14px; padding:16px; border:1px solid var(--border);">
                <div style="font-size:14px; font-weight:800; margin-bottom:14px; color:var(--accent);">🎮 Player Details (Solo)</div>
                <label class="auth-label">Player Name</label>
                <div class="input-group">
                    <span class="input-icon">👤</span>
                    <input id="solo-player-name" type="text" maxlength="25" value="${escHtml(uName)}" placeholder="Your Full Name">
                </div>
                <label class="auth-label">Free Fire Gaming UID <span style="color:var(--error)">*</span></label>
                <div style="font-size:13px; color:var(--text); font-weight:600;">${escHtml(uName)}</div>
                <div style="font-size:12px; color:var(--text2); font-family:monospace;">Gaming UID: ${escHtml(uFFUID)}</div>
                <div style="font-size:12px; color:var(--text2); margin-top:6px;">Your profile UID is used automatically — it cannot be changed here.</div>
                <input id="solo-player-uid" type="hidden" value="${escHtml(uFFUID)}">
            </div>`;
    } else if (t.teamFormat === 'DUO') {
        formContainer.innerHTML = `
            <div style="background:var(--bg3); border-radius:14px; padding:16px; border:1px solid var(--border); margin-bottom:12px;">
                <label class="auth-label">Team Name <span style="color:var(--error)">*</span></label>
                <div class="input-group">
                    <span class="input-icon">🛡️</span>
                    <input id="duo-team-name" type="text" maxlength="25" placeholder="Enter Team Name">
                </div>
            </div>
            <!-- Captain (You) -->
            <div style="background:var(--bg3); border-radius:14px; padding:14px; border:1px solid var(--border); margin-bottom:10px;">
                <div style="font-size:13px; font-weight:800; color:var(--gold); margin-bottom:8px;">👑 Captain (Player 1)</div>
                <div style="font-size:13px; color:var(--text); font-weight:600;">${escHtml(uName)}</div>
                <div style="font-size:12px; color:var(--text2); font-family:monospace;">Gaming UID: ${escHtml(uFFUID)}</div>
                <input id="duo-p1-uid" type="hidden" value="${escHtml(uFFUID)}">
                <input id="duo-p1-name" type="hidden" value="${escHtml(uName)}">
            </div>
            <!-- Teammate 2 -->
            <div style="background:var(--bg3); border-radius:14px; padding:14px; border:1px solid var(--border);">
                <div style="font-size:13px; font-weight:800; color:var(--accent); margin-bottom:8px;">Player 2</div>
                <label class="auth-label">Player 2 Name</label>
                <div class="input-group">
                    <span class="input-icon">👤</span>
                    <input id="duo-p2-name" type="text" maxlength="25" placeholder="Teammate 2 Name">
                </div>
                <label class="auth-label">Player 2 Gaming UID <span style="color:var(--error)">*</span></label>
                <div class="input-group">
                    <span class="input-icon">🎯</span>
                    <input id="duo-p2-uid" type="number" placeholder="Numeric Gaming UID" inputmode="numeric">
                </div>
            </div>`;
    } else {
        // SQUAD (4 Players Required)
        formContainer.innerHTML = `
            <div style="background:var(--bg3); border-radius:14px; padding:16px; border:1px solid var(--border); margin-bottom:12px;">
                <label class="auth-label">Squad Team Name <span style="color:var(--error)">*</span></label>
                <div class="input-group">
                    <span class="input-icon">🛡️</span>
                    <input id="squad-team-name" type="text" maxlength="25" placeholder="Enter Squad Name">
                </div>
            </div>
            <!-- Captain (You) -->
            <div style="background:var(--bg3); border-radius:14px; padding:14px; border:1px solid var(--border); margin-bottom:10px;">
                <div style="font-size:13px; font-weight:800; color:var(--gold); margin-bottom:8px;">👑 Squad Captain (Player 1)</div>
                <div style="font-size:13px; color:var(--text); font-weight:600;">${escHtml(uName)}</div>
                <div style="font-size:12px; color:var(--text2); font-family:monospace;">Gaming UID: ${escHtml(uFFUID)}</div>
                <input id="squad-p1-uid" type="hidden" value="${escHtml(uFFUID)}">
                <input id="squad-p1-name" type="hidden" value="${escHtml(uName)}">
            </div>
            <!-- Player 2 -->
            <div style="background:var(--bg3); border-radius:14px; padding:14px; border:1px solid var(--border); margin-bottom:10px;">
                <div style="font-size:13px; font-weight:800; color:var(--accent); margin-bottom:8px;">Player 2</div>
                <div class="input-group" style="height:46px; margin-bottom:8px;">
                    <input id="squad-p2-name" type="text" maxlength="25" placeholder="Player 2 Name">
                </div>
                <div class="input-group" style="height:46px; margin-bottom:0;">
                    <input id="squad-p2-uid" type="number" placeholder="Player 2 Gaming UID" inputmode="numeric">
                </div>
            </div>
            <!-- Player 3 -->
            <div style="background:var(--bg3); border-radius:14px; padding:14px; border:1px solid var(--border); margin-bottom:10px;">
                <div style="font-size:13px; font-weight:800; color:var(--accent); margin-bottom:8px;">Player 3</div>
                <div class="input-group" style="height:46px; margin-bottom:8px;">
                    <input id="squad-p3-name" type="text" maxlength="25" placeholder="Player 3 Name">
                </div>
                <div class="input-group" style="height:46px; margin-bottom:0;">
                    <input id="squad-p3-uid" type="number" placeholder="Player 3 Gaming UID" inputmode="numeric">
                </div>
            </div>
            <!-- Player 4 -->
            <div style="background:var(--bg3); border-radius:14px; padding:14px; border:1px solid var(--border);">
                <div style="font-size:13px; font-weight:800; color:var(--accent); margin-bottom:8px;">Player 4</div>
                <div class="input-group" style="height:46px; margin-bottom:8px;">
                    <input id="squad-p4-name" type="text" maxlength="25" placeholder="Player 4 Name">
                </div>
                <div class="input-group" style="height:46px; margin-bottom:0;">
                    <input id="squad-p4-uid" type="number" placeholder="Player 4 Gaming UID" inputmode="numeric">
                </div>
            </div>`;
    }
    openModal('modal-join-tournament');
}

// ════════════════════════════════════════════════════════════════
// TOURNAMENT REGISTRATION SUBMISSION (SOLO, DUO, SQUAD)
// Handles both FREE (Instant Confirm) & PAID (Proceed to UPI Payment page)
// ════════════════════════════════════════════════════════════════
export async function submitTournamentRegistration() {
    const t = state.activeJoinTournament;
    const uid = state.currentUser?.uid;
    const uData = state.userData || {};
    if (!t || !uid) {
        showToast('Session expired. Please re-open the tournament.', 'error');
        return;
    }
    const submitBtn = document.getElementById('join-submit-btn');
    const originalBtnText = submitBtn.innerHTML;
    try {
        let teamName = '';
        let players = [];
        const format = t.teamFormat || 'SOLO';

        // v8.0: DUO/SQUAD-এর roster form input থেকে নয়, My Team পেজের saved
        // team doc থেকে নেওয়া হয় — DOM বদলে অন্য UID ঢোকানো যাবে না।
                if (format === 'DUO' || format === 'SQUAD') {
            const _team = await getMyTeam(uid);
            const captain = { uid, name: uData.name || '', ffUID: uData.ffUID || '' };
            const _tp = teamPlayersForFormat(_team, captain, format);
            if (_tp.error) { showToast(_tp.error, 'warning', 4500); goReplace('myTeam', { team: format.toLowerCase() }); return; }
            teamName = _tp.teamName;

            if (format === 'DUO') {
                // Radio থেকে selected mate index নাও
                const selectedRadio = document.querySelector('input[name="duo-mate-select"]:checked');
                const mateIdx = selectedRadio ? parseInt(selectedRadio.value, 10) : 0;
                const validMates = (_team.members || []).filter(m => m && m.name && m.ffUID);
                const chosenMate = validMates[mateIdx] || validMates[0];
                if (!chosenMate) { showToast('Teammate select করো', 'warning'); return; }
                players.push(
                    { userId: uid, playerName: captain.name || 'Captain', ffUID: String(captain.ffUID || '') },
                    { userId: '', playerName: chosenMate.name, ffUID: String(chosenMate.ffUID) }
                );
            } else {
                players.push(..._tp.players);
            }
        } else
        // ── ১. ভ্যালিডেশন এবং ডেটা সংগ্রহ (Solo, Duo, Squad) ──
        if (format === 'SOLO') {
            const pName = document.getElementById('solo-player-name')?.value.trim() || uData.name || 'Player';
            const pUid = document.getElementById('solo-player-uid')?.value.trim();
            if (!pUid) {
                showToast('Please enter your Free Fire Gaming UID', 'warning');
                return;
            }
            if (!isNumeric(pUid)) {
                showToast('Free Fire UID must be numeric only', 'warning');
                return;
            }
            teamName = pName;
            players.push({
                userId: uid,
                playerName: pName,
                ffUID: pUid
            });
        } else if (format === 'DUO') {
            teamName = document.getElementById('duo-team-name')?.value.trim();
            if (!teamName) {
                showToast('Please enter your Duo Team Name', 'warning');
                return;
            }
            const p1Uid = document.getElementById('duo-p1-uid')?.value.trim() || uData.ffUID;
            const p1Name = document.getElementById('duo-p1-name')?.value.trim() || uData.name || 'Captain';
            const p2Name = document.getElementById('duo-p2-name')?.value.trim() || 'Player 2';
            const p2Uid = document.getElementById('duo-p2-uid')?.value.trim();
            if (!p2Uid) {
                showToast('Please enter Player 2 Gaming UID', 'warning');
                return;
            }
            if (!isNumeric(p2Uid)) {
                showToast('Player 2 UID must be numeric', 'warning');
                return;
            }
            if (p1Uid === p2Uid) {
                showToast('Captain and Teammate cannot have the same Free Fire UID!', 'error');
                return;
            }
            players.push({
                userId: uid,
                playerName: p1Name,
                ffUID: p1Uid
            });
            players.push({
                userId: '',
                playerName: p2Name,
                ffUID: p2Uid
            });
        } else {
            // SQUAD (4 Players)
            teamName = document.getElementById('squad-team-name')?.value.trim();
            if (!teamName) {
                showToast('Please enter your Squad Team Name', 'warning');
                return;
            }
            const p1Uid = document.getElementById('squad-p1-uid')?.value.trim() || uData.ffUID;
            const p1Name = document.getElementById('squad-p1-name')?.value.trim() || uData.name || 'Captain';
            const p2Name = document.getElementById('squad-p2-name')?.value.trim() || 'Player 2';
            const p2Uid = document.getElementById('squad-p2-uid')?.value.trim();
            const p3Name = document.getElementById('squad-p3-name')?.value.trim() || 'Player 3';
            const p3Uid = document.getElementById('squad-p3-uid')?.value.trim();
            const p4Name = document.getElementById('squad-p4-name')?.value.trim() || 'Player 4';
            const p4Uid = document.getElementById('squad-p4-uid')?.value.trim();
            if (!p2Uid || !p3Uid || !p4Uid) {
                showToast('All 4 players Free Fire UIDs are required for Squad', 'warning');
                return;
            }
            const uids = [p1Uid, p2Uid, p3Uid, p4Uid];
            if (uids.some(id => !isNumeric(id))) {
                showToast('All Free Fire UIDs must be numeric', 'warning');
                return;
            }
            // স্কোয়াডে কোনো ডুপ্লিকেট UID রয়েছে কি না যাচাই
            const uniqueUids = new Set(uids);
            if (uniqueUids.size !== 4) {
                showToast('Duplicate Free Fire UIDs detected in your Squad!', 'error');
                return;
            }
            players.push({
                userId: uid,
                playerName: p1Name,
                ffUID: p1Uid
            });
            players.push({
                userId: '',
                playerName: p2Name,
                ffUID: p2Uid
            });
            players.push({
                userId: '',
                playerName: p3Name,
                ffUID: p3Uid
            });
            players.push({
                userId: '',
                playerName: p4Name,
                ffUID: p4Uid
            });
        }

        // ── সব প্লেয়ারের FF UID নরমালাইজ + ভ্যালিডেট (lock doc ID এর জন্য জরুরি) ──
        players.forEach(p => { p.ffUID = String(p.ffUID ?? '').trim(); });
        if (players.some(p => !p.ffUID || !isNumeric(p.ffUID))) {
            showToast('All players must have a valid numeric Free Fire UID (check your profile UID)', 'warning');
            return;
        }
        if (new Set(players.map(p => p.ffUID)).size !== players.length) {
            showToast('Duplicate Free Fire UIDs detected in your team!', 'error');
            return;
        }

        // FIX (2026-10-25, L6): নামের দৈর্ঘ্য সীমা — maxlength টাইপিং
        // আটকালেও paste/devtools বাইপাস করতে পারে, তাই submit-এও চেক।
        // Edit Name-এর 25 অক্ষরের সীমার সঙ্গে মিলিয়ে।
        if (teamName.length > 25 || players.some(p => (p.playerName || '').length > 25)) {
            showToast('Team and player names must be 25 characters or less — shorten it in Profile if the name came from there', 'warning');
            return;
        }

        // বাটন লোডিং স্টেট
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<div class="spinner" style="width:20px;height:20px;"></div> Processing...';

        // ── v6.1: ADVISORY PRE-CHECK REMOVED ──
        // The old code downloaded EVERY team of the tournament here (up to ~48
        // reads per join) for a friendly duplicate error. The atomic duplicate
        // check inside the transaction below (tournamentPlayerUIDs locks) gives
        // the same friendly error — so this scan was pure waste. Removed.

        // ── v7: the rest runs through the shared executor ──
        // FIX (2026-10-25, F14): আসল বাটন text executor-কে দেওয়া হলো —
        // নইলে executor spinner-কেই "original" ধরে fail-এর পরেও spinner দেখাত।
        await runJoinTransaction(t, teamName, players, null, { submitBtn, fromModal: true, originalBtnText });
    } catch (err) {
        // errors are toasted inside runJoinTransaction
    }
}

// ── v7: shared join executor — manual form AND My Team use this ──
// persistentTeamId: links the entry to a saved team (null for manual joins).
export async function runJoinTransaction(t, teamName, players, persistentTeamId, opts = {}) {
    const uid = state.currentUser?.uid;
    const uData = state.userData || {};
    const submitBtn = opts.submitBtn || null;
    // FIX (2026-10-25, F14): caller আসল text দিলে সেটাই restore হবে;
    // না দিলে আগের মতো spinner সেট করার আগের text ধরা হবে।
    const originalBtnText = opts.originalBtnText || (submitBtn ? submitBtn.innerHTML : '');
    const format = t.teamFormat || 'SOLO';
    const fromModal = opts.fromModal !== false;
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<div class="spinner" style="width:20px;height:20px;"></div> Processing...';
    }
    try {
            const teamId = generateTeamId();
            const isFree = (t.entryType === 'FREE' || Number(t.entryFee || 0) === 0);

            // ════════════════════════════════════════════════════════════════
    // TEAM PAYLOAD
    // FREE tournament:
    //   - immediately confirmed
    //   - automatically locked
    //   - roomSlot will be assigned inside the transaction
    //
    // PAID tournament:
    //   - existing pending/payment flow remains unchanged
    // ════════════════════════════════════════════════════════════════
    const teamPayload = {
        teamId: teamId,
        tournamentId: t.id,
        tournamentName: t.name,
        teamName: teamName,
        teamFormat: format,
        persistentTeamId: null, // saved teams removed — manual entry only
        captainUserId: uid,
        captainName: uData.name || 'User',
        // FIX (2026-10-25, M1): captainEmail REMOVED — team docs are
        // readable by any signed-in user (public rosters), so storing the
        // captain's email there leaked PII. Admin lookup uses the
        // owner-scoped paymentRequests.userEmail instead; nothing reads
        // this field (verified by grep).
        players: players,

        // ✅ টিমমেটরা (userId: '') যাতে নিজেদের Matches পেজে টিম দেখতে পায়:
        // ffUID এর flat array — Firestore এ array-of-objects এর ভেতরে query করা যায় না,
        // তাই matches.js এই ফিল্ডে array-contains দিয়ে খোঁজে।
        playerFFUIDs: players.map(p => String(p.ffUID).trim()),

        // FREE = immediately confirmed
        // PAID = pending until payment/admin verification
        status: isFree ? 'confirmed' : 'pending',

        paymentStatus: isFree ? 'free' : 'unpaid',

        // FREE tournament will be locked automatically.
        // PAID tournament keeps the existing unlocked state.
        locked: isFree,

        // IMPORTANT:
        // Free tournament roomSlot is calculated from the latest
        // filledTeams value INSIDE the Firestore transaction.
        roomSlot: null,

        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
    };

            const tournRef = doc(db, 'tournaments', t.id);
            const teamRef = doc(db, 'tournamentTeams', teamId);
            const userRef = doc(db, 'users', uid);
            // 🛡️ ক্যাপ্টেনের জন্য ইউনিক লক ডকুমেন্ট (ডাবল ক্লিক ও ডুপ্লিকেট টিম রোধ)
            const captainLockRef = doc(db, 'tournamentCaptains', `${t.id}_${uid}`);
            // 🛡️ প্রতিটি FF UID এর জন্য ইউনিক লক ডকুমেন্ট (cross-team duplicate UID atomic ভাবে ব্লক)
            const playerUidLocks = players.map(p => ({
                player: p,
                ref: doc(db, 'tournamentPlayerUIDs', `${t.id}_${p.ffUID}`)
            }));

    // ════════════════════════════════════════════════════════════════
    // ATOMIC TOURNAMENT REGISTRATION
    //
    // FREE:
    //   Join → Confirmed → Auto Lock → Auto Slot → Joined
    //
    // PAID:
    //   Existing Pending → Payment flow remains unchanged
    //
    // Firestore transaction guarantees that if multiple users join
    // at nearly the same time, each user receives a different slot.
    // ════════════════════════════════════════════════════════════════
    await runTransaction(db, async (transaction) => {

        // ────────────────────────────────────────────────────────────
        // 1. DUPLICATE CAPTAIN CHECK
        // ────────────────────────────────────────────────────────────
        const lockSnap = await transaction.get(captainLockRef);

        if (
            lockSnap.exists() &&
            lockSnap.data().status !== 'rejected'
        ) {
            throw new Error(
                'You already have an active team registered in this tournament!'
            );
        }


        // ────────────────────────────────────────────────────────────
        // 2. READ LATEST TOURNAMENT DATA
        //
        // IMPORTANT:
        // We MUST calculate the slot from this transaction's latest
        // filledTeams value, not from the old page data.
        // ────────────────────────────────────────────────────────────
        const tournSnap = await transaction.get(tournRef);

        if (!tournSnap.exists()) {
            throw new Error('Tournament not found!');
        }

        const tournData = tournSnap.data();

        // FIX (2026-10-25, F6): form খোলার পর admin tournament start করলে
        // বা free→paid করলেও পুরনো txn চুপচাপ confirmed টিম বানাত। এখন
        // live doc থেকেই status + fee যাচাই হবে।
        if ((tournData.status || 'upcoming') !== 'upcoming') {
            throw new Error(`Cannot join. Tournament is currently ${String(tournData.status).toUpperCase()}`);
        }
        if (!(tournData.entryType === 'FREE' || Number(tournData.entryFee || 0) === 0)) {
            throw new Error('This tournament now requires payment. Please join via the payment flow.');
        }

        // FIX (2026-10-25, F1): captain-এর FF UID profile doc থেকে live
        // যাচাই — DOM-এর hidden input বদলে অন্যের UID দিয়ে join করা
        // যাবে না (victim block + নিজের double entry দুটোই বন্ধ)।
        const userSnap = await transaction.get(userRef);
        const profileFFUID = String(userSnap.data()?.ffUID || '').trim();
        if (!profileFFUID) {
            throw new Error('Your profile has no Free Fire UID saved. Please save it in your profile first, then join.');
        }
        if (String(players[0]?.ffUID || '').trim() !== profileFFUID) {
            throw new Error('Captain Free Fire UID does not match your profile. Please check your profile and try again.');
        }

        // Use the SAME capacity rule as the UI (normalizeTournament), so a
        // tournament without an explicit maxTeams gets the same default
        // (SOLO 48 / DUO 24 / SQUAD 12) here as on the screen, instead of
        // being treated as unlimited.
        const maxTeams = normalizeTournament(tournData, t.id).maxTeams;

        const filledTeams = Number(
            tournData.filledTeams ||
            tournData.filledSlots ||
            0
        );

        // Legacy paid pendings from the old flow still hold seats
        // (pendingTeams > 0) until the admin resolves them; new-flow paid
        // requests hold NO seat, so this only ever counts legacy data.
        const pendingTeams = Number(tournData.pendingTeams || 0);


        // ────────────────────────────────────────────────────────────
        // 3. CAPACITY CHECK (confirmed seats + reserved pending seats)
        // ────────────────────────────────────────────────────────────
        if (
            maxTeams > 0 &&
            filledTeams + pendingTeams >= maxTeams
        ) {
            throw new Error('Tournament is already FULL! 🔒');
        }


        // ────────────────────────────────────────────────────────────
        // 4. TEAM ID COLLISION CHECK
        // ────────────────────────────────────────────────────────────
        const teamCollisionSnap = await transaction.get(teamRef);

        if (teamCollisionSnap.exists()) {
            throw new Error(
                'Team ID collision detected. Please tap Confirm again!'
            );
        }


        // ────────────────────────────────────────────────────────────
        // 4b. DUPLICATE FF UID CHECK (ATOMIC, CROSS-TEAM)
        //
        // Firestore requires ALL reads before ANY write, so every UID
        // lock is read here. If two users race with the same UID, one
        // transaction will be retried/aborted and will see the lock
        // written by the other → throws below.
        // 'rejected' lock = UID released (same rule as captain lock).
        // ────────────────────────────────────────────────────────────
        const uidLockSnaps = await Promise.all(
            playerUidLocks.map(l => transaction.get(l.ref))
        );
        // FIX (2026-10-25, F2): শুধু lock থাকলেই block নয় — lock-এর
        // teamId দিয়ে team doc-টি live দেখা হবে। team না থাকলে বা
        // rejected/expired হলে lock-টি squatted/মৃত ধরে overwrite হবে
        // (writes phase-এ নতুন lock বসবে)। teamId-হীন lock প্রমাণ করা
        // যায় না বলে আগের মতোই block থাকবে — সেটা admin-কে delete
        // করতে হবে।
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
                const err = new Error(
                    `Free Fire UID (${playerUidLocks[i].player.ffUID}) is already registered in this tournament!`
                );
                err.code = 'duplicate-ff-uid';
                throw err;
            }
        }


        // ════════════════════════════════════════════════════════════
        // 5. FREE TOURNAMENT AUTO-JOIN
        // ════════════════════════════════════════════════════════════
        if (isFree) {

            // ✅ FIX (2026-10-24, AUD-024): আগে slot সবসময়
            // filledTeams+1 নেওয়া হতো — মাঝের কোনো টিম kick হলে
            // (যেমন slot 2 খালি) নতুন টিম এমন slot পেত যা আগেই অন্য
            // টিমের দখলে (collision)। এখন admin kick/reject-এর সময়
            // খালি slot tournament doc-এর freedSlots array-তে জমা হয়,
            // আর join সবচেয়ে ছোট খালি slot-টাই নেয়; খালি না থাকলে
            // আগের মতো filledTeams+1। (rules v13-এ freedSlots শুধু
            // ছোটই হতে পারে — বাড়ানো যায় না।)
            const freedSlots = Array.isArray(tournData.freedSlots)
                ? tournData.freedSlots.map(Number).filter(n => Number.isFinite(n) && n >= 1)
                : [];
            const assignedSlot = freedSlots.length ? Math.min(...freedSlots) : filledTeams + 1;
            // ⚠️ filledTeams হলো COUNT (কয়টা টিম), slot নম্বর নয় — freed
            // slot (যেমন 2) নিলেও count filledTeams+1-ই হবে, নইলে counter
            // ভেঙে capacity check ভুল দেখাত।
            const newFilled = filledTeams + 1;


            // FIX (2026-10-25, F15): counterGuard doc-এর playersPerTeam
            // দিয়ে যাচাই করে — client format দিয়ে লিখলে legacy doc-এ
            // (playersPerTeam নেই) join permission error-এ মরত। এখন doc-এর
            // field থাকলে সেটাই, না থাকলে format default।
            const playersPerTeam =
                Number(tournData.playersPerTeam || 0) ||
                (format === 'SOLO' ? 1 :
                format === 'DUO'  ? 2 :
                4);


            // ────────────────────────────────────────────────────────
            // Update tournament counters
            // ────────────────────────────────────────────────────────
            transaction.update(tournRef, {

                // Number of teams / solo players registered
                filledTeams: newFilled,

                // Keep the existing filledSlots field synchronized
                filledSlots: newFilled,

                // Total player count
                filledPlayers:
                    newFilled * playersPerTeam,

                // নেওয়া slot freedSlots থেকে সরিয়ে দেওয়া (থাকলে)
                ...(freedSlots.length ? { freedSlots: arrayRemove(assignedSlot) } : {})
            });


            // ────────────────────────────────────────────────────────
            // Update user's joined tournaments
            // ────────────────────────────────────────────────────────
            transaction.update(userRef, {
                joinedTournaments: arrayUnion(t.id)
            });


            // ────────────────────────────────────────────────────────
            // FREE TEAM = IMMEDIATELY CONFIRMED + LOCKED + SLOT
            // ────────────────────────────────────────────────────────
            transaction.set(teamRef, {

                ...teamPayload,

                // FREE tournament is instantly confirmed
                status: 'confirmed',

                // Free tournament team is automatically locked
                locked: true,

                // Automatically assigned room/participation slot
                roomSlot: assignedSlot,

                // System records why/how it was locked
                lockedAt: serverTimestamp(),
                lockedBy: 'system-auto',

                updatedAt: serverTimestamp()
            });


            // ────────────────────────────────────────────────────────
            // Captain lock
            // Prevents the same user from joining twice.
            // ────────────────────────────────────────────────────────
            transaction.set(captainLockRef, {

                tournamentId: t.id,

                captainUserId: uid,

                teamId: teamId,

                status: 'confirmed',

                // Store the assigned slot here too
                roomSlot: assignedSlot,

                createdAt: serverTimestamp(),

                updatedAt: serverTimestamp()
            });

        } else {

            // ════════════════════════════════════════════════════════
            // PAID TOURNAMENT
            //
            // KEEP EXISTING PAYMENT FLOW:
            // pending + unpaid + no automatic slot
            // ════════════════════════════════════════════════════════

            // FIX (flow change): paid joins NEVER reach this executor anymore —
            // they are created from the payment page (services/payment.service.js
            // submitPaidJoinRequest) only after payment details are confirmed.
            // This branch is a safety net and must not create a payable team.
            throw new Error('Paid joins are completed on the payment page.');
        }


        // ════════════════════════════════════════════════════════════
        // 6. PLAYER UID LOCKS (FREE + PAID দুটোতেই)
        // Team doc এর সাথে একই transaction এ লেখা হয় → all-or-nothing।
        // ════════════════════════════════════════════════════════════
        playerUidLocks.forEach(({ player, ref }) => {
            transaction.set(ref, {
                tournamentId: t.id,
                ffUID: player.ffUID,
                playerName: player.playerName,
                teamId: teamId,
                captainUserId: uid,
                status: isFree ? 'confirmed' : 'pending',
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp()
            });
        });
    });

            // FREE join success (paid joins never reach this executor anymore)
            if (fromModal) { try { closeModal('modal-join-tournament'); } catch (e) {} }
            // Reload the details page so the button/participants show the new state;
            // the success toast is shown right after the reload.
            flashToast(`Successfully registered for ${t.name}! 🎉`, 'success', 5000);
            window.location.reload();
        } catch (err) {
            console.error('runJoinTransaction error:', err);
            if (err.code === 'duplicate-ff-uid') {
                showToast(err.message, 'error', 5500);
            } else {
                showToast('Failed to complete registration: ' + err.message, 'error', 4500);
        throw err;
            }
        } finally {
            if (submitBtn) submitBtn.disabled = false;
            if (submitBtn) submitBtn.innerHTML = originalBtnText;
        }
    } // ── end runJoinTransaction ──

// Inline onclick handler in the modal needs this on window
window.submitTournamentRegistration = submitTournamentRegistration;