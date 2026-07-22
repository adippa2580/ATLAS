import {
  Controller,
  Get,
  Header,
  NotFoundException,
  Param,
} from '@nestjs/common';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

/**
 * Serves the Atlas + A-List design deliverables at /deliverables (outside the
 * /v1 prefix). These are the design-brief surfaces recreated as self-contained
 * static HTML in the two ratified design systems (Atlas v3.1 midnight for
 * operator surfaces, A-List platinum/dark for consumer surfaces). The index
 * lists every deliverable; each page is reachable at /deliverables/<file>.html.
 *
 * All pages are bundled into dist via nest-cli assets config and read into an
 * in-memory map at startup. Lookups are whitelisted against that map, so a
 * request can never escape the pages directory (no path traversal).
 */
@Controller('deliverables')
export class DeliverablesController {
  private readonly pagesDir = join(__dirname, 'pages');
  private readonly pages: Map<string, string> = this.loadPages();

  private loadPages(): Map<string, string> {
    const map = new Map<string, string>();
    for (const file of readdirSync(this.pagesDir)) {
      if (file.endsWith('.html')) {
        map.set(file, readFileSync(join(this.pagesDir, file), 'utf8'));
      }
    }
    return map;
  }

  @Get()
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  index(): string {
    return this.pages.get('index.html') ?? '<!doctype html><title>Deliverables</title>';
  }

  @Get(':file')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  page(@Param('file') file: string): string {
    const html = this.pages.get(file);
    if (!html) {
      throw new NotFoundException(`No deliverable named ${file}`);
    }
    return html;
  }
}
