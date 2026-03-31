/**
 * BtcAccountReadOnly — read-only Bitcoin account.
 *
 * Can query balance, history, fees, verify messages.
 * Cannot sign or send transactions.
 * Safe to pass to untrusted code.
 *
 * Mirrors production: tetherto/wdk-wallet-btc WalletAccountReadOnlyBtc
 */

import { WalletAccountReadOnly } from '@aspect/wdk-v2-core';
import type { TxRecord } from '@aspect/wdk-v2-utils';
import type { IBtcClient } from './client/btc-client.js';
import type { BtcWalletManager } from './btc-wallet-manager.js';
import type { UTXO, TransferQuery, TransferResult, DetailedTxInfo, BtcNetwork } from './types.js';
import { selectUtxos, calculateMaxSpendable, DUST_THRESHOLD_P2WPKH } from './utxo.js';
import { addressToScriptPubKey } from './transaction.js';
import { convertBits } from './address.js';
import { bitcoinMessageHash, btcPerKbToSatVb, base64ToUint8Array } from './btc-helpers.js';

export class BtcAccountReadOnly extends WalletAccountReadOnly {
  protected readonly manager: BtcWalletManager;

  constructor(
    manager: BtcWalletManager,
    address: string,
    index: number,
    path: string,
  ) {
    super('btc', address, index, path);
    this.manager = manager;
  }

  /** Convenience: get the shared client */
  protected get client(): IBtcClient {
    return this.manager.getClient();
  }

  protected get network(): BtcNetwork {
    return this.manager.getNetwork();
  }

  protected get isTestnet(): boolean {
    return this.manager.isTestnetNetwork();
  }

  // ── Balance ────────────────────────────────────────────────────────────

  async getBalance(): Promise<string> {
    const balance = await this.client.getBalance(this.address);
    // Production returns confirmed only — unconfirmed is not counted
    return String(balance.confirmed);
  }

  // ── Fee rates ──────────────────────────────────────────────────────────

  async getFeeRates(): Promise<{
    fast: number;
    medium: number;
    slow: number;
    normal: number;
  }> {
    const [fast, medium, slow] = await Promise.all([
      this.client.estimateFee(1),
      this.client.estimateFee(3),
      this.client.estimateFee(6),
    ]);

    return {
      fast: btcPerKbToSatVb(fast),
      medium: btcPerKbToSatVb(medium),
      slow: btcPerKbToSatVb(slow),
      normal: btcPerKbToSatVb(medium),
    };
  }

  // ── Quote + Max Spendable ──────────────────────────────────────────────

