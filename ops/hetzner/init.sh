#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")"
umask 077
[[ $(id -u) = 0 ]] || { echo "Run as root to set the container's data ownership." >&2; exit 1; }
[[ ! -e state && ! -L state ]] || { echo "State already exists. Use the original secrets." >&2; exit 1; }
stage=$(mktemp -d .init.XXXXXX)
trap 'rm -rf -- "$stage"' EXIT
mkdir "$stage/db"
for key in JWT_SECRET CSRF_SECRET API_KEY_HASH_PEPPER; do
  value=$(openssl rand -hex 32)
  printf '%s=%s\n' "$key" "$value" >> "$stage/secrets.env"
done
chown -R 1001:1001 "$stage/db"
mv "$stage" state
