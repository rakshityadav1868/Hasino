/**
 * Keep a free-tier Render web service awake by giving it inbound HTTP traffic
 * on a clock.
 *
 * The problem
 * -----------
 * A Render FREE web service spins down after 15 minutes with no INBOUND
 * TRAFFIC, and the next visitor waits through a cold start — measured on this
 * deployment at 13.5s, advertised by Render at up to a minute. That is the
 * "Render image" the user sees before the app appears.
 *
 * Why the existing cron did not fix it
 * -----------------------------------
 * The `hasino-jobs` Render Cron Job in render.yaml runs `scripts/run-jobs.ts`
 * in a SEPARATE container that talks to Postgres and never makes an HTTP
 * request to the web service. Render's idle timer counts inbound HTTP and
 * WebSocket traffic only, so a database-only cron cannot reset it no matter how
 * often it runs. (It also never ran: GET /readyz reported `"cron": null`,
 * because Render Cron Jobs are not part of the free plan.)
 *
 * What this does instead
 * ----------------------
 * It makes real HTTP requests from outside. That is the only thing that resets
 * the idle timer, and it has a second effect worth as much: while the web
 * process is awake, startWorkers() in src/workers/runner.ts keeps running, so
 * holds expire and queued mail sends on time. Keeping the service awake is
 * therefore also the free replacement for the paid jobs cron.
 *
 * Two constraints shape every default below.
 *
 *   1. The idle timer is 15 minutes. Pings must land well inside that, with
 *      room for one to fail entirely.
 *   2. A workspace gets 750 free instance-hours PER CALENDAR MONTH, shared
 *      across every free service. A 31-day month is 744 hours, so pinging one
 *      service around the clock consumes essentially the whole allowance and
 *      leaves the admin panel a few hours before Render suspends every free
 *      service until the 1st. Round-the-clock keepalive is not a free win; it
 *      is a budget decision. The scheduler — not this module — owns that daily
 *      window; DEPLOY.md carries the arithmetic and the settings.
 *
 * What counts as awake
 * --------------------
 * Any HTTP status the APPLICATION produced. A 500 still means a container
 * answered, which is all the idle timer cares about. A network-level failure
 * (DNS, connect refused, timeout) means nothing was reached. The script fails
 * only when every ping in a run failed that way, so a red run means the URL is
 * wrong or the service is suspended rather than that one request blipped.
 *
 * The exception is a reply Render produced INSTEAD of the app, which is worth
 * stating separately because it is the one that reads as success. Two forms,
 * both confirmed against production:
 *
 *   - /robots.txt, which Render's edge serves while a service is spun down, so
 *     the request never reaches the app and never wakes it;
 *   - an unrouted hostname — a typo in the service name — which returns 404
 *     with `x-render-routing: no-server`.
 *
 * Both go green under a naive "any status is fine" rule while the service
 * sleeps untouched. keepaliveConfigFromEnv() refuses the first and
 * servedByRenderEdge() catches the second.
 *
 * /healthz is the right target: it returns without touching Postgres (see
 * src/http/server.ts), so it wakes the process without loading the database
 * every few minutes, and it reports the uptime that makes the whole
 * arrangement verifiable — see readUptimeSeconds() below.
 */

/** Render spins a free web service down after this long without inbound traffic. */
export const RENDER_IDLE_TIMEOUT_MS = 15 * 60_000;

export interface KeepaliveConfig {
  /** Absolute URL to request. Should be the web service's own /healthz. */
  url: string;
  /** How long to wait between pings. */
  intervalMs: number;
  /** How long this process keeps pinging before exiting. */
  durationMs: number;
  /** Per-attempt timeout. Must tolerate a cold start, not just a warm reply. */
  timeoutMs: number;
  /** Attempts per ping, so one cold-start timeout does not cost the whole slot. */
  attempts: number;
}

export interface PingResult {
  awake: boolean;
  status: number | null;
  ms: number;
  error: string | null;
  attempts: number;
  /**
   * Seconds since the web process started, as reported by /healthz, or null if
   * the endpoint did not report it. This is the number that says whether the
   * keepalive is working — see readUptimeSeconds().
   */
  uptimeSeconds: number | null;
}

export interface KeepaliveSummary {
  pings: number;
  awake: number;
  failed: number;
  coldStarts: number;
  slowestMs: number;
  /** Uptime from the most recent successful ping, or null if unavailable. */
  uptimeSeconds: number | null;
}

export interface PingResponse {
  status: number;
  /** Optional so a test double can stay a one-liner; real fetch always has it. */
  headers?: { get(name: string): string | null };
  /** Optional for the same reason. Used only to read /healthz's uptimeSeconds. */
  text?: () => Promise<string>;
}

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; signal: AbortSignal; redirect: 'follow' },
) => Promise<PingResponse>;