  async quoteSendTransaction(params: {
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
    changeValue: number;
    error?: string;
  }> {
    const targetSats = parseInt(params.amount, 10);
    if (isNaN(targetSats) || targetSats <= 0) {
      return {
        feasible: false, fee: 0, feeRate: 0, inputCount: 0,
        outputCount: 0, totalInput: 0, change: 0, changeValue: 0,
        error: `Invalid amount: ${params.amount}`,
      };
    }

    try {
      const utxos = await this.fetchUtxos();
      const btcPerKb = await this.client.estimateFee(3);
      const feeRate = btcPerKbToSatVb(btcPerKb);

      const selection = selectUtxos(utxos, targetSats, feeRate, DUST_THRESHOLD_P2WPKH, params.to);
      if (!selection) {
        return {
          feasible: false, fee: 0, feeRate, inputCount: 0,
          outputCount: 0, totalInput: utxos.reduce((s, u) => s + u.value, 0), change: 0, changeValue: 0,
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
        changeValue: selection.change,
      };
    } catch (e: any) {
      return {
        feasible: false, fee: 0, feeRate: 0, inputCount: 0,
        outputCount: 0, totalInput: 0, change: 0, changeValue: 0,
        error: e.message ?? String(e),
      };
    }
  }

  async getMaxSpendable(): Promise<{
    maxSpendable: number;
    amount: number;
    fee: number;
    changeValue: number;
    utxoCount: number;
  }> {
    const utxos = await this.fetchUtxos();
    const btcPerKb = await this.client.estimateFee(3);
    const feeRate = btcPerKbToSatVb(btcPerKb);

    const maxSpendable = calculateMaxSpendable(utxos, feeRate, DUST_THRESHOLD_P2WPKH);
    const totalInput = utxos.reduce((s, u) => s + u.value, 0);

    return {
      maxSpendable,
      amount: maxSpendable,
      fee: totalInput - maxSpendable,
      changeValue: 0,
      utxoCount: utxos.length,
    };
  }

  // ── History + Transfers ────────────────────────────────────────────────

  async getTransactionHistory(limit: number = 25): Promise<TxRecord[]> {
    const result = await this.getTransfers({ limit });
    return (result as TransferResult).transfers.map((tx: DetailedTxInfo) => ({
      txHash: tx.txHash,
      chain: 'btc' as const,
      from: tx.direction === 'received' ? (tx.counterparties[0] ?? '') : this.address,
      to: tx.direction === 'sent' ? (tx.counterparties[0] ?? '') : this.address,
      amount: String(Math.abs(tx.amount)),
      fee: String(tx.fee),
      direction: tx.direction,
      counterparties: tx.counterparties,
      timestamp: tx.timestamp,
      status: tx.confirmed ? ('confirmed' as const) : ('pending' as const),
      blockNumber: tx.blockHeight > 0 ? tx.blockHeight : undefined,
    }));
  }

  async getTransfers(query?: Record<string, unknown>): Promise<TransferResult> {
    const q = query as TransferQuery | undefined;
    const limit = q?.limit ?? 25;
    const detailed = await this.client.getDetailedHistory(
      this.address, limit, q?.afterTxId, q?.page,
    );

    let filtered = detailed;
    if (q?.direction && q.direction !== 'all') {
      filtered = detailed.filter((tx) => tx.direction === q.direction);
    }

    // Expand multi-counterparty txs to individual transfer rows
    const transfers: DetailedTxInfo[] = [];
    for (const tx of filtered) {
      const uniqueCounterparties = [...new Set(tx.counterparties)];
      if (uniqueCounterparties.length <= 1) {
        transfers.push({ ...tx, counterparties: uniqueCounterparties });
      } else {
        for (const cp of uniqueCounterparties) {
          transfers.push({ ...tx, counterparties: [cp] });
        }
      }
    }

    const hasMore = detailed.length >= limit;
    const nextCursor = detailed.length > 0
      ? detailed[detailed.length - 1].txHash
      : undefined;

    return { transfers, hasMore, nextCursor };
  }

  // ── Receipt ────────────────────────────────────────────────────────────

  async getTransactionReceipt(txHash: string): Promise<{
    txHash: string;
    confirmed: boolean;
    confirmations: number;
    blockHeight: number;
    blockTime: number;
    fee: number;
    rawTx?: string;
  } | null> {
    try {
      const status = await this.client.getTxStatus(txHash);
      let confirmations = 0;
      if (status.confirmed && status.blockHeight > 0) {
        try {
          const tipHeight = await this.client.getBlockHeight();
          confirmations = tipHeight > 0 ? tipHeight - status.blockHeight + 1 : 1;
        } catch {
          confirmations = 1;
        }
      }

      let rawTx: string | undefined;
      try {
        rawTx = await this.client.getTransaction(txHash);
      } catch { /* optional */ }

      return { ...status, confirmations, rawTx };
    } catch {
      return null;
    }
  }

  // ── Verify ─────────────────────────────────────────────────────────────

  async verifyMessage(message: string, signature: string): Promise<boolean> {
    const sigBytes = base64ToUint8Array(signature);
    if (sigBytes.length !== 65) return false;

    const flagByte = sigBytes[0];
    const recid = (flagByte - 27) & 3;
    const compressed = ((flagByte - 27) & 4) !== 0;
    if (!compressed) return false;

    const recoverableSig = new Uint8Array(65);
    recoverableSig.set(sigBytes.slice(1, 65), 0);
    recoverableSig[64] = recid;

    const msgHash = bitcoinMessageHash(message);

    let recoveredPubkey: Uint8Array;
    try {
      recoveredPubkey = native.crypto.recoverSecp256k1(msgHash, recoverableSig);
    } catch {
      return false;
    }

    const sha = native.crypto.sha256(recoveredPubkey);
    const hash160 = native.crypto.ripemd160(sha);

    // Try P2WPKH (bech32)
    const data5 = convertBits(hash160, 8, 5, true);
    if (data5) {
      const hrp = this.network === 'regtest' ? 'bcrt' : (this.isTestnet ? 'tb' : 'bc');
      const witnessData = new Uint8Array(1 + data5.length);
      witnessData[0] = 0;
      witnessData.set(data5, 1);
      const segwitAddr = native.encoding.bech32Encode(hrp, witnessData);
      if (segwitAddr === this.address) return true;
    }

    // Try P2PKH (base58check)
    const version = this.isTestnet ? 0x6f : 0x00;
    const payload = new Uint8Array(21);
    payload[0] = version;
    payload.set(hash160, 1);
    try {
      const legacyAddr = native.encoding.base58CheckEncode(payload);
      if (legacyAddr === this.address) return true;
    } catch { /* not P2PKH */ }

    return false;
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  protected async fetchUtxos(): Promise<UTXO[]> {
    const electrumUtxos = await this.client.listUnspent(this.address);
    const senderScriptPubKey = native.encoding.hexEncode(
      addressToScriptPubKey(this.address)
    );
    return electrumUtxos.map((u) => ({
      txid: u.tx_hash,
      vout: u.tx_pos,
      value: u.value,
      scriptPubKey: senderScriptPubKey,
      address: this.address,
    }));
  }
}
