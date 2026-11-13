import { z } from "zod";
import { isGuestImageType } from "../fileProcessing";
import { sanitizeElementText, sanitizeUrl } from "../security";

const id = z.string().min(1).max(200);
const fileId = id
  .regex(/^[\w-]+$/)
  .refine(
    (value) => !["__proto__", "constructor", "prototype"].includes(value),
  );
const coordinate = z.number().min(-10_000_000).max(10_000_000);
const point = z.tuple([coordinate, coordinate]);
const nonnegativeInt = z.number().int().nonnegative();
const text = z
  .string()
  .max(20_000)
  .transform((value) => sanitizeElementText(value));
const nullableId = id.nullable();
const binding = z
  .object({
    elementId: id,
    focus: coordinate,
    gap: coordinate,
    fixedPoint: point.optional(),
  })
  .nullable();
const arrowhead = z
  .enum([
    "arrow",
    "bar",
    "dot",
    "circle",
    "circle_outline",
    "triangle",
    "triangle_outline",
    "diamond",
    "diamond_outline",
    "crowfoot_one",
    "crowfoot_many",
    "crowfoot_one_or_many",
  ])
  .nullable();

const element = z
  .object({
    id,
    type: z.enum([
      "rectangle",
      "diamond",
      "ellipse",
      "embeddable",
      "iframe",
      "image",
      "frame",
      "magicframe",
      "text",
      "line",
      "arrow",
      "freedraw",
    ]),
    x: coordinate,
    y: coordinate,
    width: coordinate,
    height: coordinate,
    angle: coordinate,
    strokeColor: z.string().max(64),
    backgroundColor: z.string().max(64),
    fillStyle: z.enum(["hachure", "cross-hatch", "solid", "zigzag"]),
    strokeWidth: z.number().min(0).max(256),
    strokeStyle: z.enum(["solid", "dashed", "dotted"]),
    roundness: z
      .object({
        type: z.number().int().min(1).max(3),
        value: coordinate.optional(),
      })
      .nullable(),
    roughness: z.number().min(0).max(3),
    opacity: z.number().min(0).max(100),
    seed: z.number().int(),
    version: nonnegativeInt,
    versionNonce: z.number().int(),
    index: z.string().max(200).nullable(),
    isDeleted: z.boolean(),
    groupIds: z.array(id).max(100),
    frameId: nullableId,
    boundElements: z
      .array(z.object({ id, type: z.enum(["arrow", "text"]) }))
      .max(1000)
      .nullable(),
    updated: nonnegativeInt,
    link: z
      .string()
      .max(2048)
      .transform((value) => sanitizeUrl(value) || null)
      .nullable(),
    locked: z.boolean(),
    // Shape-specific fields. Unknown metadata, including iframe srcdoc, is not relayed.
    points: z.array(point).max(10_000).optional(),
    lastCommittedPoint: point.nullable().optional(),
    pressures: z.array(z.number().min(0).max(1)).max(10_000).optional(),
    simulatePressure: z.boolean().optional(),
    startBinding: binding.optional(),
    endBinding: binding.optional(),
    startArrowhead: arrowhead.optional(),
    endArrowhead: arrowhead.optional(),
    elbowed: z.boolean().optional(),
    fixedSegments: z
      .array(z.object({ start: point, end: point, index: nonnegativeInt }))
      .max(1000)
      .nullable()
      .optional(),
    startIsSpecial: z.boolean().nullable().optional(),
    endIsSpecial: z.boolean().nullable().optional(),
    text: text.optional(),
    originalText: text.optional(),
    fontSize: z.number().positive().max(10_000).optional(),
    fontFamily: z.number().int().positive().optional(),
    textAlign: z.enum(["left", "center", "right"]).optional(),
    verticalAlign: z.enum(["top", "middle", "bottom"]).optional(),
    containerId: nullableId.optional(),
    autoResize: z.boolean().optional(),
    lineHeight: z.number().positive().max(100).optional(),
    fileId: fileId.nullable().optional(),
    status: z.enum(["pending", "saved", "error"]).optional(),
    scale: z
      .tuple([
        z.union([z.literal(-1), z.literal(1)]),
        z.union([z.literal(-1), z.literal(1)]),
      ])
      .optional(),
    crop: z
      .object({
        x: coordinate,
        y: coordinate,
        width: coordinate,
        height: coordinate,
        naturalWidth: coordinate,
        naturalHeight: coordinate,
      })
      .nullable()
      .optional(),
    name: z
      .string()
      .max(1024)
      .transform((value) => sanitizeElementText(value, 1024))
      .nullable()
      .optional(),
  })
  .refine((value) => {
    switch (value.type) {
      case "line":
      case "arrow":
        return (
          !!value.points?.length &&
          value.startBinding !== undefined &&
          value.endBinding !== undefined
        );
      case "freedraw":
        return (
          !!value.points?.length &&
          value.pressures !== undefined &&
          value.simulatePressure !== undefined
        );
      case "text":
        return (
          value.text !== undefined &&
          value.originalText !== undefined &&
          value.fontSize !== undefined &&
          value.fontFamily !== undefined &&
          value.textAlign !== undefined &&
          value.verticalAlign !== undefined &&
          value.lineHeight !== undefined
        );
      case "image":
        return (
          value.fileId !== undefined &&
          value.status !== undefined &&
          value.scale !== undefined
        );
      default:
        return true;
    }
  });

