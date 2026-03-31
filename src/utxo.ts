/**
 * UTXO coin selection for Bitcoin transactions.
 *
 * Production-parity two-phase algorithm (matches @bitcoinerlab/coinselect):
 *   Phase 1 — avoidChange: try to find exact-ish match (no change output)
 *   Phase 2 — addUntilReach: accumulative largest-first with change
 *
 * Also: BIP-aware dust thresholds, MAX_UTXO_INPUTS, MIN_TX_FEE_SATS,
 *        address-aware output size estimation.
 */

import type { UTXO } from './types.js';

// ── Constants matching production ────────────────────────────────────────────

/** Estimated vbytes per P2WPKH input (witness-discounted) */
export const VBYTES_PER_P2WPKH_INPUT = 68;
/** Estimated vbytes per P2PKH input (legacy, no witness) */
export const VBYTES_PER_P2PKH_INPUT = 148;
/** Default estimated vbytes per output (P2WPKH — our change output) */
const VBYTES_PER_OUTPUT_DEFAULT = 31;
/** Fixed transaction overhead in vbytes (version + locktime + segwit marker) */
const TX_OVERHEAD_VBYTES = 11;

/**
 * Estimate output size in vbytes based on destination address format.
 * Output = 8 (value) + 1 (varint) + scriptPubKey length
 */
function estimateOutputVbytes(address?: string): number {
  if (!address) return VBYTES_PER_OUTPUT_DEFAULT;
  if (address.startsWith('1') || address.startsWith('m') || address.startsWith('n')) return 34; // P2PKH
  if (address.startsWith('3') || address.startsWith('2')) return 32; // P2SH
  if (address.startsWith('bc1p') || address.startsWith('tb1p') || address.startsWith('bcrt1p')) return 43; // P2TR
  if (address.length > 50) return 43; // P2WSH
  return VBYTES_PER_OUTPUT_DEFAULT; // P2WPKH (default)
}

/** Dust threshold for P2PKH outputs (BIP44 legacy) — 546 sats */
export const DUST_THRESHOLD_P2PKH = 546;
/** Dust threshold for P2WPKH outputs (BIP84 native segwit) — 294 sats */
export const DUST_THRESHOLD_P2WPKH = 294;

/**
 * Determine input vbytes and dust threshold based on the sender's address type.
 * Matches production BIP_BY_ADDRESS_PREFIX logic.
 */
export function addressTypeParams(address: string): { inputVbytes: number; dustThreshold: number } {
  if (
    address.startsWith('bc1q') ||
    address.startsWith('tb1q') ||
    address.startsWith('bcrt1q')
  ) {
    return { inputVbytes: VBYTES_PER_P2WPKH_INPUT, dustThreshold: DUST_THRESHOLD_P2WPKH };
  }
  // P2PKH (legacy) — starts with 1, m, n
  return { inputVbytes: VBYTES_PER_P2PKH_INPUT, dustThreshold: DUST_THRESHOLD_P2PKH };
}

/**
 * Minimum transaction fee in satoshis.
 * Matches production MIN_TX_FEE_SATS = 141 (min 1-in-1-out P2WPKH at 1 sat/vB).
 */
export const MIN_TX_FEE_SATS = 141;

/**
 * Maximum number of UTXO inputs per transaction.
 * Matches production MAX_UTXO_INPUTS.
 */
export const MAX_UTXO_INPUTS = 200;

// ── Types ────────────────────────────────────────────────────────────────────

export interface CoinSelection {
  selected: UTXO[];
  fee: number;
  change: number;
}

// ── Main selector ────────────────────────────────────────────────────────────

/**
 * Select UTXOs using production-parity two-phase algorithm.
 *
 * Phase 1 — avoidChange (inspired by @bitcoinerlab/coinselect "blackjack"):
 *   Try to find a subset whose total covers target + fee for a 1-output tx.
 *   The remainder (overpayment as extra fee) must be less than the cost of
 *   adding a change output, otherwise it's wasteful.
 *
 * Phase 2 — addUntilReach (accumulative, largest-first):
 *   Greedily add UTXOs until target + fee (2-output tx) is covered.
 *   Sub-dust change absorbed into fee.
 */
