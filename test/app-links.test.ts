/**
 * Google sign-in in the Android app is native — no browser at all.
 *
 * The account sheet is drawn over the WebView by Credential Manager
 * (GoogleAuthPlugin), a signed Google ID token comes straight back, and it is
 * exchanged with Clerk in the same WebView (authenticateWithGoogleOneTap). The
 * old browser round trip — full Chrome, then Custom Tabs, then App-Link and
 * scheme returns — is gone, because none of it could reliably hand focus back
 * to the app once the OAuth was inside the browser.
 *
 * What remains here of App Links is only the deep-link plumbing: assetlinks.json
 * and the manifest filters still let a /sso-callback link opened from *outside*
 * the app (a web sign-in on a device that has the app, an email link) land in
 * the app rather than the browser. The app's own sign-in no longer uses it.
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

describe('the app signs in natively, with no browser', () => {
  const app = read('src/http/public/app.js');
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
    // Native path: token -> authenticateWithGoogleOneTap -> session here. The
    // client id is read from Clerk's own environment so there is one source of
    // truth and no audience mismatch.
    assert.match(auth, /window\.Capacitor\?\.Plugins\?\.GoogleAuth/);
    assert.match(auth, /if \(isNativeApp\(\)\) \{/);
    assert.match(auth, /plugin\.signIn\(\{ serverClientId \}\)/);
    assert.match(auth, /authenticateWithGoogleOneTap\(\{ token: idToken \}\)/);
    assert.match(auth, /handleGoogleOneTapCallback/);
    // The client id comes from /api/config (GOOGLE_WEB_CLIENT_ID), which the
    // server serves and the native token is minted for.
    assert.match(auth, /cfg\?\.googleClientId/);
    assert.match(read('src/http/server.ts'), /googleClientId: process\.env\['GOOGLE_WEB_CLIENT_ID'\]/);
  });

  it('inside the app there is no path to the browser redirect at all', () => {
    // The branch is on isNativeApp() alone. Gating it on the plugin as well —
    // `if (isNativeApp() && nativeGoogleAuth())` — reads like defensiveness and
    // is the opposite: a missing bridge then falls through to
    // authenticateWithRedirect, which hands the sign-in to Chrome. Chrome
    // cannot give it back; it signs the user in against its own cookie jar
    // while the WebView still shows a sign-in button. So the app reports a
    // missing bridge instead of routing around it.
    const branch = /if \(isNativeApp\(\)\) \{[\s\S]*?\n  \}/.exec(auth)?.[0] ?? '';
    assert.match(branch, /NO_NATIVE_BRIDGE/);
    assert.match(branch, /return signInWithGoogleNative\(c, plugin\)/);
    assert.doesNotMatch(branch, /authenticateWithRedirect/);
  });

  it('handles cancellation without falling back to a browser', () => {
    // A dismissed sheet is a quiet CANCELLED, and the native path never calls
    // authenticateWithRedirect — so it cannot open Chrome.
    const native = /async function signInWithGoogleNative[\s\S]*?\n}/.exec(auth)?.[0] ?? '';
    assert.match(native, /code: 'CANCELLED'/);
    assert.doesNotMatch(native, /authenticateWithRedirect/);
  });

  it('leaves no browser hand-off machinery behind', () => {
    // No Custom Tab, no scheme bounce, no in-page card, no app-specific path.
    assert.doesNotMatch(app, /handOffToNativeApp/);
    assert.doesNotMatch(auth, /intent:\/\//);
    assert.doesNotMatch(auth, /NATIVE_CALLBACK_PATH/);
    assert.doesNotMatch(read('src/http/server.ts'), /hasino:\/\/sso-callback/);
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
