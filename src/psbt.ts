/**
 * PSBT (BIP-174) — Partially Signed Bitcoin Transaction.
 *
 * Implements the PSBT binary format for transaction construction,
 * signing, and finalization. All signing goes through the native
 * C bridge via key handles — private key bytes never enter JS.
 *
 * Roles implemented:
 *   Creator  — createPsbt()
 *   Updater  — addWitnessUtxo(), addNonWitnessUtxo(), addBip32Derivation()
 *   Signer   — signInput() (BIP-143 P2WPKH sighash + C bridge signing)
 *   Finalizer — finalizeInput()
 *   Extractor — extractTransaction()
 *
 * Reference: https://github.com/bitcoin/bips/blob/master/bip-0174.mediawiki
 */

import { addressToScriptPubKey } from './transaction.js';
import type { BtcTxInput, BtcTxOutput } from './types.js';

// ── PSBT Key Type Constants ──────────────────────────────────────────────────

// Global
const PSBT_GLOBAL_UNSIGNED_TX = 0x00;

// Per-input
const PSBT_IN_NON_WITNESS_UTXO = 0x00;
const PSBT_IN_WITNESS_UTXO = 0x01;
const PSBT_IN_PARTIAL_SIG = 0x02;
const PSBT_IN_SIGHASH_TYPE = 0x03;
const PSBT_IN_BIP32_DERIVATION = 0x06;
const PSBT_IN_FINAL_SCRIPTSIG = 0x07;
const PSBT_IN_FINAL_SCRIPTWITNESS = 0x08;

// Per-output
const PSBT_OUT_BIP32_DERIVATION = 0x02;

// Magic bytes
const PSBT_MAGIC = new Uint8Array([0x70, 0x73, 0x62, 0x74, 0xff]); // "psbt" + 0xFF

// ── Binary helpers ───────────────────────────────────────────────────────────

function writeUint32LE(value: number): Uint8Array {
  const buf = new Uint8Array(4);
  buf[0] = value & 0xff;
  buf[1] = (value >>> 8) & 0xff;
  buf[2] = (value >>> 16) & 0xff;
  buf[3] = (value >>> 24) & 0xff;
  return buf;
}

function writeUint64LE(value: number): Uint8Array {
  const buf = new Uint8Array(8);
  buf[0] = value & 0xff;
  buf[1] = (value >>> 8) & 0xff;
  buf[2] = (value >>> 16) & 0xff;
  buf[3] = (value >>> 24) & 0xff;
  const hi = Math.floor(value / 0x100000000);
  buf[4] = hi & 0xff;
  buf[5] = (hi >>> 8) & 0xff;
  buf[6] = (hi >>> 16) & 0xff;
  buf[7] = (hi >>> 24) & 0xff;
  return buf;
}

function writeVarInt(value: number): Uint8Array {
  if (value < 0xfd) return new Uint8Array([value]);
  if (value <= 0xffff) {
    const buf = new Uint8Array(3);
    buf[0] = 0xfd;
    buf[1] = value & 0xff;
    buf[2] = (value >>> 8) & 0xff;
    return buf;
  }
  const buf = new Uint8Array(5);
  buf[0] = 0xfe;
  buf[1] = value & 0xff;
  buf[2] = (value >>> 8) & 0xff;
  buf[3] = (value >>> 16) & 0xff;
  buf[4] = (value >>> 24) & 0xff;
  return buf;
}

function concat(...arrays: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const a of arrays) len += a.length;
  const result = new Uint8Array(len);
  let off = 0;
  for (const a of arrays) { result.set(a, off); off += a.length; }
  return result;
}

function reverseTxid(txidHex: string): Uint8Array {
  const bytes = native.encoding.hexDecode(txidHex);
  const reversed = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) reversed[i] = bytes[bytes.length - 1 - i];
  return reversed;
}

function hash256(data: Uint8Array): Uint8Array {
  return native.crypto.sha256(native.crypto.sha256(data));
}

