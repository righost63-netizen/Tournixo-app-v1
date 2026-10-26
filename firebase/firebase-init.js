// ════════════════════════════════════════════════════════════════
// Single Firebase entry point. Every other file imports Firebase
// functions from HERE (never directly from gstatic), so the app is
// initialized exactly once per page.
// ════════════════════════════════════════════════════════════════
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
    initializeFirestore,
    getFirestore,
    persistentLocalCache,
    persistentMultipleTabManager
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

// Offline persistence (IndexedDB) — same as the original.
// NOTE: the original used persistentSingleTabManager (one page). Now that the
// app is multi-page, the multiple-tab manager is used so moving from one page
// to the next never fights over the IndexedDB lock. Cache behavior is unchanged.
// Falls back to plain in-memory Firestore if IndexedDB is unavailable.
let db;
try {
    db = initializeFirestore(app, {
        localCache: persistentLocalCache({
            tabManager: persistentMultipleTabManager()
        })
    });
} catch (e) {
    console.warn('[Firestore] Offline persistence unavailable, using default cache:', e.message);
    // initializeFirestore() must not be called twice on the same app (it throws
    // "already initialized"). getFirestore() reuses the existing instance, or
    // creates a default in-memory one if none was registered yet.
    db = getFirestore(app);
}

export { app, auth, db };

// ── Auth functions used by the app ──
export {
    createUserWithEmailAndPassword,
    signInWithEmailAndPassword,
    signOut,
    sendPasswordResetEmail,
    sendEmailVerification,
    reload,
    onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

// ── Firestore functions used by the app ──
// FIX (2026-10-25, Backend Failure Dialog): network-এ যাওয়া function-গুলো
// wrapper দিয়ে export হবে — প্রতিটা error/success backend-failure.js-এ
// report হবে, যাতে polling ছাড়াই quota/outage ধরা যায়। Wrapper-গুলো
// args/return/error হুবহু এক রাখে — শুধু report করে, কিছু বদলায় না।
// (doc/collection/query/where/orderBy/limit/startAfter/serverTimestamp/
// increment/arrayUnion/arrayRemove/documentId network-এ যায় না, তাই
// সরাসরি re-export।)
import {
    doc as _doc,
    setDoc as _setDoc,
    getDoc as _getDoc,
    updateDoc as _updateDoc,
    collection as _collection,
    query as _query,
    where as _where,
    orderBy as _orderBy,
    limit as _limit,
    getDocs as _getDocs,
    onSnapshot as _onSnapshot,
    addDoc as _addDoc,
    deleteDoc as _deleteDoc,
    serverTimestamp as _serverTimestamp,
    increment as _increment,
    arrayUnion as _arrayUnion,
    arrayRemove as _arrayRemove,
    startAfter as _startAfter,
    runTransaction as _runTransaction,
    documentId as _documentId
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { reportFirebaseError, reportFirebaseSuccess } from "../scripts/backend-failure.js";

export const doc = _doc;
export const collection = _collection;
export const query = _query;
export const where = _where;
export const orderBy = _orderBy;
export const limit = _limit;
export const serverTimestamp = _serverTimestamp;
export const increment = _increment;
export const arrayUnion = _arrayUnion;
// FIX (2026-10-25, F-01): patch1-এর join-tournament.js arrayRemove import
// করে, কিন্তু এই export list-এ arrayRemove ছিল না — ES module link-time
// failure-এ Join form একদমই খুলত না (navigation-এর catch শুধু toast দেখাত)।
// এই এক লাইন ছাড়া join/paid-join দুটোই অচল ছিল। আগের patch zip-এ এই
// ফাইলটি ছিল না বলে deployed app-এও bug-টি ছিল।
export const arrayRemove = _arrayRemove;
// FIX (2026-10-25, F-03): tournaments Load More-এর জন্য startAfter।
export const startAfter = _startAfter;
export const documentId = _documentId;

export async function getDoc(...args) {
    try {
        const snap = await _getDoc(...args);
        reportFirebaseSuccess(snap);
        return snap;
    } catch (e) {
        reportFirebaseError(e);
        throw e;
    }
}

export async function getDocs(...args) {
    try {
        const snap = await _getDocs(...args);
        reportFirebaseSuccess(snap);
        return snap;
    } catch (e) {
        reportFirebaseError(e);
        throw e;
    }
}

// runTransaction success = আসল server roundtrip (offline-এ txn fail করে),
// তাই এটা recovery signal। ভেতরের retry SDK-ই সামলায়, wrapper নয়।
export async function runTransaction(...args) {
    try {
        const result = await _runTransaction(...args);
        reportFirebaseSuccess(result);
        return result;
    } catch (e) {
        reportFirebaseError(e);
        throw e;
    }
}

// লেখা (set/update/add/delete): success offline-এও local resolve হতে পারে,
// তাই success recovery নয় — শুধু error report হবে (quota/unavailable-এর
// মতো আসল signal-এর জন্য)।
async function wrapWrite(fn, args) {
    try {
        return await fn(...args);
    } catch (e) {
        reportFirebaseError(e);
        throw e;
    }
}
export function setDoc(...args) { return wrapWrite(_setDoc, args); }
export function updateDoc(...args) { return wrapWrite(_updateDoc, args); }
export function addDoc(...args) { return wrapWrite(_addDoc, args); }
export function deleteDoc(...args) { return wrapWrite(_deleteDoc, args); }

// onSnapshot: next callback-এর fromCache=false snapshot recovery signal;
// error callback থাকলে সেটাও report হবে। error callback না থাকলে কিছু
// যোগ করা হবে না (আগের আচরণ বদলাবে না)।
export function onSnapshot(...args) {
    const a = [...args];
    const isObserver = a[1] && typeof a[1] === 'object'
        && (typeof a[1].next === 'function' || typeof a[1].error === 'function');
    if (isObserver) {
        const obs = a[1];
        a[1] = {
            ...obs,
            next: obs.next ? (snap) => { reportFirebaseSuccess(snap); obs.next(snap); } : undefined,
            error: obs.error ? (e) => { reportFirebaseError(e); obs.error(e); } : undefined
        };
    } else if (a[1] && typeof a[1] === 'object' && typeof a[2] === 'function') {
        // (target, options, onNext, onError?) form
        const origNext = a[2];
        a[2] = (snap) => { reportFirebaseSuccess(snap); origNext(snap); };
        if (typeof a[3] === 'function') {
            const origErr = a[3];
            a[3] = (e) => { reportFirebaseError(e); origErr(e); };
        }
    } else {
        // (target, onNext, onError?) form
        if (typeof a[1] === 'function') {
            const origNext = a[1];
            a[1] = (snap) => { reportFirebaseSuccess(snap); origNext(snap); };
        }
        if (typeof a[2] === 'function') {
            const origErr = a[2];
            a[2] = (e) => { reportFirebaseError(e); origErr(e); };
        }
    }
    return _onSnapshot(...a);
}