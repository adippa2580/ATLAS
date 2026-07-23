import { UnauthorizedException } from '@nestjs/common';
import { ConnectorsService } from './connectors.module';

/**
 * Connect-invite hardening: only signed, unexpired invites resolve to a
 * guestId; production fails closed without a signing secret.
 */
describe('ConnectorsService (invite tokens)', () => {
  function make(cfg: Record<string, string | undefined>) {
    const config: any = { get: (k: string) => cfg[k] };
    return new ConnectorsService(
      {} as any, // prisma — untouched by invite paths
      {} as any, // taste
      {} as any, // spotify
      {} as any, // soundcloud
      {} as any, // applemusic
      {} as any, // instagram
      {
        authorizeUrl: (state: string) => `https://eb/authorize?state=${state}`,
        exchangeCode: async (code: string) => `ebo_stub_token_${code}`,
        oauthConfigured: false,
      } as any, // eventbrite
      config,
    );
  }

  it('signs and verifies an invite roundtrip', () => {
    const svc = make({
      'connectors.connectInviteSecret': 's3cret',
      env: 'production',
    });
    const token = svc.signInvite('guest-123');
    expect(svc.verifyInvite(token)).toBe('guest-123');
  });

  it('rejects tampered and malformed tokens', () => {
    const svc = make({ 'connectors.connectInviteSecret': 's3cret' });
    const token = svc.signInvite('guest-123');
    const [b64, sig] = token.split('.');
    const other = Buffer.from(
      JSON.stringify({
        guestId: 'victim',
        exp: Math.floor(Date.now() / 1000) + 900,
      }),
    ).toString('base64url');
    expect(() => svc.verifyInvite(`${other}.${sig}`)).toThrow(
      UnauthorizedException,
    );
    expect(() => svc.verifyInvite(`${b64}.AAAA`)).toThrow(
      UnauthorizedException,
    );
    expect(() => svc.verifyInvite('garbage')).toThrow(UnauthorizedException);
  });

  it('rejects expired invites', () => {
    const svc = make({ 'connectors.connectInviteSecret': 's3cret' });
    const token = svc.signInvite('guest-123', -10);
    expect(() => svc.verifyInvite(token)).toThrow('Invite expired');
  });

  it('fails closed in production without a signing secret', () => {
    const svc = make({ env: 'production' });
    expect(() => svc.signInvite('guest-123')).toThrow(UnauthorizedException);
    expect(() => svc.verifyInvite('anything.dev')).toThrow(
      UnauthorizedException,
    );
  });

  it('dev mode issues clearly-marked unsigned tokens that only dev accepts', () => {
    const dev = make({ env: 'development' });
    const token = dev.signInvite('guest-dev');
    expect(token.endsWith('.dev')).toBe(true);
    expect(dev.verifyInvite(token)).toBe('guest-dev');
  });

  it('honours a custom (shareable) TTL in the invite exp', () => {
    const svc = make({ 'connectors.connectInviteSecret': 's3cret' });
    const now = Math.floor(Date.now() / 1000);
    const week = 7 * 24 * 3600;
    const token = svc.signInvite('guest-123', week);
    const payload = JSON.parse(
      Buffer.from(token.split('.')[0], 'base64url').toString('utf8'),
    );
    // exp is ~now + a week (allow a couple seconds of clock drift in the test).
    expect(payload.exp).toBeGreaterThanOrEqual(now + week - 3);
    expect(payload.exp).toBeLessThanOrEqual(now + week + 3);
    expect(svc.verifyInvite(token)).toBe('guest-123');
  });

  describe('eventbrite OAuth connect', () => {
    it('authorize issues a CSRF state that its own callback round-trips', async () => {
      const svc = make({ 'connectors.connectInviteSecret': 's3cret' });
      const { state, authorizeUrl, provider } = svc.eventbriteAuthorize('op-1');
      expect(provider).toBe('eventbrite');
      expect(authorizeUrl).toContain(state);
      const res = await svc.eventbriteCallback(state, 'the_code');
      expect(res).toMatchObject({
        provider: 'eventbrite',
        connected: true,
        subjectId: 'op-1',
        live: false,
      });
    });

    it('rejects an unknown/replayed state', async () => {
      const svc = make({ 'connectors.connectInviteSecret': 's3cret' });
      await expect(svc.eventbriteCallback('nope', 'c')).rejects.toThrow(
        UnauthorizedException,
      );
      // Single-use: a valid state cannot be replayed.
      const { state } = svc.eventbriteAuthorize('op-2');
      await svc.eventbriteCallback(state, 'c');
      await expect(svc.eventbriteCallback(state, 'c')).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });
});
