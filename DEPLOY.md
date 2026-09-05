# Deploying

## Status

Deployable, and now takes money. Clerk and Razorpay are both
implemented, and `NODE_ENV=production` refuses to boot without either — a server
that serves bookings it cannot authenticate, or takes bookings it cannot charge
for, should not start at all.

Verified locally in production mode:

```
/healthz                     -> {"ok":true}          (no DB call, by design)
/readyz                      -> {"ok":true,"auth":"clerk","payments":"razorpay"}
GET /api/salons              -> 200   (browsing stays public)
GET /                        -> 200   (customer app, real Google sign-in)
GET /api/dev/identities      -> 404
POST /api/dev/pay            -> 404   (stub-only, and only under DEV_AUTH)
x-dev-user: <uuid>           -> 401 NO_TOKEN      (dev header is inert)
Authorization: Bearer junk   -> 401 INVALID_TOKEN (real signature check)
POST /api/webhooks/razorpay  -> 400 BAD_SIGNATURE (unsigned body refused)
```

## Deploy it

You need four accounts. I cannot create them — do these yourself:

**1. Clerk project** → Authentication → enable Phone and Google. Project
settings → Service accounts → *Generate new private key*.

**2. Razorpay account** → Dashboard → Account & Settings → API Keys. Test keys
(`rzp_test_*`) work end to end against Razorpay's sandbox; live keys need the
account activated, which needs a registered business entity and a current
account. Start that early — it is the long pole.

**3. Managed Postgres** — Railway, Render, Neon, Supabase. Copy the connection
string; make sure it forces SSL.

**4. A host** — Railway, Render, Fly, or Cloud Run. All take the Dockerfile.

Then:

```bash
DATABASE_URL=... node scripts/migrate.ts
```

One command either way: on an empty database it applies `db/schema.sql` first
and then the migrations, and on one that already has tables it applies only the
migrations it is missing.

Set these on the host:

| Variable | Value |
|---|---|
| `DATABASE_URL` | your Postgres URL, SSL on |
| `NODE_ENV` | `production` |
| `CLERK_SECRET_KEY` | sk_live_… — signs and reads on the server, never sent to a browser |
| `CLERK_PUBLISHABLE_KEY` | pk_live_… — served to the browser from GET /api/config |
| `RAZORPAY_KEY_ID` | Dashboard → API Keys |
| `RAZORPAY_KEY_SECRET` | shown once, at creation |
| `RAZORPAY_WEBHOOK_SECRET` | a **different** secret — set when you create the webhook |
| `PLATFORM_COMMISSION_BPS` | optional, default `1500` (15%) |
| `TRUST_PROXY` | `true` only if something in front appends `X-Forwarded-For` |
| `RESEND_API_KEY` + `EMAIL_FROM` | optional; without them emails print to stdout |
| `ADMIN_EMAILS` | comma-separated Google addresses that get `/admin` |
| `PORT` | usually injected by the host |
| `DEV_AUTH` | **leave unset** — the server refuses to start with it |
| `CI_SMOKE` | **leave unset** — same |
| `PAYMENTS_PROVIDER` | `none` until a provider is chosen; bookings work without one |
| `RAZORPAY_*` | all optional — the server boots and takes bookings without them |

The four `CLERK_*` values are not secret — they ship to the browser via
`GET /api/config`, alongside `RAZORPAY_KEY_ID`. They are environment variables so
staging and production can point at different projects. The two **secrets**
(`RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`) never leave the server.

In the Clerk dashboard also enable **Google** under Authentication → Sign-in
method, and add your production domain under Authentication → Settings →
Authorized domains. Google supplies the whole identity, so a first sign-in
creates the account outright — nothing else is collected. Leave **Phone** off:
turning it on makes Clerk park new sign-ups at `missing_requirements` waiting
for a number this app never asks for.

Clerk must also be allowed to redirect back to `/sso-callback`, which is a real
served path rather than a hash route — see `PAGES` in `src/http/server.ts`.

`CLERK_SECRET_KEY` (a file path) works instead of
`CLERK_SECRET_KEY` and is what Cloud Run injects for free.

Deploy. `/readyz` should report `"auth":"clerk"` and `"payments":"razorpay"`.

## A free deploy, for testing only

