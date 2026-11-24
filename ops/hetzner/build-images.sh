#!/usr/bin/env bash
set -euo pipefail
[[ $# = 2 && $2 =~ ^[a-f0-9]{40}$ ]] || { echo "Usage: $0 FORK_CHECKOUT FULL_COMMIT_SHA" >&2; exit 2; }
repo=$1
rev=$2
stage=$(mktemp -d)
trap 'rm -rf -- "$stage"' EXIT
git -C "$repo" archive "$rev" | tar -xf - -C "$stage"
docker build --build-arg "APP_BUILD_LABEL=$rev" -t "excalidash-fork-backend:$rev" -f "$stage/backend/Dockerfile" "$stage"
docker build --build-arg "VITE_APP_BUILD_LABEL=$rev" -t "excalidash-fork-frontend:$rev" -f "$stage/frontend/Dockerfile" "$stage"
