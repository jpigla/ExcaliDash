ALTER TABLE "Collection" ADD COLUMN "parentId" TEXT;

ALTER TABLE "Collection" ADD CONSTRAINT "Collection_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Collection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Collection_parentId_idx" ON "Collection"("parentId");
