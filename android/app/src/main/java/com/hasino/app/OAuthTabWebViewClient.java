package com.hasino.app;

import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;

import androidx.browser.customtabs.CustomTabsIntent;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;

/**
 * The one reason app sign-ins land back in the app instead of stranding in
 * Chrome.
 *
 * Google refuses OAuth inside an embedded WebView, so the Google step has to
 * happen in a real browser. Capacitor's default for any navigation that leaves
 * the app's own origin is a plain ACTION_VIEW — the *full* Chrome app (see
 * Bridge.launchIntent) — and a full Chrome window is where sign-ins go to die
 * here. It keeps the foreground even when an App Link does reach the app, and
 * it refuses to follow a 302 into `hasino://` at all, because Chrome will not
 * launch an external scheme from a redirect the user did not initiate. Both
 * were tried; both left the user signed in to a web page rather than the app.
 *
 * A Chrome Custom Tab is bound to the app that opened it, and it does follow
 * that scheme. The server ends the app's OAuth on /sso-callback/app, answers
 * with a 302 to hasino://sso-callback, the tab launches it, closes itself, and
 * MainActivity is handed the callback with the app back in front. This is the
 * pattern native OAuth libraries on Android use, and it needs no
 * assetlinks.json and no install-time verification, so there is nothing to fail
 * closed.
 *
 * This client catches exactly the navigations Capacitor would have sent to the
 * full browser and opens them in a tab instead. Everything on the app's origin
 * is left untouched and continues to load in the WebView.
 */
public class OAuthTabWebViewClient extends BridgeWebViewClient {

    private final Bridge bridge;

    public OAuthTabWebViewClient(Bridge bridge) {
        super(bridge);
        this.bridge = bridge;
    }

    @Override
    public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        Uri url = request.getUrl();

        if (request.isForMainFrame() && isExternalHttp(url)) {
            openInCustomTab(view.getContext(), url);
            return true; // handled here — the WebView does not navigate away
        }

        // Same-origin navigation (including the /sso-callback the tab hands
        // back), or a non-http scheme: let Capacitor decide exactly as before.
        return super.shouldOverrideUrlLoading(view, request);
    }

    /**
     * True for an http(s) navigation leaving the app's own origin — i.e. the
     * OAuth hop. The app's origin is the server URL the WebView is configured
     * for; in this shell nothing else takes the main frame off-origin, so this
     * is the OAuth step and only the OAuth step.
     */
    private boolean isExternalHttp(Uri url) {
        String scheme = url.getScheme();
        if (!"http".equalsIgnoreCase(scheme) && !"https".equalsIgnoreCase(scheme)) {
            return false;
        }
        String serverUrl = bridge.getConfig().getServerUrl();
        if (serverUrl == null) {
            return false; // origin unknown — leave Capacitor's default in charge
        }
        String appHost = Uri.parse(serverUrl).getHost();
        String host = url.getHost();
        return appHost != null && host != null && !appHost.equalsIgnoreCase(host);
    }

    private void openInCustomTab(Context context, Uri url) {
        CustomTabsIntent tabs = new CustomTabsIntent.Builder().setShowTitle(true).build();
        try {
            tabs.launchUrl(context, url);
        } catch (ActivityNotFoundException e) {
            // No Custom Tabs provider on the device. Fall back to Capacitor's
            // original behaviour rather than dropping the sign-in entirely: a
            // plain browser at least completes the auth, even if the return
            // leg then needs App Links to hold on their own.
            try {
                context.startActivity(new Intent(Intent.ACTION_VIEW, url));
            } catch (ActivityNotFoundException ignored) {
                // No browser at all; nothing more this can do.
            }
        }
    }
}
