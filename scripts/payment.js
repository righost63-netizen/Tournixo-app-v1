import { initPage } from './app.js';
import { state } from './state.js';
import { showToast, flashToast } from './toast.js';
import { db, doc, getDoc, getDocs, collection, query, where } from '../firebase/firebase-init.js';
import { goBack, goReplace, getParam } from '../config/app-config.js';
import { isValidTrxId, isNumeric } from '../utils/validators.js';
import { escHtml } from '../utils/escape.js';
import { normalizeTournament } from '../services/tournaments.service.js';
import { getMyTeam, teamPlayersForFormat } from '../services/team.service.js';
import { fetchPaymentSettings, buildUpiIntentUrl, submitPaymentRequest, submitPaidJoinRequest } from '../services/payment.service.js';

// ════════════════════════════════════════════════════════════════
// PAYMENT PAGE — two modes
//
// NEW FLOW (payment.html?id=<tournamentId>):
//   Join button → this page. The player fills TEAM details (manual
//   entry: DUO = +1 player, SQUAD = +3 players) AND payment details
//   here. Nothing exists in Firestore until Confirm, which creates
//   the pending join request + payment in ONE transaction
//   (submitPaidJoinRequest). No seat is held and nothing expires —
//   the request waits for the admin to accept/reject it.
//
// LEGACY MODE (payment.html?id=<tid>&team=<teamId>):
//   Pre-flow-change teams that already exist with paymentStatus
//   'unpaid' — payment is submitted against the existing team via
//   submitPaymentRequest, exactly as before.
// ════════════════════════════════════════════════════════════════
let _mode = 'new'; // 'new' | 'legacy'

async function loadUpiIntoSheet(t, intentTeamId) {
    const submitBtn = document.getElementById('pay-submit-btn');
    const upiDisplay = document.getElementById('pay-upi-id-display');
    const loadError = document.getElementById('pay-load-error');
    if (loadError) loadError.style.display = 'none';
    if (submitBtn) submitBtn.disabled = true;
    if (upiDisplay) upiDisplay.textContent = 'Loading…';

    let adminUpiId, payeeName;
    try {
        ({ adminUpiId, payeeName } = await fetchPaymentSettings());
    } catch (e) {
        showToast('Couldn\'t load payment details. Please try again.', 'error');
        if (loadError) loadError.style.display = 'block';
        if (upiDisplay) upiDisplay.textContent = '—';
        const upiCopyBtnErr = document.getElementById('pay-upi-copy');
        if (upiCopyBtnErr) upiCopyBtnErr.hidden = true;
        return false;
    }
    // FIX (2026-10-25, F16): per-tournament upiId override সরানো হলো —
    // এর কোনো writer ছিল না, কিন্তু কেউ কোনোদিন set করলে payment চুপচাপ
    // ভুল payee-তে যেত। settings/payment-ই একমাত্র source of truth।
    if (submitBtn) submitBtn.disabled = false;

    document.getElementById('pay-tournament-name').textContent = t.name;
    document.getElementById('pay-fee').textContent = '₹' + Number(t.entryFee || 0);
    document.getElementById('pay-upi-id-display').textContent = adminUpiId;
    const upiCopyBtn = document.getElementById('pay-upi-copy');
    if (upiCopyBtn) {
        upiCopyBtn.hidden = false;
        upiCopyBtn.onclick = () => window.copyText(adminUpiId, 'UPI ID');
    }
    const amtInput = document.getElementById('pay-amount-input');
    if (amtInput) amtInput.value = Number(t.entryFee || 0);
    const trxInput = document.getElementById('pay-trxid');
    if (trxInput) trxInput.value = '';

    const upiIntentUrl = buildUpiIntentUrl(adminUpiId, payeeName, Number(t.entryFee || 0), intentTeamId || t.id);
    const intentBtn = document.getElementById('pay-upi-intent-link');
    if (intentBtn) intentBtn.href = upiIntentUrl;
    return true;
}

// ── Status view (request already submitted / confirmed) ──
function showStatusView(icon, title, body) {
    const form = document.getElementById('pay-main-form');
    if (form) form.style.display = 'none';
    const view = document.getElementById('pay-status-view');
    if (!view) return;
    view.style.display = 'block';
    view.innerHTML = `
        <div style="text-align:center; padding:18px 8px 8px;">
            <div style="font-size:42px; margin-bottom:10px;">${icon}</div>
            <div style="font-size:16px; font-weight:800; margin-bottom:8px;">${escHtml(title)}</div>
            <p style="font-size:13px; color:var(--text2); line-height:1.6; margin-bottom:16px;">${escHtml(body)}</p>
            <button class="btn btn-primary" onclick="goToMatches()">View My Matches</button>
        </div>`;
}
window.goToMatches = () => goReplace('matches');

