#!/usr/bin/env bash
#
# Install the keepalive on THIS machine's own scheduler, so no third-party
# service is in the loop.
#
#   bash scripts/install-keepalive-cron.sh              # install and start
#   bash scripts/install-keepalive-cron.sh --status     # is it loaded, is it working
#   bash scripts/install-keepalive-cron.sh --uninstall   # remove it
#
# On macOS this writes a launchd agent, which is the right tool rather than
# crontab: launchd starts it at login without a terminal open, restarts it
# after a reboot, and — the part crontab cannot do — runs a fire it slept
# through as soon as the machine wakes, instead of silently dropping it. On
# anything else it prints the crontab line to add, because there is no single
# correct way to edit a crontab from a script without risking the entries
# already in it.
#
# WHAT THIS BUYS AND WHAT IT DOES NOT
# -----------------------------------
# The pings come from this machine, so they stop when this machine is off,
# asleep, or off the network. That is the honest trade for having no external
# account in the path: the service then sleeps and the next visitor waits
# through a cold start, exactly as it did before any keepalive existed —
# nothing breaks, it is just slow again until the laptop is back. Check
# --status after the machine has been left alone for a while; the uptime line
# is what tells you the truth.
#
set -uo pipefail

label='com.hasino.keepalive'
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
runner="$repo_root/scripts/keepalive-cron.sh"
plist="$HOME/Library/LaunchAgents/$label.plist"
log="${KEEPALIVE_LOG:-$HOME/Library/Logs/hasino-keepalive.log}"
# Every 10 minutes, against Render's 15-minute idle timer: close enough that
# one ping can fail outright and the next still lands inside the window.
interval=600

die() { printf 'error: %s\n' "$*" >&2; exit 1; }

[ -f "$runner" ] || die "missing $runner"

status_report() {
  if [ "$(uname -s)" = 'Darwin' ]; then
    if launchctl list | grep -q "$label"; then
      printf 'launchd agent: loaded\n'
      launchctl list "$label" 2>/dev/null | grep -E '"(PID|LastExitStatus)"' | sed 's/^/  /'
    else
      printf 'launchd agent: NOT loaded\n'
    fi
    printf 'plist: %s\n' "$plist"
  fi
  printf 'log: %s\n' "$log"
  if [ -f "$log" ]; then
    printf '\nlast 12 lines:\n'
    tail -n 12 "$log" | sed 's/^/  /'
  else
    printf '  (no log yet — the agent has not run)\n'
  fi
}

case "${1:-}" in
  --status)
    status_report
    exit 0
    ;;
  --uninstall)
    if [ "$(uname -s)" = 'Darwin' ]; then
      launchctl bootout "gui/$(id -u)/$label" 2>/dev/null ||
        launchctl unload "$plist" 2>/dev/null
      rm -f "$plist"
      printf 'removed %s\n' "$plist"
    else
      printf 'Remove the crontab line that runs %s:\n\n  crontab -e\n' "$runner"
    fi
    exit 0
    ;;
  '') ;;
  *) die "unknown option: $1 (use --status or --uninstall)" ;;
esac

if [ "$(uname -s)" != 'Darwin' ]; then
  cat <<EOF
Not macOS, so there is no launchd. Add this to \`crontab -e\` instead — every
ten minutes, with the hour window enforced inside the script rather than in the
crontab expression, so the budget logic stays in one readable place:

  */10 * * * * /bin/bash $runner

Then confirm with:

  bash scripts/install-keepalive-cron.sh --status
EOF
  exit 0
fi

mkdir -p "$(dirname "$plist")" "$(dirname "$log")"

# StartInterval rather than StartCalendarInterval: the hour window lives in
# keepalive-cron.sh, which lets one readable `if` replace the ~108 calendar
# entries a "every 10 minutes between 00:00 and 18:00 UTC" schedule would need
# here. RunAtLoad makes the first ping happen at install and at every login,
# which is also the fastest way to find out the agent is misconfigured.
cat >"$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$runner</string>
  </array>
  <key>StartInterval</key>
  <integer>$interval</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$log</string>
  <key>StandardErrorPath</key>
  <string>$log</string>
  <key>WorkingDirectory</key>
  <string>$repo_root</string>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
EOF

# bootout first so re-running this after an edit reloads rather than silently
# keeping the old definition running.
launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$plist" 2>/dev/null ||
  launchctl load "$plist" || die 'launchctl refused to load the agent'

printf 'installed %s\n' "$plist"
printf 'pinging every %ss inside the configured UTC window\n\n' "$interval"
status_report
