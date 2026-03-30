/**
 * IBtcClient — abstract interface for Bitcoin chain data access.
 *
 * Matches the production tetherto/wdk-wallet-btc client interface exactly.
 * Production transports: ElectrumTcp, ElectrumTls, ElectrumSsl, ElectrumWs, BlockbookClient.
 * Our v2 (QuickJS/C — HTTP only): BlockbookClient, MempoolRestClient.
 */

import type { BtcBalance, ElectrumUnspent, ElectrumHistoryEntry, DetailedTxInfo } from '../types.js';

export interface IBtcClient {
  /** Establish connection to the backend (no-op for HTTP clients) */
  connect(): Promise<void>;

  /** Close / cleanup connection */
  close(): Promise<void>;

  /** Reconnect (close + connect) */
  reconnect(): Promise<void>;

  /** Get confirmed + unconfirmed balance for an address (satoshis) */
  getBalance(address: string): Promise<BtcBalance>;

  /** List unspent outputs for an address */
  listUnspent(address: string): Promise<ElectrumUnspent[]>;

  /** Get transaction history for an address — minimal Electrum shape */
  getHistory(address: string): Promise<ElectrumHistoryEntry[]>;

  /**
   * Get detailed transaction history with parsed direction, amounts, fees.
   * Default implementation: calls getHistory() + getTransaction() per tx.
   * MempoolRestClient overrides this with a single-call implementation.
   */
  getDetailedHistory(address: string, limit?: number): Promise<DetailedTxInfo[]>;

  /** Get raw transaction hex by txid */
  getTransaction(txHash: string): Promise<string>;

  /** Broadcast a raw transaction hex, returns txid */
  broadcast(rawTx: string): Promise<string>;

  /**
   * Estimate fee rate for a target confirmation in N blocks.
   * @returns fee rate in BTC/kB (production convention)
   */
  estimateFee(blocks: number): Promise<number>;

  /**
   * Get transaction confirmation status.
   * Returns confirmed state, block height/time, and fee.
   */
  getTxStatus(txHash: string): Promise<{
    txHash: string;
    confirmed: boolean;
    blockHeight: number;
    blockTime: number;
    fee: number;
  }>;
}
