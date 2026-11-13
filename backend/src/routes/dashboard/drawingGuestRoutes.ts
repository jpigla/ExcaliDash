import express from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { config } from "../../config";
import {
  issueGuestSession,
  verifyGuestPassphrase,
} from "../../authz/guestLinkSecurity";
import {
  hashShareLinkToken,
  normalizeDrawingPermission,
} from "../../authz/sharing";
import { isTrashCollectionId } from "./trash";
import type { DrawingRouteContext } from "./drawingRouteContext";

const unlockBody = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{32}$/),
  passphrase: z.string().max(256).optional(),
});

export const registerDrawingGuestRoutes = (
  app: express.Express,
  { prisma, asyncHandler }: DrawingRouteContext,
) => {
  const limitUnlockAttempts = rateLimit({
    windowMs: 60_000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
    validate: { trustProxy: false, xForwardedForHeader: false },
    message: { error: "Too many guest link attempts" },
  });
  app.post(
    "/guest-links/:shareId/unlock",
    (_req, res, next) => {
      res.setHeader("Cache-Control", "no-store");
      next();
    },
    limitUnlockAttempts,
    asyncHandler(async (req, res) => {
      const { shareId } = req.params;
      const input = unlockBody.safeParse(req.body);
      if (typeof shareId !== "string" || !input.success) {
        return res.status(404).json({ error: "Guest link not found" });
      }

      const share = await prisma.drawingLinkShare.findFirst({
        where: {
          id: shareId,
          tokenHash: hashShareLinkToken(input.data.token),
          encryptedToken: { not: null },
          revokedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
        include: { drawing: { select: { userId: true, collectionId: true } } },
      });
      const permission = normalizeDrawingPermission(share?.permission);
      if (
        !share ||
        !permission ||
        isTrashCollectionId(share.drawing.collectionId, share.drawing.userId)
      ) {
        return res.status(404).json({ error: "Guest link not found" });
      }

      if (share.passphraseHash) {
        if (input.data.passphrase === undefined) {
          return res.status(401).json({ code: "GUEST_PASSWORD_REQUIRED" });
        }
        const now = new Date();
        const locked = share.lockedUntil && share.lockedUntil > now;
        if (locked && share.failedAttempts >= 12) {
          return res
            .status(429)
            .json({ error: "Too many guest link attempts" });
        }

        // Reserve a bounded attempt before starting bcrypt, including concurrent requests.
        // The token has already been matched, so the public share ID alone cannot lock a link.
        const resetWindow = await prisma.drawingLinkShare.updateMany({
          where: {
            id: shareId,
            revision: share.revision,
            revokedAt: null,
            OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }],
          },
          data: {
            failedAttempts: 1,
            lockedUntil: new Date(now.getTime() + 60_000),
          },
        });
        if (!resetWindow.count) {
          const attempt = await prisma.drawingLinkShare.updateMany({
            where: {
              id: shareId,
              revision: share.revision,
              revokedAt: null,
              lockedUntil: { gt: now },
              failedAttempts: { lt: 12 },
            },
            data: { failedAttempts: { increment: 1 } },
          });
          if (!attempt.count) {
            return res
              .status(429)
              .json({ error: "Too many guest link attempts" });
          }
        }
        if (
          !(await verifyGuestPassphrase(
            input.data.passphrase,
            share.passphraseHash,
          ))
        ) {
          return res.status(401).json({ code: "GUEST_PASSWORD_INVALID" });
        }
      }

      return res.json({
        ...issueGuestSession(share, config.jwtSecret),
        permission,
        drawingId: share.drawingId,
      });
    }),
  );
};
