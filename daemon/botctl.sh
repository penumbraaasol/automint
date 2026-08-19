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
    mkdir -p "$HOME/Library/LaunchAgents"
    cp "$PLIST" "$TARGET"
    launchctl unload "$TARGET" 2>/dev/null || true
    launchctl load "$TARGET"
    echo "installed and started: $LABEL"
    echo "logs: $LOG"
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
