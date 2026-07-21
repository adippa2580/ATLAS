-- W7 take-rate dimensions on metering events (rates themselves stay config).
ALTER TABLE "UsageEvent" ADD COLUMN "path" TEXT;
ALTER TABLE "UsageEvent" ADD COLUMN "campaignId" TEXT;
ALTER TABLE "UsageEvent" ADD COLUMN "bookingId" TEXT;
CREATE INDEX "UsageEvent_tenantId_path_idx" ON "UsageEvent"("tenantId", "path");
