/**
 * The keepalive, asserted as behaviour and as configuration.
 *
 * The bug being guarded against is subtle and was live in this repo: a cron
 * that is configured, runs green, and keeps nothing awake. Three of its causes
 * are invisible to an ordinary test, so they are pinned here explicitly —
 *
 *   - a ping interval at or past Render's 15-minute idle timer,
 *   - pinging /robots.txt, which Render answers itself while the service is
 *     spun down so the app is never reached,
 *   - a scheduler whose gaps exceed the idle timer.
 *
 * Nothing here touches the network or the database.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Pool } from 'pg';
import { buildServer } from '../src/http/server.ts';
import {
  COLD_START_MS,
  JUST_WOKE_SECONDS,
  RENDER_IDLE_TIMEOUT_MS,
  keepaliveConfigFromEnv,
  pingOnce,
  readUptimeSeconds,
  runKeepalive,
} from '../src/obs/keepalive.ts';

/** A clock that only moves when something sleeps, so the tests run instantly. */
function fakeClock(startAt = 0) {
  let t = startAt;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
    get time() {
      return t;
    },
  };
}

describe('keepalive configuration', () => {
  it('refuses to start without a URL rather than pinging nothing', () => {
    assert.throws(() => keepaliveConfigFromEnv({}), /KEEPALIVE_URL is not set/);
  });

  it('rejects an interval that cannot beat Render’s idle timer', () => {
    // The failure this exists for: 15 minutes "feels" right because that is
    // the documented timeout, but a ping exactly on the timer races it and
    // loses. Anything at or past it is a no-op dressed as a schedule.
    assert.throws(
      () =>
        keepaliveConfigFromEnv({
          KEEPALIVE_URL: 'https://example.onrender.com/healthz',
          KEEPALIVE_INTERVAL_MS: String(RENDER_IDLE_TIMEOUT_MS),
        }),
      /cannot keep it awake/,
    );
  });

  it('rejects /robots.txt, which Render answers without waking the app', () => {
    assert.throws(
      () => keepaliveConfigFromEnv({ KEEPALIVE_URL: 'https://example.onrender.com/robots.txt' }),
      /never wakes the app/,
    );
  });

  it('rejects a non-URL and a non-http scheme', () => {
    assert.throws(() => keepaliveConfigFromEnv({ KEEPALIVE_URL: 'hasino.onrender.com' }), /not a URL/);
    assert.throws(
      () => keepaliveConfigFromEnv({ KEEPALIVE_URL: 'ftp://example.com/healthz' }),
      /must be http/,
    );
  });

  it('defaults to a cadence well inside the idle timer', () => {
    const cfg = keepaliveConfigFromEnv({ KEEPALIVE_URL: 'https://example.onrender.com/healthz' });
    assert.ok(cfg.intervalMs < RENDER_IDLE_TIMEOUT_MS / 2, 'want at least two pings per idle window');
    assert.ok(cfg.attempts > 1, 'one cold-start timeout must not cost the whole slot');
    assert.ok(cfg.timeoutMs >= 15_000, 'a cold start needs more than a few seconds to answer');
  });

  it('rejects a nonsense number instead of silently using the default', () => {
    assert.throws(
      () =>
        keepaliveConfigFromEnv({
          KEEPALIVE_URL: 'https://example.onrender.com/healthz',
          KEEPALIVE_INTERVAL_MS: 'soon',
        }),
      /must be a number >= 1/,
    );
  });
});

describe('a single ping', () => {
  const cfg = { url: 'https://example.onrender.com/healthz', timeoutMs: 1_000, attempts: 3 };

  it('counts any HTTP status as awake, because a container answered', async () => {
    for (const status of [200, 404, 500, 503]) {
      const res = await pingOnce(cfg, { fetch: async () => ({ status }) });
      assert.equal(res.awake, true, `status ${status} should count as awake`);
      assert.equal(res.status, status);
    }
  });

  it('retries, so one cold-start timeout does not write the slot off', async () => {
    let calls = 0;
    const clock = fakeClock();
    const res = await pingOnce(cfg, {
      ...clock,
      fetch: async () => {
        calls++;
        // The first attempt times out waking the container; the second lands
        // on the container the first attempt just started.
        if (calls === 1) throw new Error('The operation was aborted due to timeout');
        return { status: 200 };
      },
    });
    assert.equal(res.awake, true);
    assert.equal(res.attempts, 2);
    assert.equal(calls, 2);
  });

  it('does not count Render’s own 404 for an unrouted host as awake', async () => {
    // The green-but-asleep trap: a mistyped service name gets a 404 from
    // Render's router, never from the app. Verified against production —
    // an unrouted *.onrender.com host answers with this exact header.
    const clock = fakeClock();
    let calls = 0;
    const res = await pingOnce(cfg, {
      ...clock,
      fetch: async () => {
        calls++;
        return {
          status: 404,
          headers: { get: (n: string) => (n === 'x-render-routing' ? 'no-server' : null) },
        };
      },
    });
    assert.equal(res.awake, false, 'the app was never reached, so this is not a successful ping');
    assert.equal(calls, 1, 'retrying a hostname that routes to nothing is pointless');
    assert.match(res.error ?? '', /no-server/);
  });

  it('counts a real 404 from the app as awake', async () => {
    // A 404 that came from the application still woke the container, which is
    // all the idle timer cares about. Only the edge short-circuit is a miss.
    const res = await pingOnce(cfg, {
      fetch: async () => ({
        status: 404,
        headers: { get: (n: string) => (n === 'x-render-origin-server' ? 'Render' : null) },
      }),
    });
    assert.equal(res.awake, true);
  });

  it('gives up after the configured attempts and reports the last error', async () => {
    let calls = 0;
    const clock = fakeClock();
    const res = await pingOnce(cfg, {
      ...clock,
      fetch: async () => {
        calls++;
        throw new Error('getaddrinfo ENOTFOUND');
      },
    });
    assert.equal(res.awake, false);
    assert.equal(calls, 3);
    assert.match(res.error ?? '', /ENOTFOUND/);
  });
});

