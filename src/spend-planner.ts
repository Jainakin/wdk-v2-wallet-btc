/**
 * spend-planner.ts — Production-parity Bitcoin spend planning.
 *
 * Faithfully mirrors production tetherto/wdk-wallet-btc _planSpend() and
 * getMaxSpendable() semantics. Uses the same two-phase coin selection
 * algorithm as @bitcoinerlab/coinselect: avoidChange + addUntilReach,
 * with identical constants, sorting, dust handling, and fee calculation.
 *
 * Production reference:
 *   wallet-account-read-only-btc.js: _planSpend (lines 432-500)
 *   wallet-account-read-only-btc.js: getMaxSpendable (lines 264-329)
 *   @bitcoinerlab/coinselect: coinselect() → avoidChange + addUntilReach
 */

import type { UTXO } from './types.js';

// ── Production constants (exact match) ───────────────────────────────────────

/** Minimum transaction fee — matches production MIN_TX_FEE_SATS */
export const MIN_TX_FEE_SATS = 141;

/** Maximum UTXO inputs per transaction — matches production MAX_UTXO_INPUTS */
export const MAX_UTXO_INPUTS = 200;

/** P2WPKH input vbytes (segwit witness-discounted) */
export const VBYTES_PER_P2WPKH_INPUT = 68;

/** P2PKH input vbytes (legacy, no witness discount) */
export const VBYTES_PER_P2PKH_INPUT = 148;

/** Output vbytes — production uses 34 uniformly */
const OUTPUT_VBYTES = 34;

/** Transaction overhead vbytes (version + locktime + segwit marker + counts) */
const TX_OVERHEAD_VBYTES = 11;

/** Dust thresholds — matches production DUST_LIMIT map */
export const DUST_LIMIT = {
  p2pkh: 546,   // BIP44
  p2wpkh: 294,  // BIP84
} as const;

/**
 * BIP_BY_ADDRESS_PREFIX — matches production exactly.
 * Determines BIP type (44 or 84) from address prefix.
 */
function bipFromAddress(address: string): 44 | 84 {
  if (address.startsWith('bc1q') || address.startsWith('tb1q') || address.startsWith('bcrt1q')) return 84;
  return 44; // 1, m, n, or unknown → legacy
}

/** Get dust limit for an address */
export function dustLimitForAddress(address: string): number {
  return bipFromAddress(address) === 84 ? DUST_LIMIT.p2wpkh : DUST_LIMIT.p2pkh;
}

/** Get input vbytes for an address */
export function inputVbytesForAddress(address: string): number {
  return bipFromAddress(address) === 84 ? VBYTES_PER_P2WPKH_INPUT : VBYTES_PER_P2PKH_INPUT;
}

// ── Plan result type ─────────────────────────────────────────────────────────

export interface SpendPlan {
  /** Selected UTXOs to spend */
  utxos: UTXO[];
  /** Transaction fee in satoshis */
  fee: number;
  /** Change value in satoshis (0 = no change output) */
  changeValue: number;
}

export interface MaxSpendableResult {
  /** Maximum amount that can be sent */
  amount: number;
  /** Estimated fee for that send */
  fee: number;
  /** Change value (dust-limit minimum or 0) */
  changeValue: number;
}

// ── vsize estimation ─────────────────────────────────────────────────────────

/**
 * Estimate transaction vsize.
 * Matches production: txOverhead + (inputs × inputVbytes) + (outputs × 34)
 */
function estimateVsize(inputCount: number, outputCount: number, inputVbytes: number): number {
  return TX_OVERHEAD_VBYTES + inputCount * inputVbytes + outputCount * OUTPUT_VBYTES;
}

// ── Core coin selection (mirrors @bitcoinerlab/coinselect) ───────────────────

/**
 * Sort UTXOs by descending net value (value minus fee to spend).
 * Matches production coinselect sorting: utxoTransferredValue = value - (feeRate × inputWeight / 4)
 * Since inputWeight/4 ≈ inputVbytes, this is: value - (feeRate × inputVbytes)
 */
