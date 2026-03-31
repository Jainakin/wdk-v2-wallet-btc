/**
 * BtcAccount — full Bitcoin account with signing capabilities.
 *
 * Extends BtcAccountReadOnly with:
 *   - sendTransaction (build + sign + broadcast)
 *   - sign (Bitcoin Signed Message)
 *   - toReadOnly() — downcast to read-only view
 *
 * Mirrors production: tetherto/wdk-wallet-btc WalletAccountBtc
 */

import { WalletAccount } from '@aspect/wdk-v2-core';
import type { KeyHandle, TxRecord } from '@aspect/wdk-v2-utils';
import type { BtcWalletManager } from './btc-wallet-manager.js';
import { BtcAccountReadOnly } from './btc-account-read-only.js';
import type { UTXO, BtcNetwork } from './types.js';
import { selectUtxos, calculateMaxSpendable, addressTypeParams } from './utxo.js';
import { addressToScriptPubKey } from './transaction.js';
import { buildAndSignPsbt } from './psbt.js';
import { convertBits } from './address.js';
import type { IBtcClient } from './client/btc-client.js';
import {
  bitcoinMessageHash, btcPerKbToSatVb,
  uint8ArrayToBase64, base64ToUint8Array,
} from './btc-helpers.js';

export class BtcAccount extends WalletAccount {
  private readonly manager: BtcWalletManager;
  private readonly addressType: string;

  constructor(
    manager: BtcWalletManager,
    keyHandle: KeyHandle,
    publicKey: Uint8Array,
    address: string,
    index: number,
    path: string,
    addressType: string = 'p2wpkh',
  ) {
    super('btc', address, index, path, keyHandle, publicKey);
    this.manager = manager;
    this.addressType = addressType;
  }

  private get client(): IBtcClient {
    return this.manager.getClient();
  }

  private get network(): BtcNetwork {
    return this.manager.getNetwork();
  }

  private get isTestnet(): boolean {
    return this.manager.isTestnetNetwork();
  }

  // ── Read-only operations (delegate to shared client) ────────────────────

  async getBalance(): Promise<string> {
    const balance = await this.client.getBalance(this.address);
    // Production returns confirmed only — unconfirmed is not counted
    return String(balance.confirmed);
  }