describe('a keepalive run', () => {
  const cfg = {
    url: 'https://example.onrender.com/healthz',
    intervalMs: 5 * 60_000,
    durationMs: 5 * 60_000,
    timeoutMs: 30_000,
    attempts: 3,
  };

  it('pings at both ends of its window, not just once on startup', async () => {
    const clock = fakeClock();
    const at: number[] = [];
    const summary = await runKeepalive(cfg, {
      ...clock,
      fetch: async () => {
        at.push(clock.time);
        return { status: 200 };
      },
    });
    // A run that pinged once and exited would leave the back half of its slot
    // uncovered, which is what makes a delayed next run turn into a sleep.
    assert.deepEqual(at, [0, 300_000]);
    assert.equal(summary.pings, 2);
    assert.equal(summary.awake, 2);
    assert.equal(summary.failed, 0);
  });

  it('does not let a slow ping push every later ping back', async () => {
    // The drift bug: sleeping a fixed interval AFTER each ping means a ping
    // that took 400s delays every subsequent one by 400s, and the gap walks
    // past 15 minutes without anything looking wrong. Slots are absolute.
    const clock = fakeClock();
    const at: number[] = [];
    let first = true;
    await runKeepalive(
      { ...cfg, durationMs: 15 * 60_000 },
      {
        ...clock,
        fetch: async () => {
          at.push(clock.time);
          if (first) {
            first = false;
            clock.advance(400_000); // a cold start plus retries, 6m40s
          }
          return { status: 200 };
        },
      },
    );
    assert.equal(at[0], 0);
    assert.equal(at[1], 400_000, 'the slot it already missed is pinged immediately');
    assert.equal(at[2], 600_000, 'the next slot is back on the absolute grid, not 700_000');
    assert.equal(at[3], 900_000);
  });

  it('never sleeps past its deadline to land one more ping', async () => {
    const clock = fakeClock();
    let calls = 0;
    await runKeepalive({ ...cfg, intervalMs: 60_000, durationMs: 150_000 }, {
      ...clock,
      fetch: async () => {
        calls++;
        return { status: 200 };
      },
    });
    // Slots at 0, 60s, 120s. 180s is past the 150s deadline.
    assert.equal(calls, 3);
    assert.ok(clock.time <= 150_000);
  });

  it('flags a slow reply as a cold start, which means a run was missed', async () => {
    const clock = fakeClock();
    const summary = await runKeepalive({ ...cfg, durationMs: 0 }, {
      ...clock,
      fetch: async () => {
        clock.advance(COLD_START_MS + 1);
        return { status: 200 };
      },
    });
    assert.equal(summary.pings, 1);
    assert.equal(summary.coldStarts, 1, 'a 3s+ /healthz means the container was being rebuilt');
  });

  it('reports total failure without throwing, so the caller decides', async () => {
    const clock = fakeClock();
    const summary = await runKeepalive(cfg, {
      ...clock,
      fetch: async () => {
        throw new Error('connect ECONNREFUSED');
      },
    });
    assert.equal(summary.awake, 0);
    assert.equal(summary.failed, summary.pings);
  });
});

