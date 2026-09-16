/** A brokerage supported by SnapTrade, normalized for the renderer. */
export type SnaptradeBrokerage = {
  id: string;
  name: string;
  slug: string;
  logoUrl: string | null;
  url: string | null;
};

/** One connected brokerage account, normalized for the renderer. */
export type BrokerageAccount = {
  id: string;
  name: string;
  institution: string;
  /** Total account value in the account's currency (assumed USD). */
  totalValue: number | null;
  /** SnapTrade connection id — used to disconnect. Absent on older snapshots. */
  authorizationId?: string | null;
};

/** Combined value of every connected brokerage account. */
export type BrokerageNetWorth = {
  /** false until the user has completed at least one connection. */
  connected: boolean;
  total: number;
  accounts: BrokerageAccount[];
};
