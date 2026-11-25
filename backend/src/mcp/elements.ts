import { randomBytes, randomUUID } from "node:crypto";
import { sanitizeElementText } from "../security";
import { boardFontById, textFormattingSchema } from "../textFormatting";
import { elementTypes, type NewElement, type Operation } from "./changeInput";

export type Element = Record<string, unknown> & {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  frameId?: string | null;
  isDeleted?: boolean;
};

export class BoardError extends Error {}
export const MAX_ELEMENTS = 5000;
export const MAX_SCENE_BYTES = 4 * 1024 * 1024;
const isLinear = (type: string) => type === "arrow" || type === "line";
const isLocked = (element: Element) => element.locked === true;
const numeric = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;
const nonce = () => randomBytes(4).readUInt32BE() & 0x7fffffff;

export function readElements(raw: string): Element[] {
  if (Buffer.byteLength(raw) > MAX_SCENE_BYTES)
    throw new BoardError("Board exceeds the MCP scene size limit.");
  const data: unknown = JSON.parse(raw);
  if (
    !Array.isArray(data) ||
    data.length > MAX_ELEMENTS ||
    data.some(
      (element) =>
        !element ||
        typeof element.id !== "string" ||
        typeof element.type !== "string" ||
        !["x", "y", "width", "height"].every((key) =>
          Number.isFinite(element[key]),
        ),
    ) ||
    new Set(data.map(({ id }) => id)).size !== data.length
  ) {
    throw new BoardError("Board contains unsupported or excessive scene data.");
  }
  return data;
}

export function inFrame(element: Element, frameId?: string) {
  return !frameId || element.id === frameId || element.frameId === frameId;
}

export function summarize(element: Element) {
  const {
    id,
    type,
    x,
    y,
    width,
    height,
    frameId,
    text,
    name,
    strokeColor,
    backgroundColor,
    locked,
    angle,
  } = element;
  return {
    id,
    type,
    x,
    y,
    width,
    height,
    frameId,
    text,
    name,
    strokeColor,
    backgroundColor,
    locked,
    angle,
    ...(type === "text"
      ? {
          fontFamily: element.fontFamily,
          textFormatting: element.textFormatting,
          textRuns: element.textRuns,
        }
      : {}),
  };
}

function textGeometry(text: string, fontSize: number, lineHeight: number) {
  const lines = text.split("\n");
  return {
    width: Math.max(
      1,
      Math.ceil(
        Math.max(...lines.map((line) => Array.from(line).length)) *
          fontSize *
          0.6,
      ),
    ),
    height: lines.length * fontSize * lineHeight,
  };
}

function newElement(input: NewElement, frameId?: string): Element {
  const linear = isLinear(input.type);
  const dx = (input.endX ?? input.x + 100) - input.x;
  const dy = (input.endY ?? input.y) - input.y;
  if (linear && dx === 0 && dy === 0)
    throw new BoardError("Line and arrow endpoints must differ.");
  if (!linear && (input.endX !== undefined || input.endY !== undefined))
    throw new BoardError("Endpoints require a line or arrow.");
  if (input.text !== undefined && !["text", "frame"].includes(input.type)) {
    throw new BoardError(
      "Use a text element for labels and the text field on frames for their name.",
    );
  }
  const text = sanitizeElementText(input.text ?? "");
  const fontSize = input.fontSize ?? 20;
  if (
    input.type !== "text" &&
    (input.fontFamily !== undefined || input.textFormatting !== undefined)
  )
    throw new BoardError(
      "Font family and text formatting require a text element.",
    );
  const fontFamily = input.fontFamily ?? 5;
  const lineHeight = boardFontById.get(fontFamily)?.metrics.lineHeight ?? 1.25;
  const metrics = textGeometry(text, fontSize, lineHeight);
  const element: Element = {
    id: randomUUID(),
    type: input.type,
    x: input.x,
    y: input.y,
    width: linear
      ? Math.abs(dx)
      : input.type === "text"
        ? metrics.width
        : (input.width ?? 160),
    height: linear
      ? Math.abs(dy)
      : input.type === "text"
        ? metrics.height
        : (input.height ?? 90),
    frameId: frameId ?? null,
    angle: 0,
    strokeColor: input.strokeColor ?? "#1e1e1e",
    backgroundColor: input.backgroundColor ?? "transparent",
    fillStyle: "solid",
    strokeWidth: input.strokeWidth ?? 2,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    roundness: null,
    groupIds: [],
    boundElements: null,
    seed: nonce(),
    version: 1,
    versionNonce: nonce(),
    isDeleted: false,
    updated: Date.now(),
    link: null,
    locked: false,
  };
  element.index = null;
  if (input.type === "text")
    Object.assign(element, {
      text,
      originalText: text,
      fontSize,
      fontFamily,
      lineHeight,
      ...(input.textFormatting ? { textFormatting: input.textFormatting } : {}),
      textAlign: "left",
      verticalAlign: "top",
      containerId: null,
      autoResize: true,
    });
  if (input.type === "frame") element.name = text || null;
  if (linear)
    Object.assign(element, {
      points: [
        [0, 0],
        [dx, dy],
      ],
      lastCommittedPoint: null,
      startBinding: null,
      endBinding: null,
      startArrowhead: null,
      endArrowhead: input.type === "arrow" ? "arrow" : null,
      elbowed: false,
    });
  return element;
}

