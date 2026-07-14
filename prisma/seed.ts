import { PrismaClient, TenantKind } from '@prisma/client';

/**
 * Seeds a minimal two-tenant world: the A-List consumer tenant and one anchor
 * venue, with a guest, a venue, and inventory — enough to exercise the booking
 * loop locally. Run: npm run prisma:seed
 */
const prisma = new PrismaClient();

async function main(): Promise<void> {
  const alist = await prisma.tenant.create({
    data: { name: 'A-List', kind: TenantKind.alist },
  });
  const anchor = await prisma.tenant.create({
    data: { name: 'Delilah (anchor)', kind: TenantKind.anchor },
  });

  const guest = await prisma.guest.create({
    data: {
      tenantId: alist.id,
      displayName: 'Jack',
      primaryPhone: '+15551234567',
      provisional: false,
    },
  });

  const venue = await prisma.venue.create({
    data: { tenantId: anchor.id, name: 'Delilah', city: 'Los Angeles' },
  });

  await prisma.inventory.createMany({
    data: [
      { tenantId: anchor.id, venueId: venue.id, kind: 'table', label: 'Booth 1', capacity: 6, minSpend: 2000, deposit: 500 },
      { tenantId: anchor.id, venueId: venue.id, kind: 'table', label: 'Booth 2', capacity: 4, minSpend: 1000, deposit: 250 },
      { tenantId: anchor.id, venueId: venue.id, kind: 'ticket', label: 'GA', capacity: 200, minSpend: 0, deposit: 0 },
    ],
  });

  await prisma.entity.createMany({
    data: [
      { kind: 'artist', name: 'Keinemusik' },
      { kind: 'artist', name: 'Black Coffee' },
      { kind: 'event', name: 'Afro House Fridays' },
    ],
  });

  console.log('Seeded:');
  console.log('  A-List tenant  :', alist.id);
  console.log('  Anchor tenant  :', anchor.id);
  console.log('  Guest (Jack)   :', guest.id);
  console.log('  Venue (Delilah):', venue.id);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
