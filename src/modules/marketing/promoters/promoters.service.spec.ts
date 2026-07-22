import { NotFoundException } from '@nestjs/common';
import { PromotersService } from './promoters.module';

/** Promoter tracking: links on the attribution rails, per-person accounting. */
describe('PromotersService', () => {
  function make(opts: {
    promoter?: any;
    links?: any[];
    bookings?: any[];
    tabs?: any[];
    usage?: any[];
  }) {
    const created: any[] = [];
    const prisma: any = {
      promoter: {
        findFirst: async () => opts.promoter ?? null,
        findMany: async () => (opts.promoter ? [opts.promoter] : []),
        create: async ({ data }: any) => ({ id: 'p1', ...data }),
      },
      attributionLink: {
        findMany: async () => opts.links ?? [],
        create: async ({ data }: any) => {
          created.push(data);
          return { id: 'l-new', ...data };
        },
      },
      booking: { findMany: async () => opts.bookings ?? [] },
      tab: { findMany: async () => opts.tabs ?? [] },
      usageEvent: { findMany: async () => opts.usage ?? [] },
    };
    return { svc: new PromotersService(prisma), created };
  }

  const ctx = { tenantId: 't1', scopes: [] } as any;
  const promoter = { id: 'p1', tenantId: 't1', name: 'Maya', active: true };

  it('mints a link carrying the promoter id on the attribution rails', async () => {
    const { svc, created } = make({ promoter });
    const link = await svc.mintLink(ctx, 'p1', {
      venueId: 'v1',
      campaignId: 'jul-weekend',
    });
    expect(created[0].promoterId).toBe('p1');
    expect(created[0].venueId).toBe('v1');
    expect(link.code).toHaveLength(12);
  });

  it('404s minting for an unknown or inactive promoter', async () => {
    const { svc } = make({});
    await expect(svc.mintLink(ctx, 'nope', {})).rejects.toThrow(
      NotFoundException,
    );
  });

  it('aggregates the per-promoter funnel: bookings, seated, tab, metered take', async () => {
    const { svc } = make({
      promoter,
      links: [{ id: 'l1' }, { id: 'l2' }],
      bookings: [
        { id: 'b1', status: 'seated' },
        { id: 'b2', status: 'confirmed' },
      ],
      tabs: [{ total: 150_000 }, { total: 50_000 }],
      usage: [{ billableAmount: 15_000 }, { billableAmount: 5_000 }],
    });
    const s = await svc.stats(ctx, 'p1');
    expect(s.links).toBe(2);
    expect(s.bookings).toBe(2);
    expect(s.seated).toBe(1);
    expect(s.tabRevenue).toBe(200_000);
    expect(s.meteredTake).toBe(20_000);
  });

  it('returns zeroes for a promoter with no links yet', async () => {
    const { svc } = make({ promoter, links: [] });
    const s = await svc.stats(ctx, 'p1');
    expect(s.bookings).toBe(0);
    expect(s.tabRevenue).toBe(0);
  });
});
