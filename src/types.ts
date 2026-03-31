/** UTXO (Unspent Transaction Output) */
export interface UTXO {
  txid: string;       // Transaction ID (hex, 32 bytes)
  vout: number;       // Output index
  value: number;      // Satoshis
  scriptPubKey: string; // Hex-encoded script
  address?: string;
  confirmations?: number;
}

/** Transaction input for building a BTC transaction */
export interface BtcTxInput {
  txid: string;
  vout: number;
  value: number;
  scriptPubKey: string;
  address?: string;
  /** Full previous transaction hex — required for P2PKH (nonWitnessUtxo) */
  prevTxHex?: string;
}

/** Transaction output for building a BTC transaction */
export interface BtcTxOutput {
  address: string;
  value: number; // satoshis
}

/** Unsigned Bitcoin transaction ready for signing */
export interface BtcUnsignedTx {
  inputs: BtcTxInput[];
  outputs: BtcTxOutput[];
  changeAddress: string;
  fee: number;
}

/** Signed Bitcoin transaction ready for broadcast */
export interface BtcSignedTx {
  rawTx: string; // hex-encoded raw transaction
  txid: string;
}

/** Fee rate estimates in sat/vbyte */
export interface FeeEstimate {
  fast: number;    // sat/vbyte for ~1 block
  medium: number;  // sat/vbyte for ~3 blocks
  slow: number;    // sat/vbyte for ~6 blocks
}

// ── Client types (matching production tetherto/wdk-wallet-btc) ──────────────

/** Bitcoin network identifier — matches production WDK */
export type BtcNetwork = 'bitcoin' | 'testnet' | 'regtest';

/** Balance result from IBtcClient.getBalance() */
export interface BtcBalance {
  confirmed: number;   // satoshis
  unconfirmed: number; // satoshis
}

/** UTXO as returned by IBtcClient.listUnspent() — Electrum-style shape */
export interface ElectrumUnspent {
  tx_hash: string;
  tx_pos: number;
  value: number;
  height: number;
}

/** History entry as returned by IBtcClient.getHistory() — Electrum-style shape */
export interface ElectrumHistoryEntry {
  tx_hash: string;
  height: number;
}

/** Rich transaction info for history display — parsed from full tx data */
export interface DetailedTxInfo {
  txHash: string;
  /** 'sent' if address appears only in inputs, 'received' if only in outputs, 'self' if both */
  direction: 'sent' | 'received' | 'self';
  /** Net amount in satoshis (positive = received, negative = sent) */
  amount: number;
  /** Fee in satoshis (only available for sent txs) */
  fee: number;
  /** Unix timestamp (0 if unconfirmed) */
  timestamp: number;
  /** Block height (0 if unconfirmed) */
  blockHeight: number;
  confirmed: boolean;
  /** Counterparty address(es) */
  counterparties: string[];
}

/**
 * Per-output transfer row — matches production BtcTransfer semantics.
 * One row per relevant output (not per transaction).
 */
export interface BtcTransferRow {
  txid: string;
  /** User's own address */
  address: string;
  /** Output index in the transaction */
  vout: number;
  /** Block height (0 if unconfirmed) */
  height: number;
  /** Satoshi amount of THIS output only */
  value: number;
  /** Direction: incoming or outgoing (change outputs are excluded) */
  direction: 'incoming' | 'outgoing';
  /** Receiving address for this output */
  recipient?: string;
  /** Fee for the entire transaction (same for all rows from one tx) */
  fee?: number;
}

/** Query parameters for paginated transfer history */
export interface TransferQuery {
  /** Filter by direction: 'incoming', 'outgoing', or 'all' (default: 'all').
   * Also accepts legacy 'sent'/'received' for backward compatibility. */
  direction?: 'incoming' | 'outgoing' | 'sent' | 'received' | 'all';
  /** Max number of transfer rows to return (default: 25) */
  limit?: number;
  /** Number of transactions to skip before processing (default: 0) */
  skip?: number;
  /** Cursor for pagination — txid of the last seen tx */
  afterTxId?: string;
  /** Numeric page number (blockbook pagination) */
  page?: number;
}

/** Paginated transfer result */
export interface TransferResult {
  transfers: BtcTransferRow[];
  /** True if there may be more results beyond this page */
  hasMore: boolean;
  /** Cursor for fetching the next page (last txid in this batch) */
  nextCursor?: string;
}

/** Descriptor for creating a client via factory.
 * Production-compatible types: 'blockbook-http', 'electrum', 'electrum-ws'
 * v2 also accepts: 'blockbook' (alias), 'mempool-rest'
 */
export interface BtcClientDescriptor {
  type: 'blockbook-http' | 'blockbook' | 'mempool-rest' | 'electrum' | 'electrum-ws';
  url?: string;
  network?: BtcNetwork;
}
