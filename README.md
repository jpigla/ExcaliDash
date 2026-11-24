# ExcaliDash

Self-hosted Excalidraw workspaces with collections, real-time collaboration,
sharing, history, backups, and local or OpenID Connect authentication.

[![ExcaliDash dashboard](docs/public/images/workspace.png)](https://excalidash.xyz)

[Self-host Excalidraw with Docker Compose](https://excalidash.xyz/deploy/docker),
or read the documentation at [excalidash.xyz](https://excalidash.xyz).

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
and upgrade details. The quick start below uses the original ExcaliDash images.

## Quick start

```sh
git clone https://github.com/ZimengXiong/ExcaliDash.git
cd ExcaliDash
docker compose -f docker-compose.prod.yml up -d
```

Open <http://localhost:6767>. Configuration and deployment guidance live in
the [documentation](https://excalidash.xyz).

ExcaliDash is licensed under the GNU Lesser General Public License v3.0.