export function selectUtxos(
  utxos: UTXO[],
  targetAmount: number,
  feeRate: number,
  dustThreshold: number = DUST_THRESHOLD_P2WPKH,
  destinationAddr?: string,
  inputVbytes: number = VBYTES_PER_P2WPKH_INPUT,
): CoinSelection | null {
  const sorted = [...utxos].sort((a, b) => b.value - a.value);
  const candidates = sorted.slice(0, MAX_UTXO_INPUTS);

  const destOutputVbytes = estimateOutputVbytes(destinationAddr);
  const changeOutputVbytes = VBYTES_PER_OUTPUT_DEFAULT;

  // Phase 1: avoidChange
  const changeCost = Math.ceil(changeOutputVbytes * feeRate);
  const avoidResult = avoidChange(candidates, targetAmount, feeRate, destOutputVbytes, changeCost, inputVbytes);
  if (avoidResult) return avoidResult;

  // Phase 2: addUntilReach
  return addUntilReach(candidates, targetAmount, feeRate, dustThreshold, destOutputVbytes, changeOutputVbytes, inputVbytes);
}

/**
 * Phase 1: Try to find a no-change selection.
 * Iterates sorted UTXOs, accumulating. If total covers target + fee (1 output)
 * and the remainder is less than changeCost, use this solution.
 */
function avoidChange(
  sorted: UTXO[],
  targetAmount: number,
  feeRate: number,
  destOutputVbytes: number,
  changeCost: number,
  inputVbytes: number,
): CoinSelection | null {
  const selected: UTXO[] = [];
  let totalInput = 0;

  for (const utxo of sorted) {
    selected.push(utxo);
    totalInput += utxo.value;

    const vbytes = TX_OVERHEAD_VBYTES + selected.length * inputVbytes + destOutputVbytes;
    let fee = Math.ceil(vbytes * feeRate);
    if (fee < MIN_TX_FEE_SATS) fee = MIN_TX_FEE_SATS;

    if (totalInput >= targetAmount + fee) {
      const remainder = totalInput - targetAmount - fee;
      if (remainder < changeCost) {
        return { selected: [...selected], fee: fee + remainder, change: 0 };
      }
    }
  }
  return null;
}

/**
 * Phase 2: Accumulative with change output.
 */
function addUntilReach(
  sorted: UTXO[],
  targetAmount: number,
  feeRate: number,
  dustThreshold: number,
  destOutputVbytes: number,
  changeOutputVbytes: number,
  inputVbytes: number,
): CoinSelection | null {
  const selected: UTXO[] = [];
  let totalInput = 0;

  for (const utxo of sorted) {
    selected.push(utxo);
    totalInput += utxo.value;

    const vbytes = TX_OVERHEAD_VBYTES + selected.length * inputVbytes + destOutputVbytes + changeOutputVbytes;
    let fee = Math.ceil(vbytes * feeRate);
    if (fee < MIN_TX_FEE_SATS) fee = MIN_TX_FEE_SATS;

    if (totalInput >= targetAmount + fee) {
      const change = totalInput - targetAmount - fee;
      if (change > 0 && change < dustThreshold) {
        return { selected: [...selected], fee: totalInput - targetAmount, change: 0 };
      }
      return { selected: [...selected], fee, change };
    }
  }
  return null;
}

// ── Fee estimation helpers ───────────────────────────────────────────────────

/**
 * Estimate the virtual size (vbytes) of a transaction.
 */
export function estimateVbytes(numInputs: number, numOutputs: number, inputVbytes: number = VBYTES_PER_P2WPKH_INPUT): number {
  return TX_OVERHEAD_VBYTES + numInputs * inputVbytes + numOutputs * VBYTES_PER_OUTPUT_DEFAULT;
}

/**
 * Calculate the maximum spendable amount given UTXOs and fee rate.
 */
export function calculateMaxSpendable(
  utxos: UTXO[],
  feeRate: number,
  dustThreshold: number = DUST_THRESHOLD_P2WPKH,
  inputVbytes: number = VBYTES_PER_P2WPKH_INPUT,
): number {
  const sorted = [...utxos].sort((a, b) => b.value - a.value);
  const candidates = sorted.slice(0, MAX_UTXO_INPUTS);
  const totalInput = candidates.reduce((sum, u) => sum + u.value, 0);
  const vbytes = TX_OVERHEAD_VBYTES + candidates.length * inputVbytes + 1 * VBYTES_PER_OUTPUT_DEFAULT;
  let fee = Math.ceil(vbytes * feeRate);
  if (fee < MIN_TX_FEE_SATS) fee = MIN_TX_FEE_SATS;
  const maxSpendable = totalInput - fee;
  if (maxSpendable < dustThreshold) return 0;
  return maxSpendable;
}
