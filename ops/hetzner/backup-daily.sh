#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")"
umask 077
dest=/var/backups/excalidash
install -d -m 700 "$dest"
flock -n "$dest/.lock" ./backup.sh ./recovery.crt "$dest/excalidash-$(date -u +%Y%m%dT%H%M%SZ).cms"
find "$dest" -maxdepth 1 -type f -name 'excalidash-*.cms' -mtime +30 -delete
