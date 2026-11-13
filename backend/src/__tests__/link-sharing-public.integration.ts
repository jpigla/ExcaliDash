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

    const viewResponse = await request(app)
      .get(path)
      .set("Authorization", `Guest ${viewSession.body.session}`)
      .set("Cookie", `${ACCESS_TOKEN_COOKIE_NAME}=${ownerToken}`);
    expect(viewResponse.status).toBe(200);
    expect(viewResponse.headers["cache-control"]).toBe("no-store");
    expect(viewResponse.body.accessLevel).toBe("view");

    const other = await createDrawing();
    expect(
      (
        await request(app)
          .get(`/drawings/${other.id}`)
          .set("Authorization", `Guest ${editSession.body.session}`)
      ).status,
    ).toBe(404);

    const { anonAgent, anonCsrfHeaderName, anonCsrfToken } =
      await createAnonymousAgentWithCsrf();
    const write = (session: string) =>
      anonAgent
        .put(path)
        .set("Authorization", `Guest ${session}`)
        .set(anonCsrfHeaderName, anonCsrfToken)
        .send({ elements: [] });
    expect((await write(viewSession.body.session)).status).toBe(404);
    expect((await write(editSession.body.session)).status).toBe(200);

    const revoke = await ownerAgent
      .delete(`${path}/link-shares/${edit.id}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set(ownerCsrfHeaderName, ownerCsrfToken);
    expect(revoke.status).toBe(200);
    expect((await write(editSession.body.session)).status).toBe(404);
    expect(
      (
        await request(app)
          .get(path)
          .set("Authorization", `Guest ${viewSession.body.session}`)
      ).status,
    ).toBe(200);
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
          .set("Authorization", `Guest ${previous.body.session}`)
      ).status,
    ).toBe(404);
    expect((await unlock(share, "New-Password!")).status).toBe(200);
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
