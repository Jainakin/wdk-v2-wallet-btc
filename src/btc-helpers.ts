/**
 * Shared helper functions for Bitcoin wallet operations.
 * Used by both BtcAccount and BtcAccountReadOnly.
 */

// ── Bitcoin Signed Message hash ──────────────────────────────────────────────

/**
 * Compute the double-SHA256 hash of a Bitcoin Signed Message.
 * Format: "\x18Bitcoin Signed Message:\n" + varint(len) + message
 */
export function bitcoinMessageHash(message: string): Uint8Array {
  const prefix = new Uint8Array([
    0x18,
    0x42, 0x69, 0x74, 0x63, 0x6f, 0x69, 0x6e, 0x20,
    0x53, 0x69, 0x67, 0x6e, 0x65, 0x64, 0x20,
    0x4d, 0x65, 0x73, 0x73, 0x61, 0x67, 0x65, 0x3a,
    0x0a,
  ]);

  const msgBytes = native.encoding.utf8Encode(message);
  const varint = encodeVarint(msgBytes.length);

  const payload = new Uint8Array(prefix.length + varint.length + msgBytes.length);
  payload.set(prefix, 0);
  payload.set(varint, prefix.length);
  payload.set(msgBytes, prefix.length + varint.length);

  return native.crypto.sha256(native.crypto.sha256(payload));
}

// ── Varint encoding ──────────────────────────────────────────────────────────

export function encodeVarint(n: number): Uint8Array {
  if (n < 0xfd) return new Uint8Array([n]);
  if (n <= 0xffff) {
    const buf = new Uint8Array(3);
    buf[0] = 0xfd;
    buf[1] = n & 0xff;
    buf[2] = (n >> 8) & 0xff;
    return buf;
  }
  const buf = new Uint8Array(5);
  buf[0] = 0xfe;
  buf[1] = n & 0xff;
  buf[2] = (n >> 8) & 0xff;
  buf[3] = (n >> 16) & 0xff;
  buf[4] = (n >> 24) & 0xff;
  return buf;
}

// ── Base64 encoding/decoding (QuickJS has no btoa/atob) ─────────────────────

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function uint8ArrayToBase64(data: Uint8Array): string {
  let result = '';
  for (let i = 0; i < data.length; i += 3) {
    const a = data[i];
    const b = i + 1 < data.length ? data[i + 1] : 0;
    const c = i + 2 < data.length ? data[i + 2] : 0;
    result += B64_CHARS[(a >> 2) & 0x3f];
    result += B64_CHARS[((a << 4) | (b >> 4)) & 0x3f];
    result += i + 1 < data.length ? B64_CHARS[((b << 2) | (c >> 6)) & 0x3f] : '=';
    result += i + 2 < data.length ? B64_CHARS[c & 0x3f] : '=';
  }
  return result;
}

export function base64ToUint8Array(base64: string): Uint8Array {
  const lookup = new Map<string, number>();
  for (let i = 0; i < B64_CHARS.length; i++) lookup.set(B64_CHARS[i], i);

  const clean = base64.replace(/=/g, '');
  const outLen = Math.floor((clean.length * 3) / 4);
  const result = new Uint8Array(outLen);

  let j = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const a = lookup.get(clean[i]) ?? 0;
    const b = lookup.get(clean[i + 1]) ?? 0;
    const c = lookup.get(clean[i + 2]) ?? 0;
    const d = lookup.get(clean[i + 3]) ?? 0;
    result[j++] = (a << 2) | (b >> 4);
    if (j < outLen) result[j++] = ((b << 4) | (c >> 2)) & 0xff;
    if (j < outLen) result[j++] = ((c << 6) | d) & 0xff;
  }
  return result;
}

// ── Fee rate conversion ─────────────────────────────────────────────────────

/** Convert BTC/kB to sat/vB */
export function btcPerKbToSatVb(btcPerKb: number): number {
  return Math.ceil((btcPerKb * 1e8) / 1000);
}
