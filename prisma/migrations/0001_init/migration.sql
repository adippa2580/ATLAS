-- CreateEnum
CREATE TYPE "TenantKind" AS ENUM ('anchor', 'venue', 'alist');

-- CreateEnum
CREATE TYPE "IdentityLinkKind" AS ENUM ('phone', 'email', 'card_fingerprint', 'spotify_id', 'instagram_id', 'wallet');

-- CreateEnum
CREATE TYPE "ConsentBasis" AS ENUM ('connector_oauth', 'checkout_terms', 'explicit', 'tenant_dpa');

-- CreateEnum
CREATE TYPE "SubjectType" AS ENUM ('artist', 'genre', 'venue', 'event', 'crew', 'table');

-- CreateEnum
CREATE TYPE "Signal" AS ENUM ('follow', 'listen', 'book', 'attend', 'spend', 'mute', 'loyalty');

-- CreateEnum
CREATE TYPE "Provenance" AS ENUM ('connector', 'booking', 'venue_link', 'pos', 'agent');

-- CreateEnum
CREATE TYPE "EntitlementKind" AS ENUM ('perk', 'ticket', 'loyalty_credit');

-- CreateEnum
CREATE TYPE "InventoryKind" AS ENUM ('table', 'ticket');

-- CreateEnum
CREATE TYPE "BookingStatus" AS ENUM ('held', 'confirmed', 'seated', 'closed', 'cancelled');

-- CreateEnum
CREATE TYPE "EntityKind" AS ENUM ('artist', 'event', 'venue');

-- CreateTable
CREATE TABLE "Tenant" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "TenantKind" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Guest" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "primaryPhone" TEXT,
    "email" TEXT,
    "displayName" TEXT,
    "provisional" BOOLEAN NOT NULL DEFAULT true,
    "walletPassId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Guest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdentityLink" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "guestId" TEXT NOT NULL,
    "kind" "IdentityLinkKind" NOT NULL,
    "valueHash" TEXT NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdentityLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdentityMergeLog" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "survivingId" TEXT NOT NULL,
    "absorbedId" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdentityMergeLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConsentGrant" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "guestId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "basis" "ConsentBasis" NOT NULL,
    "connector" TEXT,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "ConsentGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AffinityEvidence" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "guestId" TEXT NOT NULL,
    "subjectType" "SubjectType" NOT NULL,
    "subjectRef" TEXT NOT NULL,
    "signal" "Signal" NOT NULL,
    "weight" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "provenance" "Provenance" NOT NULL,
    "consentId" TEXT,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dedupeKey" TEXT NOT NULL,

    CONSTRAINT "AffinityEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GuestAffinity" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "guestId" TEXT NOT NULL,
    "subjectType" "SubjectType" NOT NULL,
    "subjectRef" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "muted" BOOLEAN NOT NULL DEFAULT false,
    "decayedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GuestAffinity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Crew" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT,
    "ownerGuestId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Crew_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrewMember" (
    "crewId" TEXT NOT NULL,
    "guestId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',

    CONSTRAINT "CrewMember_pkey" PRIMARY KEY ("crewId","guestId")
);

