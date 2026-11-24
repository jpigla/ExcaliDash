import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import bcrypt from "bcrypt";
import { changeDigest, changeInput } from "./changeInput";
import { createPolicyLoader, id, sha256 } from "./policy";

async function main() {
  const [command, agentId, userId, requestPath] = process.argv.slice(2);
  if (command === "token") {
    const token = `exdm_${randomBytes(32).toString("base64url")}`;
    const credential = { type: "token", sha256: sha256(token) };
    console.log(JSON.stringify({ token, credential }, null, 2));
    return;
  }
  if (command === "validate" && agentId) {
    await createPolicyLoader(agentId)();
    console.log("MCP policy is valid.");
    return;
  }
  if (command === "provision-desktop" && agentId) {
    const ownerId = id.parse(agentId);
    const { prisma } = await import("../db/prisma");
    try {
      const secret = `exdm_${randomBytes(32).toString("base64url")}`;
      const passwordHash = await bcrypt.hash(
        randomBytes(32).toString("hex"),
        12,
      );
      const created = await prisma.$transaction(async (tx) => {
        await tx.user.findFirstOrThrow({
          where: { id: ownerId, isActive: true, mustResetPassword: false },
          select: { id: true },
        });
        const agent = await tx.user.create({
          data: {
            email: `codex-${randomBytes(12).toString("hex")}@excalidash.invalid`,
            name: "Codex",
            passwordHash,
          },
          select: { id: true },
        });
        const collection = await tx.collection.create({
          data: { name: "Codex-Entwürfe", userId: agent.id },
          select: { id: true },
        });
        await tx.collectionShare.create({
          data: {
            collectionId: collection.id,
            granteeUserId: ownerId,
            createdByUserId: agent.id,
            role: "edit",
          },
        });
        return { userId: agent.id, draftCollectionId: collection.id };
      });
      const expiresAt = new Date(
        Date.now() + 365 * 24 * 60 * 60 * 1000,
      ).toISOString();
      console.log(
        JSON.stringify({
          token: secret,
          agent: {
            ...created,
            id: `codex-desktop-${created.userId}`,
            expiresAt,
            managedByUserId: ownerId,
            credential: { type: "token", sha256: sha256(secret) },
          },
        }),
      );
      return;
    } finally {
      await prisma.$disconnect();
    }
  }
  if (command === "approval-digest" && agentId && userId && requestPath) {
    const request = changeInput.parse(
      JSON.parse(await readFile(requestPath, "utf8")),
    );
    console.log(
      changeDigest(
        { id: id.parse(agentId), userId: id.parse(userId) },
        request,
      ),
    );
    return;
  }
  throw new Error(
    "Usage: node dist/mcp/admin.js token | validate <policy.json> | provision-desktop <owner-id> | approval-digest <agent-id> <user-id> <request.json>",
  );
}

void main().catch(() => {
  console.error(
    "MCP administration command failed. Check the command, IDs and request file.",
  );
  process.exitCode = 1;
});
