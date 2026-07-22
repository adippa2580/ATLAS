import { SoundcloudAdapter } from './soundcloud.adapter';

/** SoundCloud taste connector: stub library + OAuth authorize/exchange shape. */
describe('SoundcloudAdapter', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  function make(cfg: Record<string, string | undefined>) {
    const config: any = { get: (k: string) => cfg[k] };
    return new SoundcloudAdapter(config);
  }

  it('stub mode returns a deterministic taste library and a stub authorize URL', async () => {
    const adapter = make({});
    expect(adapter.authorizeUrl('nonce123')).toBe(
      'https://stub.local/soundcloud/authorize?state=nonce123',
    );
    expect(await adapter.exchangeCode('x')).toBe('stub');
    const signals = await adapter.fetchTaste('stub');
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.some((s) => s.subjectType === 'artist')).toBe(true);
    expect(signals.some((s) => s.subjectType === 'genre')).toBe(true);
  });

  it('live authorize URL carries the client id, redirect and state', () => {
    const adapter = make({
      'connectors.soundcloudClientId': 'cid',
      'connectors.soundcloudRedirectUrl': 'https://atlas.example/cb',
    });
    const url = adapter.authorizeUrl('st8');
    expect(url).toContain('https://secure.soundcloud.com/authorize');
    expect(url).toContain('client_id=cid');
    expect(url).toContain('state=st8');
    expect(url).toContain('response_type=code');
  });

  it('live fetchTaste maps followed artists to ranked signals', async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({
        collection: [
          { id: 1, username: 'ANOTR' },
          { id: 2, username: 'Adam Port' },
          { id: 3 }, // no username → dropped
        ],
      }),
    })) as any;
    const adapter = make({ 'connectors.soundcloudClientId': 'cid' });
    const signals = await adapter.fetchTaste('tok');
    expect(signals).toHaveLength(2);
    expect(signals[0]).toMatchObject({
      subjectType: 'artist',
      subjectRef: 'ANOTR',
      externalId: 'sc:1',
    });
    expect(signals[0].weight).toBeGreaterThanOrEqual(1);
  });
});
