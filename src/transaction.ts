/**
 * Bitcoin SegWit (P2WPKH) transaction building, signing, and
 * serialization.
 *
 * Implements BIP-143 sighash and full witness transaction
 * serialization.  All crypto goes through `native.crypto.*`.
 */

import type { BtcTxInput, BtcTxOutput, BtcSignedTx } from './types.js';

// ---------------------------------------------------------------------------
// Little-endian encoding helpers
// ---------------------------------------------------------------------------

/** Write a 32-bit unsigned integer in little-endian. */
function writeUint32LE(value: number): Uint8Array {
  const buf = new Uint8Array(4);
  buf[0] = value & 0xff;
  buf[1] = (value >>> 8) & 0xff;
  buf[2] = (value >>> 16) & 0xff;
  buf[3] = (value >>> 24) & 0xff;
  return buf;
}

/** Write a 64-bit unsigned integer in little-endian (JS safe-integer range). */
function writeUint64LE(value: number): Uint8Array {
  const buf = new Uint8Array(8);
  // Low 32 bits
  buf[0] = value & 0xff;
  buf[1] = (value >>> 8) & 0xff;
  buf[2] = (value >>> 16) & 0xff;
  buf[3] = (value >>> 24) & 0xff;
  // High 32 bits — use Math.floor to avoid float issues
  const hi = Math.floor(value / 0x100000000);
  buf[4] = hi & 0xff;
  buf[5] = (hi >>> 8) & 0xff;
  buf[6] = (hi >>> 16) & 0xff;
  buf[7] = (hi >>> 24) & 0xff;
  return buf;
}

/** Bitcoin variable-length integer encoding. */
function writeVarInt(value: number): Uint8Array {
  if (value < 0xfd) {
    return new Uint8Array([value]);
  } else if (value <= 0xffff) {
    const buf = new Uint8Array(3);
    buf[0] = 0xfd;
    buf[1] = value & 0xff;
    buf[2] = (value >>> 8) & 0xff;
    return buf;
  } else if (value <= 0xffffffff) {
    const buf = new Uint8Array(5);
    buf[0] = 0xfe;
    buf[1] = value & 0xff;
    buf[2] = (value >>> 8) & 0xff;
    buf[3] = (value >>> 16) & 0xff;
    buf[4] = (value >>> 24) & 0xff;
    return buf;
  } else {
    const buf = new Uint8Array(9);
    buf[0] = 0xff;
    const lo = value & 0xffffffff;
    const hi = Math.floor(value / 0x100000000);
    buf[1] = lo & 0xff;
    buf[2] = (lo >>> 8) & 0xff;
    buf[3] = (lo >>> 16) & 0xff;
    buf[4] = (lo >>> 24) & 0xff;
    buf[5] = hi & 0xff;
    buf[6] = (hi >>> 8) & 0xff;
    buf[7] = (hi >>> 16) & 0xff;
    buf[8] = (hi >>> 24) & 0xff;
    return buf;
  }
}

// ---------------------------------------------------------------------------
// Byte-array concatenation helper
// ---------------------------------------------------------------------------

function concat(...arrays: Uint8Array[]): Uint8Array {
  let totalLength = 0;
  for (const arr of arrays) totalLength += arr.length;
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

/** Append a single byte to a Uint8Array. */
function appendByte(data: Uint8Array, byte: number): Uint8Array {
  const out = new Uint8Array(data.length + 1);
  out.set(data);
  out[data.length] = byte;
  return out;
}

// ---------------------------------------------------------------------------
// Double SHA-256 (standard Bitcoin hash)
// ---------------------------------------------------------------------------

function hash256(data: Uint8Array): Uint8Array {
  return native.crypto.sha256(native.crypto.sha256(data));
}

// ---------------------------------------------------------------------------
// Reverse a 32-byte txid from hex (Bitcoin displays txids reversed)
// ---------------------------------------------------------------------------

function reverseTxid(txidHex: string): Uint8Array {
  const bytes = native.encoding.hexDecode(txidHex);
  const reversed = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    reversed[i] = bytes[bytes.length - 1 - i];
  }
  return reversed;
}

// ---------------------------------------------------------------------------
// Output script encoding
// ---------------------------------------------------------------------------

/**
 * Encode a bech32 address into its witness scriptPubKey.
 *
 * For P2WPKH (bc1q...): OP_0 <20-byte-hash>  →  0x0014{hash}
 * For P2WSH  (bc1q...): OP_0 <32-byte-hash>  →  0x0020{hash}
 *
 * This decodes the bech32 address to extract the witness program.
 */
