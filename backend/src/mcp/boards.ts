import { randomUUID } from "node:crypto";
import {
  getDrawingAccess,
  isCurrentInstanceAdmin,
  canEditDrawing,
  canViewDrawing,
} from "../authz/sharing";
import type { Prisma, PrismaClient } from "../generated/client";
import {
  applySceneUpdateTx,
  isVersionConflict,
} from "../routes/dashboard/sceneUpdate";
import { isTrashCollectionId } from "../routes/dashboard/trash";
import { sanitizeText } from "../security";
import type { SceneBounds } from "../server/sceneBounds";
import {
  BoardError,
  changeElements,
  inFrame,
  MAX_SCENE_BYTES,
  readElements,
  summarize,
  type Element,
} from "./elements";
import { changeDigest, hashInput, type Change } from "./changeInput";
import { active, managedGrantScope, type Agent } from "./policy";
import { renderScene } from "./render";

type Db = Prisma.TransactionClient;
const boardFields = {
  id: true,
  name: true,
  userId: true,
  collectionId: true,
  version: true,
} as const;
type Board = Prisma.DrawingGetPayload<{ select: typeof boardFields }>;
type Mutation = { boardId: string; revision: number; changedIds?: string[] };
type Context = {
  prisma: PrismaClient;
  invalidateDrawingsCache: () => void;
  emitDrawingScene: (boardId: string, payload: unknown) => Promise<void>;
};
type Filter = { boardId: string; frameId?: string };
const unavailable = () =>
  new BoardError("Board unavailable for this operation.");

class AlreadyApplied extends Error {
  constructor(readonly result: Mutation) {
    super("Already applied");
  }
}

async function checkAccount(db: Db, agent: Agent) {
  const account = await db.user.findFirst({
    where: { id: agent.userId, isActive: true, mustResetPassword: false },
    select: { id: true },
  });
  if (!account || !active(agent.expiresAt)) throw unavailable();
}

function isDraft(board: Board, agent: Agent) {
  return (
    !!agent.draftCollectionId &&
    board.collectionId === agent.draftCollectionId &&
    board.userId === agent.userId
  );
}

async function grantedFrames(
  db: Db,
  agent: Agent,
  board: Board,
  write: boolean,
): Promise<string[] | null> {
  if (isTrashCollectionId(board.collectionId, board.userId)) return [];
  if (agent.managedByUserId && !isDraft(board, agent)) {
    if (
      board.userId !== agent.managedByUserId &&
      !(await isCurrentInstanceAdmin(db, agent.managedByUserId))
    )
      return [];
    const grant = await db.mcpBoardGrant.findFirst({
      where: {
        drawingId: board.id,
        ...managedGrantScope(agent, board.userId),
        expiresAt: { gt: new Date() },
        mode: { in: write ? ["edit"] : ["read", "edit"] },
      },
      select: { drawingId: true },
    });
    return grant ? null : [];
  }
  const now = Date.now();
  const grants = agent.boards.filter(
    (grant) =>
      grant.boardId === board.id &&
      (!grant.expiresAt || Date.parse(grant.expiresAt) > now) &&
      (!write || grant.mode === "edit"),
  );
  const full =
    isDraft(board, agent) ||
    grants.some((grant) => !grant.frameId) ||
    (!write &&
      !!board.collectionId &&
      agent.readCollections.includes(board.collectionId));
  const frames = [...new Set(grants.flatMap((grant) => grant.frameId ?? []))];
  if (!full && !frames.length) return [];
  const access = await getDrawingAccess({
    prisma: db,
    principal: { kind: "user", userId: agent.userId },
    drawingId: board.id,
  });
  if (!(write ? canEditDrawing(access) : canViewDrawing(access))) return [];
  return full ? null : frames;
}

