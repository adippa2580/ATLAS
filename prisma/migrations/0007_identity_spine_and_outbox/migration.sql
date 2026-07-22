-- AlterTable
ALTER TABLE "Guest" ADD COLUMN     "globalGuestId" TEXT;

-- CreateTable
CREATE TABLE "GlobalGuest" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GlobalGuest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VenueProjectionGrant" (
    "id" TEXT NOT NULL,
    "globalGuestId" TEXT NOT NULL,
    "granteeTenantId" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'affinity:summary',
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "VenueProjectionGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvidenceOutbox" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "topic" TEXT NOT NULL DEFAULT 'evidence',
    "payload" JSONB NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvidenceOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VenueProjectionGrant_granteeTenantId_idx" ON "VenueProjectionGrant"("granteeTenantId");

-- CreateIndex
CREATE INDEX "VenueProjectionGrant_globalGuestId_idx" ON "VenueProjectionGrant"("globalGuestId");

-- CreateIndex
CREATE UNIQUE INDEX "VenueProjectionGrant_globalGuestId_granteeTenantId_scope_key" ON "VenueProjectionGrant"("globalGuestId", "granteeTenantId", "scope");

-- CreateIndex
CREATE INDEX "EvidenceOutbox_publishedAt_createdAt_idx" ON "EvidenceOutbox"("publishedAt", "createdAt");

-- CreateIndex
CREATE INDEX "EvidenceOutbox_tenantId_idx" ON "EvidenceOutbox"("tenantId");

-- CreateIndex
CREATE INDEX "Guest_globalGuestId_idx" ON "Guest"("globalGuestId");

-- AddForeignKey
ALTER TABLE "Guest" ADD CONSTRAINT "Guest_globalGuestId_fkey" FOREIGN KEY ("globalGuestId") REFERENCES "GlobalGuest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VenueProjectionGrant" ADD CONSTRAINT "VenueProjectionGrant_globalGuestId_fkey" FOREIGN KEY ("globalGuestId") REFERENCES "GlobalGuest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