-- CreateTable
CREATE TABLE "CrewAffinity" (
    "id" TEXT NOT NULL,
    "crewId" TEXT NOT NULL,
    "subjectType" "SubjectType" NOT NULL,
    "subjectRef" TEXT NOT NULL,
    "blendedScore" DOUBLE PRECISION NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,

    CONSTRAINT "CrewAffinity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Entitlement" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "guestId" TEXT NOT NULL,
    "kind" "EntitlementKind" NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'active',
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Entitlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrustEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "guestId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "weight" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrustEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Venue" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "city" TEXT,
    "floorMapRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Venue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Inventory" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "kind" "InventoryKind" NOT NULL,
    "label" TEXT,
    "capacity" INTEGER NOT NULL DEFAULT 1,
    "minSpend" DOUBLE PRECISION,
    "deposit" DOUBLE PRECISION,

    CONSTRAINT "Inventory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Booking" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "guestId" TEXT NOT NULL,
    "crewId" TEXT,
    "inventoryId" TEXT,
    "status" "BookingStatus" NOT NULL DEFAULT 'held',
    "date" TIMESTAMP(3) NOT NULL,
    "partySize" INTEGER NOT NULL DEFAULT 1,
    "attributionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Booking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "stripePiId" TEXT,
    "amount" DOUBLE PRECISION NOT NULL,
    "splitGroupId" TEXT,
    "payerGuestId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Tab" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "total" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "lineItems" JSONB,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Tab_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Entity" (
    "id" TEXT NOT NULL,
    "kind" "EntityKind" NOT NULL,
    "name" TEXT NOT NULL,
    "externalRefs" JSONB,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Entity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttributionLink" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "venueId" TEXT,
    "campaignId" TEXT,
    "code" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttributionLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Audience" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "predicates" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Audience_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "audienceId" TEXT,
    "channel" TEXT NOT NULL DEFAULT 'klaviyo',
    "status" TEXT NOT NULL DEFAULT 'queued',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "billableAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsageEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Guest_walletPassId_key" ON "Guest"("walletPassId");

-- CreateIndex
CREATE INDEX "Guest_tenantId_idx" ON "Guest"("tenantId");

-- CreateIndex
CREATE INDEX "Guest_tenantId_primaryPhone_idx" ON "Guest"("tenantId", "primaryPhone");

-- CreateIndex
CREATE INDEX "Guest_tenantId_email_idx" ON "Guest"("tenantId", "email");

-- CreateIndex
CREATE INDEX "IdentityLink_tenantId_guestId_idx" ON "IdentityLink"("tenantId", "guestId");

-- CreateIndex
CREATE UNIQUE INDEX "IdentityLink_tenantId_kind_valueHash_key" ON "IdentityLink"("tenantId", "kind", "valueHash");

-- CreateIndex
CREATE INDEX "IdentityMergeLog_tenantId_survivingId_idx" ON "IdentityMergeLog"("tenantId", "survivingId");

-- CreateIndex
CREATE INDEX "ConsentGrant_tenantId_guestId_idx" ON "ConsentGrant"("tenantId", "guestId");

-- CreateIndex
CREATE INDEX "AffinityEvidence_tenantId_guestId_idx" ON "AffinityEvidence"("tenantId", "guestId");

-- CreateIndex
CREATE INDEX "AffinityEvidence_tenantId_subjectType_subjectRef_idx" ON "AffinityEvidence"("tenantId", "subjectType", "subjectRef");

-- CreateIndex
CREATE UNIQUE INDEX "AffinityEvidence_tenantId_dedupeKey_key" ON "AffinityEvidence"("tenantId", "dedupeKey");

-- CreateIndex
CREATE INDEX "GuestAffinity_tenantId_guestId_idx" ON "GuestAffinity"("tenantId", "guestId");

-- CreateIndex
CREATE UNIQUE INDEX "GuestAffinity_tenantId_guestId_subjectType_subjectRef_key" ON "GuestAffinity"("tenantId", "guestId", "subjectType", "subjectRef");

-- CreateIndex
CREATE INDEX "Crew_tenantId_idx" ON "Crew"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "CrewAffinity_crewId_subjectType_subjectRef_key" ON "CrewAffinity"("crewId", "subjectType", "subjectRef");

-- CreateIndex
CREATE INDEX "Entitlement_tenantId_guestId_idx" ON "Entitlement"("tenantId", "guestId");

-- CreateIndex
CREATE INDEX "TrustEvent_tenantId_guestId_idx" ON "TrustEvent"("tenantId", "guestId");

-- CreateIndex
CREATE INDEX "Venue_tenantId_idx" ON "Venue"("tenantId");

-- CreateIndex
CREATE INDEX "Inventory_tenantId_venueId_idx" ON "Inventory"("tenantId", "venueId");

-- CreateIndex
CREATE INDEX "Booking_tenantId_venueId_idx" ON "Booking"("tenantId", "venueId");

-- CreateIndex
CREATE INDEX "Booking_tenantId_guestId_idx" ON "Booking"("tenantId", "guestId");

-- CreateIndex
CREATE INDEX "Payment_tenantId_bookingId_idx" ON "Payment"("tenantId", "bookingId");

-- CreateIndex
CREATE UNIQUE INDEX "Tab_bookingId_key" ON "Tab"("bookingId");

-- CreateIndex
CREATE INDEX "Entity_kind_idx" ON "Entity"("kind");

-- CreateIndex
CREATE UNIQUE INDEX "AttributionLink_code_key" ON "AttributionLink"("code");

-- CreateIndex
CREATE INDEX "AttributionLink_tenantId_idx" ON "AttributionLink"("tenantId");

-- CreateIndex
CREATE INDEX "Audience_tenantId_idx" ON "Audience"("tenantId");

-- CreateIndex
CREATE INDEX "Campaign_tenantId_idx" ON "Campaign"("tenantId");

-- CreateIndex
CREATE INDEX "UsageEvent_tenantId_kind_idx" ON "UsageEvent"("tenantId", "kind");

-- AddForeignKey
ALTER TABLE "Guest" ADD CONSTRAINT "Guest_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdentityLink" ADD CONSTRAINT "IdentityLink_guestId_fkey" FOREIGN KEY ("guestId") REFERENCES "Guest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsentGrant" ADD CONSTRAINT "ConsentGrant_guestId_fkey" FOREIGN KEY ("guestId") REFERENCES "Guest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AffinityEvidence" ADD CONSTRAINT "AffinityEvidence_guestId_fkey" FOREIGN KEY ("guestId") REFERENCES "Guest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AffinityEvidence" ADD CONSTRAINT "AffinityEvidence_consentId_fkey" FOREIGN KEY ("consentId") REFERENCES "ConsentGrant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuestAffinity" ADD CONSTRAINT "GuestAffinity_guestId_fkey" FOREIGN KEY ("guestId") REFERENCES "Guest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrewMember" ADD CONSTRAINT "CrewMember_crewId_fkey" FOREIGN KEY ("crewId") REFERENCES "Crew"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrewMember" ADD CONSTRAINT "CrewMember_guestId_fkey" FOREIGN KEY ("guestId") REFERENCES "Guest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrewAffinity" ADD CONSTRAINT "CrewAffinity_crewId_fkey" FOREIGN KEY ("crewId") REFERENCES "Crew"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Entitlement" ADD CONSTRAINT "Entitlement_guestId_fkey" FOREIGN KEY ("guestId") REFERENCES "Guest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Venue" ADD CONSTRAINT "Venue_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Inventory" ADD CONSTRAINT "Inventory_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_guestId_fkey" FOREIGN KEY ("guestId") REFERENCES "Guest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_crewId_fkey" FOREIGN KEY ("crewId") REFERENCES "Crew"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_inventoryId_fkey" FOREIGN KEY ("inventoryId") REFERENCES "Inventory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tab" ADD CONSTRAINT "Tab_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

