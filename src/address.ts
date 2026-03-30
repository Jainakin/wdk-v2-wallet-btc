/**
 * BIP-84 SegWit (P2WPKH) address generation.
 *
 * Uses the native.crypto and native.encoding bridges for all
 * cryptographic operations and bech32 encoding.
 */

/**
 * Convert between bit groups (BIP-173 "convertbits").
 *
 * Re-interprets a byte array from `fromBits`-wide groups into
 * `toBits`-wide groups.  When `pad` is true the final group is
 * zero-padded on the right; when false, a partial trailing group
 * that would lose data causes a null return.
 */
export function convertBits(
  data: Uint8Array,
  fromBits: number,
  toBits: number,
  pad: boolean,
): Uint8Array | null {
  let acc = 0;
  let bits = 0;
  const maxv = (1 << toBits) - 1;
  const result: number[] = [];

  for (let i = 0; i < data.length; i++) {
    const value = data[i];
    if (value < 0 || value >> fromBits !== 0) return null;

    acc = (acc << fromBits) | value;
    bits += fromBits;

    while (bits >= toBits) {
      bits -= toBits;
      result.push((acc >> bits) & maxv);
    }
  }

  if (pad) {
    if (bits > 0) {
      result.push((acc << (toBits - bits)) & maxv);
    }
  } else {
    if (bits >= fromBits) return null;
    if (((acc << (toBits - bits)) & maxv) !== 0) return null;
  }

  return new Uint8Array(result);
}

/**
 * Generate a BIP-84 SegWit (P2WPKH) address from an already-derived
 * key handle.
 *
 * Steps:
 *   1. Get compressed public key (33 bytes)
 *   2. SHA-256 the pubkey
 *   3. RIPEMD-160 the SHA-256 result  (= Hash160)
 *   4. Convert the 20-byte hash from 8-bit to 5-bit groups
 *   5. Prepend witness version 0
 *   6. Bech32-encode with hrp "bc" (mainnet) or "tb" (testnet)
 *
 * @param keyHandle  Key handle for the derived key
 * @param isTestnet  Use testnet prefix (tb1) instead of mainnet (bc1)
 * @param network    Network identifier — 'bitcoin', 'testnet', or 'regtest'
 * @returns bech32-encoded SegWit address (bc1q... / tb1q... / bcrt1q...)
 */
export function generateSegwitAddress(
  keyHandle: number,
  isTestnet: boolean = false,
  network?: string,
): string {
  // 1. Compressed public key
  const pubkey = native.crypto.getPublicKey(keyHandle, 'secp256k1');

  // 2-3. Hash160 = RIPEMD160(SHA256(pubkey))
  const sha = native.crypto.sha256(pubkey);
  const hash160 = native.crypto.ripemd160(sha);

  // 4. Convert 20-byte (8-bit) hash to 5-bit groups
  const data5 = convertBits(hash160, 8, 5, true);
  if (!data5) {
    throw new Error('Failed to convert pubkey hash to 5-bit groups');
  }

  // 5. Prepend witness version (0) and bech32-encode
  // HRP: 'bc' for mainnet, 'tb' for testnet, 'bcrt' for regtest
  const hrp = network === 'regtest' ? 'bcrt' : (isTestnet ? 'tb' : 'bc');
  const witnessData = new Uint8Array(1 + data5.length);
  witnessData[0] = 0; // witness version 0
  witnessData.set(data5, 1);

  return native.encoding.bech32Encode(hrp, witnessData);
}

/**
 * Generate a BIP-44 legacy (P2PKH) address from a key handle.
 *
 * Steps:
 *   1. Get compressed public key (33 bytes)
 *   2. Hash160 (SHA256 → RIPEMD160)
 *   3. Prepend version byte: 0x00 (mainnet) or 0x6f (testnet/regtest)
 *   4. Base58Check encode
 *
 * @param keyHandle  Key handle for the derived key
 * @param isTestnet  Use testnet version byte
 * @returns Base58Check-encoded P2PKH address (1... mainnet, m/n... testnet)
 */
export function generateLegacyAddress(
  keyHandle: number,
  isTestnet: boolean = false,
): string {
  const pubkey = native.crypto.getPublicKey(keyHandle, 'secp256k1');
  const sha = native.crypto.sha256(pubkey);
  const hash160 = native.crypto.ripemd160(sha);

  // Version byte: 0x00 for mainnet, 0x6f for testnet/regtest
  const version = isTestnet ? 0x6f : 0x00;
  const payload = new Uint8Array(21);
  payload[0] = version;
  payload.set(hash160, 1);

  return native.encoding.base58CheckEncode(payload);
}

/** Address type — BIP-84 native segwit or BIP-44 legacy */
export type BtcAddressType = 'p2wpkh' | 'p2pkh';

/**
 * Derive a BIP-84 key and generate its SegWit address.
 *
 * Path: m/84'/{coinType}'/{account}'/0/{index}
 *
 * @param seedHandle  Handle to the master seed
 * @param account     BIP-44 account index
 * @param index       Address index within the account
 * @param isTestnet   Testnet derivation (coin type 1)
 * @returns The derived key handle and the bech32 address
 */
export function deriveAddress(
  seedHandle: number,
  account: number,
  index: number,
  isTestnet: boolean,
  network?: string,
): { keyHandle: number; address: string } {
  const coinType = isTestnet ? 1 : 0;
  const path = `m/84'/${coinType}'/${account}'/0/${index}`;
  const keyHandle = native.crypto.deriveKey(seedHandle, path);
  const address = generateSegwitAddress(keyHandle, isTestnet, network);
  return { keyHandle, address };
}
