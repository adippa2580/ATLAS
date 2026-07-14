-- Insights unlocks (additive; no backfill).
-- BookingStatusEvent: append-only status-transition ledger (measured no-show /
--   cancel / turn timing).
-- TalentEngagement: modeled artist booking + cost for exact talent ROI.
--
-- NOTE: the SubjectType 'product' enum value is added separately in migration
-- 0004 — Postgres requires `ALTER TYPE ... ADD VALUE` to be the ONLY statement
-- in its migration (it cannot run in a multi-command string with CREATE TABLE).

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
