/**
 * Clerk Auth: Google sign-in, and nothing else.
 *
 * Google supplies the entire identity, so a first sign-in creates the account
 * outright. There is no phone-link step: users.phone is nullable and the
 * server no longer answers 428 PHONE_REQUIRED — see
 * db/migrations/006_users_phone_optional.sql.
 *
 * No bundler — @clerk/clerk-js loads as a native ES module straight from the
 * CDN, pinned to one version, the same way the rest of this app's JavaScript
 * is served. Clerk's React SDKs are the documented path and would need a build
 * step; clerk-js is the same library underneath and needs none.
 *
 * The publishable key comes from GET /api/config. It is not secret — it ships
 * to every browser by design — but it is environment-specific, so it is served
 * from server env rather than hardcoded here.
 *
 * The exported surface is deliberately identical to what the Firebase version
 * exposed, so index.html, business.html, admin.html and views/login.js did not
 * have to learn a new shape.
 */

const SDK_VERSION = '6.27.1';
const SDK_URL = `https://cdn.jsdelivr.net/npm/@clerk/clerk-js@${SDK_VERSION}/dist/clerk.mjs`;

let clerk = null;
let loadPromise = null;
let configPromise = null;

/**
 * The routes of the app using this module.
 *
 * Clerk has to be told where to send the browser — for a sign-in page, for the
 * landing spot afterwards, for every step of a redirect flow it might need to
 * resume. Those URLs were hardcoded to the customer app's hash routes, which
 * is fine while there is one app and wrong the moment there are two: the admin
 * panel has no '#/login' and no '#/home', so Clerk sent it to a route that
 * does not exist and the router quietly fell back to '#/overview' — a sign-in
 * that appears to do nothing.
 *
 * Defaults are the customer app's, so index.html needs no change. The admin
 * panel calls configureAuthRoutes() with its own.
 */
const routes = { signIn: '/#/login', home: '/#/home' };

/**
 * Must be called before anything triggers clerk-js to load, because load()
 * takes these. Calling it later would leave the SDK configured for whichever
 * app got there first.
 */
export function configureAuthRoutes(next) {
  if (clerk || loadPromise) {
    throw new Error('configureAuthRoutes() must be called before Clerk loads');
  }
  Object.assign(routes, next);
}

/**
 * The SDK is fetched lazily, inside here, rather than imported at module
 * scope.
 *
 * clerk-js is 1.5MB. A top-level `await import()` of it would block this
 * module's evaluation, and therefore the whole app's module graph, on that
 * download — and if the CDN were unreachable the entire page would fail to
 * boot rather than just losing sign-in. Browsing is public and must survive an
 * auth provider that is slow, unconfigured, or down.
 */
async function ensureClerk() {
  if (clerk?.loaded) return clerk;
  loadPromise ??= (async () => {
    configPromise ??= fetch('/api/config').then((r) => r.json());
    const { clerk: cfg } = await configPromise;
    if (!cfg?.publishableKey) {
      throw new Error('Clerk is not configured on the server (CLERK_PUBLISHABLE_KEY is unset)');
    }
    const mod = await import(SDK_URL);
    const Clerk = mod.Clerk ?? mod.default;
    if (typeof Clerk !== 'function') {
      throw new Error('clerk-js loaded but exported no Clerk constructor');
    }
    const instance = new Clerk(cfg.publishableKey);
    await instance.load({
      // The app renders its own chrome; Clerk supplies identity, not UI.
      // Redirects are handled by the hash router.
      signInUrl: routes.signIn,
      afterSignOutUrl: routes.home,
    });
    clerk = instance;
    return instance;
  })();
  return loadPromise;
}

/**
 * Fires `handler(user | null)` once the session is restored, and again on
 * every change. Clerk restores asynchronously, so the first call is what tells
 * a page whether it is looking at a signed-out visitor or a slow load.
 */
