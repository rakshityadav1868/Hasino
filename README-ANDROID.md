# Hasino on Android

The APK is a Capacitor shell around the **deployed** Hasino web app. It is not a
second implementation and not a copy of the assets: the WebView loads
`HASINO_APP_URL` over HTTPS, so the running app is the same code, on the same
origin, talking to the same API as a desktop browser.

That is the whole reason for this shape. Bundling the web assets into the APK
would put the WebView on `http://localhost`, which breaks every relative
`/api/*` call, needs CORS opened for the app origin, and moves Clerk onto an
origin its OAuth redirect knows nothing about. Loading the real site avoids all
three, and Clerk needs no mobile-specific configuration.

The admin panel cannot appear here. The deployed server has no `/admin` route,
no admin asset and no `/api/admin/*` — the panel is a separate process bound to
loopback on the operator's own machine (`src/http/admin-server.ts`). There is
nothing to exclude because there is nothing to include.

## The toolchain (already installed)

Both are in place on this machine. Android Studio is deliberately **not** used:
the command-line tools do the same job headlessly, with no setup wizard and
about a tenth of the download.

| | |
|---|---|
| JDK 21 | `/opt/homebrew/opt/openjdk@21` — `brew install openjdk@21` |
| Android SDK | `~/Library/Android/sdk` — `brew install --cask android-commandlinetools` |
| Packages | `platform-tools`, `platforms;android-36`, `build-tools;36.0.0` |

JDK 21 came from the **formula**, not the `temurin` cask: the formula installs
into the Homebrew prefix with no `sudo`, and leaves the system Java alone. The
Android Gradle Plugin supports 17 and 21; on the JDK 25 that was already here,
Gradle fails outright with `Unsupported class file major version 69`.

Add these to `~/.zshrc` so a new terminal can build:

```bash
export JAVA_HOME=/opt/homebrew/opt/openjdk@21
export ANDROID_HOME="$HOME/Library/Android/sdk"
export PATH="$ANDROID_HOME/platform-tools:$PATH"
```

**What is still missing is a deployed Hasino.** There is a `Dockerfile`; any
host that runs it works. The APK needs the public HTTPS URL, and it must be
HTTPS — Android blocks cleartext traffic and Google sign-in will not run on an
insecure origin.

## Building the APK

```bash
export JAVA_HOME=/opt/homebrew/opt/openjdk@21
export ANDROID_HOME="$HOME/Library/Android/sdk"
export HASINO_APP_URL=https://your-deployment      # your real URL

npx cap sync android
cd android && ./gradlew assembleDebug
```

The APK lands at:

```
android/app/build/outputs/apk/debug/app-debug.apk
```

Install it on a phone plugged in over USB with debugging enabled:

```bash
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

`capacitor.config.ts` refuses to build without `HASINO_APP_URL`, and refuses a
non-HTTPS one. A localhost default would produce an APK that works on the
laptop that built it and nowhere else — and an emulator would make that look
fine right up until you installed it on a phone.

## Google sign-in stays inside the app

Sign-in is **native**. Android's Credential Manager draws the Google account
sheet over the WebView, hands back a signed Google ID token, and the web layer
exchanges that token with Clerk in the same WebView. No browser opens, nothing
navigates away, and there is no return trip to catch.

| | |
|---|---|
| `GoogleAuthPlugin.java` | asks Credential Manager for a Google ID token |
| `MainActivity.java` | registers the plugin before the bridge starts, so the page can call it on first paint |
| `signInWithGoogle()` in `lib/auth.js` | inside the app takes the native path and **only** the native path |

Inside the app there is deliberately no fallback to the browser redirect. Chrome
cannot hand a session back: it signs the user in against its own cookie jar
while the WebView, which has its own storage, still shows a sign-in button.
That failure looks like success to the person holding the phone, so a missing
bridge or a missing client id is reported as an error instead.

### What you must configure — all four, or Android sign-in does not work

The APK is only one of the four. Three of these are console settings, and the
app cannot supply them for you.

**1. Google Cloud — two OAuth clients in the same project**
   (APIs & Services → Credentials)

   - a **Web application** client. Its client id is the audience the token is
     minted for, and the one Clerk verifies against.
   - an **Android** client, for package `com.hasino.app` and the SHA-1 of the
     certificate the APK you install was signed with. Credential Manager
     refuses to issue a token without it.

     ```bash
     $ANDROID_HOME/build-tools/36.0.0/apksigner verify --print-certs \
       android/app/build/outputs/apk/debug/app-debug.apk
     ```

     Debug and release APKs have different certificates. Register both, or
     register the one you are actually installing.

**2. Clerk — your own Google credentials, not Clerk's shared ones**
   (User & Authentication → Social Connections → Google → *Use custom
   credentials*)

   Paste the **Web** client id and secret from step 1. This is the step that is
   easy to skip and impossible to work around: a development instance using
   Clerk's shared Google credentials has no client id of its own to check a
   native token against, so `authenticateWithGoogleOneTap` is rejected however
   correct the token is. You can confirm which state an instance is in:

   ```bash
   curl -s "https://<your-instance>.clerk.accounts.dev/v1/environment?__clerk_api_version=2025-04-10&_clerk_js_version=6.27.1&__clerk_db_jwt=$TOKEN" \
     | jq .display_config.google_one_tap_client_id
   ```

   `null` means custom credentials are not set and native sign-in cannot work.

**3. The server — `GOOGLE_WEB_CLIENT_ID`**

   The same Web client id from step 1, set on the deployment (it is in
   `render.yaml` as a `sync: false` key you type in the dashboard). The app
   reads it from `GET /api/config`; unset, that reports `googleClientId: null`
   and the app refuses to open a sheet that cannot succeed. Check it from
   anywhere:

   ```bash
   curl -s https://<host>/api/config | jq .googleClientId
   ```

**4. The APK — rebuilt and reinstalled**

   Sign-in went native in commit `731ebea`. Any APK built before that still
   contains the old browser redirect, and no amount of server or Clerk
   configuration changes what is already compiled into it. If sign-in leaves
   for Chrome, this is the first thing to rule out.

### The deep link that is still there

`AndroidManifest.xml` still claims `https://<host>/sso-callback` as an App Link,
and the server still serves `/.well-known/assetlinks.json` from
`ANDROID_CERT_FINGERPRINTS`. The app's own sign-in no longer uses either. They
are kept so a callback arriving from outside — an email link, a web sign-in on
a device that has the app — lands in the app rather than the browser.

If you keep them, the fingerprint has to be the SHA-256 of the APK you actually
installed, or the link quietly opens in Chrome:

```bash
adb shell pm get-app-links com.hasino.app     # want: verified
```

## The admin panel on Android

Optional, and off unless both halves are set. `ADMIN_PANEL_URL` on the server
sends a signed-in admin to the hosted panel; `HASINO_ADMIN_URL` at sync time
adds that host to `allowNavigation` so the app opens it instead of handing it
to Chrome. They are the same URL. Set neither and an admin stays in the
customer app, which is the previous behaviour exactly.

The panel signs in on its own origin — a Clerk session belongs to one origin,
so this is a fresh sign-in, not a continuation.

## Location

`ACCESS_COARSE_LOCATION` and `ACCESS_FINE_LOCATION` are declared in the
manifest. Declaring is not granting: Android asks the first time the page calls
`navigator.geolocation`, which happens when the customer taps **Use my current
location** and nowhere else. Nothing requests location at launch.

Both are listed because the app wants a city name, not a doorstep — a customer
who grants only approximate location still gets a working salon search.

## What is in the repo

| Path | |
|---|---|
| `capacitor.config.ts` | app id, name, and the URL guard |
| `mobile/www/index.html` | offline fallback — shown only when the site is unreachable |
| `android/` | generated Android project |
| `android/app/src/main/res/mipmap-*` | launcher icons, generated from `brand.css` |
| `android/app/src/main/res/drawable/splash.png` | splash |

The project has no image assets — the logo is a CSS wordmark — so the icons are
drawn from the brand purple (`--brand: #9b8ae8`), the app background
(`#0b0a0f`) and the wordmark's black tittle. Replace them with real artwork
before shipping to anyone.

## The web version is untouched

`npm run dev` and the deployment are unchanged. The only edits outside
`android/` are `viewport-fit=cover` in `index.html` and two `env(safe-area-inset-*)`
rules in `brand.css`, both of which resolve to `0px` in a desktop browser.
They exist because Android 15 and later draw apps edge to edge whether they ask
to or not, and without them the location chip sits under the status bar.
