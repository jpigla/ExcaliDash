import type { Express } from "express";
import { z } from "zod";
import { isInstanceAdmin } from "../authz/sharing";
import type { DashboardRouteDeps } from "../routes/dashboard/types";
import { lockDrawingForGuestAccess } from "../routes/dashboard/drawingGuestLock";
import { isTrashCollectionId } from "../routes/dashboard/trash";
import { active, createPolicyLoader, id, managedGrantScope } from "./policy";

const update = z.strictObject({
  mode: z.enum(["read", "edit"]),
  minutes: z.int().min(1).max(1440),
});

export function registerManagedMcpGrants(
  app: Express,
  policyFile: string,
  {
    prisma,
    requireAuth,
    asyncHandler,
  }: Pick<DashboardRouteDeps, "prisma" | "requireAuth" | "asyncHandler">,
) {
  const load = createPolicyLoader(policyFile);
  const path = "/drawings/:id/codex-access";
  app.all(
    path,
    requireAuth,
    asyncHandler(async (req, res) => {
      res.set("Cache-Control", "no-store");
      const owner = req.user;
      if (owner?.authCredentialType !== "jwt" || owner.impersonatorId) {
        return res.sendStatus(403);
      }
      const drawingId = id.safeParse(req.params.id);
      if (!drawingId.success) return res.sendStatus(404);
      const method = req.method;
      if (!["GET", "PUT", "DELETE"].includes(method)) {
        return res.set("Allow", "GET, PUT, DELETE").sendStatus(405);
      }
      const parsed = update.safeParse(req.body);
      if (method === "PUT" && !parsed.success) {
        return res
          .status(400)
          .json({ message: "Choose a valid mode and duration." });
      }
      const policy = await load().catch(() => null);
      if (!policy) return res.sendStatus(503);
      const agent = policy.agents.find(
        ({ managedByUserId, expiresAt }) =>
          managedByUserId === owner.id && active(expiresAt),
      );
      const result = await prisma.$transaction(async (tx) => {
        if (method !== "GET")
          await lockDrawingForGuestAccess(tx, drawingId.data);
        const drawing = await tx.drawing.findUnique({
          where: { id: drawingId.data },
          select: { userId: true, collectionId: true },
        });
        if (
          !drawing ||
          (drawing.userId !== owner.id && !isInstanceAdmin(owner)) ||
          isTrashCollectionId(drawing.collectionId, drawing.userId)
        )
          return null;
        if (
          !agent ||
          (drawing.userId === agent.userId &&
            drawing.collectionId === agent.draftCollectionId)
        )
          return { agent: null };
        const account = await tx.user.findFirst({
          where: { id: agent.userId, isActive: true, mustResetPassword: false },
          select: { name: true },
        });
        if (!account) return { agent: null };
        const scope = {
          drawingId: drawingId.data,
          ...managedGrantScope(agent, drawing.userId),
        };
        const where = {
          drawingId_agentId: { drawingId: scope.drawingId, agentId: agent.id },
        };
        if (method === "PUT" && parsed.success) {
          const { mode, minutes } = parsed.data;
          const expiresAt = new Date(
            Math.min(
              Date.now() + minutes * 60_000,
              Date.parse(agent.expiresAt),
            ),
          );
          await tx.mcpBoardGrant.upsert({
            where,
            create: { ...scope, mode, expiresAt },
            update: { ...scope, mode, expiresAt },
          });
          await tx.auditLog.create({
            data: {
              userId: owner.id,
              action: "mcp_board_granted",
              resource: scope.drawingId,
              details: JSON.stringify({ agent: agent.id, mode, expiresAt }),
            },
          });
        }
        if (method === "DELETE") {
          const { count } = await tx.mcpBoardGrant.deleteMany({ where: scope });
          if (count) {
            await tx.auditLog.create({
              data: {
                userId: owner.id,
                action: "mcp_board_revoked",
                resource: scope.drawingId,
                details: JSON.stringify({ agent: agent.id }),
              },
            });
          }
        }
        const grant = await tx.mcpBoardGrant.findFirst({
          where: { ...scope, expiresAt: { gt: new Date() } },
          select: { mode: true, expiresAt: true },
        });
        const latest = await tx.auditLog.findFirst({
          where: {
            userId: agent.userId,
            resource: scope.drawingId,
            action: "mcp_board_apply",
          },
          orderBy: { createdAt: "desc" },
          select: { createdAt: true },
        });
        return {
          agent: account.name,
          grant,
          lastEditAt: latest?.createdAt ?? null,
        };
      });
      if (!result) return res.sendStatus(404);
      if (!result.agent && method !== "GET") return res.sendStatus(409);
      return res.json(result);
    }),
  );
}