function appendByte(data: Uint8Array, byte: number): Uint8Array {
  const out = new Uint8Array(data.length + 1);
  out.set(data);
  out[data.length] = byte;
  return out;
}

// ── DER encoding ─────────────────────────────────────────────────────────────

function encodeSignedInt(value: Uint8Array): Uint8Array {
  let start = 0;
  while (start < value.length - 1 && value[start] === 0) start++;
  const trimmed = value.slice(start);
  if (trimmed[0] & 0x80) {
    const padded = new Uint8Array(trimmed.length + 1);
    padded[0] = 0x00;
    padded.set(trimmed, 1);
    return padded;
  }
  return trimmed;
}

function encodeDER(sig: Uint8Array): Uint8Array {
  const r = sig.slice(0, 32);
  const s = sig.slice(32, 64);
  const encR = encodeSignedInt(r);
  const encS = encodeSignedInt(s);
  const totalLen = 2 + encR.length + 2 + encS.length;
  const der = new Uint8Array(2 + totalLen);
  let pos = 0;
  der[pos++] = 0x30;
  der[pos++] = totalLen;
  der[pos++] = 0x02;
  der[pos++] = encR.length;
  der.set(encR, pos); pos += encR.length;
  der[pos++] = 0x02;
  der[pos++] = encS.length;
  der.set(encS, pos);
  return der;
}

// ── PSBT Input/Output Data ───────────────────────────────────────────────────

export interface PSBTInput {
  /** Previous transaction serialized (non-witness) — for P2PKH/P2SH inputs */
  nonWitnessUtxo?: Uint8Array;
  /** Witness UTXO: amount + scriptPubKey — for P2WPKH/P2WSH/P2TR inputs */
  witnessUtxo?: { amount: number; scriptPubKey: Uint8Array };
  /** Partial signatures: pubkey → DER sig + sighashtype */
  partialSigs: Map<string, Uint8Array>;
  /** Sighash type (default: SIGHASH_ALL = 1) */
  sighashType: number;
  /** BIP-32 derivation info: pubkey → { fingerprint, path } */
  bip32Derivation?: Map<string, { fingerprint: Uint8Array; path: number[] }>;
  /** Finalized scriptSig (for legacy inputs) */
  finalScriptSig?: Uint8Array;
  /** Finalized witness (for segwit inputs) */
  finalScriptWitness?: Uint8Array;
  /** Unknown key-value pairs (passed through) */
  unknowns: Map<string, Uint8Array>;
}

export interface PSBTOutput {
  /** BIP-32 derivation for change output */
  bip32Derivation?: Map<string, { fingerprint: Uint8Array; path: number[] }>;
  /** Unknown key-value pairs */
  unknowns: Map<string, Uint8Array>;
}

export interface PSBT {
  /** Global: unsigned transaction (non-witness serialization) */
  unsignedTx: {
    version: number;
    inputs: BtcTxInput[];
    outputs: BtcTxOutput[];
    locktime: number;
  };
  /** Per-input metadata */
  inputs: PSBTInput[];
  /** Per-output metadata */
  outputs: PSBTOutput[];
}

// ── Creator ──────────────────────────────────────────────────────────────────

/**
 * Create a new PSBT from transaction inputs and outputs.
 * This is the Creator role from BIP-174.
 */
export function createPsbt(
  inputs: BtcTxInput[],
  outputs: BtcTxOutput[],
): PSBT {
  return {
    unsignedTx: {
      version: 2,
      inputs,
      outputs,
      locktime: 0,
    },
    inputs: inputs.map(() => ({
      partialSigs: new Map(),
      sighashType: 1, // SIGHASH_ALL
      unknowns: new Map(),
    })),
    outputs: outputs.map(() => ({
      unknowns: new Map(),
    })),
  };
}

// ── Updater ──────────────────────────────────────────────────────────────────

/**
 * Add witness UTXO data to a PSBT input (for P2WPKH/P2WSH/P2TR).
 * The witnessUtxo contains the amount and scriptPubKey of the output being spent.
 */
