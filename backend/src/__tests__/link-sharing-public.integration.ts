import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import bcrypt from "bcrypt";
import jwt, { SignOptions } from "jsonwebtoken";
import { StringValue } from "ms";
import { PrismaClient } from "../generated/client";
import { config } from "../config";
import { getTestPrisma, setupTestDb } from "./testUtils";
import { ACCESS_TOKEN_COOKIE_NAME } from "../auth/cookies";

describe("Link Sharing - Scoped Guest Access", () => {
  const userAgent = "vitest-link-sharing-public";
  const createRefreshToken = (user: { id: string; email: string }) =>
    jwt.sign(
      { userId: user.id, email: user.email, type: "refresh" },
      config.jwtSecret,
      { expiresIn: config.jwtRefreshExpiresIn as StringValue },
    );

  let prisma: PrismaClient;
  let app: any;

  let ownerUser: { id: string; email: string };
  let ownerToken: string;

  let ownerAgent: any;
  let ownerCsrfHeaderName: string;
  let ownerCsrfToken: string;

  const createDrawing = async () => {
    return prisma.drawing.create({
      data: {
        name: "Shared Drawing",
        elements: "[]",
        appState: "{}",
        files: "{}",
        userId: ownerUser.id,
        collectionId: null,
        preview: null,
      },
      select: { id: true, userId: true, name: true },
    });
  };

  const createLinkShare = async (
    drawingId: string,
    permission: "view" | "edit",
    body?: { expiresAt?: string | null; passphrase?: string },
  ) => {
    const payload: Record<string, unknown> = { permission, ...body };
    const response = await ownerAgent
      .post(`/drawings/${drawingId}/link-shares`)
      .set("User-Agent", userAgent)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set(ownerCsrfHeaderName, ownerCsrfToken)
      .send(payload);

    expect(response.status).toBe(200);
    return response;
  };

  const createAnonymousAgentWithCsrf = async () => {
    const anonAgent = request.agent(app);
    const anonCsrfRes = await anonAgent
      .get("/csrf-token")
      .set("User-Agent", userAgent);

    return {
      anonAgent,
      anonCsrfHeaderName: anonCsrfRes.body.header as string,
      anonCsrfToken: anonCsrfRes.body.token as string,
    };
  };

  beforeAll(async () => {
    setupTestDb();
    prisma = getTestPrisma();

    ({ app } = await import("../index"));

    await prisma.systemConfig.upsert({
      where: { id: "default" },
      update: {
        authEnabled: true,
        registrationEnabled: false,
      },
      create: {
        id: "default",
        authEnabled: true,
        registrationEnabled: false,
      },
    });

    const passwordHash = await bcrypt.hash("password123", 10);
    ownerUser = await prisma.user.create({
      data: {
        email: "owner-user@test.local",
        passwordHash,
        name: "Owner User",
        role: "USER",
        isActive: true,
      },
      select: { id: true, email: true },
    });

    const signOptions: SignOptions = {
      expiresIn: config.jwtAccessExpiresIn as StringValue,
    };
    ownerToken = jwt.sign(
      { userId: ownerUser.id, email: ownerUser.email, type: "access" },
      config.jwtSecret,
      signOptions,
    );

    ownerAgent = request.agent(app);
    const csrfRes = await ownerAgent
      .get("/csrf-token")
      .set("User-Agent", userAgent);
    ownerCsrfHeaderName = csrfRes.body.header;
    ownerCsrfToken = csrfRes.body.token;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  const unlock = async (
    share: { id: string; token: string },
    passphrase?: string,
  ) => {
    const { anonAgent, anonCsrfHeaderName, anonCsrfToken } =
      await createAnonymousAgentWithCsrf();
    return anonAgent
      .post(`/guest-links/${share.id}/unlock`)
      .set(anonCsrfHeaderName, anonCsrfToken)
      .send({ token: share.token, passphrase });
  };

  it("isolates concurrent view and edit links and rejects bare board IDs", async () => {
    const drawing = await createDrawing();
    const path = `/drawings/${drawing.id}`;
    const view = (await createLinkShare(drawing.id, "view")).body.share;
    const edit = (await createLinkShare(drawing.id, "edit")).body.share;
    expect(view.id).not.toBe(edit.id);
    expect(view.token).not.toBe(edit.token);
    expect((await request(app).get(path)).status).toBe(404);

    const viewSession = await unlock(view);
    const editSession = await unlock(edit);
    expect(viewSession.status).toBe(200);
    expect(editSession.status).toBe(200);

    const sessionCookie = (response: typeof viewSession) => {
      const cookie = response.headers["set-cookie"][0];
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Strict");
      expect(response.body.session).toBeUndefined();
      return cookie.split(";")[0];
    };
    const viewCookie = sessionCookie(viewSession);
    const editCookie = sessionCookie(editSession);
    await request(app).get(path).set("Cookie", viewCookie).expect(404);
    await request(app)
      .get(path)
      .set("X-Guest-Share", edit.id)
      .set("Cookie", viewCookie)
      .expect(404);
    await request(app)
      .get(`/guest-links/${view.id}/session`)
      .set("Cookie", viewCookie)
      .expect(200);

    const viewResponse = await request(app)
      .get(path)
      .set("X-Guest-Share", view.id)
      .set(
        "Cookie",
        `${viewCookie}; ${editCookie}; ${ACCESS_TOKEN_COOKIE_NAME}=${ownerToken}`,
      );
    expect(viewResponse.status).toBe(200);
    expect(viewResponse.headers["cache-control"]).toBe("no-store");
    expect(viewResponse.body.accessLevel).toBe("view");

    const other = await createDrawing();
    expect(
      (
        await request(app)
          .get(`/drawings/${other.id}`)
          .set("X-Guest-Share", edit.id)
          .set("Cookie", editCookie)
      ).status,
    ).toBe(404);

    const { anonAgent, anonCsrfHeaderName, anonCsrfToken } =
      await createAnonymousAgentWithCsrf();
    const write = (shareId: string, cookie: string) =>
      anonAgent
        .put(path)
        .set("X-Guest-Share", shareId)
        .set("Cookie", cookie)
        .set(anonCsrfHeaderName, anonCsrfToken)
        .send({ elements: [] });
    expect((await write(view.id, viewCookie)).status).toBe(404);
    expect((await write(edit.id, editCookie)).status).toBe(200);

    const revoke = await ownerAgent
      .delete(`${path}/link-shares/${edit.id}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set(ownerCsrfHeaderName, ownerCsrfToken);
    expect(revoke.status).toBe(200);
    expect((await write(edit.id, editCookie)).status).toBe(404);
    expect(
      (
        await request(app)
          .get(path)
          .set("X-Guest-Share", view.id)
          .set("Cookie", viewCookie)
      ).status,
    ).toBe(200);
  });

  it("omits historical image metadata and prevents a guest from reattaching its known file ID", async () => {
    const drawing = await createDrawing();
    const historical = {
      id: "old",
      type: "image",
      fileId: "historical",
      isDeleted: true,
      version: 2,
      text: "old content",
    };
    const files = {
      historical: {
        id: "historical",
        dataURL: "data:image/png;base64,AQIDBA==",
      },
    };
    await prisma.drawing.update({
      where: { id: drawing.id },
      data: {
        elements: JSON.stringify([historical]),
        files: JSON.stringify(files),
      },
    });
    await prisma.drawingFile.create({
      data: {
        drawingId: drawing.id,
        fileId: "historical",
        mimeType: "image/png",
        sizeBytes: 4,
        storage: "db",
        data: Buffer.from([1, 2, 3, 4]),
      },
    });
    const share = (await createLinkShare(drawing.id, "edit")).body.share;
    // Even the link that originally uploaded a recently published image
    // may not reattach it after the owner has removed it.
    await prisma.drawingFile.update({
      where: {
        drawingId_fileId: { drawingId: drawing.id, fileId: "historical" },
      },
      data: { guestShareId: share.id, guestPublishedAt: new Date() },
    });
    const unlocked = await unlock(share);
    expect(unlocked.status).toBe(200);
    const cookie = unlocked.headers["set-cookie"][0].split(";")[0];
    const path = `/drawings/${drawing.id}`;
    const read = await request(app)
      .get(path)
      .set("X-Guest-Share", share.id)
      .set("Cookie", cookie);
    expect(read.status).toBe(200);
    expect(read.body.files).toEqual({});
    expect(read.body.elements).toEqual([
      { id: "old", isDeleted: true, version: 2 },
    ]);

    const { anonAgent, anonCsrfHeaderName, anonCsrfToken } =
      await createAnonymousAgentWithCsrf();
    const write = await anonAgent
      .put(path)
      .set("X-Guest-Share", share.id)
      .set("Cookie", cookie)
      .set(anonCsrfHeaderName, anonCsrfToken)
      .send({ elements: [{ ...historical, isDeleted: false, version: 3 }] });
    expect(write.status).toBe(409);
    expect(write.body.code).toBe("GUEST_IMAGE_UNAVAILABLE");
    const download = await request(app)
      .get(`/files/${drawing.id}/historical`)
      .set("X-Guest-Share", share.id)
      .set("Cookie", cookie);
    expect(download.status).toBe(404);
  });

  it("checks the exact password and invalidates issued sessions after a change", async () => {
    const drawing = await createDrawing();
    const path = `/drawings/${drawing.id}`;
    const share = (
      await createLinkShare(drawing.id, "view", { passphrase: "Old-Password!" })
    ).body.share;
    expect(share.passwordProtected).toBe(true);
    expect((await unlock(share)).body.code).toBe("GUEST_PASSWORD_REQUIRED");
    expect((await unlock(share, "old-password!")).body.code).toBe(
      "GUEST_PASSWORD_INVALID",
    );
    expect(
      (await unlock({ ...share, token: "A".repeat(32) }, "Old-Password!"))
        .status,
    ).toBe(404);
    const previous = await unlock(share, "Old-Password!");
    expect(previous.status).toBe(200);

    const updated = await ownerAgent
      .patch(`${path}/link-shares/${share.id}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set(ownerCsrfHeaderName, ownerCsrfToken)
      .send({ passphrase: "New-Password!" });
    expect(updated.status).toBe(200);
    expect(
      (
        await request(app)
          .get(path)
          .set("X-Guest-Share", share.id)
          .set("Cookie", previous.headers["set-cookie"][0].split(";")[0])
      ).status,
    ).toBe(404);
    expect((await unlock(share, "New-Password!")).status).toBe(200);
  });

  it("only reveals an encrypted saved password to the owner on demand", async () => {
    const drawing = await createDrawing();
    const password = " Workshop-password! ";
    const { body } = await createLinkShare(drawing.id, "view", {
      passphrase: password,
    });
    const share = body.share;
    const path = `/drawings/${drawing.id}/link-shares/${share.id}`;
    const reveal = () =>
      ownerAgent
        .get(`${path}/passphrase`)
        .set("Authorization", `Bearer ${ownerToken}`);
    const update = (passphrase: string | null) =>
      ownerAgent
        .patch(path)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set(ownerCsrfHeaderName, ownerCsrfToken)
        .send({ passphrase });

    expect(JSON.stringify(body)).not.toContain(password);
    const row = await prisma.drawingLinkShare.findUniqueOrThrow({
      where: { id: share.id },
    });
    expect(row.encryptedPassphrase).toBeTruthy();
    expect(row.encryptedPassphrase).not.toContain(password);
    const revealed = await reveal().expect(200, { passphrase: password });
    expect(revealed.headers["cache-control"]).toBe("no-store");

    const other = await prisma.user.create({
      data: {
        email: "non-owner-password-reveal@test.local",
        name: "Collaborator",
        passwordHash: "",
        isActive: true,
      },
    });
    await prisma.drawingPermission.create({
      data: {
        drawingId: drawing.id,
        granteeUserId: other.id,
        permission: "edit",
        createdByUserId: ownerUser.id,
      },
    });
    const otherToken = jwt.sign(
      { userId: other.id, email: other.email, type: "access" },
      config.jwtSecret,
    );
    await request(app).get(`${path}/passphrase`).expect(401);
    await request(app)
      .get(`${path}/passphrase`)
      .set("Authorization", `Bearer ${otherToken}`)
      .expect(404);

    await prisma.drawingLinkShare.update({
      where: { id: share.id },
      data: { encryptedPassphrase: null },
    });
    await reveal().expect(200, { passphrase: null });
    expect((await unlock(share, password)).status).toBe(200);
    const updated = await update(password).expect(200);
    expect(updated.body.share.token).toBe(share.token);
    await reveal().expect(200, { passphrase: password });
    await update(null).expect(200);
    await reveal().expect(404);
    expect((await unlock(share)).status).toBe(200);
  });

  it("limits password attempts for the same link without blocking another link", async () => {
    const drawing = await createDrawing();
    const protectedLink = (
      await createLinkShare(drawing.id, "view", {
        passphrase: "Workshop-password",
      })
    ).body.share;
    const other = (await createLinkShare(drawing.id, "view")).body.share;
    await prisma.drawingLinkShare.update({
      where: { id: protectedLink.id },
      data: { failedAttempts: 12, lockedUntil: new Date(Date.now() + 60_000) },
    });

    expect((await unlock(protectedLink, "Workshop-password")).status).toBe(429);
    expect((await unlock(other)).status).toBe(200);
    await prisma.drawingLinkShare.update({
      where: { id: protectedLink.id },
      data: { lockedUntil: new Date(Date.now() - 1_000) },
    });
    expect((await unlock(protectedLink, "Workshop-password")).status).toBe(200);
  });

  it("permanently revokes all links when moving the drawing to trash", async () => {
    const drawing = await createDrawing();
    const path = `/drawings/${drawing.id}`;
    const first = (await createLinkShare(drawing.id, "view")).body.share;
    const second = (await createLinkShare(drawing.id, "edit")).body.share;
    const move = (collectionId: string | null) =>
      ownerAgent
        .put(path)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set(ownerCsrfHeaderName, ownerCsrfToken)
        .send({ collectionId });

    expect((await move("trash")).status).toBe(200);
    expect((await unlock(first)).status).toBe(404);
    expect((await move(null)).status).toBe(200);
    expect((await unlock(second)).status).toBe(404);
  });

  it("returns 401 for a private drawing when a stale access-token cookie is present", async () => {
    const drawing = await createDrawing();

    const response = await request(app)
      .get(`/drawings/${drawing.id}`)
      .set("User-Agent", userAgent)
      .set(
        "Cookie",
        `${ACCESS_TOKEN_COOKIE_NAME}=${createRefreshToken(ownerUser)}`,
      );

    expect(response.status).toBe(401);
    expect(response.body?.message).toBe("Invalid or expired token");
  });

  it("returns 401 for a private drawing PUT when a stale access-token cookie is present", async () => {
    const drawing = await createDrawing();
    const { anonAgent, anonCsrfHeaderName, anonCsrfToken } =
      await createAnonymousAgentWithCsrf();

    const response = await anonAgent
      .put(`/drawings/${drawing.id}`)
      .set("User-Agent", userAgent)
      .set(
        "Cookie",
        `${ACCESS_TOKEN_COOKIE_NAME}=${createRefreshToken(ownerUser)}`,
      )
      .set(anonCsrfHeaderName, anonCsrfToken)
      .send({ name: "Should Fail" });

    expect(response.status).toBe(401);
    expect(response.body?.message).toBe("Invalid or expired token");
  });
});
