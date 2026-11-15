import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { sign } from "jsonwebtoken";
import { gzipSync, inflateSync } from "node:zlib";
import type { Express } from "express";
import { config } from "../config";
import { getTestPrisma, setupTestDb } from "./testUtils";

const upload = "/api/auth/profile/avatar";
const userAgent = "profile-avatar-integration";
const pixels = Buffer.alloc(128 * 128 * 4, 0xff);

describe("Authenticated profile pictures", () => {
  let app: Express;
  let prisma: ReturnType<typeof getTestPrisma>;
  let agent: ReturnType<typeof request.agent>;
  let csrf: Record<string, string>;
  const ownerId = "avatar-owner";
  const otherId = "avatar-other";

  const bearer = (userId: string, impersonatorId?: string) =>
    `Bearer ${sign(
      {
        userId,
        email: `${userId}@example.test`,
        type: "access",
        impersonatorId,
      },
      config.jwtSecret,
      { expiresIn: "5m" },
    )}`;
  const put = (body: Buffer, userId = ownerId) =>
    agent
      .put(upload)
      .set(csrf)
      .set("Authorization", bearer(userId))
      .type("application/octet-stream")
      .send(body);

  beforeAll(async () => {
    setupTestDb();
    prisma = getTestPrisma();
    ({ app } = await import("../index"));
    await prisma.systemConfig.upsert({
      where: { id: "default" },
      create: { id: "default", authEnabled: true },
      update: { authEnabled: true },
    });
    await prisma.user.createMany({
      data: [
        {
          id: ownerId,
          email: `${ownerId}@example.test`,
          name: "Owner",
          passwordHash: "unused",
        },
        {
          id: otherId,
          email: `${otherId}@example.test`,
          name: "Admin",
          passwordHash: "unused",
          role: "ADMIN",
        },
      ],
    });
    agent = request.agent(app);
    const response = await agent
      .get("/api/csrf-token")
      .set("User-Agent", userAgent)
      .expect(200);
    csrf = {
      [response.body.header]: response.body.token,
      "User-Agent": userAgent,
    };
  });

  afterAll(async () => prisma?.$disconnect());

  it("rejects missing authentication or CSRF and blocks impersonation and mandatory password resets", async () => {
    await request(app)
      .put(upload)
      .type("application/octet-stream")
      .send(pixels)
      .expect(401);
    await request(app)
      .put(upload)
      .set("Authorization", bearer(ownerId))
      .type("application/octet-stream")
      .send(pixels)
      .expect(403);
    await agent
      .put(upload)
      .set(csrf)
      .set("Authorization", bearer(ownerId, otherId))
      .type("application/octet-stream")
      .send(pixels)
      .expect(403);
    await prisma.user.update({
      where: { id: ownerId },
      data: { mustResetPassword: true },
    });
    try {
      await put(pixels).expect(403);
    } finally {
      await prisma.user.update({
        where: { id: ownerId },
        data: { mustResetPassword: false },
      });
    }
  });

  it("bounds the parser and rejects compressed or non-pixel requests", async () => {
    await agent
      .put(upload)
      .set(csrf)
      .set("Authorization", bearer(ownerId))
      .send({ avatarDataUrl: "data:image/svg+xml;base64,PHN2Zy8+" })
      .expect(415);
    await put(pixels.subarray(0, -1)).expect(400);
    await put(Buffer.alloc(pixels.length + 1)).expect(413);
    await agent
      .put(upload)
      .set(csrf)
      .set("Authorization", bearer(ownerId))
      .type("application/octet-stream")
      .set("Content-Encoding", "gzip")
      .send(gzipSync(pixels))
      .expect(415);
    expect(await prisma.userAvatar.count()).toBe(0);
  });

  it("isolates image reads, revalidates by version, and invalidates deleted images", async () => {
    const saved = await put(pixels).expect(200);
    const version = saved.body.user.avatarVersion;
    const url = `${upload}/${version}`;
    const profile = await agent
      .get("/api/auth/me")
      .set("Authorization", bearer(ownerId))
      .expect(200);
    expect(profile.body.user.avatarVersion).toBe(version);
    expect(JSON.stringify(profile.body)).not.toContain("image/png");

    const image = await agent
      .get(url)
      .set("Authorization", bearer(ownerId))
      .expect(200);
    expect(image.headers["content-type"]).toBe("image/png");
    expect(image.headers["x-content-type-options"]).toBe("nosniff");
    expect(image.headers["cache-control"]).toBe("private, no-cache");
    expect(image.headers.vary).toContain("Cookie");
    expect(image.body.readUInt32BE(16)).toBe(128);
    expect(image.body.readUInt32BE(20)).toBe(128);
    expect(image.body.toString("ascii", 37, 41)).toBe("IDAT");
    expect(
      inflateSync(image.body.subarray(41, 41 + image.body.readUInt32BE(33))),
    ).toHaveLength(128 * (1 + 128 * 4));
    const etag = image.headers.etag;
    await agent
      .get(url)
      .set("If-None-Match", etag)
      .set("Authorization", bearer(ownerId))
      .expect(304);
    await agent
      .get(url)
      .set("If-None-Match", etag)
      .set("Authorization", bearer(otherId))
      .expect(404);
    await agent
      .get(url)
      .set("If-None-Match", etag)
      .set("Authorization", bearer(ownerId, otherId))
      .expect(403);
    await request(app).get(url).set("If-None-Match", etag).expect(401);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await agent
        .delete(upload)
        .set(csrf)
        .set("Authorization", bearer(ownerId))
        .expect(200);
    }
    await agent
      .get(url)
      .set("If-None-Match", etag)
      .set("Authorization", bearer(ownerId))
      .expect(404);
  });

  it("scopes shared image reads to board members and owners of the sharing dialog", async () => {
    const { body } = await put(pixels).expect(200);
    const version = body.user.avatarVersion;
    const collection = await prisma.collection.create({
      data: { name: "Avatar collection", userId: otherId },
    });
    const drawing = await prisma.drawing.create({
      data: {
        name: "Avatar board",
        userId: otherId,
        collectionId: collection.id,
        elements: "[]",
        appState: "{}",
      },
    });
    const board = `/api/drawings/${drawing.id}`;
    const folder = `/api/collections/${collection.id}`;
    const boardAvatar = `${board}/avatars/${ownerId}/${version}`;
    const etag = `"${version}"`;

    await agent
      .get(boardAvatar)
      .set("Authorization", bearer(otherId))
      .expect(404);
    await agent
      .get(`${board}/share-resolve`)
      .query({ q: "avatar-owner" })
      .set("Authorization", bearer(otherId))
      .expect(200)
      .expect((response) =>
        expect(response.body.users[0]?.avatar?.version).toBe(version),
      );
    for (const scope of [board, folder]) {
      const sharingAvatar = `${scope}/share-avatars/${ownerId}/${version}`;
      await agent
        .get(sharingAvatar)
        .set("Authorization", bearer(otherId))
        .expect(200);
      await agent
        .get(sharingAvatar)
        .set("Authorization", bearer(ownerId))
        .expect(404);
      await agent
        .get(sharingAvatar)
        .set("Authorization", bearer(otherId, ownerId))
        .expect(404);
    }

    const grant = await prisma.collectionShare.create({
      data: {
        collectionId: collection.id,
        granteeUserId: ownerId,
        role: "view",
        createdByUserId: otherId,
      },
    });
    await agent
      .get(boardAvatar)
      .set("Authorization", bearer(otherId))
      .expect(200);
    await agent
      .get(boardAvatar)
      .set("Authorization", bearer(otherId))
      .set("If-None-Match", etag)
      .expect(304);
    await request(app).get(boardAvatar).expect(401);

    await prisma.collectionShare.delete({ where: { id: grant.id } });
    await agent
      .get(boardAvatar)
      .set("Authorization", bearer(otherId))
      .set("If-None-Match", etag)
      .expect(404);
  });

  it("limits repeated writes to one account without blocking a second account at the same IP", async () => {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await put(Buffer.alloc(1), otherId).expect(400);
    }
    await put(pixels, otherId).expect(429);
    await put(Buffer.alloc(1), ownerId).expect(400);
  });
});
