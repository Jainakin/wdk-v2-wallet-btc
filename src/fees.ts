/**
 * Bitcoin fee/size estimation utilities.
 *
 * NOTE: The `estimateFees()` function that called mempool.space directly
 * has been removed. Fee estimation now goes through the IBtcClient interface
 * (client.estimateFee(blocks)), matching the production WDK pattern.
 */

/** Estimated vbytes per P2WPKH input */
const VBYTES_PER_INPUT = 68;
/** Estimated vbytes per output */
const VBYTES_PER_OUTPUT = 31;
/** Fixed transaction overhead in vbytes */
const TX_OVERHEAD_VBYTES = 11;

/**
 * Estimate the virtual size of a P2WPKH transaction in vbytes.
 *
 * @param inputCount   Number of inputs
 * @param outputCount  Number of outputs
 */
export function estimateTxVbytes(
  inputCount: number,
  outputCount: number,
): number {
  return (
    TX_OVERHEAD_VBYTES +
    inputCount * VBYTES_PER_INPUT +
    outputCount * VBYTES_PER_OUTPUT
  );
}

/**
 * Calculate the fee in satoshis for a given transaction size and fee rate.
 *
 * @param inputCount   Number of inputs
 * @param outputCount  Number of outputs
 * @param feeRate      Fee rate in sat/vbyte
 */
export function calculateFee(
  inputCount: number,
  outputCount: number,
  feeRate: number,
): number {
  return Math.ceil(estimateTxVbytes(inputCount, outputCount) * feeRate);
}