// ── Roster form (manual entry — same fields as the free join form) ──
async function renderRosterForm(t) {
    const wrap = document.getElementById('pay-roster-section');
    if (!wrap) return;
    const uData = state.userData || {};
    const uName = uData.name || '';
    const uFFUID = uData.ffUID || '';
    const captainCard = (label) => `
            <div style="background:var(--bg3); border-radius:14px; padding:14px; border:1px solid var(--border); margin-bottom:10px;">
                <div style="font-size:13px; font-weight:800; color:var(--gold); margin-bottom:8px;">👑 ${label}</div>
                <div style="font-size:13px; color:var(--text); font-weight:600;">${escHtml(uName)}</div>
                <div style="font-size:12px; color:var(--text2); font-family:monospace;">Gaming UID: ${escHtml(uFFUID)}</div>
                <input id="pay-p1-uid" type="hidden" value="${escHtml(uFFUID)}">
                <input id="pay-p1-name" type="hidden" value="${escHtml(uName)}">
            </div>`;
    const mateCard = (n, title) => `
            <div style="background:var(--bg3); border-radius:14px; padding:14px; border:1px solid var(--border); margin-bottom:10px;">
                <div style="font-size:13px; font-weight:800; color:var(--accent); margin-bottom:8px;">${title}</div>
                <label class="auth-label">Player ${n} Name</label>
                <div class="input-group">
                    <span class="input-icon">👤</span>
                    <input id="pay-p${n}-name" type="text" maxlength="25" placeholder="Player ${n} Name">
                </div>
                <label class="auth-label">Player ${n} Gaming UID <span style="color:var(--error)">*</span></label>
                <div class="input-group">
                    <span class="input-icon">🎯</span>
                    <input id="pay-p${n}-uid" type="number" placeholder="Numeric Gaming UID" inputmode="numeric">
                </div>
            </div>`;
    let html = `
        <div style="font-size:14px; font-weight:800; margin-bottom:10px; color:var(--accent);">🛡️ Team Details</div>`;
    if (t.teamFormat === 'SOLO') {
        html += `
            <div style="background:var(--bg3); border-radius:14px; padding:16px; border:1px solid var(--border); margin-bottom:12px;">
                <label class="auth-label">Player Name</label>
                <div class="input-group">
                    <span class="input-icon">👤</span>
                    <input id="pay-solo-name" type="text" maxlength="25" value="${escHtml(uName)}" placeholder="Your Full Name">
                </div>
                <label class="auth-label">Free Fire Gaming UID <span style="color:var(--error)">*</span></label>
                <div style="font-size:13px; color:var(--text); font-weight:600;">${escHtml(uName)}</div>
                <div style="font-size:12px; color:var(--text2); font-family:monospace;">Gaming UID: ${escHtml(uFFUID)}</div>
                <div style="font-size:12px; color:var(--text2); margin-top:6px;">Your profile UID is used automatically — it cannot be changed here.</div>
                <input id="pay-solo-uid" type="hidden" value="${escHtml(uFFUID)}">
            </div>`;
    } else {
        html += `
            <div style="background:var(--bg3); border-radius:14px; padding:16px; border:1px solid var(--border); margin-bottom:12px;">
                <label class="auth-label">${t.teamFormat === 'DUO' ? 'Team' : 'Squad Team'} Name <span style="color:var(--error)">*</span></label>
                <div class="input-group">
                    <span class="input-icon">🛡️</span>
                    <input id="pay-team-name-input" type="text" maxlength="25" placeholder="Enter Team Name">
                </div>
            </div>
            ${captainCard(t.teamFormat === 'DUO' ? 'Captain (Player 1)' : 'Squad Captain (Player 1)')}
            ${mateCard(2, 'Player 2')}
            ${t.teamFormat === 'SQUAD' ? mateCard(3, 'Player 3') + mateCard(4, 'Player 4') : ''}`;
    }
    wrap.innerHTML = html;
    // v8.0: DUO/SQUAD-এ roster form-এ saved team-ই দেখাও (readonly)।
    if (t.teamFormat === 'DUO' || t.teamFormat === 'SQUAD') {
        const _team = await getMyTeam(state.currentUser?.uid);
        const _tp = _team ? teamPlayersForFormat(_team, { uid: state.currentUser?.uid, name: uData.name || '', ffUID: uData.ffUID || '' }, t.teamFormat) : { error: 'team' };
        if (_tp.error) { showToast(_tp.error, 'warning', 4500); goReplace('myTeam', { team: String(t.teamFormat).toLowerCase() }); return false; }
        const _tn = document.getElementById('pay-team-name-input'); if (_tn) { _tn.value = _tp.teamName; _tn.readOnly = true; }
        _tp.players.slice(1).forEach((pl, i) => {
            const n = i + 2;
            const nm = document.getElementById(`pay-p${n}-name`); if (nm) { nm.value = pl.playerName; nm.readOnly = true; }
            const ud = document.getElementById(`pay-p${n}-uid`); if (ud) { ud.value = pl.ffUID; ud.readOnly = true; }
        });
        const _note = document.createElement('div');
        _note.style.cssText = 'font-size:12px;color:var(--text2);margin-top:8px;line-height:1.6;';
        _note.textContent = 'এই roster My Team পেজ থেকে এসেছে। বদলাতে চাইলে My Team পেজে গিয়ে team edit করো।';
        wrap.appendChild(_note);
    }
    return true;
}

