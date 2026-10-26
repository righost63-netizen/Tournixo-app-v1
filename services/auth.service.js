import {
    auth,
    db,
    signInWithEmailAndPassword,
    createUserWithEmailAndPassword,
    signOut,
    sendPasswordResetEmail,
    sendEmailVerification,
    reload,
    doc,
    getDoc,
    setDoc,
    runTransaction,
    serverTimestamp
} from '../firebase/firebase-init.js';
import { state } from '../scripts/state.js';
import { oneSignalLogout } from './onesignal.service.js';
import { clearSessionUser } from '../scripts/cache.js';
import { resetGlobalPopupListener } from './notifications.service.js';

export async function loginWithEmail(email, pass) {
    const cred = await signInWithEmailAndPassword(auth, email, pass);
    await reload(cred.user);
    if (!cred.user.emailVerified) {
        await signOut(auth);
        const error = new Error('Please verify your email before signing in. Check your inbox for the verification link.');
        error.code = 'auth/email-not-verified';
        throw error;
    }
    return cred;
}

export function sendResetEmail(email) {
    return sendPasswordResetEmail(auth, email);
}

export async function registerUser({ name, ffUID, email, pass }) {
    state.registering = true;
    let createdUser = null;
    let profileCommitted = false;
    try {
        const cred = await createUserWithEmailAndPassword(auth, email, pass);
        createdUser = cred.user;

        // FIX (#10, AUD-018) — two phases instead of one transaction:
        // Phase 1 writes the profile doc FIRST. Phase 2 then claims the
        // Free Fire UID in registeredUIDs, and the security rule for that
        // claim cross-checks (via get()) that the caller's OWN profile doc
        // carries this exact ffUID. Under the old single transaction a
        // squatter could claim ANY FF UID directly — the claim never had
        // to match an existing profile — so they could pre-register other
        // players' UIDs and block the real owners from signing up. Now a
        // claim for a UID that is not your own profile UID is denied by
        // the rules themselves.
        await setDoc(doc(db, 'users', cred.user.uid), {
            uid: cred.user.uid,
            name,
            ffUID,
            email,
            walletBalance: 0,
            totalWins: 0,
            totalEarnings: 0,
            joinedTournaments: [],
            termsAcceptedAt: serverTimestamp(), // consent record (checkbox on register page)
            createdAt: serverTimestamp()
        });

        await runTransaction(db, async (transaction) => {
            const uidDocRef = doc(db, 'registeredUIDs', ffUID);
            const uidSnap = await transaction.get(uidDocRef);

            if (uidSnap.exists()) {
                throw new Error('This Free Fire UID is already registered to another account!');
            }

            transaction.set(uidDocRef, {
                userId: cred.user.uid,
                email,
                registeredAt: serverTimestamp()
            });
        });

        // Send Firebase's built-in verification link after the profile is created.
        // FIX (2026-10-25): continueUrl দেওয়া হলো — email-এর link-এ click
        // করলে Firebase verify করে Tournixo login page-এ ফেরত পাঠাবে।
        // আগে continueUrl না থাকায় user Firebase-এর default page-এ আটকে
        // যেত, app-এ ফিরে login খুঁজতে হতো। এই URL Firebase Console-এর
        // Authorized domains-এ থাকতে হবে; live domain আলাদা হলে শুধু
        // এই একটা URL বদলালেই হবে।
        profileCommitted = true;
        await sendEmailVerification(cred.user, {
            url: 'https://tournixo.netlify.app/pages/login.html',
            handleCodeInApp: false
        });
        await signOut(auth); // Keep unverified users outside the authenticated app.
        return { email: cred.user.email };
    } catch (e) {
        // Delete the auth user ONLY if registration never committed.
        // If the profile + UID claim exist (e.g. only the verification email
        // failed to send), the user can still verify later via "Resend
        // verification email" — deleting here would orphan the Firestore
        // profile and permanently block the Free Fire UID in registeredUIDs.
        // If phase 2 failed (FF UID already claimed), the auth user is
        // deleted; the phase-1 profile doc is left orphaned under a uid
        // Firebase will never reuse, and the UID claim was never written.
        if (createdUser && !profileCommitted) {
            await createdUser.delete().catch(() => {});
        }
        throw e;
    } finally {
        state.registering = false;
    }
}

// Re-sends the verification email for an account that has not verified yet.
// The user is signed out after login fails, so we briefly sign in with the
// credentials they typed, send the link, and sign out again.
// state.registering = true makes the auth listener in app.js ignore this
// temporary session (same technique registerUser uses).
export async function resendVerificationEmail(email, pass) {
    state.registering = true;
    try {
        const cred = await signInWithEmailAndPassword(auth, email, pass);
        await reload(cred.user);
        if (cred.user.emailVerified) {
            const error = new Error('Your email is already verified. You can sign in now.');
            error.code = 'auth/email-already-verified';
            throw error;
        }
        // FIX (2026-10-25): resend-এও একই continueUrl — verify-র পর
        // user Tournixo login page-এ ফিরবে, Firebase-এর default
        // page-এ আটকাবে না।
        await sendEmailVerification(cred.user, {
            url: 'https://tournixo.netlify.app/pages/login.html',
            handleCodeInApp: false
        });
    } finally {
        await signOut(auth).catch(() => {});
        state.registering = false;
    }
}

export async function logoutUser() {
    state.notifListenerActive = false;
    resetGlobalPopupListener(); // FIX (2026-10-25, W8): দেখো notifications.service.js
    state.joinRequestCache = null;
    state.leaderboardCache = null;
    state.modeChipsLoaded = false;

    if (Array.isArray(state.listeners)) {
        state.listeners.forEach(unsub => {
            try { if (typeof unsub === 'function') unsub(); } catch (e) {}
        });
        state.listeners = [];
    }

    oneSignalLogout();
    const uid = state.currentUser?.uid;
    await signOut(auth);
    if (uid) clearSessionUser(uid);
    try { sessionStorage.removeItem('ff_ev_ok_v1'); } catch (e) {}
    state.currentUser = null;
    state.userData = null;
}

export async function refreshUserData(forceRefresh = false) {
    const uid = state.currentUser?.uid;
    if (!uid) return null;

    const cached = state.userData;
    const cachedAt = Number(state.userDataCacheAt || 0);
    const USER_CACHE_TTL = 30 * 1000;

    // Non-critical UI profile data may use a very short session cache.
    // Critical actions must continue to read authoritative Firestore data.
    if (!forceRefresh && cached && (Date.now() - cachedAt) < USER_CACHE_TTL) {
        if (typeof window.refreshUserUI === 'function') window.refreshUserUI();
        return cached;
    }

    try {
        const snap = await getDoc(doc(db, 'users', uid));
        if (snap.exists() && state.currentUser) {
            state.userData = snap.data();
            state.userDataCacheAt = Date.now();
            if (typeof window.refreshUserUI === 'function') window.refreshUserUI();
        }
        return state.userData || null;
    } catch (e) {
        console.warn('refreshUserData failed:', e.message);
        return state.userData || null;
    }
}

window.refreshUserData = refreshUserData;
