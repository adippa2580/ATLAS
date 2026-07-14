// Plain-JS seed runnable in the production image (uses @prisma/client, which is
// installed there; no ts-node needed). Fixed UUIDs so a live demo can address
// the rows without looking them up. Idempotent (upserts / skipDuplicates).
//
// The dataset is a single-city (Los Angeles) nightlife graph for the A-List
// tenant. Because every /insights and /talent endpoint is single-tenant (it
// joins taste, crew, ops and money purely by tenantId, never across tenants),
// ALL of the rich data below lives under the A-List tenant `A` and books into
// venue Delilah (DE111). Query the API with `X-Tenant-Id: <A>` to light it up.
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const A = '00000000-0000-0000-0000-00000000a115'; // A-List tenant
const V = '00000000-0000-0000-0000-0000000a2c40'; // anchor (venue) tenant
const G = '00000000-0000-0000-0000-00000000ca57'; // guest (Jack) — existing
const VEN = '00000000-0000-0000-0000-0000000de111'; // venue Delilah (tenant V)
const VEN_NG = '00000000-0000-0000-0000-0000000de222'; // venue The Nice Guy (tenant A)
const INV = '00000000-0000-0000-0000-000000015001'; // existing inventory (Booth 1, tenant V)

// Deterministic UUID minter: 2-char hex prefix + zero-padded counter.
const uid = (p, n) => `00000000-0000-0000-0000-${p}${String(n).padStart(12 - p.length, '0')}`;
const guest = (n) => uid('a1', n); // guests g1..g13
const inv = (n) => uid('a5', n); // inventory rows
const bkId = (n) => uid('b0', n); // bookings
const D = (s, h = 20) => new Date(`${s}T${String(h).padStart(2, '0')}:00:00.000Z`);

// Artist catalog Entity ids. GuestAffinity(subjectType=artist).subjectRef and
// TalentEngagement.entityId both reference these, so who-to-book / roi anti-join
// on a straight ref match.
const ART = {
  keinemusik: uid('a2', 1),
  blackCoffee: uid('a2', 2),
  peggyGou: uid('a2', 3),
  jamieJones: uid('a2', 4),
  blessedMadonna: uid('a2', 5),
  bedouin: uid('a2', 6),
};

