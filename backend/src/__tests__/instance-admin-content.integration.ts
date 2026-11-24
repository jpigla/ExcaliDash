import jwt from "jsonwebtoken";
import request from "supertest";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Express } from "express";
import type { PrismaClient } from "../generated/client";
import { getTestPrisma, setupTestDb } from "./testUtils";

let prisma: PrismaClient;
let app: Express;
let secret: string;

beforeAll(async () => {
  setupTestDb();
  prisma = getTestPrisma();
  await prisma.systemConfig.create({
    data: { id: "default", authEnabled: true, authOnboardingCompleted: true },
  });
  ({ app } = await import("../index"));
  secret = (await import("../config")).config.jwtSecret;
});

afterAll(async () => prisma?.$disconnect());

it("lets the signed-in admin manage another user's boards, collections and shares", async () => {
  const user = (name: string, role = "USER") =>
    prisma.user.create({
      data: {
        name,
        email: `${name}@example.test`,
        role,
        passwordHash: "fixture",
      },
    });
  const [admin, codex, editor] = await Promise.all([
    user("admin", "ADMIN"),
    user("codex"),
    user("editor"),
  ]);
  const collection = await prisma.collection.create({
    data: { name: "Codex drafts", userId: codex.id },
  });
  const board = await prisma.drawing.create({
    data: {
      name: "Codex draft",
      userId: codex.id,
      collectionId: collection.id,
      elements: "[]",
      appState: "{}",
    },
  });
  await prisma.collectionShare.create({
    data: {
      collectionId: collection.id,
      granteeUserId: editor.id,
      role: "edit",
      createdByUserId: codex.id,
    },
  });
  const browser = async (account: typeof admin, impersonatorId?: string) => {
    const client = request.agent(app);
    const csrf = await client.get("/csrf-token").expect(200);
    const token = jwt.sign(
      {
        userId: account.id,
        email: account.email,
        type: "access",
        impersonatorId,
      },
      secret,
      { expiresIn: 120 },
    );
    return (method: "get" | "put" | "post" | "patch" | "delete", url: string) =>
      client[method](url)
        .set("Authorization", `Bearer ${token}`)
        .set(csrf.body.header, csrf.body.token);
  };
  const [manage, edit, delegated] = await Promise.all([
    browser(admin),
    browser(editor),
    browser(admin, editor.id),
  ]);
  const drawingPath = `/drawings/${board.id}`;
  const collectionPath = `/collections/${collection.id}`;
  await edit("put", drawingPath).send({ collectionId: "trash" }).expect(403);
  await edit("get", drawingPath + "/sharing").expect(404);
  await delegated("get", drawingPath + "/sharing").expect(404);
  expect((await manage("get", "/collections").expect(200)).body).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: collection.id,
        isOwner: true,
        userId: codex.id,
      }),
    ]),
  );
  expect((await manage("get", "/drawings").expect(200)).body.drawings).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: board.id })]),
  );
  const opened = await manage("get", drawingPath).expect(200);
  expect(opened.body).toMatchObject({ accessLevel: "owner", userId: codex.id });
  await manage("put", collectionPath)
    .send({ name: "Renamed drafts" })
    .expect(200);
  await manage("get", collectionPath + "/shares").expect(200);
  await manage("patch", collectionPath + "/shares/" + editor.id)
    .send({ role: "view" })
    .expect(200);
  await manage("post", drawingPath + "/permissions")
    .send({ granteeUserId: editor.id, permission: "edit" })
    .expect(200);
  const link = await manage("post", drawingPath + "/link-shares")
    .send({ permission: "view" })
    .expect(200);
  await manage(
    "delete",
    drawingPath + "/link-shares/" + link.body.share.id,
  ).expect(200);
  await manage("put", drawingPath).send({ collectionId: "trash" }).expect(200);
  const trash = await manage("get", "/drawings?collectionId=trash").expect(200);
  expect(trash.body.drawings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: board.id, collectionId: "trash" }),
    ]),
  );
  expect((await manage("get", "/drawings").expect(200)).body.drawings).toEqual(
    [],
  );
  await manage("put", drawingPath)
    .send({ collectionId: collection.id })
    .expect(200);
  await manage("delete", collectionPath).expect(200);
  const restored = await prisma.drawing.findUniqueOrThrow({
    where: { id: board.id },
  });
  expect(restored).toMatchObject({ collectionId: null, userId: codex.id });
  await manage("delete", drawingPath).expect(200);
  expect(await prisma.drawing.count({ where: { id: board.id } })).toBe(0);
});
