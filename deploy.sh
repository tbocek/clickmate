#!/usr/bin/env bash
# Rebuild and install both halves of clickmate.
#
# Run it as yourself, not under sudo: the extension build must not leave
# root-owned files in gnome-shell/dist. It asks for sudo only where it needs it.

set -euo pipefail
cd "$(dirname "$0")"

echo "==> daemon"
make
sudo systemctl stop clickmate 2>/dev/null || true
sudo killall clickmate 2>/dev/null || true
sudo make install

echo
echo "==> extension"
(cd gnome-shell && npm run build)

echo
echo "==> daemon status"
sleep 1
curl -s --unix-socket /var/run/click-socket http://localhost/status || echo "  not responding"
echo
journalctl -u clickmate -n 20 --no-pager 2>/dev/null | grep 'clickmate: captured' || true

echo
echo "Now log out and back in — the shell only loads extension code at login,"
echo "and running a stale shell against freshly built preferences loses macros."