`render.yaml` in the repo root is a working blueprint for Render's free web
service plus Neon's free Postgres. Neither asks for a card. The `fly.toml` next
to it is kept for the day this becomes a real pilot — Fly will not create an
app at all without payment on file.

What free costs you, and it is not nothing:

- The service **sleeps** after ~15 minutes idle and cold-starts in 30-60s. The
  first request after a quiet spell is slow. That is Render, not the app.
- The workers run inside the web process (`startWorkers`, `src/http/server.ts`).
  Asleep, nothing sweeps expired holds, retries refunds or sends queued mail.
  They catch up on wake because each sweeps by timestamp rather than by tick,
  so nothing is lost — it is just late, by however long nobody visited. A chair
  stays held meanwhile. Testing, yes. A pilot with real customers, no.
- Neon's free branch also idles to sleep; the first query after that pays a
  second or so of wake-up on top.

The order matters — the database has to exist and have a schema before the
service boots, because `NODE_ENV=production` boots straight into workers that
query it.

1. **Neon** → new project, region Singapore (`ap-southeast-1`), copy the
   *pooled* connection string. It ends in `?sslmode=require`; keep that. `pg`
   turns that into a verified TLS connection against Node's CA store, which
   Neon's certificate satisfies — if you hit a certificate error, fix the cause
   rather than reaching for `sslmode=no-verify`, which turns verification off
   and makes the connection interceptable.
2. Load the schema from your machine, not from the host:

   ```bash
   DATABASE_URL='<neon url>' node scripts/migrate.ts
   ```

   `node scripts/migrate.ts --status` first if you want to see what would run.
3. **Render** → New → Blueprint → point at this repo. It reads `render.yaml`
   and asks for the four values marked `sync: false`: `DATABASE_URL`,
   `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `ADMIN_EMAILS`. Test Clerk keys
   (`pk_test_*` / `sk_test_*`) are fine here.
4. In Clerk → **Domains**, add the `https://hasino.onrender.com` URL Render
   hands you. Sign-in fails silently against an origin Clerk has not been told
   about.
5. `curl https://<your-host>/readyz` → `{"ok":true,"auth":"clerk","payments":"disabled"}`.
   `"payments":"disabled"` is correct here, not a failure: the blueprint sets
   `PAYMENTS_PROVIDER=none`, so bookings hold real chairs and no money moves.

Do not put a `PORT` in Render's environment. Render injects its own and
`src/main.ts` reads it; pinning 3000 gets you a service that builds, boots, and
is never routed to.

The admin panel does **not** go to Render. It is a separate process that binds
loopback on purpose and refuses to start on a routable address. To administer
this database, tunnel to Neon and run `npm run admin` locally against it.

## The webhook is not optional

Razorpay Dashboard → Settings → Webhooks → Add New Webhook:

```
URL     https://<your-host>/api/webhooks/razorpay
Secret  the value of RAZORPAY_WEBHOOK_SECRET
Events  payment.captured   payment.failed   order.paid
        refund.processed   refund.failed
```

Skip this and every customer who closes the tab on the UPI screen is debited
with no booking. The browser callback confirms most payments in under a second,
but it only runs if the browser is still there; the webhook is what covers the
ones where it isn't.

Verify the secret matches by watching for `webhook … outcome=processed` in the
logs after a test payment. A mismatch shows up as `400 BAD_SIGNATURE` on every
delivery — loudly, which is the intent.

### Testing it before launch

With test keys, Razorpay's sandbox accepts UPI id `success@razorpay` and the
card `4111 1111 1111 1111` with any future expiry and any CVV. Run one booking
through, then check the salon's **Money** screen: a `sale` and a `commission`
entry should appear, and the balance should equal gross minus the cut.

## Making yourself a salon owner

Roles never come from token claims — a new account is always `customer`. To
onboard a salon, insert the row and let the owner sign in with that phone; the
next sign-in adopts it:

```sql
INSERT INTO users (phone, name, role) VALUES ('+919876543210', 'Owner', 'business');
INSERT INTO salons (owner_id, name, address, lat, lng, status, commission_bps)
VALUES ((SELECT id FROM users WHERE phone='+919876543210'),
        'Salon Name', 'Address', 12.97, 77.59, 'active', 1500);
```

`commission_bps` is per-salon, so a launch deal is a column, not a code change.

## What going live still means

