/**
 * MempoolRestClient — IBtcClient implementation using the mempool.space REST API.
 *
 * Wraps our existing mempool.space logic behind the production IBtcClient interface.
 * Fixes the testnet3/testnet4 URL mismatch (consistently uses testnet4).
 *
 * Endpoints:
 *   GET /address/{addr}          → getBalance
 *   GET /address/{addr}/utxo     → listUnspent
 *   GET /address/{addr}/txs      → getHistory  (rich data, mapped to Electrum shape)
 *   GET /tx/{txHash}/hex         → getTransaction
 *   POST /tx                     → broadcast
 *   GET /v1/fees/recommended     → estimateFee  (converts sat/vB → BTC/kB)
 */

import type { IBtcClient } from './btc-client.js';
import type { BtcBalance, ElectrumUnspent, ElectrumHistoryEntry, DetailedTxInfo, BtcNetwork } from '../types.js';
import { LRUCache } from '../cache.js';

/** Default mempool.space base URLs per network */
const BASE_URLS: Record<BtcNetwork, string> = {
  bitcoin: 'https://mempool.space/api',
  testnet: 'https://mempool.space/testnet4/api',
  regtest: 'https://mempool.space/api', // regtest needs user-provided URL
};

export class MempoolRestClient implements IBtcClient {
  private readonly baseUrl: string;
  /** LRU cache for raw transaction hex (avoids re-fetching same tx) */
  private readonly txCache = new LRUCache<string, string>(100);

  constructor(network: BtcNetwork = 'bitcoin', customUrl?: string) {
    this.baseUrl = customUrl
      ? customUrl.replace(/\/$/, '')
      : BASE_URLS[network];
  }

  async connect(): Promise<void> { /* no-op for HTTP REST */ }
  async close(): Promise<void> { this.txCache.clear(); }
  async reconnect(): Promise<void> { this.txCache.clear(); }

  async getBalance(address: string): Promise<BtcBalance> {
    const data = await this.fetchJson<{
      chain_stats: { funded_txo_sum: number; spent_txo_sum: number };
      mempool_stats: { funded_txo_sum: number; spent_txo_sum: number };
    }>(`/address/${address}`);

    const confirmed =
      data.chain_stats.funded_txo_sum - data.chain_stats.spent_txo_sum;
    const unconfirmed =
      data.mempool_stats.funded_txo_sum - data.mempool_stats.spent_txo_sum;

    return { confirmed, unconfirmed };
  }

  async listUnspent(address: string): Promise<ElectrumUnspent[]> {
    const rawUtxos = await this.fetchJson<Array<{
      txid: string;
      vout: number;
      value: number;
      status: { confirmed: boolean; block_height?: number };
    }>>(`/address/${address}/utxo`);

    return rawUtxos.map((u) => ({
      tx_hash: u.txid,
      tx_pos: u.vout,
      value: u.value,
      height: u.status.block_height ?? 0,
    }));
  }

  async getHistory(address: string): Promise<ElectrumHistoryEntry[]> {
    const txs = await this.fetchJson<Array<{
      txid: string;
      status: { confirmed: boolean; block_height?: number };
    }>>(`/address/${address}/txs`);

    return txs.map((tx) => ({
      tx_hash: tx.txid,
      height: tx.status.block_height ?? 0,
    }));
  }

