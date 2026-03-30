/**
 * UTXO coin selection for Bitcoin transactions.
 *
 * Matches production tetherto/wdk-wallet-btc patterns:
 *   - BIP-aware dust thresholds (546 for P2PKH/BIP44, 294 for P2WPKH/BIP84)
 *   - MAX_UTXO_INPUTS limit (200) to bound transaction size
 *   - MIN_TX_FEE_SATS floor (250) to ensure relay acceptance
 *   - Largest-first coin selection (accumulative strategy)
 */

import type { UTXO } from './types.js';

// ── Constants matching production ────────────────────────────────────────────

/** Estimated vbytes per P2WPKH input (witness-discounted) */
const VBYTES_PER_INPUT = 68;
/** Default estimated vbytes per output (P2WPKH — our change output) */
const VBYTES_PER_OUTPUT_DEFAULT = 31;
/** Fixed transaction overhead in vbytes (version + locktime + segwit marker) */
const TX_OVERHEAD_VBYTES = 11;

/**
 * Estimate output size in vbytes based on destination address format.
 * Output = 8 (value) + 1 (varint) + scriptPubKey length
 *
 * | Type     | scriptPubKey | Total vbytes |
 * |----------|-------------|--------------|
 * | P2WPKH   | 22 bytes    | 31           |
 * | P2SH     | 23 bytes    | 32           |
 * | P2PKH    | 25 bytes    | 34           |
 * | P2WSH    | 34 bytes    | 43           |
 * | P2TR     | 34 bytes    | 43           |
 */
function estimateOutputVbytes(address?: string): number {
  if (!address) return VBYTES_PER_OUTPUT_DEFAULT;
  if (address.startsWith('1') || address.startsWith('m') || address.startsWith('n')) return 34; // P2PKH
  if (address.startsWith('3') || address.startsWith('2')) return 32; // P2SH
  if (address.startsWith('bc1p') || address.startsWith('tb1p') || address.startsWith('bcrt1p')) return 43; // P2TR
  // bc1q with 32-byte program = P2WSH (62 char), 20-byte = P2WPKH (42 char)
  if (address.length > 50) return 43; // P2WSH
  return VBYTES_PER_OUTPUT_DEFAULT; // P2WPKH (default)
}

/** Dust threshold for P2PKH outputs (BIP44 legacy) — 546 sats */
export const DUST_THRESHOLD_P2PKH = 546;
/** Dust threshold for P2WPKH outputs (BIP84 native segwit) — 294 sats */
export const DUST_THRESHOLD_P2WPKH = 294;

/**
 * Minimum transaction fee in satoshis.
 * Even at 1 sat/vB, a standard 1-input-2-output P2WPKH tx is ~141 vbytes.
 * This floor prevents sub-relay-minimum-fee transactions from being rejected.
 */
export const MIN_TX_FEE_SATS = 141;

/**
 * Maximum number of UTXO inputs per transaction.
 * Bounds transaction size and prevents overly large transactions that
 * peers may reject. Matches production MAX_UTXO_INPUTS.
 */
export const MAX_UTXO_INPUTS = 200;

// ── Types ────────────────────────────────────────────────────────────────────

export interface CoinSelection {
  selected: UTXO[];
  fee: number;
  change: number;
}

// ── Coin selection ───────────────────────────────────────────────────────────

/**
 * Select UTXOs using a "largest first" (accumulative) strategy.
 *
 * Picks UTXOs from largest to smallest until the accumulated value
 * covers the target amount plus the estimated fee. The fee is
 * re-calculated after each UTXO is added because the transaction
 * size grows with each input.
 *
 * @param utxos         Available unspent outputs
 * @param targetAmount  Destination amount in satoshis
 * @param feeRate       Fee rate in sat/vbyte
 * @param dustThreshold Dust threshold (default: P2WPKH = 294)
 * @returns Selected UTXOs, fee, and change amount — or null if insufficient funds
 */
export function selectUtxos(
  utxos: UTXO[],
  targetAmount: number,
  feeRate: number,
  dustThreshold: number = DUST_THRESHOLD_P2WPKH,
  destinationAddress?: string,
): CoinSelection | null {
  // Sort descending by value (largest first)
  const sorted = [...utxos].sort((a, b) => b.value - a.value);

  // Enforce MAX_UTXO_INPUTS
  const candidates = sorted.slice(0, MAX_UTXO_INPUTS);

  const selected: UTXO[] = [];
  let totalInput = 0;

  // Destination output size depends on address type
  const destOutputVbytes = estimateOutputVbytes(destinationAddress);
  // Change output is always P2WPKH (our own address)
  const changeOutputVbytes = VBYTES_PER_OUTPUT_DEFAULT;

  for (const utxo of candidates) {
    selected.push(utxo);
    totalInput += utxo.value;

    // Estimate with 2 outputs (destination + change)
    const vbytes2 =
      TX_OVERHEAD_VBYTES +
      selected.length * VBYTES_PER_INPUT +
      destOutputVbytes + changeOutputVbytes;
    let fee = Math.ceil(vbytes2 * feeRate);

    // Enforce minimum fee floor
    if (fee < MIN_TX_FEE_SATS) {
      fee = MIN_TX_FEE_SATS;
    }

    if (totalInput >= targetAmount + fee) {
      const change = totalInput - targetAmount - fee;

      // If change is sub-dust, absorb it into the miner fee
      // rather than creating an uneconomical output
      if (change > 0 && change < dustThreshold) {
        const totalFee = totalInput - targetAmount;
        return { selected, fee: totalFee, change: 0 };
      }

      return { selected, fee, change };
    }
  }

  return null; // Insufficient funds
}

// ── Fee estimation helpers ───────────────────────────────────────────────────

/**
 * Estimate the virtual size (vbytes) of a transaction.
 * Used for post-sign fee rebalancing (#32).
 */
export function estimateVbytes(numInputs: number, numOutputs: number): number {
  return TX_OVERHEAD_VBYTES +
    numInputs * VBYTES_PER_INPUT +
    numOutputs * VBYTES_PER_OUTPUT_DEFAULT;
}

/**
 * Calculate the maximum spendable amount given UTXOs and fee rate.
 * Accounts for fee, dust threshold, and MAX_UTXO_INPUTS.
 */
export function calculateMaxSpendable(
  utxos: UTXO[],
  feeRate: number,
  dustThreshold: number = DUST_THRESHOLD_P2WPKH,
): number {
  // Sort descending, limit to MAX_UTXO_INPUTS
  const sorted = [...utxos].sort((a, b) => b.value - a.value);
  const candidates = sorted.slice(0, MAX_UTXO_INPUTS);

  const totalInput = candidates.reduce((sum, u) => sum + u.value, 0);

  // No change output when sending max (1 output only)
  const vbytes =
    TX_OVERHEAD_VBYTES +
    candidates.length * VBYTES_PER_INPUT +
    1 * VBYTES_PER_OUTPUT_DEFAULT;

  let fee = Math.ceil(vbytes * feeRate);
  if (fee < MIN_TX_FEE_SATS) fee = MIN_TX_FEE_SATS;

  const maxSpendable = totalInput - fee;

  // If max spendable is below dust, nothing can be sent
  if (maxSpendable < dustThreshold) return 0;

  return maxSpendable;
}