const join = z.object({
  drawingId: id,
  user: z.object({
    name: z.string().max(120),
    color: z.string().max(9).optional(),
  }),
});
const cursor = z.object({
  drawingId: id,
  pointer: z.object({
    x: coordinate,
    y: coordinate,
    tool: z.enum(["pointer", "laser"]),
  }),
  button: z.enum(["down", "up"]).optional(),
  selectedElementIds: z
    .record(fileId, z.boolean())
    .refine((value) => Object.keys(value).length <= 500)
    .optional(),
});
const activity = z.object({ drawingId: id, isActive: z.boolean() });

const file = z.object({
  id: fileId,
  mimeType: z.string().max(64),
  dataURL: z.string().max(768 * 1024),
  created: nonnegativeInt,
  lastRetrieved: nonnegativeInt.optional(),
  version: nonnegativeInt.optional(),
});

const scene = z
  .object({
    drawingId: id,
    elements: z.array(element).max(2500),
    files: z
      .record(fileId, file)
      .refine((value) => Object.keys(value).length <= 128)
      .optional(),
    elementOrder: z.array(id).max(10_000).optional(),
  })
  .transform(({ files, ...update }) => ({
    ...update,
    // New refs are distributed by the authorized persisted scene. A transient
    // packet can relay only a bounded inline raster, never arbitrary URLs.
    ...(files && {
      files: Object.fromEntries(
        Object.entries(files).filter(
          ([id, value]) =>
            id === value.id &&
            isGuestImageType(value.mimeType) &&
            value.dataURL.startsWith(`data:${value.mimeType};base64,`) &&
            /^[a-z0-9+/]+={0,2}$/i.test(
              value.dataURL.slice(value.dataURL.indexOf(",") + 1),
            ),
        ),
      ),
    }),
  }));

const schemas = {
  "join-room": join,
  "cursor-move": cursor,
  "user-activity": activity,
  "element-update": scene,
};
type GuestEvent = keyof typeof schemas;

// Walk before the schema parser. This also bounds nested unknown fields,
// preventing deeply nested input from reaching sanitizers or serialization.
const packetSize = (root: unknown, byteLimit: number): number | null => {
  const pending: [unknown, number][] = [[root, 0]];
  let size = 0;
  let visited = 0;
  while (pending.length) {
    const [value, depth] = pending.pop()!;
    if (depth > 12 || ++visited > 125_000) return null;
    size += typeof value === "string" ? Buffer.byteLength(value) + 2 : 8;
    if (size > byteLimit) return null;
    if (!value || typeof value !== "object") continue;
    if (ArrayBuffer.isView(value)) return null;
    const entries = Object.entries(value);
    if (pending.length + entries.length > 125_000) return null;
    for (const [key, child] of entries) {
      size += Buffer.byteLength(key) + 3;
      if (size > byteLimit) return null;
      pending.push([child, depth + 1]);
    }
  }
  return size;
};

const maxPacketBytes = {
  "join-room": 4096,
  "cursor-move": 16 * 1024,
  "user-activity": 4096,
  "element-update": 768 * 1024,
};
const maxPackets = {
  "join-room": 4,
  "cursor-move": 32,
  "user-activity": 8,
  "element-update": 24,
};

// The editor sends cursors at 20 Hz and scene changes at 10 Hz. A separate
// byte budget prevents large, individually valid updates from saturating a room.
export const createGuestSocketPacketGuard = (drawingId: string) => {
  let windowStart = Date.now();
  let bytes = 0;
  const counts = new Map<GuestEvent, number>();

  return ([event, raw, ack]: unknown[]) => {
    if (typeof event !== "string" || !Object.hasOwn(schemas, event))
      return null;
    const name = event as GuestEvent;
    const now = Date.now();
    if (now - windowStart >= 1000) {
      windowStart = now;
      bytes = 0;
      counts.clear();
    }
    const count = (counts.get(name) ?? 0) + 1;
    if (count > maxPackets[name] || bytes >= 3 * 1024 * 1024) return null;
    counts.set(name, count);
    const size = packetSize(raw, maxPacketBytes[name]);
    if (size === null) return null;
    bytes += size;
    if (bytes > 3 * 1024 * 1024) return null;
    const parsed = schemas[name].safeParse(raw);
    if (!parsed.success || parsed.data.drawingId !== drawingId) return null;
    return name === "join-room" && typeof ack === "function"
      ? [name, parsed.data, ack]
      : [name, parsed.data];
  };
};
