import { ConsentAuditService } from './consent-audit.module';

/**
 * Consent purpose-scope audit — read-only register over ConsentGrant. Tests use
 * a hand-rolled prisma stub (closeout.service.spec.ts style) returning a mix of
 * active, revoked and old grants, asserting grouping counts, stale flagging, and
 * unknown-scope 'review' flagging.
 */
describe('ConsentAuditService', () => {
  const NOW = new Date('2026-07-22T00:00:00.000Z');
  const daysAgo = (n: number) =>
    new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

  // A representative register:
  //  - profile:read / connector_oauth  → two guests, both fresh (ok)
  //  - taste:read  / explicit           → one guest, granted 500d ago (stale)
  //  - unknown scope                    → active, fresh, but not allow-listed (review)
  //  - a revoked grant                  → counted only in totals.revoked
  const grants = [
    {
      guestId: 'g1',
      scope: 'guest:profile:read',
      basis: 'connector_oauth',
      grantedAt: daysAgo(10),
      revokedAt: null,
    },
    {
      guestId: 'g2',
      scope: 'guest:profile:read',
      basis: 'connector_oauth',
      grantedAt: daysAgo(20),
      revokedAt: null,
    },
    {
      guestId: 'g3',
      scope: 'guest:taste:read',
      basis: 'explicit',
      grantedAt: daysAgo(500),
      revokedAt: null,
    },
    {
      guestId: 'g4',
      scope: 'legacy:sms:blast',
      basis: 'checkout_terms',
      grantedAt: daysAgo(5),
      revokedAt: null,
    },
    {
      guestId: 'g5',
      scope: 'guest:profile:read',
      basis: 'connector_oauth',
      grantedAt: daysAgo(15),
      revokedAt: daysAgo(1),
    },
  ];

  function make(rows: any[] = grants) {
    const seen: any[] = [];
    const prisma: any = {
      consentGrant: {
        findMany: async (args: any) => {
          seen.push(args);
          return rows.filter((r) => r.tenantId == null || true);
        },
      },
    };
    return { svc: new ConsentAuditService(prisma), prisma, seen };
  }

  const ctx = { tenantId: 't1', scopes: ['guest:consent:read'] } as any;

  it('scopes the query to the caller tenant and echoes the horizon', async () => {
    const { svc, seen } = make();
    const res = await svc.audit(ctx, 365);
    expect(seen[0].where).toEqual({ tenantId: 't1' });
    expect(res.tenantId).toBe('t1');
    expect(res.generatedForStaleDays).toBe(365);
  });

  it('groups active grants by scope+basis and counts distinct guests', async () => {
    const { svc } = make();
    const res = await svc.audit(ctx, 365);

    const profile = res.byScope.find((r) => r.scope === 'guest:profile:read')!;
    // g1 + g2 active (g5 is revoked, excluded from the register)
    expect(profile.activeGrants).toBe(2);
    expect(profile.distinctGuests).toBe(2);
    expect(profile.basis).toBe('connector_oauth');
    expect(profile.status).toBe('ok');
    expect(profile.staleGrants).toBe(0);
  });

  it("flags a grant older than the horizon as 'stale'", async () => {
    const { svc } = make();
    const res = await svc.audit(ctx, 365);

    const taste = res.byScope.find((r) => r.scope === 'guest:taste:read')!;
    expect(taste.staleGrants).toBe(1);
    expect(taste.status).toBe('stale');
  });

  it("flags an unknown (non-allow-listed) scope as 'review'", async () => {
    const { svc } = make();
    const res = await svc.audit(ctx, 365);

    const legacy = res.byScope.find((r) => r.scope === 'legacy:sms:blast')!;
    expect(legacy.status).toBe('review');
    expect(legacy.activeGrants).toBe(1);
  });

  it('summarizes totals across active, revoked, stale and review', async () => {
    const { svc } = make();
    const res = await svc.audit(ctx, 365);

    expect(res.totals.active).toBe(4); // g1,g2,g3,g4
    expect(res.totals.revoked).toBe(1); // g5
    expect(res.totals.stale).toBe(1); // g3
    expect(res.totals.needsReview).toBe(1); // legacy scope group
  });

  it('defaults staleDays to 365 when omitted', async () => {
    const { svc } = make();
    const res = await svc.audit(ctx);
    expect(res.generatedForStaleDays).toBe(365);
  });

  it('a shorter horizon can turn a previously-ok group stale', async () => {
    const { svc } = make();
    const res = await svc.audit(ctx, 15);
    // With a 15-day horizon, g2 (20d) is now stale; g1 (10d) is not.
    const profile = res.byScope.find((r) => r.scope === 'guest:profile:read')!;
    expect(profile.staleGrants).toBe(1);
    expect(profile.status).toBe('stale');
    expect(res.totals.stale).toBeGreaterThanOrEqual(2);
  });

  it('does not write to the register (read-only audit)', async () => {
    const { prisma } = make();
    // Only findMany is exposed; a write method would be a contract violation.
    expect(prisma.consentGrant.create).toBeUndefined();
    expect(prisma.consentGrant.update).toBeUndefined();
    expect(prisma.consentGrant.updateMany).toBeUndefined();
  });
});