// v8.0: DUO/SQUAD-এর roster My Team পেজের saved team থেকে নেওয়া হয়।
// Same validation as the join form: numeric UIDs, all mates required,
// no duplicate UID inside the roster.
async function collectRoster(t) {
    const uid = state.currentUser?.uid;
    const uData = state.userData || {};
    const format = t.teamFormat || 'SOLO';
    let teamName = '';
    const players = [];
    if (format === 'SOLO') {
        const pName = document.getElementById('pay-solo-name')?.value.trim() || uData.name || 'Player';
        const pUid = document.getElementById('pay-solo-uid')?.value.trim();
        if (!pUid) { showToast('Please enter your Free Fire Gaming UID', 'warning'); return null; }
        if (!isNumeric(pUid)) { showToast('Free Fire UID must be numeric only', 'warning'); return null; }
        teamName = pName;
        players.push({ userId: uid, playerName: pName, ffUID: pUid });
    } else {
        // v8.0 TEAM GATE (paid): form input থেকে নয়, saved team থেকে।
        const _team = await getMyTeam(uid);
        const _tp = teamPlayersForFormat(_team, { uid, name: uData.name || '', ffUID: uData.ffUID || '' }, format);
        if (_tp.error) { showToast(_tp.error, 'warning', 4500); goReplace('myTeam', { team: format.toLowerCase() }); return null; }
        return { teamName: _tp.teamName, players: _tp.players };
        // (নিচের manual input পড়া DUO/SQUAD-এ আর পৌঁছায় না — gate-ই return করে।)
        teamName = document.getElementById('pay-team-name-input')?.value.trim();
        if (!teamName) { showToast('Please enter your Team Name', 'warning'); return null; }
        const p1Uid = document.getElementById('pay-p1-uid')?.value.trim() || uData.ffUID;
        const p1Name = document.getElementById('pay-p1-name')?.value.trim() || uData.name || 'Captain';
        if (!p1Uid || !isNumeric(String(p1Uid))) { showToast('Your profile Free Fire UID is missing or invalid — update it in Profile first.', 'warning'); return null; }
        players.push({ userId: uid, playerName: p1Name, ffUID: String(p1Uid) });
        const mateCount = format === 'DUO' ? 1 : 3;
        for (let n = 2; n <= mateCount + 1; n++) {
            const mName = document.getElementById(`pay-p${n}-name`)?.value.trim() || `Player ${n}`;
            const mUid = document.getElementById(`pay-p${n}-uid`)?.value.trim();
            if (!mUid) { showToast(`Please enter Player ${n} Gaming UID`, 'warning'); return null; }
            if (!isNumeric(mUid)) { showToast(`Player ${n} UID must be numeric`, 'warning'); return null; }
            players.push({ userId: '', playerName: mName, ffUID: mUid });
        }
    }
    players.forEach(pl => { pl.ffUID = String(pl.ffUID ?? '').trim(); });
    if (new Set(players.map(pl => pl.ffUID)).size !== players.length) {
        showToast('Duplicate Free Fire UIDs detected in your team!', 'error');
        return null;
    }
    // FIX (2026-10-25, L6): join form-এর মতো 25 অক্ষরের নামের সীমা।
    if (teamName.length > 25 || players.some(pl => (pl.playerName || '').length > 25)) {
        showToast('Team and player names must be 25 characters or less — shorten it in Profile if the name came from there', 'warning');
        return null;
    }
    return { teamName, players };
}