**Money sits with you, not the salon.** Payments land in the platform's Razorpay
account and each salon's share is tracked in `ledger_entries`. That is a real
obligation: you are holding their money between the booking and the payout.
Two consequences worth being deliberate about —

- **Payouts are recorded, not sent.** `createPayoutForPeriod` writes the payout
  and the matching ledger entry so the salon's screen and your books agree, but
  the actual transfer is a manual RazorpayX or bank action today. Nothing will
  chase you if you forget.
- **Check whether you need an aggregator licence.** Holding customer funds on
  behalf of merchants is what RBI's PA/PG rules govern. Razorpay Route exists
  specifically so platforms can split payments without becoming an aggregator —
  `salons.rzp_route_account_id` is where linked accounts attach when you enable
  it. Get this looked at by someone qualified before scale, not after.

**No reconciliation.** Nothing compares our `payments` table against Razorpay's
settlement report. A payment Razorpay recorded and we did not is currently
invisible. This is the first thing to build after launch.

**No mobile app.** The customer surface the spec plans is React Native (step 7).
What ships is the API plus two web surfaces, which are real and usable but are
not an app-store presence. A native client sends the same
`Authorization: Bearer <Clerk session token>`.

**Reminders are email only.** The outbox supports `sms`, `whatsapp` and `push`
channels and parks those rows as `skipped` rather than dropping them — switching
one on is a worker change, not a backfill. For salon bookings in India, WhatsApp
is probably what customers actually read.

**Most customers have no phone number on file.** `users.phone` is nullable
(migration `006`) because Google carries no number and nothing asks for one. A
salon reaches a customer by email; a number is present only on owner rows an
admin typed one into. Anything rendering a customer phone must handle null.

## Workers

The three background jobs (hold sweep, refunds, notifications) run in the web
process by default, which is right for one box. Each tick takes a
`pg_try_advisory_lock`, so scaling to N instances does not run N sweepers.

To split them out, run the same image twice:

```
web     RUN_WORKERS=false
worker  RUN_WORKERS=true   (and no inbound traffic)
```

Nothing about correctness depends on the workers running. An expired hold stops
consuming a chair by the clock, not by being swept — a dead worker leaves stale
rows and unsent email, never an oversold slot.

## Keeping the free service awake

A Render **free** web service spins down after **15 minutes with no inbound
HTTP traffic**, and the next visitor pays for the wake. Measured on this
deployment: **13.5s**. Render documents up to a minute. That loading page is
the platform, not the app.

The fix is inbound HTTP on a clock, from outside. **cron-job.org** does it —
free, no card, one-minute resolution — fetching:

```
https://hasino.onrender.com/healthz     every 10 minutes
```

`/healthz` is the right target: it answers without touching Postgres, so it
wakes the process without loading the database every few minutes.

Nothing in this repo schedules that, and nothing should. cron-job.org fetches
the URL from its own servers; it does not run our code, so the request *is* the
whole job. A CI workflow doing the same thing on its own clock would be a
second scheduler to maintain that changes no outcome.

### Restrict it to 00:00-18:00 UTC

**This part is not optional, and cron-job.org does not do it by default.**

Render gives a **workspace** 750 free instance-hours per calendar month, shared
across every free service, and a sleeping service consumes none. A 31-day month
is 744 hours:

| Coverage | Instance-hours/month | Result |
|---|---|---|
| 24/7, one service | ~744 | Admin panel gets ~6 hours, then **every** free service is suspended until the 1st |
| 18h/day, one service | ~564 | ~186 hours spare for the admin panel and overnight traffic |
| 18h/day, both services | ~1128 | Everything goes dark around the 16th |

So in the cron-job.org job's schedule, select **hours 0-17 UTC** and leave the
rest unchecked. That is **05:30-23:30 IST**, which covers every plausible
booking hour. A visitor at 3am still waits for a cold start; that is the price
of staying inside the budget, and it is cheaper than the whole workspace going
dark mid-month.

Point it at `hasino` only. **Do not add a second job for `hasino-admin`.**

### Confirming it actually works

Do not trust a fast reply, and do not trust the pinger's own dashboard. Asking
is what makes the service awake, so a quick response proves nothing about the
minute before you asked — and a scheduler showing green rows only proves it
sent a request somewhere. This repo has already had one cron that was
configured, showed no errors, and had never run.

`/healthz` reports `uptimeSeconds`. A free-tier spin-down destroys the process,
so uptime is time since the last cold start, and one request settles it:

