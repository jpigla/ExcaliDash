---
title: Self-Hosted Excalidraw Real-Time Collaboration
description: Run real-time Excalidraw collaboration on your own server with ExcaliDash. Live cursors, follow mode, drawing and collection sharing, link access, and WebSocket proxy setup.
---

# Self-hosted Excalidraw collaboration

ExcaliDash runs real-time Excalidraw collaboration on your own backend. Edits, cursors, presence avatars, and viewport updates sync over Socket.IO without sending drawings to third-party servers.

## Share a drawing

1. [Create local accounts](/guide/first-run) or [set up OpenID Connect](/guide/authentication) for your teammates.
2. Open a drawing and select **Share**.
3. Search for an account and assign **View** or **Edit** access.
4. Have collaborators open the drawing from **Shared with me** or via the drawing URL.

<ThemeScreenshot light="/images/screenshots/share-drawing-light.png" dark="/images/screenshots/share-drawing.png" alt="Share dialog with account search and view/edit permissions" />

### Live cursors and follow mode

When multiple people open the same drawing, named cursors and header avatars show who is active on the canvas. Select any collaborator's avatar in the editor header to follow their viewport as they pan and zoom—useful for design reviews and architecture walkthroughs. Panning or zooming yourself exits follow mode immediately.

<ThemeScreenshot light="/images/collaboration-light.png" dark="/images/collaboration-dark.png" alt="Live deployment diagram with collaborator avatars and named cursors" />

## Share a collection

Collections group related canvases under one permission set. Right-click a collection in the sidebar, select **Share Collection**, and choose who can view or edit the drawings inside it.

<ThemeScreenshot light="/images/screenshots/share-collection-light.png" dark="/images/screenshots/share-collection.png" alt="Share Collection dialog for Platform engineering" />

Enable account authentication on instances that use guest links to restrict access. In single-user mode with authentication disabled, visitors already have workspace access.

Open **Share** on a drawing to create a guest link. A drawing can have several links, each with its own permissions, password, and expiration. Guests can open the link without an account. Choose **View** for live viewing or **Edit** to allow changes and image uploads. Set an expiration of one hour, one day, one week, a custom date and time, or no expiration.

You can copy, edit, or revoke each active link from the share dialog. Share a protected link's password separately. The browser remembers a successful unlock in an HttpOnly cookie for up to 30 days or until the link expires. Hosted deployments require HTTPS for guest sessions. Changing its password, permissions, or expiration ends active guest sessions for that link. Moving the drawing to Trash revokes all its guest links permanently.

Board owners can reveal a guest link password on demand in the share dialog. Passwords set before this feature only have a verification hash. They continue to work, and setting the password again makes it available to reveal without changing the URL. It ends existing guest sessions for that link.

On upgrade from versions that used the drawing ID as a public link, those public links are revoked. Open each drawing's share dialog to create replacement guest links. Existing account and collection permissions still apply.

Keep the configured JWT secret stable across restarts and back it up separately from the database. The server derives a key from it to recover the share URLs for owners. Rotating that secret invalidates guest sessions and makes previous URLs unavailable to copy. Recreate affected links after rotation.

If you use S3 for drawings with sensitive images, keep the bucket private and leave `S3_PUBLIC_URL` unset. Guest links control access through ExcaliDash. Public object URLs can still be opened directly.

Guests can fetch images referenced by the current visible scene. Images kept only for history are restricted to account access. Each guest link allows up to 60 upload attempts per minute. Across all links for a drawing, guest uploads are limited to 100 MiB and 1,000 files. Unused guest uploads become eligible for cleanup after one hour.

<ThemeScreenshot light="/images/screenshots/share-link-light.png" dark="/images/screenshots/share-link.png" alt="Drawing Share dialog with Link access menu open" />

## Socket.IO access with API keys

Automated clients and bots can join collaboration rooms using a personal API key (`exd_...`):

```js
import { io } from "socket.io-client";

const socket = io("https://draw.example.com", {
  auth: { token: process.env.EXCALIDASH_API_KEY },
});
```

- Pass the key in `auth.token` only; API keys are ignored if sent in cookies or query parameters.
- Joining a room requires `drawings:read`; sending updates requires `drawings:write`.
- Open sockets re-verify key validity, scopes, and account status on activity, so revoking a key disconnects or blocks further updates immediately.

## Reverse proxy WebSocket setup

When terminating HTTPS in front of ExcaliDash, your proxy must upgrade WebSocket connections on `/socket.io/`. Set `FRONTEND_URL` to your public origin and `TRUST_PROXY` to the number of trusted proxy hops. See [Configure HTTPS](/deploy/docker#configure-https).

## Troubleshoot live editing

If a drawing loads but changes do not sync between sessions:

- Confirm both sessions opened the same drawing and have edit permission.
- Verify your reverse proxy forwards `Upgrade` and `Connection` headers on `/socket.io/`.
- Check that `FRONTEND_URL` matches the exact browser origin, including `https://`.
- Inspect backend logs for WebSocket or permission errors:

```bash
docker compose -f docker-compose.prod.yml logs --tail=100 backend
```

Live collaboration syncs changes across active sessions; pair it with [storage and backups](/guide/storage-backups) to protect your workspace over time.