export interface KeepaliveDeps {
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

/**
 * A reply slower than this almost certainly included a cold start — the whole
 * thing this exists to prevent — so it is counted and logged separately from
 * an ordinary slow response. /healthz does no I/O, so a warm reply is tens of
 * milliseconds; seconds means the container was being built back up.
 */
export const COLD_START_MS = 3_000;

/**
 * Did Render's edge answer this itself, without the request ever reaching the
 * application?
 *
 * This is the same trap as /robots.txt, in the form that actually bites: point
 * the keepalive at a mistyped service name and Render's router replies 404
 * with `x-render-routing: no-server`. A rule of "any HTTP status means the
 * container answered" reads that as a healthy ping and reports green forever
 * while the real service sleeps untouched — precisely the failure this whole
 * mechanism exists to end. A response that genuinely came from the app carries
 * `x-render-origin-server: Render` instead, and no `no-server` routing header.
 *
 * Verified against production: a real reply from hasino.onrender.com has
 * `x-render-origin-server: Render`; a nonexistent subdomain has
 * `x-render-routing: no-server` and no origin-server header at all.
 */
export function servedByRenderEdge(res: PingResponse): boolean {
  const routing = res.headers?.get('x-render-routing')?.toLowerCase() ?? '';
  return routing === 'no-server';
}

/**
 * Pull `uptimeSeconds` out of a /healthz body.
 *
 * This is the whole verification story, so it is worth saying why it works. On
 * Render's free tier a spin-down destroys the process; the next request starts
 * a new one. Uptime is therefore time since the last cold start, and a single
 * request answers a question you otherwise cannot answer at all: a fast reply
 * proves only that the service is awake *now*, which asking guarantees. Uptime
 * of four hours proves nothing has let it sleep for four hours. Uptime of
 * three seconds proves this very request paid for the wake — the pinger is not
 * working, however green its dashboard looks.
 *
 * Returns null rather than throwing for any endpoint that does not report it,
 * so pointing this at some other service degrades to a plain ping.
 */
export async function readUptimeSeconds(res: PingResponse): Promise<number | null> {
  if (!res.text) return null;
  try {
    const body = await res.text();
    // /healthz is a few dozen bytes. Anything larger is not it, and is not
    // worth parsing on a path that runs every few minutes.
    if (body.length > 4_096) return null;
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const value = (parsed as { uptimeSeconds?: unknown }).uptimeSeconds;
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Uptime at or below this means the service was asleep and this request is
 * what woke it. Generous enough to cover a slow boot without ever misreading a
 * service that has genuinely been up for a while.
 */
export const JUST_WOKE_SECONDS = 90;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Read the configuration from the environment.
 *
 * The defaults suit a scheduler that fires roughly every ten minutes: ping,
 * wait five minutes, ping again, exit. Set KEEPALIVE_DURATION_MS=0 for a
 * scheduler with a tight cadence of its own, which wants a single ping.
 *
 * Throws rather than falling back on anything questionable: a keepalive that
 * silently runs with a useless interval is worse than one that refuses to
 * start, because it looks green while the service sleeps.
 */
export function keepaliveConfigFromEnv(env: NodeJS.ProcessEnv): KeepaliveConfig {
  const url = (env.KEEPALIVE_URL ?? '').trim();
  if (!url) {
    throw new Error(
      'KEEPALIVE_URL is not set. Point it at the web service’s own health check, ' +
        'e.g. https://hasino.onrender.com/healthz',
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`KEEPALIVE_URL is not a URL: ${url}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`KEEPALIVE_URL must be http(s): ${url}`);
  }
  // The trap that makes a keepalive look like it is working when it is not.
  if (parsed.pathname === '/robots.txt') {
    throw new Error(
      'KEEPALIVE_URL points at /robots.txt. Render answers that path itself while ' +
        'the service is spun down, so the request never wakes the app. Use /healthz.',
    );
  }

  const num = (key: string, fallback: number, min: number): number => {
    const raw = env[key];
    if (raw === undefined || raw.trim() === '') return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < min) {
      throw new Error(`${key} must be a number >= ${min}, got: ${raw}`);
    }
    return n;
  };

  const intervalMs = num('KEEPALIVE_INTERVAL_MS', 5 * 60_000, 1);
  // Zero is meaningful and allowed: ping once and exit. That is the right
  // shape for a scheduler with its own tight cadence — cron-job.org firing
  // every 10 minutes wants a single ping, not a process that lingers.
  const durationMs = num('KEEPALIVE_DURATION_MS', 5 * 60_000, 0);
  const timeoutMs = num('KEEPALIVE_TIMEOUT_MS', 30_000, 1);
  const attempts = num('KEEPALIVE_ATTEMPTS', 3, 1);

  // The whole point is to ping more often than Render's idle timer. An
  // interval at or past 15 minutes cannot keep anything awake, so treat it as
  // a configuration bug rather than running a no-op on a schedule.
  if (intervalMs >= RENDER_IDLE_TIMEOUT_MS) {
    throw new Error(
      `KEEPALIVE_INTERVAL_MS is ${intervalMs}ms, but Render spins a free service down after ` +
        `${RENDER_IDLE_TIMEOUT_MS}ms idle. Pinging that slowly cannot keep it awake.`,
    );
  }

  return { url, intervalMs, durationMs, timeoutMs, attempts };
}

/**
 * One ping, with retries. Returns rather than throws: a failed ping is data,
 * not an exception, and the run continues either way.
 */
export async function pingOnce(
  cfg: Pick<KeepaliveConfig, 'url' | 'timeoutMs' | 'attempts'>,
  deps: KeepaliveDeps = {},
): Promise<PingResult> {
  const doFetch = (deps.fetch ?? (globalThis.fetch as unknown as FetchLike));
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;

  const started = now();
  let lastError: string | null = null;

  for (let attempt = 1; attempt <= cfg.attempts; attempt++) {
    try {
      const res = await doFetch(cfg.url, {
        method: 'GET',
        headers: {
          // Attributable in the service's own access log, so this traffic is
          // never mistaken for a scraper hammering /healthz.
          'user-agent': 'hasino-keepalive/1 (+https://github.com/gouravj25551-afk/Hasino)',
          // Belt and braces: nothing should serve this from a cache, because a
          // cached reply would not reach the app and would not wake it.
          'cache-control': 'no-cache',
          accept: 'application/json',
        },
        signal: AbortSignal.timeout(cfg.timeoutMs),
        redirect: 'follow',
      });
      if (servedByRenderEdge(res)) {
        // Retrying will not help — the hostname routes to nothing. Fail the
        // ping immediately with a message that names the actual cause.
        return {
          awake: false,
          status: res.status,
          ms: now() - started,
          error:
            'Render’s edge answered with x-render-routing: no-server — no service is routed at ' +
            'this hostname, so the request never reached the app. Check KEEPALIVE_URL.',
          attempts: attempt,
          uptimeSeconds: null,
        };
      }
      // Any other status means a container answered, which is what resets the
      // idle timer. Correctness of the response is a different job's problem.
      const uptimeSeconds = await readUptimeSeconds(res);
      return {
        awake: true,
        status: res.status,
        ms: now() - started,
        error: null,
        attempts: attempt,
        uptimeSeconds,
      };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      // A cold start can outlast one timeout. Back off briefly and try again
      // rather than writing the slot off — the second attempt usually lands on
      // the container the first attempt just woke.
      if (attempt < cfg.attempts) await sleep(Math.min(2_000 * attempt, 5_000));
    }
  }

  return {
    awake: false,
    status: null,
    ms: now() - started,
    error: lastError,
    attempts: cfg.attempts,
    uptimeSeconds: null,
  };
}

/**
 * Ping on a clock for the configured duration, then return a summary.
 *
 * The loop is deadline-driven rather than tick-driven: it sleeps until the
 * next slot is due rather than sleeping a fixed interval after each ping. A
 * slow ping (a cold start plus retries can run past a minute) therefore eats
 * into its own slot instead of pushing every later ping back, which is what
 * would otherwise let the gap drift past 15 minutes.
 */
export async function runKeepalive(
  cfg: KeepaliveConfig,
  deps: KeepaliveDeps = {},
): Promise<KeepaliveSummary> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const log = deps.log ?? (() => {});

  const startedAt = now();
  const deadline = startedAt + cfg.durationMs;
  const summary: KeepaliveSummary = {
    pings: 0,
    awake: 0,
    failed: 0,
    coldStarts: 0,
    slowestMs: 0,
    uptimeSeconds: null,
  };

  for (let slot = 0; ; slot++) {
    const due = startedAt + slot * cfg.intervalMs;
    // Never sleep past the deadline just to land one more ping.
    if (due > deadline) break;
    const wait = due - now();
    if (wait > 0) await sleep(wait);

    const result = await pingOnce(cfg, deps);
    summary.pings++;
    summary.slowestMs = Math.max(summary.slowestMs, result.ms);
    if (result.awake) {
      summary.awake++;
      if (result.ms >= COLD_START_MS) summary.coldStarts++;
      if (result.uptimeSeconds !== null) summary.uptimeSeconds = result.uptimeSeconds;
    } else {
      summary.failed++;
    }

    log(result.awake ? 'keepalive ping' : 'keepalive ping failed', {
      url: cfg.url,
      slot,
      status: result.status,
      ms: result.ms,
      attempts: result.attempts,
      coldStart: result.awake && result.ms >= COLD_START_MS,
      uptimeSeconds: result.uptimeSeconds,
      error: result.error,
    });
  }

  return summary;
}
