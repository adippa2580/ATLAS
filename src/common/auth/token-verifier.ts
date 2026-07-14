import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose';
import type { TenantContext } from '../tenancy/tenant-context';

/**
 * Verifies OAuth2/OIDC Bearer tokens and maps their claims onto a
 * {@link TenantContext}.
 *
 * This is the production replacement for the `trust-headers` path: instead of
 * blindly trusting client-supplied `X-Tenant-Id` / `X-Scopes` headers, we verify
 * a signed JWT against the identity provider's published JWKS and derive the
 * tenant + scopes from the token's own (cryptographically-attested) claims.
 *
 * Configuration (all read from `oidc.*` in configuration.ts):
 *   - OIDC_JWKS_URL : remote JWKS endpoint, e.g.
 *                     https://issuer.example.com/.well-known/jwks.json
 *   - OIDC_ISSUER   : expected `iss` claim
 *   - OIDC_AUDIENCE : expected `aud` claim
 *
 * The JWKS is fetched lazily and cached/rotated internally by jose's
 * `createRemoteJWKSet` (it handles key rollover and caching), so we build it
 * once and reuse it across requests.
 */
@Injectable()
export class TokenVerifier {
  private readonly logger = new Logger(TokenVerifier.name);

  // Built lazily on first use so that construction never performs network I/O
  // and a mis-/un-configured JWKS URL only fails requests, not app startup.
  private jwks?: JWTVerifyGetKey;

  constructor(private readonly config: ConfigService) {}

  /**
   * Verify a raw `Authorization` header value (or bare token) and return the
   * resolved TenantContext. Returns `null` when the token is missing, malformed,
   * fails signature/issuer/audience verification, or lacks a tenant claim — the
   * caller (TenantMiddleware) is responsible for translating `null` into a 401.
   */
  async verify(authorizationHeader?: string): Promise<TenantContext | null> {
    const token = this.extractBearer(authorizationHeader);
    if (!token) {
      return null;
    }

    const issuer = this.config.get<string>('oidc.issuer') ?? '';
    const audience = this.config.get<string>('oidc.audience') ?? '';

    try {
      const jwks = this.getJwks();
      const { payload } = await jwtVerify(token, jwks, {
        // Only enforce issuer/audience when configured, so a partial config
        // still fails closed on signature but doesn't silently accept a token
        // for the wrong `iss`/`aud` once those are set.
        ...(issuer ? { issuer } : {}),
        ...(audience ? { audience } : {}),
      });
      return this.claimsToContext(payload);
    } catch (err) {
      // Do not leak token contents; log only the failure reason.
      this.logger.warn(
        `Bearer token verification failed: ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );
      return null;
    }
  }

  /** Returns the (lazily-built) remote JWKS key resolver. */
  private getJwks(): JWTVerifyGetKey {
    if (!this.jwks) {
      const jwksUrl = this.config.get<string>('oidc.jwksUrl') ?? '';
      if (!jwksUrl) {
        throw new Error(
          'OIDC_JWKS_URL is not configured but AUTH_MODE=oauth is set',
        );
      }
      this.jwks = createRemoteJWKSet(new URL(jwksUrl));
    }
    return this.jwks;
  }

  /** Pulls the raw JWT out of an `Authorization: Bearer <token>` header. */
  private extractBearer(header?: string): string | null {
    if (!header) {
      return null;
    }
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match) {
      return match[1].trim();
    }
    return null;
  }

  /**
   * Maps verified JWT claims onto a TenantContext.
   *   - tenantId : first present of `tenant_id` | `org`
   *   - scopes   : from `scope` (space/comma-delimited string, OAuth2 standard)
   *                or `scp` (string or string[]) — Azure AD style.
   *   - guestId  : optional `guest_id` claim (consumer-agent consent token).
   * Returns `null` when no tenant claim is present (a token we can't tenant-scope
   * is not usable and must be rejected).
   */
  private claimsToContext(payload: JWTPayload): TenantContext | null {
    const tenantId =
      this.stringClaim(payload['tenant_id']) ??
      this.stringClaim(payload['org']);
    if (!tenantId) {
      return null;
    }

    const scopes = this.parseScopes(payload['scope'] ?? payload['scp']);
    const guestId = this.stringClaim(payload['guest_id']);

    return {
      tenantId,
      scopes,
      ...(guestId ? { guestId } : {}),
    };
  }

  private stringClaim(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  }

  /** Normalizes a `scope`/`scp` claim (string or array) to a string[]. */
  private parseScopes(raw: unknown): string[] {
    if (Array.isArray(raw)) {
      return raw.filter((s): s is string => typeof s === 'string');
    }
    if (typeof raw === 'string') {
      return raw.split(/[\s,]+/).filter(Boolean);
    }
    return [];
  }
}
