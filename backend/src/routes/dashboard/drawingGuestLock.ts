import type { Prisma } from "../../generated/client";

export const guestAccessEnded = new Error("Guest drawing access ended");

// Take the drawing write lock before consulting or changing guest grants. A
// no-op update works with both PostgreSQL row locks and SQLite's writer lock.
export const lockDrawingForGuestAccess = async (
  tx: Prisma.TransactionClient,
  drawingId: string,
): Promise<void> => {
  await tx.$executeRaw`
    UPDATE "Drawing" SET "updatedAt" = "updatedAt" WHERE "id" = ${drawingId}
  `;
};

export const revokeAllDrawingGuestLinks = async (
  tx: Prisma.TransactionClient,
  drawingId: string,
): Promise<void> => {
  await tx.drawingLinkShare.updateMany({
    where: { drawingId, revokedAt: null },
    data: { revokedAt: new Date(), revision: { increment: 1 } },
  });
};
