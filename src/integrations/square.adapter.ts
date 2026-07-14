import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface TabPayload {
  externalTabId: string;
  total: number;
  lineItems: { name: string; amount: number }[];
  closed: boolean;
}

/**
 * Square POS adapter — tab/spend sync. The Tab/POS primitive (#13) is
 * POS-agnostic, so a Lightspeed adapter could implement the same shape.
 * STUB mode when SQUARE_ACCESS_TOKEN is unset.
 */
@Injectable()
export class SquareAdapter {
  constructor(private readonly config: ConfigService) {}

  private get stub(): boolean {
    return !this.config.get<string>('connectors.squareAccessToken');
  }

  verifyWebhook(_payload: unknown, _signature?: string): boolean {
    if (this.stub) return true;
    return false;
  }

  /** Normalise a raw Square webhook body into our TabPayload. */
  normalizeTab(body: any): TabPayload {
    return {
      externalTabId: body?.externalTabId ?? body?.id ?? 'tab_stub',
      total: Number(body?.total ?? 0),
      lineItems: Array.isArray(body?.lineItems) ? body.lineItems : [],
      closed: Boolean(body?.closed),
    };
  }
}
