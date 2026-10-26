# Tournixo v8.0 — Capacitor APK Guide (user builds the APK himself)

This zip is the web app itself. There is NO build step: the folder that
contains index.html at its root IS the Capacitor webDir.

## 1. Bundle it (do NOT point the APK at Netlify)

Unzip to a folder, e.g. `tournixo-app/`, then in that folder:

```
npm init -y
npm install @capacitor/core @capacitor/cli
npx cap init Tournixo app.tournixo.app --web-dir=.
npx cap add android
npx cap sync android
```

Then open Android Studio (`npx cap open android`) and Run / Build APK.
Why bundled, not `server.url: https://tournixo.netlify.app`?
- With `server.url` the APK is just a WebView of the website: the service
  worker and OneSignal WEB push do not work reliably, and offline the app
  is blank. Bundled files + Firebase (cloud) still work fully, because
  Auth/Firestore are HTTPS APIs, not a local server.
- The TWA files in this zip (`.well-known/assetlinks.json`,
  `twa-manifest.json`, `.github/workflows/build-apk.yml`) are for the OLD
  TWA route. For Capacitor, ignore them — do not run the TWA workflow.

## 2. Push in the APK is NOT the website push

In this web bundle, Profile → Notifications on a Capacitor native app
deliberately does NOT load the OneSignal web SDK (see
`services/onesignal.service.js` → `isCapacitorNative()`). The toggle only
saves the local preference and tells you native push needs its own setup.
For real push inside the APK, add natively (Android Studio / Capacitor
project, not this zip):

- `@capacitor/push-notifications` + Firebase Cloud Messaging (google-services.json), OR
- OneSignal's native Android SDK with the same App ID
  `1d0c2af9-4033-4585-b1bd-198b02675a14`.

Do not expect the website's "Notifications allowed, push failed" popup to
appear in the APK — that popup is website-only, by design, after v8.0.

## 3. Website push still needs this (Netlify users)

- Deploy this zip to Netlify (same site as before).
- OneSignal Dashboard → Tournixo app → Settings → Site URL must be
  exactly `https://tournixo.netlify.app` (the live origin, not localhost).
- After deploy, on the phone: clear site data / hard refresh once (the
  service-worker cache name changed to `tournixo-user-v8-0-2026-10-25`).
- Then Profile → Notifications ON: on a slow connection it now waits up
  to 10 seconds for the SDK (was 2.5s), and if the SDK still cannot load
  the toggle goes back OFF so you can tap again to retry — it no longer
  sticks ON while remote push is actually down.
- In-app Notifications (the bell / Notifications page) are Firestore-based
  and keep working even when remote push is down.
