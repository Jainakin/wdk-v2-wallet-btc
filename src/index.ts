export { BitcoinWallet } from './btc-wallet.js';
export * from './types.js';
export { generateSegwitAddress, deriveAddress } from './address.js';
export { selectUtxos } from './utxo.js';
export { buildTransaction, addressToScriptPubKey } from './transaction.js';
export { buildAndSignPsbt, createPsbt, signInput, finalizeInput, extractTransaction, serializePsbt } from './psbt.js';
export { estimateTxVbytes, calculateFee } from './fees.js';

// Client interface and implementations (matching production WDK pattern)
export type { IBtcClient } from './client/btc-client.js';
export { BlockbookClient } from './client/blockbook-client.js';
export { MempoolRestClient } from './client/mempool-rest-client.js';
export { createClient } from './client/index.js';