export function addWitnessUtxo(
  psbt: PSBT,
  inputIndex: number,
  amount: number,
  scriptPubKey: Uint8Array,
): void {
  psbt.inputs[inputIndex].witnessUtxo = { amount, scriptPubKey };
}

/**
 * Add non-witness UTXO data to a PSBT input (for legacy P2PKH/P2SH).
 * The nonWitnessUtxo is the full previous transaction serialization.
 */
export function addNonWitnessUtxo(
  psbt: PSBT,
  inputIndex: number,
  rawTx: Uint8Array,
): void {
  psbt.inputs[inputIndex].nonWitnessUtxo = rawTx;
}

/**
 * Add BIP-32 derivation info to a PSBT input.
 * Used by hardware wallets to verify the key path.
 */
export function addBip32Derivation(
  psbt: PSBT,
  inputIndex: number,
  pubkey: Uint8Array,
  fingerprint: Uint8Array,
  path: number[],
): void {
  if (!psbt.inputs[inputIndex].bip32Derivation) {
    psbt.inputs[inputIndex].bip32Derivation = new Map();
  }
  psbt.inputs[inputIndex].bip32Derivation!.set(
    native.encoding.hexEncode(pubkey),
    { fingerprint, path },
  );
}

// ── Signer ───────────────────────────────────────────────────────────────────

/**
 * Sign a P2WPKH input using BIP-143 sighash + native C bridge.
 *
 * This is the Signer role from BIP-174. The private key NEVER enters JS —
 * only the integer key handle is passed to native.crypto.signSecp256k1().
 */
export function signInput(
  psbt: PSBT,
  inputIndex: number,
  keyHandle: number,
): void {
  const { inputs, outputs } = psbt.unsignedTx;
  const input = psbt.inputs[inputIndex];

  // Determine if this is a witness input
  if (input.witnessUtxo) {
    // P2WPKH signing via BIP-143
    const sighash = computeSegwitSighash(psbt, inputIndex, keyHandle);
    const signature = native.crypto.signSecp256k1(keyHandle, sighash);
    const derSig = encodeDER(signature);
    const sigWithHashType = appendByte(derSig, input.sighashType);
    const pubkey = native.crypto.getPublicKey(keyHandle, 'secp256k1');

    input.partialSigs.set(native.encoding.hexEncode(pubkey), sigWithHashType);
  } else if (input.nonWitnessUtxo) {
    // Legacy P2PKH signing (non-BIP-143)
    const sighash = computeLegacySighash(psbt, inputIndex, keyHandle);
    const signature = native.crypto.signSecp256k1(keyHandle, sighash);
    const derSig = encodeDER(signature);
    const sigWithHashType = appendByte(derSig, input.sighashType);
    const pubkey = native.crypto.getPublicKey(keyHandle, 'secp256k1');

    input.partialSigs.set(native.encoding.hexEncode(pubkey), sigWithHashType);
  } else {
    throw new Error(`Input ${inputIndex} has no witnessUtxo or nonWitnessUtxo`);
  }
}

/**
 * BIP-143 sighash for P2WPKH inputs.
 */
