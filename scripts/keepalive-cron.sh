#!/usr/bin/env bash
#
# One keepalive ping, shaped for a scheduler that owns the clock.
#
# This is what the local launchd agent (or a crontab line) actually runs. It is
# a shell wrapper rather than the scheduler calling `node scripts/keepalive.ts`
# directly because three things have to happen around that command and none of
# them belong in the Node script:
#
#   1. FIND NODE. A launchd agent and a cron job inherit almost no environment:
#      PATH is roughly /usr/bin:/bin:/usr/sbin:/sbin, with nothing an nvm or
#      Homebrew install has put on it. `node` is simply not found, the job
#      fails silently every ten minutes, and the service sleeps while the
#      scheduler's own log fills with "command not found". Resolving the
#      interpreter here is the difference between a keepalive and a cron entry
#      that has never once worked.
#
#   2. HOLD THE INSTANCE-HOUR BUDGET. Render gives a WORKSPACE 750 free
#      instance-hours per calendar month and a 31-day month is 744 hours, so a
#      round-the-clock ping on one service consumes essentially the entire
#      allowance and every free service — the admin panel included — is
#      suspended until the 1st. The window below is the fix, and it lives here
#      because launchd cannot express "every ten minutes, but only between
#      these hours" without a hundred-odd calendar entries. StartInterval fires
#      every ten minutes and this script decides whether the ping is owed.
#
#   3. LEAVE A TRAIL. A keepalive that nobody can audit is how the last one
#      went unnoticed for weeks: the cron-job.org job was configured, showed
#      green, and the service was cold-starting anyway. Every run appends one
#      JSON line here, so "is it working" is answered by a file rather than by
#      a dashboard that reports only that it sent a request somewhere.
#
# Run it by hand exactly as the scheduler does:
#
#   bash scripts/keepalive-cron.sh
#   KEEPALIVE_FORCE=1 bash scripts/keepalive-cron.sh   # ignore the hour window
#
set -uo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Optional per-machine overrides, so the URL and the window can differ between
# a laptop and a spare box without either of them carrying a local edit to a
# tracked file.
config="${KEEPALIVE_ENV_FILE:-$HOME/.hasino-keepalive.env}"
# shellcheck source=/dev/null
[ -f "$config" ] && . "$config"

: "${KEEPALIVE_URL:=https://hasino.onrender.com/healthz}"
: "${KEEPALIVE_LOG:=$HOME/Library/Logs/hasino-keepalive.log}"
# Inclusive start, exclusive end, in UTC. 0-18 is 05:30-23:30 IST, which covers
# every plausible booking hour; see DEPLOY.md for the arithmetic behind it.
: "${KEEPALIVE_START_HOUR_UTC:=0}"
: "${KEEPALIVE_END_HOUR_UTC:=18}"
: "${KEEPALIVE_FORCE:=}"

# One ping and exit. The scheduler has its own cadence, so a process that
# lingered for five minutes pinging on its own would be a second clock arguing
# with the first.
export KEEPALIVE_URL
export KEEPALIVE_DURATION_MS="${KEEPALIVE_DURATION_MS:-0}"
export KEEPALIVE_TIMEOUT_MS="${KEEPALIVE_TIMEOUT_MS:-45000}"
export KEEPALIVE_ATTEMPTS="${KEEPALIVE_ATTEMPTS:-3}"

mkdir -p "$(dirname "$KEEPALIVE_LOG")"

# Keep the log to something a person can open. Ten-minute pings for a year is
# about 50k lines, which is fine, but a run of failures with stack traces is
# not — truncate rather than let it grow without bound.
if [ -f "$KEEPALIVE_LOG" ] && [ "$(wc -c <"$KEEPALIVE_LOG" | tr -d ' ')" -gt 2000000 ]; then
  tail -n 2000 "$KEEPALIVE_LOG" >"$KEEPALIVE_LOG.tmp" && mv "$KEEPALIVE_LOG.tmp" "$KEEPALIVE_LOG"
fi

log() { printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >>"$KEEPALIVE_LOG"; }

hour_utc=$(date -u '+%H')
hour_utc=$((10#$hour_utc))
if [ -z "$KEEPALIVE_FORCE" ] &&
   { [ "$hour_utc" -lt "$KEEPALIVE_START_HOUR_UTC" ] || [ "$hour_utc" -ge "$KEEPALIVE_END_HOUR_UTC" ]; }; then
  log "skip: ${hour_utc}:00 UTC is outside the ${KEEPALIVE_START_HOUR_UTC}-${KEEPALIVE_END_HOUR_UTC} window, letting the service sleep"
  exit 0
fi

# Find an interpreter the way a login shell would, then the way a machine with
# no login shell has to. nvm is first because that is where this repo's Node
# lives on the machine that schedules it; the rest are the ordinary install
# locations, newest version first within each.
find_node() {
  if command -v node >/dev/null 2>&1; then command -v node; return; fi
  local candidate
  for candidate in \
    "$HOME"/.nvm/versions/node/*/bin/node \
    /opt/homebrew/bin/node \
    /usr/local/bin/node \
    /usr/bin/node
  do
    [ -x "$candidate" ] && printf '%s\n' "$candidate"
  done | sort -Vr | head -n 1
}

node_bin="${KEEPALIVE_NODE:-$(find_node)}"
if [ -z "$node_bin" ] || [ ! -x "$node_bin" ]; then
  log 'error: no node interpreter found. Set KEEPALIVE_NODE in '"$config"' to an absolute path.'
  exit 1
fi

# The Node script does the real work: the ping, the retries, the Render-edge
# guards, and the uptime verdict that says whether the SCHEDULE is working
# rather than whether this one request was.
output="$("$node_bin" "$repo_root/scripts/keepalive.ts" 2>&1)"
status=$?

printf '%s\n' "$output" | sed "s|^|$(date -u '+%Y-%m-%dT%H:%M:%SZ') |" >>"$KEEPALIVE_LOG"
[ "$status" -ne 0 ] && log "error: keepalive exited $status"
exit "$status"
