#!/usr/bin/env python3
import hashlib
from pathlib import Path
import sqlite3
import sys


TABLES = (
    "User", "UserAvatar", "Collection", "CollectionShare", "Drawing",
    "DrawingFile", "DrawingSnapshot", "DrawingPermission", "DrawingLinkShare",
    "McpBoardGrant",
)


def fingerprint(filename):
    with sqlite3.connect(Path(filename).resolve().as_uri() + "?mode=ro", uri=True) as db:
        if db.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
            raise SystemExit("SQLite integrity_check failed.")
        if db.execute("PRAGMA foreign_key_check").fetchone():
            raise SystemExit("SQLite foreign_key_check failed.")
        result = {}
        for table in TABLES:
            exists = db.execute(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (table,)
            ).fetchone()
            if not exists:
                if table == "McpBoardGrant":
                    result[table] = (0, hashlib.sha256().hexdigest())
                    continue
                raise SystemExit(f"Missing table: {table}")
            cursor = db.execute(f'SELECT * FROM "{table}" ORDER BY rowid')
            digest = hashlib.sha256()
            count = 0
            for row in cursor:
                for value in row:
                    payload = value if isinstance(value, bytes) else repr(value).encode()
                    digest.update(type(value).__name__.encode() + b":")
                    digest.update(len(payload).to_bytes(8, "big"))
                    digest.update(payload)
                count += 1
            result[table] = (count, digest.hexdigest())
        return result


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit(f"Usage: {sys.argv[0]} BEFORE.db AFTER.db")
    before, after = map(fingerprint, sys.argv[1:])
    for table in TABLES:
        print(f"{table}: {before[table][0]} -> {after[table][0]}")
    differences = [table for table in TABLES if before[table] != after[table]]
    if differences:
        raise SystemExit("Changed records: " + ", ".join(differences))