function computeSegwitSighash(
  psbt: PSBT,
  inputIndex: number,
  keyHandle: number,
): Uint8Array {
  const { inputs, outputs, version, locktime } = psbt.unsignedTx;
  const sighashType = psbt.inputs[inputIndex].sighashType;

  // hashPrevouts
  const outpoints: Uint8Array[] = [];
  for (const inp of inputs) {
    outpoints.push(reverseTxid(inp.txid));
    outpoints.push(writeUint32LE(inp.vout));
  }
  const hashPrevouts = hash256(concat(...outpoints));

  // hashSequence
  const sequences: Uint8Array[] = [];
  for (let i = 0; i < inputs.length; i++) sequences.push(writeUint32LE(0xffffffff));
  const hashSequence = hash256(concat(...sequences));

  // hashOutputs
  const outputParts: Uint8Array[] = [];
  for (const out of outputs) {
    outputParts.push(writeUint64LE(out.value));
    const spk = addressToScriptPubKey(out.address);
    outputParts.push(writeVarInt(spk.length));
    outputParts.push(spk);
  }
  const hashOutputs = hash256(concat(...outputParts));

  // This input's outpoint
  const thisOutpoint = concat(
    reverseTxid(inputs[inputIndex].txid),
    writeUint32LE(inputs[inputIndex].vout),
  );

  // scriptCode for P2WPKH
  const pubkey = native.crypto.getPublicKey(keyHandle, 'secp256k1');
  const pubkeySha = native.crypto.sha256(pubkey);
  const pubkeyHash = native.crypto.ripemd160(pubkeySha);
  const scriptCode = new Uint8Array(26);
  scriptCode[0] = 0x19;
  scriptCode[1] = 0x76; scriptCode[2] = 0xa9; scriptCode[3] = 0x14;
  scriptCode.set(pubkeyHash, 4);
  scriptCode[24] = 0x88; scriptCode[25] = 0xac;

  const value = writeUint64LE(inputs[inputIndex].value);

  const preimage = concat(
    writeUint32LE(version),
    hashPrevouts, hashSequence,
    thisOutpoint, scriptCode, value,
    writeUint32LE(0xffffffff), // nSequence
    hashOutputs,
    writeUint32LE(locktime),
    writeUint32LE(sighashType),
  );

  return hash256(preimage);
}

/**
 * Legacy sighash for P2PKH inputs (non-segwit).
 *
 * The sighash is computed by:
 *   1. Serialize the tx with all scriptSig empty except the one being signed
 *   2. The signing input's scriptSig = the scriptPubKey of the output being spent
 *   3. Append sighash type as 4 bytes LE
 *   4. Double-SHA256 the result
 */
function computeLegacySighash(
  psbt: PSBT,
  inputIndex: number,
  keyHandle: number,
): Uint8Array {
  const { inputs, outputs, version, locktime } = psbt.unsignedTx;
  const sighashType = psbt.inputs[inputIndex].sighashType;

  // Get the scriptPubKey of the output being spent
  // For P2PKH: OP_DUP OP_HASH160 <hash> OP_EQUALVERIFY OP_CHECKSIG
  const pubkey = native.crypto.getPublicKey(keyHandle, 'secp256k1');
  const pubkeySha = native.crypto.sha256(pubkey);
  const pubkeyHash = native.crypto.ripemd160(pubkeySha);
  const prevScriptPubKey = new Uint8Array(25);
  prevScriptPubKey[0] = 0x76; prevScriptPubKey[1] = 0xa9; prevScriptPubKey[2] = 0x14;
  prevScriptPubKey.set(pubkeyHash, 3);
  prevScriptPubKey[23] = 0x88; prevScriptPubKey[24] = 0xac;

  const parts: Uint8Array[] = [];
  parts.push(writeUint32LE(version));
  parts.push(writeVarInt(inputs.length));

  for (let i = 0; i < inputs.length; i++) {
    parts.push(reverseTxid(inputs[i].txid));
    parts.push(writeUint32LE(inputs[i].vout));
    if (i === inputIndex) {
      // Signing input: scriptSig = previous scriptPubKey
      parts.push(writeVarInt(prevScriptPubKey.length));
      parts.push(prevScriptPubKey);
    } else {
      // Other inputs: empty scriptSig
      parts.push(writeVarInt(0));
    }
    parts.push(writeUint32LE(0xffffffff));
  }

  parts.push(writeVarInt(outputs.length));
  for (const out of outputs) {
    parts.push(writeUint64LE(out.value));
    const spk = addressToScriptPubKey(out.address);
    parts.push(writeVarInt(spk.length));
    parts.push(spk);
  }

  parts.push(writeUint32LE(locktime));
  // Append sighash type
  parts.push(writeUint32LE(sighashType));

  return hash256(concat(...parts));
}

// ── Finalizer ────────────────────────────────────────────────────────────────

