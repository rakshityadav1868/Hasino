import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';

import { getPool, type Pool } from '../db/pool.ts';
import { MemorySnapshotCache } from '../availability/cache.ts';
import { getAvailability } from '../availability/service.ts';
import { loadCart } from '../availability/repo.ts';
import { createBooking } from '../booking/create.ts';
import { HISTORY_GRACE_MIN, NoShowTooEarlyError, customerCancelBooking } from '../booking/status.ts';
import { rescheduleBooking } from '../booking/reschedule.ts';
import { BookingError, SlotUnavailableError } from '../booking/errors.ts';
import { ForbiddenError, listCustomerBookings } from '../business/repo.ts';
import { addFavorite, getBooking, getSalon, listFavorites, listFavoriteSalons, listSalons, removeFavorite } from '../salons/repo.ts';
import {
  ImageUploadError,
  deleteStagedImage,
  readImageBody,
  saveStagedImage,
  serveGalleryPhoto,
  serveSalonImage,
  serveStagedImage,
  stagedImageFor,
} from '../salons/images.ts';
import { businessRoutes } from './routes-business.ts';
import { AdminError, applyForSalon, listCatalogue } from '../admin/repo.ts';
import { reverseGeocode, searchPlaces } from '../geo/geocode.ts';
import {
  HttpError,
  json,
  loadAssets,
  readJson,
  sendAsset,
  stringArray,
  uuid,
} from './respond.ts';
import {
  RateLimitError,
  RateLimiter,
  applyCors,
  clientKey,
  originsFromEnv,
  readRawBody,
  securityHeaders,
} from './middleware.ts';
import { AuthError, verifierFromEnv } from '../auth/verifier.ts';
import { type Session, authenticate, requireRole } from '../auth/session.ts';
import { AccountDeletionBlockedError, deleteOwnAccount } from '../auth/account.ts';
import { StubRazorpayClient, paymentsConfigFromEnv } from '../payments/razorpay.ts';
import { PaymentError, confirmCheckout, openCheckout } from '../payments/service.ts';
import { WebhookSignatureError, handleWebhook, handleCashfreeWebhook } from '../payments/webhook.ts';
import { channelFromEnv } from '../notify/dispatch.ts';
import { startWorkers, type RunningWorkers } from '../workers/runner.ts';
import { annotate, log, newRequestId, reportError, withRequestContext } from '../obs/logger.ts';
import { readCronHeartbeat } from '../obs/heartbeat.ts';

/**
 * DEV_AUTH swaps real token verification for a header naming the user
 * directly — anyone can act as anyone.
 *
 * It now requires CI_SMOKE as well, because "local development" and "a smoke
 * test harness" are different needs that were sharing one switch. Local
 * development uses real Google sign-in like production does; only the CI smoke
 * run, which has no browser to sign in with, gets the bypass. A developer who
 * sets DEV_AUTH out of habit gets a working server with auth ON and a warning
 * saying why, rather than a server that silently trusts a header.
 *
 * start() refuses to boot with either flag in production.
 */
const DEV_AUTH_REQUESTED = process.env['DEV_AUTH'] === 'true';
const CI_SMOKE = process.env['CI_SMOKE'] === 'true';
const DEV_AUTH = DEV_AUTH_REQUESTED && CI_SMOKE;
const IS_PROD = process.env['NODE_ENV'] === 'production';
const TRUST_PROXY = process.env['TRUST_PROXY'] === 'true';

const verifier = verifierFromEnv(DEV_AUTH);
const payments = paymentsConfigFromEnv(CI_SMOKE);

const cache = new MemorySnapshotCache();
const allowedOrigins = originsFromEnv();

/**
 * Three budgets, because the endpoints are not equally expensive to abuse.
 * Browsing is cheap and gets a wide limit; taking a chair costs someone else a
 * slot, so it gets a narrow one keyed to the user rather than the IP — an
 * office behind one NAT is many customers.
 */
const limits = {
  global: new RateLimiter(Number(process.env['RATE_LIMIT_PER_MIN'] ?? 300)),
  booking: new RateLimiter(10, 5),
  auth: new RateLimiter(60),
};

const assets = loadAssets(new URL('./public/', import.meta.url), [
  'index.html',
  'business.html',
  'brand.css',
  'app.css',
  // Page shells. External rather than inline so the CSP can stay
  // `script-src 'self'` with no 'unsafe-inline'.
  'app.js',
  'business.js',
  // The pre-paint launch script (theme + splash watchdog). Classic, not a
  // module, so it runs before app.js during head parsing.
  'splash-boot.js',
  'lib/api.js',
  'lib/auth.js',
  'lib/backbutton.js',
  'lib/cart.js',
  'lib/theme.js',
  'lib/dialog.js',
  'lib/dom.js',
  'lib/favorites.js',
  'lib/format.js',
  'lib/icons.js',
  'lib/imagecrop.js',
  'lib/legal-content.js',
  'lib/location.js',
  'lib/payments.js',
  'lib/router.js',
  'components/Avatar.js',
  'components/Badge.js',
  'components/BookingCard.js',
  'components/BottomNav.js',
  'components/BottomSheet.js',
  'components/Button.js',
  'components/CategoryNav.js',
  'components/EmptyState.js',
  'components/HeartButton.js',
  'components/ImageCarousel.js',
  'components/LocationSheet.js',
  'components/Input.js',
  'components/Modal.js',
  'components/Rating.js',
  'components/SalonCard.js',
  'components/SearchBar.js',
  'components/ServiceCard.js',
  'components/Skeleton.js',
  'components/Toast.js',
  'components/Stepper.js',
  'components/TopBar.js',
  'views/home.js',
  'views/explore.js',
  'views/salon.js',
  'views/checkout.js',
  'views/bookings.js',
  'views/saved.js',
  'views/profile.js',
  'views/login.js',
  'views/apply.js',
  'views/legal.js',
]);

const PAGES: Record<string, string> = {
  '/': 'index.html',
  '/business': 'business.html',
  // Where Clerk returns the browser after Google. It has to be a real path
  // rather than a hash route: Clerk appends its callback parameters as a
  // query string, and on a '/#/login' target they would land inside the
  // fragment, where location.search cannot see them and the sign-in can
  // never be completed. Serves the app shell, which finishes the handshake
  // and then navigates on — see app.js and lib/auth.js.
  '/sso-callback': 'index.html',
};

function requireDevAuth(): void {
  if (!DEV_AUTH) throw new HttpError(404, 'Not found');
}

/**
 * The single authentication entry point.
 *
 * Production: a Clerk session token in `Authorization: Bearer <token>`.
 * DEV_AUTH:   an `x-dev-user` header naming a users.auth_provider_id, so the
 *             smoke harness can act as anyone without a browser.
 */
