# ExcaliDash — Self-Hosted Excalidraw Workspace

Open-source, self-hosted **Excalidraw** dashboard and **Excalidraw+ alternative** with persistent server-side drawings, collections, built-in real-time collaboration, version history, backups, and local or OpenID Connect (OIDC) SSO authentication.

[![ExcaliDash self-hosted Excalidraw dashboard](docs/public/images/workspace.png)](https://excalidash.xyz)

- **Documentation:** [excalidash.xyz](https://excalidash.xyz)
- **Self-hosting guide:** [How to self-host Excalidraw with Docker Compose](https://excalidash.xyz/guides/self-host-excalidraw)
- **Comparison:** [Self-hosted Excalidraw+ alternative](https://excalidash.xyz/guides/excalidraw-plus-alternative)
- **Team SSO:** [Excalidraw with OIDC / SSO (Authentik, Keycloak, Pocket ID)](https://excalidash.xyz/guides/excalidraw-oidc-sso)

## What's different in this fork

This fork builds on [ExcaliDash](https://github.com/ZimengXiong/ExcaliDash) and
extends board sharing, account profiles, and editor navigation.

- **Guest links without accounts.** Create several links for the same board.
  Each link can allow live viewing or editing and can be open or password protected.
- **Flexible link management.** Set a preset or custom expiration, or keep a
  link valid until you revoke it. Board owners can change permissions, copy
  links, and reveal saved passwords on demand.
- **Guest access protections.** Changes to a link's access settings end its
  guest sessions. Guests can load images on the current board, while
  history-only images stay private. Guest uploads are limited.
- **Profile pictures.** Signed-in users, including admins, can upload, replace,
  or remove a picture under **Profile**. Pictures appear in the sidebar, on
  boards for signed-in collaborators, and in board and collection sharing
  dialogs. Guest sessions show initials.
- **Board opening view.** The editor centers the whole drawing and fits it
  to the window by default. Under **Settings → Board opening view**, choose
  **Restore last view** to reopen each board at its last zoom and position
  in the same browser. Boards without a saved view open fitted.
- **Zoom down to 1%.** The editor's zoom buttons move in one-percentage-point
  steps between 10% and 1%.
- **Board previews.** Thumbnail bounds exclude deleted elements, so the
  preview fits the visible drawing.
- **Editor toolbar.** With auto-hide enabled, the top bar stays visible while
  the pointer is over it. Move to the top edge to bring it back.
- **Agent access over MCP.** Optional scoped access to create, draw, inspect,
  and edit persistent boards. See the [MCP setup guide](docs/guide/mcp.md).
- **Security fixes.** ZIP imports enforce size limits during decompression,
  stale OIDC sessions cannot restore revoked admin rights, and
  `follow-redirects` is updated to 1.16.3.

See the [guest sharing guide](docs/guide/collaboration.md#share-a-link) for setup
and upgrade details. For this fork, see the [SQLite deployment and update guide](ops/hetzner/README.md). The quick start below uses the upstream images.

## Quick start

```sh
git clone https://github.com/ZimengXiong/ExcaliDash.git
cd ExcaliDash
docker compose -f docker-compose.prod.yml up -d
```

Or drop a standalone `docker-compose.yml` anywhere without cloning:

```yaml
services:
  backend:
    image: zimengxiong/excalidash-backend:latest
    init: true
    environment:
      DATABASE_PROVIDER: sqlite
      DATABASE_URL: file:/app/prisma/dev.db
      PORT: 8000
      NODE_ENV: production
      AUTH_MODE: local
    volumes:
      - backend-data:/app/prisma
    restart: unless-stopped

  frontend:
    image: zimengxiong/excalidash-frontend:latest
    ports:
      - "6767:8080"
    depends_on:
      - backend
    restart: unless-stopped

volumes:
  backend-data:
```

Open <http://localhost:6767> and create your first administrator account.

## Features

- **Persistent workspace:** Save Excalidraw drawings to SQLite (zero-config default) or PostgreSQL, with local or S3-compatible image storage (MinIO, Cloudflare R2, AWS S3).
- **Real-time collaboration:** Built-in Socket.IO sync with named cursors, presence avatars, and viewport follow mode—all on your own server.
- **Organization & sharing:** Group drawings into collections, search and sort across devices, and share drawings or collections with view/edit permissions or expiring public links.
- **Authentication & SSO:** Local email/password accounts, `hybrid` or `oidc_enforced` OpenID Connect (Authentik, Keycloak, Pocket ID, Authelia), group-to-admin mapping, and scoped REST/Socket.IO API keys.
- **Version history & portable backups:** Automatic drawing snapshots with two-click restore, scheduled SQLite backups, standard `.excalidraw` import/export, and full `.excalidash` library archives.

## Documentation

- [How to self-host Excalidraw](https://excalidash.xyz/guides/self-host-excalidraw)
- [Docker Compose deployment, HTTPS (Caddy, Nginx, Traefik) & backups](https://excalidash.xyz/deploy/docker)
- [Real-time collaboration & WebSocket proxy setup](https://excalidash.xyz/guide/collaboration)
- [Authentication & OIDC SSO](https://excalidash.xyz/guide/authentication)
- [Storage, version history & backups](https://excalidash.xyz/guide/storage-backups)
- [Environment variables reference](https://excalidash.xyz/reference/environment)

ExcaliDash is an independent open-source project built around Excalidraw and is not affiliated with Excalidraw. Licensed under the GNU Lesser General Public License v3.0.
