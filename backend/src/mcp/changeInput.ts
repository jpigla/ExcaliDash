import { z } from "zod";
import { id, sha256 } from "./policy";

const coord = z.number().min(-100_000).max(100_000);
const extent = z.number().min(1).max(10_000);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const visual = {
  x: coord,
  y: coord,
  width: extent.optional(),
  height: extent.optional(),
  strokeColor: color.optional(),
  backgroundColor: z.union([color, z.literal("transparent")]).optional(),
  strokeWidth: z.number().min(1).max(8).optional(),
  text: z.string().max(2000).optional(),
  fontSize: z.number().int().min(12).max(96).optional(),
};
const add = z.strictObject({
  ...visual,
  type: z.enum([
    "rectangle",
    "ellipse",
    "diamond",
    "text",
    "arrow",
    "line",
    "frame",
  ]),
  frameId: id.optional(),
  endX: coord.optional(),
  endY: coord.optional(),
});
const update = z.strictObject(visual).partial();
const operation = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("add"), element: add }),
  z.strictObject({ op: z.literal("update"), id, changes: update }),
  z.strictObject({ op: z.literal("remove"), id }),
]);
export const changeInput = z.strictObject({
  boardId: id,
  frameId: id.optional(),
  revision: z.number().int().min(1),
  operationId: id,
  operations: z.array(operation).min(1).max(100),
});
export type Operation = z.infer<typeof operation>;
export type Change = z.infer<typeof changeInput>;
export type NewElement = z.infer<typeof add>;
export const elementTypes = new Set(add.shape.type.options);
export const hashInput = (value: unknown) => sha256(JSON.stringify(value));

export function changeDigest(
  agent: { id: string; userId: string },
  input: Change,
) {
  return hashInput([
    "apply",
    agent.id,
    agent.userId,
    input.boardId,
    input.frameId ?? null,
    input.revision,
    input.operationId,
    input.operations,
  ]);
}
