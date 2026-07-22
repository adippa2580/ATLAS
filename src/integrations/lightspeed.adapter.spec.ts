import { LightspeedAdapter } from './lightspeed.adapter';
import { createHmac } from 'node:crypto';

/** Lightspeed adapter: fail-closed webhook verification + tab normalisation. */
describe('LightspeedAdapter', () => {
  function make(cfg: Record<string, string | undefined>) {
    const config: any = { get: (k: string) => cfg[k] };
    return new LightspeedAdapter(config);
  }

  it('rejects webhooks in production when no secret is configured', () => {
    const a = make({ env: 'production' });
    expect(a.verifyWebhook('{}', 'sig')).toBe(false);
  });

  it('trusts webhooks in dev/stub mode with no secret', () => {
    const a = make({ env: 'development' });
    expect(a.verifyWebhook('{}', undefined)).toBe(true);
  });

  it('accepts a correctly signed body and rejects a tampered one', () => {
    const secret = 's3cret';
    const a = make({
      env: 'production',
      'connectors.lightspeedWebhookSecret': secret,
    });
    const body = '{"orderId":"o1","total":12345}';
    const sig = createHmac('sha256', secret).update(body, 'utf8').digest('hex');
    expect(a.verifyWebhook(body, sig)).toBe(true);
    expect(a.verifyWebhook(body + ' ', sig)).toBe(false);
  });

  it('normalises a K-Series-shaped body into integer-cent TabPayload', () => {
    const a = make({});
    const tab = a.normalizeTab({
      orderId: 'o9',
      totalAmount: 4200.4,
      items: [{ name: 'Booth min', amount: 4200.4 }],
      finalized: true,
    });
    expect(tab.externalTabId).toBe('o9');
    expect(tab.total).toBe(4200);
    expect(tab.lineItems[0].amount).toBe(4200);
    expect(tab.closed).toBe(true);
  });
});