  async getDetailedHistory(address: string, limit: number = 25): Promise<DetailedTxInfo[]> {
    // Mempool /address/{addr}/txs returns full transaction objects
    const txs = await this.fetchJson<Array<{
      txid: string;
      fee: number;
      vin: Array<{ prevout: { scriptpubkey_address?: string; value: number } | null }>;
      vout: Array<{ scriptpubkey_address?: string; value: number }>;
      status: { confirmed: boolean; block_height?: number; block_time?: number };
    }>>(`/address/${address}/txs`);

    return txs.slice(0, limit).map((tx) => {
      // Determine direction by checking if address appears in inputs/outputs
      const inputAddresses = new Set(
        tx.vin
          .filter((v) => v.prevout?.scriptpubkey_address)
          .map((v) => v.prevout!.scriptpubkey_address!)
      );
      const outputAddresses = new Set(
        tx.vout
          .filter((v) => v.scriptpubkey_address)
          .map((v) => v.scriptpubkey_address!)
      );

      const isInInput = inputAddresses.has(address);
      const isInOutput = outputAddresses.has(address);

      let direction: 'sent' | 'received' | 'self';
      if (isInInput && isInOutput) {
        // Could be self-transfer or change output — check if ALL outputs go to us
        const allOutputsToUs = tx.vout.every(
          (v) => !v.scriptpubkey_address || v.scriptpubkey_address === address
        );
        direction = allOutputsToUs ? 'self' : 'sent';
      } else if (isInInput) {
        direction = 'sent';
      } else {
        direction = 'received';
      }

      // Calculate net amount for this address
      let amount: number;
      if (direction === 'received') {
        amount = tx.vout
          .filter((v) => v.scriptpubkey_address === address)
          .reduce((sum, v) => sum + v.value, 0);
      } else if (direction === 'sent') {
        const totalIn = tx.vin
          .filter((v) => v.prevout?.scriptpubkey_address === address)
          .reduce((sum, v) => sum + (v.prevout?.value ?? 0), 0);
        const changeBack = tx.vout
          .filter((v) => v.scriptpubkey_address === address)
          .reduce((sum, v) => sum + v.value, 0);
        amount = -(totalIn - changeBack);
      } else {
        amount = 0;
      }

      // Counterparty addresses (addresses that aren't ours)
      const counterparties: string[] = [];
      if (direction === 'sent') {
        tx.vout.forEach((v) => {
          if (v.scriptpubkey_address && v.scriptpubkey_address !== address) {
            counterparties.push(v.scriptpubkey_address);
          }
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
        fee: tx.fee,
        timestamp: tx.status.block_time ?? 0,
        blockHeight: tx.status.block_height ?? 0,
        confirmed: tx.status.confirmed,
        counterparties,
      };
    });
  }

  async getTransaction(txHash: string): Promise<string> {
    // Check LRU cache first
    const cached = this.txCache.get(txHash);
    if (cached !== undefined) return cached;

    const hex = await this.fetchText(`/tx/${txHash}/hex`);
    this.txCache.set(txHash, hex);
    return hex;
  }

  /**
   * Get transaction confirmation status via mempool.space /tx/{txid} endpoint.
   * Used by btc-wallet's getTransactionReceipt().
   */
  async getTxStatus(txHash: string): Promise<{
    txHash: string;
    confirmed: boolean;
    blockHeight: number;
    blockTime: number;
    fee: number;
  }> {
    const data = await this.fetchJson<{
      txid: string;
      fee: number;
      status: {
        confirmed: boolean;
        block_height?: number;
        block_time?: number;
      };
    }>(`/tx/${txHash}`);

    return {
      txHash: data.txid,
      confirmed: data.status.confirmed,
      blockHeight: data.status.block_height ?? 0,
      blockTime: data.status.block_time ?? 0,
      fee: data.fee,
    };
  }

  async broadcast(rawTx: string): Promise<string> {
    const response = await native.net.fetch(`${this.baseUrl}/tx`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: rawTx,
    });

    const bodyStr = response.body
      ? native.encoding.utf8Decode(response.body)
      : '';

    if (response.status !== 200) {
      throw new Error(`Broadcast failed (status ${response.status}): ${bodyStr}`);
    }

    return bodyStr.trim();
  }

  async estimateFee(blocks: number): Promise<number> {
    const data = await this.fetchJson<{
      fastestFee: number;
      halfHourFee: number;
      hourFee: number;
      economyFee: number;
      minimumFee: number;
    }>('/v1/fees/recommended');

    // Select tier by block target (matches production BlockbookClient fallback)
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

    // Convert sat/vB → BTC/kB (production IBtcClient convention)
    // 1 kB = 1000 vbytes, 1 BTC = 1e8 sat
    // BTC/kB = satPerVb * 1000 / 1e8
    return (satPerVb * 1000) / 1e8;
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private async fetchJson<T>(path: string): Promise<T> {
    const response = await native.net.fetch(`${this.baseUrl}${path}`);

    if (response.status !== 200) {
      const body = response.body
        ? native.encoding.utf8Decode(response.body)
        : '';
      throw new Error(
        `Mempool API error: status ${response.status} for ${path}: ${body}`,
      );
    }

    const bodyText = response.body
      ? native.encoding.utf8Decode(response.body)
      : '';
    return JSON.parse(bodyText) as T;
  }

  private async fetchText(path: string): Promise<string> {
    const response = await native.net.fetch(`${this.baseUrl}${path}`);

    if (response.status !== 200) {
      const body = response.body
        ? native.encoding.utf8Decode(response.body)
        : '';
      throw new Error(
        `Mempool API error: status ${response.status} for ${path}: ${body}`,
      );
    }

    return response.body
      ? native.encoding.utf8Decode(response.body)
      : '';
  }
}
