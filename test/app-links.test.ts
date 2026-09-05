/**
 * The Google sign-in round trip in the Android app, and how it comes home.
 *
 * Google refuses OAuth inside an embedded WebView, so the Google step happens
 * in a browser and that will not change. What must not happen is the browser
 * *keeping* the result: it finishes the handshake in its own cookie jar, and
 * the app the user started from is still signed out, because a WebView shares
 * no storage with Chrome.
 *
 * Two arrangements have already failed on a device here, and both are asserted
 * against rather than merely avoided:
 *
 *   1. Full Chrome returning through App Links. The session did cross, but the
 *      browser kept the foreground — the user had to close Chrome by hand to
 *      find the app. And App Links rest on an install-time verification that
 *      fails closed, so when it does not hold the browser simply keeps the URL.
 *   2. Full Chrome following a 302 into `hasino://`. Chrome will not launch an
 *      external scheme from a redirect the user did not initiate, so nothing
 *      happened at all.
 *
 * What works is the pair. The hop is opened in a Chrome Custom Tab
 * (OAuthTabWebViewClient), which is bound to the app that opened it, and the
 * sign-in ends on /sso-callback/app, which the server bounces to
 * hasino://sso-callback. The tab launches the scheme, closes, and MainActivity
 * is handed the callback with the app in front. No verification anywhere in
 * that chain, so nothing can quietly fail closed.
 *
 * Native sign-in (GoogleAuthPlugin + authenticateWithGoogleOneTap) skips the
 * browser entirely, but only where the deployment has its own Google
 * credentials. Unconfigured — the ordinary case — the round trip above runs, so
 * both paths are covered here.
 */
import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { readFileSync } from 'node:fs';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const { assetLinkStatements } = await import('../src/http/server.ts');

const FINGERPRINT = '74:32:7B:37:93:45:EE:A9:4D:D6:F3:66:DD:CD:1B:30:FE:66:C0:03:80:43:96:7F:4E:B9:66:C4:ED:9C:45:1F';

describe('assetlinks — what makes Android trust the app with these links', () => {
  const saved = process.env['ANDROID_CERT_FINGERPRINTS'];

  beforeEach(() => {
    delete process.env['ANDROID_CERT_FINGERPRINTS'];
  });
  afterEach(() => {
    if (saved === undefined) delete process.env['ANDROID_CERT_FINGERPRINTS'];
    else process.env['ANDROID_CERT_FINGERPRINTS'] = saved;
  });

  it('declares nothing when no fingerprint is configured — which is what broke the flow', () => {
    // Null is a 404 at the route. It must not be an empty list: an empty
    // `relation` is a positive statement that NO app may handle these links,
    // and Android caches that answer.
    assert.equal(assetLinkStatements(), null);
  });

  it('serves a declaration Android can verify once the fingerprint is set', () => {
    process.env['ANDROID_CERT_FINGERPRINTS'] = FINGERPRINT;
    const statements = assetLinkStatements() as Array<{
      relation: string[];
      target: { namespace: string; package_name: string; sha256_cert_fingerprints: string[] };
    }>;
    assert.equal(statements.length, 1);
    const [statement] = statements;
    assert.deepEqual(statement!.relation, ['delegate_permission/common.handle_all_urls']);
    assert.equal(statement!.target.namespace, 'android_app');
    // Must match the applicationId in android/app/build.gradle, or Android
    // verifies a statement about a different app and the link stays in Chrome.
    assert.equal(statement!.target.package_name, 'com.hasino.app');
    assert.deepEqual(statement!.target.sha256_cert_fingerprints, [FINGERPRINT]);
  });

  it('takes more than one fingerprint, because debug and release differ', () => {
    const release = 'AA:BB:' + FINGERPRINT.slice(6);
    process.env['ANDROID_CERT_FINGERPRINTS'] = `${FINGERPRINT}, ${release}`;
    const statements = assetLinkStatements() as Array<{ target: { sha256_cert_fingerprints: string[] } }>;
    assert.deepEqual(statements[0]!.target.sha256_cert_fingerprints, [FINGERPRINT, release]);
  });

  it('is asked for by the deployment blueprint', () => {
    // The variable existed and nothing ever prompted for it, so the endpoint
    // 404'd in production and App Links never verified.
    const render = read('render.yaml');
    assert.match(render, /ANDROID_CERT_FINGERPRINTS/);
    assert.match(render, /ANDROID_PACKAGE/);
  });
});

