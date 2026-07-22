import { NotFoundException } from '@nestjs/common';
import {
  DEFAULT_DROP_COUNT,
  DEFAULT_MIN_SPEND,
  DEFAULT_DEPOSIT,
  DEFAULT_CAPACITY,
  InventoryDropService,
} from './inventory-drop.module';

/**
 * Release late-night after-party inventory (#drop) — drops a batch of
 * late-night "Late Drop {n}" table slots for a venue, idempotently.
 */
describe('InventoryDropService', () => {
  const ctx = { tenantId: 't1', scopes: [] } as any;

  function make(opts: {
    venue?: any; // venue returned by findFirst (default valid)
    existing?: { label: string | null }[]; // rows already present for the venue
  }) {
    const created: any[] = [];
    let seq = 0;
    const prisma: any = {
      venue: {
        findFirst: async ({ where }: any) => {
          if (opts.venue !== undefined) return opts.venue;
          // Default: venue exists and matches the tenant scope.
          return where.id === 'v1' && where.tenantId === 't1'
            ? { id: 'v1', tenantId: 't1', name: 'Club X' }
            : null;
        },
      },
      inventory: {
        findMany: async ({ where }: any) => {
          const rows = opts.existing ?? [];
          const wanted: string[] = where.label?.in ?? [];
          return rows.filter(
            (r) => r.label != null && wanted.includes(r.label),
          );
        },
        create: async ({ data }: any) => {
          seq += 1;
          const row = { id: `inv${seq}`, ...data };
          created.push(row);
          return row;
        },
      },
    };
    return { svc: new InventoryDropService(prisma), created };
  }

  it('rejects a venue that does not belong to the tenant', async () => {
    const { svc, created } = make({ venue: null });
    await expect(svc.lateNightDrop(ctx, { venueId: 'nope' })).rejects.toThrow(
      NotFoundException,
    );
    expect(created).toHaveLength(0);
  });

  it('creates N late-night table rows with numbered "Late Drop {n}" labels', async () => {
    const { svc, created } = make({});
    const res = await svc.lateNightDrop(ctx, { venueId: 'v1' });

    expect(res.tenantId).toBe('t1');
    expect(res.venueId).toBe('v1');
    expect(res.skippedExisting).toBe(0);
    expect(res.created).toHaveLength(DEFAULT_DROP_COUNT);
    expect(created).toHaveLength(DEFAULT_DROP_COUNT);

    // Every created row is a tenant-scoped, late-night table with drop defaults.
    for (const row of created) {
      expect(row.tenantId).toBe('t1');
      expect(row.venueId).toBe('v1');
      expect(row.kind).toBe('table');
      expect(row.label).toMatch(/^Late Drop \d+$/);
      expect(row.minSpend).toBe(DEFAULT_MIN_SPEND);
      expect(row.deposit).toBe(DEFAULT_DEPOSIT);
      expect(row.capacity).toBe(DEFAULT_CAPACITY);
    }
    expect(res.created.map((c) => c.label)).toEqual([
      'Late Drop 1',
      'Late Drop 2',
      'Late Drop 3',
      'Late Drop 4',
    ]);
  });

  it('honours count, custom label prefix, and money/capacity overrides', async () => {
    const { svc, created } = make({});
    const res = await svc.lateNightDrop(ctx, {
      venueId: 'v1',
      label: 'After Party',
      count: 2,
      minSpend: 300_000,
      deposit: 50_000,
      capacity: 10,
    });

    expect(res.created).toHaveLength(2);
    expect(res.created.map((c) => c.label)).toEqual([
      'After Party 1',
      'After Party 2',
    ]);
    expect(created[0].minSpend).toBe(300_000);
    expect(created[0].deposit).toBe(50_000);
    expect(created[0].capacity).toBe(10);
  });

  it('is idempotent: a second run skips already-present labels (no duplicates)', async () => {
    // "Late Drop 1" and "Late Drop 2" already exist from a prior drop.
    const { svc, created } = make({
      existing: [{ label: 'Late Drop 1' }, { label: 'Late Drop 2' }],
    });
    const res = await svc.lateNightDrop(ctx, { venueId: 'v1', count: 4 });

    expect(res.skippedExisting).toBe(2);
    expect(res.created).toHaveLength(2);
    expect(res.created.map((c) => c.label)).toEqual([
      'Late Drop 3',
      'Late Drop 4',
    ]);
    // Only the two missing rows were actually written.
    expect(created).toHaveLength(2);
    expect(created.map((c) => c.label)).toEqual(['Late Drop 3', 'Late Drop 4']);
  });

  it('creates nothing when the entire batch already exists', async () => {
    const { svc, created } = make({
      existing: [
        { label: 'Late Drop 1' },
        { label: 'Late Drop 2' },
        { label: 'Late Drop 3' },
        { label: 'Late Drop 4' },
      ],
    });
    const res = await svc.lateNightDrop(ctx, { venueId: 'v1' });

    expect(res.created).toHaveLength(0);
    expect(res.skippedExisting).toBe(DEFAULT_DROP_COUNT);
    expect(created).toHaveLength(0);
  });
});
