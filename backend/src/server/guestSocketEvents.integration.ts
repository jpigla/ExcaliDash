import { afterEach, describe, expect, it, vi } from "vitest";
import { createGuestSocketPacketGuard } from "./guestSocketEvents";

const drawingId = "drawing";
const rectangle = {
  id: "rect",
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
};

describe("guest Socket.IO packet limits", () => {
  afterEach(() => vi.useRealTimers());

  it("drops unknown, cross-drawing, and oversized events before dispatch", () => {
    const guard = createGuestSocketPacketGuard(drawingId);
    expect(guard(["unknown", {}])).toBeNull();
    expect(
      guard(["join-room", { drawingId: "other", user: { name: "Guest" } }]),
    ).toBeNull();
    expect(
      guard([
        "join-room",
        { drawingId, user: { name: "Guest" }, excess: "x".repeat(4096) },
      ]),
    ).toBeNull();
    expect(
      guard([
        "element-update",
        {
          drawingId,
          elements: [rectangle],
          files: {
            image: {
              id: "image",
              mimeType: "image/png",
              dataURL: `data:image/png;base64,${"a".repeat(768 * 1024)}`,
              created: 0,
            },
          },
        },
      ]),
    ).toBeNull();
  });

  it("accepts editor packets while removing unknown metadata and pending references", () => {
    const guard = createGuestSocketPacketGuard(drawingId);
    const raster = {
      id: "raster",
      mimeType: "image/png",
      dataURL: "data:image/png;base64,AQID",
      created: 0,
    };
    expect(
      guard([
        "element-update",
        {
          drawingId,
          persisted: true,
          elements: [
            {
              ...rectangle,
              link: "javascript:alert(1)",
              customData: { html: "<script />" },
            },
          ],
          files: {
            raster,
            pending: {
              ...raster,
              id: "pending",
              dataURL: "/api/files/drawing/pending",
            },
          },
        },
      ]),
    ).toEqual([
      "element-update",
      {
        drawingId,
        elements: [rectangle],
        files: { raster },
      },
    ]);
  });

  it("bounds event bursts and allows normal traffic again in the next window", () => {
    vi.useFakeTimers();
    const guard = createGuestSocketPacketGuard(drawingId);
    const cursor = [
      "cursor-move",
      { drawingId, pointer: { x: 0, y: 0, tool: "pointer" }, button: "up" },
    ];
    const scene = ["element-update", { drawingId, elements: [rectangle] }];
    for (let i = 0; i < 32; i++) expect(guard(cursor)).not.toBeNull();
    expect(guard(cursor)).toBeNull();
    expect(guard(scene)).not.toBeNull();
    vi.advanceTimersByTime(1000);
    expect(guard(cursor)).not.toBeNull();
  });
});
