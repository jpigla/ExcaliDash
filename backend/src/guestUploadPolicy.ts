import type { Prisma, PrismaClient } from "./generated/client";
import type { GuestPrincipal } from "./authz/guestLinkSecurity";
import { hasDrawingFileContent } from "./drawingFileStore";
import {
  guestAccessEnded,
  lockDrawingForGuestAccess,
} from "./routes/dashboard/drawingGuestLock";
import { collectRetainedDrawingFileIds } from "./routes/storage/retainedFiles";
import { deleteS3Object, isS3Enabled } from "./s3";

const maxGuestBytesPerDrawing = 100 * 1024 * 1024;
const maxGuestFilesPerDrawing = 1000;
const uploadWindowMs = 60_000;
const maxUploadsPerWindow = 60;
const cleanupBatchSize = 100;
const retainedRecheckMs = 24 * 60 * 60 * 1000;

export const guestUploadProvisionalMs = 60 * 60 * 1000;

type GuestUploadLimitCode =
  "GUEST_UPLOAD_RATE_LIMIT" | "GUEST_UPLOAD_QUOTA_EXCEEDED";

export class GuestUploadLimitError extends Error {
  readonly status: 413 | 429;

  constructor(readonly code: GuestUploadLimitCode) {
    super(
      code === "GUEST_UPLOAD_RATE_LIMIT"
        ? "Too many guest uploads. Wait a minute and try again."
        : "This drawing has reached its guest upload limit.",
    );
    this.status = code === "GUEST_UPLOAD_RATE_LIMIT" ? 429 : 413;
  }
}

/** Consume an upload attempt before parsing/storing another file or calling S3. */
export const admitGuestUpload = async (
  prisma: PrismaClient,
  principal: GuestPrincipal,
): Promise<void> => {
  const now = new Date();
  if (principal.expiresAt <= now.getTime()) throw guestAccessEnded;

  const cutoff = new Date(now.getTime() - uploadWindowMs);
  const activeShare: Prisma.DrawingLinkShareWhereInput = {
    id: principal.shareId,
    drawingId: principal.drawingId,
    revision: principal.revision,
    revokedAt: null,
    permission: "edit",
    OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
  };
  const reset = await prisma.drawingLinkShare.updateMany({
    where: {
      AND: [
        activeShare,
        { OR: [{ uploadWindowAt: null }, { uploadWindowAt: { lte: cutoff } }] },
      ],
    },
    data: { uploadWindowAt: now, uploadCount: 1 },
  });
  if (reset.count > 0) return;

  const count = await prisma.drawingLinkShare.updateMany({
    where: {
      ...activeShare,
      uploadWindowAt: { gt: cutoff },
      uploadCount: { lt: maxUploadsPerWindow },
    },
    data: { uploadCount: { increment: 1 } },
  });
  if (count.count > 0) return;

  if (
    !(await prisma.drawingLinkShare.findFirst({
      where: activeShare,
      select: { id: true },
    }))
  ) {
    throw guestAccessEnded;
  }
  throw new GuestUploadLimitError("GUEST_UPLOAD_RATE_LIMIT");
};

export const guestUploadMetadata = (shareId: string) => {
  const createdAt = new Date();
  return {
    guestShareId: shareId,
    createdAt,
    guestOrphanCheckAt: new Date(
      createdAt.getTime() + guestUploadProvisionalMs,
    ),
  };
};

/**
 * Call with the drawing write lock held for the same transaction that stores
 * the file. Counting all guest-origin rows and queued S3 deletions keeps the
 * cap effective across links and across concurrent requests. A preflight
 * using the root client is only an early rejection before remote upload.
 */
export const checkGuestUploadQuota = async (
  tx: Pick<Prisma.TransactionClient, "drawingFile" | "guestUploadCleanup">,
  principal: GuestPrincipal,
  drawingId: string,
  fileId: string,
  sizeBytes: number,
): Promise<void> => {
  if (principal.drawingId !== drawingId) throw guestAccessEnded;

  const existing = await tx.drawingFile.findUnique({
    where: { drawingId_fileId: { drawingId, fileId } },
  });
  if (hasDrawingFileContent(existing)) return;

  const uploaded = await tx.drawingFile.aggregate({
    where: { drawingId, guestShareId: { not: null } },
    _sum: { sizeBytes: true },
    _count: true,
  });
  const pendingCleanup = await tx.guestUploadCleanup.aggregate({
    where: { drawingId },
    _sum: { sizeBytes: true },
    _count: true,
  });
  const existingGuestRow = existing?.guestShareId ? existing : null;
  const totalBytes =
    (uploaded._sum.sizeBytes ?? 0) +
    (pendingCleanup._sum.sizeBytes ?? 0) -
    (existingGuestRow?.sizeBytes ?? 0);
  const totalFiles =
    uploaded._count + pendingCleanup._count - Number(existingGuestRow !== null);

  if (
    sizeBytes > maxGuestBytesPerDrawing - totalBytes ||
    totalFiles >= maxGuestFilesPerDrawing
  ) {
    throw new GuestUploadLimitError("GUEST_UPLOAD_QUOTA_EXCEEDED");
  }
};