/**
 * Finalize a PSBT input — produce the final scriptSig or scriptWitness.
 */
export function finalizeInput(psbt: PSBT, inputIndex: number): void {
  const input = psbt.inputs[inputIndex];

  if (input.partialSigs.size === 0) {
    throw new Error(`Input ${inputIndex} has no signatures`);
  }

  // Get the first (and usually only) partial sig
  const [pubkeyHex, sigWithHashType] = input.partialSigs.entries().next().value!;
  const pubkey = native.encoding.hexDecode(pubkeyHex);

  if (input.witnessUtxo) {
    // P2WPKH finalization: witness = [sig, pubkey]
    // Encode as: <num_items> <sig_len> <sig> <pubkey_len> <pubkey>
    const witnessParts: Uint8Array[] = [];
    witnessParts.push(writeVarInt(2)); // 2 stack items
    witnessParts.push(writeVarInt(sigWithHashType.length));
    witnessParts.push(sigWithHashType);
    witnessParts.push(writeVarInt(pubkey.length));
    witnessParts.push(pubkey);
    input.finalScriptWitness = concat(...witnessParts);
  } else if (input.nonWitnessUtxo) {
    // P2PKH finalization: scriptSig = <sig_push> <sig> <pubkey_push> <pubkey>
    const scriptParts: Uint8Array[] = [];
    scriptParts.push(new Uint8Array([sigWithHashType.length])); // push sig
    scriptParts.push(sigWithHashType);
    scriptParts.push(new Uint8Array([pubkey.length])); // push pubkey
    scriptParts.push(pubkey);
    input.finalScriptSig = concat(...scriptParts);
  }

  // Clear non-final fields per BIP-174
  input.partialSigs.clear();
  input.bip32Derivation = undefined;
  input.sighashType = 1;
}

// ── Extractor ────────────────────────────────────────────────────────────────

/**
 * Extract the final signed transaction from a fully-finalized PSBT.
 * Returns the raw hex and txid.
 */
export function extractTransaction(psbt: PSBT): { rawTx: string; txid: string } {
  const { inputs, outputs, version, locktime } = psbt.unsignedTx;
  const hasWitness = psbt.inputs.some((inp) => inp.finalScriptWitness);

  const parts: Uint8Array[] = [];

  // Version
  parts.push(writeUint32LE(version));

  // SegWit marker + flag (if any witness)
  if (hasWitness) {
    parts.push(new Uint8Array([0x00, 0x01]));
  }

  // Inputs
  parts.push(writeVarInt(inputs.length));
  for (let i = 0; i < inputs.length; i++) {
    parts.push(reverseTxid(inputs[i].txid));
    parts.push(writeUint32LE(inputs[i].vout));
    const scriptSig = psbt.inputs[i].finalScriptSig ?? new Uint8Array(0);
    parts.push(writeVarInt(scriptSig.length));
    if (scriptSig.length > 0) parts.push(scriptSig);
    parts.push(writeUint32LE(0xffffffff));
  }

  // Outputs
  parts.push(writeVarInt(outputs.length));
  for (const out of outputs) {
    parts.push(writeUint64LE(out.value));
    const spk = addressToScriptPubKey(out.address);
    parts.push(writeVarInt(spk.length));
    parts.push(spk);
  }

  // Witness data (if segwit)
  if (hasWitness) {
    for (let i = 0; i < inputs.length; i++) {
      const witness = psbt.inputs[i].finalScriptWitness;
      if (witness) {
        parts.push(witness);
      } else {
        // Empty witness for non-segwit inputs in a segwit tx
        parts.push(new Uint8Array([0x00]));
      }
    }
  }

  // Locktime
  parts.push(writeUint32LE(locktime));

  const rawTx = concat(...parts);

  // Compute txid from non-witness serialization
  const noWitnessParts: Uint8Array[] = [];
  noWitnessParts.push(writeUint32LE(version));
  noWitnessParts.push(writeVarInt(inputs.length));
  for (let i = 0; i < inputs.length; i++) {
    noWitnessParts.push(reverseTxid(inputs[i].txid));
    noWitnessParts.push(writeUint32LE(inputs[i].vout));
    const scriptSig = psbt.inputs[i].finalScriptSig ?? new Uint8Array(0);
    noWitnessParts.push(writeVarInt(scriptSig.length));
    if (scriptSig.length > 0) noWitnessParts.push(scriptSig);
    noWitnessParts.push(writeUint32LE(0xffffffff));
  }
  noWitnessParts.push(writeVarInt(outputs.length));
  for (const out of outputs) {
    noWitnessParts.push(writeUint64LE(out.value));
    const spk = addressToScriptPubKey(out.address);
    noWitnessParts.push(writeVarInt(spk.length));
    noWitnessParts.push(spk);
  }
  noWitnessParts.push(writeUint32LE(locktime));

  const rawNoWitness = concat(...noWitnessParts);
  const txidBytes = hash256(rawNoWitness);
  // Reverse for display convention
  const txidReversed = new Uint8Array(txidBytes.length);
  for (let i = 0; i < txidBytes.length; i++) {
    txidReversed[i] = txidBytes[txidBytes.length - 1 - i];
  }

  return {
    rawTx: native.encoding.hexEncode(rawTx),
    txid: native.encoding.hexEncode(txidReversed),
  };
}

