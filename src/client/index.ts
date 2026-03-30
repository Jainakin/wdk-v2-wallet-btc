/**
 * Client module — pluggable Bitcoin chain data transports.
 *
 * Matches production tetherto/wdk-wallet-btc pattern:
 *   - IBtcClient interface (same 8 methods)
 *   - Multiple transport implementations
 *   - Factory to create from descriptor or pass-through existing instance
 */

export type { IBtcClient } from './btc-client.js';
export { BlockbookClient } from './blockbook-client.js';
export { MempoolRestClient } from './mempool-rest-client.js';
export { ElectrumWsClient } from './electrum-ws-client.js';

import type { IBtcClient } from './btc-client.js';
import type { BtcClientDescriptor, BtcNetwork } from '../types.js';
import { BlockbookClient } from './blockbook-client.js';
import { MempoolRestClient } from './mempool-rest-client.js';
import { ElectrumWsClient } from './electrum-ws-client.js';

/**
 * Create an IBtcClient from a descriptor object, or pass through an
 * already-constructed client instance.
 *
 * Matches production pattern where config.client can be either a
 * pre-built client or a descriptor object.
 */
export function createClient(
  descOrClient: BtcClientDescriptor | IBtcClient | unknown,
  network: BtcNetwork = 'bitcoin',
): IBtcClient {
  // If it already looks like an IBtcClient, return it directly
  if (
    descOrClient &&
    typeof descOrClient === 'object' &&
    'getBalance' in descOrClient &&
    'listUnspent' in descOrClient &&
    'broadcast' in descOrClient
  ) {
    return descOrClient as IBtcClient;
  }

  // Treat as descriptor
  const desc = descOrClient as BtcClientDescriptor;
  const net = desc.network ?? network;

  switch (desc.type) {
    // Production-compatible descriptors
    case 'blockbook-http':
    case 'blockbook':
      return new BlockbookClient(net, desc.url);
    case 'mempool-rest':
      return new MempoolRestClient(net, desc.url);
    // Electrum WebSocket — production-compatible transport
    case 'electrum-ws':
      return new ElectrumWsClient(net, desc.url);
    // Electrum TCP — not yet supported (requires native TCP bridge)
    case 'electrum':
      throw new Error(
        `BTC client type "electrum" (TCP) is not yet implemented in v2. ` +
        `Use "electrum-ws" for WebSocket or "blockbook-http"/"mempool-rest" for HTTP.`
      );
    default:
      throw new Error(`Unknown BTC client type: ${(desc as any).type}`);
  }
}
