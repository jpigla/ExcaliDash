CREATE TABLE "McpBoardGrant" (
    "drawingId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "agentUserId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,

    CONSTRAINT "McpBoardGrant_pkey" PRIMARY KEY ("drawingId", "agentId"),
    CONSTRAINT "McpBoardGrant_drawingId_fkey" FOREIGN KEY ("drawingId") REFERENCES "Drawing" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "McpBoardGrant_agentId_agentUserId_ownerId_expiresAt_idx" ON "McpBoardGrant"("agentId", "agentUserId", "ownerId", "expiresAt");