async function checkAccess(
  db: Db,
  agent: Agent,
  board: Board,
  write: boolean,
  requestedFrame?: string,
) {
  const frames = await grantedFrames(db, agent, board, write);
  if (!frames) return requestedFrame;
  if (!frames.length || (requestedFrame && !frames.includes(requestedFrame)))
    throw unavailable();
  if (!requestedFrame && frames.length > 1)
    throw new BoardError("Specify a frameId for this board.");
  return requestedFrame ?? frames[0];
}

function requireFrame(elements: Element[], frameId?: string) {
  if (
    frameId &&
    !elements.some(
      (el) => el.id === frameId && el.type === "frame" && !el.isDeleted,
    )
  )
    throw unavailable();
}

function receiptId(agent: Agent, operationId: string) {
  return `mcp_${hashInput([agent.userId, agent.id, operationId])}`;
}

async function checkReceipt(
  db: Db,
  key: string,
  digest: string,
  boardId?: string,
) {
  const receipt = await db.auditLog.findUnique({
    where: { id: key },
    select: { details: true, resource: true },
  });
  if (!receipt) return;
  const data = JSON.parse(receipt.details ?? "{}") as {
    digest?: string;
    result?: Mutation;
  };
  if (
    data.digest !== digest ||
    !data.result ||
    !receipt.resource ||
    (boardId && receipt.resource !== boardId)
  ) {
    throw new BoardError("operationId already used for a different request.");
  }
  return data.result;
}

async function record(
  db: Db,
  agent: Agent,
  key: string,
  digest: string,
  result: Mutation,
  action: string,
) {
  await db.auditLog.create({
    data: {
      id: key,
      userId: agent.userId,
      action,
      resource: result.boardId,
      details: JSON.stringify({ agent: agent.id, digest, result }),
    },
  });
}

