import type { Prisma } from "../generated/client";
import crypto from "crypto";
import { hashTokenForStorage } from "../auth/tokenSecurity";
import { isTrashCollectionId } from "../routes/dashboard/trash";
import type { GuestPrincipal } from "./guestLinkSecurity";

export type DrawingPermission = "view" | "edit";
export type DrawingAccess = "none" | DrawingPermission | "owner";

export type DrawingPrincipal =
  { kind: "user"; userId: string } | GuestPrincipal;

export const normalizeDrawingPermission = (
  input: unknown,
): DrawingPermission | null => {
  if (input === "view" || input === "edit") return input;
  return null;
};

export const buildShareLinkToken = (): string =>
  crypto.randomBytes(24).toString("base64url");

export const hashShareLinkToken = (token: string): string =>
  hashTokenForStorage(token);

export const getDrawingAccess = async (params: {
  prisma: Prisma.TransactionClient;
  principal: DrawingPrincipal | null;
  drawingId: string;
  now?: Date;
}): Promise<DrawingAccess> => {
  const now = params.now ?? new Date();
  const { principal, prisma, drawingId } = params;
  if (principal?.kind === "guest") {
    if (
      principal.drawingId !== drawingId ||
      principal.expiresAt <= now.getTime()
    )
      return "none";

    const share = await prisma.drawingLinkShare.findFirst({
      where: {
        id: principal.shareId,
        drawingId,
        revision: principal.revision,
        revokedAt: null,
        encryptedToken: { not: null },
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      select: {
        permission: true,
        drawing: { select: { userId: true, collectionId: true } },
      },
    });
    if (
      !share ||
      isTrashCollectionId(share.drawing.collectionId, share.drawing.userId)
    ) {
      return "none";
    }
    return normalizeDrawingPermission(share.permission) ?? "none";
  }

  let baseAccess: DrawingAccess = "none";

  // User-based access (owner or explicit ACL).
  if (params.principal?.kind === "user") {
    const drawing = await params.prisma.drawing.findUnique({
      where: { id: params.drawingId },
      select: { userId: true, collectionId: true },
    });
    if (!drawing) return "none";
    if (drawing.userId === params.principal.userId) return "owner";

    const perm = await params.prisma.drawingPermission.findUnique({
      where: {
        drawingId_granteeUserId: {
          drawingId: params.drawingId,
          granteeUserId: params.principal.userId,
        },
      },
      select: { permission: true },
    });
    baseAccess = normalizeDrawingPermission(perm?.permission) ?? baseAccess;

    // A drawing inherits the strongest access available from its collection.
    // This matters when a direct drawing grant is weaker than the collection grant.
    if (drawing.collectionId) {
      const ownedCollection = await params.prisma.collection.findFirst({
        where: {
          id: drawing.collectionId,
          userId: params.principal.userId,
        },
        select: { id: true },
      });
      if (ownedCollection) {
        baseAccess = "owner";
      } else {
        const collectionShare = await params.prisma.collectionShare.findFirst({
          where: {
            collectionId: drawing.collectionId,
            granteeUserId: params.principal.userId,
          },
          select: { role: true },
        });
        const collectionAccess =
          normalizeDrawingPermission(collectionShare?.role) ?? "none";
        baseAccess = maxAccess(baseAccess, collectionAccess);
      }
    }
  }

  return baseAccess;
};

export const canViewDrawing = (
  access: DrawingAccess,
): access is Exclude<DrawingAccess, "none"> => access !== "none";

export const canEditDrawing = (
  access: DrawingAccess,
): access is Extract<DrawingAccess, "edit" | "owner"> =>
  access === "edit" || access === "owner";

export const isOwnerAccess = (access: DrawingAccess): boolean =>
  access === "owner";

const accessRank = (access: DrawingAccess): number => {
  switch (access) {
    case "owner":
      return 3;
    case "edit":
      return 2;
    case "view":
      return 1;
    default:
      return 0;
  }
};

const maxAccess = (a: DrawingAccess, b: DrawingAccess): DrawingAccess =>
  accessRank(a) >= accessRank(b) ? a : b;
