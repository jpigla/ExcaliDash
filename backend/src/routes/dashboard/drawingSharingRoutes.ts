import express from "express";
import { z } from "zod";
import {
  decryptGuestLinkToken,
  encryptGuestLinkToken,
  hashGuestPassphrase,
  isValidGuestPassphrase,
} from "../../authz/guestLinkSecurity";
import { config as appConfig } from "../../config";
import type { Prisma } from "../../generated/client";
import { lockDrawingForGuestAccess } from "./drawingGuestLock";
import { isTrashCollectionId } from "./trash";
import {
  buildShareLinkToken,
  hashShareLinkToken,
  normalizeDrawingPermission,
} from "../../authz/sharing";
import type { DrawingRouteContext } from "./drawingRouteContext";

const guestLinkFields = {
  id: true,
  permission: true,
  expiresAt: true,
  revokedAt: true,
  createdAt: true,
  encryptedToken: true,
  passphraseHash: true,
} satisfies Prisma.DrawingLinkShareSelect;

type GuestLinkRow = Prisma.DrawingLinkShareGetPayload<{
  select: typeof guestLinkFields;
}>;

const recoverLinkToken = (encrypted: string): string | null => {
  try {
    return decryptGuestLinkToken(encrypted, appConfig.jwtSecret);
  } catch {
    // Changing JWT_SECRET invalidates existing browser sessions and prevents
    // copying old links. Owners can still list and revoke those links.
    return null;
  }
};

const serializeGuestLink = ({
  encryptedToken,
  passphraseHash,
  ...share
}: GuestLinkRow) => ({
  ...share,
  passwordProtected: passphraseHash !== null,
  token:
    encryptedToken &&
    !share.revokedAt &&
    (!share.expiresAt || share.expiresAt.getTime() > Date.now())
      ? recoverLinkToken(encryptedToken)
      : null,
});

const linkChanges = z.strictObject({
  permission: z
    .enum(["view", "edit"], { error: "Invalid permission" })
    .optional(),
  expiresAt: z.iso
    .datetime({ offset: true, error: "Invalid expiry" })
    .refine((value) => Date.parse(value) - Date.now() >= 60_000, {
      message: "Expiry must be at least 1 minute in the future",
    })
    .nullable()
    .optional(),
  passphrase: z
    .string({ error: "Invalid passphrase" })
    .refine(isValidGuestPassphrase, {
      message: "Use at least 8 characters and at most 72 UTF-8 bytes",
    })
    .nullable()
    .optional(),
});

const createLink = linkChanges.required({ permission: true });
const updateLink = linkChanges.refine(
  (payload) => Object.keys(payload).length > 0,
  { message: "At least one link setting is required" },
);

const sendLinkValidationError = (res: express.Response, error: z.ZodError) =>
  res.status(400).json({
    error: "Validation error",
    message: error.issues[0]?.message ?? "Invalid link settings",
  });

