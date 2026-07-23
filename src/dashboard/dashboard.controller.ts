import { Controller, Get, Header } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Serves the ATLAS operations console at /dashboard (outside the /v1 prefix).
 * Same-origin, so the page drives the live primitive APIs directly. The HTML is
 * bundled into dist via nest-cli assets config.
 */
@Controller('dashboard')
export class DashboardController {
  // A build stamp baked into the page. Cloud Run sets K_REVISION per revision,
  // so it changes on every deploy — if the stamp differs after a reload, the
  // browser is on fresh HTML (the old build has no stamp at all).
  private readonly buildId =
    process.env.K_REVISION ??
    process.env.BUILD_SHA ??
    `local-${Math.floor(Date.now() / 1000)}`;

  private readonly html = readFileSync(
    join(__dirname, 'dashboard.html'),
    'utf8',
  ).replace(/__BUILD__/g, this.buildId);

  @Get()
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  page(): string {
    return this.html;
  }
}