describe('proving the pinger works', () => {
  /**
   * The point of this suite. A fast reply proves only that the service is
   * awake now, which the act of asking guarantees — so "it responded quickly"
   * is not evidence of anything. Uptime is, because a free-tier spin-down
   * destroys the process.
   */
  const healthz = (uptimeSeconds: unknown) => ({
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify({ ok: true, uptimeSeconds }),
  });

  it('reads uptime out of a /healthz body', async () => {
    assert.equal(await readUptimeSeconds(healthz(15_042)), 15_042);
  });

  it('reports null instead of throwing on anything that is not a /healthz', async () => {
    assert.equal(await readUptimeSeconds({ status: 200 }), null, 'no body reader at all');
    assert.equal(
      await readUptimeSeconds({ status: 200, text: async () => '<html>not json</html>' }),
      null,
    );
    assert.equal(await readUptimeSeconds({ status: 200, text: async () => 'null' }), null);
    assert.equal(await readUptimeSeconds(healthz('ages')), null, 'wrong type');
    assert.equal(await readUptimeSeconds({ status: 200, text: async () => '{}' }), null);
  });

  it('does not parse a large body on a path that runs every few minutes', async () => {
    const big = JSON.stringify({ uptimeSeconds: 999, pad: 'x'.repeat(5_000) });
    assert.equal(await readUptimeSeconds({ status: 200, text: async () => big }), null);
  });

  it('surfaces uptime on the ping, so one request settles the question', async () => {
    const res = await pingOnce(
      { url: 'https://example.onrender.com/healthz', timeoutMs: 1_000, attempts: 1 },
      { fetch: async () => healthz(4 * 60 * 60) },
    );
    assert.equal(res.awake, true);
    assert.equal(res.uptimeSeconds, 4 * 60 * 60);
    assert.ok(
      (res.uptimeSeconds as number) > JUST_WOKE_SECONDS,
      'four hours of uptime means nothing let it sleep',
    );
  });

  it('distinguishes a service that was already up from one this request woke', async () => {
    // The whole failure mode in one assertion: both of these are HTTP 200 and
    // both are "awake". Only uptime separates a working pinger from a broken
    // one, and the second case is what a green-but-useless cron looks like.
    const alreadyUp = await pingOnce(
      { url: 'https://example.onrender.com/healthz', timeoutMs: 1_000, attempts: 1 },
      { fetch: async () => healthz(7_200) },
    );
    const justWoken = await pingOnce(
      { url: 'https://example.onrender.com/healthz', timeoutMs: 1_000, attempts: 1 },
      { fetch: async () => healthz(3) },
    );
    assert.equal(alreadyUp.awake, justWoken.awake, 'both look identical on status alone');
    assert.ok((alreadyUp.uptimeSeconds as number) > JUST_WOKE_SECONDS);
    assert.ok((justWoken.uptimeSeconds as number) <= JUST_WOKE_SECONDS);
  });

  it('carries the latest uptime into the run summary', async () => {
    const clock = fakeClock();
    let n = 0;
    const summary = await runKeepalive(
      {
        url: 'https://example.onrender.com/healthz',
        intervalMs: 60_000,
        durationMs: 60_000,
        timeoutMs: 1_000,
        attempts: 1,
      },
      { ...clock, fetch: async () => healthz(100 + n++) },
    );
    assert.equal(summary.pings, 2);
    assert.equal(summary.uptimeSeconds, 101, 'the most recent ping wins');
  });

  it('leaves uptime null when a ping never got through', async () => {
    const clock = fakeClock();
    const summary = await runKeepalive(
      {
        url: 'https://example.onrender.com/healthz',
        intervalMs: 60_000,
        durationMs: 0,
        timeoutMs: 1_000,
        attempts: 1,
      },
      {
        ...clock,
        fetch: async () => {
          throw new Error('connect ECONNREFUSED');
        },
      },
    );
    assert.equal(summary.uptimeSeconds, null);
  });
});

describe('GET /healthz, against a real running server', () => {
  /**
   * Boots the actual HTTP server and makes actual requests. /healthz performs
   * no I/O — that is the point of splitting it from /readyz — so this needs no
   * database and runs everywhere, including where the Postgres-backed suites
   * skip. The pool below is constructed but never queried.
   */
  async function withServer<T>(fn: (base: string) => Promise<T>): Promise<T> {
    const db = new Pool({ connectionString: 'postgres://unused@127.0.0.1:1/unused' });
    const server = buildServer(db as never);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const { port } = server.address() as { port: number };
    try {
      return await fn(`http://127.0.0.1:${port}`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await db.end().catch(() => {});
    }
  }

  it('answers 200 with the uptime the keepalive is verified against', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/healthz`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { ok: boolean; uptimeSeconds: number };
      assert.equal(body.ok, true, 'the existing contract must not change');
      assert.equal(typeof body.uptimeSeconds, 'number');
      assert.ok(body.uptimeSeconds >= 0);
    });
  });

  it('is parsed by the same reader the keepalive uses', async () => {
    // End to end: the server's real bytes through the real parser. A field
    // renamed on one side and not the other would pass both unit suites and
    // silently return the keepalive to guessing from response times.
    await withServer(async (base) => {
      const res = await fetch(`${base}/healthz`);
      const uptime = await readUptimeSeconds({
        status: res.status,
        headers: res.headers,
        text: () => res.text(),
      });
      assert.notEqual(uptime, null, 'the keepalive could not read the server’s own /healthz');
      assert.equal(typeof uptime, 'number');
    });
  });

  it('still touches no database', async () => {
    // The pool points at a closed port. If /healthz ever grew a query this
    // would fail, and a liveness probe that needs Postgres turns a database
    // blip into a restart loop.
    await withServer(async (base) => {
      const res = await fetch(`${base}/healthz`);
      assert.equal(res.status, 200);
    });
  });

  it('answers HEAD too, which is what uptime checkers send', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/healthz`, { method: 'HEAD' });
      assert.equal(res.status, 200);
    });
  });
});