function addressToScriptPubKey(address: string): Uint8Array {
  // Determine if bech32 or bech32m by trying decode
  let decoded: { hrp: string; data: Uint8Array };
  try {
    decoded = native.encoding.bech32Decode(address);
  } catch {
    // Try bech32m for witness v1+ (taproot)
    try {
      decoded = native.encoding.bech32mDecode(address);
    } catch {
      throw new Error(`Unsupported address format: ${address}. Only bech32 (bc1q) and bech32m (bc1p) addresses are supported.`);
    }
  }

  const witnessVersion = decoded.data[0];
  const data5bit = decoded.data.slice(1);

  // Convert 5-bit groups back to 8-bit bytes
  const program = convertBits5to8(data5bit);

  // scriptPubKey: <witnessVersion> <push length> <program>
  const script = new Uint8Array(2 + program.length);
  // OP_0 = 0x00, OP_1..OP_16 = 0x51..0x60
  script[0] = witnessVersion === 0 ? 0x00 : 0x50 + witnessVersion;
  script[1] = program.length;
  script.set(program, 2);
  return script;
}

/** Convert 5-bit groups to 8-bit bytes (inverse of BIP-173 convertbits). */
function convertBits5to8(data: Uint8Array): Uint8Array {
  let acc = 0;
  let bits = 0;
  const result: number[] = [];
  for (let i = 0; i < data.length; i++) {
    acc = (acc << 5) | data[i];
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      result.push((acc >> bits) & 0xff);
    }
  }
  // Discard incomplete trailing bits (should be zero-padded)
  return new Uint8Array(result);
}

// ---------------------------------------------------------------------------
// DER signature encoding
// ---------------------------------------------------------------------------

/**
 * DER-encode a 64-byte compact (r || s) ECDSA signature.
 *
 * Format: 0x30 <total-len> 0x02 <r-len> <r> 0x02 <s-len> <s>
 *
 * Each integer is encoded as a signed big-endian value: a leading
 * 0x00 byte is prepended if the high bit is set.
 */
function encodeDER(sig: Uint8Array): Uint8Array {
  if (sig.length !== 64) {
    throw new Error(`Expected 64-byte signature, got ${sig.length}`);
  }

  const r = sig.slice(0, 32);
  const s = sig.slice(32, 64);

  const encR = encodeSignedInt(r);
  const encS = encodeSignedInt(s);

  // 0x30 <len> 0x02 <rlen> <r> 0x02 <slen> <s>
  const totalLen = 2 + encR.length + 2 + encS.length;
  const der = new Uint8Array(2 + totalLen);
  let pos = 0;
  der[pos++] = 0x30;
  der[pos++] = totalLen;
  der[pos++] = 0x02;
  der[pos++] = encR.length;
  der.set(encR, pos);
  pos += encR.length;
  der[pos++] = 0x02;
  der[pos++] = encS.length;
  der.set(encS, pos);

  return der;
}

/** Encode a 32-byte big-endian unsigned integer as a DER signed integer. */
function encodeSignedInt(value: Uint8Array): Uint8Array {
  // Strip leading zero bytes (but keep at least one byte)
  let start = 0;
  while (start < value.length - 1 && value[start] === 0) {
    start++;
  }
  const trimmed = value.slice(start);

  // If the high bit is set, prepend a 0x00 byte
  if (trimmed[0] & 0x80) {
    const padded = new Uint8Array(trimmed.length + 1);
    padded[0] = 0x00;
    padded.set(trimmed, 1);
    return padded;
  }
  return trimmed;
}

// ---------------------------------------------------------------------------
// BIP-143 SegWit sighash computation (for P2WPKH)
// ---------------------------------------------------------------------------

/**
 * Compute the BIP-143 sighash for a single P2WPKH input.
 *
 * ```text
 * hashPrevouts = hash256(serialized outpoints of all inputs)
 * hashSequence = hash256(serialized sequences of all inputs)
 * hashOutputs  = hash256(serialized outputs)
 *
 * preimage =
 *   nVersion           (4 bytes LE)
 *   hashPrevouts       (32 bytes)
 *   hashSequence       (32 bytes)
 *   outpoint           (32+4 bytes — this input's txid + vout)
 *   scriptCode         (var — 0x1976a914{20-byte-hash}88ac for P2WPKH)
 *   value              (8 bytes LE — this input's value)
 *   nSequence          (4 bytes LE — this input's sequence)
 *   hashOutputs        (32 bytes)
 *   nLockTime          (4 bytes LE)
 *   nHashType          (4 bytes LE)
 *
 * sighash = hash256(preimage)
 * ```
 */
