ALTER TABLE "DrawingLinkShare" ADD COLUMN "encryptedToken" TEXT;
ALTER TABLE "DrawingLinkShare" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0;

-- Older public links granted access through the board ID without a link token.
UPDATE "DrawingLinkShare" SET "revokedAt" = CURRENT_TIMESTAMP WHERE "revokedAt" IS NULL;