async function session(db: Pool, req: IncomingMessage): Promise<Session> {
  if (DEV_AUTH) {
    const dev = req.headers['x-dev-user'];
    if (typeof dev === 'string' && dev.length > 0) {
      const s = await authenticate(db, verifier, `Bearer ${dev}`);
      annotate({ userId: s.userId });
      return s;
    }
  }
  const s = await authenticate(db, verifier, req.headers.authorization);
  annotate({ userId: s.userId });
  return s;
}

/**
 * Replay a retried request instead of doing it twice.
 *
 * A phone on a bad connection retries POST /api/bookings, and without this the
 * second attempt takes a second chair and opens a second Razorpay order. The
 * request body is hashed into the key so a client reusing a key for a
 * *different* request gets an error rather than someone else's response.
 *
 * Without an Idempotency-Key header this is a straight pass-through — the
 * header is opt-in for clients that can generate one, not a requirement.
 */
async function withIdempotency<T>(
  db: Pool,
  req: IncomingMessage,
  userId: string,
  endpoint: string,
  body: unknown,
  fn: () => Promise<{ status: number; body: T }>,
): Promise<{ status: number; body: T }> {
  const raw = req.headers['idempotency-key'];
  const key = (Array.isArray(raw) ? raw[0] : raw)?.slice(0, 200);
  if (!key) return fn();

  const hash = createHash('sha256').update(JSON.stringify(body ?? {})).digest('hex');

  const claim = await db.query<{ request_hash: string; status_code: number | null; response: T | null }>(
    `INSERT INTO idempotency_keys (key, user_id, endpoint, request_hash)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, endpoint, key) DO NOTHING
     RETURNING request_hash, status_code, response`,
    [key, userId, endpoint, hash],
  );

  if (claim.rowCount === 0) {
    const seen = await db.query<{ request_hash: string; status_code: number | null; response: T | null }>(
      `SELECT request_hash, status_code, response FROM idempotency_keys
        WHERE user_id = $1 AND endpoint = $2 AND key = $3`,
      [userId, endpoint, key],
    );
    const row = seen.rows[0]!;
    if (row.request_hash !== hash) {
      throw new HttpError(422, 'This Idempotency-Key was already used for a different request');
    }
    if (row.status_code !== null && row.response !== null) {
      return { status: row.status_code, body: row.response };
    }
    // The first attempt is still in flight. 409 is honest: retrying in a
    // moment will replay the stored response.
    throw new HttpError(409, 'That request is still being processed');
  }

  const result = await fn();
  await db.query(
    `UPDATE idempotency_keys SET status_code = $4, response = $5::jsonb
      WHERE user_id = $1 AND endpoint = $2 AND key = $3`,
    [userId, endpoint, key, result.status, JSON.stringify(result.body)],
  );
  return result;
}

/** What POST /api/bookings answers with — and what gets stored for a replay. */
interface BookingResponse {
  id: string;
  salonId: string;
  startAt: string;
  endAt: string;
  amount: number;
  status: string;
  paid: boolean;
  holdExpiresAt?: string | null;
  checkout?: unknown;
  warning?: string;
}

