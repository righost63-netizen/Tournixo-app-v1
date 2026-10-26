import { initPage } from './app.js';
import { state } from './state.js';
import { showToast } from './toast.js';
import { getParam } from '../config/app-config.js';
import { getMyTeam, saveMyTeam as saveTeamDoc, deleteMyTeam as deleteTeamDoc, validateTeamInput } from '../services/team.service.js';

// ─────────────────────────────────────────────
// FORM READ
// ─────────────────────────────────────────────
function readTeamForm() {
    const v = id => document.getElementById(id)?.value.trim() || '';
    return {
        teamName: v('team-name-input'),
        members: [
            { name: v('team-m1-name'), ffUID: v('team-m1-uid') },
            { name: v('team-m2-name'), ffUID: v('team-m2-uid') },
            { name: v('team-m3-name'), ffUID: v('team-m3-uid') }
        ]
    };
}

// ─────────────────────────────────────────────
// LOCK / UNLOCK FORM
// ─────────────────────────────────────────────
function setFormLocked(locked) {
    const ids = [
        'team-name-input',
        'team-m1-name', 'team-m1-uid',
        'team-m2-name', 'team-m2-uid',
        'team-m3-name', 'team-m3-uid'
    ];
    ids.forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.readOnly = locked;
        el.style.opacity = locked ? '0.6' : '1';
        el.style.cursor  = locked ? 'not-allowed' : '';
    });

    const saveBtn   = document.getElementById('team-save-btn');
    const deleteBtn = document.getElementById('team-delete-btn');
    const lockedNote = document.getElementById('team-locked-note');

    if (saveBtn)    saveBtn.style.display   = locked ? 'none' : 'block';
    if (deleteBtn)  deleteBtn.style.display = locked ? 'block' : 'none';
    if (lockedNote) lockedNote.style.display = locked ? 'flex' : 'none';
}

// ─────────────────────────────────────────────
// FILL FORM
// ─────────────────────────────────────────────
function fillTeamForm(team) {
    const set = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.value = val || '';
    };
    const status = document.getElementById('team-status');

    if (!team) {
        set('team-name-input', '');
        set('team-m1-name', ''); set('team-m1-uid', '');
        set('team-m2-name', ''); set('team-m2-uid', '');
        set('team-m3-name', ''); set('team-m3-uid', '');
        if (status) status.textContent = 'No team yet — DUO/SQUAD join করতে আগে এখানে team বানাও।';
        setFormLocked(false);
        return;
    }

    set('team-name-input', team.teamName);
    const m = team.members || [];
    set('team-m1-name', m[0]?.name); set('team-m1-uid', m[0]?.ffUID);
    set('team-m2-name', m[1]?.name); set('team-m2-uid', m[1]?.ffUID);
    set('team-m3-name', m[2]?.name); set('team-m3-uid', m[2]?.ffUID);

    const ready = m.length >= 3
        ? '✅ Squad-ready'
        : m.length >= 1
            ? '✅ Duo-ready'
            : 'Mate যোগ করো';

    if (status) status.textContent = `${team.teamName} — ${ready}`;

    // Team আছে → form lock করো
    setFormLocked(true);
}

// ─────────────────────────────────────────────
// LOAD
// ─────────────────────────────────────────────
async function loadMyTeamPage() {
    const uid = state.currentUser?.uid;
    if (!uid) return;
    fillTeamForm(await getMyTeam(uid));

    const teamNeed = getParam('team');
    if (teamNeed) {
        showToast(
            teamNeed === 'squad'
                ? 'SQUAD join-এর আগে 3 জন teammate-সহ team বানাও।'
                : 'DUO join-এর আগে Mate 1-সহ team বানাও।',
            'warning', 4500
        );
    }
}

// ─────────────────────────────────────────────
// SAVE
// ─────────────────────────────────────────────
async function saveMyTeam() {
    const uid   = state.currentUser?.uid;
    const uData = state.userData || {};
    if (!uid) { showToast('Please sign in first', 'error'); return; }

    const { teamName, members } = readTeamForm();
    const err = validateTeamInput(teamName, members, uData.ffUID);
    if (err) { showToast(err, 'warning', 4000); return; }

    const btn = document.getElementById('team-save-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

    try {
        await saveTeamDoc(uid, { name: uData.name || '', ffUID: uData.ffUID || '' }, teamName, members);
        showToast('Team saved ✅ — এখন DUO/SQUAD join করতে পারবে।', 'success', 3500);
        fillTeamForm(await getMyTeam(uid));
    } catch (e) {
        showToast('Could not save team: ' + e.message, 'error', 4500);
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Save Team'; }
    }
}

// ─────────────────────────────────────────────
// DELETE
// ─────────────────────────────────────────────
async function deleteMyTeam() {
    const uid = state.currentUser?.uid;
    if (!uid) return;

    const doDelete = async () => {
        try {
            await deleteTeamDoc(uid);
            fillTeamForm(null);
            showToast('Team deleted. নতুন team বানাও।', 'info', 3500);
        } catch (e) {
            showToast('Could not delete team: ' + e.message, 'error', 4000);
        }
    };

    if (typeof window.showConfirm === 'function') {
        window.showConfirm(
            'Delete Team?',
            'Team delete করলে নতুন করে বানাতে হবে। Edit করার option নেই।',
            doDelete
        );
    } else {
        await doDelete();
    }
}

window.saveMyTeam   = saveMyTeam;
window.deleteMyTeam = deleteMyTeam;

initPage({
    page: 'myTeam',
    onReady: () => loadMyTeamPage()
});