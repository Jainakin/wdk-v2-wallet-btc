/**
 * BitcoinWallet — concrete BaseWallet implementation for Bitcoin
 * (BIP-84 native SegWit / P2WPKH).
 *
 * Depends on:
 *   - native.crypto.*  for all cryptographic operations
 *   - native.encoding.* for hex / bech32 encoding
 *   - native.net.fetch  for HTTP calls (mempool.space API)
 */

import { BaseWallet } from '@aspect/wdk-v2-core';
import type {
  KeyHandle,
  NetworkConfig,
  TxParams,
  UnsignedTx,
  SignedTx,
  TxRecord,
} from '@aspect/wdk-v2-utils';
import { generateSegwitAddress, deriveAddress } from './address.js';
import { selectUtxos } from './utxo.js';
import { buildTransaction } from './transaction.js';
import { estimateFees } from './fees.js';
import type { UTXO, BtcUnsignedTx } from './types.js';

export class BitcoinWallet extends BaseWallet {
  private isTestnet: boolean = false;

  constructor() {
    super('btc', 0, 'secp256k1');
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  async initialize(config: NetworkConfig): Promise<void> {
    await super.initialize(config);
    this.isTestnet = config.isTestnet;
  }

  // -----------------------------------------------------------------------
  // Address
  // -----------------------------------------------------------------------

  /**
   * Generate a SegWit address for the given key handle.
   * The keyHandle should already be derived to the correct BIP-84 path.
   */
  async getAddress(keyHandle: KeyHandle, _index: number): Promise<string> {
    return generateSegwitAddress(keyHandle, this.isTestnet);
  }

  // -----------------------------------------------------------------------
  // Balance
  // -----------------------------------------------------------------------

  /**
   * Fetch the confirmed balance for a Bitcoin address (in satoshis).
   * Uses the mempool.space REST API.
   */
  async getBalance(address: string): Promise<string> {
    const baseUrl = this.getApiBaseUrl();
    const response = await native.net.fetch(`${baseUrl}/address/${address}`);

    if (response.status !== 200) {
      throw new Error(
        `Failed to fetch balance: status ${response.status}`,
      );
    }

    const data = JSON.parse(response.body) as {
      chain_stats: { funded_txo_sum: number; spent_txo_sum: number };
      mempool_stats: { funded_txo_sum: number; spent_txo_sum: number };
    };

    const confirmed =
      data.chain_stats.funded_txo_sum - data.chain_stats.spent_txo_sum;
    return String(confirmed);
  }

  // -----------------------------------------------------------------------
  // Build transaction
  // -----------------------------------------------------------------------

  /**
   * Build an unsigned Bitcoin transaction.
   *
   * Steps:
   *   1. Fetch UTXOs for the sender address
   *   2. Estimate fees
   *   3. Select coins
   *   4. Construct the unsigned transaction envelope
   */
  async buildTransaction(params: TxParams): Promise<UnsignedTx> {
    const { to, amount } = params;
    const targetSats = parseInt(amount, 10);
    if (isNaN(targetSats) || targetSats <= 0) {
      throw new Error(`Invalid amount: ${amount}`);
    }

    // We need the sender address — derive from the config or require it
    // For now we use the `memo` field to pass the sender address
    const fromAddress = params.memo;
    if (!fromAddress) {
      throw new Error(
        'Sender address must be provided in params.memo for BTC transactions',
      );
    }

    // 1. Fetch UTXOs
    const utxos = await this.fetchUtxos(fromAddress);
    if (utxos.length === 0) {
      throw new Error('No UTXOs available for address');
    }

    // 2. Estimate fee rate
    const fees = await estimateFees(this.isTestnet);
    const feeRate = fees.medium; // default to medium priority

    // 3. Coin selection
    const selection = selectUtxos(utxos, targetSats, feeRate);
    if (!selection) {
      throw new Error('Insufficient funds');
    }

    // 4. Build the unsigned tx structure
    const inputs = selection.selected.map((u) => ({
      txid: u.txid,
      vout: u.vout,
      value: u.value,
      scriptPubKey: u.scriptPubKey,
    }));

    const outputs: { address: string; value: number }[] = [
      { address: to, value: targetSats },
    ];

    // Add change output if there is change
    if (selection.change > 0) {
      outputs.push({ address: fromAddress, value: selection.change });
    }

    const btcUnsignedTx: BtcUnsignedTx = {
      inputs,
      outputs,
      changeAddress: fromAddress,
      fee: selection.fee,
    };

    return {
      chain: 'btc',
      data: btcUnsignedTx,
      estimatedFee: String(selection.fee),
    };
  }

  // -----------------------------------------------------------------------
  // Sign transaction
  // -----------------------------------------------------------------------

  /**
   * Sign a previously built unsigned transaction.
   *
   * The keyHandle should be the account-level key; individual input
   * keys are derived from it at the same path used when the UTXOs
   * were received.  For simplicity, we assume all inputs belong to
   * the same key (index 0 of the external chain).
   */
  async signTransaction(
    tx: UnsignedTx,
    keyHandle: KeyHandle,
  ): Promise<SignedTx> {
    const btcTx = tx.data as BtcUnsignedTx;

    // Use the same key handle for all inputs (single-address wallet)
    const keyHandles = btcTx.inputs.map(() => keyHandle);

    const signed = buildTransaction(btcTx.inputs, btcTx.outputs, keyHandles);

    return {
      chain: 'btc',
      rawTx: signed.rawTx,
      txHash: signed.txid,
    };
  }

  // -----------------------------------------------------------------------
  // Broadcast
  // -----------------------------------------------------------------------

  /**
   * Broadcast a signed transaction to the Bitcoin network.
   * Uses the mempool.space POST /tx endpoint.
   *
   * @returns The transaction ID (txid)
   */
  async broadcastTransaction(tx: SignedTx): Promise<string> {
    const baseUrl = this.getApiBaseUrl();
    const rawTx = typeof tx.rawTx === 'string'
      ? tx.rawTx
      : native.encoding.hexEncode(tx.rawTx);

    const response = await native.net.fetch(`${baseUrl}/tx`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: rawTx,
    });

    if (response.status !== 200) {
      throw new Error(
        `Broadcast failed (status ${response.status}): ${response.body}`,
      );
    }

    // mempool.space returns the txid as plain text
    return response.body.trim();
  }

