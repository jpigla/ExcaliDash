import type { Request, Response } from "express";
import type { PrismaClient } from "../generated/client";

const VERSION_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const sendProfileAvatar = async (
  prisma: PrismaClient,
  req: Request,
  res: Response,
  userId: string,
  version: unknown,
) => {
  if (typeof version !== "string" || !VERSION_PATTERN.test(version)) {
    return res.sendStatus(404);
  }

  const where = { userId, version, user: { isActive: true } };
  const etag = `"${version}"`;
  const applyCacheHeaders = () => {
    res.set({ "Cache-Control": "private, no-cache", ETag: etag });
    res.vary("Cookie");
    res.vary("Authorization");
  };

  // Revalidation reads metadata only and checks that the image still exists.
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
};
