import { isInstanceAdmin, manageableOwner } from "../../authz/sharing";
import express from "express";
import { z } from "zod";
import { Prisma } from "../../generated/client";
import { shareUserFields } from "./profileAvatars";
import { DashboardRouteDeps } from "./types";
import { getUserTrashCollectionId } from "./trash";

const parentCollectionIdSchema = z
  .string()
  .min(1)
  .refine((id) => id !== "trash" && !id.startsWith("trash:"))
  .nullable();

class ParentCollectionNotFound extends Error {}

export const registerCollectionRoutes = (
  app: express.Express,
  deps: DashboardRouteDeps,
) => {
  const {
    prisma,
    requireAuth,
    asyncHandler,
    collectionNameSchema,
    sanitizeText,
    ensureTrashCollection,
    invalidateDrawingsCache,
    config,
    logAuditEvent,
  } = deps;

  // GET /collections — lists collections available in the current session.
  app.get(
    "/collections",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });
      const trashCollectionId = getUserTrashCollectionId(req.user.id);
      await ensureTrashCollection(prisma, req.user.id);

      const admin = isInstanceAdmin(req.user);
      const rawCollections = await prisma.collection.findMany({
        where: admin
          ? {
              OR: [
                { id: trashCollectionId },
                { NOT: { id: { startsWith: "trash:" } } },
              ],
            }
          : { userId: req.user.id },
        orderBy: { createdAt: "desc" },
      });
      const hasInternalTrash = rawCollections.some(
        (c) => c.id === trashCollectionId,
      );
      const shareCountMap = await prisma.collectionShare.groupBy({
        by: ["collectionId"],
        where: {
          collectionId: {
            in: rawCollections.map((c) => c.id),
          },
        },
        _count: { collectionId: true },
      });
      const sharedCollectionIds = new Set(
        shareCountMap.map((s) => s.collectionId),
      );

      const ownedCollections = rawCollections
        .filter((c) => !(hasInternalTrash && c.id === "trash"))
        .map((c) =>
          c.id === trashCollectionId
            ? {
                ...c,
                id: "trash",
                name: "Trash",
                sharedRole: null,
                isOwner: true,
                isShared: false,
              }
            : {
                ...c,
                sharedRole: null,
                isOwner: true,
                isShared: sharedCollectionIds.has(c.id),
              },
        );

      if (admin) return res.json(ownedCollections);

      // Collections shared with this user by others
      const sharedEntries = await prisma.collectionShare.findMany({
        where: { granteeUserId: req.user.id },
        include: {
          collection: {
            include: {
              user: { select: { id: true, name: true, email: true } },
            },
          },
        },
      });
      const visibleSharedIds = new Set(
        sharedEntries.map((s) => s.collectionId),
      );
      const sharedCollections = sharedEntries.map((s) => ({
        ...s.collection,
        parentId:
          s.collection.parentId && visibleSharedIds.has(s.collection.parentId)
            ? s.collection.parentId
            : null,
        sharedRole: s.role,
        isOwner: false,
      }));

      return res.json([...ownedCollections, ...sharedCollections]);
    }),
  );

  // POST /collections
  app.post(
    "/collections",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });

      const parsed = collectionNameSchema.safeParse(req.body.name);
      if (!parsed.success) {
        return res.status(400).json({
          error: "Validation error",
          message: "Collection name must be between 1 and 100 characters",
        });
      }

      const parent = parentCollectionIdSchema.safeParse(
        req.body.parentId ?? null,
      );
      if (!parent.success) {
        return res.status(400).json({ error: "Invalid parent collection" });
      }

      const userId = req.user.id;
      const parentId = parent.data;
      const admin = isInstanceAdmin(req.user);
      const data = { name: sanitizeText(parsed.data, 100), userId, parentId };
      try {
        const newCollection =
          parentId === null
            ? await prisma.collection.create({ data })
            : await prisma.$transaction(async (tx) => {
                const ownedParent = await tx.collection.findFirst({
                  where: { id: parentId, ...(admin ? {} : { userId }) },
                  select: { userId: true },
                });
                if (!ownedParent) throw new ParentCollectionNotFound();
                return tx.collection.create({
                  data: { ...data, userId: ownedParent.userId },
                });
              });
        return res.json({ ...newCollection, sharedRole: null, isOwner: true });
      } catch (error) {
        if (
          error instanceof ParentCollectionNotFound ||
          (parentId !== null &&
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === "P2003")
        ) {
          return res.status(404).json({ error: "Parent collection not found" });
        }
        throw error;
      }
    }),
  );

  // PUT /collections/:id
  app.put(
    "/collections/:id",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });

      const { id } = req.params;
      if (id === "trash" || id.startsWith("trash:")) {
        return res.status(400).json({
          error: "Validation error",
          message: "Trash collection cannot be renamed",
        });
      }
      const existing = await prisma.collection.findFirst({
        where: {
          id,
          NOT: [{ id: "trash" }, { id: { startsWith: "trash:" } }],
          ...manageableOwner(req.user),
        },
      });
      if (!existing)
        return res.status(404).json({ error: "Collection not found" });

      const parsed = collectionNameSchema.safeParse(req.body.name);
      if (!parsed.success) {
        return res.status(400).json({
          error: "Validation error",
          message: "Collection name must be between 1 and 100 characters",
        });
      }

      const sanitizedName = sanitizeText(parsed.data, 100);
      await prisma.collection.updateMany({
        where: {
          id,
          NOT: [{ id: "trash" }, { id: { startsWith: "trash:" } }],
          ...manageableOwner(req.user),
        },
        data: { name: sanitizedName },
      });
      const updated = await prisma.collection.findFirst({
        where: {
          id,
          NOT: [{ id: "trash" }, { id: { startsWith: "trash:" } }],
          ...manageableOwner(req.user),
        },
      });
      if (!updated)
        return res.status(404).json({ error: "Collection not found" });
      return res.json(updated);
    }),
  );

  // DELETE /collections/:id
  app.delete(
    "/collections/:id",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });

      const { id } = req.params;
      if (id === "trash" || id.startsWith("trash:")) {
        return res.status(400).json({
          error: "Validation error",
          message: "Trash collection cannot be deleted",
        });
      }
      const collection = await prisma.collection.findFirst({
        where: {
          id,
          NOT: [{ id: "trash" }, { id: { startsWith: "trash:" } }],
          ...manageableOwner(req.user),
        },
      });
      if (!collection)
        return res.status(404).json({ error: "Collection not found" });

      await prisma.$transaction([
        prisma.drawing.updateMany({
          where: { collectionId: id },
          data: { collectionId: null },
        }),
        prisma.collectionShare.deleteMany({ where: { collectionId: id } }),
        prisma.collection.deleteMany({
          where: { id, ...manageableOwner(req.user) },
        }),
      ]);
      invalidateDrawingsCache();

      if (config.enableAuditLogging) {
        await logAuditEvent({
          userId: req.user.id,
          action: "collection_deleted",
          resource: `collection:${id}`,
          ipAddress: req.ip || req.connection.remoteAddress || undefined,
          userAgent: req.headers["user-agent"] || undefined,
          details: { collectionId: id, collectionName: collection.name },
        });
      }

      return res.json({ success: true });
    }),
  );

  // ─── Collection Sharing ───────────────────────────────────────────────────

  // GET /collections/:id/shares — list shares
  app.get(
    "/collections/:id/shares",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });
      const { id } = req.params;

      const collection = await prisma.collection.findFirst({
        where: {
          id,
          NOT: [{ id: "trash" }, { id: { startsWith: "trash:" } }],
          ...manageableOwner(req.user),
        },
      });
      if (!collection)
        return res.status(404).json({ error: "Collection not found" });

      const shares = await prisma.collectionShare.findMany({
        where: { collectionId: id },
        include: {
          granteeUser: { select: shareUserFields },
        },
        orderBy: { createdAt: "asc" },
      });

      return res.json({ shares });
    }),
  );

  // POST /collections/:id/shares — add or update a user share
  app.post(
    "/collections/:id/shares",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });
      const { id } = req.params;
      const { identifier, role } = req.body as {
        identifier: string;
        role: string;
      };

      if (!identifier || !["view", "edit"].includes(role)) {
        return res
          .status(400)
          .json({ error: "identifier and role (view|edit) are required" });
      }

      const collection = await prisma.collection.findFirst({
        where: {
          id,
          NOT: [{ id: "trash" }, { id: { startsWith: "trash:" } }],
          ...manageableOwner(req.user),
        },
      });
      if (!collection)
        return res.status(404).json({ error: "Collection not found" });

      // Resolve user by email or username
      const grantee = await prisma.user.findFirst({
        where: {
          isActive: true,
          OR: [
            { email: identifier.toLowerCase() },
            { username: identifier },
            { name: identifier },
          ],
        },
        select: { id: true, name: true, email: true },
      });
      if (!grantee) return res.status(404).json({ error: "User not found" });
      if (grantee.id === collection.userId)
        return res.status(400).json({ error: "Cannot share with yourself" });

      const share = await prisma.collectionShare.upsert({
        where: {
          collectionId_granteeUserId: {
            collectionId: id,
            granteeUserId: grantee.id,
          },
        },
        update: { role, updatedAt: new Date() },
        create: {
          collectionId: id,
          granteeUserId: grantee.id,
          role,
          createdByUserId: req.user.id,
        },
        include: {
          granteeUser: { select: shareUserFields },
        },
      });
      invalidateDrawingsCache();

      return res.json({ share });
    }),
  );

  // PATCH /collections/:id/shares/:userId — update role
  app.patch(
    "/collections/:id/shares/:userId",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });
      const { id, userId } = req.params;
      const { role } = req.body as { role: string };

      if (!["view", "edit"].includes(role)) {
        return res.status(400).json({ error: "role must be view or edit" });
      }

      const collection = await prisma.collection.findFirst({
        where: {
          id,
          NOT: [{ id: "trash" }, { id: { startsWith: "trash:" } }],
          ...manageableOwner(req.user),
        },
      });
      if (!collection)
        return res.status(404).json({ error: "Collection not found" });

      const share = await prisma.collectionShare.updateMany({
        where: { collectionId: id, granteeUserId: userId },
        data: { role, updatedAt: new Date() },
      });
      if (share.count === 0)
        return res.status(404).json({ error: "Share not found" });
      invalidateDrawingsCache();

      return res.json({ success: true });
    }),
  );

  // DELETE /collections/:id/shares/:userId — remove a user
  app.delete(
    "/collections/:id/shares/:userId",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });
      const { id, userId } = req.params;

      const collection = await prisma.collection.findFirst({
        where: {
          id,
          NOT: [{ id: "trash" }, { id: { startsWith: "trash:" } }],
          ...manageableOwner(req.user),
        },
      });
      if (!collection)
        return res.status(404).json({ error: "Collection not found" });

      await prisma.collectionShare.deleteMany({
        where: { collectionId: id, granteeUserId: userId },
      });
      invalidateDrawingsCache();
      return res.json({ success: true });
    }),
  );

  // GET /collections/:id/share-resolve — search users to share with
  app.get(
    "/collections/:id/share-resolve",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });
      const { id } = req.params;
      const q = String(req.query.q || "").trim();

      if (q.length < 2) return res.json({ users: [] });

      const collection = await prisma.collection.findFirst({
        where: {
          id,
          NOT: [{ id: "trash" }, { id: { startsWith: "trash:" } }],
          ...manageableOwner(req.user),
        },
      });
      if (!collection)
        return res.status(404).json({ error: "Collection not found" });

      // Get already-shared user IDs to exclude them
      const existing = await prisma.collectionShare.findMany({
        where: { collectionId: id },
        select: { granteeUserId: true },
      });
      const excludeIds = [
        collection.userId,
        ...existing.map((s) => s.granteeUserId),
      ];

      const users = await prisma.user.findMany({
        where: {
          isActive: true,
          id: { notIn: excludeIds },
          OR: [
            { email: { contains: q } },
            { name: { contains: q } },
            { username: { contains: q } },
          ],
        },
        select: shareUserFields,
        take: 8,
      });

      return res.json({ users });
    }),
  );
};