  // -----------------------------------------------------------------------
  // Transaction history
  // -----------------------------------------------------------------------

  /**
   * Fetch transaction history for an address.
   * Uses mempool.space /address/{addr}/txs endpoint.
   */
  async getTransactionHistory(
    address: string,
    limit: number = 25,
  ): Promise<TxRecord[]> {
    const baseUrl = this.getApiBaseUrl();
    const response = await native.net.fetch(
      `${baseUrl}/address/${address}/txs`,
    );

    if (response.status !== 200) {
      throw new Error(
        `Failed to fetch tx history: status ${response.status}`,
      );
    }

    const txs = JSON.parse(response.body) as Array<{
      txid: string;
      status: { confirmed: boolean; block_time?: number; block_height?: number };
      vin: Array<{ prevout?: { scriptpubkey_address?: string; value?: number } }>;
      vout: Array<{ scriptpubkey_address?: string; value?: number }>;
    }>;

    const records: TxRecord[] = [];

    for (const tx of txs.slice(0, limit)) {
      // Determine direction: if any input belongs to our address, it's outgoing
      const isOutgoing = tx.vin.some(
        (v) => v.prevout?.scriptpubkey_address === address,
      );

      // Find the counterparty address and amount
      let counterparty = '';
      let amount = 0;

      if (isOutgoing) {
        // Find the first output NOT to our address
        for (const out of tx.vout) {
          if (out.scriptpubkey_address && out.scriptpubkey_address !== address) {
            counterparty = out.scriptpubkey_address;
            amount = out.value ?? 0;
            break;
          }
        }
      } else {
        // Incoming: sum outputs to our address
        for (const out of tx.vout) {
          if (out.scriptpubkey_address === address) {
            amount += out.value ?? 0;
          }
        }
        // Sender is the first input's address
        counterparty = tx.vin[0]?.prevout?.scriptpubkey_address ?? '';
      }

      records.push({
        txHash: tx.txid,
        chain: 'btc',
        from: isOutgoing ? address : counterparty,
        to: isOutgoing ? counterparty : address,
        amount: String(amount),
        timestamp: tx.status.block_time ?? 0,
        status: tx.status.confirmed ? 'confirmed' : 'pending',
        blockNumber: tx.status.block_height,
      });
    }

    return records;
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /** Get the mempool.space API base URL for the current network. */
  private getApiBaseUrl(): string {
    return this.isTestnet
      ? 'https://mempool.space/testnet/api'
      : 'https://mempool.space/api';
  }

  /**
   * Fetch UTXOs for an address from mempool.space.
   * Endpoint: GET /address/{addr}/utxo
   */
  private async fetchUtxos(address: string): Promise<UTXO[]> {
    const baseUrl = this.getApiBaseUrl();
    const response = await native.net.fetch(
      `${baseUrl}/address/${address}/utxo`,
    );

    if (response.status !== 200) {
      throw new Error(
        `Failed to fetch UTXOs: status ${response.status}`,
      );
    }

    const rawUtxos = JSON.parse(response.body) as Array<{
      txid: string;
      vout: number;
      value: number;
      status: { confirmed: boolean; block_height?: number };
    }>;

    return rawUtxos.map((u) => ({
      txid: u.txid,
      vout: u.vout,
      value: u.value,
      scriptPubKey: '', // mempool.space UTXO endpoint doesn't include this
      address,
      confirmations: u.status.confirmed ? 1 : 0,
    }));
  }
}
