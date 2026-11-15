import { randomUUID } from "node:crypto";
import express, { type RequestHandler } from "express";
import rateLimit from "express-rate-limit";
import { logAuditEvent } from "../utils/audit";
import type { RegisterAccountRoutesDeps } from "./accountRoutes";
import { AVATAR_PIXEL_BYTES, encodeProfileAvatar } from "./profileAvatarPng";

export const AVATAR_PATH = "/profile/avatar";
const AVATAR_MEDIA_TYPE = "application/octet-stream";
const VERSION_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const parsePixels = express.raw({
  type: AVATAR_MEDIA_TYPE,
  limit: AVATAR_PIXEL_BYTES,
  inflate: false,
});

const readPixels: RequestHandler = (req, res, next) => {
  if (!req.is(AVATAR_MEDIA_TYPE)) {
    res.status(415).json({ message: "Expected profile picture pixels" });
    return;
  }
  parsePixels(req, res, (err?: { status?: number }) => {
    if (err) {
      const status =
        err.status === 413 || err.status === 415 ? err.status : 400;
      res.status(status).json({ message: "Invalid profile picture upload" });
      return;
    }
    if (!Buffer.isBuffer(req.body) || req.body.length !== AVATAR_PIXEL_BYTES) {
      res.status(400).json({ message: "Invalid profile picture size" });
      return;
    }
    next();
  });
};

export const registerAccountAvatarRoutes = ({
  router,
  prisma,
  requireAuth,
  requireCsrf,
  ensureAuthEnabled,
  accountActionRateLimiter,
  config,
}: RegisterAccountRoutesDeps) => {
  const requireOwnSession: RequestHandler = async (req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (!(await ensureAuthEnabled(res))) return;
    if (!req.user) {
      res.status(401).json({ message: "User not authenticated" });
      return;
    }
    if (req.user.impersonatorId || req.user.authCredentialType === "apiKey") {
      res
        .status(403)
        .json({ message: "Profile pictures require your own session" });
      return;
    }
    next();
  };

  const limitAccountUploads = rateLimit({
    windowMs: 5 * 60 * 1000,
    limit: 30,
    keyGenerator: (req) => req.user!.id,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: "Too many profile picture updates. Try again later." },
  });

  const verifyWrite: RequestHandler = (req, res, next) => {
    if (requireCsrf(req, res)) next();
  };

  const saveAvatar: RequestHandler = async (req, res) => {
    const userId = req.user!.id;
    const removing = req.method === "DELETE";
    try {
      let avatarVersion: string | null = null;
      if (removing) {
        await prisma.userAvatar.deleteMany({ where: { userId } });
      } else {
        const png = await encodeProfileAvatar(req.body);
        const version = randomUUID();
        await prisma.userAvatar.upsert({
          where: { userId },
          create: { userId, version, png },
          update: { version, png },
          select: { userId: true },
        });
        avatarVersion = version;
      }
      if (config.enableAuditLogging) {
        await logAuditEvent({
          userId,
          action: "profile_updated",
          ipAddress: req.ip || req.connection.remoteAddress || undefined,
          userAgent: req.headers["user-agent"] || undefined,
          details: { field: "avatar" },
        });
      }
      res.json({ user: { id: userId, avatarVersion } });
    } catch {
      console.error("Profile picture update failed");
      res.status(500).json({ message: "Failed to update profile picture" });
    }
  };

  router.put(
    AVATAR_PATH,
    requireAuth,
    accountActionRateLimiter,
    requireOwnSession,
    verifyWrite,
    limitAccountUploads,
    readPixels,
    saveAvatar,
  );
  router.delete(
    AVATAR_PATH,
    requireAuth,
    accountActionRateLimiter,
    requireOwnSession,
    verifyWrite,
    limitAccountUploads,
    saveAvatar,
  );
  router.get(
    `${AVATAR_PATH}/:version`,
    requireAuth,
    requireOwnSession,
    async (req, res) => {
      const { version } = req.params;
      if (typeof version !== "string" || !VERSION_PATTERN.test(version)) {
        return res.sendStatus(404);
      }

      const where = { userId: req.user!.id, version };
      const etag = `"${version}"`;
      const applyCacheHeaders = () => {
        res.set({ "Cache-Control": "private, no-cache", ETag: etag });
        res.vary("Cookie");
        res.vary("Authorization");
      };

      // A revalidation only needs an ownership/version check, not the PNG blob.
      if (req.get("If-None-Match") === etag) {
        const match = await prisma.userAvatar.findUnique({
          where,
          select: { userId: true },
        });
        if (!match) return res.sendStatus(404);
        applyCacheHeaders();
        return res.status(304).end();
      }
      const avatar = await prisma.userAvatar.findUnique({
        where,
        select: { png: true },
      });
      if (!avatar) return res.sendStatus(404);
      applyCacheHeaders();
      return res.type("png").send(avatar.png);
    },
  );
};
