import { CrewEngageService } from './crew-engage.module';

/**
 * Crew engagement levers. Add-a-member resolves-or-creates a guest and attaches
 * them idempotently; the group offer templatizes the crew's blended affinity and
 * size. Both are tenant-scoped and hand-rolled against a prisma stub.
 */
describe('CrewEngageService', () => {
  const ctx = { tenantId: 't1', scopes: [] } as any;

  describe('addMember', () => {
    it('creates a provisional guest for unresolved contact and adds them (added:true)', async () => {
      const created: any[] = [];
      const identity: any = {
        create: jest.fn(async (_c: any, dto: any) => ({
          id: 'gNew',
          provisional: dto.provisional,
          primaryPhone: dto.primaryPhone ?? null,
          email: dto.email ?? null,
          displayName: dto.displayName ?? null,
        })),
      };
      const prisma: any = {
        crew: { findUnique: async () => ({ id: 'crew1', tenantId: 't1' }) },
        guest: { findFirst: async () => null },
        identityLink: { findFirst: async () => null },
        crewMember: {
          findUnique: async () => null,
          create: jest.fn(async ({ data }: any) => {
            created.push(data);
            return data;
          }),
        },
      };
      const svc = new CrewEngageService(prisma, identity);

      const res = await svc.addMember(ctx, 'crew1', {
        phone: '+13105550123',
        displayName: 'Ada',
      });

      expect(identity.create).toHaveBeenCalledWith(
        ctx,
        expect.objectContaining({ provisional: true, displayName: 'Ada' }),
      );
      expect(res).toEqual({
        crewId: 'crew1',
        guestId: 'gNew',
        added: true,
        alreadyMember: false,
      });
      expect(prisma.crewMember.create).toHaveBeenCalledTimes(1);
      expect(created[0]).toEqual(
        expect.objectContaining({
          tenantId: 't1',
          crewId: 'crew1',
          guestId: 'gNew',
        }),
      );
    });

    it('resolves an existing guest by id and does not create a new one', async () => {
      const identity: any = { create: jest.fn() };
      const prisma: any = {
        crew: { findUnique: async () => ({ id: 'crew1', tenantId: 't1' }) },
        guest: {
          findFirst: async ({ where }: any) =>
            where.id === 'gExisting' ? { id: 'gExisting' } : null,
        },
        identityLink: { findFirst: async () => null },
        crewMember: {
          findUnique: async () => null,
          create: jest.fn(async ({ data }: any) => data),
        },
      };
      const svc = new CrewEngageService(prisma, identity);

      const res = await svc.addMember(ctx, 'crew1', { guestId: 'gExisting' });

      expect(identity.create).not.toHaveBeenCalled();
      expect(res.guestId).toBe('gExisting');
      expect(res.added).toBe(true);
    });

    it('is idempotent: re-adding an existing member is a no-op (alreadyMember:true, no dup)', async () => {
      const identity: any = { create: jest.fn() };
      const prisma: any = {
        crew: { findUnique: async () => ({ id: 'crew1', tenantId: 't1' }) },
        guest: { findFirst: async () => ({ id: 'gExisting' }) },
        identityLink: { findFirst: async () => null },
        crewMember: {
          findUnique: async () => ({ crewId: 'crew1', guestId: 'gExisting' }),
          create: jest.fn(async ({ data }: any) => data),
        },
      };
      const svc = new CrewEngageService(prisma, identity);

      const res = await svc.addMember(ctx, 'crew1', { guestId: 'gExisting' });

      expect(res).toEqual({
        crewId: 'crew1',
        guestId: 'gExisting',
        added: false,
        alreadyMember: true,
      });
      expect(prisma.crewMember.create).not.toHaveBeenCalled();
    });

    it('rejects a crew in another tenant', async () => {
      const identity: any = { create: jest.fn() };
      const prisma: any = {
        crew: { findUnique: async () => ({ id: 'crew1', tenantId: 'other' }) },
      };
      const svc = new CrewEngageService(prisma, identity);
      await expect(
        svc.addMember(ctx, 'crew1', { guestId: 'g1' }),
      ).rejects.toThrow('Crew not found for tenant');
    });
  });

  describe('groupOffer', () => {
    it('returns top crew subjects and member count with a templatized offer', async () => {
      const identity: any = {};
      const prisma: any = {
        crew: {
          findUnique: async () => ({
            id: 'crew1',
            tenantId: 't1',
            name: 'The Regulars',
          }),
        },
        crewMember: { count: async () => 4 },
        crewAffinity: {
          findMany: async () => [
            {
              subjectType: 'artist',
              subjectRef: 'Fred again',
              blendedScore: 9.2,
            },
            {
              subjectType: 'venue',
              subjectRef: 'The Basement',
              blendedScore: 7.1,
            },
          ],
        },
      };
      const svc = new CrewEngageService(prisma, identity);

      const res = await svc.groupOffer(ctx, 'crew1');

      expect(res.crewId).toBe('crew1');
      expect(res.memberCount).toBe(4);
      expect(res.topSubjects).toEqual([
        { subjectType: 'artist', subjectRef: 'Fred again', blendedScore: 9.2 },
        { subjectType: 'venue', subjectRef: 'The Basement', blendedScore: 7.1 },
      ]);
      expect(res.template.headline).toContain('Fred again');
      // Per-head framing is a size fraction, never an invented cents amount.
      expect(res.template.perHeadFraming).toContain('1/4');
      expect(res.template.perHeadFraming).not.toMatch(/\$|cents/);
    });

    it('handles a crew with no blended affinity yet', async () => {
      const prisma: any = {
        crew: { findUnique: async () => ({ id: 'crew1', tenantId: 't1' }) },
        crewMember: { count: async () => 2 },
        crewAffinity: { findMany: async () => [] },
      };
      const svc = new CrewEngageService(prisma, {} as any);

      const res = await svc.groupOffer(ctx, 'crew1');

      expect(res.topSubjects).toEqual([]);
      expect(res.memberCount).toBe(2);
      expect(res.template.perHeadFraming).toContain('1/2');
    });
  });
});
