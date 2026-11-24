#!/usr/bin/env bash
set -euo pipefail
cd -- "${EXCALIDASH_INSTALL_DIR:-$(dirname -- "$0")}"
project=${EXCALIDASH_PROJECT:-excalidash}
files=(-f compose.yaml)
case "${EXCALIDASH_ROUTING:-traefik}" in
  traefik) files+=(-f compose.traefik.yaml) ;;
  isolated)
    [[ $project != excalidash ]] || { echo "Set a separate EXCALIDASH_PROJECT." >&2; exit 2; }
    files+=(-f compose.isolated.yaml)
    ;;
  *) echo "Unknown EXCALIDASH_ROUTING." >&2; exit 2 ;;
esac
if [[ -f compose.mcp.yaml ]]; then
  files+=(-f compose.mcp.yaml)
fi
exec docker compose -p "$project" "${files[@]}" "$@"
