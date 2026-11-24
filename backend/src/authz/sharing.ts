import type { Prisma } from "../generated/client";
import crypto from "crypto";
import { hashTokenForStorage } from "../auth/tokenSecurity";
import { isTrashCollectionId } from "../routes/dashboard/trash";
import type { GuestPrincipal } from "./guestLinkSecurity";

export type DrawingPermission = "view" | "edit";
export type DrawingAccess = "none" | DrawingPermission | "owner";

export type DrawingPrincipal =
  { kind: "user"; userId: string; instanceAdmin?: boolean } | GuestPrincipal;

type SessionUser = {
  id: string;
  role: string;
  authCredentialType?: string;
  impersonatorId?: string;
};

export const isInstanceAdmin = (user?: SessionUser): boolean =>
  user?.role === "ADMIN" &&
  user.authCredentialType === "jwt" &&
  !user.impersonatorId;

export const sessionDrawingPrincipal = (
  user: SessionUser,
): DrawingPrincipal => ({
  kind: "user",
  userId: user.id,
  instanceAdmin: isInstanceAdmin(user),
});

export const manageableOwner = (user: SessionUser) =>
  isInstanceAdmin(user) ? {} : { userId: user.id };

export const isCurrentInstanceAdmin = async (
  db: Prisma.TransactionClient,
  userId: string,
): Promise<boolean> =>
  Boolean(
    await db.user.findFirst({
      where: {
        id: userId,
        role: "ADMIN",
        isActive: true,
        mustResetPassword: false,
      },
      select: { id: true },
    }),
  );

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

type DrawingAccessParams = {
  prisma: Prisma.TransactionClient;
  principal: DrawingPrincipal | null;
  drawingId: string;
  now?: Date;
};

export type DrawingAccessDetails = {
  access: DrawingAccess;
  baseAccess: DrawingAccess;
  linkExpiresAt: number | null;
  trashed: boolean;
};

export const getDrawingAccessDetails = async (
  params: DrawingAccessParams,
): Promise<DrawingAccessDetails> => {
  const now = params.now ?? new Date();
  const { principal, prisma, drawingId } = params;
  if (principal?.kind === "guest") {
    if (
      principal.drawingId !== drawingId ||
      principal.expiresAt <= now.getTime()
    )
      return {
        access: "none",
        baseAccess: "none",
        linkExpiresAt: null,
        trashed: false,
      };

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
        expiresAt: true,
        drawing: { select: { userId: true, collectionId: true } },
      },
    });
    if (
      !share ||
      isTrashCollectionId(share.drawing.collectionId, share.drawing.userId)
    ) {
      return {
        access: "none",
        baseAccess: "none",
        linkExpiresAt: null,
        trashed: false,
      };
    }
    return {
      access: normalizeDrawingPermission(share.permission) ?? "none",
      baseAccess: "none",
      linkExpiresAt: Math.min(
        principal.expiresAt,
        share.expiresAt?.getTime() ?? Infinity,
      ),
      trashed: false,
    };
  }

  let baseAccess: DrawingAccess = "none";

  if (params.principal?.kind === "user") {
    const drawing = await params.prisma.drawing.findUnique({
      where: { id: params.drawingId },
      select: { userId: true, collectionId: true },
    });
    const trashed = Boolean(
      drawing && isTrashCollectionId(drawing.collectionId, drawing.userId),
    );
    if (
      drawing &&
      (drawing.userId === params.principal.userId ||
        (params.principal.instanceAdmin &&
          (await isCurrentInstanceAdmin(prisma, params.principal.userId))))
    ) {
      return {
        access: "owner",
        baseAccess: "owner",
        linkExpiresAt: null,
        trashed,
      };
    }
    if (!drawing || trashed) {
      return {
        access: "none",
        baseAccess: "none",
        linkExpiresAt: null,
        trashed,
      };
    }
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

  // Tokenized guest links only grant access to their validated guest principal.
  return {
    access: baseAccess,
    baseAccess,
    linkExpiresAt: null,
    trashed: false,
  };
};

export const getDrawingAccess = async (
  params: DrawingAccessParams,
): Promise<DrawingAccess> => (await getDrawingAccessDetails(params)).access;

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
