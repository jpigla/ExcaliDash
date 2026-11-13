import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import express from "express";
import { Server } from "socket.io";
import request from "supertest";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { AuthModeService } from "../auth/authMode";
import { issueGuestSession } from "../authz/guestLinkSecurity";
import { config } from "../config";
import { registerFileRoutes } from "../routes/files";
import { registerSocketHandlers } from "../server/socket";
import { createTestUser, getTestPrisma, setupTestDb } from "./testUtils";

const sockets = new Set<WebSocket>();
let prisma: ReturnType<typeof getTestPrisma>;
let ownerId: string;

beforeAll(async () => {
  setupTestDb();
  prisma = getTestPrisma();
  ownerId = (await createTestUser(prisma)).id;
});
afterAll(async () => {
  for (const socket of sockets) socket.close();
  await prisma?.$disconnect();
});

const createDrawing = () =>
  prisma.drawing.create({
    data: {
      userId: ownerId,
      name: "Guest board",
      elements: "[]",
      files: "{}",
      appState: "{}",
    },
  });

const createGuest = async (
  drawingId: string,
  permission: "view" | "edit",
  expiresAt: Date | null = null,
) => {
  const share = await prisma.drawingLinkShare.create({
    data: {
      drawingId,
      permission,
      tokenHash: crypto.randomUUID(),
      encryptedToken: "created-by-test",
      createdByUserId: ownerId,
      expiresAt,
    },
  });
  return { share, ...issueGuestSession(share, config.jwtSecret) };
};

it("authorizes raw image transfers through the particular guest grant", async () => {
  const drawing = await createDrawing();
  const other = await createDrawing();
  const reader = await createGuest(drawing.id, "view");
  const editor = await createGuest(drawing.id, "edit");
  const app = express();
  const auth: express.RequestHandler = (_req, res) => {
    res.sendStatus(401);
  };
  registerFileRoutes(app, {
    prisma,
    requireAuth: auth,
    optionalAuth: (_req, _res, next) => next(),
    asyncHandler: (fn) => (req, res, next) =>
      void fn(req, res, next).catch(next),
  });
  const upload = (drawingId: string, session: string) =>
    request(app)
      .put(`/drawings/${drawingId}/files/image`)
      .set("Authorization", `Guest ${session}`)
      .type("png")
      .send(Buffer.from([137, 80, 78, 71]));
  await upload(drawing.id, reader.session).expect(404);
  await upload(other.id, editor.session).expect(404);
  await upload(drawing.id, editor.session).expect(200);
  await request(app)
    .put(`/drawings/${drawing.id}/files/scriptable`)
    .set("Authorization", `Guest ${editor.session}`)
    .type("image/svg+xml")
    .send(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>void 0</script></svg>',
    )
    .expect(415);
  expect(
    await prisma.drawingFile.count({
      where: { drawingId: drawing.id, fileId: "scriptable" },
    }),
  ).toBe(0);
  const url = `/files/${drawing.id}/image`;
  await request(app).get(url).expect(404);
  await request(app)
    .get(url)
    .set("Authorization", `Guest ${reader.session}`)
    .expect("Cache-Control", "no-store")
    .expect(200);
  await prisma.drawingLinkShare.update({
    where: { id: editor.share.id },
    data: { revision: { increment: 1 } },
  });
  await upload(drawing.id, editor.session).expect(404);
  await request(app)
    .get(url)
    .set("Authorization", `Guest ${reader.session}`)
    .expect(200);
});

const guestSocket = async (url: string, guestSession: string) => {
  const ws = new WebSocket(url);
  sockets.add(ws);
  const messages: string[] = [];
  ws.addEventListener("message", ({ data }) => {
    if (typeof data !== "string") return;
    if (data.startsWith("0")) ws.send(`40${JSON.stringify({ guestSession })}`);
    else if (data === "2") ws.send("3");
    else messages.push(data);
  });
  await expect
    .poll(() => messages.some((msg) => msg.startsWith("40")))
    .toBe(true);
  return { ws, messages };
};

it("checks guest roles on live edits and stops passive scene delivery after revocation or expiry", async () => {
  const drawing = await createDrawing();
  const reader = await createGuest(drawing.id, "view");
  const editor = await createGuest(drawing.id, "edit");
  const expiring = await createGuest(
    drawing.id,
    "view",
    new Date(Date.now() + 3_000),
  );
  const http = createServer();
  const io = new Server(http);
  const handlers = registerSocketHandlers({
    io,
    prisma,
    authModeService: { getAuthEnabled: async () => true } as AuthModeService,
    jwtSecret: config.jwtSecret,
  });
  http.listen(0, "127.0.0.1");
  try {
    await once(http, "listening");
    const { port } = http.address() as AddressInfo;
    const url = `ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`;
    const [view, edit, passive] = await Promise.all(
      [reader, editor, expiring].map((guest) =>
        guestSocket(url, guest.session),
      ),
    );
    for (const guest of [view, edit, passive]) {
      guest.ws.send(
        `421${JSON.stringify(["join-room", { drawingId: drawing.id, user: { name: "Guest" } }])}`,
      );
    }
    await expect
      .poll(() =>
        [view, edit, passive].every(({ messages }) =>
          messages.some((msg) => msg.startsWith("431")),
        ),
      )
      .toBe(true);

    view.ws.send(
      `42${JSON.stringify(["element-update", { drawingId: drawing.id, elements: [] }])}`,
    );
    await expect
      .poll(() => view.messages.some((msg) => msg.includes("Read-only access")))
      .toBe(true);
    edit.ws.send(
      `42${JSON.stringify(["element-update", { drawingId: drawing.id, elements: [{ id: "guest-edit" }] }])}`,
    );
    await expect
      .poll(() => view.messages.some((msg) => msg.includes("guest-edit")))
      .toBe(true);

    await prisma.drawingLinkShare.update({
      where: { id: reader.share.id },
      data: { revokedAt: new Date() },
    });
    await handlers.emitDrawingScene(drawing.id, {
      drawingId: drawing.id,
      elements: [{ id: "after-revoke" }],
    });
    await expect
      .poll(() =>
        view.messages.some((msg) => msg.includes("GUEST_ACCESS_ENDED")),
      )
      .toBe(true);
    await expect
      .poll(() => edit.messages.some((msg) => msg.includes("after-revoke")))
      .toBe(true);
    expect(view.messages.some((msg) => msg.includes("after-revoke"))).toBe(
      false,
    );

    await expect
      .poll(
        () =>
          passive.messages.some((msg) => msg.includes("GUEST_ACCESS_ENDED")),
        { timeout: 5_000 },
      )
      .toBe(true);
    await handlers.emitDrawingScene(drawing.id, {
      drawingId: drawing.id,
      elements: [{ id: "after-expiry" }],
    });
    await expect
      .poll(() => edit.messages.some((msg) => msg.includes("after-expiry")))
      .toBe(true);
    expect(passive.messages.some((msg) => msg.includes("after-expiry"))).toBe(
      false,
    );
  } finally {
    await io.close();
  }
});