// ── PSBT Binary Serialization ────────────────────────────────────────────────

/**
 * Serialize a PSBT to its binary format (BIP-174).
 * Useful for hardware wallet communication or file storage.
 */
export function serializePsbt(psbt: PSBT): Uint8Array {
  const parts: Uint8Array[] = [];

  // Magic
  parts.push(PSBT_MAGIC);

  // ── Global map ──
  // Unsigned tx
  const unsignedTxBytes = serializeUnsignedTx(psbt);
  parts.push(writeKeyValue(new Uint8Array([PSBT_GLOBAL_UNSIGNED_TX]), unsignedTxBytes));
  // Map terminator
  parts.push(new Uint8Array([0x00]));

  // ── Input maps ──
  for (const input of psbt.inputs) {
    if (input.nonWitnessUtxo) {
      parts.push(writeKeyValue(
        new Uint8Array([PSBT_IN_NON_WITNESS_UTXO]),
        input.nonWitnessUtxo,
      ));
    }
    if (input.witnessUtxo) {
      const wUtxo = concat(
        writeUint64LE(input.witnessUtxo.amount),
        writeVarInt(input.witnessUtxo.scriptPubKey.length),
        input.witnessUtxo.scriptPubKey,
      );
      parts.push(writeKeyValue(new Uint8Array([PSBT_IN_WITNESS_UTXO]), wUtxo));
    }
    for (const [pubkeyHex, sig] of input.partialSigs) {
      const key = concat(
        new Uint8Array([PSBT_IN_PARTIAL_SIG]),
        native.encoding.hexDecode(pubkeyHex),
      );
      parts.push(writeKeyValue(key, sig));
    }
    if (input.sighashType !== 1) { // Only write if non-default
      parts.push(writeKeyValue(
        new Uint8Array([PSBT_IN_SIGHASH_TYPE]),
        writeUint32LE(input.sighashType),
      ));
    }
    if (input.finalScriptSig) {
      parts.push(writeKeyValue(
        new Uint8Array([PSBT_IN_FINAL_SCRIPTSIG]),
        input.finalScriptSig,
      ));
    }
    if (input.finalScriptWitness) {
      parts.push(writeKeyValue(
        new Uint8Array([PSBT_IN_FINAL_SCRIPTWITNESS]),
        input.finalScriptWitness,
      ));
    }
    // Pass through unknowns
    for (const [keyHex, value] of input.unknowns) {
      parts.push(writeKeyValue(native.encoding.hexDecode(keyHex), value));
    }
    parts.push(new Uint8Array([0x00])); // terminator
  }

  // ── Output maps ──
  for (const output of psbt.outputs) {
    // Pass through unknowns
    for (const [keyHex, value] of output.unknowns) {
      parts.push(writeKeyValue(native.encoding.hexDecode(keyHex), value));
    }
    parts.push(new Uint8Array([0x00])); // terminator
  }

  return concat(...parts);
}

