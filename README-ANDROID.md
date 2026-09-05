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

## Google sign-in: out to a tab, back to the app

Google refuses OAuth inside an embedded WebView, so the Google step happens in a
browser and that will not change. The whole problem is getting the browser to
give the app the foreground back afterwards — otherwise the user is signed in
in Chrome while the app, which shares no storage with it, still shows a sign-in
button.

Two arrangements were tried on a device and both failed:

| tried | what happened |
|---|---|
| full Chrome, returning through App Links | the session crossed into the app, but Chrome kept the foreground — the user had to close it by hand. And App Links rest on an install-time verification that fails closed, so when it does not hold Chrome simply keeps the URL |
| full Chrome, following a 302 to `hasino://` | nothing happened. Chrome will not launch an external scheme from a redirect the user did not initiate |

What works is the pair, not either half:

1. `OAuthTabWebViewClient.java` diverts the off-origin hop into a **Chrome
   Custom Tab** instead of the full browser. A tab is bound to the app that
   opened it.
2. The app's sign-in ends on `https://<host>/sso-callback/app`, an ordinary
   https URL — the only kind Clerk accepts as a redirect.
3. The server answers that with a **302 to `hasino://sso-callback`**, carrying
   Clerk's handshake query verbatim.
4. The tab launches the scheme, closes itself, and the app comes forward.
   `MainActivity` rebuilds the query onto the app's own origin and loads it, and
   the WebView — the one place holding the client state that started the
   sign-in — finishes the handshake.

This is the pattern native OAuth libraries on Android use. Nothing in the chain
depends on a verification that can fail closed, so there is nothing to
configure: **no `assetlinks.json`, no fingerprints, no Google Cloud.** Deploy
the server and install the APK.

The web flow is untouched. A desktop browser returns to `/sso-callback` and
finishes where it started.

### The optional upgrade: no browser at all

If you would rather nothing opened at all, the native path is still here and
takes over automatically the moment the deployment can support it. Android's
Credential Manager draws the Google account sheet over the WebView
(`GoogleAuthPlugin.java`), hands back a signed ID token, and Clerk exchanges it
in place — no tab, no redirect.

It needs three things, and unset it simply is not used:

1. **Google Cloud**, one project, two OAuth clients — a **Web** client, and an
   **Android** client for `com.hasino.app` plus the SHA-1 of the certificate the
   APK is signed with:

   ```bash
   $ANDROID_HOME/build-tools/36.0.0/apksigner verify --print-certs \
     android/app/build/outputs/apk/debug/app-debug.apk
   ```

2. **Clerk** → Social Connections → Google → *use custom credentials*, with the
   Web client id and secret. A development instance on Clerk's shared Google
   credentials has no client id of its own to verify a native token against and
   rejects it however correct the token is. Check which state an instance is in:

   ```bash
   curl -s "https://<instance>.clerk.accounts.dev/v1/environment?__clerk_api_version=2025-04-10&_clerk_js_version=6.27.1&__clerk_db_jwt=$TOKEN" \
     | jq .display_config.google_one_tap_client_id
   ```

   `null` means custom credentials are not set.

3. **`GOOGLE_WEB_CLIENT_ID`** on the server, the same Web client id. It is in
   `render.yaml` as a `sync: false` key you type in the dashboard, and the app
   reads it from `GET /api/config`:

   ```bash
   curl -s https://<host>/api/config | jq .googleClientId
   ```

### The App Links filter that is still there

`AndroidManifest.xml` still claims `https://<host>/sso-callback`, and the server
still serves `/.well-known/assetlinks.json` from `ANDROID_CERT_FINGERPRINTS`.
The app's own sign-in no longer depends on either. They are kept so a callback
arriving from *outside* — an email link, a web sign-in on a device that has the
app — lands in the app rather than the browser. Leave them unset and nothing
about the app's sign-in changes.

### If the sign-in still ends up in Chrome

The first thing to rule out is the APK. The Custom Tab client is compiled in;
a build from before it landed still sends the hop to the full browser and no
amount of server configuration changes what is already in the APK.

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
| `android/app/src/main/java/com/hasino/app/OAuthTabWebViewClient.java` | sends the OAuth hop to a Custom Tab |
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