function computeSegwitSighash(
  inputs: BtcTxInput[],
  outputs: BtcTxOutput[],
  inputIndex: number,
  keyHandle: number,
): Uint8Array {
  const SIGHASH_ALL = 1;
  const nVersion = writeUint32LE(2); // tx version 2
  const nLockTime = writeUint32LE(0);
  const nHashType = writeUint32LE(SIGHASH_ALL);

  // hashPrevouts — hash256 of all outpoints
  const outpoints: Uint8Array[] = [];
  for (const inp of inputs) {
    outpoints.push(reverseTxid(inp.txid));
    outpoints.push(writeUint32LE(inp.vout));
  }
  const hashPrevouts = hash256(concat(...outpoints));

  // hashSequence — hash256 of all sequences
  const sequences: Uint8Array[] = [];
  for (let i = 0; i < inputs.length; i++) {
    sequences.push(writeUint32LE(0xffffffff)); // nSequence
  }
  const hashSequence = hash256(concat(...sequences));

  // hashOutputs — hash256 of all serialized outputs
  const outputParts: Uint8Array[] = [];
  for (const out of outputs) {
    outputParts.push(writeUint64LE(out.value));
    const scriptPubKey = addressToScriptPubKey(out.address);
    outputParts.push(writeVarInt(scriptPubKey.length));
    outputParts.push(scriptPubKey);
  }
  const hashOutputs = hash256(concat(...outputParts));

  // This input's outpoint
  const thisOutpoint = concat(
    reverseTxid(inputs[inputIndex].txid),
    writeUint32LE(inputs[inputIndex].vout),
  );

  // scriptCode for P2WPKH: OP_DUP OP_HASH160 <20 bytes> OP_EQUALVERIFY OP_CHECKSIG
  // = 0x76a914{pubkeyhash}88ac, length-prefixed with 0x19
  const pubkey = native.crypto.getPublicKey(keyHandle, 'secp256k1');
  const pubkeySha = native.crypto.sha256(pubkey);
  const pubkeyHash = native.crypto.ripemd160(pubkeySha);
  const scriptCode = new Uint8Array(26);
  scriptCode[0] = 0x19; // length prefix
  scriptCode[1] = 0x76; // OP_DUP
  scriptCode[2] = 0xa9; // OP_HASH160
  scriptCode[3] = 0x14; // push 20 bytes
  scriptCode.set(pubkeyHash, 4);
  scriptCode[24] = 0x88; // OP_EQUALVERIFY
  scriptCode[25] = 0xac; // OP_CHECKSIG

  // Value
  const value = writeUint64LE(inputs[inputIndex].value);

  // Sequence for this input
  const nSequence = writeUint32LE(0xffffffff);

  // Assemble preimage
  const preimage = concat(
    nVersion,
    hashPrevouts,
    hashSequence,
    thisOutpoint,
    scriptCode,
    value,
    nSequence,
    hashOutputs,
    nLockTime,
    nHashType,
  );

  return hash256(preimage);
}

// ---------------------------------------------------------------------------
// Transaction serialization
// ---------------------------------------------------------------------------

/**
 * Serialize the full SegWit transaction (with witness data).
 *
 * Format:
 *   version (4)
 *   marker  (1) — 0x00
 *   flag    (1) — 0x01
 *   vin count (varint)
 *   vin[]
 *   vout count (varint)
 *   vout[]
 *   witness[]
 *   locktime (4)
 */
