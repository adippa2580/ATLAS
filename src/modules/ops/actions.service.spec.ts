import { BadRequestException } from '@nestjs/common';
import { ActionsService } from './actions.module';

/**
 * Operator action lifecycle: proposed → approved → executed → measured with
 * timestamps at each step; illegal transitions are rejected.
 */
describe('ActionsService lifecycle', () => {
  const ctx = { tenantId: 't1', scopes: [] } as any;

  function make() {
    let row: any = null;
    const prisma: any = {
      operatorAction: {
        create: async ({ data }: any) => {
          row = { id: 'a1', status: 'proposed', ...data };
          return row;
        },
        findFirst: async () => row,
        update: async ({ data }: any) => {
          row = { ...row, ...data };
          return row;
        },
      },
    };
    return new ActionsService(prisma);
  }

  it('walks the happy path and records the outcome', async () => {
    const svc = make();
    const proposed: any = await svc.propose(ctx, {
      actionType: 'attach_prompt',
      venueId: 'v1',
      expectedImpact: { revenueCents: 40000 },
      confidence: 0.7,
      source: 'rules',
    } as any);
    expect(proposed.status ?? 'proposed').toBe('proposed');

    const approved: any = await svc.approve(ctx, 'a1');
    expect(approved.status).toBe('approved');
    expect(approved.decidedAt).toBeInstanceOf(Date);

    const executed: any = await svc.execute(ctx, 'a1');
    expect(executed.status).toBe('executed');
    expect(executed.executedAt).toBeInstanceOf(Date);

    const measured: any = await svc.measure(ctx, 'a1', {
      outcome: { revenueCents: 52000 },
    } as any);
    expect(measured.status).toBe('measured');
    expect(measured.outcome).toEqual({ revenueCents: 52000 });
    expect(measured.measuredAt).toBeInstanceOf(Date);
  });

  it('rejects illegal transitions (measured is terminal)', async () => {
    const svc = make();
    await svc.propose(ctx, { actionType: 'x' } as any);
    await svc.approve(ctx, 'a1');
    await svc.execute(ctx, 'a1');
    await svc.measure(ctx, 'a1', { outcome: {} } as any);
    await expect(svc.approve(ctx, 'a1')).rejects.toThrow(BadRequestException);
  });

  it('rejects executing an unapproved action', async () => {
    const svc = make();
    await svc.propose(ctx, { actionType: 'x' } as any);
    await expect(svc.execute(ctx, 'a1')).rejects.toThrow(BadRequestException);
  });
});
