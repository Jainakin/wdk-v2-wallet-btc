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
import type { UTXO, TransferQuery, TransferResult, BtcTransferRow, BtcNetwork } from './types.js';
import { planSpend, planMaxSpendable } from './spend-planner.js';
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

      const plan = planSpend(utxos, this.address, params.to, targetSats, feeRate);

      return {
        feasible: true,
        fee: plan.fee,
        feeRate,
        inputCount: plan.utxos.length,
        outputCount: plan.changeValue > 0 ? 2 : 1,
        totalInput: plan.utxos.reduce((s, u) => s + u.value, 0),
        change: plan.changeValue,
        changeValue: plan.changeValue,
      };
    } catch (e: any) {
      const utxos = await this.fetchUtxos().catch(() => []);
      const btcPerKb = await this.client.estimateFee(3).catch(() => 0);
      return {
        feasible: false, fee: 0, feeRate: btcPerKbToSatVb(btcPerKb), inputCount: 0,
        outputCount: 0, totalInput: utxos.reduce((s: number, u: any) => s + u.value, 0), change: 0, changeValue: 0,
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

    const result = planMaxSpendable(utxos, this.address, feeRate);

    return {
      maxSpendable: result.amount,
      amount: result.amount,
      fee: result.fee,
      changeValue: result.changeValue,
      utxoCount: utxos.length,
    };
  }

  // ── History + Transfers ────────────────────────────────────────────────

  async getTransactionHistory(limit: number = 25): Promise<TxRecord[]> {
    const result = await this.getTransfers({ limit });
    return result.transfers.map((tx) => ({
      txHash: tx.txid,
      chain: 'btc' as const,
      from: tx.direction === 'incoming' ? (tx.recipient ?? '') : this.address,
      to: tx.direction === 'outgoing' ? (tx.recipient ?? '') : this.address,
      amount: String(tx.value),
      fee: String(tx.fee ?? 0),
      direction: tx.direction === 'incoming' ? 'received' as const : 'sent' as const,
      counterparties: tx.recipient ? [tx.recipient] : [],
      timestamp: 0,
      status: tx.height > 0 ? ('confirmed' as const) : ('pending' as const),
      blockNumber: tx.height > 0 ? tx.height : undefined,
    }));
  }

  async getTransfers(query?: Record<string, unknown>): Promise<TransferResult> {
    const q = query as TransferQuery | undefined;
    const rowLimit = q?.limit ?? 25;
    const skip = q?.skip ?? 0;

    // Normalize direction filter (accept legacy 'sent'/'received' too)
    let dirFilter: 'incoming' | 'outgoing' | 'all' = 'all';
    if (q?.direction === 'outgoing' || q?.direction === 'sent') dirFilter = 'outgoing';
    else if (q?.direction === 'incoming' || q?.direction === 'received') dirFilter = 'incoming';

    // Fetch enough transactions to fill the row limit.
    // Each tx can produce multiple rows, so we may need fewer txs than limit.
    const history = await this.client.getHistory(this.address);
    const txEntries = history.slice(skip);

    const transfers: BtcTransferRow[] = [];
    let lastTxid: string | undefined;

    // Process transactions in batches to avoid huge single requests
    const BATCH = 10;
    for (let i = 0; i < txEntries.length && transfers.length < rowLimit; i += BATCH) {
      const batch = txEntries.slice(i, i + BATCH);
      const details = await this.client.getVerboseTxBatch(
        batch.map(h => h.tx_hash),
      );

      for (let j = 0; j < details.length && transfers.length < rowLimit; j++) {
        const tx = details[j];
        if (!tx) continue;
        const entry = batch[j];
        const height = entry.height > 0 ? entry.height : 0;

        // Determine if this is an outgoing tx (any input belongs to us)
        const isOutgoing = tx.vin.some(
          (v: any) => v.prevout?.scriptpubkey_address === this.address,
        );

        // Calculate fee (sum inputs - sum outputs)
        let fee: number | undefined;
        if (isOutgoing) {
          const totalIn = tx.vin.reduce(
            (s: number, v: any) => s + (v.prevout?.value ?? 0), 0,
          );
          const totalOut = tx.vout.reduce(
            (s: number, v: any) => s + (v.value ?? 0), 0,
          );
          fee = totalIn - totalOut;
        }

        // One row per relevant output
        for (let vout = 0; vout < tx.vout.length && transfers.length < rowLimit; vout++) {
          const output = tx.vout[vout];
          const outAddr = output.scriptpubkey_address;
          const isMine = outAddr === this.address;

          let direction: 'incoming' | 'outgoing' | null = null;
          if (!isOutgoing && isMine) direction = 'incoming';
          else if (isOutgoing && !isMine) direction = 'outgoing';
          // isOutgoing && isMine = change → skip

          if (!direction) continue;
          if (dirFilter !== 'all' && dirFilter !== direction) continue;

          transfers.push({
            txid: tx.txid,
            address: this.address,
            vout,
            height,
            value: output.value ?? 0,
            direction,
            recipient: outAddr,
            fee,
          });
        }

        lastTxid = tx.txid;
      }
    }

    return {
      transfers,
      hasMore: transfers.length >= rowLimit,
      nextCursor: lastTxid,
    };
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
      // Production returns null for unconfirmed transactions
      if (!status.confirmed || status.blockHeight <= 0) return null;

      let confirmations = 0;
      try {
        const tipHeight = await this.client.getBlockHeight();
        confirmations = tipHeight > 0 ? tipHeight - status.blockHeight + 1 : 1;
      } catch {
        confirmations = 1;
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

  // ── Unsupported interface methods (match production surface) ────────────

  async getTokenBalance(_tokenAddress: string): Promise<never> {
    throw new Error("The 'getTokenBalance' method is not supported on the bitcoin blockchain.");
  }

  async quoteTransfer(_options: Record<string, unknown>): Promise<never> {
    throw new Error("The 'quoteTransfer' method is not supported on the bitcoin blockchain.");
  }
}
