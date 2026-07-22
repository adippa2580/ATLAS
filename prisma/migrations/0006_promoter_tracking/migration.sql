-- Promoter tracking (W6 pull-forward): promoters on the attribution rails.
CREATE TABLE "Promoter" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contact" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Promoter_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Promoter_tenantId_idx" ON "Promoter"("tenantId");
ALTER TABLE "AttributionLink" ADD COLUMN "promoterId" TEXT;
CREATE INDEX "AttributionLink_tenantId_promoterId_idx" ON "AttributionLink"("tenantId", "promoterId");
ALTER TABLE "AttributionLink" ADD CONSTRAINT "AttributionLink_promoterId_fkey" FOREIGN KEY ("promoterId") REFERENCES "Promoter"("id") ON DELETE SET NULL ON UPDATE CASCADE;
