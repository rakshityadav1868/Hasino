import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Hasino for Android — a shell around the deployed web app.
 *
 * Why a shell rather than bundled assets
 * --------------------------------------
 * This project has no bundler and no build step: the customer app is plain ES
 * modules that the Node server hands out, and every API call is a same-origin
 * relative path. Bundling those files into the APK would put the WebView on
 * `http://localhost`, which breaks every one of those paths, needs CORS opened
 * up for the app origin, and moves Clerk onto an origin its OAuth redirect
 * knows nothing about.
 *
 * Pointing the WebView at the real HTTPS site avoids all three. The origin is
 * the deployed site, so relative URLs, cookies and the existing Clerk redirect
 * behave exactly as they do in a desktop browser — which is the requirement.
 * The cost is that the app needs a network connection; there is no offline
 * mode, and mobile/www is only what shows when the site cannot be reached.
 *
 * The admin panel is not reachable from here by construction, not by
 * configuration: the deployed server has no /admin route, no admin asset and
 * no /api/admin/*, because the panel is a separate process bound to loopback
 * on the operator's own machine. See src/http/admin-server.ts.
 */

/**
 * The deployed site. Set HASINO_APP_URL before `npx cap sync android`.
 *
 * There is deliberately no default. A localhost fallback would silently
 * produce an APK that works on the laptop that built it and nowhere else —
 * and an emulator would even make that look fine. An unset value stops the
 * sync with an error instead.
 */
const APP_URL = process.env['HASINO_APP_URL'];

if (!APP_URL) {
  throw new Error(
    'HASINO_APP_URL is not set. The Android app loads the deployed Hasino site, so the build ' +
      'needs its URL:\n\n  HASINO_APP_URL=https://your-deployment npx cap sync android\n\n' +
      'It must be https — Android blocks cleartext traffic, and Clerk requires a secure origin.',
  );
}

if (!APP_URL.startsWith('https://')) {
  throw new Error(
    `HASINO_APP_URL must be https, got "${APP_URL}". Android blocks cleartext HTTP by default and ` +
      'Google sign-in will not run on an insecure origin.',
  );
}

/**
 * The hosted admin panel, if there is one. Optional.
 *
 * An admin signing in is sent to their panel by the server's ADMIN_PANEL_URL,
 * and that panel is a different origin. Without its host listed below, Android
 * would treat the hop as an external link and open Chrome — the thing this
 * build exists to stop. Listed, the panel opens inside the app.
 *
 * Set it only if you have deployed the panel and set ADMIN_PANEL_URL on the
 * server; the two are the same URL. Unset, nothing routes there and the app
 * behaves exactly as before.
 */
const ADMIN_URL = process.env['HASINO_ADMIN_URL'];

if (ADMIN_URL && !ADMIN_URL.startsWith('https://')) {
  throw new Error(`HASINO_ADMIN_URL must be https, got "${ADMIN_URL}".`);
}

const config: CapacitorConfig = {
  appId: 'com.hasino.app',
  appName: 'Hasino',
  // Required by the CLI even though the app loads from the network. Holds the
  // offline fallback page and nothing else.
  webDir: 'mobile/www',
  android: {
    // The default is already false; stated because the whole design depends on
    // it. Turning it on to "just test against my laptop" is how a production
    // APK ends up talking to http://192.168.x.x.
    allowMixedContent: false,
    // How the page knows it is inside the app.
    //
    // The site is loaded from the network, not from the APK, so Capacitor
    // never injects its bridge and `window.Capacitor` does not exist here —
    // the usual isNativePlatform() check would report "browser" inside the
    // app. The OAuth return has to tell the two apart to know whether to
    // finish the sign-in or bounce back into the app, so the app announces
    // itself in a way that survives a remote origin. See isNativeApp() in
    // lib/auth.js.
    appendUserAgent: 'HasinoApp/1',
  },
  server: {
    url: APP_URL,
    // Anything the site itself navigates to stays inside the app. The OAuth hop
    // to Google deliberately does NOT — Google refuses OAuth from an embedded
    // WebView, so a browser has to take that step. It is opened in a Chrome
    // Custom Tab (OAuthTabWebViewClient.java) rather than the full browser,
    // because a tab follows the hasino:// redirect the sign-in ends on and puts
    // the app back in front. See README-ANDROID.md.
    allowNavigation: ADMIN_URL ? [new URL(APP_URL).host, new URL(ADMIN_URL).host] : [new URL(APP_URL).host],
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 1200,
      backgroundColor: '#0b0a0f',
      androidScaleType: 'CENTER_CROP',
      showSpinner: false,
    },
  },
};

export default config;
