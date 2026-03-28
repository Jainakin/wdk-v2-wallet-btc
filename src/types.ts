/** UTXO (Unspent Transaction Output) */
export interface UTXO {
  txid: string;       // Transaction ID (hex, 32 bytes)
  vout: number;       // Output index
  value: number;      // Satoshis
  scriptPubKey: string; // Hex-encoded script
  address?: string;
  confirmations?: number;
}

/** Transaction input for building a BTC transaction */
export interface BtcTxInput {
  txid: string;
  vout: number;
  value: number;
  scriptPubKey: string;
}

/** Transaction output for building a BTC transaction */
export interface BtcTxOutput {
  address: string;
  value: number; // satoshis
}

/** Unsigned Bitcoin transaction ready for signing */
export interface BtcUnsignedTx {
  inputs: BtcTxInput[];
  outputs: BtcTxOutput[];
  changeAddress: string;
  fee: number;
}

/** Signed Bitcoin transaction ready for broadcast */
export interface BtcSignedTx {
  rawTx: string; // hex-encoded raw transaction
  txid: string;
}

/** Fee rate estimates in sat/vbyte */
export interface FeeEstimate {
  fast: number;    // sat/vbyte for ~1 block
  medium: number;  // sat/vbyte for ~3 blocks
  slow: number;    // sat/vbyte for ~6 blocks
}
