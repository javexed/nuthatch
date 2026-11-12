# The phone app

The interface, built as an app (`pnpm --dir ../web build:app`) and
wrapped with [Capacitor](https://capacitorjs.com/) (MIT). The app asks
which nuthatch server to talk to, logs in there for a token of its own,
and keeps the server's address and the token on the device.

**Android: built and tried in an emulator.** `mobile/test-emulator` builds
the debug app, starts an Android 15 emulator without a window, installs
the app, and drives its web view: the app logs in at a nuthatch server
for a token, shows the overview, acknowledges a problem (the engine is
asked whether it has it), and logs out, which deletes the token. The
debug app was also installed on one real phone (Android 17) over USB,
where it logged in and showed the overview. A release build compiles,
unsigned, and has not been run.

**iOS: no project.** Making and building one needs a Mac.

## Building it

Android, with a JDK and the Android SDK (Android Studio brings both):

    pnpm install
    pnpm sync                    # builds the interface as the app and copies it in
    pnpm exec cap open android   # or: cd android && ./gradlew assembleDebug

iOS, on a Mac with Xcode and CocoaPods:

    pnpm exec cap add ios
    pnpm sync
    pnpm exec cap open ios

## Before it goes to a store

- `appId` in `capacitor.config.json` is a placeholder
  (`org.example.nuthatch`). It must be a name under a domain you own, and
  is fixed once the app is published.
- Icons and a splash screen: none yet.
- The token is kept in the web view's storage. The device's keystore
  would be the better place; that needs a plugin.
- Push notifications are not done: they need a sender on the server's
  side that Apple's and Google's services accept.

## What the server needs

The app's pages come from the device, which is another origin to the
server than the server's own pages. The server lets an origin call it
when it is listed:

    app_origins = ["https://localhost", "capacitor://localhost"]

(`https://localhost` is Capacitor's origin on Android, `capacitor://localhost`
on iOS.) The server must be reached over `https://`: a phone's web view
does not talk plain HTTP.

## Tested

- `mobile/test-emulator`: the app in an Android emulator, as above. It
  needs a JDK (`JAVA_HOME`), the Android SDK (`ANDROID_HOME`) with the
  platform, build tools, emulator and system image the script names, KVM,
  and `dev/up naemon` and `dev/up checkd` running. A debug build lets
  plain HTTP through, so that the emulator can reach a server on the
  machine it runs on; a release build does not.
- `web/e2e/app.spec.ts`: the same app build in a browser, served from an
  origin of its own against a server elsewhere.
