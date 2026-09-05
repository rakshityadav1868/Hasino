/**
 * The two server-side halves of the Google sign-in redirect.
 *
 * Neither is exercised by any user-facing endpoint, and both fail silently
 * when wrong — a missing route looks like a blank page, a missing CSP source
 * looks like "sign-up is broken but sign-in works". They are asserted here
 * because the symptom is a redirect loop and the cause is one string.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';

import { clerkFrontendApiHost, contentSecurityPolicy } from '../src/http/middleware.ts';

const server = readFileSync(new URL('../src/http/server.ts', import.meta.url), 'utf8');
const auth = readFileSync(new URL('../src/http/public/lib/auth.js', import.meta.url), 'utf8');

describe('OAuth callback route', () => {
  it('serves the app shell at the path Clerk redirects back to', () => {
    assert.match(server, /'\/sso-callback': 'index\.html'/);
  });

  it('points the client at that same path', () => {
    const declared = /const CALLBACK_PATH = '([^']+)'/.exec(auth)?.[1];
    assert.equal(declared, '/sso-callback');
  });

  it('does not put the callback behind a hash route', () => {
    // Clerk appends its parameters as a query string. On a '#/...' target they
    // land inside the fragment, location.search is empty, and the sign-in can
    // never be completed — which is exactly how the loop happened.
    assert.doesNotMatch(
      auth,
      /redirectUrl: window\.location\.origin \+ '\/#/,
      'redirectUrl must be a real path, not a hash route',
    );
    const url = new URL('http://x' + '/sso-callback' + '?__clerk_status=complete');
    assert.equal(url.search, '?__clerk_status=complete');
  });

  it('completes the redirect rather than only starting it', () => {
    // authenticateWithRedirect without a matching handleRedirectCallback is a
    // flow that nothing finishes: the browser returns holding a sign-in
    // attempt and no session.
    assert.match(auth, /handleRedirectCallback\(/);
  });
});

describe('no phone is asked for anywhere in sign-in', () => {
  const login = readFileSync(new URL('../src/http/public/views/login.js', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../src/http/public/app.js', import.meta.url), 'utf8');
  const session = readFileSync(new URL('../src/auth/session.ts', import.meta.url), 'utf8');
  const schema = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');

  it('the login view has no phone step left in it', () => {
    assert.doesNotMatch(login, /phone/i);
  });

  it('nothing throws or routes on 428 PHONE_REQUIRED', () => {
    // Prose about the old behaviour is fine; a live code path is not.
    assert.doesNotMatch(session, /throw new AuthError\(\s*428/);
    assert.doesNotMatch(app, /status === 428/);
  });

  it('users.phone is nullable, so an account can exist without one', () => {
    const col = /phone\s+text\s+UNIQUE(\s+NOT NULL)?/.exec(schema);
    assert.ok(col, 'users.phone column not found');
    assert.equal(col[1], undefined, 'users.phone must not be NOT NULL');
  });
});

describe('panels do not rebuild themselves on a token refresh', () => {
  // watchAuthState fires on every Clerk resource change, including the routine
  // token refresh that happens about once a minute. Both panels re-render the
  // current view from that callback, and those views start by clearing #view —
  // so without an identity guard, anything typed into a form is wiped roughly
  // every minute, which reads as the page reloading on its own.
  for (const panel of ['admin.js', 'business.js']) {
    it(`${panel} only re-renders when the identity actually changes`, () => {
      const src = readFileSync(new URL(`../src/http/public/${panel}`, import.meta.url), 'utf8');
      const handler = /watchAuthState\(async \(([^)]*)\) => \{([\s\S]*?)\n\}\)/.exec(src);
      assert.ok(handler, `${panel}: watchAuthState handler not found`);
      const args = handler[1] ?? '';
      const body = handler[2] ?? '';
      assert.notEqual(args.trim(), '', `${panel}: handler must receive the user to compare`);
      assert.match(
        body,
        /if \(userId === lastUserId\) return;/,
        `${panel}: handler must bail out when the user is unchanged`,
      );
      // The guard is worthless below the work it is meant to skip.
      assert.ok(
        body.indexOf('lastUserId) return') < body.indexOf('render()'),
        `${panel}: the guard must come before render()`,
      );
    });
  }
});

describe('the salon panel is reachable from the customer app', () => {
  // Only the salon panel. The admin panel is a separate private process and
  // this app has no route to it — see test/admin-separation.test.ts.
  const topbar = readFileSync(new URL('../src/http/public/components/TopBar.js', import.meta.url), 'utf8');
  const profile = readFileSync(new URL('../src/http/public/views/profile.js', import.meta.url), 'utf8');

  it('the top bar links an approved owner to their salon panel', () => {
    assert.match(topbar, /'business'.*'\/business'/s);
  });

  it('the profile list links an approved owner to their salon panel', () => {
    assert.match(profile, /'\/business'/);
  });

  it('but the panel offers a salon account no way back to a customer one', () => {
    // Two buttons side by side read as "which panel are you?", and the account
    // already answered that: role comes from the owner_id relationship, not
    // from anything about the email. Someone signed out, or signed in without
    // a salon, is looking at a panel that is not theirs and still gets a door.
    const businessHtml = readFileSync(
      new URL('../src/http/public/business.html', import.meta.url), 'utf8');
    const businessJs = readFileSync(
      new URL('../src/http/public/business.js', import.meta.url), 'utf8');
    assert.doesNotMatch(businessHtml, /Customer app/);
    assert.match(businessJs, /me\.role !== 'business'\) showExit\(\)/);
  });
});

describe('the OAuth return comes back into the Android app', () => {
  // Google will not run OAuth in an embedded WebView, so the browser takes
  // that step. Everything here is about the browser handing the *result* back:
  // left in Chrome it completes against Chrome's cookies and the app stays
  // signed out, because a WebView has its own storage.
  const manifest = readFileSync(
    new URL('../android/app/src/main/AndroidManifest.xml', import.meta.url), 'utf8');
  const mainActivity = readFileSync(
    new URL('../android/app/src/main/java/com/hasino/app/MainActivity.java', import.meta.url), 'utf8');
  const buildGradle = readFileSync(
    new URL('../android/app/build.gradle', import.meta.url), 'utf8');
  const capacitorConfig = readFileSync(
    new URL('../capacitor.config.ts', import.meta.url), 'utf8');
  const clientAuth = readFileSync(
    new URL('../src/http/public/lib/auth.js', import.meta.url), 'utf8');

  it('claims the callback path as a verified App Link', () => {
    assert.match(manifest, /android:autoVerify="true"/);
    assert.match(manifest, /android:path="\/sso-callback"/);
    assert.match(manifest, /android:scheme="https"/);
  });

  it('claims that path only, not the whole host', () => {
    // A host-wide filter turns every shared salon link into an app launch.
    assert.doesNotMatch(manifest, /android:pathPrefix="\/"/);
    assert.doesNotMatch(manifest, /android:host="\$\{hasinoAppHost\}"\s*\/>/);
  });

  it('takes the host from the built config rather than hardcoding it', () => {
    // Two places to write the deployment URL means one of them is eventually
    // stale, and a stale host fails as "Chrome kept the user".
    assert.match(manifest, /android:host="\$\{hasinoAppHost\}"/);
    assert.match(buildGradle, /capacitor\.config\.json/);
    assert.match(buildGradle, /manifestPlaceholders = \[hasinoAppHost/);
  });

  it('loads the link into the WebView, which Capacitor does not do', () => {
    // Bridge.onNewIntent only notifies plugins. Without this the app
    // foregrounds and drops the sign-in — worse than staying in Chrome,
    // because it looks like it worked.
    assert.match(mainActivity, /onNewIntent/);
    assert.match(mainActivity, /getWebView\(\)\.loadUrl/);
  });

  it('honours the link only when it is our own origin', () => {
    // Otherwise any app could have a URL of its choosing rendered inside the
    // Hasino WebView, wearing Hasino's identity.
    assert.match(mainActivity, /sameOrigin/);
    assert.match(mainActivity, /getConfig\(\)\.getServerUrl\(\)/);
  });

  it('has a route home that App Links verification cannot break', () => {
    // Android verifies App Links over a network that may not be there at
    // install time. A device that failed that check sends the callback to the
    // browser instead, silently. Schemes are not verified and cannot fail
    // that way, so the callback page hands itself on by scheme when it
    // notices it is in a browser.
    assert.match(manifest, /android:scheme="hasino"/);
    assert.match(manifest, /android:host="sso-callback"/);
    assert.match(mainActivity, /NATIVE_SCHEME/);
  });

  it('rebuilds a scheme callback onto its own origin rather than following it', () => {
    // Any app may claim hasino://. Only the query survives; the scheme, host
    // and path are the app's own, so the worst a hostile sender achieves is
    // making Hasino reload its own callback URL.
    assert.match(mainActivity, /encodedQuery\(query\)/);
    assert.match(mainActivity, /\.path\(CALLBACK_PATH\)/);
  });

  it('knows it is in the app without Capacitor being injected', () => {
    // The site is loaded from the network, so Capacitor never injects its
    // bridge and window.Capacitor does not exist inside the app. Detecting
    // "native" with isNativePlatform() would report browser everywhere and
    // the callback would never hand itself back.
    assert.match(capacitorConfig, /appendUserAgent: 'HasinoApp\/1'/);
    assert.match(clientAuth, /HasinoApp\\\//);
  });

  it('bounces the app callback to the scheme, and leaves the web one alone', () => {
    // The app returns to /sso-callback/app; the server 302s that to hasino://,
    // which the Custom Tab launches — closing itself and putting the app back
    // in front. The web sign-in returns to /sso-callback and finishes in the
    // browser it started in.
    assert.match(clientAuth, /NATIVE_CALLBACK_PATH = '\/sso-callback\/app'/);
    assert.match(server, /path === '\/sso-callback\/app'/);
    assert.match(server, /hasino:\/\/sso-callback/);
    assert.doesNotMatch(clientAuth, /sso-callback\/native/);
    assert.doesNotMatch(server, /'\/sso-callback\/native'/);
    // The web redirect flow is untouched.
    assert.match(server, /'\/sso-callback': 'index\.html'/);
  });

  it('serves the site half of the agreement, and only when configured', () => {
    assert.match(server, /\/\.well-known\/assetlinks\.json/);
    assert.match(server, /delegate_permission\/common\.handle_all_urls/);
    // An empty fingerprint list is a positive "no app may handle these links",
    // and Android caches it. 404 leaves the question open. The rule itself now
    // lives in assetLinkStatements(), which test/app-links.test.ts drives
    // directly; what this file still holds is that the route serves it and
    // that "nothing to declare" is a 404 rather than an empty declaration.
    assert.match(server, /const statements = assetLinkStatements\(\);/);
    assert.match(server, /if \(!statements\) throw new HttpError\(404/);
    assert.match(server, /if \(fingerprints\.length === 0\) return null;/);
  });
});

describe('sign-in lands you where your role belongs', () => {
  // An owner who signs in and arrives on the customer home has been asked,
  // in effect, to pick a role — first the home page, then the profile, then
  // the dashboard. The role is not theirs to pick: it is `role` on
  // GET /api/me, derived server-side from the identity Google verified.
  const app = readFileSync(new URL('../src/http/public/app.js', import.meta.url), 'utf8');
  const login = readFileSync(new URL('../src/http/public/views/login.js', import.meta.url), 'utf8');

  it('sends a salon owner straight to their panel', () => {
    assert.match(app, /role === 'business'\) return '\/business'/);
  });

  it('leaves the customer destination alone', () => {
    // The intent from the two login buttons still decides where a customer
    // lands. Only the owner branch is role-driven.
    assert.match(app, /intent === 'salon' \? '#\/apply' : '#\/home'/);
  });

  it('navigates a real path as a document load, not a hash route', () => {
    // '/business' is business.html, a separate document. go() only moves the
    // hash, so routing an owner there with it would change the URL and render
    // nothing. Both forms — pushing an entry and replacing the current one —
    // have to be a document load for a real path.
    const fn = /function navigateTo\(dest[\s\S]*?\n\}/.exec(app)?.[0] ?? '';
    assert.notEqual(fn, '', 'navigateTo() not found');
    assert.match(fn, /if \(dest\.startsWith\('#'\)\)/, 'hash routes stay in the router');
    assert.match(fn, /window\.location\.assign\(dest\)/);
    assert.match(fn, /window\.location\.replace\(dest\)/);
  });

  it('routes on app open, not only on the sign-in that created the session', () => {
    // Sign-in happens once; opening the app happens every day. Routing only
    // at sign-in left an owner who reopened the app on the customer home,
    // which is the "customer panel first" this is meant to remove.
    assert.match(app, /function routeOnOpen\(\)/);
    assert.match(app, /else routeOnOpen\(\);/);
  });

  it('moves nobody away from a page they chose', () => {
    // Only landing routes. An owner who opened a shared salon link asked for
    // that page; bouncing them to the dashboard breaks every link into the app.
    assert.match(app, /LANDING_ROUTES = new Set\(\['', '#\/', '#\/home'\]\)/);
    assert.match(app, /LANDING_ROUTES\.has\(currentHash\(\)\)/);
  });

  it('takes the panel from the server-side role, not the email', () => {
    assert.match(app, /app\.session\?\.role === 'business'\) return '\/business'/);
    assert.doesNotMatch(app, /email.*@.*(includes|endsWith|test\()/);
  });

  it('forgets the launch on sign-out, so the next sign-in still routes', () => {
    // Without the reset, an owner who signed out and back in on the same page
    // would be stranded on the customer home: routeOnOpen had spent its one
    // shot and would not fire again.
    assert.match(app, /openRouted = false;/);
  });

  it('decides the same way for someone already signed in', () => {
    // The login view is reachable with a live session — a bookmark, a back
    // button. Sending that person to '#/home' while a fresh sign-in goes to
    // the panel is the same inconsistency in a place nobody tests.
    assert.match(login, /app\.afterSignIn\(\)/);
    assert.doesNotMatch(login, /app\.navigate\('#\/home'\)/);
  });
});

describe('no native browser dialogs', () => {
  // window.prompt() THROWS "prompt() is not supported." in sandboxed and
  // embedded contexts, and Chrome suppresses alert/confirm/prompt entirely
  // once a user ticks "prevent this page from creating additional dialogs".
  // Every call site sat in an onclick that ignored the returned promise, so
  // the throw became an unhandled rejection and the button silently did
  // nothing — that is how "Approve & activate" stopped working.
  const surfaces = [
    'admin.js',
    'business.js',
    'views/bookings.js',
  ];
  for (const file of surfaces) {
    it(`${file} uses the in-page dialog, not alert/confirm/prompt`, () => {
      const src = readFileSync(new URL(`../src/http/public/${file}`, import.meta.url), 'utf8');
      const code = src
        .replace(/\/\*[\s\S]*?\*\//g, '')  // block comments
        .replace(/^\s*\/\/.*$/gm, '');     // line comments
      for (const fn of ['alert', 'confirm', 'prompt']) {
        assert.doesNotMatch(
          code,
          new RegExp(`(^|[^.\\w])${fn}\\s*\\(`),
          `${file} still calls ${fn}() — it is unavailable in some contexts and fails silently`,
        );
      }
    });
  }

  it('the dialog module is actually served', () => {
    // loadAssets() takes an explicit allowlist; a module missing from it 404s
    // at import time and takes the whole panel down with it.
    assert.match(server, /'lib\/dialog\.js'/);
  });
});

describe('CSP', () => {
  const pkFor = (host: string) => 'pk_live_' + Buffer.from(host + '$').toString('base64');
  const directive = (csp: string, name: string) =>
    csp.split('; ').find((d) => d.startsWith(name + ' ')) ?? '';

  const csp = contentSecurityPolicy(pkFor('clerk.hasino.in'));
  const scriptSrc = directive(csp, 'script-src');
  const frameSrc = directive(csp, 'frame-src');
  const connectSrc = directive(csp, 'connect-src');

  it('allows Clerk bot protection as a script, not just as a frame', () => {
    // Turnstile is a script that then creates the frame. Trusting only the
    // frame blocks the script, and the sole symptom is that *sign-up* fails
    // with captcha_invalid while sign-in keeps working.
    assert.ok(frameSrc.includes('https://challenges.cloudflare.com'));
    assert.ok(
      scriptSrc.includes('https://challenges.cloudflare.com'),
      'challenges.cloudflare.com must be in script-src or new accounts cannot be created',
    );
  });

  it('still refuses eval', () => {
    assert.ok(!scriptSrc.includes('unsafe-eval'));
  });

  it('carries no wildcard a browser will discard', () => {
    // A wildcard is only legal as the leftmost label. 'https://clerk.*' is
    // dropped whole, with nothing but a console warning to say so.
    for (const source of csp.split(/[; ]/)) {
      if (!source.startsWith('https://')) continue;
      assert.ok(
        !/\*/.test(source.slice('https://'.length).split('.').slice(1).join('.')),
        `${source} puts a wildcard somewhere a browser will reject`,
      );
    }
  });

  it('trusts the exact Frontend API host of a production instance', () => {
    // The one that was actually broken: production serves Clerk from
    // clerk.<yourdomain>, which no other source in the policy matches.
    assert.ok(scriptSrc.includes('https://clerk.hasino.in'));
    assert.ok(connectSrc.includes('https://clerk.hasino.in'));
    assert.ok(frameSrc.includes('https://clerk.hasino.in'));
  });

  it('reads that host out of the publishable key', () => {
    assert.equal(clerkFrontendApiHost(pkFor('clerk.hasino.in')), 'clerk.hasino.in');
    assert.equal(clerkFrontendApiHost('pk_test_' + Buffer.from('abc.clerk.accounts.dev$').toString('base64')),
      'abc.clerk.accounts.dev');
  });

  it('refuses a key that would widen the policy', () => {
    // The host goes into the policy verbatim, so a key encoding a space and a
    // second origin would otherwise add one.
    assert.equal(clerkFrontendApiHost('pk_live_' + Buffer.from('evil.com https://attacker.test$').toString('base64')), null);
    assert.equal(clerkFrontendApiHost('pk_live_@@@'), null);
    assert.equal(clerkFrontendApiHost(undefined), null);
  });

  it('omits the Clerk host entirely when there is no key', () => {
    const bare = contentSecurityPolicy(undefined);
    assert.ok(!bare.includes('undefined'));
    assert.ok(!bare.includes('https://null'));
  });
});