```
curl -s https://hasino.onrender.com/healthz
{"ok":true,"uptimeSeconds":15042}
```

- **Uptime of hours** — nothing has let the service sleep. It is working.
- **Uptime of seconds** — this request woke it. It is **not** working.

Check it after the service has been left alone for a while, not right after
loading the site yourself.

`scripts/keepalive.ts` wraps the same request and states the verdict in words:

```
KEEPALIVE_URL=https://hasino.onrender.com/healthz node scripts/keepalive.ts
```

```
keepalive: service uptime 4h 12m — it has not been allowed to sleep in that
time, so the pinger is working.
```

Set `KEEPALIVE_EXPECT_AWAKE=true` to make it exit 1 on a just-woken service, so
it can be a monitored check rather than something a human reads.

### Two ways a keepalive silently reports green, both guarded

Both are Render answering *instead of* the app, so the request never wakes it:

- **`/robots.txt`** — Render's edge serves it while a service is spun down. The
  script refuses to start if pointed there.
- **A mistyped hostname** — an unrouted `*.onrender.com` host returns `404` with
  `x-render-routing: no-server`. Counting any HTTP status as success would read
  that as healthy forever. The script treats that header as a failed ping.

### Running the pinger somewhere else

If cron-job.org ever lapses, `scripts/keepalive.ts` is the same request in a
form any scheduler can run — a laptop, a spare box, a paid Render cron. It
depends on nothing but Node: no database, no provider keys.

Env: `KEEPALIVE_INTERVAL_MS` (default 300000), `KEEPALIVE_DURATION_MS` (default
300000; **0 means ping once and exit**, which is the right shape for a
scheduler with its own cadence), `KEEPALIVE_TIMEOUT_MS` (30000),
`KEEPALIVE_ATTEMPTS` (3). Exit 0 if a ping reached the app, 1 if none did.

### The background jobs are a different problem

The `hasino-jobs` cron in `render.yaml` **has never run** — `GET /readyz`
returns `"cron": null`, and that field is written on every invocation, because
Render Cron Jobs are not on the free plan. It would not have fixed cold starts
anyway: it talks to Postgres and never sends the web service an HTTP request,
and the idle timer only counts HTTP.

The keepalive covers it as a side effect. While the web service is awake,
`startWorkers()` is running its interval loops, so holds expire and mail sends
on time. Between 18:00 and 00:00 UTC the jobs pause; every job sweeps by
timestamp rather than by tick, so they catch up on the next wake instead of
losing work.

## Migrations

`db/schema.sql` is the whole schema — the baseline, not a migration. The
numbered files are deltas layered on top of it, which is why `001` opens with
`ALTER TABLE users` and fails on an empty database with `relation "users" does
not exist` if the baseline never ran.

`scripts/migrate.ts` handles both halves. It applies `db/schema.sql` first when
`users` does not exist, then applies `db/migrations/*.sql` in order, once each,
recording filename + checksum + duration in `schema_migrations` (the baseline
lands there as `000_schema.sql`). A database that already has tables — one
installed by hand with `psql -f db/schema.sql` before the runner existed — gets
only the deltas: the baseline is skipped on the presence of `users`, not on an
empty ledger, so nothing re-creates tables under a live pilot.

```bash
npm run db:migrate:status   # what would run
npm run db:migrate          # run it
```

Each file runs in a transaction (Postgres has transactional DDL, so a failure
leaves the schema untouched) and the whole run holds an advisory lock, so two
containers booting together cannot interleave. Editing a migration that has
already run is **refused** — the checksum will not match, and the fix is a new
file rather than a schema that differs per environment.

CI asserts that `schema.sql` and the migrations have not drifted: it builds a
database from `schema.sql`, then runs every migration against it. A migration
that is not re-runnable fails there rather than against production on a Friday.

Do **not** run `npm run db:seed` against production; it truncates every table.
It refuses when `NODE_ENV=production` unless `ALLOW_DESTRUCTIVE_SEED=true`.

## Rollback

The schema changes in `003_payments.sql` are additive — new tables, new columns,
a widened `CHECK` constraint. An older build will run against the new schema
with one caveat: it does not know about `pending_payment`, so live holds become
invisible to its availability query and those chairs are sellable twice for as
long as the rollback lasts. If you must roll back, expire the holds first:

