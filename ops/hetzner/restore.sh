#!/usr/bin/env bash
set -euo pipefail
[[ $# = 2 ]] || { echo "Usage: $0 BACKUP.cms RECOVERY_PRIVATE_KEY" >&2; exit 2; }
archive="$(cd -- "$(dirname -- "$1")" && pwd)/$(basename -- "$1")"
private_key="$(cd -- "$(dirname -- "$2")" && pwd)/$(basename -- "$2")"
cd -- "${EXCALIDASH_INSTALL_DIR:-$(dirname -- "$0")}"
umask 077
[[ $(id -u) = 0 ]] || { echo "Run as root to restore data ownership." >&2; exit 1; }
for item in .env state backup-config; do
  [[ ! -e $item && ! -L $item ]] || { echo "Restore into a fresh directory. Found $item." >&2; exit 1; }
done
stage=$(mktemp -d .restore.XXXXXX)
trap 'rm -rf -- "$stage"' EXIT
passphrase=()
if [[ -n ${EXCALIDASH_RECOVERY_PASSPHRASE_FILE:-} ]]; then
  passphrase=(-passin "file:$EXCALIDASH_RECOVERY_PASSPHRASE_FILE")
fi
openssl cms -decrypt -binary -inform DER -in "$archive" -inkey "$private_key"   "${passphrase[@]}" -out "$stage/backup.tar"
python3 - "$stage" <<'PY'
from pathlib import Path, PurePosixPath
import shutil
import sys
import tarfile

stage = Path(sys.argv[1])
with tarfile.open(stage / "backup.tar") as archive:
    seen = set()
    for member in archive:
        path = PurePosixPath(member.name)
        if (
            path.is_absolute() or ".." in path.parts or not path.parts
            or path.parts[0] not in {".env", "state", "backup-config"}
            or path in seen or not (member.isdir() or member.isfile())
        ):
            raise SystemExit("Unexpected or unsafe backup archive member.")
        seen.add(path)
        target = stage / path
        if member.isdir():
            target.mkdir(mode=0o700, parents=True, exist_ok=True)
        else:
            target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            with archive.extractfile(member) as source, target.open("xb") as output:
                shutil.copyfileobj(source, output)
            target.chmod(0o600)
PY
[[ -f $stage/state/db/dev.db && -s $stage/state/db/.jwt_secret && -s $stage/state/secrets.env && -f $stage/.env ]]
key=$(sed -n 's/^JWT_SECRET=//p' "$stage/state/secrets.env")
[[ ${#key} -ge 32 && $(cat "$stage/state/db/.jwt_secret") = "$key" ]] || {
  echo "Backup is missing the original key or contains conflicting keys." >&2
  exit 1
}
unset key
chown -R 1001:1001 "$stage/state/db"
if [[ -d $stage/state/mcp ]]; then
  [[ -f $stage/state/mcp/policy.json ]]
  chown -R 1001:1001 "$stage/state/mcp"
fi
mv -- "$stage/state" state
mv -- "$stage/.env" .env
if [[ -d $stage/backup-config ]]; then mv -- "$stage/backup-config" backup-config; fi
