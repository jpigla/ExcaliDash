ALTER TABLE "DrawingLinkShare" ADD COLUMN "uploadWindowAt" TIMESTAMP(3);
ALTER TABLE "DrawingLinkShare" ADD COLUMN "uploadCount" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "DrawingFile" ADD COLUMN "guestShareId" TEXT;
ALTER TABLE "DrawingFile" ADD COLUMN "guestOrphanCheckAt" TIMESTAMP(3);
ALTER TABLE "DrawingFile" ADD COLUMN "guestPublishedAt" TIMESTAMP(3);
CREATE INDEX "DrawingFile_guestOrphanCheckAt_idx" ON "DrawingFile"("guestOrphanCheckAt");

CREATE TABLE "GuestUploadCleanup" (
    "s3Key" TEXT NOT NULL PRIMARY KEY,
    "drawingId" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "GuestUploadCleanup_drawingId_idx" ON "GuestUploadCleanup"("drawingId");
CREATE INDEX "GuestUploadCleanup_nextAttemptAt_idx" ON "GuestUploadCleanup"("nextAttemptAt");
