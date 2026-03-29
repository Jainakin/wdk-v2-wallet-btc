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
import type { BtcBalance, ElectrumUnspent, ElectrumHistoryEntry, BtcNetwork } from '../types.js';

/** Default mempool.space base URLs per network */
const BASE_URLS: Record<BtcNetwork, string> = {
  bitcoin: 'https://mempool.space/api',
  testnet: 'https://mempool.space/testnet4/api',
  regtest: 'https://mempool.space/api', // regtest needs user-provided URL
};

export class MempoolRestClient implements IBtcClient {
  private readonly baseUrl: string;

  constructor(network: BtcNetwork = 'bitcoin', customUrl?: string) {
    this.baseUrl = customUrl
      ? customUrl.replace(/\/$/, '')
      : BASE_URLS[network];
  }

  async connect(): Promise<void> { /* no-op for HTTP REST */ }
  async close(): Promise<void> { /* no-op */ }
  async reconnect(): Promise<void> { /* no-op */ }

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

  async getTransaction(txHash: string): Promise<string> {
    return this.fetchText(`/tx/${txHash}/hex`);
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
