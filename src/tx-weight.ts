/**
 * tx-weight.ts — Exact transaction weight/vsize calculation.
 *
 * Matches bitcoinjs-lib Transaction.weight() and Transaction.virtualSize()
 * exactly, computed from raw serialized transaction bytes.
 *
 * Formula (BIP-141):
 *   base_size  = size of tx serialized WITHOUT witness data
 *   total_size = size of tx serialized WITH witness data
 *   weight     = base_size * 3 + total_size
 *   vsize      = ceil(weight / 4)
 *
 * This is mathematically equivalent to:
 *   weight = non_witness_bytes * 4 + witness_bytes
 *   vsize  = ceil(weight / 4)
 *
 * We parse the raw bytes to separate witness from non-witness, then apply
 * the same arithmetic as bitcoinjs-lib.
 */

// ── Varint helpers ───────────────────────────────────────────────────────────

/** Read a Bitcoin varint from a buffer at offset. Returns [value, bytesConsumed]. */
function readVarint(buf: Uint8Array, offset: number): [number, number] {
  const first = buf[offset];
  if (first < 0xfd) return [first, 1];
  if (first === 0xfd) return [(buf[offset + 1]) | (buf[offset + 2] << 8), 3];
  if (first === 0xfe) {
    return [
      (buf[offset + 1]) | (buf[offset + 2] << 8) |
      (buf[offset + 3] << 16) | (buf[offset + 4] << 24) >>> 0,
      5,
    ];
  }
  // 0xff — 8-byte varint (unlikely for tx counts, but handle it)
  let val = 0;
  for (let i = 0; i < 8; i++) val += buf[offset + 1 + i] * (256 ** i);
  return [val, 9];
}

// ── Main calculation ─────────────────────────────────────────────────────────

/**
 * Calculate the exact virtual size (vsize) of a serialized Bitcoin transaction.
 *
 * Parses the raw bytes to find the boundary between non-witness and witness
 * data, then applies the BIP-141 weight formula.
 *
 * Produces the same integer result as bitcoinjs-lib's Transaction.virtualSize()
 * for the same raw transaction.
 */
export function calculateVsize(rawBytes: Uint8Array): number {
  const totalSize = rawBytes.length;
  let offset = 0;

  // Version (4 bytes)
  offset += 4;

  // Detect segwit marker + flag
  const isSegwit = rawBytes[offset] === 0x00 && rawBytes[offset + 1] === 0x01;
  if (isSegwit) offset += 2; // skip marker + flag

  // Input count (varint)
  const [inCount, inCountLen] = readVarint(rawBytes, offset);
  offset += inCountLen;

  // Parse each input (to skip past them)
  for (let i = 0; i < inCount; i++) {
    offset += 32; // txid
    offset += 4;  // vout
    // scriptSig (varint length + data)
    const [scriptLen, scriptLenBytes] = readVarint(rawBytes, offset);
    offset += scriptLenBytes + scriptLen;
    offset += 4;  // sequence
  }

  // Output count (varint)
  const [outCount, outCountLen] = readVarint(rawBytes, offset);
  offset += outCountLen;

  // Parse each output (to skip past them)
  for (let i = 0; i < outCount; i++) {
    offset += 8; // value (uint64)
    // scriptPubKey (varint length + data)
    const [spkLen, spkLenBytes] = readVarint(rawBytes, offset);
    offset += spkLenBytes + spkLen;
  }

  // Now `offset` points to the start of witness data (if segwit) or locktime
  // Locktime is always the last 4 bytes
  // witness data = everything from offset to (totalSize - 4)

  if (!isSegwit) {
    // No witness discount — vsize = total size
    return totalSize;
  }

  // Segwit: compute base_size (serialized without witness and without marker+flag)
  // base_size = version(4) + vin_count + inputs + vout_count + outputs + locktime(4)
  // That's: totalSize - markerFlag(2) - witnessData
  const witnessDataSize = totalSize - offset - 4; // subtract locktime at the end
  const markerFlagSize = 2;
  const baseSize = totalSize - markerFlagSize - witnessDataSize;

  // BIP-141 weight = base_size * 3 + total_size
  // (equivalent to: non_witness * 4 + witness, where witness = markerFlag + witnessData)
  const weight = baseSize * 3 + totalSize;

  return Math.ceil(weight / 4);
}
