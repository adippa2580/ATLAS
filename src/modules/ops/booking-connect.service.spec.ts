import { NotFoundException } from '@nestjs/common';
import { BookingConnectService } from './booking-connect.module';

/**
 * Prompt Spotify connect at booking. Hand-rolled prisma stub (closeout style).
 * Asserts the connector-gap computation: a guest with no connectors is prompted
 * for both (Spotify first), and an already-Spotify-consented guest is not.
 */
describe('BookingConnectService', () => {
  const ctx = { tenantId: 't1', scopes: [] } as any;

  function make(opts: { booking?: any; grants?: any[]; links?: any[] }) {
    const booking =
      opts.booking === undefined ? { id: 'b1', guestId: 'g1' } : opts.booking;
    const prisma: any = {
      booking: {
        findFirst: async ({ where }: any) => {
          // Enforce tenant scoping in the stub so a mismatch surfaces.
          if (!booking) return null;
          if (where.tenantId !== ctx.tenantId) return null;
          if (where.id !== booking.id) return null;
          return booking;
        },
      },
      consentGrant: {
        findMany: async ({ where }: any) => {
          expect(where.tenantId).toBe(ctx.tenantId);
          expect(where.revokedAt).toBeNull();
          return opts.grants ?? [];
        },
      },
      identityLink: {
        findMany: async ({ where }: any) => {
          expect(where.tenantId).toBe(ctx.tenantId);
          return opts.links ?? [];
        },
      },
    };
    return new BookingConnectService(prisma);
  }

  it('suggests spotify then instagram for a guest with no connectors', async () => {
    const svc = make({ grants: [], links: [] });
    const res = await svc.connectPrompt(ctx, 'b1');

    expect(res.bookingId).toBe('b1');
    expect(res.guestId).toBe('g1');
    expect(res.alreadyConnected).toEqual([]);
    expect(res.suggested.map((s) => s.connector)).toEqual([
      'spotify',
      'instagram',
    ]);
    expect(res.suggested[0].deepLink).toContain('guestId=g1');
    expect(res.eligible).toBe(true);
  });

  it('excludes spotify when the guest already has a live taste:spotify consent', async () => {
    const svc = make({
      grants: [{ scope: 'taste:spotify', connector: 'spotify' }],
      links: [],
    });
    const res = await svc.connectPrompt(ctx, 'b1');

    expect(res.alreadyConnected).toEqual(['spotify']);
    expect(res.suggested.map((s) => s.connector)).toEqual(['instagram']);
    expect(res.eligible).toBe(true);
  });

  it('treats a spotify_id identity link as already connected', async () => {
    const svc = make({
      grants: [],
      links: [{ kind: 'spotify_id' }],
    });
    const res = await svc.connectPrompt(ctx, 'b1');

    expect(res.alreadyConnected).toEqual(['spotify']);
    expect(res.suggested.map((s) => s.connector)).toEqual(['instagram']);
  });

  it('is not eligible once both connectors are consented', async () => {
    const svc = make({
      grants: [
        { scope: 'taste:spotify', connector: 'spotify' },
        { scope: 'taste:instagram', connector: 'instagram' },
      ],
      links: [],
    });
    const res = await svc.connectPrompt(ctx, 'b1');

    expect(res.suggested).toEqual([]);
    expect(res.alreadyConnected).toEqual(['spotify', 'instagram']);
    expect(res.eligible).toBe(false);
  });

  it('throws NotFound for a booking outside the tenant', async () => {
    const svc = make({ booking: null });
    await expect(svc.connectPrompt(ctx, 'missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
