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
      {} as any, // instagram
      config,
    );
  }

  it('signs and verifies an invite roundtrip', () => {
    const svc = make({ connectInviteSecret: 's3cret', env: 'production' });
    const token = svc.signInvite('guest-123');
    expect(svc.verifyInvite(token)).toBe('guest-123');
  });

  it('rejects tampered and malformed tokens', () => {
    const svc = make({ connectInviteSecret: 's3cret' });
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
    const svc = make({ connectInviteSecret: 's3cret' });
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
});
