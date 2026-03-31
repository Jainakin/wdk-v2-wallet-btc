export { BitcoinWallet } from './btc-wallet.js';
export { BtcWalletManager } from './btc-wallet-manager.js';
export { BtcAccount } from './btc-account.js';
export { BtcAccountReadOnly } from './btc-account-read-only.js';
export * from './types.js';
export { generateSegwitAddress, deriveAddress } from './address.js';
export { selectUtxos } from './utxo.js';
export { planSpend, planMaxSpendable, dustLimitForAddress, inputVbytesForAddress } from './spend-planner.js';
export { buildTransaction, addressToScriptPubKey } from './transaction.js';
export { buildAndSignPsbt, createPsbt, signInput, finalizeInput, extractTransaction, serializePsbt } from './psbt.js';
export { estimateTxVbytes, calculateFee } from './fees.js';

// Client interface and implementations (matching production WDK pattern)
export type { IBtcClient } from './client/btc-client.js';
export { BlockbookClient } from './client/blockbook-client.js';
export { MempoolRestClient } from './client/mempool-rest-client.js';
export { ElectrumWsClient } from './client/electrum-ws-client.js';
export { createClient } from './client/index.js';
