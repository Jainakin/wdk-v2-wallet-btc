/**
 * BlockbookClient — IBtcClient implementation using the Blockbook v2 REST API.
 *
 * Matches the production tetherto/wdk-wallet-btc BlockbookClient exactly.
 * This is one of the three production-supported transports.
 *
 * Endpoints (Blockbook v2):
 *   GET /api/v2/address/{addr}?details=basic              → getBalance
 *   GET /api/v2/utxo/{addr}                               → listUnspent
 *   GET /api/v2/address/{addr}?details=txslight&pageSize=N → getHistory
 *   GET /api/v2/tx/{txHash}                               → getTransaction (hex field)
 *   GET /api/v2/sendtx/{rawTxHex}                         → broadcast
 *   GET /api/v2/estimatefee/{blocks}                      → estimateFee (BTC/kB)
 *
 * Default servers: btc1.trezor.io (mainnet), tbtc1.trezor.io (testnet)
 */

import type { IBtcClient } from './btc-client.js';
import type { BtcBalance, ElectrumUnspent, ElectrumHistoryEntry, DetailedTxInfo, BtcNetwork } from '../types.js';
import { LRUCache, ConcurrencyLimiter } from '../cache.js';

/** Default Blockbook server URLs per network */
const BASE_URLS: Record<BtcNetwork, string> = {
  bitcoin: 'https://btc1.trezor.io',
  testnet: 'https://tbtc1.trezor.io',
  regtest: '', // regtest needs user-provided URL
};

/** Mempool.space fallback for fee estimation when Blockbook fails */
const MEMPOOL_FEE_URL = 'https://mempool.space/api/v1/fees/recommended';

export class BlockbookClient implements IBtcClient {
  private readonly baseUrl: string;
  private readonly txCache = new LRUCache<string, string>(100);
  private readonly limiter = new ConcurrencyLimiter(8);

  constructor(network: BtcNetwork = 'bitcoin', customUrl?: string) {
    this.baseUrl = customUrl
      ? customUrl.replace(/\/$/, '')
      : BASE_URLS[network];

    if (!this.baseUrl) {
      throw new Error(
        `No default Blockbook server for network '${network}'. Provide a custom URL.`,
      );
    }
  }

  async connect(): Promise<void> { /* no-op for HTTP REST */ }
  async close(): Promise<void> { this.txCache.clear(); }
  async reconnect(): Promise<void> { this.txCache.clear(); }
  async reconnect(): Promise<void> { /* no-op */ }

  async getBalance(address: string): Promise<BtcBalance> {
    const data = await this.fetchJson<{
      balance: string;
      unconfirmedBalance: string;
    }>(`/api/v2/address/${address}?details=basic`);

    return {
      confirmed: Number(data.balance),
      unconfirmed: Number(data.unconfirmedBalance),
    };
  }

  async listUnspent(address: string): Promise<ElectrumUnspent[]> {
    const utxos = await this.fetchJson<Array<{
      txid: string;
      vout: number;
      value: string;
      height?: number;
      confirmations?: number;
    }>>(`/api/v2/utxo/${address}`);

    return utxos.map((u) => ({
      tx_hash: u.txid,
      tx_pos: u.vout,
      value: Number(u.value),
      height: u.height ?? 0,
    }));
  }

  async getHistory(address: string): Promise<ElectrumHistoryEntry[]> {
    // Fetch with txslight detail for transaction metadata
    const entries: ElectrumHistoryEntry[] = [];
    let page = 1;
    let totalPages = 1;

    while (page <= totalPages) {
      const data = await this.fetchJson<{
        page: number;
        totalPages: number;
        txs?: number;
        transactions?: Array<{
          txid: string;
          blockHeight: number;
        }>;
      }>(`/api/v2/address/${address}?details=txslight&pageSize=1000&page=${page}`);

      totalPages = data.totalPages;

      if (data.transactions) {
        for (const tx of data.transactions) {
          entries.push({
            tx_hash: tx.txid,
            height: tx.blockHeight > 0 ? tx.blockHeight : 0,
          });
        }
      }

      page++;
    }

    return entries;
  }

  async getTransaction(txHash: string): Promise<string> {
    const cached = this.txCache.get(txHash);
    if (cached !== undefined) return cached;

    const data = await this.fetchJson<{
      hex?: string;
    }>(`/api/v2/tx/${txHash}`);

    if (!data.hex) {
      throw new Error(`No hex data in Blockbook response for tx ${txHash}`);
    }

    this.txCache.set(txHash, data.hex);
    return data.hex;
  }

  async getTxStatus(txHash: string): Promise<{
    txHash: string;
    confirmed: boolean;
    blockHeight: number;
    blockTime: number;
    fee: number;
  }> {
    const data = await this.fetchJson<{
      txid: string;
      confirmations: number;
      blockHeight?: number;
      blockTime?: number;
      fees: string;
    }>(`/api/v2/tx/${txHash}`);

    return {
      txHash: data.txid,
      confirmed: data.confirmations > 0,
      blockHeight: data.blockHeight ?? 0,
      blockTime: data.blockTime ?? 0,
      fee: parseInt(data.fees, 10) || 0,
    };
  }

