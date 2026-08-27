#!/usr/bin/env bash
# Control the automint background bot (launchd).
#
# The bot runs independently of any Claude session or terminal: launchd starts
# it at login and restarts it if it exits. Install once; after that it runs
# unattended until stopped.
set -euo pipefail

LABEL="com.automint.bot"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLIST="$HERE/$LABEL.plist"
TARGET="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HERE/automint.log"

case "${1:-status}" in
  install)
    PROJECT_DIR="$(cd "$HERE/.." && pwd)"
    NODE="$(command -v node)"
    [ -n "$NODE" ] || { echo "node not found on PATH"; exit 1; }

    mkdir -p "$HOME/Library/LaunchAgents"
    # The committed plist is a template; fill in this machine's paths.
    sed -e "s|__NODE__|$NODE|g" -e "s|__PROJECT_DIR__|$PROJECT_DIR|g" "$PLIST" > "$TARGET"
    plutil -lint "$TARGET" >/dev/null || { echo "generated plist is invalid"; exit 1; }

    launchctl unload "$TARGET" 2>/dev/null || true
    launchctl load "$TARGET"
    echo "installed and started: $LABEL"
    echo "  node    $NODE"
    echo "  project $PROJECT_DIR"
    echo "  logs    $LOG"
    ;;
  start)   launchctl load "$TARGET" && echo "started" ;;
  stop)    launchctl unload "$TARGET" && echo "stopped" ;;
  uninstall)
    launchctl unload "$TARGET" 2>/dev/null || true
    rm -f "$TARGET"
    echo "uninstalled"
    ;;
  status)
    if launchctl list | grep -q "$LABEL"; then
      echo "RUNNING"
      launchctl list | grep "$LABEL"
    else
      echo "not running"
    fi
    ;;
  logs)    tail -n "${2:-40}" "$LOG" 2>/dev/null || echo "no logs yet" ;;
  follow)  tail -f "$LOG" ;;
  spend)
    node --input-type=module -e "
      import { totalSpent } from '$HERE/../src/rails.js';
      import { formatEther } from 'viem';
      console.log('lifetime spend:', formatEther(totalSpent()), 'ETH');
    "
    ;;
  *)
    echo "usage: botctl.sh {install|start|stop|uninstall|status|logs [n]|follow|spend}"
    exit 1
    ;;
esac