function serializeTransaction(
  inputs: BtcTxInput[],
  outputs: BtcTxOutput[],
  witnesses: Uint8Array[][],
): Uint8Array {
  const parts: Uint8Array[] = [];

  // Version
  parts.push(writeUint32LE(2));

  // SegWit marker + flag
  parts.push(new Uint8Array([0x00, 0x01]));

  // Input count
  parts.push(writeVarInt(inputs.length));

  // Inputs
  for (const inp of inputs) {
    // Previous output hash (reversed txid)
    parts.push(reverseTxid(inp.txid));
    // Previous output index
    parts.push(writeUint32LE(inp.vout));
    // scriptSig (empty for SegWit)
    parts.push(writeVarInt(0));
    // Sequence
    parts.push(writeUint32LE(0xffffffff));
  }

  // Output count
  parts.push(writeVarInt(outputs.length));

  // Outputs
  for (const out of outputs) {
    // Value (satoshis, 8 bytes LE)
    parts.push(writeUint64LE(out.value));
    // scriptPubKey
    const scriptPubKey = addressToScriptPubKey(out.address);
    parts.push(writeVarInt(scriptPubKey.length));
    parts.push(scriptPubKey);
  }

  // Witness data (one stack per input)
  for (const witness of witnesses) {
    // Number of stack items
    parts.push(writeVarInt(witness.length));
    for (const item of witness) {
      parts.push(writeVarInt(item.length));
      parts.push(item);
    }
  }

  // Locktime
  parts.push(writeUint32LE(0));

  return concat(...parts);
}

/**
 * Serialize the transaction *without* witness data (for txid
 * computation).  The txid is hash256 of this serialization.
 */
function serializeTransactionNoWitness(
  inputs: BtcTxInput[],
  outputs: BtcTxOutput[],
): Uint8Array {
  const parts: Uint8Array[] = [];

  // Version
  parts.push(writeUint32LE(2));

  // Input count
  parts.push(writeVarInt(inputs.length));

  // Inputs
  for (const inp of inputs) {
    parts.push(reverseTxid(inp.txid));
    parts.push(writeUint32LE(inp.vout));
    parts.push(writeVarInt(0)); // empty scriptSig
    parts.push(writeUint32LE(0xffffffff));
  }

  // Output count
  parts.push(writeVarInt(outputs.length));

  // Outputs
  for (const out of outputs) {
    parts.push(writeUint64LE(out.value));
    const scriptPubKey = addressToScriptPubKey(out.address);
    parts.push(writeVarInt(scriptPubKey.length));
    parts.push(scriptPubKey);
  }

  // Locktime
  parts.push(writeUint32LE(0));

  return concat(...parts);
}

/**
 * Compute the txid from the raw transaction.
 *
 * The txid is the double-SHA256 of the non-witness serialization,
 * byte-reversed (Bitcoin convention: display as little-endian).
 */
function computeTxid(
  inputs: BtcTxInput[],
  outputs: BtcTxOutput[],
): Uint8Array {
  const rawNoWitness = serializeTransactionNoWitness(inputs, outputs);
  const h = hash256(rawNoWitness);
  // Reverse for display convention
  const reversed = new Uint8Array(h.length);
  for (let i = 0; i < h.length; i++) {
    reversed[i] = h[h.length - 1 - i];
  }
  return reversed;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build and sign a raw SegWit (P2WPKH) transaction.
 *
 * @param inputs     Transaction inputs (UTXOs to spend)
 * @param outputs    Transaction outputs (destinations + amounts)
 * @param keyHandles One key handle per input (must correspond 1:1)
 * @returns Hex-encoded raw transaction and its txid
 */
export function buildTransaction(
  inputs: BtcTxInput[],
  outputs: BtcTxOutput[],
  keyHandles: number[],
): BtcSignedTx {
  if (inputs.length !== keyHandles.length) {
    throw new Error(
      `Mismatched inputs (${inputs.length}) and keyHandles (${keyHandles.length})`,
    );
  }
  if (inputs.length === 0) {
    throw new Error('Transaction must have at least one input');
  }
  if (outputs.length === 0) {
    throw new Error('Transaction must have at least one output');
  }

  // Sign each input
  const witnesses: Uint8Array[][] = [];

  for (let i = 0; i < inputs.length; i++) {
    // BIP-143 sighash
    const sighash = computeSegwitSighash(inputs, outputs, i, keyHandles[i]);

    // Sign with secp256k1
    const signature = native.crypto.signSecp256k1(keyHandles[i], sighash);

    // DER-encode + SIGHASH_ALL byte
    const derSig = encodeDER(signature);
    const sigWithHashType = appendByte(derSig, 0x01); // SIGHASH_ALL

    // Compressed public key for the witness stack
    const pubkey = native.crypto.getPublicKey(keyHandles[i], 'secp256k1');

    witnesses.push([sigWithHashType, pubkey]);
  }

  // Serialize with witness
  const rawTx = serializeTransaction(inputs, outputs, witnesses);

  // Compute txid (from non-witness serialization)
  const txid = computeTxid(inputs, outputs);

  return {
    rawTx: native.encoding.hexEncode(rawTx),
    txid: native.encoding.hexEncode(txid),
  };
}