async function route(db: Pool, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = req.method ?? 'GET';
  const seg = path.split('/').filter(Boolean);

  // HEAD is a GET without a body, and Node drops the body for us. Matching only
  // GET makes every asset 404 for uptime checks, CDNs and proxies that HEAD
  // before they fetch — which looks like the app being down.
  const read = method === 'GET' || method === 'HEAD';

  // ---------- liveness / readiness ----------
  // Split on purpose. Kubernetes restarts a container that fails liveness and
  // only removes it from the load balancer when it fails readiness. A liveness
  // probe that touches Postgres therefore turns a database blip into a rolling
  // restart of every instance, which is how a brief outage becomes a long one.
  if (read && path === '/healthz') {
    // uptimeSeconds is what makes the keepalive verifiable, and it is the only
    // reason this returns more than `{ ok: true }`.
    //
    // On Render's free tier the process is destroyed when the service spins
    // down and a new one starts on the next request, so uptime is time since
    // the last cold start. That turns a single request into a complete answer
    // about whether the external pinger is doing its job: hours of uptime
    // means nothing has let the service fall asleep, and a handful of seconds
    // means this very request paid for the wake. Without it you cannot tell a
    // working keepalive from a broken one — both return `{ ok: true }`, and a
    // fast reply only proves the service is awake *now*, which the act of
    // asking guarantees. See scripts/keepalive.ts.
    //
    // Deliberately still free of I/O: this is the liveness probe, and reading
    // process.uptime() costs nothing.
    return json(res, 200, { ok: true, uptimeSeconds: Math.round(process.uptime()) });
  }

  if (read && (path === '/readyz' || path === '/health')) {
    try {
      await db.query('SELECT 1');
    } catch (err) {
      return json(res, 503, { ok: false, db: 'unreachable', error: (err as Error).message });
    }
    // The cron liveness record: how long ago the background-job cron last ran.
    // Null means it has never run against this database; a large ageSeconds
    // means it has stopped. Read-only and unauthenticated on purpose — a
    // timestamp is the whole point, so anyone can check the cron without the
    // Render dashboard.
    let cron: {
      lastRunAt: string;
      ageSeconds: number;
      ok: boolean;
      runs: number;
      lastMs: number | null;
    } | null = null;
    try {
      const hb = await readCronHeartbeat(db);
      if (hb) {
        cron = {
          lastRunAt: hb.lastRunAt.toISOString(),
          ageSeconds: Math.round((Date.now() - hb.lastRunAt.getTime()) / 1000),
          ok: hb.ok,
          runs: hb.runs,
          lastMs: hb.ms,
        };
      }
    } catch {
      // The heartbeat table not existing (a database behind on migrations) must
      // not fail readiness — the service is still ready to serve.
    }
    return json(res, 200, {
      ok: true,
      auth: DEV_AUTH ? 'DEV_AUTH (insecure)' : verifier.kind,
      payments: payments.enabled ? payments.client.kind : 'disabled',
      cron,
    });
  }

  // ---------- Razorpay webhook ----------
  // Before the asset and auth branches: it is unauthenticated by design (the
  // signature is the authentication) and it must read the raw body, so nothing
  // may parse it first.
  if (method === 'POST' && path === '/api/webhooks/razorpay') {
    // With no provider configured there is nothing that could legitimately
    // post here, and the config carries a stub secret — so this would be an
    // open endpoint running HMAC against a value that is in the source code.
    if (payments.provider !== 'razorpay') {
      throw new HttpError(404, 'Not found');
    }
    const raw = await readRawBody(req);
    const sig = req.headers['x-razorpay-signature'];
    const eventId = req.headers['x-razorpay-event-id'];
    const result = await handleWebhook(
      db,
      payments,
      raw,
      {
        signature: Array.isArray(sig) ? sig[0] : sig,
        eventId: Array.isArray(eventId) ? eventId[0] : eventId,
      },
      { cache },
    );
    log.info('webhook', { event: result.event, outcome: result.outcome });
    return json(res, result.status, { received: true, outcome: result.outcome });
  }

  // ---------- Cashfree webhook ----------
  // Same rules as the Razorpay one: unauthenticated by design (the signature is
  // the authentication), reads the raw body, verifies before parsing. Cashfree
  // signs timestamp + rawBody, so both headers are forwarded.
  if (method === 'POST' && path === '/api/webhooks/cashfree') {
    if (payments.provider !== 'cashfree') {
      throw new HttpError(404, 'Not found');
    }
    const raw = await readRawBody(req);
    const sig = req.headers['x-webhook-signature'];
    const ts = req.headers['x-webhook-timestamp'];
    const result = await handleCashfreeWebhook(
      db,
      payments,
      raw,
      {
        signature: Array.isArray(sig) ? sig[0] : sig,
        timestamp: Array.isArray(ts) ? ts[0] : ts,
      },
      { cache },
    );
    log.info('webhook', { provider: 'cashfree', event: result.event, outcome: result.outcome });
    return json(res, result.status, { received: true, outcome: result.outcome });
  }

  // ---------- pages + assets ----------
  // Pages are served either way — production users sign in with real Google
  // auth. Only the x-dev-user bypass and /api/dev/identities (below) are
  // DEV_AUTH-only.
  const page = PAGES[path];
  if (read && page) {
    return sendAsset(res, assets.get(page)!, req);
  }

  if (read && assets.has(path.slice(1))) {
    return sendAsset(res, assets.get(path.slice(1))!, req);
  }

  if (read && path === '/favicon.ico') {
    res.writeHead(204);
    return void res.end();
  }

  // ---------- Android App Links ----------
  // Android fetches this at install time to decide whether this site agrees
  // that the Hasino app may open its /sso-callback links. Without agreement
  // the OAuth return stays in Chrome, the handshake completes against
  // Chrome's cookies, and the app the user started from is still signed out —
  // a WebView has its own storage and the session cannot cross.
  //
  // Both halves have to match for a link to verify: the package name and the
  // SHA-256 of the certificate the APK was actually signed with. A debug APK
  // and a release APK have different certificates, so list both here when
  // there is a release build; a fingerprint that is merely stale fails
  // closed — links open in the browser exactly as they did before.
  //
  // Unset, this 404s rather than serving an empty declaration, because an
  // empty `relation` list is a positive statement that no app may handle
  // these links, and Android caches it.
  if (read && path === '/.well-known/assetlinks.json') {
    const statements = assetLinkStatements();
    if (!statements) throw new HttpError(404, 'Not found');
    return json(res, 200, statements);
  }

  // Clerk's publishable key is not secret — it ships to every browser by
  // design — but it is environment-specific, so it comes from env rather than
  // being hardcoded into a checked-in file. CLERK_SECRET_KEY is never served.
  if (read && path === '/api/config') {
    return json(res, 200, {
      clerk: {
        publishableKey: process.env['CLERK_PUBLISHABLE_KEY'] ?? null,
      },
      // The Google *Web* OAuth client id, for native Google sign-in in the
      // Android app: the app asks Credential Manager for a token minted for this
      // audience and Clerk verifies it against the same id. Public by design (an
      // OAuth client id ships to every client), and the SAME id configured as
      // Clerk's Google credentials. Unset on web-only deploys — the browser flow
      // does not use it. See signInWithGoogle() in lib/auth.js.
      googleClientId: process.env['GOOGLE_WEB_CLIENT_ID'] || null,
      // The public key id only. The secret signs, and never leaves the server.
      // `provider` so the UI can say "coming soon" rather than "misconfigured"
      // — one of those is a promise and the other is a bug report. keyId is
      // public by design (Razorpay checkout needs it in the browser); the
      // secret never leaves the server.
      razorpay: { keyId: payments.enabled ? payments.keyId : null, enabled: payments.enabled },
      payments: { provider: payments.provider, enabled: payments.enabled },
      // Where the admin panel lives, when it is hosted. Only a URL, and only
      // one an operator typed: this app still serves no admin route, no admin
      // asset and no /api/admin/* — the panel is a separate process and this
      // is a signpost to it, not a door into it. Unset (the default, and the
      // case for a loopback panel) it is null and the app sends nobody
      // anywhere. Everyone gets this value, which costs nothing: the panel's
      // own sign-in decides who may do anything there.
      adminPanelUrl: process.env['ADMIN_PANEL_URL'] || null,
      devAuth: DEV_AUTH,
    });
  }

  // ---------- dev identity ----------
  // There is no login, so the panels need a way to pick who they are acting as.
  if (method === 'GET' && path === '/api/dev/identities') {
    requireDevAuth();
    // devToken is what x-dev-user expects: the part of auth_provider_id after "dev:".
    const [customers, owners] = await Promise.all([
      db.query(
        `SELECT id, name, phone, replace(auth_provider_id, 'dev:', '') AS dev_token
           FROM users WHERE role = 'customer' AND auth_provider_id LIKE 'dev:%'
          ORDER BY created_at LIMIT 20`,
      ),
      db.query(
        `SELECT u.id, u.name, s.name AS salon_name,
                replace(u.auth_provider_id, 'dev:', '') AS dev_token
           FROM users u JOIN salons s ON s.owner_id = u.id
          WHERE u.role = 'business' AND u.auth_provider_id LIKE 'dev:%'
          ORDER BY s.name`,
      ),
    ]);
    return json(res, 200, { customers: customers.rows, owners: owners.rows });
  }

  /**
   * Stand in for the customer tapping "Pay" in the Razorpay sheet.
   *
   * Razorpay's checkout cannot be driven without real keys, which would
   * otherwise leave the most important path in the app — hold, pay, confirm —
   * untested locally and unexercised by the smoke suite. This asks the stub
   * client to mint a payment and sign it exactly as Razorpay would, so the
   * response goes through the real signature check on the way back in.
   *
   * Two locks: DEV_AUTH only, and only when the payment client is the stub. On
   * a server holding live keys this route does not exist.
   */
  if (method === 'POST' && path === '/api/dev/pay') {
    requireDevAuth();
    if (!(payments.client instanceof StubRazorpayClient)) {
      throw new HttpError(404, 'Not found');
    }
    const body = await readJson(req);
    const orderId = String(body['orderId'] ?? '');
    if (!orderId) throw new HttpError(400, 'orderId is required');
    if (body['fail'] === true) {
      const failed = payments.client.fail(orderId);
      return json(res, 200, { paid: false, paymentId: failed.id, error: failed.error_code });
    }
    return json(res, 200, { paid: true, ...payments.client.pay(orderId, String(body['method'] ?? 'upi')) });
  }

  // ---------- self-serve: the storefront photo, before there is a salon ----------
  //
  // salon_images is keyed by salon_id and an application has none yet — the
  // salons row is created by the submission itself. So the bytes wait here,
  // keyed to the applicant, and applyForSalon moves them onto the salon in the
  // same transaction that creates it.
  //
  // There is no id anywhere in these three routes. The photo is always the
  // caller's own, resolved from the session, exactly like PUT
  // /api/business/image — nothing in the request says whose it is, so there is
  // nothing to tamper with.
  if (seg[0] === 'api' && seg[1] === 'salons' && seg[2] === 'apply' && seg[3] === 'image' && seg.length === 4) {
    const applicant = await session(db, req);

    // The same gate the application itself is behind. An unverified address is
    // a string the person signing up chose, and this stores bytes for them; a
    // route that is cheaper to reach than the form it feeds is a route that
    // gets used on its own.
    if (!applicant.emailVerified) {
      throw new HttpError(
        403,
        'Verify your email address before listing a salon. Open the link your provider sent you, then try again.',
        'EMAIL_NOT_VERIFIED',
      );
    }

    if (method === 'PUT') {
      // Keyed to the user, like the application: uploads are per-person work,
      // not per-address traffic.
      limits.booking.check(`apply-image:${applicant.userId}`);
      const bytes = await readImageBody(req);
      const staged = await saveStagedImage(db, applicant.userId, bytes);
      return json(res, 200, {
        url: staged.url,
        byteSize: staged.byteSize,
        contentType: staged.contentType,
      });
    }

    if (method === 'GET') {
      // The applicant's own preview, and how the form knows a photo is already
      // staged after a reload. `?v=` is ignored — the row is whichever one is
      // current, and there is only ever one.
      const served = await serveStagedImage(db, applicant.userId, req, res);
      if (served) return;
      throw new HttpError(404, 'No photo staged', 'NO_STAGED_IMAGE');
    }

    if (method === 'DELETE') {
      const removed = await deleteStagedImage(db, applicant.userId);
      return json(res, 200, { removed });
    }

    throw new HttpError(405, 'Method not allowed');
  }

  // ---------- self-serve: list your salon ----------
  // Creates rows for any signed-in user, so it shares the booking bucket's
  // shape: keyed to the user, not the IP.
  if (method === 'POST' && path === '/api/salons/apply') {
    const applicant = await session(db, req);

    // A verified address, before anything else.
    //
    // An application is a claim to run a business on Hasino, reviewed by an
    // admin who will read the email as the way to reach whoever sent it — and
    // an unverified `email` claim is a string the person signing up chose.
    // Checked here rather than only in the UI: the form is a courtesy, this is
    // the control. Google sign-in returns a verified address, so in practice
    // this only ever stops a provider configured to allow unverified sign-ups.
    if (!applicant.emailVerified) {
      throw new HttpError(
        403,
        'Verify your email address before listing a salon. Open the link your provider sent you, then try again.',
        'EMAIL_NOT_VERIFIED',
      );
    }

    limits.booking.check(`apply:${applicant.userId}`);
    const body = await readJson(req);
    const result = await applyForSalon(
      db,
      {
        userId: applicant.userId,
        // From the session, never the body — the provider already verified it.
        phone: applicant.phone,
        name: applicant.name,
        email: applicant.email,
      },
      {
        name: String(body['name'] ?? ''),
        address: String(body['address'] ?? ''),
        city: String(body['city'] ?? ''),
        area: typeof body['area'] === 'string' ? body['area'] : null,
        // Optional: geocoded from the address when absent.
        ...(typeof body['lat'] === 'number' ? { lat: body['lat'] } : {}),
        ...(typeof body['lng'] === 'number' ? { lng: body['lng'] } : {}),
        ...(typeof body['timezone'] === 'string' ? { timezone: body['timezone'] } : {}),
        phone: typeof body['phone'] === 'string' ? body['phone'] : null,
        email: typeof body['email'] === 'string' ? body['email'] : null,
        description: typeof body['description'] === 'string' ? body['description'] : null,
        coverUrl: typeof body['coverUrl'] === 'string' ? body['coverUrl'] : null,
        photoUrls: Array.isArray(body['photoUrls'])
          ? body['photoUrls'].filter((u): u is string => typeof u === 'string')
          : [],
        openAt: typeof body['openAt'] === 'string' ? body['openAt'] : null,
        closeAt: typeof body['closeAt'] === 'string' ? body['closeAt'] : null,
        // The applicant's own name and number. Contact details, not identity:
        // who is applying is applicant.userId from the session above, and
        // applyForSalon writes these onto that row and no other. There is
        // deliberately no ownerEmail here — the address an admin will reply to
        // is the verified one on the session, and accepting one from the body
        // would let an application name somebody else's inbox.
        ownerName: typeof body['ownerName'] === 'string' ? body['ownerName'] : null,
        ownerPhone: typeof body['ownerPhone'] === 'string' ? body['ownerPhone'] : null,
        services: Array.isArray(body['services'])
          ? body['services'].flatMap((raw) => {
              if (typeof raw !== 'object' || raw === null) return [];
              const svc = raw as Record<string, unknown>;
              if (typeof svc['serviceId'] !== 'string' || typeof svc['price'] !== 'number') return [];
              return [{
                serviceId: svc['serviceId'],
                price: svc['price'],
                ...(typeof svc['durationMin'] === 'number' ? { durationMin: svc['durationMin'] } : {}),
              }];
            })
          : [],
      },
    );
    return json(res, 201, { ...result, status: 'pending' });
  }

  // There is deliberately no /api/admin/* here. The admin panel is a separate
  // process bound to loopback — see src/http/admin-server.ts. Mounting it here
  // as well would put the operator's surface on the public internet behind
  // nothing but a role check, which is the arrangement this replaced.

  // ---------- business panel ----------
  if (seg[0] === 'api' && seg[1] === 'business') {
    const s = await session(db, req);
    requireRole(s, 'business');
    const handled = await businessRoutes(db, req, res, { seg, method, url, ownerId: s.userId, cache });
    if (handled) return;
    throw new HttpError(404, `No route for ${method} ${path}`);
  }

  // ---------- where am I / where is that ----------
  // Public: a customer picks their location before signing in, and both are
  // reads of a public gazetteer with nothing user-specific in them. Rate
  // limited by the global bucket, and cached upstream in src/geo/geocode.ts.
  if (method === 'GET' && path === '/api/geo/reverse') {
    const lat = Number(url.searchParams.get('lat'));
    const lng = Number(url.searchParams.get('lng'));
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      throw new HttpError(400, 'lat and lng must be numbers');
    }
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      throw new HttpError(400, 'lat and lng must be a real coordinate');
    }
    // null rather than 404: "we could not name this point" is a normal answer
    // and the client falls back to asking the customer to type a city.
    return json(res, 200, { place: await reverseGeocode(lat, lng) });
  }

  if (method === 'GET' && path === '/api/geo/search') {
    const q = url.searchParams.get('q') ?? '';
    return json(res, 200, { places: await searchPlaces(q) });
  }

  // The service catalogue an applicant picks their menu from. Public because
  // the application form needs it before anyone is a salon owner — it is a
  // list of service names, the same one every salon's menu is built from, and
  // carries nothing about any particular salon.
  if (method === 'GET' && path === '/api/services') {
    return json(res, 200, { services: await listCatalogue(db) });
  }

  // ---------- customer ----------
  if (method === 'GET' && path === '/api/salons') {
    const q = url.searchParams.get('q') ?? undefined;
    const latRaw = url.searchParams.get('lat');
    const lngRaw = url.searchParams.get('lng');
    const lat = latRaw === null ? undefined : Number(latRaw);
    const lng = lngRaw === null ? undefined : Number(lngRaw);
    if ((lat !== undefined && Number.isNaN(lat)) || (lng !== undefined && Number.isNaN(lng))) {
      throw new HttpError(400, 'lat and lng must be numbers');
    }
    const category = url.searchParams.get('category') ?? undefined;
    // The customer's current city, and a hard filter rather than a hint: with
    // one set the response carries the salons in that city and nothing else.
    // Filtering here and not in the browser is what makes that true — a
    // client that drops the parameter gets a smaller list, never a wider one,
    // and no salon a customer cannot reach ever crosses the wire.
    //
    // Absent, every city is listed. That is the visitor who has not chosen a
    // location yet, not a fallback for a city that turned out to be empty:
    // an empty city answers with an empty list, which the app renders as
    // "no salons here yet".
    const city = url.searchParams.get('city') ?? undefined;
    return json(res, 200, { salons: await listSalons(db, q, { lat, lng, city, category }) });
  }

  if (method === 'GET' && seg[0] === 'api' && seg[1] === 'salons' && seg.length === 3) {
    const salon = await getSalon(db, uuid(seg[2]!, 'salonId'));
    if (!salon) throw new HttpError(404, 'Salon not found');
    return json(res, 200, salon);
  }

  // GET /api/salons/:id/image — the storefront photo, as bytes.
  //
  // Public, like the salon card it appears on: a customer who has never signed
  // in still sees the shop. This is where salons.cover_url points once a photo
  // has been uploaded rather than linked.
  if (method === 'GET' && seg[0] === 'api' && seg[1] === 'salons' && seg[3] === 'image' && seg.length === 4) {
    const served = await serveSalonImage(db, uuid(seg[2]!, 'salonId'), req, res);
    if (served) return;
    throw new HttpError(404, 'This salon has no image');
  }

  // GET /api/salons/:id/photos/:photoId/image — one uploaded gallery photo, as
  // bytes. Public for the same reason as the storefront shot above: the gallery
  // is on the salon's public page, seen by someone who has never signed in.
  if (
    method === 'GET' &&
    seg[0] === 'api' &&
    seg[1] === 'salons' &&
    seg[3] === 'photos' &&
    seg[5] === 'image' &&
    seg.length === 6
  ) {
    const served = await serveGalleryPhoto(db, uuid(seg[2]!, 'salonId'), uuid(seg[4]!, 'photoId'), req, res);
    if (served) return;
    throw new HttpError(404, 'No such photo');
  }

  if (
    method === 'POST' &&
    seg[0] === 'api' &&
    seg[1] === 'salons' &&
    seg[3] === 'availability' &&
    seg.length === 4
  ) {
    const salonId = uuid(seg[2]!, 'salonId');
    const body = await readJson(req);
    const serviceIds = stringArray(body['serviceIds'], 'serviceIds');

    const cart = await loadCart(db, salonId, serviceIds);
    if (cart.length !== new Set(serviceIds).size) {
      throw new HttpError(400, 'Some services are not offered by this salon');
    }

    const availability = await getAvailability(db, salonId, cart, { cache });
    if (!availability) throw new HttpError(404, 'Salon not found');

    return json(res, 200, {
      salonId: availability.salonId,
      timezone: availability.timezone,
      requiredMin: availability.requiredMin,
      days: availability.days.map((d) => ({
        date: d.date,
        state: d.state,
        closedReason: d.closedReason,
        // Chairs, per slot. The client shows "2 left" and greys out a taken
        // time from this; `full` stays the bookable subset so nothing that
        // reads it has to learn about capacity to keep working.
        capacity: d.capacity,
        slots: d.slots.map((s) => ({
          at: s.at.toISOString(),
          capacity: s.capacity,
          taken: s.taken,
          remaining: s.remaining,
          state: s.state,
        })),
        full: d.full.map((t) => t.toISOString()),
        partial: d.partial.map((p) => ({
          at: p.at.toISOString(),
          freeMin: p.freeMin,
          suggest: { serviceId: p.suggest.serviceId, name: p.suggest.name, price: p.suggest.price },
        })),
      })),
    });
  }

  if (method === 'GET' && path === '/api/me') {
    const s = await session(db, req);
    // The application a customer already has in flight, if any. Without it the
    // app would keep offering "List your salon" to someone who applied last
    // week — applying is what creates the salon, so a second attempt only 409s.
    // Not part of resolveSession: this is one query for one endpoint, not
    // something every authenticated request should pay for.
    // The application, with the reason attached when it was turned down. The
    // reason already existed — an admin types it when they reject — but it
    // only ever reached other admins, so the owner saw "not approved" and no
    // way to find out what to fix. Read from the status trail rather than
    // copied onto the salon: salon_status_events is already the record of who
    // did what and why.
    const application = await db.query<{
      id: string;
      status: string;
      name: string;
      submitted_at: Date;
      reviewed_at: Date | null;
      rejection_reason: string | null;
    }>(
      `SELECT s.id, s.status, s.name, s.submitted_at,
              e.created_at AS reviewed_at,
              CASE WHEN s.status = 'rejected' THEN e.reason END AS rejection_reason
         FROM salons s
         LEFT JOIN LATERAL (
           SELECT reason, created_at
             FROM salon_status_events
            WHERE salon_id = s.id AND to_status = s.status
            ORDER BY created_at DESC
            LIMIT 1
         ) e ON true
        WHERE s.owner_id = $1`,
      [s.userId],
    );
    const salon = application.rows[0];
    return json(res, 200, {
      id: s.userId,
      role: s.role,
      // So the app can ask for verification before offering the form, instead
      // of letting someone fill it in and be refused on submit.
      emailVerified: s.emailVerified,
      salon: salon
        ? {
            id: salon.id,
            name: salon.name,
            status: salon.status,
            submittedAt: salon.submitted_at.toISOString(),
            reviewedAt: salon.reviewed_at ? salon.reviewed_at.toISOString() : null,
            rejectionReason: salon.rejection_reason,
          }
        : null,
      phone: s.phone,
      name: s.name,
      email: s.email,
      avatarUrl: s.avatarUrl,
      blockedUntil: s.blockedUntil,
    });
  }

  // DELETE /api/me — the account's owner deletes it.
  //
  // The row is anonymised, not removed: bookings, payments and reviews reference
  // it as a NOT NULL customer_id and are records that must add up. A salon owner
  // is refused here (409 OWNS_SALON) and pointed at support. The client signs
  // out of the identity provider on success — with auth_provider_id cleared, the
  // row is already unreachable by any token, so a refresh finds nobody signed in.
  if (method === 'DELETE' && path === '/api/me') {
    const s = await session(db, req);
    try {
      await deleteOwnAccount(db, s.userId);
    } catch (err) {
      if (err instanceof AccountDeletionBlockedError) {
        throw new HttpError(409, err.message, err.code);
      }
      throw err;
    }
    return json(res, 200, { ok: true });
  }

  if (method === 'GET' && path === '/api/me/bookings') {
    const s = await session(db, req);
    const now = new Date();
    const requested = url.searchParams.get('category');
    // An unknown ?category= is dropped rather than rejected: the parameter is a
    // narrowing convenience, and a typo should not 400 a customer's booking
    // list. Omitted means "all three, each tagged".
    const category = (['upcoming', 'past', 'cancelled'] as const).find((c) => c === requested);
    return json(res, 200, {
      bookings: await listCustomerBookings(db, s.userId, now, category),
      // The clock the client classifies against, and the rule it is applying.
      // Both are the server's: a phone an hour behind would otherwise hold a
      // finished booking in "Upcoming" for an extra hour, and the threshold is
      // a business rule that should not be duplicated as a literal in the view.
      serverNow: now.toISOString(),
      historyGraceMin: HISTORY_GRACE_MIN,
    });
  }

  if (method === 'POST' && seg[0] === 'api' && seg[1] === 'me' && seg[2] === 'bookings' && seg[4] === 'cancel' && seg.length === 5) {
    const s = await session(db, req);
    const bookingId = uuid(seg[3]!, 'bookingId');
    const result = await customerCancelBooking(db, s.userId, bookingId);
    await cache.invalidate(result.salonId);
    return json(res, 200, { ok: true, booking: result });
  }

  // §4: move a no-show or a cancellation to a new slot within 36 hours, at no
  // extra charge. One transaction — see booking/reschedule.ts.
  if (
    method === 'POST' &&
    seg[0] === 'api' &&
    seg[1] === 'me' &&
    seg[2] === 'bookings' &&
    seg[4] === 'reschedule' &&
    seg.length === 5
  ) {
    const s = await session(db, req);
    const bookingId = uuid(seg[3]!, 'bookingId');
    const body = await readJson(req);
    const startAt = isoDate(body['startAt']);

    const result = await rescheduleBooking(db, { bookingId, customerId: s.userId, startAt }, { cache });
    return json(res, 201, {
      id: result.booking.id,
      previousBookingId: result.previousBookingId,
      salonId: result.booking.salonId,
      startAt: result.booking.startAt.toISOString(),
      endAt: result.booking.endAt.toISOString(),
      amount: result.booking.amount,
      status: result.booking.status,
      paid: true,
    });
  }

  if (method === 'GET' && path === '/api/me/favorites') {
    const s = await session(db, req);
    return json(res, 200, { salonIds: await listFavorites(db, s.userId) });
  }

  // Full cards for the saved screen, newest first. Separate from the ids-only
  // list above, which exists to paint hearts and must stay cheap.
  if (method === 'GET' && path === '/api/me/saved') {
    const s = await session(db, req);
    return json(res, 200, { salons: await listFavoriteSalons(db, s.userId) });
  }

  if (method === 'POST' && path === '/api/me/favorites') {
    const s = await session(db, req);
    const body = await readJson(req);
    const salonId = uuid(String(body['salonId'] ?? ''), 'salonId');
    await addFavorite(db, s.userId, salonId);
    return json(res, 201, { ok: true });
  }

  if (
    method === 'DELETE' &&
    seg[0] === 'api' &&
    seg[1] === 'me' &&
    seg[2] === 'favorites' &&
    seg.length === 4
  ) {
    const s = await session(db, req);
    await removeFavorite(db, s.userId, uuid(seg[3]!, 'salonId'));
    return json(res, 200, { ok: true });
  }

  // ---------- booking + payment ----------
  //
  // Step 1 of two. This takes the chair and opens a Razorpay order; the booking
  // exists as 'pending_payment' and is holding a real slot from this moment.
  // §4 describes the reverse order (pay, then create) — that version has
  // nothing holding the chair while the payment sheet is open, so two customers
  // on the last chair both pay and one is refunded. See db/migrations/003.
  if (method === 'POST' && path === '/api/bookings') {
    // Authenticate before touching the body: an unauthenticated request should
    // not get 64KB of parsing done on its behalf.
    const customer = await session(db, req);
    limits.booking.check(`book:${customer.userId}`);

    const body = await readJson(req);
    const salonId = uuid(String(body['salonId'] ?? ''), 'salonId');
    const serviceIds = stringArray(body['serviceIds'], 'serviceIds');
    const startAt = isoDate(body['startAt']);

    const out = await withIdempotency<BookingResponse>(db, req, customer.userId, 'POST /api/bookings', body, async () => {
      const booking = await createBooking(
        db,
        { salonId, customerId: customer.userId, serviceIds, startAt },
        { cache, holdTtlMs: payments.enabled ? payments.holdTtlMs : 0 },
      );

      if (payments.provider === 'none') {
        // No provider chosen yet. The chair is really reserved and the booking
        // is real; what has not happened is a payment, and `paid: false` says
        // so rather than implying one succeeded.
        return {
          status: 201,
          body: {
            id: booking.id,
            salonId: booking.salonId,
            startAt: booking.startAt.toISOString(),
            endAt: booking.endAt.toISOString(),
            amount: booking.amount,
            status: booking.status,
            paid: false,
            warning: 'Payments are not enabled yet — this booking is reserved without payment.',
          },
        };
      }

      const checkout = await openCheckout(db, payments, booking.id, customer.userId);
      return {
        status: 201,
        body: {
          id: booking.id,
          salonId: booking.salonId,
          startAt: booking.startAt.toISOString(),
          endAt: booking.endAt.toISOString(),
          amount: booking.amount,
          status: booking.status,
          holdExpiresAt: booking.holdExpiresAt ? booking.holdExpiresAt.toISOString() : null,
          paid: false,
          checkout,
        },
      };
    });

    return json(res, out.status, out.body);
  }

  // Re-open checkout for a hold that is still live — a customer who reloaded
  // the page, or dismissed the sheet and changed their mind.
  if (
    method === 'POST' &&
    seg[0] === 'api' &&
    seg[1] === 'bookings' &&
    seg[3] === 'checkout' &&
    seg.length === 4
  ) {
    const customer = await session(db, req);
    const bookingId = uuid(seg[2]!, 'bookingId');
    return json(res, 200, await openCheckout(db, payments, bookingId, customer.userId));
  }

  // Step 2 of two: the browser's success callback. The signature is what makes
  // this endpoint safe to expose — see payments/service.ts.
  if (
    method === 'POST' &&
    seg[0] === 'api' &&
    seg[1] === 'bookings' &&
    seg[3] === 'confirm' &&
    seg.length === 4
  ) {
    const customer = await session(db, req);
    const bookingId = uuid(seg[2]!, 'bookingId');
    const body = await readJson(req);

    const result = await confirmCheckout(
      db,
      payments,
      {
        bookingId,
        customerId: customer.userId,
        // Cashfree posts `orderId`; Razorpay posts the razorpay_* triple. The
        // service branches on provider, so the unused fields are simply empty.
        orderId: String(body['orderId'] ?? body['razorpay_order_id'] ?? ''),
        paymentId: String(body['razorpay_payment_id'] ?? ''),
        signature: String(body['razorpay_signature'] ?? ''),
      },
      { cache },
    );

    // 202 for a payment that landed too late: the money is real, the booking is
    // not, and a refund is queued. A 200 here would have the app show a
    // confirmation screen for a booking that does not exist.
    return json(res, result.outcome === 'refunding' ? 202 : 200, {
      bookingId: result.bookingId,
      outcome: result.outcome,
      status: result.status,
      paid: result.outcome !== 'refunding',
      message:
        result.outcome === 'refunding'
          ? 'Your payment arrived after the slot was taken. A full refund is on its way.'
          : 'Booking confirmed.',
    });
  }

  if (method === 'GET' && seg[0] === 'api' && seg[1] === 'bookings' && seg.length === 3) {
    const booking = await getBooking(db, uuid(seg[2]!, 'bookingId'));
    if (!booking) throw new HttpError(404, 'Booking not found');
    return json(res, 200, booking);
  }

  throw new HttpError(404, `No route for ${method} ${path}`);
}

