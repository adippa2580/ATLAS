-- 0009 — Port of the 2026-07-23 Supabase design-spike deltas into the canonical
-- model: SplitGroup captain-guarantee funding state (a SEPARATE axis from
-- BookingStatus floor state), the EventOutlook rules-engine store, and the
-- OperatorAction action-outcome ledger.
--
-- Non-breaking notes:
--   * Payment.kind is added NOT NULL DEFAULT 'crew_share' — Postgres backfills
--     existing rows with the default; no rewrite of application reads needed.
--   * Payment.splitGroupId keeps NO foreign key: pre-existing rows carry
--     ad-hoc split-group UUIDs with no parent SplitGroup row, so a constraint
--     would break on existing data. Payments join SplitGroup by VALUE.

-- Enums ----------------------------------------------------------------------
CREATE TYPE "PaymentKind" AS ENUM ('captain_authorization', 'crew_share', 'captain_remainder', 'refund');
CREATE TYPE "FundingState" AS ENUM ('pending', 'authorized', 'partially_funded', 'funded', 'settled', 'expired');
CREATE TYPE "OperatorActionSource" AS ENUM ('rules', 'model', 'operator', 'agent');
CREATE TYPE "OperatorActionStatus" AS ENUM ('proposed', 'approved', 'rejected', 'executed', 'measured');

-- Payment.kind ---------------------------------------------------------------
ALTER TABLE "Payment" ADD COLUMN "kind" "PaymentKind" NOT NULL DEFAULT 'crew_share';

-- SplitGroup — the funding axis of a booking's split-pay ---------------------
CREATE TABLE "SplitGroup" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "captainGuestId" TEXT NOT NULL,
    "totalAmount" INTEGER NOT NULL,
    "fundedAmount" INTEGER NOT NULL DEFAULT 0,
    "state" "FundingState" NOT NULL DEFAULT 'pending',
    "fundingDeadlineAt" TIMESTAMP(3),
    "captainPiId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SplitGroup_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SplitGroup_tenantId_bookingId_idx" ON "SplitGroup"("tenantId", "bookingId");
CREATE INDEX "SplitGroup_tenantId_state_idx" ON "SplitGroup"("tenantId", "state");

-- SplitGroupEvent — append-only funding ledger (mirrors BookingStatusEvent) --
CREATE TABLE "SplitGroupEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "splitGroupId" TEXT NOT NULL,
    "fromState" "FundingState",
    "toState" "FundingState" NOT NULL,
    "reason" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SplitGroupEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SplitGroupEvent_tenantId_splitGroupId_idx" ON "SplitGroupEvent"("tenantId", "splitGroupId");
ALTER TABLE "SplitGroupEvent" ADD CONSTRAINT "SplitGroupEvent_splitGroupId_fkey"
    FOREIGN KEY ("splitGroupId") REFERENCES "SplitGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- EventOutlook — rules engine v1 store ---------------------------------------
CREATE TABLE "EventOutlook" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "factors" JSONB NOT NULL,
    "weightsVersion" TEXT NOT NULL DEFAULT 'v1-20/20/15/15/10/10/10',
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EventOutlook_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "EventOutlook_tenantId_venueId_date_key" ON "EventOutlook"("tenantId", "venueId", "date");
CREATE INDEX "EventOutlook_tenantId_venueId_idx" ON "EventOutlook"("tenantId", "venueId");

-- OperatorAction — action-outcome ledger -------------------------------------
CREATE TABLE "OperatorAction" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "venueId" TEXT,
    "actionType" TEXT NOT NULL,
    "target" JSONB,
    "reason" TEXT,
    "expectedImpact" JSONB,
    "confidence" DOUBLE PRECISION,
    "source" "OperatorActionSource" NOT NULL DEFAULT 'rules',
    "status" "OperatorActionStatus" NOT NULL DEFAULT 'proposed',
    "outcome" JSONB,
    "proposedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    "executedAt" TIMESTAMP(3),
    "measuredAt" TIMESTAMP(3),
    CONSTRAINT "OperatorAction_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "OperatorAction_tenantId_status_idx" ON "OperatorAction"("tenantId", "status");
CREATE INDEX "OperatorAction_tenantId_venueId_idx" ON "OperatorAction"("tenantId", "venueId");

-- Row-Level Security ----------------------------------------------------------
-- Re-run the 0008 tenant-isolation block (idempotent: DROP POLICY IF EXISTS)
-- so the new tenantId-carrying tables get the same policy.
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables tb
      ON tb.table_schema = c.table_schema
     AND tb.table_name = c.table_name
     AND tb.table_type = 'BASE TABLE'
    WHERE c.table_schema = 'public'
      AND c.column_name = 'tenantId'
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I '
      'USING (current_setting(''app.current_tenant'', true) IS NULL '
      '       OR "tenantId" = current_setting(''app.current_tenant'', true)) '
      'WITH CHECK (current_setting(''app.current_tenant'', true) IS NULL '
      '       OR "tenantId" = current_setting(''app.current_tenant'', true))',
      t);
  END LOOP;
END $$;