export const registerDrawingSharingRoutes = (
  app: express.Express,
  context: DrawingRouteContext,
) => {
  const {
    prisma,
    requireAuth,
    asyncHandler,
    invalidateDrawingsCache,
    config,
    logAuditEvent,
    resolveDefaultTtlMs,
    revalidateDrawingAccess,
  } = context;

  // Kick any connected collaborators whose access to this drawing just changed.
  // Best-effort: never let a socket failure break the sharing HTTP response.
  const revokeLiveAccess = async (drawingId: string): Promise<void> => {
    if (!revalidateDrawingAccess) return;
    try {
      await revalidateDrawingAccess(drawingId);
    } catch (err) {
      console.error("Failed to revalidate live drawing access:", err);
    }
  };
  // Owner-only: resolve users by name/email in the context of a drawing you own (reduces enumeration risk).
  app.get(
    "/drawings/:id/share-resolve",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });

      const { id } = req.params;
      const qRaw = typeof req.query.q === "string" ? req.query.q.trim() : "";
      const q = qRaw.toLowerCase();
      if (q.length < 3) return res.json({ users: [] });

      const drawing = await prisma.drawing.findUnique({
        where: { id },
        select: { userId: true },
      });
      if (!drawing || drawing.userId !== req.user.id) {
        return res.status(404).json({ error: "Drawing not found" });
      }

      const users = await prisma.user.findMany({
        where: {
          isActive: true,
          id: { not: req.user.id },
          OR: [
            { email: { contains: q } },
            { name: { contains: q } },
            { username: { contains: q } },
          ],
        },
        select: { id: true, name: true, email: true },
        take: 10,
      });

      return res.json({ users });
    }),
  );

  app.get(
    "/drawings/:id/sharing",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });
      const { id } = req.params;

      const drawing = await prisma.drawing.findUnique({
        where: { id },
        select: { userId: true },
      });
      if (!drawing || drawing.userId !== req.user.id) {
        return res.status(404).json({ error: "Drawing not found" });
      }

      const [permissions, linkShares] = await Promise.all([
        prisma.drawingPermission.findMany({
          where: { drawingId: id },
          select: {
            id: true,
            granteeUserId: true,
            permission: true,
            createdAt: true,
            updatedAt: true,
            granteeUser: { select: { id: true, name: true, email: true } },
          },
          orderBy: { createdAt: "desc" },
        }),
        prisma.drawingLinkShare.findMany({
          where: { drawingId: id },
          select: {
            id: true,
            permission: true,
            expiresAt: true,
            revokedAt: true,
            createdAt: true,
            updatedAt: true,
            lastUsedAt: true,
          },
          orderBy: { createdAt: "desc" },
        }),
      ]);

      return res.json({ permissions, linkShares });
    }),
  );

  app.post(
    "/drawings/:id/permissions",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });
      const { id } = req.params;

      const drawing = await prisma.drawing.findUnique({
        where: { id },
        select: { userId: true },
      });
      if (!drawing || drawing.userId !== req.user.id) {
        return res.status(404).json({ error: "Drawing not found" });
      }

      const granteeUserId =
        typeof req.body?.granteeUserId === "string"
          ? req.body.granteeUserId
          : null;
      const permission = normalizeDrawingPermission(req.body?.permission);
      if (!granteeUserId || !permission) {
        return res.status(400).json({
          error: "Validation error",
          message: "Invalid grantee or permission",
        });
      }
      if (granteeUserId === req.user.id) {
        return res.status(400).json({
          error: "Validation error",
          message: "Cannot share with yourself",
        });
      }

      const user = await prisma.user.findUnique({
        where: { id: granteeUserId },
        select: { id: true, isActive: true },
      });
      if (!user || !user.isActive) {
        return res.status(404).json({ error: "User not found" });
      }

      const saved = await prisma.drawingPermission.upsert({
        where: {
          drawingId_granteeUserId: { drawingId: id, granteeUserId },
        },
        update: { permission, createdByUserId: req.user.id },
        create: {
          drawingId: id,
          granteeUserId,
          permission,
          createdByUserId: req.user.id,
        },
        select: {
          id: true,
          granteeUserId: true,
          permission: true,
          createdAt: true,
          updatedAt: true,
          granteeUser: { select: { id: true, name: true, email: true } },
        },
      });

      invalidateDrawingsCache();

      if (config.enableAuditLogging) {
        await logAuditEvent({
          userId: req.user.id,
          action: "drawing_shared_user_upsert",
          resource: `drawing:${id}`,
          ipAddress: req.ip || req.connection.remoteAddress || undefined,
          userAgent: req.headers["user-agent"] || undefined,
          details: { drawingId: id, granteeUserId, permission },
        });
      }

      return res.json({ permission: saved });
    }),
  );

  app.delete(
    "/drawings/:id/permissions/:permId",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });
      const { id, permId } = req.params;

      const drawing = await prisma.drawing.findUnique({
        where: { id },
        select: { userId: true },
      });
      if (!drawing || drawing.userId !== req.user.id) {
        return res.status(404).json({ error: "Drawing not found" });
      }

      await prisma.drawingPermission.deleteMany({
        where: { id: permId, drawingId: id },
      });
      invalidateDrawingsCache();
      await revokeLiveAccess(id);

      if (config.enableAuditLogging) {
        await logAuditEvent({
          userId: req.user.id,
          action: "drawing_shared_user_revoke",
          resource: `drawing:${id}`,
          ipAddress: req.ip || req.connection.remoteAddress || undefined,
          userAgent: req.headers["user-agent"] || undefined,
          details: { drawingId: id, permissionId: permId },
        });
      }

      return res.json({ success: true });
    }),
  );

  const findOwnedDrawing = (
    db: Prisma.TransactionClient,
    drawingId: string,
    userId: string,
  ) =>
    db.drawing.findFirst({
      where: { id: drawingId, userId },
      select: { collectionId: true },
    });

  const recordLinkEvent = async (
    req: express.Request,
    drawingId: string,
    userId: string,
    action: string,
    shareId: string,
  ): Promise<void> => {
    if (!config.enableAuditLogging) return;
    await logAuditEvent({
      userId,
      action,
      resource: `drawing:${drawingId}`,
      ipAddress: req.ip || req.connection.remoteAddress || undefined,
      userAgent: req.headers["user-agent"] || undefined,
      details: { drawingId, shareId },
    });
  };

  app.get(
    "/drawings/:id/link-shares",
    requireAuth,
    asyncHandler(async (req, res) => {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: "Unauthorized" });
      const { id } = req.params;

      if (!(await findOwnedDrawing(prisma, id, userId))) {
        return res.status(404).json({ error: "Drawing not found" });
      }

      const shares = await prisma.drawingLinkShare.findMany({
        where: { drawingId: id },
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        select: guestLinkFields,
      });
      return res.set("Cache-Control", "no-store").json({
        shares: shares.map(serializeGuestLink),
      });
    }),
  );

  app.post(
    "/drawings/:id/link-shares",
    requireAuth,
    asyncHandler(async (req, res) => {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: "Unauthorized" });
      const { id } = req.params;
      const input = createLink.safeParse(req.body);
      if (!input.success) {
        return sendLinkValidationError(res, input.error);
      }
      if (!(await findOwnedDrawing(prisma, id, userId))) {
        return res.status(404).json({ error: "Drawing not found" });
      }

      const { permission, expiresAt, passphrase } = input.data;
      const token = buildShareLinkToken();
      const passphraseHash = passphrase
        ? await hashGuestPassphrase(passphrase)
        : null;
      const share = await prisma.$transaction(async (tx) => {
        await lockDrawingForGuestAccess(tx, id);
        const drawing = await findOwnedDrawing(tx, id, userId);
        if (!drawing || isTrashCollectionId(drawing.collectionId, userId)) {
          return null;
        }
        return tx.drawingLinkShare.create({
          data: {
            drawingId: id,
            permission,
            tokenHash: hashShareLinkToken(token),
            encryptedToken: encryptGuestLinkToken(token, appConfig.jwtSecret),
            passphraseHash,
            expiresAt:
              expiresAt === undefined
                ? new Date(Date.now() + resolveDefaultTtlMs(permission))
                : expiresAt === null
                  ? null
                  : new Date(expiresAt),
            createdByUserId: userId,
          },
          select: guestLinkFields,
        });
      });
      if (!share) {
        return res.status(404).json({ error: "Drawing not found or in trash" });
      }

      await recordLinkEvent(
        req,
        id,
        userId,
        "drawing_link_share_created",
        share.id,
      );
      return res
        .set("Cache-Control", "no-store")
        .json({ share: serializeGuestLink(share) });
    }),
  );

  app.patch(
    "/drawings/:id/link-shares/:shareId",
    requireAuth,
    asyncHandler(async (req, res) => {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: "Unauthorized" });
      const { id, shareId } = req.params;
      const input = updateLink.safeParse(req.body);
      if (!input.success) {
        return sendLinkValidationError(res, input.error);
      }
      if (!(await findOwnedDrawing(prisma, id, userId))) {
        return res.status(404).json({ error: "Drawing not found" });
      }

      const { permission, expiresAt, passphrase } = input.data;
      const passphraseHash =
        typeof passphrase === "string"
          ? await hashGuestPassphrase(passphrase)
          : passphrase;
      const share = await prisma.$transaction(async (tx) => {
        await lockDrawingForGuestAccess(tx, id);
        const drawing = await findOwnedDrawing(tx, id, userId);
        if (!drawing || isTrashCollectionId(drawing.collectionId, userId)) {
          return null;
        }
        const current = await tx.drawingLinkShare.findFirst({
          where: {
            id: shareId,
            drawingId: id,
            revokedAt: null,
            encryptedToken: { not: null },
          },
          select: { permission: true, expiresAt: true, passphraseHash: true },
        });
        if (!current) return null;

        const accessChanged =
          (permission !== undefined && permission !== current.permission) ||
          (passphraseHash !== undefined &&
            passphraseHash !== current.passphraseHash) ||
          (expiresAt !== undefined &&
            (expiresAt === null ? null : Date.parse(expiresAt)) !==
              (current.expiresAt?.getTime() ?? null));
        return tx.drawingLinkShare.update({
          where: { id: shareId },
          data: {
            permission,
            expiresAt:
              typeof expiresAt === "string" ? new Date(expiresAt) : expiresAt,
            passphraseHash,
            ...(accessChanged
              ? {
                  revision: { increment: 1 },
                  failedAttempts: 0,
                  lockedUntil: null,
                }
              : {}),
          },
          select: guestLinkFields,
        });
      });
      if (!share) return res.status(404).json({ error: "Link not found" });

      await revokeLiveAccess(id);
      await recordLinkEvent(
        req,
        id,
        userId,
        "drawing_link_share_updated",
        shareId,
      );
      return res
        .set("Cache-Control", "no-store")
        .json({ share: serializeGuestLink(share) });
    }),
  );

  app.delete(
    "/drawings/:id/link-shares/:shareId",
    requireAuth,
    asyncHandler(async (req, res) => {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: "Unauthorized" });
      const { id, shareId } = req.params;

      if (!(await findOwnedDrawing(prisma, id, userId))) {
        return res.status(404).json({ error: "Drawing not found" });
      }
      const changed = await prisma.$transaction(async (tx) => {
        await lockDrawingForGuestAccess(tx, id);
        const revoked = await tx.drawingLinkShare.updateMany({
          where: {
            id: shareId,
            drawingId: id,
            revokedAt: null,
            drawing: { userId },
          },
          data: { revokedAt: new Date(), revision: { increment: 1 } },
        });
        return revoked.count > 0;
      });
      if (changed) {
        await revokeLiveAccess(id);
        await recordLinkEvent(
          req,
          id,
          userId,
          "drawing_link_share_revoked",
          shareId,
        );
      }

      return res.json({ success: true });
    }),
  );
};
