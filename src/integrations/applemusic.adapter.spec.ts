import { AppleMusicAdapter } from './applemusic.adapter';

/** Apple Music taste connector: stub library + MusicKit token pass-through. */
describe('AppleMusicAdapter', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  function make(cfg: Record<string, string | undefined>) {
    const config: any = { get: (k: string) => cfg[k] };
    return new AppleMusicAdapter(config);
  }

  it('stub mode returns a deterministic taste library and a stub authorize URL', async () => {
    const adapter = make({});
    expect(adapter.authorizeUrl('nonce123')).toBe(
      'https://stub.local/applemusic/authorize?state=nonce123',
    );
    // Stub passes nothing real through.
    expect(await adapter.exchangeCode('mut')).toBe('stub');
    const signals = await adapter.fetchTaste('stub');
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.some((s) => s.subjectType === 'artist')).toBe(true);
  });

  it('live mode points at the MusicKit authorize page and passes the user token through', async () => {
    const adapter = make({
      'connectors.appleMusicDeveloperToken': 'dev.jwt.token',
    });
    expect(adapter.authorizeUrl('st8')).toBe('/connect/applemusic?state=st8');
    // No server-side exchange — the Music User Token round-trips unchanged.
    expect(await adapter.exchangeCode('music-user-token')).toBe(
      'music-user-token',
    );
  });

  it('live fetchTaste sends both tokens and maps library artists', async () => {
    let seenAuth = '';
    let seenUserToken = '';
    global.fetch = jest.fn(async (_url: any, init: any) => {
      seenAuth = init.headers.Authorization;
      seenUserToken = init.headers['Music-User-Token'];
      return {
        ok: true,
        json: async () => ({
          data: [
            { id: 'r1', attributes: { name: 'Keinemusik' } },
            { id: 'r2', attributes: { name: 'Rampa' } },
            { id: 'r3', attributes: {} }, // no name → dropped
          ],
        }),
      } as any;
    }) as any;

    const adapter = make({
      'connectors.appleMusicDeveloperToken': 'dev.jwt.token',
    });
    const signals = await adapter.fetchTaste('user-tok');
    expect(seenAuth).toBe('Bearer dev.jwt.token');
    expect(seenUserToken).toBe('user-tok');
    expect(signals).toHaveLength(2);
    expect(signals[0]).toMatchObject({
      subjectType: 'artist',
      subjectRef: 'Keinemusik',
      externalId: 'am:r1',
    });
  });
});
