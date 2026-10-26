import { initPage, refreshUserUI } from './app.js';
import './auth-ui.js'; // provides window.confirmLogout (auth-ui only starts a page on login/register)
import { syncNotifToggleUI } from '../services/onesignal.service.js';
import { state } from './state.js';
import { getMyTeam } from '../services/team.service.js';

// v8.1: My Team আর Profile-এর ভেতরে inline form নয় — Profile-এ শুধু
// "My Team" option row থাকে, tap করলে pages/my-team.html খোলে।

async function loadProfile() {
    refreshUserUI();
    syncNotifToggleUI();
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) syncNotifToggleUI();
    });
    const uid = state.currentUser?.uid;
    const sub = document.getElementById('team-row-sub');
    if (uid && sub) {
        const team = await getMyTeam(uid);
        if (!team) sub.textContent = 'No team yet — DUO/SQUAD join করতে আগে team বানাও।';
        else {
            const n = (team.members || []).length;
            sub.textContent = `${team.teamName} • ${n >= 3 ? 'Squad-ready (3 mates)' : n >= 1 ? 'Duo-ready (Mate 1 আছে)' : 'Teammate যোগ করো'}`;
        }
    }
}

initPage({
    page: 'profile',
    tab: 'profile',
    onReady: () => {
        loadProfile();
    }
});
