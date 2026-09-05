/**
 * Hit the backend so Render does not spin it down — and tell you whether
 * whatever is scheduling the hits is actually working.
 *
 *   KEEPALIVE_URL=https://hasino.onrender.com/healthz node scripts/keepalive.ts
 *
 * WHO RUNS THIS
 * -------------
 * Anything with a clock. This file does not schedule itself and cannot; a
 * process that is not running cannot wake anything, and neither can the app,
 * which is asleep exactly when the ping is needed. Something outside has to
 * make the request.
 *
 * In this deployment that something is cron-job.org, which fetches a URL on a
 * schedule from its own servers. Note what that means: it does not run this
 * file. It calls /healthz directly, which is the entire job, so with
 * cron-job.org configured there is nothing for a CI platform to do — a second
 * scheduler would be a second thing to maintain that changes no outcome.
 *
 * So this script is not the keepalive in production. It is the same request in
 * a form you can run by hand, point a different scheduler at if cron-job.org
 * ever lapses, or use as the verification below.
 *
 * VERIFYING, WHICH IS THE PART THAT ACTUALLY MATTERS
 * -------------------------------------------------
 * A keepalive that looks green while the service sleeps is the failure mode
 * this repo has already had once — the hasino-jobs cron was configured, showed
 * no errors, and had never run. So do not trust a fast reply: asking is what
 * makes the service awake, and a fast reply proves nothing about the minute
 * before you asked.
 *
 * /healthz reports `uptimeSeconds`, and on a free Render service a spin-down
 * destroys the process, so uptime is time since the last cold start. That is
 * the proof, and it is available from one request:
 *
 *   uptime of hours   nothing has let the service sleep. The pinger works.
 *   uptime of seconds this request woke it. The pinger is NOT working,
 *                     whatever its dashboard says.
 *
 * Set KEEPALIVE_EXPECT_AWAKE=true to turn that judgement into an exit code, so
 * it can be a monitored check rather than something a human has to read.
 *
 * Exit codes
 * ----------
 *   0  a ping reached the app (any status — a 500 still means a container
 *      answered, which is what resets the idle timer)
 *   1  no ping reached it, the configuration is wrong, or the service had just
 *      cold-started while KEEPALIVE_EXPECT_AWAKE was set
 *
 * Depends on nothing but Node: no database, no provider keys. A keepalive that
 * could not start because Postgres was unreachable would fail exactly when it
 * is most needed.
 */
import { JUST_WOKE_SECONDS, keepaliveConfigFromEnv, runKeepalive } from '../src/obs/keepalive.ts';

let cfg;
try {
  cfg = keepaliveConfigFromEnv(process.env);
} catch (err) {
  console.error(`keepalive: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

const expectAwake = /^(1|true|yes)$/i.test(process.env.KEEPALIVE_EXPECT_AWAKE ?? '');

/** Seconds as something a human reads at a glance: "4h 12m", "38s". */
function humanise(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ${Math.round(seconds % 60)}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

const line = (event: string, fields: Record<string, unknown>): void => {
  // Plain JSON lines rather than src/obs/logger.ts, so this stays runnable in a
  // container that has none of the app's environment set.
  console.log(JSON.stringify({ event, ...fields }));
};

console.log(
  `keepalive: ${cfg.url} every ${cfg.intervalMs / 1000}s for ${cfg.durationMs / 1000}s ` +
    `(Render sleeps after 900s idle)`,
);

const summary = await runKeepalive(cfg, { log: line });

console.log(
  `keepalive: ${summary.awake}/${summary.pings} awake, ${summary.failed} failed, ` +
    `${summary.coldStarts} cold start(s), slowest ${summary.slowestMs}ms`,
);

// Nothing reached at all, across every ping and every retry.
if (summary.pings > 0 && summary.awake === 0) {
  console.error('keepalive: the service was never reached. Check KEEPALIVE_URL and the Render dashboard.');
  process.exit(1);
}

// The verdict. Everything above says the request worked; this says whether the
// schedule behind it is doing its job.
const uptime = summary.uptimeSeconds;
if (uptime === null) {
  console.warn(
    'keepalive: no uptimeSeconds in the response, so whether the service had already been ' +
      'awake cannot be told from here. Point this at /healthz on a build that reports it.',
  );
} else if (uptime <= JUST_WOKE_SECONDS) {
  console.error(
    `keepalive: service uptime is only ${humanise(uptime)} — it was asleep and THIS request ` +
      `woke it. Whatever is meant to be pinging it is not working.`,
  );
  if (expectAwake) process.exit(1);
} else {
  console.log(
    `keepalive: service uptime ${humanise(uptime)} — it has not been allowed to sleep in that ` +
      `time, so the pinger is working.`,
  );
}

process.exit(0);
