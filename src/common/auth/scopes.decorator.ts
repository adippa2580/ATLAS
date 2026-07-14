import { SetMetadata } from '@nestjs/common';

export const SCOPES_KEY = 'atlasRequiredScopes';

/**
 * Declares the auth scopes required for a handler, named `hub:primitive:action`
 * (see docs/architecture/primitive-api-spec.md). Example: @Scopes('guest:evidence:write').
 */
export const Scopes = (...scopes: string[]) => SetMetadata(SCOPES_KEY, scopes);