function sortByNetValue(utxos: UTXO[], feeRate: number, inputVbytes: number): UTXO[] {
  const perInputFee = Math.ceil(inputVbytes * feeRate);
  return [...utxos]
    .map(u => ({ u, netValue: u.value - perInputFee }))
    .filter(x => x.netValue > 0) // Production filters out UTXOs with non-positive net value
    .sort((a, b) => b.netValue - a.netValue)
    .map(x => x.u);
}

/**
 * Phase 1: avoidChange — try to find a no-change selection.
 *
 * Iterates sorted UTXOs, accumulating. For each accumulation state,
 * checks if total covers target + fee (1-output tx) and the remainder
 * is below the dust threshold (meaning change would be unspendable anyway).
 *
 * Matches production @bitcoinerlab/coinselect avoidChange algorithm.
 */
function avoidChange(
  sorted: UTXO[],
  targetAmount: number,
  feeRate: number,
  inputVbytes: number,
  dustThreshold: number,
): SpendPlan | null {
  const selected: UTXO[] = [];
  let totalInput = 0;

  for (const utxo of sorted) {
    selected.push(utxo);
    totalInput += utxo.value;

    // 1-output tx: only recipient, no change
    const vsize = estimateVsize(selected.length, 1, inputVbytes);
    let fee = Math.ceil(vsize * feeRate);
    if (fee < MIN_TX_FEE_SATS) fee = MIN_TX_FEE_SATS;

    if (totalInput >= targetAmount + fee) {
      const remainder = totalInput - targetAmount - fee;
      // If remainder is below dust threshold, it's not worth creating
      // a change output — absorb into fee instead.
      if (remainder <= dustThreshold) {
        return {
          utxos: [...selected],
          fee: fee + remainder,
          changeValue: 0,
        };
      }
    }
  }
  return null;
}

/**
 * Phase 2: addUntilReach — accumulative with change output.
 *
 * Greedily adds UTXOs until target + fee (2-output tx) is covered.
 * If change would be below dust threshold, absorbs into fee.
 *
 * Matches production @bitcoinerlab/coinselect addUntilReach algorithm.
 */
