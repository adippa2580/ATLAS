-- P0 hardening migration.
-- 1) Crew tenant-scoping (close the cross-tenant IDOR): add tenantId to
--    CrewMember/CrewAffinity, backfilled from the parent Crew, plus a Crew->Tenant FK.
-- 2) Money -> integer minor units (cents): convert Float dollar columns, preserving
--    value via *100. (Demo data is small; a real prod cutover would backfill/verify.)
-- 3) Idempotency: unique keys on Booking/Payment, a unique stripePiId, and a shared
--    IdempotencyRecord ledger.

-- ---------------------------------------------------------------------------
-- 1) Crew tenant-scoping
-- ---------------------------------------------------------------------------
ALTER TABLE "CrewMember" ADD COLUMN "tenantId" TEXT;
UPDATE "CrewMember" cm SET "tenantId" = c."tenantId" FROM "Crew" c WHERE c."id" = cm."crewId";
ALTER TABLE "CrewMember" ALTER COLUMN "tenantId" SET NOT NULL;

ALTER TABLE "CrewAffinity" ADD COLUMN "tenantId" TEXT;
UPDATE "CrewAffinity" ca SET "tenantId" = c."tenantId" FROM "Crew" c WHERE c."id" = ca."crewId";
ALTER TABLE "CrewAffinity" ALTER COLUMN "tenantId" SET NOT NULL;

-- Replace the crew-only unique with a tenant-scoped one.
DROP INDEX "CrewAffinity_crewId_subjectType_subjectRef_key";
CREATE UNIQUE INDEX "CrewAffinity_tenantId_crewId_subjectType_subjectRef_key" ON "CrewAffinity"("tenantId", "crewId", "subjectType", "subjectRef");
CREATE INDEX "CrewMember_tenantId_crewId_idx" ON "CrewMember"("tenantId", "crewId");
CREATE INDEX "CrewAffinity_tenantId_crewId_idx" ON "CrewAffinity"("tenantId", "crewId");

ALTER TABLE "Crew" ADD CONSTRAINT "Crew_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 2) Money -> integer minor units (cents). Preserve value: dollars * 100.
-- ---------------------------------------------------------------------------
ALTER TABLE "Inventory"
  ALTER COLUMN "minSpend" SET DATA TYPE INTEGER USING round("minSpend" * 100)::integer,
  ALTER COLUMN "deposit"  SET DATA TYPE INTEGER USING round("deposit"  * 100)::integer;

ALTER TABLE "Payment"
  ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'usd',
  ALTER COLUMN "amount" SET DATA TYPE INTEGER USING round("amount" * 100)::integer;

ALTER TABLE "Tab"
  ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'usd',
  ALTER COLUMN "total" SET DATA TYPE INTEGER USING round("total" * 100)::integer,
  ALTER COLUMN "total" SET DEFAULT 0;

ALTER TABLE "UsageEvent"
  ALTER COLUMN "billableAmount" SET DATA TYPE INTEGER USING round("billableAmount" * 100)::integer,
  ALTER COLUMN "billableAmount" SET DEFAULT 0;

-- ---------------------------------------------------------------------------
-- 3) Idempotency + webhook lookup keys
-- ---------------------------------------------------------------------------
ALTER TABLE "Booking" ADD COLUMN "idempotencyKey" TEXT;

CREATE TABLE "IdempotencyRecord" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "statusCode" INTEGER,
    "response" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "IdempotencyRecord_tenantId_createdAt_idx" ON "IdempotencyRecord"("tenantId", "createdAt");
CREATE UNIQUE INDEX "IdempotencyRecord_tenantId_key_key" ON "IdempotencyRecord"("tenantId", "key");
CREATE UNIQUE INDEX "Booking_tenantId_idempotencyKey_key" ON "Booking"("tenantId", "idempotencyKey");
CREATE UNIQUE INDEX "Payment_stripePiId_key" ON "Payment"("stripePiId");
CREATE UNIQUE INDEX "Payment_tenantId_idempotencyKey_key" ON "Payment"("tenantId", "idempotencyKey");
