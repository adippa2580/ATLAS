import { Controller, Get, Header } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Serves the internal "Studio" hub at /studio (outside the /v1 prefix) — the
 * design system, sales collateral, developer surfaces and A-List consumer
 * previews. Deliberately kept OFF the venue customer's home (/): those are
 * internal ATLAS-team artifacts, not operator product. The HTML is bundled
 * into dist via nest-cli assets config.
 */
@Controller('studio')
export class StudioController {
  private readonly html = readFileSync(join(__dirname, 'studio.html'), 'utf8');

  @Get()
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  page(): string {
    return this.html;
  }
}