export const preflightGuestUploadQuota = (
  prisma: PrismaClient,
  principal: GuestPrincipal,
  drawingId: string,
  fileId: string,
  sizeBytes: number,
): Promise<void> =>
  checkGuestUploadQuota(prisma, principal, drawingId, fileId, sizeBytes);

type CleanupEntry = {
  s3Key: string;
  drawingId: string;
  sizeBytes: number;
};

const scheduleGuestUploadCleanup = async (
  prisma: Pick<PrismaClient, "guestUploadCleanup">,
  entry: CleanupEntry,
): Promise<void> => {
  await prisma.guestUploadCleanup.upsert({
    where: { s3Key: entry.s3Key },
    create: entry,
    update: {},
  });
};

/** Discard only this request's unique S3 generation. Retry failed deletions. */
export const discardGuestS3Upload = async (
  prisma: Pick<PrismaClient, "guestUploadCleanup">,
  entry: CleanupEntry,
): Promise<void> => {
  try {
    await deleteS3Object(entry.s3Key);
  } catch (error) {
    try {
      await scheduleGuestUploadCleanup(prisma, entry);
    } catch (queueError) {
      console.error("[files] Failed to schedule guest upload cleanup:", {
        drawingId: entry.drawingId,
        error,
        queueError,
      });
    }
  }
};

const queueStaleGuestUploads = async (
  prisma: PrismaClient,
  now: Date,
): Promise<number> => {
  const due = await prisma.drawingFile.findMany({
    where: { guestOrphanCheckAt: { lte: now } },
    select: { drawingId: true, fileId: true },
    orderBy: { guestOrphanCheckAt: "asc" },
    take: cleanupBatchSize,
  });
  const dueByDrawing = new Map<string, string[]>();
  for (const { drawingId, fileId } of due) {
    const files = dueByDrawing.get(drawingId);
    if (files) files.push(fileId);
    else dueByDrawing.set(drawingId, [fileId]);
  }

  let removed = 0;
  for (const [drawingId, fileIds] of dueByDrawing) {
    removed += await prisma.$transaction(async (tx) => {
      await lockDrawingForGuestAccess(tx, drawingId);
      const retained = await collectRetainedDrawingFileIds(tx, drawingId);
      const stillDue: Prisma.DrawingFileWhereInput = {
        drawingId,
        fileId: { in: fileIds },
        guestShareId: { not: null },
        guestOrphanCheckAt: { lte: now },
      };
      if (!retained) {
        await tx.drawingFile.updateMany({
          where: stillDue,
          data: {
            guestOrphanCheckAt: new Date(now.getTime() + retainedRecheckMs),
          },
        });
        return 0;
      }

      const stale = await tx.drawingFile.findMany({
        where: {
          ...stillDue,
          fileId: { in: fileIds.filter((id) => !retained.has(id)) },
        },
        select: { fileId: true, storage: true, s3Key: true, sizeBytes: true },
      });
      // Queue exact immutable object generations before removing their rows.
      // Deleting objects inside the transaction would break retained scenes if
      // the transaction rolled back or an S3 operation partially failed.
      for (const { storage, s3Key, sizeBytes } of stale) {
        if (storage === "s3" && s3Key) {
          await tx.guestUploadCleanup.create({
            data: { s3Key, drawingId, sizeBytes },
          });
        }
      }

      const deleted = await tx.drawingFile.deleteMany({
        where: { drawingId, fileId: { in: stale.map((file) => file.fileId) } },
      });
      await tx.drawingFile.updateMany({
        where: stillDue,
        data: {
          guestOrphanCheckAt: new Date(now.getTime() + retainedRecheckMs),
        },
      });
      return deleted.count;
    });
  }

  return removed;
};

export const sweepStaleGuestUploads = async (
  prisma: PrismaClient,
  now = new Date(),
): Promise<number> => {
  const removed = await queueStaleGuestUploads(prisma, now);
  if (!isS3Enabled()) return removed;

  const pending = await prisma.guestUploadCleanup.findMany({
    where: { nextAttemptAt: { lte: now } },
    orderBy: { nextAttemptAt: "asc" },
    take: cleanupBatchSize,
    select: { s3Key: true },
  });
  for (const { s3Key } of pending) {
    try {
      await deleteS3Object(s3Key);
      await prisma.guestUploadCleanup.deleteMany({ where: { s3Key } });
    } catch (error) {
      // Put failures behind newer entries so one unavailable object cannot
      // stop this bounded worker from deleting other pending uploads.
      await prisma.guestUploadCleanup.updateMany({
        where: { s3Key },
        data: { nextAttemptAt: new Date(now.getTime() + retainedRecheckMs) },
      });
      console.error("[Cleanup] Guest upload object cleanup failed:", error);
    }
  }
  return removed;
};
