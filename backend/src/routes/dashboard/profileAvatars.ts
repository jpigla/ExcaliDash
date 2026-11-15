import type { Express, Request } from "express";
import { BOOTSTRAP_USER_ID } from "../../auth/authMode";
import { sendProfileAvatar } from "../../auth/profileAvatarResponse";
import { canViewDrawing, getDrawingAccess } from "../../authz/sharing";
import type { Prisma } from "../../generated/client";
import type { DashboardRouteDeps } from "./types";

export const shareUserFields = {
  id: true,
  name: true,
  email: true,
  avatar: { select: { version: true } },
} satisfies Prisma.UserSelect;

const getAvatarViewer = (req: Request): string | null => {
  const user = req.user;
  if (
    !user ||
    user.id === BOOTSTRAP_USER_ID ||
    user.impersonatorId ||
    user.authCredentialType === "apiKey"
  ) {
    return null;
  }
  return user.id;
};

export const registerDashboardProfileAvatars = (
  app: Express,
  { prisma, requireAuth, asyncHandler }: DashboardRouteDeps,
) => {
  // The sharing dialogs can show avatars for the accounts already visible to
  // the owner through their existing search and permission list endpoints.
  app.get(
    [
      "/drawings/:id/share-avatars/:userId/:version",
      "/collections/:id/share-avatars/:userId/:version",
    ],
    requireAuth,
    asyncHandler(async (req, res) => {
      res.set("Cache-Control", "no-store");
      const viewerId = getAvatarViewer(req);
      if (!viewerId) return res.sendStatus(404);
      const { id, userId, version } = req.params;
      const where = { id, userId: viewerId };
      const select = { id: true } as const;
      const owned = req.path.toLowerCase().startsWith("/drawings/")
        ? await prisma.drawing.findUnique({ where, select })
        : await prisma.collection.findUnique({ where, select });
      if (!owned) return res.sendStatus(404);
      return sendProfileAvatar(prisma, req, res, userId, version);
    }),
  );

  app.get(
    "/drawings/:id/avatars/:userId/:version",
    requireAuth,
    asyncHandler(async (req, res) => {
      res.set("Cache-Control", "no-store");
      const viewerId = getAvatarViewer(req);
      if (!viewerId) return res.sendStatus(404);
      const { id: drawingId, userId, version } = req.params;
      const [viewerAccess, subjectAccess] = await Promise.all(
        [viewerId, userId].map((id) =>
          getDrawingAccess({
            prisma,
            principal: { kind: "user", userId: id },
            drawingId,
          }),
        ),
      );
      if (!canViewDrawing(viewerAccess) || !canViewDrawing(subjectAccess))
        return res.sendStatus(404);
      return sendProfileAvatar(prisma, req, res, userId, version);
    }),
  );
};
