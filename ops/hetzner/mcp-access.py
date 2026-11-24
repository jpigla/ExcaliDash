#!/usr/bin/env python3
import argparse
import datetime
import fcntl
import json
import os
from pathlib import Path
import subprocess
import tempfile


def admin(*args, capture=False):
    return subprocess.run(
        [
            "./compose.sh", "exec", "-T", "-e", "DOTENV_CONFIG_QUIET=true",
            "backend", "node", "/app/dist/mcp/admin.js", *args,
        ],
        check=True,
        text=True,
        stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
    ).stdout


def save_policy(path, policy):
    fd, name = tempfile.mkstemp(dir=path.parent)
    candidate = Path(name)
    try:
        with os.fdopen(fd, "w") as handle:
            json.dump(policy, handle, indent=2)
            handle.write("\n")
        owner = path.stat()
        os.chown(candidate, owner.st_uid, owner.st_gid)
        candidate.chmod(owner.st_mode & 0o777)
        admin("validate", f"/run/excalidash-mcp/{candidate.name}")
        candidate.replace(path)
    finally:
        candidate.unlink(missing_ok=True)


def desktop_policy(args, path, policy):
    entries = policy["agents"]
    entry = next((a for a in entries if a.get("managedByUserId") == args.owner_id), None)
    if args.action == "provision":
        if entry:
            raise SystemExit("This owner already has a Codex account. Use rotate for a new token.")
        result = json.loads(admin("provision-desktop", args.owner_id, capture=True))
        entries.append(result["agent"])
    elif not entry:
        raise SystemExit("No Codex entry for this owner.")
    elif args.action == "rotate":
        result = json.loads(admin("token", capture=True))
        entry["credential"] = result["credential"]
        entry["expiresAt"] = (
            datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=365)
        ).isoformat()
    else:
        # Disable immediately, preserving the agent and collection for later rotation.
        entry["expiresAt"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        result = None
    save_policy(path, policy)
    if result is not None:
        print(result["token"])


def main():
    parser = argparse.ArgumentParser(description="Issue or revoke one ExcaliDash MCP board grant")
    commands = parser.add_subparsers(dest="command", required=True)
    grant = commands.add_parser("grant")
    grant.add_argument("agent_id")
    grant.add_argument("user_id")
    grant.add_argument("board_id")
    grant.add_argument("mode", choices=["read", "edit"])
    grant.add_argument("--minutes", type=int, default=60)
    grant.add_argument("--frame")
    revoke = commands.add_parser("revoke")
    revoke.add_argument("agent_id")
    desktop = commands.add_parser("desktop")
    desktop.add_argument("action", choices=["provision", "rotate", "revoke"])
    desktop.add_argument("owner_id")
    args = parser.parse_args()

    os.chdir(Path(__file__).resolve().parent)
    path = Path("state/mcp/policy.json")
    with (path.parent / ".lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        policy = json.loads(path.read_text())
        if args.command == "desktop":
            desktop_policy(args, path, policy)
            return
        entries = policy["agents"]
        existing = next((entry for entry in entries if entry["id"] == args.agent_id), None)
        if args.command == "revoke":
            if existing is None:
                return
            entries.remove(existing)
        else:
            if existing is not None:
                parser.error("Agent ID already exists. Use a new ID or revoke the old grant first.")
            if args.minutes <= 0:
                parser.error("--minutes must be positive.")
            expiry = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=args.minutes)
            board = {"boardId": args.board_id, "mode": args.mode}
            if args.frame:
                board["frameId"] = args.frame
            credential = json.loads(admin("token", capture=True))
            entries.append({
                "id": args.agent_id,
                "userId": args.user_id,
                "expiresAt": expiry.isoformat(),
                "credential": credential["credential"],
                "boards": [board],
            })

        save_policy(path, policy)
        if args.command == "grant":
            print(credential["token"])


if __name__ == "__main__":
    main()
