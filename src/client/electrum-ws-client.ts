/**
 * ElectrumWsClient — IBtcClient implementation using Electrum JSON-RPC 2.0
 * over WebSocket.
 *
 * Matches the production tetherto/wdk-wallet-btc transport pattern:
 *   - Uses scripthash (SHA256 of scriptPubKey, reversed) for all address queries
 *   - Supports blockchain.scripthash.subscribe for real-time notifications
 *   - LRU cache for transaction hex lookups
 *   - ConcurrencyLimiter for parallel requests
 *
 * Connection: wss://blockstream.info/electrum-websocket (mainnet)
 *             wss://blockstream.info/testnet/electrum-websocket (testnet)
 */

import type { IBtcClient } from './btc-client.js';
import type {
  BtcBalance,
  ElectrumUnspent,
  ElectrumHistoryEntry,
  DetailedTxInfo,
  BtcNetwork,
} from '../types.js';
import { ElectrumTransport } from './electrum-transport.js';
import { ELECTRUM_WS_URLS } from './electrum-types.js';
import { addressToScriptPubKey } from '../transaction.js';
import { LRUCache, ConcurrencyLimiter } from '../cache.js';

export class ElectrumWsClient implements IBtcClient {
  private transport: ElectrumTransport;
  private readonly network: BtcNetwork;
  private readonly url: string;
  private readonly txCache = new LRUCache<string, string>(100);
  private readonly limiter = new ConcurrencyLimiter(8);
  private activeSubscriptions: Map<string, (status: string | null) => void> = new Map();

  constructor(network: BtcNetwork = 'bitcoin', customUrl?: string) {
    this.network = network;
    this.url = customUrl ?? ELECTRUM_WS_URLS[network];
    if (!this.url) {
      throw new Error(
        `ElectrumWsClient: no default URL for ${network}. Provide a custom URL.`
      );
    }
    this.transport = new ElectrumTransport();
  }

  // ── Connection lifecycle ────────────────────────────────────────────────

  async connect(): Promise<void> {
    const info = await this.transport.connect(this.url);
    // Set up subscription notification handler
    this.transport.onNotification(
      'blockchain.scripthash.subscribe',
      (params: unknown[]) => {
        const [scripthash, status] = params as [string, string | null];
        const handler = this.activeSubscriptions.get(scripthash);
        if (handler) handler(status);
      },
    );
  }

  async close(): Promise<void> {
    this.transport.close();
    this.txCache.clear();
    this.activeSubscriptions.clear();
  }

  async reconnect(): Promise<void> {
    this.transport.close();
    await this.connect();
  }

  // ── Scripthash computation ──────────────────────────────────────────────

  /**
   * Convert a Bitcoin address to Electrum scripthash.
   * scripthash = reverse(SHA256(scriptPubKey))
   */
  private addressToScripthash(address: string): string {
    const spk = addressToScriptPubKey(address);
    const hash = native.crypto.sha256(spk);
    // Reverse byte order (Electrum convention)
    const reversed = new Uint8Array(hash.length);
    for (let i = 0; i < hash.length; i++) {
      reversed[i] = hash[hash.length - 1 - i];
    }
    return native.encoding.hexEncode(reversed);
  }

  // ── IBtcClient methods ──────────────────────────────────────────────────

  async getBalance(address: string): Promise<BtcBalance> {
    const scripthash = this.addressToScripthash(address);
    const result = await this.limiter.run(() =>
      this.transport.request('blockchain.scripthash.get_balance', [scripthash])
    ) as { confirmed: number; unconfirmed: number };

    return {
      confirmed: result.confirmed,
      unconfirmed: result.unconfirmed,
    };
  }

  async listUnspent(address: string): Promise<ElectrumUnspent[]> {
    const scripthash = this.addressToScripthash(address);
    const result = await this.limiter.run(() =>
      this.transport.request('blockchain.scripthash.listunspent', [scripthash])
    ) as Array<{ tx_hash: string; tx_pos: number; value: number; height: number }>;

    return result.map((u) => ({
      tx_hash: u.tx_hash,
      tx_pos: u.tx_pos,
      value: u.value,
      height: u.height,
    }));
  }

  async getHistory(address: string): Promise<ElectrumHistoryEntry[]> {
    const scripthash = this.addressToScripthash(address);
    const result = await this.limiter.run(() =>
      this.transport.request('blockchain.scripthash.get_history', [scripthash])
    ) as Array<{ tx_hash: string; height: number }>;

    return result.map((h) => ({
      tx_hash: h.tx_hash,
      height: h.height,
    }));
  }