export async function watchAuthState(handler) {
  const c = await ensureClerk();
  handler(c.user ?? null);
  return c.addListener(({ user }) => handler(user ?? null));
}

/**
 * The path Clerk returns the browser to after Google, served by the server as
 * the app shell — see PAGES in src/http/server.ts.
 *
 * It is a real path, not a hash route, and that is load-bearing. Clerk appends
 * its callback parameters (__clerk_status and friends) to this URL as a query
 * string. Given '/#/login' the browser parses the result as one long fragment,
 * location.search is empty, and handleRedirectCallback finds nothing to act
 * on — which is precisely how the sign-in loop used to happen.
 */
const CALLBACK_PATH = '/sso-callback';

/**
 * The return path for a sign-in that started in the Android app.
 *
 * Google refuses OAuth inside an embedded WebView, so the Google step has to
 * happen in a browser however this is arranged. The whole difficulty is getting
 * that browser to hand focus back afterwards, and two arrangements have already
 * failed here: a full Chrome window returning through App Links kept the
 * foreground even once the session had crossed, and a full Chrome window
 * following a 302 to a custom scheme never followed it at all, because Chrome
 * will not launch an external scheme from a redirect the user did not initiate.
 *
 * What returns reliably is the pair, not either half: the hop is opened in a
 * Chrome Custom Tab (OAuthTabWebViewClient.java), and the tab is sent to this
 * https path, which the server answers with a 302 to `hasino://sso-callback`
 * (see src/http/server.ts). A Custom Tab is bound to the app that opened it and
 * does launch that scheme, which closes the tab and brings the app forward —
 * the pattern every native OAuth library on Android uses. The scheme needs no
 * assetlinks.json and no install-time verification, so there is nothing to fail
 * closed.
 *
 * A path rather than a query parameter because Clerk rewrites the redirect it
 * round-trips: a marker in the query does not survive, an exact URL does.
 */
const NATIVE_CALLBACK_PATH = '/sso-callback/app';

/**
 * The Google Web OAuth client id the server is configured with, or null.
 *
 * Null is the ordinary state, not an error: it is only set when the deployment
 * has been given its own Google credentials (GOOGLE_WEB_CLIENT_ID), which is
 * what native sign-in needs and the browser flow does not.
 */
async function googleWebClientId() {
  const cfg = await (configPromise ??= fetch('/api/config').then((r) => r.json())).catch(() => null);
  return cfg?.googleClientId ?? null;
}

/**
 * The native Google-sign-in plugin, when the page is running inside the app.
 *
 * The Android shell registers a `GoogleAuth` plugin (see GoogleAuthPlugin.java)
 * that draws the system Google account sheet over the WebView and returns a
 * signed Google ID token — no browser, nothing to navigate back from. This
 * build loads a remote origin, and the bridge Capacitor injects for that case
 * exposes registered native plugins on `window.Capacitor.Plugins.<Name>` (it
 * does not expose `registerPlugin`). Resolved lazily so bridge load-order never
 * matters; null in an ordinary browser, where the web redirect flow is used.
 */
function nativeGoogleAuth() {
  return window.Capacitor?.Plugins?.GoogleAuth ?? null;
}

/**
 * True inside the Hasino Android app, false in any ordinary browser.
 *
 * The app announces itself in the user agent (appendUserAgent in
 * capacitor.config.ts); `window.Capacitor` is also present in this build and is
 * checked as a second signal.
 */
export function isNativeApp() {
  return (
    / HasinoApp\//.test(navigator.userAgent) ||
    Boolean(window.Capacitor?.isNativePlatform?.())
  );
}

/** True on the page load that Clerk redirected to after Google. */
export function isRedirectCallback() {
  return window.location.pathname === CALLBACK_PATH;
}