// ════════════════════════════════════════════════════════════════
// SUBMIT (both modes)
// ════════════════════════════════════════════════════════════════
export async function submitTournamentPayment() {
    const t = state.activePaymentTournament;
    const uid = state.currentUser?.uid;
    const uData = state.userData || {};
    if (!t || !uid) {
        showToast('Payment session expired. Please try joining again.', 'error');
        return;
    }
    const trxId = document.getElementById('pay-trxid').value.trim();
    if (!trxId) {
        showToast('Please enter your UPI Transaction / UTR ID', 'error');
        return;
    }
    if (!isValidTrxId(trxId)) {
        showToast('Please enter a valid alphanumeric Transaction / UTR ID (min 8 characters, no spaces)', 'error');
        return;
    }

    const submitBtn = document.getElementById('pay-submit-btn');
    const originalBtnText = submitBtn.innerHTML;

    // LEGACY MODE — existing unpaid team
    if (_mode === 'legacy') {
        const teamData = state.activePaymentTeam;
        if (!teamData) { showToast('Payment session expired. Please try joining again.', 'error'); return; }
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<div class="spinner" style="width:20px;height:20px;"></div> Verifying & Submitting...';
        try {
            await submitPaymentRequest({ t, teamData, trxId, uid, uData, authEmail: state.currentUser?.email });
            flashToast('Payment submitted successfully! Waiting for admin approval ⏳', 'success', 5000);
            goReplace('matches');
        } catch (err) {
            showToast(err.message, 'error', 5000);
            submitBtn.disabled = false;
            submitBtn.innerHTML = originalBtnText;
        }
        return;
    }

    // NEW FLOW — roster + payment → one pending join request
    const roster = await collectRoster(t);
    if (!roster) return;
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<div class="spinner" style="width:20px;height:20px;"></div> Submitting Join Request...';
    // FIX (2026-10-25, F16): page load-এর পর fee বদলে গেলে user পুরনো
    // amount pay করে থাকতে পারে — submit-এর আগে live fee মিলিয়ে নেওয়া
    // হলো; না মিললে ভুল record যাবে না, user-কে জানিয়ে থামবে। fee
    // re-read fail করলে txn-এর authoritative fee-ই record করবে। বাটন
    // fee check-এর আগেই disable করা হলো, যাতে double-tap-এ দুই submit
    // না যায় (আগে check-এর await-এর ফাঁকে double-tap window ছিল)।
    try {
        const feeSnap = await getDoc(doc(db, 'tournaments', t.id));
        const liveFee = feeSnap.exists() ? Number(feeSnap.data().entryFee || 0) : Number(t.entryFee || 0);
        if (liveFee !== Number(t.entryFee || 0)) {
            showToast(`Entry fee changed to ₹${liveFee} since you opened this page. Please pay the new fee and submit again.`, 'error', 5500);
            submitBtn.disabled = false;
            submitBtn.innerHTML = originalBtnText;
            return;
        }
    } catch (e) { /* fee re-read failed — transaction fee stays authoritative */ }
    try {
        await submitPaidJoinRequest({
            t,
            teamName: roster.teamName,
            players: roster.players,
            trxId,
            uid,
            uData,
            authEmail: state.currentUser?.email
        });
        flashToast('Join request submitted! Admin will verify your payment ⏳', 'success', 5000);
        goReplace('matches');
    } catch (err) {
        showToast(err.message, 'error', 5500);
        submitBtn.disabled = false;
        submitBtn.innerHTML = originalBtnText;
    }
}

export function closePaymentSheet() {
    goBack('matches');
}

