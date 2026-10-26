#!/bin/zsh
# Runs the intake assistant every 2 minutes while you're logged in
# (reads new email, and sends the replies you approved).
#   ./install-launchd.sh            install / update
#   ./install-launchd.sh remove     stop and remove
set -e
LABEL=com.vapiq.intake
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
SLABEL=com.vapiq.summary
ALABEL=com.vapiq.ai
APLIST="$HOME/Library/LaunchAgents/$ALABEL.plist"
SPLIST="$HOME/Library/LaunchAgents/$SLABEL.plist"
DIR="$(cd "$(dirname "$0")" && pwd)"
NODE="$(command -v node)"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootout "gui/$(id -u)/$SLABEL" 2>/dev/null || true
launchctl bootout "gui/$(id -u)/$ALABEL" 2>/dev/null || true
if [[ "$1" == "remove" ]]; then rm -f "$PLIST" "$SPLIST" "$APLIST"; echo "Removed."; exit 0; fi

mkdir -p "$DIR/state" "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$DIR/intake.js</string></array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>StartInterval</key><integer>120</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$DIR/state/intake.log</string>
  <key>StandardErrorPath</key><string>$DIR/state/intake.log</string>
</dict></plist>
PL
launchctl bootstrap "gui/$(id -u)" "$PLIST"

# Morning summary — time from config ("alerts.morningSummary", default 07:00).
# If the Mac is asleep at that time, it runs as soon as it wakes.
TIME=$("$NODE" -e "import('$DIR/intake.js').then(m=>console.log(m.loadConfig().alerts.morningSummary||'07:00'))" 2>/dev/null || echo 07:00)
HOUR=$((10#${TIME%%:*})); MIN=$((10#${TIME##*:}))
cat > "$SPLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$SLABEL</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$DIR/summary.js</string></array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>$HOUR</integer><key>Minute</key><integer>$MIN</integer></dict>
  <key>StandardOutPath</key><string>$DIR/state/summary.log</string>
  <key>StandardErrorPath</key><string>$DIR/state/summary.log</string>
</dict></plist>
PL
launchctl bootstrap "gui/$(id -u)" "$SPLIST"

# Reply suggestions (Claude, your subscription) — every 30 seconds, quick when idle
cat > "$APLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$ALABEL</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$DIR/ai-queue.js</string></array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>StartInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$DIR/state/ai.log</string>
  <key>StandardErrorPath</key><string>$DIR/state/ai.log</string>
</dict></plist>
PL
launchctl bootstrap "gui/$(id -u)" "$APLIST"
echo "Installed: checks mail every 2 minutes; reply suggestions every 30 seconds; morning summary at $TIME. Logs: $DIR/state/"