function isoDate(value: unknown): Date {
  if (typeof value !== 'string') throw new HttpError(400, 'startAt must be an ISO-8601 string');
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new HttpError(400, 'startAt is not a valid date');
  return d;
}

/**
 * Turn a thrown error into a response.
 *
 * Every branch here is a deliberate status code. The default is 500 with no
 * detail: an unexpected error's message can contain a SQL fragment or a
 * connection string, and the customer does not need either.
 */
/**
 * The Digital Asset Links statement, or null when there is nothing to say.
 *
 * Read from env on every request rather than at boot so the value can be added
 * to a running deployment without a restart — the whole failure this addresses
 * is that it was never set at all, and the endpoint 404'd in production while
 * the APK sat there claiming links nobody vouched for.
 *
 * Null rather than an empty list: `relation: []` is a positive statement that
 * NO app may handle these links, and Android caches the answer.
 */
export function assetLinkStatements(): unknown[] | null {
  const fingerprints = (process.env['ANDROID_CERT_FINGERPRINTS'] ?? '')
    .split(',')
    .map((f) => f.trim().toUpperCase())
    .filter(Boolean);
  if (fingerprints.length === 0) return null;
  return [
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: process.env['ANDROID_PACKAGE'] ?? 'com.hasino.app',
        sha256_cert_fingerprints: fingerprints,
      },
    },
  ];
}

