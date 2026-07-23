import {
  generateKeyPair,
  exportPKCS8,
  decodeJwt,
  decodeProtectedHeader,
} from 'jose';
import { AppleMusicAdapter } from './applemusic.adapter';

/**
 * Apple Music taste connector: stub when unconfigured; live via a server-minted
 * ES256 developer token (or a supplied one) + a client-obtained Music User
 * Token; taste from heavy-rotation + library artists.
 */
describe('AppleMusicAdapter', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  function make(cfg: Record<string, string | undefined>) {
    const config: any = { get: (k: string) => cfg[k] };
    return new AppleMusicAdapter(config);
  }

  it('stubs when neither a developer token nor a signing trio is set', async () => {
    const adapter = make({});
    expect(adapter.authorizeUrl('nonce123')).toBe(
      'https://stub.local/applemusic/authorize?state=nonce123',
    );
    expect(await adapter.exchangeCode('mut')).toBe('stub');
    const signals = await adapter.fetchTaste('stub');
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.some((s) => s.subjectType === 'artist')).toBe(true);
  });

  it('with a supplied developer token: live authorize page + token pass-through', async () => {
    const adapter = make({
      'connectors.appleMusicDeveloperToken': 'dev.jwt.token',
    });
    expect(adapter.authorizeUrl('st8')).toBe(
      '/v1/connectors/applemusic/connect?state=st8',
    );
    expect(await adapter.developerToken()).toBe('dev.jwt.token');
    // No server exchange — the Music User Token round-trips unchanged.
    expect(await adapter.exchangeCode('music-user-token')).toBe(
      'music-user-token',
    );
  });

  it('mints an ES256 developer token from the signing trio (kid + iss claims)', async () => {
    const { privateKey } = await generateKeyPair('ES256');
    const pem = await exportPKCS8(privateKey);
    const adapter = make({
      'connectors.appleMusicTeamId': 'TEAMID1234',
      'connectors.appleMusicKeyId': 'KEYID56789',
      'connectors.appleMusicPrivateKey': pem,
    });
    expect(adapter.authorizeUrl('x')).toContain(
      '/v1/connectors/applemusic/connect',
    );
    const jwt = await adapter.developerToken(1_000_000);
    expect(decodeProtectedHeader(jwt)).toMatchObject({
      alg: 'ES256',
      kid: 'KEYID56789',
    });
    const claims = decodeJwt(jwt);
    expect(claims.iss).toBe('TEAMID1234');
    expect(claims.iat).toBe(1_000_000);
    // 6-month cap: exp must be within 6 months of iat.
    expect((claims.exp as number) - 1_000_000).toBeLessThanOrEqual(15_777_000);
  });

  it('caches the minted token and rotates before expiry', async () => {
    const { privateKey } = await generateKeyPair('ES256');
    const pem = await exportPKCS8(privateKey);
    const adapter = make({
      'connectors.appleMusicTeamId': 'TEAMID1234',
      'connectors.appleMusicKeyId': 'KEYID56789',
      'connectors.appleMusicPrivateKey': pem,
    });
    const t1 = await adapter.developerToken(1_000_000);
    const t2 = await adapter.developerToken(1_000_050); // still fresh → cached
    expect(t2).toBe(t1);
    // Far in the future (past rotate window) → a new token is minted.
    const t3 = await adapter.developerToken(1_000_000 + 150 * 24 * 60 * 60);
    expect(t3).not.toBe(t1);
  });

  it('live fetchTaste merges heavy-rotation + library artists with both tokens', async () => {
    const seen: { auth: string; userTok: string }[] = [];
    global.fetch = jest.fn(async (url: any, init: any) => {
      seen.push({
        auth: init.headers.Authorization,
        userTok: init.headers['Music-User-Token'],
      });
      if (String(url).includes('heavy-rotation')) {
        return {
          ok: true,
          json: async () => ({
            data: [{ id: 'hr1', attributes: { artistName: 'Keinemusik' } }],
          }),
        } as any;
      }
      return {
        ok: true,
        json: async () => ({
          data: [{ id: 'lib1', attributes: { name: 'Rampa' } }],
        }),
      } as any;
    }) as any;

    const adapter = make({
      'connectors.appleMusicDeveloperToken': 'dev.jwt.token',
    });
    const signals = await adapter.fetchTaste('user-tok');
    const refs = signals.map((s) => s.subjectRef);
    expect(refs).toContain('Keinemusik');
    expect(refs).toContain('Rampa');
    expect(seen[0].auth).toBe('Bearer dev.jwt.token');
    expect(seen[0].userTok).toBe('user-tok');
  });
});
