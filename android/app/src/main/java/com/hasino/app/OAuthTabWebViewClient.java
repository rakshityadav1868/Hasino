package com.hasino.app;

import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.net.Uri;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;

import androidx.browser.customtabs.CustomTabsClient;
import androidx.browser.customtabs.CustomTabsIntent;

import java.util.List;

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

    /** The service every Custom Tabs provider publishes. */
    private static final String CUSTOM_TABS_SERVICE = "android.support.customtabs.action.CustomTabsService";

    /**
     * Any installed browser that implements Custom Tabs, Chrome first.
     *
     * Chrome is preferred only because it is the reference implementation and
     * the one this flow was verified against; any provider here is correct, and
     * null means the device genuinely has none, which the caller handles.
     *
     * Requires the <queries> element in AndroidManifest.xml — without it
     * Android 11 and later report no matches at all.
     */
    private String anyCustomTabsProvider(Context context) {
        PackageManager pm = context.getPackageManager();
        List<ResolveInfo> providers = pm.queryIntentServices(new Intent(CUSTOM_TABS_SERVICE), 0);
        String first = null;
        for (ResolveInfo info : providers) {
            String candidate = info.serviceInfo.packageName;
            if ("com.android.chrome".equals(candidate)) {
                return candidate;
            }
            if (first == null) {
                first = candidate;
            }
        }
        return first;
    }

    private void openInCustomTab(Context context, Uri url) {
        CustomTabsIntent tabs = new CustomTabsIntent.Builder().setShowTitle(true).build();
        // Name the browser explicitly.
        //
        // Without a package the intent is a bare ACTION_VIEW, and on a device
        // with no default browser set Android answers it with the "Open with"
        // chooser — observed on a OnePlus running Android 15, mid sign-in, with
        // Chrome and the system browser offered and no way for the user to know
        // which one keeps the flow working. Worse, a plain browser picked there
        // is not a Custom Tab at all, so the return leg loses the one property
        // this whole client exists to get.
        //
        // getPackageName() returns a browser that actually implements Custom
        // Tabs, preferring the user's default; null means none does, and the
        // fallback below then applies.
        String pkg = CustomTabsClient.getPackageName(context, null);
        if (pkg == null) {
            // getPackageName() starts from the *default* browser and checks
            // whether it speaks Custom Tabs. On a phone with no default browser
            // set there is nothing to start from and it returns null even when
            // two providers are installed — measured on an Android 15 device
            // that had both Chrome and the vendor browser. Ask the package
            // manager directly rather than accept the chooser.
            pkg = anyCustomTabsProvider(context);
        }
        if (pkg != null) {
            tabs.intent.setPackage(pkg);
        }
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
