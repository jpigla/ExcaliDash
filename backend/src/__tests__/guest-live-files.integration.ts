import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import express from "express";
import { Server } from "socket.io";
import request from "supertest";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { AuthModeService } from "../auth/authMode";
import {
  guestSessionCookieName,
  issueGuestSession,
} from "../authz/guestLinkSecurity";
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
  const cookie = (guest: typeof reader) =>
    `excalidash-guest-${guest.share.id}=${guest.session}`;
  const upload = (drawingId: string, guest: typeof reader) =>
    request(app)
      .put(`/drawings/${drawingId}/files/image`)
      .set("X-Guest-Share", guest.share.id)
      .set("Cookie", cookie(guest))
      .type("png")
      .send(Buffer.from([137, 80, 78, 71]));
  await upload(drawing.id, reader).expect(404);
  await upload(other.id, editor).expect(404);
  await upload(drawing.id, editor).expect(200);
  await request(app)
    .put(`/drawings/${drawing.id}/files/scriptable`)
    .set("X-Guest-Share", editor.share.id)
    .set("Cookie", cookie(editor))
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
  const readAsGuest = () =>
    request(app)
      .get(url)
      .set("X-Guest-Share", reader.share.id)
      .set("Cookie", cookie(reader));
  await readAsGuest().expect(404); // staged, not yet present on the board
  await prisma.drawingSnapshot.create({
    data: {
      drawingId: drawing.id,
      version: 1,
      elements: JSON.stringify([{ id: "old", type: "image", fileId: "image" }]),
      appState: "{}",
      files: JSON.stringify({ image: { dataURL: url } }),
    },
  });
  await readAsGuest().expect(404); // exact file ID known, snapshot-only
  await prisma.drawing.update({
    where: { id: drawing.id },
    data: {
      elements: JSON.stringify([
        { id: "old", type: "image", fileId: "image", isDeleted: true },
      ]),
    },
  });
  await readAsGuest().expect(404); // tombstone in live scene
  await prisma.drawing.update({
    where: { id: drawing.id },
    data: {
      elements: JSON.stringify([
        { id: "new", type: "image", fileId: "image", isDeleted: false },
      ]),
    },
  });
  await request(app)
    .get(url)
    .set("X-Guest-Share", reader.share.id)
    .set("Cookie", cookie(reader))
    .expect("Cache-Control", "no-store")
    .expect(200);
  await prisma.drawingLinkShare.update({
    where: { id: editor.share.id },
    data: { revision: { increment: 1 } },
  });
  await upload(drawing.id, editor).expect(404);
  await request(app)
    .get(url)
    .set("X-Guest-Share", reader.share.id)
    .set("Cookie", cookie(reader))
    .expect(200);
});

const guestSocket = async (
  url: string,
  guest: Awaited<ReturnType<typeof createGuest>>,
  options?: { selectedShareId?: string; origin?: string; rejected?: boolean },
) => {
  const ws = new WebSocket(url, {
    headers: {
      cookie: `${guestSessionCookieName(guest.share.id)}=${guest.session}`,
      ...(options?.origin && { origin: options.origin }),
    },
  });
  sockets.add(ws);
  const messages: string[] = [];
  ws.addEventListener("message", ({ data }) => {
    if (typeof data !== "string") return;
    if (data.startsWith("0")) {
      ws.send(
        `40${JSON.stringify({ guestShareId: options?.selectedShareId ?? guest.share.id })}`,
      );
    } else if (data === "2") ws.send("3");
    else messages.push(data);
  });
  await expect
    .poll(() =>
      messages.some((msg) => msg.startsWith(options?.rejected ? "44" : "40")),
    )
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
    isAllowedOrigin: (origin) =>
      origin === undefined || origin === "https://app.test",
  });
  http.listen(0, "127.0.0.1");
  try {
    await once(http, "listening");
    const { port } = http.address() as AddressInfo;
    const url = `ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`;
    const [view, edit, passive] = await Promise.all(
      [reader, editor, expiring].map((guest) => guestSocket(url, guest)),
    );
    const wrongShare = await guestSocket(url, reader, {
      selectedShareId: editor.share.id,
      rejected: true,
    });
    const wrongOrigin = await guestSocket(url, reader, {
      origin: "https://other.test",
      rejected: true,
    });
    expect(
      wrongShare.messages.some((msg) => msg.includes("GUEST_ACCESS_ENDED")),
    ).toBe(true);
    expect(
      wrongOrigin.messages.some((msg) => msg.includes("Authentication failed")),
    ).toBe(true);
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
    edit.ws.send(
      `42${JSON.stringify(["element-update", { drawingId: drawing.id, elements: [{ id: "invalid-edit", type: "freedraw", points: "not an array" }] }])}`,
    );
    edit.ws.send(
      `42${JSON.stringify(["cursor-move", { drawingId: drawing.id, pointer: { x: "bad-cursor", y: 0, tool: "pointer" } }])}`,
    );
    await expect
      .poll(() => view.messages.some((msg) => msg.includes("Read-only access")))
      .toBe(true);
    edit.ws.send(
      `42${JSON.stringify([
        "element-update",
        {
          drawingId: drawing.id,
          elements: [
            {
              id: "guest-edit",
              type: "rectangle",
              x: 0,
              y: 0,
              width: 50,
              height: 50,
              angle: 0,
              strokeColor: "#000000",
              backgroundColor: "transparent",
              fillStyle: "solid",
              strokeWidth: 1,
              strokeStyle: "solid",
              roundness: null,
              roughness: 1,
              opacity: 100,
              seed: 1,
              version: 1,
              versionNonce: 1,
              index: null,
              isDeleted: false,
              groupIds: [],
              frameId: null,
              boundElements: null,
              updated: 1,
              link: null,
              locked: false,
            },
          ],
        },
      ])}`,
    );
    await expect
      .poll(() => view.messages.some((msg) => msg.includes("guest-edit")))
      .toBe(true);
    expect(
      view.messages.some(
        (msg) => msg.includes("invalid-edit") || msg.includes("bad-cursor"),
      ),
    ).toBe(false);

    await handlers.emitDrawingScene(drawing.id, {
      drawingId: drawing.id,
      persisted: true,
      elements: [
        {
          id: "deleted-content",
          version: 3,
          versionNonce: 5,
          isDeleted: true,
          type: "image",
          fileId: "deleted-image",
          text: "previous-private-content",
        },
      ],
      files: {
        "deleted-image": { dataURL: "data:image/png;base64,AQID" },
      },
    });
    await expect
      .poll(() => view.messages.some((msg) => msg.includes("deleted-content")))
      .toBe(true);
    const tombstone = view.messages.find((msg) =>
      msg.includes("deleted-content"),
    );
    expect(tombstone).not.toContain("previous-private-content");
    expect(tombstone).not.toContain("deleted-image");

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
