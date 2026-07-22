import { Controller, Get, Header } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Serves the Atlas platform home / menu at the site root `/` (outside the /v1
 * prefix). A single hub that links every surface — the live Ops console, the
 * Outcomes intelligence view, the design deliverables, and the API docs — so
 * the dashboards are reachable from one place. The HTML is bundled into dist
 * via nest-cli assets config.
 */
@Controller()
export class HomeController {
  private readonly html = readFileSync(join(__dirname, 'home.html'), 'utf8');

  @Get()
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  page(): string {
    return this.html;
  }
}
