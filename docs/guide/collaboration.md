---
title: Self-hosted Excalidraw Collaboration and Sharing
description: Collaborate on Excalidraw drawings with your own ExcaliDash server. Share drawings and collections, manage access, and troubleshoot live editing.
---

# Self-hosted Excalidraw collaboration

ExcaliDash lets people edit Excalidraw drawings together while storing them on your own server. The frontend and backend in the [Docker Compose deployment](/deploy/docker) provide the workspace and real-time connection.

## Share a drawing with your team

1. [Create accounts](/guide/first-run) for the people who will use your workspace, or [configure OpenID Connect](/guide/authentication).
2. Create or open a drawing and select **Share**.
3. Add the account you want to invite and choose viewing or editing access.
4. Have the invited person open the drawing from their shared workspace.
5. Open the same drawing at the same time to work together. Editing access allows collaborators to change the drawing; viewing access allows them to read it.

<ThemeScreenshot light="/images/screenshots/share-drawing-light.png" dark="/images/screenshots/share-drawing.png" alt="Share dialog open with account search and access controls" />

Live cursors and presence help you see who is working on the drawing.

<ThemeScreenshot light="/images/collaboration-light.png" dark="/images/collaboration-dark.png" alt="Live deployment drawing with collaborator avatars and named cursors" />

## Share collections

Collections group related drawings. Right-click a collection in the sidebar and select **Share Collection**. Share the collection with other accounts and select their access level to work on a set of drawings together. Keep access scoped to the people who need it.

<ThemeScreenshot light="/images/screenshots/share-collection-light.png" dark="/images/screenshots/share-collection.png" alt="Share Collection dialog open for Platform engineering" />

## Share a link

Enable account authentication on instances that use guest links to restrict access. In single-user mode with authentication disabled, visitors already have workspace access.

Open **Share** on a drawing to create a guest link. A drawing can have several links, each with its own permissions, password, and expiration. Guests can open the link without an account. Choose **View** for live viewing or **Edit** to allow changes and image uploads. Set an expiration of one hour, one day, one week, a custom date and time, or no expiration.

You can copy, edit, or revoke each active link from the share dialog. Share a protected link's password separately. The browser remembers a successful unlock for up to 30 days or until the link expires. Changing its password, permissions, or expiration ends active guest sessions for that link. Moving the drawing to Trash revokes all its guest links permanently.

On upgrade from versions that used the drawing ID as a public link, those public links are revoked. Open each drawing's share dialog to create replacement guest links. Existing account and collection permissions still apply.

Keep the configured JWT secret stable across restarts and back it up separately from the database. The server derives a key from it to recover the share URLs for owners. Rotating that secret invalidates guest sessions and makes previous URLs unavailable to copy. Recreate affected links after rotation.

If you use S3 for drawings with sensitive images, keep the bucket private and leave `S3_PUBLIC_URL` unset. Guest links control access through ExcaliDash. Public object URLs can still be opened directly.

## Configure your reverse proxy

For HTTPS deployments, your proxy must forward WebSocket upgrades for `/socket.io/`. Set `FRONTEND_URL` to the origin people use to open your workspace, and configure `TRUST_PROXY` for your trusted proxy chain. Follow the [HTTPS deployment instructions](/deploy/docker#configure-https).

## Troubleshoot live editing

If the drawing loads but edits do not appear in the second session:

- Confirm both people opened the same drawing and have the intended permissions.
- Confirm the reverse proxy forwards WebSocket upgrades.
- Check that `FRONTEND_URL` matches the deployed URL, including HTTPS.
- Read the backend logs for connection or authorization errors:

```bash
docker compose -f docker-compose.prod.yml logs --tail=100 backend
```

Collaboration and backups serve different purposes. Use [persistent storage and separate backups](/guide/storage-backups) to protect the workspace over time.