/**
 * Google sign-in.
 *
 * Two paths, chosen by where this runs:
 *
 *  - Android app: native. The system Google account sheet is drawn over the
 *    WebView (GoogleAuthPlugin), a signed ID token comes back, and it is handed
 *    to Clerk here, in this same WebView. No browser, no redirect, no return
 *    trip — signInWithGoogleNative() resolves already signed in.
 *  - Web / desktop: Clerk's full-page OAuth redirect, unchanged. It never
 *    returns on success — the browser leaves for Google and comes back at
 *    CALLBACK_PATH, where completeRedirectCallback() finishes the handshake.
 *
 * The caller treats a resolved promise as "sign-in is under way or done, stop
 * showing the button", and a thrown error as "it failed or was cancelled".
 */
export async function signInWithGoogle() {
  const c = await ensureClerk();

  const native = isNativeApp();

  if (native) {
    // Native when the deployment has been given its own Google credentials:
    // the account sheet is drawn over the WebView and no browser opens at all.
    // Unconfigured — the usual case — this falls through to the redirect
    // below, which is a working sign-in rather than a dead end.
    const plugin = nativeGoogleAuth();
    const serverClientId = plugin ? await googleWebClientId() : null;
    if (plugin && serverClientId) {
      return signInWithGoogleNative(c, plugin, serverClientId);
    }
  }

  try {
    await c.client.signIn.authenticateWithRedirect({
      strategy: 'oauth_google',
      // In the app both of these go to /sso-callback/app, which the server
      // bounces to hasino:// so the Custom Tab closes and the app comes
      // forward; on the web they keep their ordinary values and the sign-in
      // finishes in the tab it started in.
      //
      // Both, not just redirectUrl, and that is the whole fix. redirectUrl is
      // only used when Clerk needs a callback page to carry on; when Google
      // supplies everything the sign-in completes in one hop and Clerk goes
      // straight to redirectUrlComplete. Observed on a device: the tab went
      // from Google to `/?__clerk_handshake=…` to `/#/home`, never touching
      // /sso-callback/app, so the bounce never fired and the session was
      // created in the browser — exactly the bug this is meant to end.
      //
      // The handshake token rides along in the query. It is what carries the
      // authenticated state onto the origin, so bouncing the whole query into
      // the app hands the WebView the session rather than leaving it in the
      // tab that happened to finish the OAuth.
      redirectUrl: window.location.origin + (native ? NATIVE_CALLBACK_PATH : CALLBACK_PATH),
      redirectUrlComplete: window.location.origin + (native ? NATIVE_CALLBACK_PATH : routes.home),
    });
    return null; // navigating away
  } catch (err) {
    if (/network/i.test(err?.message ?? '')) {
      throw Object.assign(new Error('Network error — check your connection and try again'), { code: 'NETWORK' });
    }
    throw err;
  }
}

/**
 * The native token exchange: Google account sheet -> ID token -> Clerk session,
 * all without leaving the app.
 *
 * `authenticateWithGoogleOneTap` verifies the token and creates the session in
 * this WebView; it also signs up a brand-new user in the same call (Clerk falls
 * back to signUp on external_account_not_found). handleGoogleOneTapCallback then
 * activates the session and routes home, the same finish as the web callback —
 * so watchAuthState() in app.js sees the new session and the app routes by role.
 */
async function signInWithGoogleNative(c, plugin, serverClientId) {
  // serverClientId is the Google *Web* OAuth client id the token must be minted
  // for, so Clerk — configured with the same id — will accept it. The caller
  // has already established it is set; this function is not reached otherwise.
  let idToken;
  try {
    const res = await plugin.signIn({ serverClientId });
    idToken = res?.idToken;
  } catch (err) {
    // Credential Manager rejects here when the user backs out of the sheet, and
    // when there is a real failure. A cancellation is not an error to shout.
    const msg = String(err?.message ?? err);
    if (/cancel|dismiss|no.?credential|GetCredentialCancellation/i.test(msg)) {
      throw Object.assign(new Error('Sign-in cancelled'), { code: 'CANCELLED' });
    }
    throw Object.assign(new Error('Could not sign in with Google. Please try again.'), { code: 'NATIVE_FAILED' });
  }
  if (!idToken) {
    throw Object.assign(new Error('Google did not return a token'), { code: 'NATIVE_FAILED' });
  }

  const resource = await c.authenticateWithGoogleOneTap({ token: idToken });
  await c.handleGoogleOneTapCallback(resource, {
    signInFallbackRedirectUrl: routes.home,
    signUpFallbackRedirectUrl: routes.home,
  });
  return null; // signed in; Clerk has routed us home
}