function addUntilReach(
  sorted: UTXO[],
  targetAmount: number,
  feeRate: number,
  inputVbytes: number,
  dustThreshold: number,
): SpendPlan | null {
  const selected: UTXO[] = [];
  let totalInput = 0;

  for (const utxo of sorted) {
    selected.push(utxo);
    totalInput += utxo.value;

    // 2-output tx: recipient + change
    const vsize = estimateVsize(selected.length, 2, inputVbytes);
    let fee = Math.ceil(vsize * feeRate);
    if (fee < MIN_TX_FEE_SATS) fee = MIN_TX_FEE_SATS;

    if (totalInput >= targetAmount + fee) {
      const change = totalInput - targetAmount - fee;
      if (change > 0 && change <= dustThreshold) {
        // Sub-dust change: absorb into fee
        return {
          utxos: [...selected],
          fee: totalInput - targetAmount, // all remainder becomes fee
          changeValue: 0,
        };
      }
      return {
        utxos: [...selected],
        fee,
        changeValue: change,
      };
    }
  }
  return null;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * planSpend — Production-parity spend planning.
 *
 * Mirrors production _planSpend() exactly:
 * 1. Validate amount > dustLimit
 * 2. Sort UTXOs by descending net value (value - perInputFee)
 * 3. Filter out UTXOs with non-positive net value
 * 4. Run coinselect (avoidChange → addUntilReach)
 * 5. Enforce MAX_UTXO_INPUTS and MIN_TX_FEE_SATS
 * 6. Calculate change; collapse sub-dust change into fee
 *
 * @returns SpendPlan or throws if insufficient funds
 */
export function planSpend(
  utxos: UTXO[],
  fromAddress: string,
  toAddress: string,
  amount: number,
  feeRate: number,
): SpendPlan {
  // Normalize
  feeRate = Math.max(feeRate, 1); // Enforce minimum 1 sat/vB

  const dustThreshold = dustLimitForAddress(fromAddress);
  const inputVbytes = inputVbytesForAddress(fromAddress);

  // Validate amount > dust limit (matches production line 437)
  if (amount <= dustThreshold) {
    throw new Error(`The amount must be bigger than the dust limit (= ${dustThreshold}).`);
  }

  // No UTXOs (matches production line 449)
  if (!utxos || utxos.length === 0) {
    throw new Error('No unspent outputs available.');
  }

  // Sort by descending net value and filter non-positive (matches production coinselect sorting)
  const sorted = sortByNetValue(utxos, feeRate, inputVbytes);

  if (sorted.length === 0) {
    throw new Error('Insufficient balance to send the transaction.');
  }

  // Limit to MAX_UTXO_INPUTS
  const candidates = sorted.slice(0, MAX_UTXO_INPUTS);

  // Phase 1: avoidChange
  const avoidResult = avoidChange(candidates, amount, feeRate, inputVbytes, dustThreshold);
  if (avoidResult) {
    // Enforce MIN_TX_FEE_SATS on final result (production line 474)
    avoidResult.fee = Math.max(avoidResult.fee, MIN_TX_FEE_SATS);
    return avoidResult;
  }

  // Phase 2: addUntilReach
  const accResult = addUntilReach(candidates, amount, feeRate, inputVbytes, dustThreshold);
  if (!accResult) {
    throw new Error('Insufficient balance to send the transaction.');
  }

  // Enforce MAX_UTXO_INPUTS (production line 470)
  if (accResult.utxos.length > MAX_UTXO_INPUTS) {
    throw new Error('Exceeded maximum allowed inputs for transaction.');
  }

  // Enforce MIN_TX_FEE_SATS (production line 474)
  accResult.fee = Math.max(accResult.fee, MIN_TX_FEE_SATS);

  return accResult;
}

/**
 * planMaxSpendable — Production-parity max spendable calculation.
 *
 * Mirrors production getMaxSpendable() exactly:
 * 1. Filter UTXOs by positive net value (value > perInputFee)
 * 2. Sort by value descending, limit to MAX_UTXO_INPUTS
 * 3. Try 2-output scenario: amount = total - fee - dustLimit
 * 4. Try 1-output scenario: amount = total - fee
 * 5. Return 0 if below dust limit
 */
export function planMaxSpendable(
  utxos: UTXO[],
  fromAddress: string,
  feeRate: number,
): MaxSpendableResult {
  feeRate = Math.max(feeRate, 1);
  const dustThreshold = dustLimitForAddress(fromAddress);
  const inputVbytes = inputVbytesForAddress(fromAddress);

  if (!utxos || utxos.length === 0) {
    return { amount: 0, fee: 0, changeValue: 0 };
  }

  // Filter spendable UTXOs (matches production line 289)
  const perInputFee = Math.ceil(inputVbytes * feeRate);
  let spendable = utxos.filter(u => (u.value - perInputFee) > 0);

  if (spendable.length === 0) {
    return { amount: 0, fee: 0, changeValue: 0 };
  }

  // Sort by value descending, limit to MAX_UTXO_INPUTS (production lines 295-299)
  if (spendable.length > MAX_UTXO_INPUTS) {
    spendable = [...spendable]
      .sort((a, b) => b.value - a.value)
      .slice(0, MAX_UTXO_INPUTS);
  }

  const totalInput = spendable.reduce((sum, u) => sum + u.value, 0);
  const inputCount = spendable.length;

  // Scenario 1: Two-output tx (recipient + change at dust limit)
  // Matches production lines 301-315
  const twoOutputVsize = estimateVsize(inputCount, 2, inputVbytes);
  const twoOutputFee = Math.max(Math.ceil(twoOutputVsize * feeRate), MIN_TX_FEE_SATS);
  const twoOutputAmount = totalInput - twoOutputFee - dustThreshold;

  if (twoOutputAmount > dustThreshold) {
    return {
      amount: twoOutputAmount,
      fee: twoOutputFee,
      changeValue: dustThreshold,
    };
  }

  // Scenario 2: One-output tx (no change)
  // Matches production lines 317-328
  const oneOutputVsize = estimateVsize(inputCount, 1, inputVbytes);
  const oneOutputFee = Math.max(Math.ceil(oneOutputVsize * feeRate), MIN_TX_FEE_SATS);
  const oneOutputAmount = totalInput - oneOutputFee;

  if (oneOutputAmount <= dustThreshold) {
    return { amount: 0, fee: 0, changeValue: 0 };
  }

  return {
    amount: oneOutputAmount,
    fee: oneOutputFee,
    changeValue: 0,
  };
}
