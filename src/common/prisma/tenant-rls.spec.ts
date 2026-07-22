import { assertTenantId, runWithTenant } from './tenant-rls';

/**
 * Unit tests for the app-side RLS binding (migration 0008). No database: a
 * mocked PrismaService whose `$transaction` invokes the callback with a fake
 * `tx` that records `$executeRawUnsafe` calls, so we can assert the exact
 * `SET LOCAL` statement and the injection guard's behaviour.
 */
describe('tenant-rls (RLS binding)', () => {
  const TENANT = '11111111-2222-4333-8444-555555555555';

  function makePrisma() {
    const rawCalls: string[] = [];
    const tx: any = {
      $executeRawUnsafe: async (sql: string) => {
        rawCalls.push(sql);
        return 1;
      },
    };
    const prisma: any = {
      $transaction: async (fn: (t: any) => Promise<any>) => fn(tx),
    };
    return { prisma, rawCalls, tx };
  }

  describe('runWithTenant', () => {
    it('issues exactly one SET LOCAL binding the given tenant, and returns the callback result', async () => {
      const { prisma, rawCalls, tx } = makePrisma();

      const result = await runWithTenant(prisma, TENANT, async (t) => {
        expect(t).toBe(tx); // fn receives the transactional client
        return 'ok';
      });

      expect(result).toBe('ok');
      expect(rawCalls).toEqual([
        `SET LOCAL app.current_tenant = '${TENANT}'`,
      ]);
    });

    it('binds the tenant before running the callback body', async () => {
      const { prisma, rawCalls } = makePrisma();
      const order: string[] = [];

      await runWithTenant(prisma, TENANT, async (t) => {
        order.push('fn');
        await t.$executeRawUnsafe('SELECT 1');
        return undefined;
      });

      // SET LOCAL is the first raw statement, before anything fn runs.
      expect(rawCalls[0]).toBe(`SET LOCAL app.current_tenant = '${TENANT}'`);
      expect(order).toEqual(['fn']);
    });

    it('never opens a transaction or emits SQL when the tenant id is invalid', async () => {
      const { prisma, rawCalls } = makePrisma();
      let transactionOpened = false;
      prisma.$transaction = async (fn: any) => {
        transactionOpened = true;
        return fn({ $executeRawUnsafe: async () => 1 });
      };

      await expect(
        runWithTenant(prisma, "x'; DROP TABLE users", async () => 'nope'),
      ).rejects.toThrow(/Invalid tenantId/);

      expect(transactionOpened).toBe(false);
      expect(rawCalls).toEqual([]);
    });
  });

  describe('assertTenantId (injection guard)', () => {
    it('returns the id unchanged for a valid UUID', () => {
      expect(assertTenantId(TENANT)).toBe(TENANT);
    });

    it('throws on a SQL-injection attempt', () => {
      expect(() => assertTenantId("x'; DROP TABLE users; --")).toThrow(
        /Invalid tenantId/,
      );
    });

    it.each([
      ['empty string', ''],
      ['not a uuid', 'not-a-uuid'],
      ['uuid with trailing quote', `${'a'.repeat(8)}-0000-4000-8000-000000000000'`],
      ['uuid with embedded space', '11111111-2222-4333-8444-5555 5555555'],
      ['too short', '11111111-2222-4333-8444-5555555555'],
    ])('throws on %s', (_label, value) => {
      expect(() => assertTenantId(value as string)).toThrow(/Invalid tenantId/);
    });

    it('throws on non-string input', () => {
      expect(() => assertTenantId(undefined as any)).toThrow(/Invalid tenantId/);
      expect(() => assertTenantId(null as any)).toThrow(/Invalid tenantId/);
    });
  });
});