describe('the app claims exactly the callback it is sent to', () => {
  const manifest = read('android/app/src/main/AndroidManifest.xml');
  const buildGradle = read('android/app/build.gradle');
  const auth = read('src/http/public/lib/auth.js');

  it('claims the https callback path, and verifies it', () => {
    assert.match(manifest, /android:autoVerify="true"/);
    assert.match(manifest, /android:scheme="https"/);
    assert.match(manifest, /android:path="\/sso-callback"/);
  });

  it('takes the host from the same config the WebView loads', () => {
    // A hardcoded host would disagree with HASINO_APP_URL the moment either
    // moved, and the symptom of that disagreement is Chrome keeping the user.
    assert.match(manifest, /android:host="\$\{hasinoAppHost\}"/);
    assert.match(buildGradle, /capacitor\.config\.json/);
    assert.match(buildGradle, /manifestPlaceholders = \[hasinoAppHost: hasinoAppHost\]/);
  });

  it('also claims the scheme that needs no verification', () => {
    assert.match(manifest, /android:scheme="hasino"/);
    assert.match(manifest, /android:host="sso-callback"/);
  });

  it('and the page it lands on is the app shell, which finishes the handshake', () => {
    assert.match(read('src/http/server.ts'), /'\/sso-callback'/);
    assert.match(auth, /export function isRedirectCallback/);
  });
});