  async broadcast(rawTx: string): Promise<string> {
    // Production Blockbook uses GET /api/v2/sendtx/{hex}
    const data = await this.fetchJson<{
      result?: string;
      error?: string;
    }>(`/api/v2/sendtx/${rawTx}`);

    if (data.error) {
      throw new Error(`Broadcast failed: ${data.error}`);
    }

    return data.result ?? '';
  }

  async getDetailedHistory(address: string, limit: number = 25): Promise<DetailedTxInfo[]> {
    // Blockbook /api/v2/address/{addr}?details=txs returns full tx data
    const data = await this.fetchJson<{
      transactions?: Array<{
        txid: string;
        fees: string;
        blockHeight: number;
        blockTime: number;
        confirmations: number;
        vin: Array<{ addresses?: string[]; value: string }>;
        vout: Array<{ addresses?: string[]; value: string }>;
      }>;
    }>(`/api/v2/address/${address}?details=txs&pageSize=${limit}`);

    if (!data.transactions) return [];

    return data.transactions.map((tx) => {
      const inputAddresses = new Set(
        tx.vin.flatMap((v) => v.addresses ?? [])
      );
      const outputAddresses = new Set(
        tx.vout.flatMap((v) => v.addresses ?? [])
      );

      const isInInput = inputAddresses.has(address);
      const isInOutput = outputAddresses.has(address);

      let direction: 'sent' | 'received' | 'self';
      if (isInInput && isInOutput) {
        const allToUs = tx.vout.every(
          (v) => !v.addresses || v.addresses.every((a) => a === address)
        );
        direction = allToUs ? 'self' : 'sent';
      } else if (isInInput) {
        direction = 'sent';
      } else {
        direction = 'received';
      }

      let amount: number;
      if (direction === 'received') {
        amount = tx.vout
          .filter((v) => v.addresses?.includes(address))
          .reduce((sum, v) => sum + parseInt(v.value, 10), 0);
      } else if (direction === 'sent') {
        const totalIn = tx.vin
          .filter((v) => v.addresses?.includes(address))
          .reduce((sum, v) => sum + parseInt(v.value, 10), 0);
        const changeBack = tx.vout
          .filter((v) => v.addresses?.includes(address))
          .reduce((sum, v) => sum + parseInt(v.value, 10), 0);
        amount = -(totalIn - changeBack);
      } else {
        amount = 0;
      }

      const counterparties: string[] = [];
      if (direction === 'sent') {
        tx.vout.forEach((v) => {
          (v.addresses ?? []).forEach((a) => {
            if (a !== address) counterparties.push(a);
          });
        });
      } else if (direction === 'received') {
        inputAddresses.forEach((a) => {
          if (a !== address) counterparties.push(a);
        });
      }

      return {
        txHash: tx.txid,
        direction,
        amount,
        fee: parseInt(tx.fees, 10) || 0,
        timestamp: tx.blockTime ?? 0,
        blockHeight: tx.blockHeight ?? 0,
        confirmed: tx.confirmations > 0,
        counterparties,
      };
    });
  }

  async estimateFee(blocks: number): Promise<number> {
    try {
      // Primary: Blockbook's own fee estimation
      const data = await this.fetchJson<{
        result: string;
      }>(`/api/v2/estimatefee/${blocks}`);

      const rate = parseFloat(data.result);
      if (rate > 0) return rate; // BTC/kB

      // If rate is 0 or negative, fall through to mempool fallback
    } catch {
      // Blockbook fee estimation failed, fall through
    }

    // Fallback: mempool.space (matches production BlockbookClient behavior)
    return this.estimateFeeFromMempool(blocks);
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  /**
   * Fallback fee estimation from mempool.space.
   * Matches production blockbook-client.js _estimateFeeFromMempool().
   */
  private async estimateFeeFromMempool(blocks: number): Promise<number> {
    const response = await native.net.fetch(MEMPOOL_FEE_URL);

    if (response.status !== 200) {
      throw new Error('Fee estimation failed from both Blockbook and mempool.space');
    }

    const bodyText = response.body
      ? native.encoding.utf8Decode(response.body)
      : '';
    const data = JSON.parse(bodyText) as {
      fastestFee: number;
      halfHourFee: number;
      hourFee: number;
      economyFee: number;
    };

    // Select tier by block target
    let satPerVb: number;
    if (blocks <= 1) {
      satPerVb = data.fastestFee;
    } else if (blocks <= 3) {
      satPerVb = data.halfHourFee;
    } else if (blocks <= 6) {
      satPerVb = data.hourFee;
    } else {
      satPerVb = data.economyFee;
    }

    // Convert sat/vB → BTC/kB: (satPerVb * 1000) / 1e8
    // This matches production's division by 100_000
    return satPerVb / 100_000;
  }

  private async fetchJson<T>(path: string): Promise<T> {
    const response = await native.net.fetch(`${this.baseUrl}${path}`);

    if (response.status !== 200) {
      const body = response.body
        ? native.encoding.utf8Decode(response.body)
        : '';
      throw new Error(
        `Blockbook API error: status ${response.status} for ${path}: ${body}`,
      );
    }

    const bodyText = response.body
      ? native.encoding.utf8Decode(response.body)
      : '';
    return JSON.parse(bodyText) as T;
  }
}