  async getDetailedHistory(
    address: string,
    limit: number = 25,
    _afterTxId?: string,
    _page?: number,
  ): Promise<DetailedTxInfo[]> {
    const history = await this.getHistory(address);
    const entries = history.slice(0, limit);

    // Batch-fetch transaction details
    const batchCalls = entries.map((h) => ({
      method: 'blockchain.transaction.get',
      params: [h.tx_hash, true], // verbose=true
    }));

    const txDetails = await this.transport.batch(batchCalls) as Array<{
      txid: string;
      vin: Array<{ prevout?: { scriptpubkey_address?: string; value: number } }>;
      vout: Array<{ scriptpubkey_address?: string; value: number }>;
      fee: number;
      status?: { confirmed: boolean; block_height?: number; block_time?: number };
      confirmations?: number;
      blocktime?: number;
      blockhash?: string;
    }>;

    return txDetails.map((tx) => {
      const inputAddresses = new Set<string>();
      let totalIn = 0;
      for (const vin of tx.vin) {
        if (vin.prevout?.scriptpubkey_address) {
          inputAddresses.add(vin.prevout.scriptpubkey_address);
          totalIn += vin.prevout.value;
        }
      }

      const outputAddresses = new Set<string>();
      let totalOut = 0;
      let myOut = 0;
      for (const vout of tx.vout) {
        if (vout.scriptpubkey_address) {
          outputAddresses.add(vout.scriptpubkey_address);
          totalOut += vout.value;
          if (vout.scriptpubkey_address === address) myOut += vout.value;
        }
      }

      const isSender = inputAddresses.has(address);
      const isReceiver = outputAddresses.has(address);
      const direction: 'sent' | 'received' | 'self' =
        isSender && isReceiver ? 'self' :
        isSender ? 'sent' : 'received';

      let amount = 0;
      if (direction === 'received') {
        amount = myOut;
      } else if (direction === 'sent') {
        amount = totalIn - myOut - (tx.fee ?? 0);
      }

      const counterparties: string[] = [];
      if (direction === 'sent') {
        outputAddresses.forEach((a) => { if (a !== address) counterparties.push(a); });
      } else if (direction === 'received') {
        inputAddresses.forEach((a) => { if (a !== address) counterparties.push(a); });
      }

      const confirmed = (tx.confirmations ?? 0) > 0;
      const height = entries.find((h) => h.tx_hash === tx.txid)?.height ?? 0;

      return {
        txHash: tx.txid,
        direction,
        amount,
        fee: tx.fee ?? 0,
        timestamp: tx.blocktime ?? 0,
        blockHeight: height > 0 ? height : 0,
        confirmed,
        counterparties: [...new Set(counterparties)],
      };
    });
  }

  async getTransaction(txHash: string): Promise<string> {
    // Check cache
    const cached = this.txCache.get(txHash);
    if (cached !== undefined) return cached;

    const hex = await this.limiter.run(() =>
      this.transport.request('blockchain.transaction.get', [txHash, false])
    ) as string;

    this.txCache.set(txHash, hex);
    return hex;
  }

  async estimateFee(blocks: number): Promise<number> {
    const result = await this.limiter.run(() =>
      this.transport.request('blockchain.estimatefee', [blocks])
    ) as number;

    // Returns BTC/kB, or -1 if insufficient data
    if (result < 0) return 0.00001; // fallback: 1 sat/vB
    return result;
  }

  async broadcast(rawTx: string): Promise<string> {
    const txid = await this.transport.request(
      'blockchain.transaction.broadcast',
      [rawTx],
    ) as string;
    return txid;
  }

  async getTxStatus(txHash: string): Promise<{
    txHash: string;
    confirmed: boolean;
    blockHeight: number;
    blockTime: number;
    fee: number;
  }> {
    const tx = await this.limiter.run(() =>
      this.transport.request('blockchain.transaction.get', [txHash, true])
    ) as {
      txid: string;
      confirmations?: number;
      blocktime?: number;
      fee?: number;
    };

    const height = await this.getBlockHeightForTx(txHash);

    return {
      txHash: tx.txid,
      confirmed: (tx.confirmations ?? 0) > 0,
      blockHeight: height,
      blockTime: tx.blocktime ?? 0,
      fee: tx.fee ?? 0,
    };
  }

  // ── Subscription support ────────────────────────────────────────────────

  /**
   * Subscribe to address balance changes.
   * The callback fires when the address's transaction history changes.
   */
  async subscribeAddress(
    address: string,
    callback: (status: string | null) => void,
  ): Promise<string | null> {
    const scripthash = this.addressToScripthash(address);
    this.activeSubscriptions.set(scripthash, callback);

    // Initial subscribe — returns current status
    const status = await this.transport.request(
      'blockchain.scripthash.subscribe',
      [scripthash],
    ) as string | null;

    return status;
  }

  /**
   * Unsubscribe from address balance changes.
   */
  unsubscribeAddress(address: string): void {
    const scripthash = this.addressToScripthash(address);
    this.activeSubscriptions.delete(scripthash);
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private async getBlockHeightForTx(txHash: string): Promise<number> {
    // Get from history which includes height
    // This is a simplification — production would track this differently
    return 0;
  }
}
