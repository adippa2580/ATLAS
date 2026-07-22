import { TabService } from './tab.module';
import { LightspeedAdapter } from '../../integrations/lightspeed.adapter';
import { createHmac } from 'node:crypto';

/**
 * Lightspeed webhook → shared tab pipeline: signature gate, tab upsert, and
 * spend evidence publication (venue grain + product grain), mirroring Square.
 */
describe('TabService (Lightspeed webhook)', () => {
  const secret = 'ls-token';

  function make() {
    const upserts: any[] = [];
    const published: any[] = [];
    const prisma: any = {
      booking: {
        findUnique: async () => ({
          id: 'b1',
          tenantId: 't1',
          guestId: 'g1',
          venueId: 'v1',
        }),
      },
      tab: {
        upsert: async (arg: any) => {
          upserts.push(arg);
          return arg.create;
        },
      },
    };
    const bus: any = { publish: async (m: any) => published.push(m) };
    const square: any = {};
    const config: any = {
      get: (k: string) =>
        k === 'connectors.lightspeedWebhookSecret'
          ? secret
          : k === 'env'
            ? 'production'
            : undefined,
    };
    const lightspeed = new LightspeedAdapter(config);
    const svc = new TabService(prisma, bus, square, lightspeed);
    return { svc, upserts, published };
  }

  function sign(body: string) {
    return createHmac('sha256', secret).update(body, 'utf8').digest('hex');
  }

  it('rejects an unsigned or tampered webhook', async () => {
    const { svc, upserts } = make();
    const body = Buffer.from('{"bookingId":"b1","totalAmount":100}');
    expect(await svc.handleLightspeedWebhook(body, undefined)).toEqual({
      received: false,
    });
    expect(
      await svc.handleLightspeedWebhook(body, sign(body.toString() + 'x')),
    ).toEqual({ received: false });
    expect(upserts).toHaveLength(0);
  });

  it('ingests a signed K-Series tab: upsert + venue and product spend evidence', async () => {
    const { svc, upserts, published } = make();
    const body = Buffer.from(
      JSON.stringify({
        bookingId: 'b1',
        orderId: 'o7',
        totalAmount: 150000,
        items: [{ name: 'Champagne', amount: 150000 }],
        finalized: true,
      }),
    );
    const res = await svc.handleLightspeedWebhook(body, sign(body.toString()));
    expect(res).toMatchObject({ received: true, bookingId: 'b1' });
    expect(upserts[0].create.total).toBe(150000);
    expect(upserts[0].create.tenantId).toBe('t1');
    const grains = published.map((m) => m.subjectType);
    expect(grains).toContain('venue');
    expect(grains).toContain('product');
    expect(published.every((m) => m.provenance === 'pos')).toBe(true);
  });
});
