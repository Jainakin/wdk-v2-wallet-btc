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
import { generateSegwitAddress, generateLegacyAddress, convertBits } from './address.js';
import type { BtcAddressType } from './address.js';
import { selectUtxos, calculateMaxSpendable, DUST_THRESHOLD_P2WPKH, MIN_TX_FEE_SATS } from './utxo.js';
import { addressToScriptPubKey } from './transaction.js';
import { buildAndSignPsbt } from './psbt.js';
import type { IBtcClient } from './client/btc-client.js';
import { createClient, MempoolRestClient } from './client/index.js';
import type { UTXO, BtcUnsignedTx, BtcNetwork, TransferQuery, TransferResult } from './types.js';

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
   * BTC legacy (P2PKH) uses BIP-44: m/44'/coinType'/account'/change/index
   * coinType is set dynamically in initialize(): 0 for mainnet, 1 for testnet.
   */
  override getDerivationPath(index: number, addressType?: string): string {
    const purpose = addressType === 'p2pkh' ? 44 : 84;
    return `m/${purpose}'/${this.coinType}'/0'/0/${index}`;
  }

  // -----------------------------------------------------------------------
  // Address
  // -----------------------------------------------------------------------

  async getAddress(keyHandle: KeyHandle, _index: number, addressType?: string): Promise<string> {
    if (addressType === 'p2pkh') {
      return generateLegacyAddress(keyHandle, this.isTestnet);
    }
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

    // Use PSBT (BIP-174) for signing — supports P2WPKH, P2PKH, mixed inputs
    const signed = buildAndSignPsbt(btcTx.inputs, btcTx.outputs, keyHandles);

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
  // Paginated transfers (production parity: getTransfers)
  // -----------------------------------------------------------------------

  /**
   * Get paginated, filterable transfer history.
   * Matches production WDK's getTransfers({direction, limit, skip}).
   *
   * @param address  The Bitcoin address to query
   * @param query    Optional: direction filter, limit, pagination cursor
   * @returns transfers array + hasMore flag + nextCursor for pagination
   */
  async getTransfers(
    address: string,
    query?: TransferQuery,
  ): Promise<TransferResult> {
    const limit = query?.limit ?? 25;
    const detailed = await this.client.getDetailedHistory(
      address, limit, query?.afterTxId, query?.page,
    );

    // Apply direction filter
    let filtered = detailed;
    if (query?.direction && query.direction !== 'all') {
      filtered = detailed.filter((tx) => tx.direction === query.direction);
    }

    // Deduplicate counterparties and map to TxRecord-compatible shape
    const transfers = filtered.map((tx) => ({
      ...tx,
      counterparties: [...new Set(tx.counterparties)],
    }));

    // Determine pagination state
    const hasMore = detailed.length >= limit;
    const nextCursor = detailed.length > 0
      ? detailed[detailed.length - 1].txHash
      : undefined;

    return { transfers, hasMore, nextCursor };
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
  // Message signing (Bitcoin Signed Message format)
  // -----------------------------------------------------------------------

  /**
   * Sign a message using the Bitcoin Signed Message standard.
   * Compatible with bitcoinjs-message / Electrum / Bitcoin Core signmessage.
   *
   * Format: double-SHA256 of "\x18Bitcoin Signed Message:\n" + varint(len) + message
   * Output: base64-encoded 65-byte signature (1 flag byte + 32r + 32s)
   *
   * @param message    The message string to sign
   * @param keyHandle  Key handle for the signing key
   * @returns base64-encoded signature string
   */
  async signMessage(message: string, keyHandle: KeyHandle): Promise<string> {
    const msgHash = this.bitcoinMessageHash(message);
    // Sign with recoverable signature → 65 bytes (64 compact + 1 recid)
    const recoverableSig = native.crypto.signRecoverableSecp256k1(keyHandle, msgHash);
    const recid = recoverableSig[64];

    // Flag byte: 27 (magic) + 4 (compressed pubkey) + recid
    const flagByte = 27 + 4 + recid;

    // Output: [flagByte, r(32), s(32)]
    const result = new Uint8Array(65);
    result[0] = flagByte;
    result.set(recoverableSig.slice(0, 64), 1);

    // Base64 encode
    return this.uint8ArrayToBase64(result);
  }

  /**
   * Verify a Bitcoin Signed Message against an address.
   * Recovers the public key from the signature, derives the address,
   * and compares to the expected address.
   *
   * @param message    The original message string
   * @param signature  base64-encoded 65-byte signature
   * @param address    The expected Bitcoin address
   * @returns true if the signature is valid for this address
   */
  async verifyMessage(message: string, signature: string, address: string): Promise<boolean> {
    const sigBytes = this.base64ToUint8Array(signature);
    if (sigBytes.length !== 65) return false;

    const flagByte = sigBytes[0];
    // Extract recid from flag: recid = (flagByte - 27) & 3
    const recid = (flagByte - 27) & 3;
    // Check compressed flag: (flagByte - 27) & 4
    const compressed = ((flagByte - 27) & 4) !== 0;
    if (!compressed) return false; // We only support compressed keys

    // Reconstruct 65-byte recoverable signature (64 compact + 1 recid)
    const recoverableSig = new Uint8Array(65);
    recoverableSig.set(sigBytes.slice(1, 65), 0);
    recoverableSig[64] = recid;

    const msgHash = this.bitcoinMessageHash(message);

    // Recover public key
    let recoveredPubkey: Uint8Array;
    try {
      recoveredPubkey = native.crypto.recoverSecp256k1(msgHash, recoverableSig);
    } catch {
      return false;
    }

    // Derive address from recovered pubkey: Hash160 + bech32
    const sha = native.crypto.sha256(recoveredPubkey);
    const hash160 = native.crypto.ripemd160(sha);

    // Convert to 5-bit groups for bech32
    const data5 = convertBits(hash160, 8, 5, true);
    if (!data5) return false;

    const hrp = this.network === 'regtest' ? 'bcrt' : (this.isTestnet ? 'tb' : 'bc');
    const witnessData = new Uint8Array(1 + data5.length);
    witnessData[0] = 0; // witness version 0
    witnessData.set(data5, 1);

    const derivedAddress = native.encoding.bech32Encode(hrp, witnessData);
    return derivedAddress === address;
  }

  // ── Bitcoin Signed Message helpers ──

  private bitcoinMessageHash(message: string): Uint8Array {
    // Construct: "\x18Bitcoin Signed Message:\n" + varint(len) + message
    const prefix = new Uint8Array([
      0x18, // length of "Bitcoin Signed Message:\n"
      0x42, 0x69, 0x74, 0x63, 0x6f, 0x69, 0x6e, 0x20, // "Bitcoin "
      0x53, 0x69, 0x67, 0x6e, 0x65, 0x64, 0x20,       // "Signed "
      0x4d, 0x65, 0x73, 0x73, 0x61, 0x67, 0x65, 0x3a,  // "Message:"
      0x0a,                                              // "\n"
    ]);

    const msgBytes = native.encoding.utf8Encode(message);
    const varint = this.encodeVarint(msgBytes.length);

    // Concatenate: prefix + varint + msgBytes
    const payload = new Uint8Array(prefix.length + varint.length + msgBytes.length);
    payload.set(prefix, 0);
    payload.set(varint, prefix.length);
    payload.set(msgBytes, prefix.length + varint.length);

    // Double SHA256
    return native.crypto.sha256(native.crypto.sha256(payload));
  }

  private encodeVarint(n: number): Uint8Array {
    if (n < 0xfd) return new Uint8Array([n]);
    if (n <= 0xffff) {
      const buf = new Uint8Array(3);
      buf[0] = 0xfd;
      buf[1] = n & 0xff;
      buf[2] = (n >> 8) & 0xff;
      return buf;
    }
    const buf = new Uint8Array(5);
    buf[0] = 0xfe;
    buf[1] = n & 0xff;
    buf[2] = (n >> 8) & 0xff;
    buf[3] = (n >> 16) & 0xff;
    buf[4] = (n >> 24) & 0xff;
    return buf;
  }

  private uint8ArrayToBase64(data: Uint8Array): string {
    // QuickJS doesn't have btoa — manual base64 encoding
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let result = '';
    for (let i = 0; i < data.length; i += 3) {
      const a = data[i];
      const b = i + 1 < data.length ? data[i + 1] : 0;
      const c = i + 2 < data.length ? data[i + 2] : 0;
      result += chars[(a >> 2) & 0x3f];
      result += chars[((a << 4) | (b >> 4)) & 0x3f];
      result += i + 1 < data.length ? chars[((b << 2) | (c >> 6)) & 0x3f] : '=';
      result += i + 2 < data.length ? chars[c & 0x3f] : '=';
    }
    return result;
  }

  private base64ToUint8Array(base64: string): Uint8Array {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const lookup = new Map<string, number>();
    for (let i = 0; i < chars.length; i++) lookup.set(chars[i], i);

    // Remove padding and calculate output length
    const clean = base64.replace(/=/g, '');
    const outLen = Math.floor((clean.length * 3) / 4);
    const result = new Uint8Array(outLen);

    let j = 0;
    for (let i = 0; i < clean.length; i += 4) {
      const a = lookup.get(clean[i]) ?? 0;
      const b = lookup.get(clean[i + 1]) ?? 0;
      const c = lookup.get(clean[i + 2]) ?? 0;
      const d = lookup.get(clean[i + 3]) ?? 0;
      result[j++] = (a << 2) | (b >> 4);
      if (j < outLen) result[j++] = ((b << 4) | (c >> 2)) & 0xff;
      if (j < outLen) result[j++] = ((c << 6) | d) & 0xff;
    }
    return result;
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
