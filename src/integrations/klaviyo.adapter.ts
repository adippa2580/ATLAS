import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Klaviyo adapter — CRM/email delivery rail. Makes the venue's existing stack
 * smarter (no rip-and-replace). Delivery is discovery, never a blast. STUB mode
 * logs instead of sending.
 */
@Injectable()
export class KlaviyoAdapter {
  private readonly logger = new Logger(KlaviyoAdapter.name);

  constructor(private readonly config: ConfigService) {}

  private get stub(): boolean {
    return !this.config.get<string>('connectors.klaviyoApiKey');
  }

  async sendCampaign(
    audienceSize: number,
    payload: Record<string, unknown>,
  ): Promise<{ delivered: number; provider: string; stub: boolean }> {
    if (this.stub) {
      this.logger.debug(
        `[klaviyo-stub] would deliver to ${audienceSize} recipients: ${JSON.stringify(payload)}`,
      );
      return { delivered: audienceSize, provider: 'klaviyo', stub: true };
    }
    throw new Error('Klaviyo live mode not configured in this build');
  }
}