async function main() {
  // -----------------------------------------------------------------------
  // Tenancy + venues (existing rows preserved).
  // -----------------------------------------------------------------------
  await prisma.tenant.upsert({
    where: { id: A },
    update: {},
    create: { id: A, name: 'A-List', kind: 'alist' },
  });
  await prisma.tenant.upsert({
    where: { id: V },
    update: {},
    create: { id: V, name: 'Delilah Group', kind: 'anchor' },
  });
  await prisma.venue.upsert({
    where: { id: VEN },
    update: {},
    create: { id: VEN, tenantId: V, name: 'Delilah', city: 'Los Angeles' },
  });
  // Second venue under the A-List tenant so cross-venue portability ranks >1 venue.
  await prisma.venue.upsert({
    where: { id: VEN_NG },
    update: {},
    create: { id: VEN_NG, tenantId: A, name: 'The Nice Guy', city: 'Los Angeles' },
  });

  // -----------------------------------------------------------------------
  // Inventory — tables under tenant A. minSpend/deposit vary so Insight F
  // (minspend-realization) surfaces underpriced / overpriced / balanced tables.
  // (Existing Booth 1 under tenant V is preserved but not part of the A demo.)
  // -----------------------------------------------------------------------
  await prisma.inventory.upsert({
    where: { id: INV },
    update: {},
    create: {
      id: INV,
      tenantId: V,
      venueId: VEN,
      kind: 'table',
      label: 'Booth 1',
      capacity: 6,
      minSpend: 200000,
      deposit: 50000,
    },
  });
  const INV_A1 = inv(1); // underpriced   ($2,000 min, tabs run ~$3,500+)
  const INV_A2 = inv(2); // overpriced    ($5,000 min, few tabs clear)
  const INV_A3 = inv(3); // balanced      ($1,500 min)
  const INV_A4 = inv(4); // balanced      ($3,000 min)
  const INV_A5 = inv(5); // no minSpend / no deposit (future-only, cold hold)
  const INV_NG1 = inv(9); // The Nice Guy table
  await prisma.inventory.createMany({
    skipDuplicates: true,
    data: [
      { id: INV_A1, tenantId: A, venueId: VEN, kind: 'table', label: 'Banquette A', capacity: 8, minSpend: 200000, deposit: 50000 },
      { id: INV_A2, tenantId: A, venueId: VEN, kind: 'table', label: 'Owner Booth', capacity: 10, minSpend: 500000, deposit: 100000 },
      { id: INV_A3, tenantId: A, venueId: VEN, kind: 'table', label: 'Bar Ledge C', capacity: 4, minSpend: 150000, deposit: 30000 },
      { id: INV_A4, tenantId: A, venueId: VEN, kind: 'table', label: 'Main Floor D', capacity: 6, minSpend: 300000, deposit: 75000 },
      { id: INV_A5, tenantId: A, venueId: VEN, kind: 'table', label: 'Standing GA', capacity: 12, minSpend: null, deposit: null },
      { id: INV_NG1, tenantId: A, venueId: VEN_NG, kind: 'table', label: 'NG Corner 1', capacity: 6, minSpend: 250000, deposit: 40000 },
    ],
  });

  // -----------------------------------------------------------------------
  // Artist catalog (global, no tenantId). Fixed ids => idempotent + referenced
  // by affinities and talent engagements.
  // -----------------------------------------------------------------------
  const artistRows = [
    [ART.keinemusik, 'Keinemusik'],
    [ART.blackCoffee, 'Black Coffee'],
    [ART.peggyGou, 'Peggy Gou'],
    [ART.jamieJones, 'Jamie Jones'],
    [ART.blessedMadonna, 'The Blessed Madonna'],
    [ART.bedouin, 'Bedouin'],
  ];
  for (const [id, name] of artistRows) {
    await prisma.entity.upsert({
      where: { id },
      update: {},
      create: { id, kind: 'artist', name },
    });
  }

  // -----------------------------------------------------------------------
  // Guests — ~14 total (Jack + 13). Whales, regulars, provisionals (dark
  // revenue) and a couple of thin/unmatched identities (match-rate < 100%).
  // -----------------------------------------------------------------------
  await prisma.guest.upsert({
    where: { id: G },
    update: {},
    create: { id: G, tenantId: A, displayName: 'Jack', primaryPhone: '+15551234567', provisional: false },
  });
  // [num, displayName, phone, email, provisional]
  const guestSpecs = [
    [1, 'Ava Sterling', '+13105550101', 'ava@example.com', false], // whale
    [2, 'Marcus Vale', '+13105550102', 'marcus@example.com', false], // whale
    [3, 'Nina Cortez', '+13105550103', 'nina@example.com', false], // whale
    [4, 'Theo Lang', '+13105550104', 'theo@example.com', false],
    [5, 'Priya Anand', '+13105550105', 'priya@example.com', false],
    [6, 'Diego Ruiz', '+13105550106', 'diego@example.com', false],
    [7, 'Sofia Klein', '+13105550107', 'sofia@example.com', false],
    [8, "Liam O'Brien", '+13105550108', 'liam@example.com', false],
    [9, 'Zara Osei', '+13105550109', 'zara@example.com', true], // provisional (revoked consent)
    [10, 'Owen Park', '+13105550110', 'owen@example.com', true], // provisional whale-ish, risky
    [11, 'Cash Walk-in', '+13105550111', null, true], // thin: unverified link only
    [12, 'Anon Guest', null, null, true], // thin: no links at all
    [13, 'Kai Mercer', '+13105550113', 'kai@example.com', false],
  ];
  await prisma.guest.createMany({
    skipDuplicates: true,
    data: guestSpecs.map(([n, displayName, primaryPhone, email, provisional]) => ({
      id: guest(n),
      tenantId: A,
      displayName,
      primaryPhone,
      email,
      provisional,
    })),
  });

  // -----------------------------------------------------------------------
  // Identity links (Insight B match-rate + per-kind coverage). Most guests have
  // verified phone+email; some also spotify/instagram; g11 has only an
  // unverified link and g12/Jack have none (thin) -> match-rate < 100%.
  // -----------------------------------------------------------------------
  const verifiedGuests = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 13];
  const linkRows = [];
  let linkN = 0;
  const pushLink = (n, kind, verified) =>
    linkRows.push({
      id: uid('b1', ++linkN),
      tenantId: A,
      guestId: guest(n),
      kind,
      valueHash: `h_${kind}_${n}`,
      verified,
      source: verified ? 'checkout' : 'unverified_capture',
    });
  for (const n of verifiedGuests) {
    pushLink(n, 'phone', true);
    pushLink(n, 'email', true);
  }
  pushLink(1, 'spotify_id', true);
  pushLink(1, 'instagram_id', true);
  pushLink(2, 'spotify_id', true);
  pushLink(13, 'spotify_id', true);
  pushLink(11, 'phone', false); // thin: unverified -> not matched
  await prisma.identityLink.createMany({ skipDuplicates: true, data: linkRows });

  // -----------------------------------------------------------------------
  // Consent ledger. Active for most; g9 REVOKED (exercises consent gating in
  // the reach-ceiling calc). Thin guests g11/g12 have none.
  // -----------------------------------------------------------------------
  const consentGuests = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 13];
  const consentByGuest = {};
  const consentRows = consentGuests.map((n) => {
    const id = uid('c1', n);
    consentByGuest[n] = id;
    return {
      id,
      tenantId: A,
      guestId: guest(n),
      scope: 'taste:read',
      basis: 'connector_oauth',
      connector: 'spotify',
      revokedAt: n === 9 ? D('2026-06-30', 12) : null,
    };
  });
  await prisma.consentGrant.createMany({ skipDuplicates: true, data: consentRows });

  // -----------------------------------------------------------------------
  // Taste graph — affinities (derived) + append-only evidence.
  // [guestNum, subjectType, subjectRef, score, muted]
  //   * Peggy Gou has the strongest summed demand AND no TalentEngagement, so
  //     /talent/who-to-book surfaces it top. Bedouin has one MUTED row.
  //   * product:* affinities feed the doorlist taste chips.
  // -----------------------------------------------------------------------
  const AFF = [
    // artists
    [1, 'artist', ART.peggyGou, 0.95, false],
    [2, 'artist', ART.peggyGou, 0.9, false],
    [3, 'artist', ART.peggyGou, 0.85, false],
    [4, 'artist', ART.peggyGou, 0.8, false],
    [5, 'artist', ART.peggyGou, 0.7, false],
    [6, 'artist', ART.peggyGou, 0.6, false],
    [1, 'artist', ART.keinemusik, 0.9, false],
    [2, 'artist', ART.keinemusik, 0.8, false],
    [4, 'artist', ART.keinemusik, 0.7, false],
    [7, 'artist', ART.keinemusik, 0.6, false],
    [3, 'artist', ART.blackCoffee, 0.85, false],
    [5, 'artist', ART.blackCoffee, 0.75, false],
    [8, 'artist', ART.blackCoffee, 0.65, false],
    [6, 'artist', ART.jamieJones, 0.7, false],
    [7, 'artist', ART.jamieJones, 0.65, false],
    [13, 'artist', ART.jamieJones, 0.5, false],
    [8, 'artist', ART.blessedMadonna, 0.55, false],
    [9, 'artist', ART.blessedMadonna, 0.4, false],
    [10, 'artist', ART.bedouin, 0.6, true], // MUTED — excluded from demand
    [5, 'artist', ART.bedouin, 0.5, false],
    // genres
    [1, 'genre', 'afro-house', 0.9, false],
    [2, 'genre', 'afro-house', 0.85, false],
    [3, 'genre', 'afro-house', 0.8, false],
    [5, 'genre', 'afro-house', 0.7, false],
    [4, 'genre', 'house', 0.7, false],
    [6, 'genre', 'house', 0.6, false],
    [7, 'genre', 'house', 0.55, false],
    [8, 'genre', 'techno', 0.5, false],
    [13, 'genre', 'techno', 0.45, false],
    [1, 'genre', 'melodic-house', 0.6, false],
    [9, 'genre', 'melodic-house', 0.5, false],
    // venue (doorlist chips)
    [1, 'venue', VEN, 0.9, false],
    [2, 'venue', VEN, 0.85, false],
    [3, 'venue', VEN, 0.8, false],
    // product mix taste
    [1, 'product', 'product:dom-perignon', 0.9, false],
    [1, 'product', 'product:espresso-martini', 0.7, false],
    [2, 'product', 'product:don-julio', 0.8, false],
    [3, 'product', 'product:ace-of-spades', 0.85, false],
    [5, 'product', 'product:casamigos', 0.6, false],
  ];
  await prisma.guestAffinity.createMany({
    skipDuplicates: true,
    data: AFF.map(([g, subjectType, subjectRef, score, muted], i) => ({
      id: uid('f1', i + 1),
      tenantId: A,
      guestId: guest(g),
      subjectType,
      subjectRef,
      score,
      muted,
    })),
  });
  // One evidence row per affinity (the only write path into the taste graph).
  const signalFor = { artist: 'listen', genre: 'listen', venue: 'attend', product: 'spend' };
  const provFor = { artist: 'connector', genre: 'connector', venue: 'booking', product: 'pos' };
  await prisma.affinityEvidence.createMany({
    skipDuplicates: true,
    data: AFF.map(([g, subjectType, subjectRef, score], i) => ({
      id: uid('e1', i + 1),
      tenantId: A,
      guestId: guest(g),
      subjectType,
      subjectRef,
      signal: signalFor[subjectType],
      weight: score,
      provenance: provFor[subjectType],
      consentId: consentByGuest[g] ?? null,
      dedupeKey: `${g}:${subjectType}:${subjectRef}`,
    })),
  });

  // -----------------------------------------------------------------------
  // Crew graph (Insight C super-connectors). Crew 1 is the big connector: 7
  // members and the most crew-anchored bookings; its members also hold solo
  // bookings. Every crew row carries tenantId.
  // -----------------------------------------------------------------------
  const CREW1 = uid('ce', 1);
  const CREW2 = uid('ce', 2);
  const CREW3 = uid('ce', 3);
  const CREW4 = uid('ce', 4);
  await prisma.crew.createMany({
    skipDuplicates: true,
    data: [
      { id: CREW1, tenantId: A, name: 'The Sterling Set', ownerGuestId: guest(1) },
      { id: CREW2, tenantId: A, name: 'Vale Vipers', ownerGuestId: guest(2) },
      { id: CREW3, tenantId: A, name: 'Cortez Circle', ownerGuestId: guest(3) },
      { id: CREW4, tenantId: A, name: 'The Duo', ownerGuestId: guest(4) },
    ],
  });
  const crewMembership = [
    [CREW1, [1, 2, 3, 4, 5, 6, 7]],
    [CREW2, [2, 8, 9]],
    [CREW3, [3, 10, 13]],
    [CREW4, [4, 5]],
  ];
  const crewMemberRows = [];
  for (const [crewId, members] of crewMembership) {
    for (const [idx, n] of members.entries()) {
      crewMemberRows.push({
        tenantId: A,
        crewId,
        guestId: guest(n),
        role: idx === 0 ? 'owner' : 'member',
      });
    }
  }
  await prisma.crewMember.createMany({ skipDuplicates: true, data: crewMemberRows });
  await prisma.crewAffinity.createMany({
    skipDuplicates: true,
    data: [
      { id: uid('ca', 1), tenantId: A, crewId: CREW1, subjectType: 'artist', subjectRef: ART.peggyGou, blendedScore: 0.85, confidence: 0.7 },
      { id: uid('ca', 2), tenantId: A, crewId: CREW1, subjectType: 'artist', subjectRef: ART.jamieJones, blendedScore: 0.6, confidence: 0.6 },
      { id: uid('ca', 3), tenantId: A, crewId: CREW1, subjectType: 'genre', subjectRef: 'afro-house', blendedScore: 0.7, confidence: 0.6 },
      { id: uid('ca', 4), tenantId: A, crewId: CREW2, subjectType: 'artist', subjectRef: ART.peggyGou, blendedScore: 0.55, confidence: 0.5 },
    ],
  });

  // -----------------------------------------------------------------------
  // Attribution / campaigns / audiences (Insight G attribution-ltv). Three
  // channels; some bookings carry attributionId -> AttributionLink -> Campaign.
  // -----------------------------------------------------------------------
  const AUD1 = uid('ad', 1);
  const AUD2 = uid('ad', 2);
  await prisma.audience.createMany({
    skipDuplicates: true,
    data: [
      { id: AUD1, tenantId: A, name: 'Afro-House Whales', predicates: { genre: 'afro-house', minLifetimeSpendCents: 500000 } },
      { id: AUD2, tenantId: A, name: 'Lapsing VIPs', predicates: { daysSinceLastVisit: { gte: 60 } } },
    ],
  });
  const CAMP_IG = uid('cb', 1);
  const CAMP_KL = uid('cb', 2);
  const CAMP_SMS = uid('cb', 3);
  await prisma.campaign.createMany({
    skipDuplicates: true,
    data: [
      { id: CAMP_IG, tenantId: A, audienceId: AUD1, channel: 'instagram', status: 'sent' },
      { id: CAMP_KL, tenantId: A, audienceId: AUD1, channel: 'klaviyo', status: 'sent' },
      { id: CAMP_SMS, tenantId: A, audienceId: AUD2, channel: 'sms', status: 'sent' },
    ],
  });
  const AL_IG = uid('a4', 1);
  const AL_KL = uid('a4', 2);
  const AL_SMS = uid('a4', 3);
  await prisma.attributionLink.createMany({
    skipDuplicates: true,
    data: [
      { id: AL_IG, tenantId: A, venueId: VEN, campaignId: CAMP_IG, code: 'IG-SUMMER26' },
      { id: AL_KL, tenantId: A, venueId: VEN, campaignId: CAMP_KL, code: 'VIP-EMAIL' },
      { id: AL_SMS, tenantId: A, venueId: VEN, campaignId: CAMP_SMS, code: 'SMS-FLASH' },
    ],
  });

  // -----------------------------------------------------------------------
  // Bookings + Tabs + Payments. Closed bookings span past Fridays/Saturdays
  // (talent ROI baseline), plus future holds (no-show / doorlist) and cancels.
  // n = booking counter -> stable id via bkId(n). Tab.lineItems drive
  // product-mix + min-spend realization; totals vary vs each table's minSpend.
  // -----------------------------------------------------------------------
  // [n, guestNum, venue, inventory, totalCents, dateStr, partySize, crewId|null, attributionId|null, lineItems]
  const closed = [
    [1, 4, VEN, INV_A1, 380000, '2026-05-01', 4, null, AL_SMS, [['Casamigos Blanco', 180000], ['Espresso Martini', 120000], ['Modelo', 80000]]],
    [2, 5, VEN, INV_A2, 300000, '2026-05-08', 4, CREW4, AL_KL, [['Whispering Angel Rosé', 150000], ['Grey Goose', 100000], ['Red Bull', 50000]]],
    [3, 6, VEN, INV_A4, 320000, '2026-05-22', 5, null, null, [['Veuve Clicquot', 200000], ['Casamigos Blanco', 120000]]],
    [4, 8, VEN, INV_A2, 250000, '2026-06-05', 6, CREW2, null, [['Grey Goose', 150000], ['Corona', 100000]]],
    [5, 1, VEN, INV_A1, 420000, '2026-05-15', 6, CREW1, AL_IG, [['Dom Pérignon 2013', 300000], ['Espresso Martini', 120000]]],
    [6, 2, VEN, INV_A4, 480000, '2026-05-15', 6, CREW1, AL_IG, [['Dom Pérignon 2013', 300000], ['Don Julio 1942', 180000]]],
    [7, 3, VEN, INV_A2, 520000, '2026-05-15', 8, CREW1, AL_KL, [['Ace of Spades', 400000], ['Casamigos Blanco', 120000]]],
    [8, 7, VEN, INV_A1, 350000, '2026-05-30', 4, null, null, [['Veuve Clicquot', 200000], ['Espresso Martini', 150000]]],
    [9, 5, VEN, INV_A3, 160000, '2026-06-06', 3, null, null, [['Espresso Martini', 90000], ['Modelo', 70000]]],
    [10, 6, VEN, INV_A3, 140000, '2026-06-20', 2, null, null, [['Margarita', 80000], ['Corona', 60000]]],
    [11, 1, VEN, INV_A4, 300000, '2026-06-13', 5, CREW1, null, [['Casamigos Blanco', 180000], ['Red Bull', 120000]]],
    [12, 3, VEN, INV_A2, 300000, '2026-06-13', 6, CREW3, null, [['Don Julio 1942', 180000], ['Espresso Martini', 120000]]],
    [13, 1, VEN_NG, INV_NG1, 300000, '2026-05-10', 5, CREW1, null, [['Grey Goose', 180000], ['Espresso Martini', 120000]]],
    [14, 2, VEN_NG, INV_NG1, 280000, '2026-05-17', 4, null, null, [['Whispering Angel Rosé', 160000], ['Corona', 120000]]],
    [15, 3, VEN_NG, INV_NG1, 260000, '2026-05-24', 4, null, null, [['Casamigos Blanco', 160000], ['Modelo', 100000]]],
  ];
  // [n, guestNum, venue, inventory, dateStr, partySize, status, createdAtStr]
  const future = [
    [16, 1, VEN, INV_A1, '2026-07-17', 6, 'confirmed', '2026-07-16'], // safe whale, deposit -> low risk / doorlist
    [17, 10, VEN, INV_A2, '2026-07-17', 10, 'held', '2026-06-01'], // provisional + no-shows + cold long lead -> high risk
    [18, 9, VEN, INV_A4, '2026-07-17', 4, 'confirmed', '2026-07-08'], // provisional, revoked consent
    [19, 11, VEN, INV_A5, '2026-07-17', 8, 'held', '2026-06-25'], // thin, no deposit table -> elevated risk
    [20, 2, VEN, INV_A1, '2026-07-17', 8, 'seated', '2026-07-12'], // whale, seated -> doorlist
  ];
  // [n, guestNum, venue, inventory, dateStr, partySize, createdAtStr]
  const cancelled = [
    [21, 10, VEN, INV_A2, '2026-06-05', 8, '2026-05-20'],
    [22, 11, VEN, INV_A3, '2026-05-22', 4, '2026-05-01'],
    [23, 10, VEN, INV_A1, '2026-06-06', 6, '2026-05-25'],
  ];

  const bookingRows = [];
  const tabRows = [];
  const paymentRows = [];
  let payN = 0;
  const pushPayment = (bookingId, amount, guestNum, splitGroupId = null) => {
    payN += 1;
    paymentRows.push({
      id: uid('ba', payN),
      tenantId: A,
      bookingId,
      stripePiId: `pi_seed_${payN}`,
      amount,
      currency: 'usd',
      splitGroupId,
      payerGuestId: guest(guestNum),
      status: 'succeeded',
      idempotencyKey: `pay_seed_${payN}`,
    });
  };

  for (const [n, g, venue, inventoryId, total, dateStr, party, crewId, attributionId, items] of closed) {
    const id = bkId(n);
    bookingRows.push({
      id,
      tenantId: A,
      venueId: venue,
      guestId: guest(g),
      crewId,
      inventoryId,
      status: 'closed',
      date: D(dateStr),
      partySize: party,
      attributionId,
      createdAt: new Date(D(dateStr).getTime() - 5 * 86400000),
    });
    tabRows.push({
      id: uid('ab', n),
      tenantId: A,
      bookingId: id,
      total,
      currency: 'usd',
      lineItems: items.map(([name, amount]) => ({ name, amount })),
      closedAt: new Date(D(dateStr).getTime() + 3 * 3600000),
    });
    // Payments: split groups on b5 (2-way) and b7 (3-way); otherwise single.
    if (n === 5) {
      pushPayment(id, 210000, 1, 'sg_b5');
      pushPayment(id, 210000, 2, 'sg_b5');
    } else if (n === 7) {
      pushPayment(id, 200000, 3, 'sg_b7');
      pushPayment(id, 200000, 1, 'sg_b7');
      pushPayment(id, 120000, 2, 'sg_b7');
    } else {
      pushPayment(id, total, g);
    }
  }
  for (const [n, g, venue, inventoryId, dateStr, party, status, createdAtStr] of future) {
    bookingRows.push({
      id: bkId(n),
      tenantId: A,
      venueId: venue,
      guestId: guest(g),
      inventoryId,
      status,
      date: D(dateStr),
      partySize: party,
      createdAt: D(createdAtStr, 12),
    });
  }
  for (const [n, g, venue, inventoryId, dateStr, party, createdAtStr] of cancelled) {
    bookingRows.push({
      id: bkId(n),
      tenantId: A,
      venueId: venue,
      guestId: guest(g),
      inventoryId,
      status: 'cancelled',
      date: D(dateStr),
      partySize: party,
      createdAt: D(createdAtStr, 12),
    });
  }
  await prisma.booking.createMany({ skipDuplicates: true, data: bookingRows });
  await prisma.tab.createMany({ skipDuplicates: true, data: tabRows });
  await prisma.payment.createMany({ skipDuplicates: true, data: paymentRows });

  // -----------------------------------------------------------------------
  // Trust ledger (Insight D no-show-risk). no_show erodes, positive builds.
  // -----------------------------------------------------------------------
  const trustSpecs = [
    [1, 'positive', 3],
    [2, 'positive', 2],
    [3, 'positive', 3],
    [4, 'positive', 2],
    [5, 'positive', 1],
    [7, 'positive', 2],
    [8, 'positive', 1],
    [13, 'positive', 1],
    [9, 'no_show', 2],
    [10, 'no_show', 2],
    [10, 'no_show', 1],
    [11, 'no_show', 1],
  ];
  await prisma.trustEvent.createMany({
    skipDuplicates: true,
    data: trustSpecs.map(([g, kind, weight], i) => ({
      id: uid('a7', i + 1),
      tenantId: A,
      guestId: guest(g),
      kind,
      weight,
    })),
  });

  // -----------------------------------------------------------------------
  // Entitlements (active perks / loyalty credits) — doorlist activeEntitlements.
  // -----------------------------------------------------------------------
  const entSpecs = [
    [1, 'perk'],
    [1, 'loyalty_credit'],
    [2, 'loyalty_credit'],
    [3, 'loyalty_credit'],
    [7, 'perk'],
  ];
  await prisma.entitlement.createMany({
    skipDuplicates: true,
    data: entSpecs.map(([g, kind], i) => ({
      id: uid('a6', i + 1),
      tenantId: A,
      guestId: guest(g),
      kind,
      state: 'active',
    })),
  });

  // -----------------------------------------------------------------------
  // Talent engagements (Insight I roi + who-to-book anti-join). Keinemusik &
  // Black Coffee are BOOKED (removed from who-to-book); Peggy Gou stays the top
  // unbooked demand. Fri 05-15 and Sat 06-13 have strong same-weekday lift; the
  // future 07-18 engagement has no revenue yet (unproven / negative lift).
  // -----------------------------------------------------------------------
  await prisma.talentEngagement.createMany({
    skipDuplicates: true,
    data: [
      { id: uid('a8', 1), tenantId: A, venueId: VEN, entityId: ART.keinemusik, date: D('2026-05-15'), cost: 500000, status: 'confirmed' },
      { id: uid('a8', 2), tenantId: A, venueId: VEN, entityId: ART.blackCoffee, date: D('2026-06-13'), cost: 400000, status: 'booked' },
      { id: uid('a8', 3), tenantId: A, venueId: VEN, entityId: ART.keinemusik, date: D('2026-07-18'), cost: 550000, status: 'booked' },
    ],
  });

  // -----------------------------------------------------------------------
  // Booking status transition ledger (realism / turn-timing).
  // -----------------------------------------------------------------------
  const statusSpecs = [
    [5, 'held', 'confirmed', 'deposit_paid'],
    [5, 'confirmed', 'seated', 'arrived'],
    [5, 'seated', 'closed', 'tab_settled'],
    [21, 'held', 'cancelled', 'guest_cancel'],
    [16, 'held', 'confirmed', 'deposit_paid'],
  ];
  await prisma.bookingStatusEvent.createMany({
    skipDuplicates: true,
    data: statusSpecs.map(([b, fromStatus, toStatus, reason], i) => ({
      id: uid('a9', i + 1),
      tenantId: A,
      bookingId: bkId(b),
      fromStatus,
      toStatus,
      reason,
    })),
  });

  console.log('SEEDED', {
    tenant: A,
    venues: [VEN, VEN_NG],
    guests: 1 + guestSpecs.length,
    identityLinks: linkRows.length,
    consents: consentRows.length,
    affinities: AFF.length,
    evidence: AFF.length,
    crews: 4,
    crewMembers: crewMemberRows.length,
    bookings: bookingRows.length,
    tabs: tabRows.length,
    payments: paymentRows.length,
    talentEngagements: 3,
    peggyGou: ART.peggyGou,
    hint: 'call the API with X-Tenant-Id set to the tenant above',
  });
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
