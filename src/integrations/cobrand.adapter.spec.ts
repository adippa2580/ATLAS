import { CobrandAdapter } from './cobrand.adapter';

/** Co:Brand adapter: deterministic emerging-artist stub + defensive normalisation. */
describe('CobrandAdapter', () => {
  function make(cfg: Record<string, string | undefined>) {
    const config: any = { get: (k: string) => cfg[k] };
    return new CobrandAdapter(config);
  }

  it('returns deterministic emerging ArtistIntel[] in stub mode', async () => {
    const a = make({});
    const rows = await a.fetchEmerging();

    expect(rows.length).toBeGreaterThan(0);
    // Deterministic: a second call yields the same payload.
    expect(await a.fetchEmerging()).toEqual(rows);

    for (const r of rows) {
      expect(r.emerging).toBe(true);
      expect(typeof r.externalArtistId).toBe('string');
      expect(r.momentum).toBeGreaterThan(0);
      expect(r.momentum).toBeGreaterThanOrEqual(-1);
      expect(r.momentum).toBeLessThanOrEqual(1);
      expect(r.fitScore).toBeGreaterThanOrEqual(0);
      expect(r.fitScore).toBeLessThanOrEqual(1);
      expect(Array.isArray(r.genres)).toBe(true);
      expect(Array.isArray(r.topMarkets)).toBe(true);
    }
  });

  it('throws in live mode when an API key is configured', async () => {
    const a = make({ 'connectors.cobrandApiKey': 'key_live' });
    await expect(a.fetchEmerging('Sydney')).rejects.toThrow(
      'Co:Brand live mode not configured in this build',
    );
  });

  it('normalises a raw payload and clamps out-of-range momentum and fitScore', () => {
    const a = make({});
    const intel = a.normalizeArtist({
      artist_id: 'cb_999',
      name: 'Test Riser',
      genres: ['amapiano'],
      monthly_listeners: 123000,
      momentum: 5, // out of range → clamped to 1
      fit: 2.4, // out of range → clamped to 1
      top_markets: ['Sydney', 'Cape Town'],
    });

    expect(intel.externalArtistId).toBe('cb_999');
    expect(intel.name).toBe('Test Riser');
    expect(intel.genres).toEqual(['amapiano']);
    expect(intel.monthlyListeners).toBe(123000);
    expect(intel.momentum).toBe(1);
    expect(intel.fitScore).toBe(1);
    expect(intel.topMarkets).toEqual(['Sydney', 'Cape Town']);
    // Emerging defaults to true for this connector when not stated.
    expect(intel.emerging).toBe(true);
  });

  it('clamps a negative momentum up to -1', () => {
    const a = make({});
    const intel = a.normalizeArtist({ id: 'cb_neg', momentum: -8 });
    expect(intel.momentum).toBe(-1);
  });

  it('is defensive on missing fields', () => {
    const a = make({});
    const intel = a.normalizeArtist({});

    expect(intel.externalArtistId).toBe('cb_art_stub');
    expect(intel.name).toBe('Unknown artist');
    expect(intel.emerging).toBe(true);
    expect(intel.momentum).toBeUndefined();
    expect(intel.fitScore).toBeUndefined();
  });
});
