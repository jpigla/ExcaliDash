#!/usr/bin/env bash
set -euo pipefail
mode=online
case "${1:-}" in
  --keep-stopped) mode=frozen; shift ;;
esac
[[ $# = 2 ]] || { echo "Usage: $0 [--keep-stopped] RECIPIENT_CERT OUTPUT.cms" >&2; exit 2; }
script_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
cert="$(cd -- "$(dirname -- "$1")" && pwd)/$(basename -- "$1")"
out="$(cd -- "$(dirname -- "$2")" && pwd)/$(basename -- "$2")"
export EXCALIDASH_INSTALL_DIR="${EXCALIDASH_INSTALL_DIR:-$script_dir}"
cd -- "$EXCALIDASH_INSTALL_DIR"
umask 077
[[ -f $cert && ! -e $out && ! -L $out ]]
[[ -f state/db/dev.db && -s state/db/.jwt_secret && -s state/secrets.env ]]
key=$(sed -n 's/^JWT_SECRET=//p' state/secrets.env)
[[ ${#key} -ge 32 && $(cat state/db/.jwt_secret) = "$key" ]] || {
  echo "The configured key does not match the database's saved key." >&2
  exit 1
}
unset key

# Use the installed Compose wrapper for the currently running instance.
./compose.sh config --quiet
if [[ $mode == frozen && -n $(./compose.sh ps --status running -q) ]]; then
  echo "Stop the entire instance before taking the cutover backup." >&2
  exit 1
fi
if [[ -e state/mcp || -e compose.mcp.yaml ]]; then
  [[ -f state/mcp/policy.json && ! -L state/mcp/policy.json ]]
  exec 8>>state/mcp/.lock
  flock -x 8
fi

stage=$(mktemp -d)
trap 'rm -rf -- "$stage"; if [[ -n ${tmp:-} ]]; then rm -f -- "$tmp"; fi' EXIT
tmp=$(mktemp "${out}.part.XXXXXX")
mkdir -p "$stage/state/db" "$stage/backup-config"
cp -p -- .env "$stage/.env"
cp -p -- state/secrets.env "$stage/state/"
for file in state/db/.jwt_secret state/db/.csrf_secret; do
  if [[ -f $file ]]; then cp -p -- "$file" "$stage/state/db/"; fi
done
if [[ -f state/mcp/policy.json ]]; then
  mkdir "$stage/state/mcp"
  cp -p -- state/mcp/policy.json "$stage/state/mcp/"
fi
python3 - state/db/dev.db "$stage/state/db/dev.db" <<'PY'
from pathlib import Path
import sqlite3
import sys

source = Path(sys.argv[1]).resolve().as_uri() + "?mode=ro"
with sqlite3.connect(source, uri=True, timeout=5) as current:
    with sqlite3.connect(sys.argv[2]) as backup:
        current.backup(backup, pages=128, sleep=0.1)
        if backup.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
            raise SystemExit("SQLite backup did not pass integrity_check.")
PY

for file in compose.sh compose.yaml compose.traefik.yaml compose.mcp.yaml compose.isolated.yaml guard.cjs; do
  if [[ -f $file ]]; then cp -p -- "$file" "$stage/backup-config/"; fi
done
for service in backend frontend; do
  container=$(./compose.sh ps -a -q "$service")
  if [[ -n $container ]]; then
    docker inspect --format '{{.Config.Image}} {{.Image}}' "$container"
  fi
done > "$stage/backup-config/images.txt"

tar -C "$stage" -cf - .env state backup-config |
  openssl cms -encrypt -binary -stream -aes-256-gcm -outform DER -recip "$cert" -out "$tmp"
ln -- "$tmp" "$out"
