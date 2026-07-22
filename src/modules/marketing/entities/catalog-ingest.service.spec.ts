import { NotFoundException } from '@nestjs/common';
import { CatalogIngestService } from './catalog-ingest.module';
import { EventsFeedAdapter } from '../../../integrations/eventsfeed.adapter';

/**
 * Catalog ingest invariants: dated stub slate lands in the catalog, re-runs
 * are idempotent (update, never duplicate), and competitor flagging is a
 * curated call on venues only.
 */
describe('CatalogIngestService', () => {
  function make(existing: any[] = []) {
    const rows: any[] = [...existing];
    const prisma: any = {
      entity: {
        findFirst: async ({ where }: any) => {
          if (where.externalRefs) {
            return (
              rows.find(
                (r) =>
                  r.kind === where.kind &&
                  r.externalRefs?.sourceId === where.externalRefs.equals,
              ) ?? null
            );
          }
          return (
            rows.find((r) => r.kind === where.kind && r.name === where.name) ??
            null
          );
        },
        findUnique: async ({ where }: any) =>
          rows.find((r) => r.id === where.id) ?? null,
        create: async ({ data }: any) => {
          const row = { id: `id${rows.length + 1}`, ...data };
          rows.push(row);
          return row;
        },
        update: async ({ where, data }: any) => {
          const row = rows.find((r) => r.id === where.id);
          Object.assign(row, data);
          return row;
        },
      },
    };
    const config: any = { get: () => undefined }; // no key → stub slate
    const feed = new EventsFeedAdapter(config);
    const svc = new CatalogIngestService(prisma, feed);
    return { svc, rows };
  }

  const ctx = { tenantId: 't1', scopes: [] } as any;

  it('ingests the stub slate: dated events + venues with source refs', async () => {
    const { svc, rows } = make();
    const res = await svc.ingest(ctx, { city: 'Miami' });
    expect(res.stub).toBe(true);
    expect(res.created).toBe(5); // 3 events + 2 venues
    const fest = rows.find((r) => r.name.includes('Sundown Festival'));
    expect(fest.kind).toBe('event');
    expect(typeof fest.metadata.date).toBe('string');
    expect(fest.metadata.genres).toContain('amapiano');
    expect(fest.externalRefs.sourceId).toBe('tm-ev-001');
  });

  it('re-running the same city updates instead of duplicating', async () => {
    const { svc, rows } = make();
    await svc.ingest(ctx, { city: 'Miami' });
    const countAfterFirst = rows.length;
    const res2 = await svc.ingest(ctx, { city: 'Miami' });
    expect(rows.length).toBe(countAfterFirst);
    expect(res2.created).toBe(0);
    expect(res2.updated).toBe(5);
  });

  it('matches pre-existing seed rows by kind+name and attaches source refs', async () => {
    const { svc, rows } = make([
      {
        id: 'seeded',
        kind: 'venue',
        name: 'Rival Rooftop',
        metadata: { competitor: true, openingDate: '2026-07-24' },
        externalRefs: null,
      },
    ]);
    await svc.ingest(ctx, { city: 'Miami' });
    const rival = rows.find((r) => r.id === 'seeded');
    expect(rival.externalRefs.sourceId).toBe('tm-vn-001');
    // curated competitor flag survives the sync
    expect(rival.metadata.competitor).toBe(true);
    expect(rival.metadata.openingDate).toBe('2026-07-24');
    expect(rows.filter((r) => r.name === 'Rival Rooftop')).toHaveLength(1);
  });

  it('markCompetitor is venue-only and stamps openingDate for grounding', async () => {
    const { svc, rows } = make();
    await svc.ingest(ctx, { city: 'Miami' });
    const venue = rows.find((r) => r.kind === 'venue');
    const res = await svc.markCompetitor(ctx, {
      entityId: venue.id,
      competitor: true,
      openingDate: '2026-08-01T22:00:00.000Z',
    });
    expect(res.competitor).toBe(true);
    expect(venue.metadata.competitor).toBe(true);
    expect(venue.metadata.openingDate).toBe('2026-08-01T22:00:00.000Z');
    const event = rows.find((r) => r.kind === 'event');
    await expect(
      svc.markCompetitor(ctx, { entityId: event.id, competitor: true }),
    ).rejects.toThrow(NotFoundException);
  });
});
