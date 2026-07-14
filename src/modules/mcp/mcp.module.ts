import { Controller, Get, Injectable, Module } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Scopes } from '../../common/auth/scopes.decorator';

/**
 * MCP gateway — two-sided (deck slide 11). Exposes a subset of primitives as
 * agent tools: consumer-side (C) and tenant-side (T), same toolkit, different
 * auth scope + consent gate. This build publishes the tool manifest; wiring each
 * tool to its primitive handler is the next increment.
 */
export interface McpTool {
  name: string;
  side: 'consumer' | 'tenant';
  primitive: string;
  scope: string;
  description: string;
}

@Injectable()
export class McpService {
  private readonly tools: McpTool[] = [
    {
      name: 'recommend_night',
      side: 'consumer',
      primitive: 'discovery',
      scope: 'mkt:discovery:read',
      description: 'Ranked events/venues/tables for a guest/crew',
    },
    {
      name: 'search_availability',
      side: 'consumer',
      primitive: 'bookings',
      scope: 'ops:bookings:read',
      description: 'Crew-aware ranked inventory for a date',
    },
    {
      name: 'book_table',
      side: 'consumer',
      primitive: 'bookings',
      scope: 'ops:bookings:write',
      description: 'Hold and confirm a booking',
    },
    {
      name: 'check_entitlements',
      side: 'consumer',
      primitive: 'entitlements',
      scope: 'guest:entitlements:read',
      description: 'Wallet contents for a guest',
    },
    {
      name: 'guest_context',
      side: 'tenant',
      primitive: 'identity',
      scope: 'guest:identity:read',
      description: 'Consent-gated guest profile + taste for a venue agent',
    },
  ];

  list(): McpTool[] {
    return this.tools;
  }
}

@ApiTags('mcp')
@Controller('mcp')
export class McpController {
  constructor(private readonly mcp: McpService) {}

  @Get('tools')
  @Scopes('mcp:tools:read')
  tools(): McpTool[] {
    return this.mcp.list();
  }
}

@Module({
  controllers: [McpController],
  providers: [McpService],
})
export class McpModule {}
