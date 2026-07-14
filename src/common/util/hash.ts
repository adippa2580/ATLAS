import { createHash } from 'crypto';

/** Stable hash for identity-link values and evidence dedupe keys. */
export function sha256(...parts: (string | undefined)[]): string {
  return createHash('sha256')
    .update(parts.filter(Boolean).join('|'))
    .digest('hex');
}

/** Canonical dedupe key for an evidence record: sha(connector, external, signal). */
export function evidenceDedupeKey(
  source: string,
  externalId: string,
  signal: string,
): string {
  return sha256(source, externalId, signal);
}
