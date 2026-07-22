import { Controller, Get, Header } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Serves the Atlas outcomes-intelligence dashboard at /outcomes (outside the
 * /v1 prefix). Portfolio-level view: hospitality outcomes derived against the
 * platform's data pillars, with relative success scoring and drill-downs. The
 * HTML is bundled into dist via nest-cli assets config.
 */
@Controller('outcomes')
export class OutcomesController {
  private readonly html = readFileSync(
    join(__dirname, 'outcomes.html'),
    'utf8',
  );

  @Get()
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  page(): string {
    return this.html;
  }
}
