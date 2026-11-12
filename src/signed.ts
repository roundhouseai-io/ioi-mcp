export interface ChannelSent {
  slot: string;
  kind: 'voucher' | 'deposit';
  channelId: string;
  maxClaimable: bigint;
  deposit: bigint | undefined;
  request: bigint;
  depositUntil: number | undefined;
}

/** A payment payload ready to put in `_meta["x402/payment"]`, plus what to count. */
export interface SignedQuote {
  payload: Record<string, unknown>;
  exposureAtomic: bigint;
  asset: string;
  decimals: number;
  receipt: Record<string, unknown>;
  channelSent?: ChannelSent;
}
