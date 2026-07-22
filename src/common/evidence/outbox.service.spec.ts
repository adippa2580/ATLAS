import { OutboxRelayService } from './outbox.service';

/**
 * Unit test for the durable-outbox relay's core invariant (transactional-outbox
 * pattern): `drainOnce` forwards each unpublished row's payload onto the bus and
 * marks it published on success; a publish that throws leaves the row
 * unpublished and bumps its attempts, so the next drain retries it (at-least-once).
 * No database — Prisma and the bus are mocked.
 */
describe('OutboxRelayService (drain relay)', () => {
  function makeService(rows: any[], publishImpl?: (payload: any) => void) {
    const published: any[] = [];
    const updates: Array<{ id: string; data: any }> = [];

    const bus: any = {
      publish: jest.fn(async (payload: any) => {
        if (publishImpl) {
          publishImpl(payload);
        }
        published.push(payload);
      }),
    };

    const prisma: any = {
      evidenceOutbox: {
        findMany: jest.fn(async () => rows),
        update: jest.fn(async ({ where, data }: any) => {
          updates.push({ id: where.id, data });
          return { id: where.id, ...data };
        }),
      },
    };

    const svc = new OutboxRelayService(prisma, bus);
    return { svc, bus, prisma, published, updates };
  }

  it('publishes each unpublished row and marks it published', async () => {
    const rows = [
      { id: 'r1', payload: { tenantId: 't1', guestId: 'g1' }, attempts: 0 },
      { id: 'r2', payload: { tenantId: 't1', guestId: 'g2' }, attempts: 0 },
    ];
    const { svc, bus, published, updates } = makeService(rows);

    const summary = await svc.drainOnce();

    // Each payload was forwarded onto the bus, in order.
    expect(bus.publish).toHaveBeenCalledTimes(2);
    expect(published).toEqual([rows[0].payload, rows[1].payload]);

    // Both rows were stamped publishedAt (and nothing else).
    expect(updates).toHaveLength(2);
    expect(updates.map((u) => u.id)).toEqual(['r1', 'r2']);
    expect(updates.every((u) => u.data.publishedAt instanceof Date)).toBe(true);

    expect(summary).toEqual({ fetched: 2, published: 2, failed: 0 });
  });

  it('increments attempts and does NOT mark published when publish throws', async () => {
    const rows = [
      { id: 'ok', payload: { tenantId: 't1', guestId: 'g1' }, attempts: 0 },
      { id: 'bad', payload: { tenantId: 't1', guestId: 'g2' }, attempts: 2 },
    ];
    const { svc, updates } = makeService(rows, (payload) => {
      if (payload.guestId === 'g2') {
        throw new Error('bus down');
      }
    });

    const summary = await svc.drainOnce();

    const okUpdate = updates.find((u) => u.id === 'ok');
    const badUpdate = updates.find((u) => u.id === 'bad');

    // Successful row published, failed row retried via attempts increment.
    expect(okUpdate?.data.publishedAt).toBeInstanceOf(Date);
    expect(badUpdate?.data).toEqual({ attempts: { increment: 1 } });
    // The failed row is NOT stamped published, so it re-drains next cycle.
    expect(badUpdate?.data.publishedAt).toBeUndefined();

    expect(summary).toEqual({ fetched: 2, published: 1, failed: 1 });
  });
});
