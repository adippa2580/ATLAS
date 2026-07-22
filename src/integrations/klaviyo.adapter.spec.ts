import { KlaviyoAdapter } from './klaviyo.adapter';

/**
 * Klaviyo rail: stub when no key; in live mode push one metric event per
 * contactable recipient to the Events API, count what got through, and never
 * throw (delivery is a side effect of a discovery action, not the action).
 */
describe('KlaviyoAdapter', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  function make(apiKey: string | undefined) {
    const config: any = {
      get: (k: string) =>
        k === 'connectors.klaviyoApiKey' ? (apiKey ?? '') : undefined,
    };
    return new KlaviyoAdapter(config);
  }

  it('stubs when no API key: reports audience size, never calls fetch', async () => {
    const spy = jest.fn();
    global.fetch = spy as any;
    const adapter = make(undefined);
    const res = await adapter.sendCampaign(7, { template: 'event_promo' }, [
      { email: 'a@b.com' },
    ]);
    expect(res).toEqual({ delivered: 7, provider: 'klaviyo', stub: true });
    expect(spy).not.toHaveBeenCalled();
  });

  it('toRecipients maps guest rows to profile keys with name property', () => {
    const recipients = KlaviyoAdapter.toRecipients(
      [
        {
          id: 'g1',
          email: 'g1@x.com',
          primaryPhone: '+15551234567',
          displayName: 'Ada',
        },
        { id: 'g2', email: null, primaryPhone: null, displayName: null },
      ],
      { audienceId: 'aud1' },
    );
    expect(recipients[0]).toEqual({
      email: 'g1@x.com',
      phone: '+15551234567',
      externalId: 'g1',
      properties: { audienceId: 'aud1', guestName: 'Ada' },
    });
    // No contact key but still carries externalId (Klaviyo can resolve by it).
    expect(recipients[1].externalId).toBe('g2');
    expect(recipients[1].email).toBeNull();
  });

  it('live mode posts one Events API request per recipient and counts delivered', async () => {
    const bodies: any[] = [];
    global.fetch = jest.fn(async (url: any, init: any) => {
      expect(String(url)).toBe('https://a.klaviyo.com/api/events/');
      expect(init.method).toBe('POST');
      expect(init.headers.Authorization).toBe('Klaviyo-API-Key sk-live');
      expect(init.headers.revision).toBeTruthy();
      bodies.push(JSON.parse(init.body));
      return { ok: true, status: 202 } as any;
    }) as any;

    const adapter = make('sk-live');
    const res = await adapter.sendCampaign(2, { template: 'event_promo' }, [
      { email: 'a@b.com', externalId: 'g1' },
      { phone: '+15550000000', externalId: 'g2' },
    ]);

    expect(res).toEqual({
      delivered: 2,
      provider: 'klaviyo',
      stub: false,
      skipped: 0,
    });
    expect(bodies).toHaveLength(2);
    // Metric name is derived from the template; profile carries the key(s).
    expect(bodies[0].data.attributes.metric.data.attributes.name).toBe(
      'Atlas Event Match',
    );
    expect(bodies[0].data.attributes.profile.data.attributes.email).toBe(
      'a@b.com',
    );
    expect(bodies[1].data.attributes.profile.data.attributes.phone_number).toBe(
      '+15550000000',
    );
  });

  it('live mode with no contactable recipients sends nothing and reports why', async () => {
    const spy = jest.fn();
    global.fetch = spy as any;
    const adapter = make('sk-live');
    const res = await adapter.sendCampaign(3, { template: 'event_promo' }, []);
    expect(res.delivered).toBe(0);
    expect(res.stub).toBe(false);
    expect(res.reason).toBe('no contactable recipients');
    expect(spy).not.toHaveBeenCalled();
  });

  it('live mode is fail-soft: a failed send is skipped, never thrown', async () => {
    let n = 0;
    global.fetch = jest.fn(async () => {
      n += 1;
      if (n === 1) throw new Error('network down');
      return { ok: false, status: 429 } as any; // rate-limited
    }) as any;

    const adapter = make('sk-live');
    const res = await adapter.sendCampaign(
      3,
      { template: 'lapsed_vip_winback' },
      [{ email: 'a@b.com' }, { email: 'b@b.com' }, { email: 'c@b.com' }],
    );
    // All three failed (one threw, two non-2xx) — delivered 0, all skipped, no throw.
    expect(res.delivered).toBe(0);
    expect(res.skipped).toBe(3);
    expect(res.stub).toBe(false);
  });

  it('falls back to a generic metric name for an unknown template', async () => {
    const bodies: any[] = [];
    global.fetch = jest.fn(async (_url: any, init: any) => {
      bodies.push(JSON.parse(init.body));
      return { ok: true, status: 202 } as any;
    }) as any;
    const adapter = make('sk-live');
    await adapter.sendCampaign(1, { template: 'something_new' }, [
      { email: 'a@b.com' },
    ]);
    expect(bodies[0].data.attributes.metric.data.attributes.name).toBe(
      'Atlas Signal',
    );
  });
});