export function respondToError(res: ServerResponse, err: unknown): void {
  if (res.headersSent) return;

  if (err instanceof RateLimitError) {
    res.setHeader('retry-after', String(err.retryAfterSec));
    return json(res, 429, { error: err.message, code: 'RATE_LIMITED' });
  }
  if (err instanceof HttpError) {
    return json(res, err.status, { error: err.message, ...(err.code ? { code: err.code } : {}) });
  }
  if (err instanceof ImageUploadError) {
    return json(res, err.status, { error: err.message, code: err.code });
  }
  if (err instanceof AuthError) return json(res, err.status, { error: err.message, code: err.code });
  if (err instanceof ForbiddenError) return json(res, 403, { error: err.message, code: err.code });
  if (err instanceof AdminError) return json(res, err.status, { error: err.message, code: err.code });
  if (err instanceof WebhookSignatureError) {
    // 400, not 401: Razorpay does not retry a 4xx, and a body we cannot verify
    // is one we never want again.
    return json(res, 400, { error: 'Invalid signature', code: 'BAD_SIGNATURE' });
  }
  if (err instanceof SlotUnavailableError) {
    return json(res, 409, { error: err.message, code: err.code });
  }
  if (err instanceof PaymentError) {
    const status =
      err.code === 'BAD_SIGNATURE' ? 403
      : err.code === 'PAYMENT_NOT_FOUND' ? 404
      : err.code === 'PAYMENTS_DISABLED' ? 503
      : err.code === 'VERIFY_UNAVAILABLE' ? 503
      : 400;
    return json(res, status, { error: err.message, code: err.code });
  }
  if (err instanceof BookingError) {
    const status =
      err.code === 'CUSTOMER_BLOCKED' ? 403
      : err.code === 'NOT_FOUND' ? 404
      : err.code === 'INVALID_TRANSITION' ? 409
      : err.code === 'RESCHEDULE_LIMIT' ? 409
      : err.code === 'RESCHEDULE_EXPIRED' ? 410
      // Early, not wrong: the same request succeeds once the customer's
      // 15 minutes of grace have run out.
      : err.code === 'NO_SHOW_TOO_EARLY' ? 409
      : 400;
    return json(res, status, {
      error: err.message,
      code: err.code,
      // When the answer is "not yet", the caller needs the minute, not a
      // rounded description of it.
      ...(err instanceof NoShowTooEarlyError ? { availableAt: err.availableAt.toISOString() } : {}),
    });
  }

  reportError(err, { unhandled: true });
  return json(res, 500, { error: 'Internal error' });
}

