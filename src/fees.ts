/**
 * Bitcoin fee estimation using the mempool.space public API.
 */

import type { FeeEstimate } from './types.js';

/** Estimated vbytes per P2WPKH input */
const VBYTES_PER_INPUT = 68;
/** Estimated vbytes per output */
const VBYTES_PER_OUTPUT = 31;
/** Fixed transaction overhead in vbytes */
const TX_OVERHEAD_VBYTES = 11;

/**
 * Fetch recommended fee rates from the mempool.space API.
 *
 * Returns sat/vbyte estimates for fast (~1 block), medium (~3 blocks),
 * and slow (~6 blocks) confirmation targets.
 *
 * @param isTestnet  Query the testnet API
 */
export async function estimateFees(
  isTestnet: boolean = false,
): Promise<FeeEstimate> {
  const baseUrl = isTestnet
    ? 'https://mempool.space/testnet/api'
    : 'https://mempool.space/api';

  const response = await native.net.fetch(`${baseUrl}/v1/fees/recommended`);

  if (response.status !== 200) {
    throw new Error(
      `Fee estimation request failed with status ${response.status}`,
    );
  }

  const data = JSON.parse(response.body) as {
    fastestFee: number;
    halfHourFee: number;
    hourFee: number;
    economyFee: number;
    minimumFee: number;
  };

  return {
    fast: data.fastestFee,
    medium: data.halfHourFee,
    slow: data.hourFee,
  };
}

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
