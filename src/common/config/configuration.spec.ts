import configuration from './configuration';

/**
 * Guards the admin-secret resolution: a real secret is kept, but a value still
 * wrapped in the deploy placeholder (`__ADMIN_…__`, i.e. CI never substituted
 * it) must be treated as UNSET so login fails closed instead of accepting the
 * publicly-visible placeholder string as a password.
 */
describe('configuration() admin secrets', () => {
  const KEYS = [
    'ADMIN_SESSION_SECRET',
    'ADMIN_ADRIAN_PASSWORD',
    'ADMIN_JACK_PASSWORD',
  ];
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    KEYS.forEach((k) => delete process.env[k]);
  });
  afterEach(() => {
    KEYS.forEach((k) => {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    });
  });

  it('keeps real secrets and admits configured users', () => {
    process.env.ADMIN_SESSION_SECRET = 's3cret';
    process.env.ADMIN_ADRIAN_PASSWORD = 'adrian-pw';
    const cfg = configuration().admin;
    expect(cfg.sessionSecret).toBe('s3cret');
    expect(cfg.users).toEqual({ adrian: 'adrian-pw' });
  });

  it('trims surrounding whitespace on a secret', () => {
    process.env.ADMIN_SESSION_SECRET = '  s3cret\n';
    expect(configuration().admin.sessionSecret).toBe('s3cret');
  });

  it('rejects an un-substituted CI placeholder as if unset (fails closed)', () => {
    process.env.ADMIN_SESSION_SECRET = '__ADMIN_SESSION_SECRET__';
    process.env.ADMIN_ADRIAN_PASSWORD = '__ADMIN_ADRIAN_PASSWORD__';
    process.env.ADMIN_JACK_PASSWORD = 'jack-pw';
    const cfg = configuration().admin;
    // Placeholder session secret → blanked; placeholder password → user dropped.
    expect(cfg.sessionSecret).toBe('');
    expect(cfg.users).toEqual({ jack: 'jack-pw' });
  });
});
