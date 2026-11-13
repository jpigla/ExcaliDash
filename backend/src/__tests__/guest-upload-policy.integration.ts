import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { GuestPrincipal } from "../authz/guestLinkSecurity";
import { storeDrawingFileOnce } from "../drawingFileStore";
import type { PrismaClient } from "../generated/client";
import {
  admitGuestUpload,
  checkGuestUploadQuota,
  guestUploadMetadata,
  guestUploadProvisionalMs,
  sweepStaleGuestUploads,
} from "../guestUploadPolicy";
import { lockDrawingForGuestAccess } from "../routes/dashboard/drawingGuestLock";
import { getTestPrisma, setupTestDb } from "./testUtils";

let prisma: PrismaClient;
let userId: string;

beforeAll(async () => {
  setupTestDb();
  prisma = getTestPrisma();
  const user = await prisma.user.create({
    data: {
      email: "guest-upload-owner@test.local",
      passwordHash: "unused",
      name: "Owner",
    },
  });
  userId = user.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

const makeDrawing = () =>
  prisma.drawing.create({
    data: {
      userId,
      name: "Guest upload test",
      elements: "[]",
      appState: "{}",
    },
  });

const makeGuest = async (drawingId: string): Promise<GuestPrincipal> => {
  const share = await prisma.drawingLinkShare.create({
    data: {
      drawingId,
      createdByUserId: userId,
      encryptedToken: "test-placeholder",
      tokenHash: randomUUID(),
      permission: "edit",
    },
  });
  return {
    kind: "guest",
    drawingId,
    shareId: share.id,
    revision: share.revision,
    expiresAt: Date.now() + 60_000,
  };
};

const storeGuestFile = async (
  guest: GuestPrincipal,
  fileId: string,
  sizeBytes: number,
) => {
  const drawingId = guest.drawingId;
  return prisma.$transaction(async (tx) => {
    await lockDrawingForGuestAccess(tx, drawingId);
    await checkGuestUploadQuota(tx, guest, drawingId, fileId, sizeBytes);
    return storeDrawingFileOnce(tx, {
      drawingId,
      fileId,
      mimeType: "image/png",
      sizeBytes,
      storage: "db",
      data: Buffer.from("test bytes"),
      ...guestUploadMetadata(guest.shareId),
    });
  });
};

describe("Guest upload storage policy", () => {
  it("shares one byte budget across links and charges immutable file IDs once", async () => {
    const drawing = await makeDrawing();
    const first = await makeGuest(drawing.id);
    const second = await makeGuest(drawing.id);
    await storeGuestFile(first, "existing", 100 * 1024 * 1024);
    await expect(storeGuestFile(second, "new", 1)).rejects.toMatchObject({
      status: 413,
      code: "GUEST_UPLOAD_QUOTA_EXCEEDED",
    });
    const duplicate = await storeGuestFile(second, "existing", 1);
    expect(duplicate.guestShareId).toBe(first.shareId);
    expect(duplicate.sizeBytes).toBe(100 * 1024 * 1024);
    expect(
      await prisma.drawingFile.count({ where: { drawingId: drawing.id } }),
    ).toBe(1);
  });

  it("limits each link separately and resets its window", async () => {
    const drawing = await makeDrawing();
    const first = await makeGuest(drawing.id);
    const second = await makeGuest(drawing.id);
    await prisma.drawingLinkShare.update({
      where: { id: first.shareId },
      data: { uploadWindowAt: new Date(), uploadCount: 59 },
    });
    await expect(admitGuestUpload(prisma, first)).resolves.toBeUndefined();
    await expect(admitGuestUpload(prisma, first)).rejects.toMatchObject({
      status: 429,
      code: "GUEST_UPLOAD_RATE_LIMIT",
    });
    await expect(admitGuestUpload(prisma, second)).resolves.toBeUndefined();
    await prisma.drawingLinkShare.update({
      where: { id: first.shareId },
      data: { uploadWindowAt: new Date(Date.now() - 61_000) },
    });
    await expect(admitGuestUpload(prisma, first)).resolves.toBeUndefined();
    expect(
      await prisma.drawingLinkShare.findUnique({
        where: { id: first.shareId },
        select: { uploadCount: true },
      }),
    ).toEqual({ uploadCount: 1 });
  });

  it("reclaims stale unreferenced uploads while retaining current and historical images", async () => {
    const drawing = await makeDrawing();
    const guest = await makeGuest(drawing.id);
    await storeGuestFile(guest, "current", 10);
    await storeGuestFile(guest, "history", 10);
    await storeGuestFile(guest, "unused", 10);
    await prisma.drawing.update({
      where: { id: drawing.id },
      data: { elements: JSON.stringify([{ fileId: "current" }]) },
    });
    await prisma.drawingSnapshot.create({
      data: {
        drawingId: drawing.id,
        version: 1,
        elements: "[]",
        appState: "{}",
        files: JSON.stringify({ history: {} }),
      },
    });

    expect(await sweepStaleGuestUploads(prisma, new Date())).toBe(0);
    const future = new Date(Date.now() + guestUploadProvisionalMs + 1_000);
    await sweepStaleGuestUploads(prisma, future);
    expect(
      await prisma.drawingFile.findMany({
        where: { drawingId: drawing.id },
        select: { fileId: true },
        orderBy: { fileId: "asc" },
      }),
    ).toEqual([{ fileId: "current" }, { fileId: "history" }]);
  });
});