  async getFeeRates(): Promise<{
    fast: number; medium: number; slow: number; normal: number;
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

  async quoteSendTransaction(params: { to: string; amount: string }): Promise<{
    feasible: boolean; fee: number; feeRate: number;
    inputCount: number; outputCount: number; totalInput: number;
    change: number; changeValue: number; error?: string;
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
      const { inputVbytes, dustThreshold } = addressTypeParams(this.address);
      const selection = selectUtxos(utxos, targetSats, feeRate, dustThreshold, params.to, inputVbytes);
      if (!selection) {
        return {
          feasible: false, fee: 0, feeRate, inputCount: 0,
          outputCount: 0, totalInput: utxos.reduce((s, u) => s + u.value, 0),
          change: 0, changeValue: 0, error: 'Insufficient funds',
        };
      }
      return {
        feasible: true, fee: selection.fee, feeRate,
        inputCount: selection.selected.length,
        outputCount: selection.change > 0 ? 2 : 1,
        totalInput: selection.selected.reduce((s, u) => s + u.value, 0),
        change: selection.change, changeValue: selection.change,
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
    maxSpendable: number; amount: number; fee: number;
    changeValue: number; utxoCount: number;
  }> {
    const utxos = await this.fetchUtxos();
    const btcPerKb = await this.client.estimateFee(3);
    const feeRate = btcPerKbToSatVb(btcPerKb);
    const { inputVbytes, dustThreshold } = addressTypeParams(this.address);
    const maxSpendable = calculateMaxSpendable(utxos, feeRate, dustThreshold, inputVbytes);
    const totalInput = utxos.reduce((s, u) => s + u.value, 0);
    return {
      maxSpendable, amount: maxSpendable,
      fee: totalInput - maxSpendable, changeValue: 0, utxoCount: utxos.length,
    };
  }

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

  // getTransfers() is inherited from BtcAccountReadOnly — production per-output semantics

  async getTransactionReceipt(txHash: string): Promise<{
    txHash: string; confirmed: boolean; confirmations: number;
    blockHeight: number; blockTime: number; fee: number; rawTx?: string;
  } | null> {
    try {
      const status = await this.client.getTxStatus(txHash);
      // Production returns null for unconfirmed transactions
      if (!status.confirmed || status.blockHeight <= 0) return null;

      let confirmations = 0;
      try {
        const tipHeight = await this.client.getBlockHeight();
        confirmations = tipHeight > 0 ? tipHeight - status.blockHeight + 1 : 1;
      } catch { confirmations = 1; }
      let rawTx: string | undefined;
      try { rawTx = await this.client.getTransaction(txHash); } catch { /* optional */ }
      return { ...status, confirmations, rawTx };
    } catch { return null; }
  }

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
    try { recoveredPubkey = native.crypto.recoverSecp256k1(msgHash, recoverableSig); }
    catch { return false; }

    const sha = native.crypto.sha256(recoveredPubkey);
    const hash160 = native.crypto.ripemd160(sha);

    // Try P2WPKH
    const data5 = convertBits(hash160, 8, 5, true);
    if (data5) {
      const hrp = this.network === 'regtest' ? 'bcrt' : (this.isTestnet ? 'tb' : 'bc');
      const witnessData = new Uint8Array(1 + data5.length);
      witnessData[0] = 0;
      witnessData.set(data5, 1);
      if (native.encoding.bech32Encode(hrp, witnessData) === this.address) return true;
    }

    // Try P2PKH
    const version = this.isTestnet ? 0x6f : 0x00;
    const payload = new Uint8Array(21);
    payload[0] = version;
    payload.set(hash160, 1);
    try {
      if (native.encoding.base58CheckEncode(payload) === this.address) return true;
    } catch { /* not P2PKH */ }

    return false;
  }

  // ── Signing operations ─────────────────────────────────────────────────

  async sendTransaction(params: {
    to: string;
    amount: string;
    feeRate?: number;
  }): Promise<{ txHash: string; fee: number }> {
    const targetSats = parseInt(params.amount, 10);
    if (isNaN(targetSats) || targetSats <= 0) {
      throw new Error(`Invalid amount: ${params.amount}`);
    }

    // 1. Fetch UTXOs
    const utxos = await this.fetchUtxos();
    if (utxos.length === 0) throw new Error('No UTXOs available');

    // 2. Determine fee rate
    let feeRate = params.feeRate;
    if (!feeRate) {
      const btcPerKb = await this.client.estimateFee(3);
      feeRate = btcPerKbToSatVb(btcPerKb);
    }

    // 3. Coin selection (BIP-aware dust + input sizing)
    const { inputVbytes: sendInputVbytes, dustThreshold: sendDust } = addressTypeParams(this.address);
    const selection = selectUtxos(utxos, targetSats, feeRate, sendDust, params.to, sendInputVbytes);
    if (!selection) throw new Error('Insufficient funds');

    // 4. For legacy inputs, fetch full previous tx (nonWitnessUtxo)
    const spkBytes = native.encoding.hexDecode(utxos[0].scriptPubKey);
    const isLegacy = spkBytes.length === 25 && spkBytes[0] === 0x76;

    const inputs = await Promise.all(
      selection.selected.map(async (u) => {
        const input: any = {
          txid: u.txid, vout: u.vout, value: u.value,
          scriptPubKey: u.scriptPubKey, address: this.address,
        };
        if (isLegacy) {
          try { input.prevTxHex = await this.client.getTransaction(u.txid); } catch { /* fallback */ }
        }
        return input;
      })
    );

    // 5. Build outputs
    const outputs: { address: string; value: number }[] = [
      { address: params.to, value: targetSats },
    ];
    if (selection.change > 0) {
      outputs.push({ address: this.address, value: selection.change });
    }

    // 6. Sign with PSBT
    const keyHandles = inputs.map(() => this.keyHandle);
    const psbtInputs = inputs.map((inp) => ({
      txid: inp.txid, vout: inp.vout, value: inp.value,
      scriptPubKey: inp.scriptPubKey, prevTxHex: inp.prevTxHex,
    }));
    const psbtOutputs = outputs.map((out) => ({
      address: out.address, value: out.value,
    }));

    let signed = buildAndSignPsbt(psbtInputs, psbtOutputs, keyHandles);
    let currentFee = selection.fee;

    // 7. Post-sign fee rebalance (matches production _getRawTransaction)
    // After signing, check actual tx vsize against fee. If short, adjust
    // outputs and rebuild+resign exactly once.
    const rawBytes = native.encoding.hexDecode(signed.rawTx);
    const actualVsize = rawBytes.length; // serialized tx bytes = vsize for segwit
    const requiredFee = Math.ceil(actualVsize * feeRate);

    if (requiredFee > currentFee) {
      const delta = requiredFee - currentFee;
      currentFee = requiredFee;

      // Priority: reduce change first, then recipient amount
      let currentChange = selection.change;
      let currentTarget = targetSats;

      if (currentChange > 0) {
        currentChange -= delta;
        if (currentChange < sendDust) currentChange = 0;
      } else {
        currentTarget -= delta;
        if (currentTarget < sendDust) {
          throw new Error('Insufficient funds: fee rebalance would make output below dust');
        }
      }

      // Rebuild outputs and resign
      const rebalancedOutputs: { address: string; value: number }[] = [
        { address: params.to, value: currentTarget },
      ];
      if (currentChange > 0) {
        rebalancedOutputs.push({ address: this.address, value: currentChange });
      }
      const rebPsbtOutputs = rebalancedOutputs.map((out) => ({
        address: out.address, value: out.value,
      }));

      signed = buildAndSignPsbt(psbtInputs, rebPsbtOutputs, keyHandles);

      // Final validation — must not still be short
      const rebBytes = native.encoding.hexDecode(signed.rawTx);
      const rebVsize = rebBytes.length;
      const rebRequired = Math.ceil(rebVsize * feeRate);
      if (rebRequired > currentFee) {
        throw new Error('Fee shortfall persists after output rebalance');
      }
    }

    // 8. Broadcast
    const broadcastTxid = await this.client.broadcast(signed.rawTx);

    return { txHash: broadcastTxid || signed.txid, fee: currentFee };
  }

  async sign(message: string): Promise<string> {
    const msgHash = bitcoinMessageHash(message);
    const recoverableSig = native.crypto.signRecoverableSecp256k1(this.keyHandle, msgHash);
    const recid = recoverableSig[64];

    // Recovery flag byte per BIP-137 / bitcoinjs-message:
    //   P2PKH compressed: 31 + recid  (27 + recid + 4)
    //   P2WPKH:           39 + recid  (27 + recid + 4 + 8)
    const isSegwit = this.address.startsWith('bc1q') ||
                     this.address.startsWith('tb1q') ||
                     this.address.startsWith('bcrt1q');
    const flagByte = 27 + recid + 4 + (isSegwit ? 8 : 0);
    const result = new Uint8Array(65);
    result[0] = flagByte;
    result.set(recoverableSig.slice(0, 64), 1);

    return uint8ArrayToBase64(result);
  }

  // ── Unsupported interface methods (match production surface) ────────────

  async transfer(_options: Record<string, unknown>): Promise<never> {
    throw new Error("The 'transfer' method is not supported on the bitcoin blockchain.");
  }

  // ── Downcast to read-only ──────────────────────────────────────────────

  toReadOnly(): BtcAccountReadOnly {
    return new BtcAccountReadOnly(
      this.manager, this.address, this.index, this.path,
    );
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  private async fetchUtxos(): Promise<UTXO[]> {
    const electrumUtxos = await this.client.listUnspent(this.address);
    const senderScriptPubKey = native.encoding.hexEncode(
      addressToScriptPubKey(this.address)
    );
    return electrumUtxos.map((u) => ({
      txid: u.tx_hash, vout: u.tx_pos, value: u.value,
      scriptPubKey: senderScriptPubKey, address: this.address,
    }));
  }
}