describe('the app sign-in leaves for a tab and comes back to the app', () => {
  const app = read('src/http/public/app.js');
  const auth = read('src/http/public/lib/auth.js');
  const server = read('src/http/server.ts');
  const tabClient = read('android/app/src/main/java/com/hasino/app/OAuthTabWebViewClient.java');
  const plugin = read('android/app/src/main/java/com/hasino/app/GoogleAuthPlugin.java');
  const mainActivity = read('android/app/src/main/java/com/hasino/app/MainActivity.java');
  const buildGradle = read('android/app/build.gradle');

  it('opens the off-origin hop in a Custom Tab, not the full browser', () => {
    // Capacitor's default for an off-origin navigation is ACTION_VIEW, which is
    // the full Chrome app — the one browser that will neither give the
    // foreground back nor follow the scheme the sign-in ends on. So the client
    // diverts exactly those navigations and leaves everything else alone.
    assert.match(tabClient, /extends BridgeWebViewClient/);
    assert.match(tabClient, /CustomTabsIntent/);
    assert.match(tabClient, /shouldOverrideUrlLoading/);
    assert.match(tabClient, /isForMainFrame\(\)/);
    assert.match(tabClient, /equalsIgnoreCase\(host\)/);
    assert.match(tabClient, /return super\.shouldOverrideUrlLoading/);
  });

  it('names the browser, so no "Open with" chooser interrupts the sign-in', () => {
    // A bare ACTION_VIEW is answered by the resolver on a device with no
    // default browser — seen mid sign-in on Android 15, offering Chrome and the
    // system browser with no way to tell which keeps the flow intact. A plain
    // browser chosen there is not a Custom Tab, so the return leg loses the one
    // property this client exists to get.
    assert.match(tabClient, /CustomTabsClient\.getPackageName\(context, null\)/);
    assert.match(tabClient, /tabs\.intent\.setPackage\(pkg\)/);
    // getPackageName() starts from the default browser, so it returns null on a
    // phone that has none set — even with two providers installed, which is
    // what the test device had. The direct query is the one that answers.
    assert.match(tabClient, /queryIntentServices/);
    assert.match(tabClient, /anyCustomTabsProvider/);
    // Android 11+ hides every other package unless the app declares what it
    // needs to see; without this the query above matches nothing at all.
    const manifest = read('android/app/src/main/AndroidManifest.xml');
    assert.match(manifest, /<queries>/);
    assert.match(manifest, /android\.support\.customtabs\.action\.CustomTabsService/);
  });

  it('is installed on the WebView at startup', () => {
    assert.match(mainActivity, /setWebViewClient\(new OAuthTabWebViewClient\(getBridge\(\)\)\)/);
    assert.match(buildGradle, /androidx\.browser:browser/);
  });

  it('ends the app sign-in on a path the server bounces to the scheme', () => {
    // Clerk only accepts an https redirect, so the app cannot ask Google to end
    // on hasino:// directly. It ends on /sso-callback/app instead and the
    // server does the scheme hop — which is also why this is a path and not a
    // query marker: Clerk rewrites the redirect it round-trips, so a marker
    // does not survive and an exact URL does.
    assert.match(auth, /NATIVE_CALLBACK_PATH = '\/sso-callback\/app'/);
    assert.match(auth, /native \? NATIVE_CALLBACK_PATH : CALLBACK_PATH/);
    assert.match(server, /path === '\/sso-callback\/app'/);
    assert.match(server, /Location: `hasino:\/\/sso-callback\$\{url\.search\}`/);
  });

  it('leaves the web sign-in on its own callback', () => {
    // A desktop browser finishes where it started. Only the app takes the hop.
    assert.match(auth, /const CALLBACK_PATH = '\/sso-callback'/);
    assert.match(server, /'\/sso-callback': 'index\.html'/);
    assert.match(auth, /window\.location\.pathname === CALLBACK_PATH/);
  });

  it('has no in-page hand-off left — no card, no intent bounce', () => {
    // The page never has to rescue a stranded sign-in, so none of the old
    // in-page escape hatches remain.
    assert.doesNotMatch(app, /handOffToNativeApp/);
    assert.doesNotMatch(app, /Continue in this browser instead/);
    assert.doesNotMatch(auth, /intent:\/\//);
    assert.doesNotMatch(auth, /sso-callback\/native/);
  });
});

describe('native sign-in is used where the deployment supports it', () => {
  const auth = read('src/http/public/lib/auth.js');
  const plugin = read('android/app/src/main/java/com/hasino/app/GoogleAuthPlugin.java');
  const mainActivity = read('android/app/src/main/java/com/hasino/app/MainActivity.java');
  const buildGradle = read('android/app/build.gradle');

  it('gets a Google ID token from Credential Manager, not a browser', () => {
    // The account sheet is drawn over the app; a signed ID token comes back.
    assert.match(plugin, /@CapacitorPlugin\(name = "GoogleAuth"\)/);
    assert.match(plugin, /CredentialManager/);
    assert.match(plugin, /GetGoogleIdOption/);
    assert.match(plugin, /GoogleIdTokenCredential/);
    assert.match(plugin, /setServerClientId\(serverClientId\)/);
    assert.match(plugin, /ret\.put\("idToken"/);
  });

  it('registers the plugin and pulls in Credential Manager', () => {
    assert.match(mainActivity, /registerPlugin\(GoogleAuthPlugin\.class\)/);
    assert.match(buildGradle, /androidx\.credentials:credentials/);
    assert.match(buildGradle, /com\.google\.android\.libraries\.identity\.googleid:googleid/);
  });

  it('exchanges the token with Clerk in the same WebView', () => {
    assert.match(auth, /window\.Capacitor\?\.Plugins\?\.GoogleAuth/);
    assert.match(auth, /plugin\.signIn\(\{ serverClientId \}\)/);
    assert.match(auth, /authenticateWithGoogleOneTap\(\{ token: idToken \}\)/);
    assert.match(auth, /handleGoogleOneTapCallback/);
    assert.match(auth, /cfg\?\.googleClientId/);
    assert.match(read('src/http/server.ts'), /googleClientId: process\.env\['GOOGLE_WEB_CLIENT_ID'\]/);
  });

  it('falls back to the browser round trip when it is not configured', () => {
    // GOOGLE_WEB_CLIENT_ID is unset on a deployment that has not been given its
    // own Google credentials, which is the ordinary case. Throwing there — as
    // this once did — leaves the app with no way to sign in at all; the browser
    // round trip is worse than native but it works, so it is what runs.
    const branch = /if \(native\) \{[\s\S]*?\n  \}/.exec(auth)?.[0] ?? '';
    assert.match(branch, /if \(plugin && serverClientId\)/);
    assert.doesNotMatch(auth, /NOT_CONFIGURED/);
    assert.doesNotMatch(auth, /NO_NATIVE_BRIDGE/);
  });

  it('handles cancellation without falling back to a browser', () => {
    // A dismissed sheet is a quiet CANCELLED. Retrying in a browser after the
    // user closed the sheet on purpose would be its own bug.
    const native = /async function signInWithGoogleNative[\s\S]*?\n}/.exec(auth)?.[0] ?? '';
    assert.match(native, /code: 'CANCELLED'/);
    assert.doesNotMatch(native, /authenticateWithRedirect/);
  });
});

describe('an already signed-in launch stays in the app', () => {
  const app = read('src/http/public/app.js');
  const login = read('src/http/public/views/login.js');

  it('sign-in is only ever started by a tap', () => {
    // Anything that called signInWithGoogle() on load would send a
    // already-signed-in user out to Chrome every time they opened the app.
    // signInWithGoogle() is reachable only from start(), and start() only
    // from an onclick. Anything calling it at render time would send an
    // already-signed-in user out to Chrome every time they opened the app.
    assert.match(login, /customerBtn\.onclick = \(\) => start\(/);
    assert.match(login, /salonBtn\.onclick = \(\) => start\(/);
    const calls = login.match(/signInWithGoogle\(\)/g) ?? [];
    assert.equal(calls.length, 1, 'exactly one call site, inside start()');
    const startFn = /const start = async \([\s\S]*?\n  \};/.exec(login)?.[0] ?? '';
    assert.match(startFn, /await signInWithGoogle\(\)/, 'and it is that one');
  });

  it('a restored session routes by role, in the app', () => {
    assert.match(app, /routeOnOpen\(\)/);
    assert.match(app, /if \(app\.session\?\.role === 'business'\) return '\/business'/);
  });

  it("the owner's panel is a path on the same origin, so it stays in the WebView", () => {
    // '/business' is same-origin; only the admin panel is a different host,
    // and capacitor.config.ts adds it to allowNavigation when it is set.
    assert.match(read('capacitor.config.ts'), /allowNavigation/);
    assert.match(read('capacitor.config.ts'), /HASINO_ADMIN_URL/);
  });
});
