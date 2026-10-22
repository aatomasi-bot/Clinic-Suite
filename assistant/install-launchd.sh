#!/bin/zsh
# Runs the intake assistant every 10 minutes while you're logged in.
#   ./install-launchd.sh            install / update
#   ./install-launchd.sh remove     stop and remove
set -e
LABEL=com.vapiq.intake
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DIR="$(cd "$(dirname "$0")" && pwd)"
NODE="$(command -v node)"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
if [[ "$1" == "remove" ]]; then rm -f "$PLIST"; echo "Removed."; exit 0; fi

mkdir -p "$DIR/state" "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$DIR/intake.js</string></array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>StartInterval</key><integer>600</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$DIR/state/intake.log</string>
  <key>StandardErrorPath</key><string>$DIR/state/intake.log</string>
</dict></plist>
PL
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Installed: runs every 10 minutes. Log: $DIR/state/intake.log"
