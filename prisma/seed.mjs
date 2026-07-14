// Plain-JS seed runnable in the production image (uses @prisma/client, which is
// installed there; no ts-node needed). Fixed UUIDs so a live demo can address
// the rows without looking them up. Idempotent (upserts).
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const A = '00000000-0000-0000-0000-00000000a115'; // A-List tenant
const V = '00000000-0000-0000-0000-0000000a2c40'; // anchor (venue) tenant
const G = '00000000-0000-0000-0000-00000000ca57'; // guest (Jack)
const VEN = '00000000-0000-0000-0000-0000000de111'; // venue (Delilah)
const INV = '00000000-0000-0000-0000-000000015001'; // inventory (Booth 1)

async function main() {
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
  await prisma.guest.upsert({
    where: { id: G },
    update: {},
    create: {
      id: G,
      tenantId: A,
      displayName: 'Jack',
      primaryPhone: '+15551234567',
      provisional: false,
    },
  });
  await prisma.venue.upsert({
    where: { id: VEN },
    update: {},
    create: { id: VEN, tenantId: V, name: 'Delilah', city: 'Los Angeles' },
  });
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
      minSpend: 200000, // $2,000.00 in minor units (cents)
      deposit: 50000, //   $500.00 in minor units (cents)
    },
  });
  await prisma.entity.createMany({
    data: [
      { kind: 'artist', name: 'Keinemusik' },
      { kind: 'artist', name: 'Black Coffee' },
    ],
    skipDuplicates: true,
  });
  console.log('SEEDED', { alistTenant: A, anchorTenant: V, guest: G, venue: VEN });
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
