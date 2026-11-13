ALTER TABLE "DrawingLinkShare" ADD COLUMN "uploadWindowAt" DATETIME;
ALTER TABLE "DrawingLinkShare" ADD COLUMN "uploadCount" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "DrawingFile" ADD COLUMN "guestShareId" TEXT;
ALTER TABLE "DrawingFile" ADD COLUMN "guestOrphanCheckAt" DATETIME;
ALTER TABLE "DrawingFile" ADD COLUMN "guestPublishedAt" DATETIME;
CREATE INDEX "DrawingFile_guestOrphanCheckAt_idx" ON "DrawingFile"("guestOrphanCheckAt");

CREATE TABLE "GuestUploadCleanup" (
    "s3Key" TEXT NOT NULL PRIMARY KEY,
    "drawingId" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "nextAttemptAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "GuestUploadCleanup_drawingId_idx" ON "GuestUploadCleanup"("drawingId");
CREATE INDEX "GuestUploadCleanup_nextAttemptAt_idx" ON "GuestUploadCleanup"("nextAttemptAt");