```sql
UPDATE bookings SET status = 'expired'
 WHERE status = 'pending_payment';
```

Anyone mid-payment is then refunded by the normal late-capture path.


## The admin panel is a separate process

`npm start` runs the public application: the customer app and the salon panel.
It has no admin route, no admin asset and no `/api/admin/*`. There is nothing
to protect with a firewall rule because there is nothing there — and that stays
true no matter where the panel itself runs.

By default the panel is a second process on your own machine:

```bash
npm run admin      # http://127.0.0.1:4000
```

It binds to loopback. That is not a configuration you can get wrong from the
outside — the operating system will not accept a connection to a loopback
socket from another host, whatever the firewall or the reverse proxy say.

### Hosting it instead (ADMIN_PUBLIC)

An operator who has to approve a salon from a phone cannot do it through a
loopback socket. `ADMIN_PUBLIC=true` hosts the panel as its own service —
`render.yaml` defines `hasino-admin`, the same image with `dockerCommand: node
src/admin-main.ts`.

**Understand what this trades before you set it.** On loopback the operating
system refused every outside connection and Clerk was the second lock. Public,
**Clerk and `ADMIN_EMAILS` are the only locks.** Every `/api/admin/*` route
verifies a Clerk token and checks the admin role — that was always true, which
is the only reason this is a reasonable thing to do at all — but nothing else
stands in front of it now. `ADMIN_EMAILS` stops being configuration and becomes
a credential: anyone who can sign in to Google as one of those addresses
administers Hasino from anywhere on the internet. Put 2FA on those accounts,
and keep the list to people who genuinely need it.

Public changes four things:

| | |
|---|---|
| bind | `0.0.0.0` on the host's injected `PORT` (do not set `ADMIN_PORT`) |
| rate limit | 120/min per caller, `ADMIN_RATE_LIMIT_PER_MIN` to change — there was none before, because the network was the limit |
| HSTS | sent, since the panel is now HTTPS |
| boot | refuses outright if `DEV_AUTH`/`CI_SMOKE` are set, either Clerk key is missing, or `ADMIN_EMAILS` is empty |

That last one is the important one: a public panel with a hole in the perimeter
does not come up half-locked, it does not come up. `ADMIN_HOST` alone still
cannot reach a routable interface in production — a hostname is the shape a
mistake takes, and `ADMIN_PUBLIC` is the shape a decision takes.

The customer-facing service is untouched by any of this. It has no admin code
in it to expose, which is why hosting the panel is additive rather than a
widening of the public app.

### Administering production data

The admin panel reads `DATABASE_URL`, exactly as the public app does. The
hosted service takes it as an environment variable like everything else. To
work against production from your laptop instead, point the panel at the
production database directly — a managed Postgres like Neon is reachable over
TLS, so there is nothing to tunnel:

```bash
set -a; . ./.env; set +a
DATABASE_URL='<production url>' npm run admin
```

For a database that is not reachable from outside its network, tunnel first and
point at the tunnel:

```bash
ssh -N -L 5433:<db-host>:5432 <your-server>          # in one terminal
DATABASE_URL=postgres://user:pass@localhost:5433/hasino npm run admin
```

An approval made this way writes the same row the deployed app reads, so the
salon is live the moment you click Approve. There is no local copy of the data,
nothing to sync, and no second source of truth.

No Clerk dashboard change is needed for local use. A **development** instance
accepts any localhost origin, and has no Domains list to add one to; the panel
signs in on `127.0.0.1:4000` by itself. A Clerk session belongs to one origin,
so being signed in on the public app grants nothing here — that is the
separation working, not a fault.

`lib/auth.js` is shared by both apps, and its default redirect URLs are the
customer app's hash routes. The panel calls `configureAuthRoutes()` with its
own before Clerk loads. Without that, Clerk sends the browser to `#/login`,
which this router does not have, and the sign-in silently falls back to
`#/overview` looking like a button that does nothing.

One thing to decide later: a Clerk **production** instance is locked to your
own domain, so pointing the local panel at one is not the same as pointing it
at a dev instance. The simplest answer is to keep using the development
instance for the admin panel, or to give the panel its own Clerk application.

`ADMIN_EMAILS` still decides who gets in, and every route still runs
`requireRole(s, 'admin')` against a verified Clerk token. Being on loopback is
not the authorisation: anyone with an account on the laptop can reach the port.
