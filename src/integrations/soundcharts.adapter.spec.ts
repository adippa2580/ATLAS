import { ConfigService } from '@nestjs/config';
import { SoundchartsAdapter } from './soundcharts.adapter';

/** Soundcharts artist-intel adapter: deterministic stub + defensive normalise. */
describe('SoundchartsAdapter', () => {
  function make(cfg: Record<string, string | undefined>): SoundchartsAdapter {
    const config = { get: (k: string) => cfg[k] } as unknown as ConfigService;
    return new SoundchartsAdapter(config);
  }

  it('returns a deterministic ArtistIntel shape in stub mode', async () => {
    const a = make({});
    const intel = await a.fetchArtist('Adam Port');

    expect(typeof intel.externalArtistId).toBe('string');
    expect(intel.name).toBe('Adam Port');
    expect(typeof intel.monthlyListeners).toBe('number');
    expect(typeof intel.followers).toBe('number');
    expect(Array.isArray(intel.genres)).toBe(true);
    expect(Array.isArray(intel.topMarkets)).toBe(true);
    expect(intel.momentum).toBeGreaterThanOrEqual(-1);
    expect(intel.momentum).toBeLessThanOrEqual(1);
    expect(intel.fitScore).toBeGreaterThanOrEqual(0);
    expect(intel.fitScore).toBeLessThanOrEqual(1);

    // Deterministic: a second call yields the same payload.
    expect(await a.fetchArtist('Adam Port')).toEqual(intel);
  });

  it('throws in live mode when an api key is configured', async () => {
    const a = make({ 'connectors.soundchartsApiKey': 'key_live' });
    await expect(a.fetchArtist('Adam Port')).rejects.toThrow(
      'Soundcharts live mode not configured in this build',
    );
    await expect(a.rankArtists(['Adam Port'])).rejects.toThrow(
      'Soundcharts live mode not configured in this build',
    );
  });

  it('rankArtists returns intel sorted by fitScore descending', async () => {
    const a = make({});
    const names = ['ANOTR', 'Peggy Gou', 'Black Coffee', 'Adam Port'];
    const ranked = await a.rankArtists(names);

    expect(ranked).toHaveLength(names.length);
    // Same names returned, just reordered.
    expect(ranked.map((r) => r.name).sort()).toEqual([...names].sort());

    // Stub fitScores are distinct per name, so ordering is strictly descending.
    const scores = ranked.map((r) => r.fitScore ?? 0);
    for (let i = 1; i < scores.length; i += 1) {
      expect(scores[i - 1]).toBeGreaterThanOrEqual(scores[i]);
    }
    const distinct = new Set(scores);
    expect(distinct.size).toBe(scores.length);
    expect(scores[0]).toBe(Math.max(...scores));
  });

  it('normalises a vendor-shaped artist and clamps out-of-range values', () => {
    const a = make({});
    const intel = a.normalizeArtist({
      uuid: 'sc_9f2',
      name: 'Keinemusik',
      genres: ['afro house', 'organic house'],
      monthlyListeners: 3_200_000,
      followers: 540_000,
      growth: 2.5, // out of range → clamps to 1
      audience_geo: ['DE', 'AU', 'GB'],
      fit: 1.4, // out of range → clamps to 1
    });

    expect(intel.externalArtistId).toBe('sc_9f2');
    expect(intel.name).toBe('Keinemusik');
    expect(intel.genres).toEqual(['afro house', 'organic house']);
    expect(intel.monthlyListeners).toBe(3_200_000);
    expect(intel.followers).toBe(540_000);
    expect(intel.topMarkets).toEqual(['DE', 'AU', 'GB']);
    expect(intel.momentum).toBe(1);
    expect(intel.fitScore).toBe(1);
  });

  it('clamps a negative momentum up to −1 and omits absent metrics', () => {
    const a = make({});
    const intel = a.normalizeArtist({
      artist_id: 'sc_neg',
      name: 'Falling Act',
      momentum: -3,
    });

    expect(intel.externalArtistId).toBe('sc_neg');
    expect(intel.momentum).toBe(-1);
    expect(intel.monthlyListeners).toBeUndefined();
    expect(intel.followers).toBeUndefined();
    expect(intel.fitScore).toBeUndefined();
  });
});