// ════════════════════════════════════════════════════════════════
// PAGE LOAD
// ════════════════════════════════════════════════════════════════
async function loadPaymentPage() {
    const tid = getParam('id');
    const teamId = getParam('team');
    const uid = state.currentUser?.uid;
    if (!tid || !uid) {
        flashToast('Tournament not found', 'error');
        goBack('matches');
        return;
    }
    try {
        const tSnap = await getDoc(doc(db, 'tournaments', tid));
        if (!tSnap.exists()) {
            flashToast('Tournament not found', 'error');
            goBack('matches');
            return;
        }
        const t = normalizeTournament(tSnap.data(), tSnap.id);
        state.activePaymentTournament = t;

        // ── LEGACY MODE ──
        if (teamId) {
            _mode = 'legacy';
            const teamSnap = await getDoc(doc(db, 'tournamentTeams', teamId));
            if (!teamSnap.exists()) {
                flashToast('Team not found', 'error');
                goBack('matches');
                return;
            }
            if (teamSnap.data().captainUserId !== uid) {
                flashToast('Unauthorized: This team does not belong to you.', 'error');
                goBack('matches');
                return;
            }
            state.activePaymentTeam = teamSnap.data();
            document.getElementById('pay-team-name').textContent = teamSnap.data().teamName || 'My Team';
            document.getElementById('pay-team-id').textContent = teamSnap.data().teamId;
            const submitBtn = document.getElementById('pay-submit-btn');
            if (submitBtn) submitBtn.textContent = 'Submit Payment';
            await loadUpiIntoSheet(t, teamSnap.data().teamId);
            return;
        }

        // ── NEW FLOW ──
        _mode = 'new';
        if (Number(t.entryFee || 0) <= 0 || t.entryType === 'FREE') {
            flashToast('This is a free tournament — use the Join button to register.', 'info');
            goReplace('tournamentDetails', { id: tid });
            return;
        }
        if (t.status !== 'upcoming') {
            document.getElementById('pay-tournament-name').textContent = t.name;
            showStatusView('🔒', 'Tournament ' + String(t.status).toUpperCase(), 'This tournament is not accepting join requests right now.');
            return;
        }

        // Existing request states for this captain
        try {
            const ownSnap = await getDocs(query(
                collection(db, 'tournamentTeams'),
                where('tournamentId', '==', tid),
                where('captainUserId', '==', uid)
            ));
            let legacyUnpaid = null;
            for (const d of ownSnap.docs) {
                const tm = d.data();
                if (tm.status === 'confirmed' || tm.status === 'approved') {
                    document.getElementById('pay-tournament-name').textContent = t.name;
                    document.getElementById('pay-team-name').textContent = tm.teamName || 'My Team';
                    document.getElementById('pay-team-id').textContent = tm.teamId || d.id;
                    showStatusView('✅', 'You are already confirmed!', 'Your team is confirmed for this tournament. Room details will appear in My Matches when the admin publishes them.');
                    return;
                }
                if (tm.status === 'pending' && tm.paymentStatus === 'pending') {
                    document.getElementById('pay-tournament-name').textContent = t.name;
                    document.getElementById('pay-team-name').textContent = tm.teamName || 'My Team';
                    document.getElementById('pay-team-id').textContent = tm.teamId || d.id;
                    showStatusView('⏳', 'Join request already submitted', 'Your payment is waiting for admin verification. You will be notified when the admin accepts or rejects it.');
                    return;
                }
                if (tm.status === 'pending' && tm.paymentStatus === 'unpaid') legacyUnpaid = tm;
            }
            if (legacyUnpaid) {
                // Pre-flow-change team: finish it through the legacy path.
                goReplace('payment', { id: tid, team: legacyUnpaid.teamId });
                return;
            }
        } catch (e) {
            // FIX (2026-10-25, F19): advisory check fail হলে আগে চুপচাপ
            // থাকত — user পুরো form ভরে submit-এ গিয়ে জানত। এখন log +
            // ছোট note; transaction-ই final backstop থাকবে।
            console.warn('[Payment] own-team state check failed:', e?.message);
            showToast('Could not verify your existing registration — submit will re-check.', 'warning', 3500);
        }

        const rowName = document.getElementById('row-team-name');
        const rowId = document.getElementById('row-team-id');
        if (rowName) rowName.style.display = 'none';
        if (rowId) rowId.style.display = 'none';
        if (!(await renderRosterForm(t))) return;
        const submitBtn = document.getElementById('pay-submit-btn');
        if (submitBtn) submitBtn.textContent = 'Confirm Join Request';
        await loadUpiIntoSheet(t, null);
    } catch (e) {
        showToast('Error opening payment: ' + e.message, 'error');
    }
}

window.submitTournamentPayment = submitTournamentPayment;
window.closePaymentSheet = closePaymentSheet;
window.retryPaymentLoad = () => {
    const err = document.getElementById('pay-load-error');
    if (err) err.style.display = 'none';
    loadPaymentPage();
};

initPage({
    page: 'payment',
    onReady: () => {
        loadPaymentPage();
    }
});
