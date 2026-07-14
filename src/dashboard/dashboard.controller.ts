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
  private readonly html = readFileSync(
    join(__dirname, 'dashboard.html'),
    'utf8',
  );

  @Get()
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  page(): string {
    return this.html;
  }
}
