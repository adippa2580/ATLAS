import { BadRequestException } from '@nestjs/common';
import { RecommendationsService } from './recommendations.module';

/**
 * Grounded-recommendations invariants (GM review 2026-07-22): recs must name
 * the entity + date + matched audience; undated events are reported as
 * ungrounded, never narrated; actions execute real levers.
 */
describe('RecommendationsService', () => {
  const soon = new Date(Date.now() + 3 * 86_400_000).toISOString();

  function make(opts: {
    events?: any[];
    affinities?: any[];
    repeatBookings?: any[];
    dropCount?: number;
  }) {
    const created: Record<string, any[]> = { audiences: [], links: [] };
    const prisma: any = {
      entity: {
        findMany: async () => opts.events ?? [],
        findUnique: async ({ where }: any) =>
          (opts.events ?? []).find((e) => e.id === where.id) ?? null,
      },
      venue: { findFirst: async () => ({ id: 'v1', tenantId: 't1' }) },
      guestAffinity: { findMany: async () => opts.affinities ?? [] },
      booking: { findMany: async () => opts.repeatBookings ?? [] },
      inventory: { count: async () => opts.dropCount ?? 0 },
      audience: {
        create: async ({ data }: any) => {
          created.audiences.push(data);
          return { id: 'aud1', ...data };
        },
      },
      attributionLink: {
        create: async ({ data }: any) => {
          created.links.push(data);
          return data;
        },
      },
    };
    const klaviyo: any = {
      sendCampaign: jest.fn(async (n: number) => ({
        delivered: n,
        provider: 'klaviyo',
        stub: true,
      })),
    };
    const drops: any = {
      lateNightDrop: jest.fn(async () => ({
        tenantId: 't1',
        venueId: 'v1',
        created: [{ id: 'i9', label: 'Late Drop 1' }],
        skippedExisting: 0,
      })),
    };
    const svc = new RecommendationsService(prisma, klaviyo, drops);
    return { svc, created, klaviyo, drops };
  }

  const ctx = { tenantId: 't1', scopes: [] } as any;
  const festival = {
    id: 'e1',
    name: 'Sundown Festival — After Parties',
    kind: 'event',
    metadata: { date: soon, genres: ['afro house', 'amapiano'] },
  };

  it('grounds an event rec: name, date, matched + repeat counts, actions', async () => {
    const { svc } = make({
      events: [festival],
      affinities: [{ guestId: 'g1' }, { guestId: 'g2' }, { guestId: 'g1' }],
      repeatBookings: [{ guestId: 'g1' }],
    });
    const out = await svc.list(ctx, { venueId: 'v1' });
    const rec = out.recommendations.find((r) => r.kind === 'event_demand')!;
    expect(rec.headline).toContain('Sundown Festival');
    expect(rec.headline).toContain(soon.slice(0, 10));
    expect(rec.matched).toBe(2);
    expect(rec.repeatMatched).toBe(1);
    expect(rec.insight).toContain('2 consented guests');
    expect(rec.insight).toContain('1 are repeat guests');
    expect(rec.actions.map((a) => a.action)).toEqual([
      'promote_matched',
      'late_night_drop',
      'mint_link',
    ]);
  });

  it('reports undated events as ungrounded instead of recommending vibes', async () => {
    const { svc } = make({
      events: [{ id: 'e2', name: 'Mystery Rave', kind: 'event', metadata: {} }],
    });
    const out = await svc.list(ctx, {});
    expect(
      out.recommendations.some((r) => r.headline.includes('Mystery')),
    ).toBe(false);
    expect(out.ungrounded).toContain('Mystery Rave');
  });

  it('raises late-night fill only when no Late Drop inventory exists', async () => {
    const { svc } = make({ dropCount: 0 });
    const out = await svc.list(ctx, { venueId: 'v1' });
    expect(out.recommendations.some((r) => r.kind === 'late_night_fill')).toBe(
      true,
    );
    const { svc: svc2 } = make({ dropCount: 4 });
    const out2 = await svc2.list(ctx, { venueId: 'v1' });
    expect(out2.recommendations.some((r) => r.kind === 'late_night_fill')).toBe(
      false,
    );
  });

  it('promote_matched creates the audience and sends via the Klaviyo rail', async () => {
    const { svc, created, klaviyo } = make({
      events: [festival],
      affinities: [{ guestId: 'g1' }, { guestId: 'g2' }],
    });
    const res: any = await svc.act(ctx, {
      action: 'promote_matched',
      eventId: 'e1',
      venueId: 'v1',
    } as any);
    expect(created.audiences[0].name).toContain('Sundown Festival');
    expect(created.audiences[0].predicates.matchedGuestIds).toEqual([
      'g1',
      'g2',
    ]);
    expect(klaviyo.sendCampaign).toHaveBeenCalledWith(
      2,
      expect.objectContaining({ template: 'event_promo' }),
    );
    expect(res.matched).toBe(2);
  });

  it('refuses to promote to an empty audience', async () => {
    const { svc } = make({ events: [festival], affinities: [] });
    await expect(
      svc.act(ctx, { action: 'promote_matched', eventId: 'e1' } as any),
    ).rejects.toThrow(BadRequestException);
  });

  it('late_night_drop and mint_link execute their levers with event context', async () => {
    const { svc, created, drops } = make({ events: [festival] });
    const dropRes: any = await svc.act(ctx, {
      action: 'late_night_drop',
      eventId: 'e1',
    } as any);
    expect(drops.lateNightDrop).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({
        label: 'Late Drop · Sundown Festival — After Parties',
      }),
    );
    expect(dropRes.created).toHaveLength(1);
    const linkRes: any = await svc.act(ctx, {
      action: 'mint_link',
      eventId: 'e1',
    } as any);
    expect(linkRes.code).toHaveLength(12);
    expect(created.links[0].campaignId).toBe('event:e1');
  });

  const rival = {
    id: 'v-rival',
    name: 'Rival Rooftop',
    kind: 'venue',
    metadata: { competitor: true, openingDate: soon },
  };

  it('grounds a competitor opening with the exposed-regulars count', async () => {
    const { svc } = make({
      events: [rival],
      repeatBookings: [{ guestId: 'g1' }, { guestId: 'g2' }, { guestId: 'g1' }],
    });
    const out = await svc.list(ctx, { venueId: 'v1' });
    const rec = out.recommendations.find(
      (r) => r.kind === 'competitor_opening',
    )!;
    expect(rec.headline).toContain('Rival Rooftop opens');
    expect(rec.headline).toContain(soon.slice(0, 10));
    expect(rec.matched).toBe(2);
    expect(rec.insight).toContain('2 consented regulars');
    expect(rec.actions[0].action).toBe('defend_regulars');
  });

  it('reports a competitor venue without an openingDate as ungrounded', async () => {
    const { svc } = make({
      events: [
        {
          id: 'v2',
          name: 'Mystery Rival',
          kind: 'venue',
          metadata: { competitor: true },
        },
      ],
    });
    const out = await svc.list(ctx, {});
    expect(
      out.recommendations.some((r) => r.kind === 'competitor_opening'),
    ).toBe(false);
    expect(out.ungrounded).toContain('Mystery Rival');
  });

  it('defend_regulars builds the lock-in audience and sends via Klaviyo', async () => {
    const { svc, created, klaviyo } = make({
      events: [rival],
      repeatBookings: [{ guestId: 'g1' }, { guestId: 'g2' }],
    });
    const res: any = await svc.act(ctx, {
      action: 'defend_regulars',
      eventId: 'v-rival',
      venueId: 'v1',
    } as any);
    expect(created.audiences[0].predicates.defensive).toBe(true);
    expect(created.audiences[0].predicates.matchedGuestIds).toEqual([
      'g1',
      'g2',
    ]);
    expect(klaviyo.sendCampaign).toHaveBeenCalledWith(
      2,
      expect.objectContaining({
        template: 'regulars_lock_in',
        rival: 'Rival Rooftop',
      }),
    );
    expect(res.matched).toBe(2);
  });
});
