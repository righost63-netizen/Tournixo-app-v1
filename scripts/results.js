import { initPage } from './app.js';
import { state } from './state.js';
import { goTo, getParam } from '../config/app-config.js';
import { formatDateOnly } from '../utils/formatters.js';
import { fetchTournamentResults, fetchCompletedTournaments, fetchResultPosts, fetchResultPoster } from '../services/results.service.js';

// ════════════════════════════════════════════════════════════════
// XSS PROTECTION: Firestore থেকে আসা যেকোনো string innerHTML এ বসানোর আগে escape করতে হবে।
// (`??` ব্যবহার করা হয়েছে যাতে 0 মানটা খালি string না হয়ে যায়)
// ⚠️ inline onclick="fn('${...}')" এর ভেতরে এটা যথেষ্ট নয় — ওখানে data-* attribute ব্যবহার করো।
// ════════════════════════════════════════════════════════════════
import { escHtml } from '../utils/escape.js';

// FIX (2026-10-25, W4): poster-এর onclick="window.open('...')" ছিল stored
// XSS — escHtml-এর &#39; HTML parser decode করে JS string ভেঙে দিত।
// এখন data-* attribute + একটাই delegated listener; শুধু https URL খুলবে।
let _posterClickBound = false;
if (!_posterClickBound) {
    _posterClickBound = true;
    document.addEventListener('click', (e) => {
        const el = e.target?.closest?.('.result-poster-open');
        if (!el) return;
        const url = el.getAttribute('data-poster-url');
        if (url && /^https:\/\//.test(url)) window.open(url, '_blank');
    });
}

// ════════════════════════════════════════════════════════════════
// PARSE TOURNAMENT RESULTS ARRAY ACCURATELY (results.html?id=<tournamentId>)
// ════════════════════════════════════════════════════════════════
async function openTournamentResults(tournamentId) {
    const container = document.getElementById('published-results-list');
    if (!container) return;
    container.innerHTML = '<div class="empty-state"><div class="spinner"></div><div style="margin-top:10px;">Loading results...</div></div>';
    try {
        const { tourn, resData } = await fetchTournamentResults(tournamentId);
        // ৩. রেজাল্ট পাবলিশ করা আছে কি না যাচাই
        // ✅ নতুন Result flow (2026-10-24): scoreboard publish না থাকলে
        // Result টুলের poster-ই অফিসিয়াল result — থাকলে সেটা দেখাও।
        if (!resData || resData.published !== true) {
            const poster = await fetchResultPoster(tournamentId).catch(() => null);
            if (poster?.imageUrl) {
                container.innerHTML = `
                    <div class="results-board-head">
                        <div class="results-board-title">${escHtml(tourn.name)}</div>
                        <div class="results-board-meta">Official Result Poster</div>
                    </div>
                    <div style="margin-top:12px;" class="result-poster-open" data-poster-url="${escHtml(poster.imageUrl)}">
                        <img src="${escHtml(poster.imageUrl)}" alt="${escHtml(poster.title || 'Result')}" style="width:100%;border-radius:14px;display:block;">
                    </div>
                    <div style="text-align:center;color:var(--text2);font-size:13px;margin-top:10px;">${escHtml(poster.title || '')} — Tap image to view full size</div>`;
                return;
            }
            container.innerHTML = `
                <div class="empty-state">
                    <div class="empty-icon">📢</div>
                    <div class="empty-title">Results Not Published Yet</div>
                    <div class="empty-sub">Admin has not published the official result for "${escHtml(tourn.name)}" yet.</div>
                </div>`;
            return;
        }
        // ৪. রেজাল্ট অ্যারে বের করে নেওয়া (results অথবা players ফিল্ড থেকে)
        let entries = [];
        if (Array.isArray(resData.results)) {
            entries = resData.results;
        } else if (Array.isArray(resData.players)) {
            entries = resData.players;
        }
        if (entries.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <div class="empty-icon">📢</div>
                    <div class="empty-title">Scoreboard Empty</div>
                    <div class="empty-sub">No participant scores recorded for this tournament.</div>
                </div>`;
            return;
        }
        // ৫. Rank অনুযায়ী ক্রমানুসারে সাজানো (Rank #1, #2, #3...)
        entries.sort((a, b) => Number(a.rank || 999) - Number(b.rank || 999));
        const medals = ['🥇', '🥈', '🥉'];
        const isSolo = (tourn.teamFormat || resData.teamFormat) === 'SOLO';
        const isDistributed = resData.prizesDistributed === true;

        const rowsHtml = entries.map(r => {
            const rankNum = Number(r.rank || 0);
            const medal = rankNum <= 3 && rankNum > 0 ? medals[rankNum - 1] : `#${rankNum}`;
            const kills = Number(r.kills || 0);
            const perKill = Number(tourn.perKill || resData.perKill || 0);
            const killReward = Number(r.killReward !== undefined ? r.killReward : (kills * perKill));
            const rankPrize = Number(r.rankPrize || 0);
            const totalPrize = Number(r.totalPrize !== undefined ? r.totalPrize : (killReward + rankPrize));

            // v6: highlight the logged-in user's own team/row (match by FF UID).
            const myFfUID = String(state.userData?.ffUID || '').trim();
            const rowUids = [];
            if (r.ffUID) rowUids.push(String(r.ffUID).trim());
            if (Array.isArray(r.players)) r.players.forEach(p => { if (p?.ffUID) rowUids.push(String(p.ffUID).trim()); });
            const isMe = myFfUID !== '' && rowUids.includes(myFfUID);

            // Duo বা Squad হলে প্লেয়ারদের নাম ও Gaming UID শো করা
            let playerDetailsHtml = '';
            if (!isSolo && Array.isArray(r.players) && r.players.length > 0) {
                playerDetailsHtml = `
                    <div class="results-player-sub">
                        ${r.players.map(p => `<span>${escHtml(p.playerName || 'Player')} (UID: ${escHtml(p.ffUID || '—')})</span>`).join(' · ')}
                    </div>`;
            } else if (r.ffUID) {
                playerDetailsHtml = `<div class="results-player-sub" style="font-family:monospace;">Gaming UID: ${escHtml(r.ffUID)}</div>`;
            }

            return `
                <div class="results-row${isMe ? ' me' : ''}">
                    <div class="results-row-top">
                        <div style="display:flex; align-items:center; gap:10px;">
                            <div class="results-rank">${medal}</div>
                            <div>
                                <div class="results-player">${escHtml(r.teamName || r.playerName || r.userName || 'Player')}${isMe ? ' <span class="you-tag">YOU</span>' : ''}</div>
                                ${playerDetailsHtml}
                            </div>
                        </div>
                        <div class="results-prize">
                            <div class="results-prize-amt">₹${totalPrize.toLocaleString()}</div>
                            <div class="results-prize-kills">${kills} Kills (+₹${killReward})</div>
                        </div>
                    </div>
                    <div class="results-row-foot">
                        <span>Rank Prize: ₹${rankPrize}</span>
                        <span>Kill Reward: ₹${killReward}</span>
                        <span style="color:${isDistributed ? 'var(--success)' : 'var(--warning)'}; font-weight:700;">${isDistributed ? 'Prize Credited ✅' : 'Verified (Pending Payout)'}</span>
                    </div>
                </div>`;
        }).join('');

        container.innerHTML = `
            <div class="results-board-head">
                <div class="results-board-title">${escHtml(tourn.name)}</div>
                <div class="results-board-meta">
                    ${escHtml(tourn.teamFormat)} · ${escHtml(tourn.gameMode)} · Map: ${escHtml(tourn.map)}
                </div>
                ${!isSolo ? `<div class="results-team-note">👑 Prize belongs to the team and is credited to the Team Captain's wallet.</div>` : ''}
            </div>
            ${rowsHtml}`;
    } catch (err) {
        console.error('openTournamentResults error:', err);
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">⚠️</div>
                <div class="empty-title">Failed to load results</div>
                <div class="empty-sub">${escHtml(err.message)}</div>
            </div>`;
    }
}