function referencedIds(element: Element): unknown[] {
  const bindings = [element.startBinding, element.endBinding] as (
    { elementId?: unknown } | null | undefined
  )[];
  return [
    element.frameId,
    element.containerId,
    ...bindings.map((binding) => binding?.elementId),
    ...(Array.isArray(element.boundElements)
      ? element.boundElements.map((bound) => bound?.id)
      : []),
  ];
}

export function changeElements(
  elements: Element[],
  operations: Operation[],
  frameId?: string,
) {
  const existing = new Map(elements.map((element) => [element.id, element]));
  const removed = new Set(
    operations.flatMap((item) => (item.op === "remove" ? [item.id] : [])),
  );
  const targets = operations.flatMap((item) =>
    item.op === "add" ? [] : [item.id],
  );
  if (new Set(targets).size !== targets.length)
    throw new BoardError("Use at most one operation per existing element.");
  if (
    removed.size &&
    elements.some(
      (element) =>
        !element.isDeleted &&
        !removed.has(element.id) &&
        referencedIds(element).some(
          (ref) => typeof ref === "string" && removed.has(ref),
        ),
    )
  )
    throw new BoardError("Removal would leave a reference in another element.");
  if (
    elements.length + operations.filter((item) => item.op === "add").length >
    MAX_ELEMENTS
  ) {
    throw new BoardError("Board exceeds the MCP element limit.");
  }
  const changedIds: string[] = [];
  for (const item of operations) {
    if (item.op === "add") {
      const targetFrameId = item.element.frameId ?? frameId;
      const targetFrame = targetFrameId
        ? existing.get(targetFrameId)
        : undefined;
      if (
        targetFrameId &&
        (!targetFrame ||
          targetFrame.isDeleted ||
          isLocked(targetFrame) ||
          removed.has(targetFrameId) ||
          targetFrame.type !== "frame" ||
          item.element.type === "frame" ||
          (frameId && targetFrameId !== frameId))
      )
        throw new BoardError("Target frame unavailable.");
      const element = newElement(item.element, targetFrameId);
      existing.set(element.id, element);
      changedIds.push(element.id);
      continue;
    }
    const before = existing.get(item.id);
    if (
      !before ||
      before.isDeleted ||
      !inFrame(before, frameId) ||
      before.id === frameId ||
      isLocked(before)
    ) {
      throw new BoardError("Element unavailable for editing.");
    }
    if (item.op === "update") {
      const { text, fontSize, fontFamily, textFormatting, ...patch } =
        item.changes;
      if (!elementTypes.has(before.type as NewElement["type"]))
        throw new BoardError("Element type is read-only.");
      const geometry = ["x", "y", "width", "height"].some(
        (key) => key in patch,
      );
      if (
        geometry &&
        (referencedIds(before).slice(1).some(Boolean) ||
          (isLinear(before.type) && ("width" in patch || "height" in patch)))
      ) {
        throw new BoardError(
          "Resize or move bound elements and resize lines in the editor.",
        );
      }
      const typographyChanged =
        fontFamily !== undefined || textFormatting !== undefined;
      if (text !== undefined || fontSize !== undefined || typographyChanged) {
        if (
          before.type === "frame" &&
          fontSize === undefined &&
          !typographyChanged
        ) {
          Object.assign(patch, { name: sanitizeElementText(text ?? "") });
        } else if (before.type === "text" && !before.containerId) {
          const value = sanitizeElementText(text ?? String(before.text ?? ""));
          const size = fontSize ?? numeric(before.fontSize, 20);
          const family = fontFamily ?? numeric(before.fontFamily, 5);
          const lineHeight =
            fontFamily !== undefined
              ? (boardFontById.get(family)?.metrics.lineHeight ?? 1.25)
              : numeric(before.lineHeight, 1.25);
          const previous = textFormattingSchema.safeParse(
            before.textFormatting,
          );
          Object.assign(patch, {
            text: value,
            originalText: value,
            ...(text !== undefined &&
            value !== before.originalText &&
            before.textRuns
              ? { textRuns: [] }
              : {}),
            fontSize: size,
            fontFamily: family,
            lineHeight,
            ...(typographyChanged
              ? {
                  textFormatting: {
                    ...previous.data,
                    ...textFormatting,
                  },
                }
              : {}),
            ...textGeometry(value, size, lineHeight),
            autoResize: true,
          });
        } else {
          throw new BoardError(
            "Use a standalone text element or edit bound labels in the editor.",
          );
        }
      }
      if (!Object.keys(patch).length)
        throw new BoardError("Update must change at least one field.");
      existing.set(before.id, {
        ...before,
        ...patch,
        version: numeric(before.version, 1) + 1,
        versionNonce: nonce(),
        updated: Date.now(),
      });
    } else {
      existing.set(before.id, {
        ...before,
        isDeleted: true,
        version: numeric(before.version, 1) + 1,
        versionNonce: nonce(),
        updated: Date.now(),
      });
    }
    changedIds.push(before.id);
  }
  return { elements: [...existing.values()], changedIds };
}
