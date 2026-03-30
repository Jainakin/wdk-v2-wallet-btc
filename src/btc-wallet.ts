/**
 * BitcoinWallet — concrete BaseWallet implementation for Bitcoin
 * (BIP-84 native SegWit / P2WPKH).
 *
 * Depends on:
 *   - native.crypto.*   for all cryptographic operations
 *   - native.encoding.* for hex / bech32 encoding
 *   - IBtcClient        for all chain data access (balance, UTXOs, fees, broadcast)
 *
 * All chain data access goes through the pluggable IBtcClient interface,
 * matching the production tetherto/wdk-wallet-btc architecture.
 * This file NEVER calls native.net.fetch directly.
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
import { generateSegwitAddress } from './address.js';
import { selectUtxos, calculateMaxSpendable, DUST_THRESHOLD_P2WPKH, MIN_TX_FEE_SATS } from './utxo.js';
import { buildTransaction, addressToScriptPubKey } from './transaction.js';
import type { IBtcClient } from './client/btc-client.js';
import { createClient, MempoolRestClient } from './client/index.js';
import type { UTXO, BtcUnsignedTx, BtcNetwork } from './types.js';

export class BitcoinWallet extends BaseWallet {
  private isTestnet: boolean = false;
  private network: BtcNetwork = 'bitcoin';
  private client!: IBtcClient;

  constructor() {
    super('btc', 0, 'secp256k1');
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  async initialize(config: NetworkConfig): Promise<void> {
    await super.initialize(config);

    // Determine network — match production WDK pattern
    this.network = (config.network as BtcNetwork)
      ?? (config.isTestnet ? 'testnet' : 'bitcoin');
    this.isTestnet = this.network !== 'bitcoin';

    // Fix coin type: 0 for mainnet, 1 for testnet/regtest (BIP-44 standard)
    this.coinType = this.network === 'bitcoin' ? 0 : 1;

    // Create or accept the chain data client
    if (config.btcClient) {
      this.client = createClient(config.btcClient, this.network);
    } else {
      // Default: MempoolRestClient (preserves current working behavior)
      this.client = new MempoolRestClient(this.network);
    }

    await this.client.connect();
  }

  /**
   * BTC native SegWit (P2WPKH) uses BIP-84: m/84'/coinType'/account'/change/index
   * coinType is set dynamically in initialize(): 0 for mainnet, 1 for testnet.
   */
  override getDerivationPath(index: number): string {
    return `m/84'/${this.coinType}'/0'/0/${index}`;
  }

  // -----------------------------------------------------------------------
  // Address
  // -----------------------------------------------------------------------

  async getAddress(keyHandle: KeyHandle, _index: number): Promise<string> {
    return generateSegwitAddress(keyHandle, this.isTestnet, this.network);
  }

  // -----------------------------------------------------------------------
  // Balance
  // -----------------------------------------------------------------------

  /**
   * Fetch the confirmed balance for a Bitcoin address (in satoshis).
   * Delegates to IBtcClient.getBalance().
   */
  async getBalance(address: string): Promise<string> {
    const balance = await this.client.getBalance(address);
    return String(balance.confirmed);
  }

  // -----------------------------------------------------------------------
  // Fee rates
  // -----------------------------------------------------------------------

  /**
   * Get current fee rates in sat/vB for different priority levels.
   * Matches production WDK's fee rate exposure.
   */
  async getFeeRates(): Promise<{
    fast: number;    // ~1 block target
    medium: number;  // ~3 block target
    slow: number;    // ~6 block target
  }> {
    const [fast, medium, slow] = await Promise.all([
      this.client.estimateFee(1),
      this.client.estimateFee(3),
      this.client.estimateFee(6),
    ]);
    // Convert BTC/kB → sat/vB
    const toSatVb = (btcPerKb: number) => Math.ceil((btcPerKb * 1e8) / 1000);
    return {
      fast: toSatVb(fast),
      medium: toSatVb(medium),
      slow: toSatVb(slow),
    };
  }

  // -----------------------------------------------------------------------
  // Quote + Max Spendable (production parity: quoteSendTransaction, getMaxSpendable)
  // -----------------------------------------------------------------------

  /**
   * Preview a send transaction without signing or broadcasting.
   * Returns estimated fee, input/output counts, and whether the tx is feasible.
   * Matches production WDK's quoteSendTransaction().
   */
  async quoteSendTransaction(params: {
    from: string;
    to: string;
    amount: string;
  }): Promise<{
    feasible: boolean;
    fee: number;
    feeRate: number;
    inputCount: number;
    outputCount: number;
    totalInput: number;
    change: number;
    error?: string;
  }> {
    const targetSats = parseInt(params.amount, 10);
    if (isNaN(targetSats) || targetSats <= 0) {
      return {
        feasible: false, fee: 0, feeRate: 0, inputCount: 0,
        outputCount: 0, totalInput: 0, change: 0,
        error: `Invalid amount: ${params.amount}`,
      };
    }

    try {
      const electrumUtxos = await this.client.listUnspent(params.from);
      const utxos: UTXO[] = electrumUtxos.map((u) => ({
        txid: u.tx_hash, vout: u.tx_pos, value: u.value,
        scriptPubKey: '', address: params.from,
      }));

      const btcPerKb = await this.client.estimateFee(3);
      const feeRate = Math.ceil((btcPerKb * 1e8) / 1000);

      const selection = selectUtxos(utxos, targetSats, feeRate, DUST_THRESHOLD_P2WPKH, params.to);
      if (!selection) {
        return {
          feasible: false, fee: 0, feeRate, inputCount: 0,
          outputCount: 0, totalInput: utxos.reduce((s, u) => s + u.value, 0), change: 0,
          error: 'Insufficient funds',
        };
      }

      return {
        feasible: true,
        fee: selection.fee,
        feeRate,
        inputCount: selection.selected.length,
        outputCount: selection.change > 0 ? 2 : 1,
        totalInput: selection.selected.reduce((s, u) => s + u.value, 0),
        change: selection.change,
        changeValue: selection.change, // production alias
      };
    } catch (e: any) {
      return {
        feasible: false, fee: 0, feeRate: 0, inputCount: 0,
        outputCount: 0, totalInput: 0, change: 0,
        error: e.message ?? String(e),
      };
    }
  }

  /**
   * Calculate the maximum amount that can be sent from an address.
   * Accounts for fee, dust threshold, and MAX_UTXO_INPUTS.
   * Matches production WDK's getMaxSpendable().
   */
  async getMaxSpendable(address: string): Promise<{
    maxSpendable: number;
    fee: number;
    utxoCount: number;
  }> {
    const electrumUtxos = await this.client.listUnspent(address);
    const utxos: UTXO[] = electrumUtxos.map((u) => ({
      txid: u.tx_hash, vout: u.tx_pos, value: u.value,
      scriptPubKey: '', address,
    }));

    const btcPerKb = await this.client.estimateFee(3);
    const feeRate = Math.ceil((btcPerKb * 1e8) / 1000);

    const maxSpendable = calculateMaxSpendable(utxos, feeRate, DUST_THRESHOLD_P2WPKH);
    const totalInput = utxos.reduce((s, u) => s + u.value, 0);

    return {
      maxSpendable,
      amount: maxSpendable, // production alias
      fee: totalInput - maxSpendable,
      utxoCount: utxos.length,
    };
  }

  // -----------------------------------------------------------------------
  // Build transaction
  // -----------------------------------------------------------------------

  /**
   * Build an unsigned Bitcoin transaction.
   *
   * Steps:
   *   1. Fetch UTXOs via IBtcClient.listUnspent()
   *   2. Estimate fees via IBtcClient.estimateFee()
   *   3. Select coins
   *   4. Construct the unsigned transaction envelope
   */
  async buildTransaction(params: TxParams): Promise<UnsignedTx> {
    const { to, amount } = params;
    const targetSats = parseInt(amount, 10);
    if (isNaN(targetSats) || targetSats <= 0) {
      throw new Error(`Invalid amount: ${amount}`);
    }

    const fromAddress = params.from;
    if (!fromAddress) {
      throw new Error(
        'Sender address must be provided in params.from for BTC transactions',
      );
    }

    // 1. Fetch UTXOs via client interface
    const electrumUtxos = await this.client.listUnspent(fromAddress);
    // Derive scriptPubKey from the sender address (needed for signing/PSBT)
    const senderScriptPubKey = native.encoding.hexEncode(
      addressToScriptPubKey(fromAddress)
    );
    const utxos: UTXO[] = electrumUtxos.map((u) => ({
      txid: u.tx_hash,
      vout: u.tx_pos,
      value: u.value,
      scriptPubKey: senderScriptPubKey,
      address: fromAddress,
      confirmations: u.height > 0 ? 1 : 0,
    }));

    if (utxos.length === 0) {
      throw new Error('No UTXOs available for address');
    }

    // 2. Estimate fee rate via client interface
    // IBtcClient.estimateFee returns BTC/kB (production convention)
    // Convert to sat/vB: (btcPerKb * 1e8) / 1000
    const btcPerKb = await this.client.estimateFee(3); // medium priority (~3 blocks)
    const feeRate = Math.ceil((btcPerKb * 1e8) / 1000);

    // 3. Coin selection
    const selection = selectUtxos(utxos, targetSats, feeRate, DUST_THRESHOLD_P2WPKH, to);
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

  async signTransaction(
    tx: UnsignedTx,
    keyHandle: KeyHandle,
  ): Promise<SignedTx> {
    const btcTx = tx.data as BtcUnsignedTx;
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
   * Delegates to IBtcClient.broadcast().
   */
  async broadcastTransaction(tx: SignedTx): Promise<string> {
    const rawTx = typeof tx.rawTx === 'string'
      ? tx.rawTx
      : native.encoding.hexEncode(tx.rawTx);
    return this.client.broadcast(rawTx);
  }

  // -----------------------------------------------------------------------
  // Transaction history
  // -----------------------------------------------------------------------

  /**
   * Fetch transaction history with full parsed details.
   * Uses IBtcClient.getDetailedHistory() which returns direction, amounts,
   * fees, counterparties — parsed from full transaction data.
   */
  async getTransactionHistory(
    address: string,
    limit: number = 25,
  ): Promise<TxRecord[]> {
    const detailed = await this.client.getDetailedHistory(address, limit);

    return detailed.map((tx) => {
      // Deduplicate counterparties
      const uniqueCounterparties = [...new Set(tx.counterparties)];
      return {
        txHash: tx.txHash,
        chain: 'btc' as const,
        // Primary from/to for backwards compat (first counterparty)
        from: tx.direction === 'received'
          ? (uniqueCounterparties[0] ?? '')
          : address,
        to: tx.direction === 'sent'
          ? (uniqueCounterparties[0] ?? '')
          : address,
        amount: String(Math.abs(tx.amount)),
        fee: String(tx.fee),
        direction: tx.direction,
        // Full counterparty list (deduplicated)
        counterparties: uniqueCounterparties,
        timestamp: tx.timestamp,
        status: tx.confirmed ? ('confirmed' as const) : ('pending' as const),
        blockNumber: tx.blockHeight > 0 ? tx.blockHeight : undefined,
      };
    });
  }

  // -----------------------------------------------------------------------
  // Transaction receipt
  // -----------------------------------------------------------------------

  /**
   * Get the confirmation status of a transaction.
   * Matches production WDK's getTransactionReceipt().
   */
  async getTransactionReceipt(txHash: string): Promise<{
    txHash: string;
    confirmed: boolean;
    blockHeight: number;
    blockTime: number;
    fee: number;
  }> {
    // getTxStatus is now part of IBtcClient — no duck-typing needed
    return this.client.getTxStatus(txHash);
  }

  // -----------------------------------------------------------------------
  // Cleanup
  // -----------------------------------------------------------------------

  override destroy(): void {
    // Close client and clear its caches (LRU tx cache, etc.)
    if (this.client) {
      this.client.close().catch(() => {});
    }
    // Null out references to prevent accidental reuse
    // Note: actual key material lives in the C key_store which
    // zeroes bytes on releaseKey(). The JS layer only holds handles (integers).
    this.network = 'bitcoin';
    this.isTestnet = false;
    super.destroy();
  }
}