export function buildServer(db: Pool): Server {
  return createServer((req, res) => {
    const requestId = newRequestId(req.headers['x-request-id']);
    const startedAt = Date.now();

    void withRequestContext({ requestId, route: `${req.method} ${req.url}` }, async () => {
      res.setHeader('x-request-id', requestId);
      securityHeaders(res, IS_PROD);

      res.on('finish', () => {
        const ms = Date.now() - startedAt;
        // Assets are the majority of requests and none of the interest.
        const noisy = req.url?.startsWith('/lib/') || req.url?.startsWith('/components/') ||
                      req.url?.startsWith('/views/') || req.url?.endsWith('.css');
        if (!noisy || res.statusCode >= 400) {
          log[res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info']('request', {
            method: req.method,
            path: req.url,
            status: res.statusCode,
            ms,
          });
        }
      });

      try {
        if (applyCors(req, res, allowedOrigins)) return;
        // The webhook is exempt: Razorpay's retry storm during an incident is
        // exactly when we must not start dropping their deliveries, and the
        // signature already gates it.
        if (req.url !== '/api/webhooks/razorpay') {
          limits.global.check(clientKey(req, TRUST_PROXY));
        }
        await route(db, req, res);
      } catch (err) {
        respondToError(res, err);
      }
    });
  });
}

