-- Insights unlocks (additive; no backfill).
-- 1) product-grain taste: new SubjectType value 'product' so POS line items can
--    be fanned into the taste graph at SKU/category grain.
-- 2) BookingStatusEvent: append-only status-transition ledger (measured no-show /
--    cancel / turn timing).
-- 3) TalentEngagement: modeled artist booking + cost for exact talent ROI.

-- AlterEnum
ALTER TYPE "SubjectType" ADD VALUE 'product';

-- CreateTable
CREATE TABLE "BookingStatusEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "fromStatus" "BookingStatus",
    "toStatus" "BookingStatus" NOT NULL,
    "reason" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BookingStatusEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TalentEngagement" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "cost" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'booked',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TalentEngagement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BookingStatusEvent_tenantId_bookingId_idx" ON "BookingStatusEvent"("tenantId", "bookingId");

-- CreateIndex
CREATE INDEX "BookingStatusEvent_tenantId_at_idx" ON "BookingStatusEvent"("tenantId", "at");

-- CreateIndex
CREATE INDEX "TalentEngagement_tenantId_venueId_date_idx" ON "TalentEngagement"("tenantId", "venueId", "date");

-- CreateIndex
CREATE INDEX "TalentEngagement_tenantId_entityId_idx" ON "TalentEngagement"("tenantId", "entityId");
