/**
 * Bitcoin fee/size estimation utilities.
 *
 * NOTE: The `estimateFees()` function that called mempool.space directly
 * has been removed. Fee estimation now goes through the IBtcClient interface
 * (client.estimateFee(blocks)), matching the production WDK pattern.
 */

import { VBYTES_PER_P2WPKH_INPUT } from './utxo.js';

/** Estimated vbytes per output */
const VBYTES_PER_OUTPUT = 31;
/** Fixed transaction overhead in vbytes */
const TX_OVERHEAD_VBYTES = 11;

/**
 * Estimate the virtual size of a transaction in vbytes.
 *
 * @param inputCount   Number of inputs
 * @param outputCount  Number of outputs
 * @param inputVbytes  Vbytes per input (68 for P2WPKH, 148 for P2PKH)
 */
export function estimateTxVbytes(
  inputCount: number,
  outputCount: number,
  inputVbytes: number = VBYTES_PER_P2WPKH_INPUT,
): number {
  return (
    TX_OVERHEAD_VBYTES +
    inputCount * inputVbytes +
    outputCount * VBYTES_PER_OUTPUT
  );
}

/**
 * Calculate the fee in satoshis for a given transaction size and fee rate.
 *
 * @param inputCount   Number of inputs
 * @param outputCount  Number of outputs
 * @param feeRate      Fee rate in sat/vbyte
 * @param inputVbytes  Vbytes per input (68 for P2WPKH, 148 for P2PKH)
 */
export function calculateFee(
  inputCount: number,
  outputCount: number,
  feeRate: number,
  inputVbytes: number = VBYTES_PER_P2WPKH_INPUT,
): number {
  return Math.ceil(estimateTxVbytes(inputCount, outputCount, inputVbytes) * feeRate);
}