export function start(): void {
  if (IS_PROD) {
    const fatal: string[] = [];

    // Both flags, not just their conjunction. Either one set in production is
    // a misconfiguration worth refusing on: DEV_AUTH means someone intended
    // the bypass, and CI_SMOKE is the other half of the key.
    if (DEV_AUTH_REQUESTED) {
      fatal.push(
        'DEV_AUTH=true trusts an unverified x-dev-user header. Anyone could book, ' +
          'cancel, or edit any salon as anyone else.',
      );
    }
    if (CI_SMOKE) {
      fatal.push(
        'CI_SMOKE=true enables the DEV_AUTH bypass and the /api/dev/* routes. ' +
          'It exists for the smoke test harness and must never be set in production.',
      );
    }
    // Fail at boot, not on the first customer's request.
    if (!process.env['CLERK_SECRET_KEY']) {
      fatal.push(
        'No CLERK_SECRET_KEY. Without it no session token can be verified and every ' +
          'authenticated request would fail at runtime instead of at boot.',
      );
    }
    if (!process.env['CLERK_PUBLISHABLE_KEY']) {
      fatal.push(
        'No CLERK_PUBLISHABLE_KEY. The browser reads it from GET /api/config; without it ' +
          'the pages load but nobody can sign in.',
      );
    }
    // Payment credentials are deliberately NOT fatal any more. Hasino has not
    // chosen a provider yet, and running with provider 'none' is a supported
    // state: bookings are taken, no money moves, and nothing pretends
    // otherwise. Refusing to boot would only mean the choice of provider
    // blocks the pilot.
    //
    // The guard that matters is still here: a provider that IS configured must
    // have its webhook secret, because a half-configured Razorpay debits
    // customers whose webhooks then fail their signature check.
    if (payments.provider === 'razorpay' && !process.env['RAZORPAY_WEBHOOK_SECRET']) {
      fatal.push(
        'RAZORPAY_KEY_ID/SECRET are set but RAZORPAY_WEBHOOK_SECRET is not. Every webhook ' +
          'would fail its signature check, and any customer who closes the tab mid-payment ' +
          'is debited with no booking. Set it, or set PAYMENTS_PROVIDER=none.',
      );
    }

    if (fatal.length > 0) {
      console.error('Refusing to start:\n' + fatal.map((f) => `  - ${f}`).join('\n'));
      process.exit(1);
    }
  }

  const port = Number(process.env['PORT'] ?? 3000);
  const db = getPool();
  const server = buildServer(db);

  let workers: RunningWorkers | null = null;
  // One process runs both by default, which is right for one box. Set
  // RUN_WORKERS=false on the web tier and true on a worker dyno to split them;
  // the advisory locks in workers/runner.ts already make that safe.
  if (process.env['RUN_WORKERS'] !== 'false') {
    workers = startWorkers({
      db,
      razorpay: payments.client,
      channel: channelFromEnv(),
      cache,
    });
  }

  server.listen(port, () => {
    log.info('listening', {
      port,
      auth: DEV_AUTH ? 'DEV_AUTH' : verifier.kind,
      payments: payments.enabled ? payments.client.kind : 'disabled',
      workers: workers ? 'in-process' : 'off',
    });
    console.log(`hasino  →  http://localhost:${port}          (customer)`);
    console.log(`        →  http://localhost:${port}/business (salon panel)`);
    if (DEV_AUTH) {
      log.warn('DEV_AUTH is on — authentication is bypassed. CI only.');
    } else if (DEV_AUTH_REQUESTED) {
      // Ignored, loudly. Silently honouring it would be a server that trusts a
      // header; silently dropping it would look like the flag was broken.
      log.warn(
        'DEV_AUTH=true was ignored: it now also requires CI_SMOKE=true, which exists ' +
          'for the smoke-test harness. Local development signs in with real Google auth — ' +
          'set CLERK_PUBLISHABLE_KEY and CLERK_SECRET_KEY in .env. Authentication is ON.',
      );
    }
    if (!payments.enabled) console.warn('Razorpay is not configured — bookings will be unpaid.');
  });

  /**
   * Shutdown, in order: stop accepting, let in-flight requests finish, stop the
   * workers, then close the pool. A hard deadline sits over the whole thing
   * because an orchestrator will SIGKILL after ~30s regardless, and a
   * half-finished graceful shutdown is worse than a clean fast one.
   */
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('shutting down', { signal });

    const deadline = setTimeout(() => {
      log.warn('shutdown deadline exceeded, exiting anyway');
      process.exit(1);
    }, 15_000);
    deadline.unref();

    server.close(() => {
      void (async () => {
        try {
          await workers?.stop();
          await db.end();
        } catch (err) {
          reportError(err, { during: 'shutdown' });
        }
        clearTimeout(deadline);
        process.exit(0);
      })();
    });
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => shutdown(signal));

  // A rejection nobody handled is a bug, and a process that keeps serving after
  // one is a process in an unknown state. Log it with its stack and let the
  // orchestrator restart a clean one.
  process.on('unhandledRejection', (reason) => {
    reportError(reason, { fatal: 'unhandledRejection' });
  });
  process.on('uncaughtException', (err) => {
    reportError(err, { fatal: 'uncaughtException' });
    shutdown('uncaughtException');
  });
}
