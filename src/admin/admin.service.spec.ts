import { AdminService } from './admin.module';

/**
 * Admin auth is security-critical: constant-time credential check, tamper-proof
 * HMAC session, fail-closed when unconfigured. Plus the taste-graph snapshot.
 */
describe('AdminService', () => {
  function make(
    cfg: Record<string, unknown> = {
      'admin.sessionSecret': 'super-secret',
      'admin.users': { adrian: 'pw-adrian', jack: 'pw-jack' },
    },
    prisma: any = {},
    catalog: any = {},
    recompute: any = { recomputeSubject: jest.fn(async () => undefined) },
  ) {
    const config: any = { get: (k: string) => cfg[k] };
    return new AdminService(config, prisma, catalog, recompute);
  }

  describe('configured', () => {
    it('true only with a session secret AND at least one user', () => {
      expect(make().configured).toBe(true);
      expect(
        make({ 'admin.sessionSecret': '', 'admin.users': { adrian: 'x' } })
          .configured,
      ).toBe(false);
      expect(
        make({ 'admin.sessionSecret': 's', 'admin.users': {} }).configured,
      ).toBe(false);
    });
  });

  describe('verifyCredentials', () => {
    it('accepts a correct username+password, rejects everything else', () => {
      const s = make();
      expect(s.verifyCredentials('adrian', 'pw-adrian')).toBe(true);
      expect(s.verifyCredentials('jack', 'pw-jack')).toBe(true);
      expect(s.verifyCredentials('adrian', 'wrong')).toBe(false);
      expect(s.verifyCredentials('adrian', '')).toBe(false);
      expect(s.verifyCredentials('mallory', 'pw-adrian')).toBe(false);
    });
  });

  describe('session', () => {
    it('round-trips a valid session to the username', () => {
      const s = make();
      const tok = s.issueSession('adrian', 1_000_000);
      expect(s.verifySession(tok, 1_000_100)).toBe('adrian');
    });

    it('rejects a tampered signature', () => {
      const s = make();
      const tok = s.issueSession('adrian', 1_000_000);
      const [payload] = tok.split('.');
      expect(s.verifySession(`${payload}.deadbeef`, 1_000_100)).toBeNull();
    });

    it('rejects a tampered payload (re-signed under a different secret fails)', () => {
      const forged = make({
        'admin.sessionSecret': 'attacker',
        'admin.users': {},
      }).issueSession('adrian', 1_000_000);
      // Verified against the real secret → signature mismatch → null.
      expect(make().verifySession(forged, 1_000_100)).toBeNull();
    });

    it('rejects an expired session', () => {
      const s = make();
      const tok = s.issueSession('adrian', 1_000_000); // exp = +8h
      expect(s.verifySession(tok, 1_000_000 + 9 * 3600)).toBeNull();
    });

    it('rejects malformed tokens and returns null when unconfigured', () => {
      const s = make();
      expect(s.verifySession('', 1)).toBeNull();
      expect(s.verifySession('nodot', 1)).toBeNull();
      const noSecret = make({ 'admin.sessionSecret': '', 'admin.users': {} });
      expect(noSecret.verifySession('a.b', 1)).toBeNull();
    });
  });

  describe('graph', () => {
    const prisma = {
      entity: {
        groupBy: async () => [
          { kind: 'artist', _count: { _all: 5 } },
          { kind: 'genre', _count: { _all: 3 } },
        ],
      },
      guest: { count: async () => 12 },
      consentGrant: { count: async () => 9 },
      crew: { count: async () => 2 },
      affinityEvidence: {
        count: async () => 40,
        findMany: async () => [
          {
            tenantId: 't1',
            guestId: 'g1',
            subjectType: 'artist',
            subjectRef: 'Keinemusik',
            signal: 'follow',
            provenance: 'connector',
            weight: 3,
            observedAt: '2026-07-23T10:00:00Z',
          },
        ],
      },
      guestAffinity: {
        count: async () => 25,
        findMany: async () => [
          { subjectType: 'artist', subjectRef: 'Keinemusik', score: 4 },
          { subjectType: 'artist', subjectRef: 'Keinemusik', score: 3 },
          { subjectType: 'artist', subjectRef: 'Rampa', score: 2 },
          { subjectType: 'genre', subjectRef: 'afro house', score: 5 },
        ],
      },
      tenant: {
        findMany: async () => [
          { id: 't1', name: 'A-List', kind: 'flagship' },
          { id: 't2', name: 'Delilah', kind: 'venue' },
        ],
        findUnique: async ({ where }: any) => ({ name: 'Tenant ' + where.id }),
      },
    };

    it('aggregates the graph: entity counts, totals, ranked top artists/genres', async () => {
      const s = make(undefined, prisma);
      const g = await s.graph();
      expect(g.entities).toEqual({ artist: 5, genre: 3 });
      expect(g.counts).toEqual({
        guests: 12,
        consents: 9,
        crews: 2,
        evidence: 40,
        affinities: 25,
      });
      // Keinemusik summed to 7 across two guests → ranks first.
      expect(g.topArtists[0]).toEqual({
        subjectType: 'artist',
        subjectRef: 'Keinemusik',
        score: 7,
        guests: 2,
      });
      expect(g.topGenres[0].subjectRef).toBe('afro house');
      expect(g.recentEvidence).toHaveLength(1);
      // Unscoped → aggregate label.
      expect(g.tenant).toBe('All tenants');
    });

    it('scopes to a tenant and labels it by name', async () => {
      const s = make(undefined, prisma);
      const g = await s.graph('t1');
      expect(g.tenant).toBe('Tenant t1');
    });

    it('lists tenants for the scope picker', async () => {
      const s = make(undefined, prisma);
      expect(await s.tenants()).toEqual([
        { id: 't1', name: 'A-List', kind: 'flagship' },
        { id: 't2', name: 'Delilah', kind: 'venue' },
      ]);
    });

    it('load ingests the catalog, recomputes affinities, then returns the graph', async () => {
      const catalog = { ingest: jest.fn(async () => ({ created: 4 })) };
      const recompute = { recomputeSubject: jest.fn(async () => undefined) };
      const s = make(undefined, prisma, catalog, recompute);
      const out = await s.load('Miami');
      expect(catalog.ingest).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: expect.any(String) }),
        { city: 'Miami' },
      );
      // One distinct evidence key → one recompute, with its real coordinates.
      expect(recompute.recomputeSubject).toHaveBeenCalledWith(
        't1',
        'g1',
        'artist',
        'Keinemusik',
      );
      expect(out.recomputed).toBe(1);
      expect(out.ingested).toEqual({ created: 4 });
      expect(out.graph.topArtists[0].subjectRef).toBe('Keinemusik');
    });
  });
});