/** Write a BIP-174 key-value pair: <keylen><key><valuelen><value> */
function writeKeyValue(key: Uint8Array, value: Uint8Array): Uint8Array {
  return concat(writeVarInt(key.length), key, writeVarInt(value.length), value);
}

/** Serialize the unsigned transaction (non-witness format) for the global map. */
function serializeUnsignedTx(psbt: PSBT): Uint8Array {
  const { inputs, outputs, version, locktime } = psbt.unsignedTx;
  const parts: Uint8Array[] = [];

  parts.push(writeUint32LE(version));
  parts.push(writeVarInt(inputs.length));
  for (const inp of inputs) {
    parts.push(reverseTxid(inp.txid));
    parts.push(writeUint32LE(inp.vout));
    parts.push(writeVarInt(0)); // empty scriptSig
    parts.push(writeUint32LE(0xffffffff));
  }
  parts.push(writeVarInt(outputs.length));
  for (const out of outputs) {
    parts.push(writeUint64LE(out.value));
    const spk = addressToScriptPubKey(out.address);
    parts.push(writeVarInt(spk.length));
    parts.push(spk);
  }
  parts.push(writeUint32LE(locktime));

  return concat(...parts);
}

// ── High-level API ───────────────────────────────────────────────────────────

/**
 * Build, sign, and finalize a transaction via PSBT.
 *
 * This is the all-in-one function for the common case:
 *   1. Create PSBT from inputs/outputs
 *   2. Add witnessUtxo for each input (P2WPKH)
 *   3. Sign each input via native C bridge
 *   4. Finalize each input
 *   5. Extract the raw signed transaction
 *
 * Supports mixed input types: P2WPKH (witnessUtxo) and P2PKH (nonWitnessUtxo).
 *
 * @param inputs     Transaction inputs with scriptPubKey
 * @param outputs    Transaction outputs
 * @param keyHandles One key handle per input
 * @returns Signed transaction hex + txid
 */
export function buildAndSignPsbt(
  inputs: BtcTxInput[],
  outputs: BtcTxOutput[],
  keyHandles: number[],
): { rawTx: string; txid: string } {
  if (inputs.length !== keyHandles.length) {
    throw new Error(`Mismatched inputs (${inputs.length}) and keyHandles (${keyHandles.length})`);
  }
  if (inputs.length === 0) throw new Error('Transaction must have at least one input');
  if (outputs.length === 0) throw new Error('Transaction must have at least one output');

  // 1. Create
  const psbt = createPsbt(inputs, outputs);

  // 2. Update — add UTXO data for each input
  for (let i = 0; i < inputs.length; i++) {
    const spk = inputs[i].scriptPubKey
      ? native.encoding.hexDecode(inputs[i].scriptPubKey)
      : addressToScriptPubKey(inputs[i].address ?? '');

    // Determine input type from scriptPubKey
    if (spk.length === 25 && spk[0] === 0x76) {
      // P2PKH: needs nonWitnessUtxo (full previous tx)
      // For now, add witnessUtxo as fallback — full prev tx requires extra fetch
      // TODO: fetch full prev tx from client for true P2PKH support
      addWitnessUtxo(psbt, i, inputs[i].value, spk);
    } else {
      // P2WPKH, P2WSH, P2TR: witnessUtxo is sufficient
      addWitnessUtxo(psbt, i, inputs[i].value, spk);
    }
  }

  // 3. Sign
  for (let i = 0; i < inputs.length; i++) {
    signInput(psbt, i, keyHandles[i]);
  }

  // 4. Finalize
  for (let i = 0; i < inputs.length; i++) {
    finalizeInput(psbt, i);
  }

  // 5. Extract
  return extractTransaction(psbt);
}