/**
 * Google sign-in, step 2 of 2 — run on CALLBACK_PATH and nowhere else.
 *
 * This is what turns a returning OAuth redirect into an actual session, and
 * its absence was the original bug: authenticateWithRedirect() started a flow
 * that nothing ever finished, so the browser came back with a sign-in attempt
 * in progress, no session, and a login page that offered to start the whole
 * thing again.
 *
 * Clerk navigates away itself when it is done, so this does not return in the
 * success case. The destinations matter:
 *
 *  - existing user  -> redirectUrlComplete from step 1 ('/#/home')
 *  - brand-new user -> the sign-in is transferred to a sign-up automatically
 *                      (transferable defaults to true), and with Google
 *                      supplying every required attribute that sign-up
 *                      completes in the same round trip and lands on '/#/home'
 *                      too. Nothing is collected in between.
 *
 * The remaining URLs are stops this app does not use but Clerk may still route
 * to — an instance reconfigured to require a phone or a second factor, say.
 * They all point at the login view because that is the only auth UI mounted
 * here; left unset they default to Clerk's own hosted component routes, which
 * do not exist in this app and would dead-end.
 */
export async function completeRedirectCallback() {
  const c = await ensureClerk();

  // The app's return does not arrive as an OAuth callback at all.
  //
  // Google supplies every attribute the sign-up needs, so Clerk completes in
  // one hop and sends back a handshake token rather than a callback to resume.
  // ensureClerk() above has already loaded clerk-js, which consumes that token
  // from the query and establishes the session on this origin — which is the
  // point of bouncing the whole query into the app rather than letting the tab
  // keep it. By the time we get here the sign-in has therefore already
  // succeeded, and handleRedirectCallback would throw looking for an attempt
  // that no longer exists. Route on instead.
  if (c.session) {
    window.location.replace(routes.home);
    return null;
  }

  return c.handleRedirectCallback({
    continueSignUpUrl: routes.signIn,
    signInFallbackRedirectUrl: routes.home,
    signUpFallbackRedirectUrl: routes.home,
    signInUrl: routes.signIn,
    signUpUrl: routes.signIn,
    firstFactorUrl: routes.signIn,
    secondFactorUrl: routes.signIn,
    resetPasswordUrl: routes.signIn,
    verifyPhoneNumberUrl: routes.signIn,
    verifyEmailAddressUrl: routes.signIn,
  });
}

export async function signOut() {
  const c = await ensureClerk();
  await c.signOut();
}

/**
 * The session token for `Authorization: Bearer <token>`, or null when signed
 * out. Clerk caches it and refreshes shortly before expiry, so this is cheap
 * to call per request; `forceRefresh` skips the cache after a 401.
 */
export async function currentIdToken(forceRefresh = false) {
  const c = await ensureClerk();
  if (!c.session) return null;
  return c.session.getToken(forceRefresh ? { skipCache: true } : undefined);
}

export function currentUser() {
  return clerk?.user ?? null;
}

/**
 * Resolves once clerk-js has loaded and restored whatever session exists.
 *
 * currentUser() is synchronous and reports null until that finishes, so any
 * "are they signed in?" check that does not await this first answers "no" for
 * everybody on a cold page load — and, on the login view, offers a signed-in
 * user the sign-in button.
 */
export async function awaitClerk() {
  await ensureClerk();
}
