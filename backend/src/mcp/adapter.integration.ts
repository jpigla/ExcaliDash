import type { Server } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import jwt from "jsonwebtoken";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createTestUser,
  getTestPrisma,
  setupTestDb,
} from "../__tests__/testUtils";
import type { PrismaClient } from "../generated/client";
import { sha256 } from "./policy";

describe("ExcaliDash MCP adapter", () => {
  let prisma: PrismaClient;
  let server: Server;
  let resource: string;
  let directory: string;
  let file: string;
  let ownerId: string;
  let draftId: string;
  let outsidersId: string;
  const token = `exdm_${randomBytes(32).toString("base64url")}`;
  const expiry = () => new Date(Date.now() + 3_600_000).toISOString();
  const grant = () => ({
    id: "local-agent",
    userId: ownerId,
    expiresAt: expiry(),
    draftCollectionId: draftId,
    credential: { type: "token", sha256: sha256(token) },
  });
  const policy = async (agents: unknown[], oauth?: unknown) => {
    await writeFile(
      `${file}.next`,
      JSON.stringify({ resource, agents, oauth }),
    );
    await rename(`${file}.next`, file);
  };
  const rpc = (method: string, params: unknown = {}, authorization = token) =>
    request(server)
      .post("/api/mcp")
      .set("Authorization", `Bearer ${authorization}`)
      .set("Accept", "application/json, text/event-stream")
      .send({ jsonrpc: "2.0", id: 1, method, params });
  const call = async (name: string, args: object, authorization = token) => {
    const response = await rpc(
      "tools/call",
      { name, arguments: args },
      authorization,
    ).expect(200);
    expect(response.body.error).toBeUndefined();
    return response.body.result;
  };
  const value = (result: { content: { text: string }[] }) =>
    JSON.parse(result.content[0].text);
  const fixtureBoard = (userId = ownerId, elements: object[] = []) =>
    prisma.drawing.create({
      data: {
        name: "Existing sketch",
        userId,
        elements: JSON.stringify(elements),
        appState: "{}",
        files: "{}",
      },
    });
  const shape = (id: string, frameId?: string) => ({
    id,
    type: "rectangle",
    x: 0,
    y: 0,
    width: 100,
    height: 50,
    frameId,
  });
  const addBox = (x = 10) => ({
    op: "add",
    element: { type: "rectangle", x, y: 20 },
  });

  it("lets only the owner grant and revoke live access for the desktop identity", async () => {
    const { config } = await import("../config");
    const agent = await createTestUser(prisma, "codex-desktop@example.test");
    const draft = await prisma.collection.create({
      data: {
        name: "Codex drafts",
        userId: agent.id,
        shares: {
          create: {
            granteeUserId: ownerId,
            createdByUserId: agent.id,
            role: "edit",
          },
        },
      },
    });
    const managed = {
      ...grant(),
      id: "desktop-agent",
      userId: agent.id,
      draftCollectionId: draft.id,
      managedByUserId: ownerId,
    };
    await policy([managed]);

    const drawing = await fixtureBoard();
    const hidden = await fixtureBoard(outsidersId);
    const accessPath = `/drawings/${drawing.id}/codex-access`;
    const auth = (userId: string, impersonatorId?: string) =>
      `Bearer ${jwt.sign({ userId, email: "fixture@example.test", type: "access", impersonatorId }, config.jwtSecret, { expiresIn: 120 })}`;
    const browser = request.agent(server);
    const csrf = await browser.get("/csrf-token").expect(200);
    const set = (mode: "read" | "edit") =>
      browser
        .put(accessPath)
        .set("Authorization", auth(ownerId))
        .set(csrf.body.header, csrf.body.token)
        .send({ mode, minutes: 60 });
    const write = () =>
      call("apply_changes", {
        boardId: drawing.id,
        revision: 1,
        operationId: "desktop-edit",
        operations: [addBox()],
      });

    await browser
      .get(accessPath)
      .set("Authorization", auth(outsidersId))
      .expect(404);
    await browser
      .get(accessPath)
      .set("Authorization", auth(ownerId, outsidersId))
      .expect(403);
    await browser
      .put(accessPath)
      .set("Authorization", auth(ownerId))
      .send({ mode: "edit", minutes: 60 })
      .expect(403);
    expect(value(await call("list_boards", {})).boards).toEqual([]);
    expect((await call("read_board", { boardId: drawing.id })).isError).toBe(
      true,
    );
    await set("read").expect(200);
    expect(
      value(await call("list_boards", {})).boards.map(
        (b: { boardId: string }) => b.boardId,
      ),
    ).toEqual([drawing.id]);
    expect((await call("read_board", { boardId: hidden.id })).isError).toBe(
      true,
    );
    expect((await write()).isError).toBe(true);

    await set("edit").expect(200);
    expect(value(await write()).revision).toBe(2);
    const state = await browser
      .get(accessPath)
      .set("Authorization", auth(ownerId))
      .expect(200);
    expect(state.body.lastEditAt).toBeTruthy();
    expect(
      await prisma.auditLog.count({
        where: {
          userId: agent.id,
          resource: drawing.id,
          action: "mcp_board_apply",
        },
      }),
    ).toBe(1);
    await prisma.mcpBoardGrant.updateMany({
      where: { drawingId: drawing.id },
      data: { expiresAt: new Date(0) },
    });
    expect((await call("read_board", { boardId: drawing.id })).isError).toBe(
      true,
    );
    await set("edit").expect(200);
    await browser
      .delete(accessPath)
      .set("Authorization", auth(ownerId))
      .set(csrf.body.header, csrf.body.token)
      .expect(200)
      .expect(({ body }) => expect(body.grant).toBeNull());
    expect((await call("read_board", { boardId: drawing.id })).isError).toBe(
      true,
    );
    expect((await write()).isError).toBe(true);

    const created = value(
      await call("create_board", {
        title: "Desktop draft",
        operationId: "desktop-create",
      }),
    );
    expect(
      await prisma.drawing.findUnique({
        where: { id: created.boardId },
        select: { userId: true, collectionId: true },
      }),
    ).toEqual({ userId: agent.id, collectionId: draft.id });
    await browser
      .get(`/drawings/${created.boardId}`)
      .set("Authorization", auth(ownerId))
      .expect(200);

    const foreignAccess = `/drawings/${hidden.id}/codex-access`;
    await prisma.user.update({
      where: { id: ownerId },
      data: { role: "ADMIN" },
    });
    try {
      expect((await call("read_board", { boardId: hidden.id })).isError).toBe(
        true,
      );
      await browser
        .put(foreignAccess)
        .set("Authorization", auth(ownerId))
        .set(csrf.body.header, csrf.body.token)
        .send({ mode: "read", minutes: 60 })
        .expect(200);
      expect(
        value(await call("read_board", { boardId: hidden.id })).boardId,
      ).toBe(hidden.id);
      expect(value(await call("list_boards", {})).boards).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ boardId: hidden.id }),
        ]),
      );
    } finally {
      await prisma.user.update({
        where: { id: ownerId },
        data: { role: "USER" },
      });
    }
    expect((await call("read_board", { boardId: hidden.id })).isError).toBe(
      true,
    );
  });

  beforeAll(async () => {
    setupTestDb();
    prisma = getTestPrisma();
    await prisma.systemConfig.create({
      data: { id: "default", authEnabled: true, authOnboardingCompleted: true },
    });
    directory = await mkdtemp(join(tmpdir(), "excalidash-mcp-policy-"));
    file = join(directory, "policy.json");
    vi.stubEnv("MCP_POLICY_FILE", file);
    const owner = await createTestUser(prisma, "board-owner@example.test");
    const outsider = await createTestUser(prisma, "outsider@example.test");
    ownerId = owner.id;
    outsidersId = outsider.id;
    draftId = (
      await prisma.collection.create({
        data: { name: "Agent drafts", userId: ownerId },
      })
    ).id;
    const { httpServer } = await import("../index");
    server = httpServer;
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing server address");
    resource = `http://127.0.0.1:${address.port}/api/mcp`;
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    if (server)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    await prisma?.$disconnect();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("connects via the SDK and creates, draws, reads, renders and persists a native board", async () => {
    await policy([grant()]);
    const client = new Client({ name: "integration-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(resource), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    await client.connect(transport);
    try {
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(
        [
          "list_boards",
          "create_board",
          "read_board",
          "apply_changes",
          "render_board",
        ],
      );
      const creation = { title: "Service map", operationId: "create-map" };
      const [board, replay] = (
        await Promise.all([
          call("create_board", creation),
          call("create_board", creation),
        ])
      ).map(value);
      expect(board.url).toBe(
        new URL(`/editor/${board.boardId}`, resource).href,
      );
      expect(replay).toEqual(board);
      const args = {
        boardId: board.boardId,
        revision: 1,
        operationId: "draw-map",
        operations: [
          addBox(),
          {
            op: "add",
            element: { type: "text", x: 20, y: 30, text: "Übergabe" },
          },
          {
            op: "add",
            element: { type: "arrow", x: 180, y: 10, endX: 250, endY: 47 },
          },
        ],
      };
      const written = value(await call("apply_changes", args));
      expect(written).toMatchObject({ revision: 2 });
      expect(value(await call("apply_changes", args))).toMatchObject({
        ...written,
        replayed: true,
      });
      expect(
        (await call("apply_changes", { ...args, operations: [addBox(50)] }))
          .isError,
      ).toBe(true);
      const read = value(await call("read_board", { boardId: board.boardId }));
      expect(read.elements.map(({ type }: { type: string }) => type)).toEqual([
        "rectangle",
        "text",
        "arrow",
      ]);
      expect(read.elements[1].text).toBe("Übergabe");
      const image = await call("render_board", { boardId: board.boardId });
      expect(image.content[1]).toMatchObject({
        type: "image",
        mimeType: "image/png",
      });
      expect(
        Buffer.from(image.content[1].data, "base64")
          .subarray(0, 8)
          .toString("hex"),
      ).toBe("89504e470d0a1a0a");
      const cropped = value(
        await call("render_board", {
          boardId: board.boardId,
          bounds: [0, 0, 170, 150],
        }),
      );
      expect(cropped).toMatchObject({ shown: 2, elementCount: 3 });
      const drawing = await prisma.drawing.findUniqueOrThrow({
        where: { id: board.boardId },
      });
      expect(drawing.version).toBe(2);
      expect(JSON.parse(drawing.elements)[2]).toMatchObject({
        points: [
          [0, 0],
          [70, 37],
        ],
        endArrowhead: "arrow",
      });
      expect(
        await prisma.drawingSnapshot.count({
          where: { drawingId: board.boardId },
        }),
      ).toBe(1);
      expect(
        await prisma.auditLog.count({ where: { resource: board.boardId } }),
      ).toBe(2);
      expect(
        (
          await prisma.auditLog.findFirstOrThrow({
            where: { resource: board.boardId },
          })
        ).details,
      ).not.toContain("Übergabe");
    } finally {
      await client.close();
    }
  });

  it("enforces independent MCP scope, underlying ExcaliDash ACL, trash and revocation", async () => {
    const privateBoard = await fixtureBoard();
    const foreign = await fixtureBoard(outsidersId);
    await policy([
      { ...grant(), boards: [{ boardId: foreign.id, mode: "edit" }] },
    ]);
    for (const board of [privateBoard, foreign]) {
      expect((await call("read_board", { boardId: board.id })).isError).toBe(
        true,
      );
      expect((await call("render_board", { boardId: board.id })).isError).toBe(
        true,
      );
    }
    const listed = value(await call("list_boards", {}));
    expect(
      listed.boards.map(({ boardId }: { boardId: string }) => boardId),
    ).not.toContain(foreign.id);
    await prisma.drawingPermission.create({
      data: {
        drawingId: foreign.id,
        granteeUserId: ownerId,
        createdByUserId: outsidersId,
        permission: "view",
      },
    });
    expect(
      value(await call("read_board", { boardId: foreign.id })).boardId,
    ).toBe(foreign.id);
    expect(
      (
        await call("apply_changes", {
          boardId: foreign.id,
          revision: 1,
          operationId: "acl",
          operations: [addBox()],
        })
      ).isError,
    ).toBe(true);
    const trash = await prisma.collection.create({
      data: { id: `trash:${outsidersId}`, name: "Trash", userId: outsidersId },
    });
    await prisma.drawing.update({
      where: { id: foreign.id },
      data: { collectionId: trash.id },
    });
    expect((await call("read_board", { boardId: foreign.id })).isError).toBe(
      true,
    );
    await policy([]);
    await rpc("tools/list").expect(401);
    await policy([{ ...grant(), expiresAt: "2000-01-01T00:00:00Z" }]);
    await rpc("tools/list").expect(401);
  });

  it("limits edits to the granted frame, requires exact deletion approval and handles revisions", async () => {
    const frame = { ...shape("frame"), type: "frame" };
    const board = await fixtureBoard(ownerId, [
      frame,
      shape("inside", "frame"),
      shape("outside"),
    ]);
    const scopedAgent = {
      ...grant(),
      boards: [{ boardId: board.id, mode: "edit", frameId: "frame" }],
    };
    await policy([scopedAgent]);
    expect(
      value(await call("read_board", { boardId: board.id })).elements.map(
        ({ id }: { id: string }) => id,
      ),
    ).toEqual(["frame", "inside"]);
    const edit = {
      boardId: board.id,
      revision: 1,
      operationId: "scope-check",
      operations: [{ op: "update", id: "outside", changes: { x: 5 } }],
    };
    expect((await call("apply_changes", edit)).isError).toBe(true);
    const removal = {
      ...edit,
      frameId: "frame",
      operations: [{ op: "remove", id: "inside" }],
    };
    const unspecified = await call("apply_changes", {
      ...removal,
      frameId: undefined,
    });
    expect(unspecified.isError).toBe(true);
    expect(unspecified.content[0].text).toContain("Specify the frameId");
    const denied = await call("apply_changes", removal);
    expect(denied.isError).toBe(true);
    const { changeDigest, changeInput } = await import("./changeInput");
    const digest = changeDigest(scopedAgent, changeInput.parse(removal));
    expect(denied.content[0].text).toContain(digest);
    await policy([
      { ...scopedAgent, approvedChanges: [{ digest, expiresAt: expiry() }] },
    ]);
    expect(value(await call("apply_changes", removal)).revision).toBe(2);
    const stale = await call("apply_changes", {
      ...edit,
      operationId: "stale",
      operations: [addBox()],
    });
    expect(stale.content[0].text).toContain("revision changed");
    const current = await call("apply_changes", {
      ...edit,
      revision: 2,
      operationId: "current",
      operations: [addBox()],
    });
    const newId = value(current).changedIds[0];
    const edited = await call("apply_changes", {
      ...edit,
      revision: 3,
      operationId: "move-new-element",
      operations: [
        {
          op: "update",
          id: newId,
          changes: { x: 85, backgroundColor: "#bfdbfe" },
        },
      ],
    });
    expect(value(edited)).toMatchObject({ revision: 4, changedIds: [newId] });
    const persisted = await prisma.drawing.findUniqueOrThrow({
      where: { id: board.id },
    });
    expect(JSON.parse(persisted.elements)).toContainEqual(
      expect.objectContaining({
        id: newId,
        frameId: "frame",
        x: 85,
        backgroundColor: "#bfdbfe",
      }),
    );
    expect(JSON.parse(persisted.elements)).toContainEqual(shape("outside"));
  });

  it("rechecks the current frame before replaying a write receipt", async () => {
    const board = await fixtureBoard(ownerId, [
      { ...shape("frame"), type: "frame" },
    ]);
    const request = {
      boardId: board.id,
      revision: 1,
      operationId: "replay-after-scope-change",
      operations: [addBox()],
    };
    await policy([
      { ...grant(), boards: [{ boardId: board.id, mode: "edit" }] },
    ]);
    const original = value(await call("apply_changes", request));
    expect(original.changedIds).toHaveLength(1);
    await policy([
      {
        ...grant(),
        boards: [{ boardId: board.id, mode: "edit", frameId: "frame" }],
      },
    ]);
    const replay = await call("apply_changes", request);
    expect(replay.isError).toBe(true);
    expect(replay.content[0].text).not.toContain(original.changedIds[0]);
  });

  it("paginates only over boards with native access", async () => {
    const collection = await prisma.collection.create({
      data: { name: "Outside agent account", userId: outsidersId },
    });
    await prisma.drawing.createMany({
      data: Array.from({ length: 51 }, () => ({
        name: "Outside scope",
        userId: outsidersId,
        collectionId: collection.id,
        elements: "[]",
        appState: "{}",
      })),
    });
    await policy([
      {
        ...grant(),
        draftCollectionId: undefined,
        readCollections: [collection.id],
      },
    ]);
    expect(value(await call("list_boards", {}))).toEqual({ boards: [] });
    const visible = await prisma.drawing.findFirstOrThrow({
      where: { collectionId: collection.id },
    });
    await prisma.drawingPermission.create({
      data: {
        drawingId: visible.id,
        granteeUserId: ownerId,
        createdByUserId: outsidersId,
        permission: "view",
      },
    });
    const page = value(await call("list_boards", {}));
    expect(page).toEqual({
      boards: [expect.objectContaining({ boardId: visible.id })],
    });
  });

  it("protects the MCP HTTP entry point and verifies OAuth issuer, client, scope and resource", async () => {
    const issuer = "https://identity.example.test";
    const jwksUri = `${issuer}/jwks`;
    const oauth = { issuer, jwksUri };
    const identity = {
      ...grant(),
      credential: { type: "oauth", clientId: "chatgpt-test", subject: "owner" },
    };
    await policy([grant(), { ...identity, id: "cloud-agent" }], oauth);
    await request(server)
      .get("/api/mcp")
      .expect(401)
      .expect("Cache-Control", "no-store");
    await request(server)
      .post("/api/mcp")
      .set("Cookie", "access_token=browser-cookie")
      .expect(401);
    await request(server)
      .post("/api/mcp")
      .set("Authorization", `Bearer ${token}`)
      .type("json")
      .send({ payload: "x".repeat(129 * 1024) })
      .expect(413);
    await request(server)
      .post("/api/mcp")
      .set("Origin", "https://other.example.test")
      .expect(403);
    await request(server)
      .post("/api/mcp")
      .set("Host", "other.example.test")
      .expect(403);
    const challenge = await rpc("tools/list", {}, "invalid").expect(401);
    expect(challenge.headers["www-authenticate"]).toContain(
      'error="invalid_token"',
    );
    const metadataPath = new URL(
      challenge.headers["www-authenticate"].match(
        /resource_metadata="([^"]+)"/,
      )[1],
    ).pathname;
    const metadata = await request(server).get(metadataPath).expect(200);
    expect(metadata.body).toEqual({
      resource,
      authorization_servers: [issuer],
      scopes_supported: ["excalidash:mcp"],
    });

    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = {
      ...(await exportJWK(publicKey)),
      kid: "test-key",
      alg: "RS256",
    };
    const fetchJwks = vi.fn(async () => Response.json({ keys: [jwk] }));
    vi.stubGlobal("fetch", fetchJwks);
    try {
      const jwt = (
        overrides: {
          aud?: string;
          client_id?: string;
          scope?: string;
          iss?: string;
        } = {},
      ) =>
        new SignJWT({
          client_id: "chatgpt-test",
          scope: "excalidash:mcp",
          ...overrides,
        })
          .setProtectedHeader({ alg: "RS256", kid: "test-key" })
          .setSubject("owner")
          .setIssuer(overrides.iss ?? issuer)
          .setAudience(overrides.aud ?? resource)
          .setIssuedAt()
          .setExpirationTime("5m")
          .sign(privateKey);
      await rpc("tools/list", {}, await jwt()).expect(200);
      expect(fetchJwks).toHaveBeenCalledOnce();
      expect(String(fetchJwks.mock.calls[0][0])).toBe(jwksUri);
      await rpc(
        "tools/list",
        {},
        await jwt({ aud: "https://different.example.test/api/mcp" }),
      ).expect(401);
      await rpc(
        "tools/list",
        {},
        await jwt({ client_id: "other-client" }),
      ).expect(401);
      await rpc("tools/list", {}, await jwt({ scope: "openid" })).expect(401);
      await rpc(
        "tools/list",
        {},
        await jwt({ iss: "https://different.example.test" }),
      ).expect(401);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