// ════════════════════════════════════════════════════════════════
// Global Published Results (from Profile) — results.html without ?id
// ════════════════════════════════════════════════════════════════
async function openPublishedResults() {
    const container = document.getElementById('published-results-list');
    if (!container) return;
    container.innerHTML = '<div class="empty-state"><div class="spinner"></div></div>';
    try {
        // Fetch completed tournaments that have published results
        const tournList = await fetchCompletedTournaments();
        if (tournList.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <div class="empty-icon">📢</div>
                    <div class="empty-title">No Completed Tournaments</div>
                    <div class="empty-sub">Results will appear here once tournaments are completed</div>
                </div>`;
            return;
        }
        // ✅ নতুন Result flow (2026-10-24): সবার উপরে Result Poster
        // section — admin-এর Result টুল থেকে আপলোড করা poster-গুলো।
        let posterHtml = '';
        try {
            const posters = await fetchResultPosts();
            if (posters.length) {
                posterHtml = `
                    <div class="results-pick-label">🖼️ Official Result Posters</div>
                    ${posters.map(po => `
                        <div class="results-tourn-card result-poster-open" data-poster-url="${escHtml(po.imageUrl)}">
                            <div>
                                <div class="results-tourn-name">${escHtml(po.title || 'Result')}</div>
                                <div class="results-tourn-meta">🏆 ${escHtml(po.tournamentName || '')}</div>
                            </div>
                            <span style="font-size:20px;">🖼️</span>
                        </div>`).join('')}
                    <div class="results-pick-label" style="margin-top:18px;">Select a tournament to view official results:</div>`;
            }
        } catch (e) { /* poster section না থাকলে list-ই দেখাবে */ }
        container.innerHTML = `
            ${posterHtml || '<div class="results-pick-label">Select a tournament to view official results:</div>'}
            ${tournList.map(t => `
                <div class="results-tourn-card">
                    <div>
                        <div class="results-tourn-name">${escHtml(t.name)}</div>
                        <div class="results-tourn-meta">${escHtml(t.teamFormat)} · ${t.dateObj ? formatDateOnly(t.dateObj) : ''}</div>
                    </div>
                    <button class="btn btn-primary btn-sm" data-id="${escHtml(t.id)}" onclick="openTournamentResults(this.dataset.id)">View Results 🏆</button>
                </div>
            `).join('')}`;
    } catch (err) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">⚠️</div>
                <div class="empty-title">Failed to load</div>
                <div class="empty-sub">${escHtml(err.message)}</div>
            </div>`;
    }
}

// List → tournament scoreboard (opens results.html?id=…; back button returns via history)
// (openTournamentResults now centralized in navigation.js)
initPage({
    page: 'results',
    onReady: () => {
        const id = getParam('id');
        if (id) openTournamentResults(id);
        else openPublishedResults();
    }
});