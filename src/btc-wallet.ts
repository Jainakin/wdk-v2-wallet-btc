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
import { selectUtxos } from './utxo.js';
import { buildTransaction } from './transaction.js';
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
    return generateSegwitAddress(keyHandle, this.isTestnet);
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
    const utxos: UTXO[] = electrumUtxos.map((u) => ({
      txid: u.tx_hash,
      vout: u.tx_pos,
      value: u.value,
      scriptPubKey: '',
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

    return detailed.map((tx) => ({
      txHash: tx.txHash,
      chain: 'btc' as const,
      from: tx.direction === 'received'
        ? (tx.counterparties[0] ?? '')
        : address,
      to: tx.direction === 'sent'
        ? (tx.counterparties[0] ?? '')
        : address,
      amount: String(Math.abs(tx.amount)),
      fee: String(tx.fee),
      direction: tx.direction,
      timestamp: tx.timestamp,
      status: tx.confirmed ? ('confirmed' as const) : ('pending' as const),
      blockNumber: tx.blockHeight > 0 ? tx.blockHeight : undefined,
    }));
  }

  // -----------------------------------------------------------------------
  // Cleanup
  // -----------------------------------------------------------------------

  override destroy(): void {
    if (this.client) {
      this.client.close().catch(() => {});
    }
    super.destroy();
  }
}