export function createBoardTools(
  context: Context,
  agent: Agent,
  resource: string,
) {
  const { prisma } = context;
  const url = (id: string) =>
    new URL(`/editor/${encodeURIComponent(id)}`, resource).href;
  const present = ({ id, name, version }: Board) => ({
    boardId: id,
    title: name,
    revision: version,
    url: url(id),
  });

  async function read(filter: Filter) {
    await checkAccount(prisma, agent);
    const board = await prisma.drawing.findUnique({
      where: { id: filter.boardId },
      select: boardFields,
    });
    if (!board) throw unavailable();
    const frameId = await checkAccess(
      prisma,
      agent,
      board,
      false,
      filter.frameId,
    );
    // Load the full scene after checking scope. Also require the metadata
    // we authorized to match, so a concurrent move cannot broaden access.
    const stored = await prisma.drawing.findFirst({
      where: {
        id: board.id,
        version: board.version,
        collectionId: board.collectionId,
        userId: board.userId,
      },
      select: { elements: true },
    });
    if (!stored)
      throw new BoardError("Board changed while reading. Try again.");
    const elements = readElements(stored.elements);
    requireFrame(elements, frameId);
    return {
      board,
      scene: elements.filter((el) => !el.isDeleted && inFrame(el, frameId)),
      frameId,
    };
  }

  return {
    async list(input: { offset: number }) {
      await checkAccount(prisma, agent);
      const managerIsAdmin =
        agent.managedByUserId &&
        (await isCurrentInstanceAdmin(prisma, agent.managedByUserId));
      const candidates = await prisma.drawing.findMany({
        where: agent.managedByUserId
          ? {
              OR: [
                {
                  ...(managerIsAdmin ? {} : { userId: agent.managedByUserId }),
                  mcpGrants: {
                    some: {
                      agentId: agent.id,
                      agentUserId: agent.userId,
                      ...(managerIsAdmin
                        ? {}
                        : { ownerId: agent.managedByUserId }),
                      mode: { in: ["read", "edit"] },
                      expiresAt: { gt: new Date() },
                    },
                  },
                },
                ...(agent.draftCollectionId
                  ? [
                      {
                        collectionId: agent.draftCollectionId,
                        userId: agent.userId,
                      },
                    ]
                  : []),
              ],
            }
          : {
              // Filter native access before pagination so a revoked collection
              // share cannot leak a board count via nextOffset.
              AND: [
                {
                  OR: [
                    { userId: agent.userId },
                    {
                      permissions: {
                        some: {
                          granteeUserId: agent.userId,
                          permission: { in: ["view", "edit"] },
                        },
                      },
                    },
                    {
                      collection: {
                        is: {
                          OR: [
                            { userId: agent.userId },
                            {
                              shares: {
                                some: {
                                  granteeUserId: agent.userId,
                                  role: { in: ["view", "edit"] },
                                },
                              },
                            },
                          ],
                        },
                      },
                    },
                  ],
                },
                {
                  OR: [
                    {
                      id: {
                        in: agent.boards
                          .filter((grant) => active(grant.expiresAt))
                          .map((grant) => grant.boardId),
                      },
                    },
                    { collectionId: { in: agent.readCollections } },
                    ...(agent.draftCollectionId
                      ? [
                          {
                            collectionId: agent.draftCollectionId,
                            userId: agent.userId,
                          },
                        ]
                      : []),
                  ],
                },
              ],
            },
        orderBy: { id: "asc" },
        skip: input.offset,
        take: 51,
        select: boardFields,
      });
      const boards = [];
      for (const board of candidates.slice(0, 50)) {
        const frameIds = await grantedFrames(prisma, agent, board, false);
        if (frameIds === null) boards.push(present(board));
        else if (frameIds.length) boards.push({ ...present(board), frameIds });
      }
      const nextOffset = candidates.length > 50 ? input.offset + 50 : undefined;
      return { boards, nextOffset };
    },
    async create(input: { title: string; operationId: string }) {
      const collectionId = agent.draftCollectionId;
      if (
        !collectionId ||
        collectionId === "trash" ||
        collectionId.startsWith("trash:")
      )
        throw unavailable();
      const title = sanitizeText(input.title).trim();
      if (!title) throw new BoardError("Title cannot be empty.");
      const key = receiptId(agent, input.operationId);
      const digest = hashInput(["create", collectionId, title]);
      await checkAccount(prisma, agent);
      let result: Mutation = { boardId: randomUUID(), revision: 1 };
      try {
        await prisma.$transaction(async (tx) => {
          // Reserve the operation ID before reading. The transaction rolls
          // back the receipt if creating the drawing fails.
          await record(tx, agent, key, digest, result, "mcp_board_create");
          await checkAccount(tx, agent);
          const collection = await tx.collection.findFirst({
            where: { id: collectionId, userId: agent.userId },
            select: { id: true },
          });
          if (!collection) throw unavailable();
          await tx.drawing.create({
            data: {
              id: result.boardId,
              version: result.revision,
              name: title,
              elements: "[]",
              appState: "{}",
              userId: agent.userId,
              collectionId,
            },
          });
        });
        context.invalidateDrawingsCache();
      } catch (error) {
        if ((error as { code?: string }).code !== "P2002") throw error;
        const previous = await checkReceipt(prisma, key, digest);
        if (!previous) throw error;
        await checkAccount(prisma, agent);
        const board = await prisma.drawing.findUnique({
          where: { id: previous.boardId },
          select: boardFields,
        });
        if (!board || !isDraft(board, agent)) throw unavailable();
        result = previous;
      }
      return { ...result, url: url(result.boardId) };
    },
    async read(input: Filter & { offset: number; elementId?: string }) {
      const { board, scene, frameId } = await read(input);
      const elements = scene.filter(
        (element) => !input.elementId || element.id === input.elementId,
      );
      return {
        ...present(board),
        frameId,
        total: elements.length,
        elements: elements
          .slice(input.offset, input.offset + 50)
          .map(summarize),
        nextOffset:
          input.offset + 50 < elements.length ? input.offset + 50 : undefined,
      };
    },
    async render(input: Filter & { bounds?: SceneBounds }) {
      const { board, scene } = await read(input);
      return { board: present(board), png: renderScene(scene, input.bounds) };
    },
    async apply(input: Change) {
      // Reject out-of-scope calls before taking the write lock. Recheck while locked.
      await checkAccount(prisma, agent);
      const board = await prisma.drawing.findUnique({
        where: { id: input.boardId },
        select: boardFields,
      });
      if (!board) throw unavailable();
      await checkAccess(prisma, agent, board, true, input.frameId);
      const key = receiptId(agent, input.operationId);
      const digest = changeDigest(agent, input);
      let result: Mutation | undefined;
      let saved: { elements: string; files: string };
      let frameId: string | undefined;
      try {
        const { drawing } = await applySceneUpdateTx({
          prisma,
          drawingId: input.boardId,
          versionGuard: input.revision,
          parseJsonField: (raw, fallback) => (raw ? JSON.parse(raw) : fallback),
          authorizeWrite: async (tx) => {
            await checkAccount(tx, agent);
            const board = await tx.drawing.findUnique({
              where: { id: input.boardId },
              select: boardFields,
            });
            if (!board) throw unavailable();
            frameId = await checkAccess(tx, agent, board, true, input.frameId);
            const previous = await checkReceipt(tx, key, digest, board.id);
            if (previous) {
              if (frameId) {
                const stored = await tx.drawing.findUniqueOrThrow({
                  where: { id: board.id },
                  select: { elements: true },
                });
                const elements = readElements(stored.elements);
                requireFrame(elements, frameId);
                const visibleIds = new Set(
                  elements
                    .filter((element) => inFrame(element, frameId))
                    .map((element) => element.id),
                );
                if (!previous.changedIds?.every((id) => visibleIds.has(id)))
                  throw unavailable();
              }
              throw new AlreadyApplied(previous);
            }
          },
          mutate: async (current, tx) => {
            if (
              !isDraft(current, agent) &&
              input.operations.some((op) => op.op === "remove")
            ) {
              if (frameId && !input.frameId) {
                throw new BoardError(
                  "Specify the frameId before requesting element removal approval.",
                );
              }
              if (
                !agent.approvedChanges.some(
                  (grant) => grant.digest === digest && active(grant.expiresAt),
                )
              ) {
                throw new BoardError(
                  `Element removal requires approval for this exact change. Approval digest: ${digest}.`,
                );
              }
            }
            const currentElements = readElements(current.elements);
            requireFrame(currentElements, frameId);
            const changes = changeElements(
              currentElements,
              input.operations,
              frameId,
            );
            const elements = JSON.stringify(changes.elements);
            if (Buffer.byteLength(elements) > MAX_SCENE_BYTES)
              throw new BoardError("Board exceeds the MCP scene size limit.");
            result = {
              boardId: current.id,
              revision: current.version + 1,
              changedIds: changes.changedIds,
            };
            await record(tx, agent, key, digest, result, "mcp_board_apply");
            return { data: { elements, preview: null } };
          },
        });
        saved = drawing;
      } catch (error) {
        if (error instanceof AlreadyApplied)
          return { ...error.result, url: url(input.boardId), replayed: true };
        if (isVersionConflict(error))
          throw new BoardError(
            "Board revision changed. Read the current board and re-evaluate the change.",
          );
        throw error;
      }
      context.invalidateDrawingsCache();
      try {
        const elements = readElements(saved.elements);
        await context.emitDrawingScene(input.boardId, {
          drawingId: input.boardId,
          persisted: true,
          elements,
          elementOrder: elements.map((element) => element.id),
          files: JSON.parse(saved.files),
        });
      } catch {
        console.warn("[mcp] Could not relay committed board update");
      }
      if (!result) throw new Error("Missing committed MCP receipt");
      return { ...result, url: url(input.boardId) };
    },
  };
}
