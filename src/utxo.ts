/**
 * UTXO coin selection for Bitcoin transactions.
 */

import type { UTXO } from './types.js';

/** Estimated vbytes per P2WPKH input */
const VBYTES_PER_INPUT = 68;
/** Estimated vbytes per output */
const VBYTES_PER_OUTPUT = 31;
/** Fixed transaction overhead in vbytes */
const TX_OVERHEAD_VBYTES = 11;
/** Dust threshold in satoshis — outputs below this are uneconomical */
const DUST_THRESHOLD = 546;

/**
 * Simple coin selection using a "largest first" strategy.
 *
 * Picks UTXOs from largest to smallest until the accumulated value
 * covers the target amount plus the estimated fee.  The fee is
 * re-calculated after each UTXO is added because the transaction
 * size grows with each input.
 *
 * The estimate assumes 2 outputs (destination + change).  If the
 * resulting change is below the dust threshold it is dropped and
 * absorbed into the fee (output count becomes 1).
 *
 * @param utxos        Available unspent outputs
 * @param targetAmount Destination amount in satoshis
 * @param feeRate      Fee rate in sat/vbyte
 * @returns Selected UTXOs, fee, and change amount — or null if
 *          there are insufficient funds.
 */
export function selectUtxos(
  utxos: UTXO[],
  targetAmount: number,
  feeRate: number,
): { selected: UTXO[]; fee: number; change: number } | null {
  // Sort descending by value (largest first)
  const sorted = [...utxos].sort((a, b) => b.value - a.value);

  const selected: UTXO[] = [];
  let totalInput = 0;

  for (const utxo of sorted) {
    selected.push(utxo);
    totalInput += utxo.value;

    // Estimate with 2 outputs (destination + change)
    const vbytes2 =
      TX_OVERHEAD_VBYTES +
      selected.length * VBYTES_PER_INPUT +
      2 * VBYTES_PER_OUTPUT;
    const fee2 = Math.ceil(vbytes2 * feeRate);

    if (totalInput >= targetAmount + fee2) {
      const change = totalInput - targetAmount - fee2;

      // If change is dust, drop the change output and recalculate fee
      // with only 1 output.  The "lost" change becomes extra fee.
      if (change > 0 && change < DUST_THRESHOLD) {
        const vbytes1 =
          TX_OVERHEAD_VBYTES +
          selected.length * VBYTES_PER_INPUT +
          1 * VBYTES_PER_OUTPUT;
        const fee1 = Math.ceil(vbytes1 * feeRate);
        const feeWithDust = totalInput - targetAmount;
        // Only if we still cover the 1-output fee
        if (feeWithDust >= fee1) {
          return { selected, fee: feeWithDust, change: 0 };
        }
      }

      return { selected, fee: fee2, change };
    }
  }

  return null; // Insufficient funds
}
