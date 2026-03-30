/**
 * Electrum Protocol JSON-RPC types.
 *
 * Reference: https://electrumx.readthedocs.io/en/latest/protocol-methods.html
 */

/** JSON-RPC 2.0 request */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params: unknown[];
}

/** JSON-RPC 2.0 response */
export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: string | { code: number; message: string };
}

/** JSON-RPC 2.0 notification (no id) — used for subscriptions */
export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params: unknown[];
}

/** Default Electrum WebSocket server URLs */
export const ELECTRUM_WS_URLS: Record<string, string> = {
  bitcoin: 'wss://blockstream.info/electrum-websocket',
  testnet: 'wss://blockstream.info/testnet/electrum-websocket',
  regtest: '', // requires user-provided URL
};

/** Electrum protocol version we negotiate */
export const ELECTRUM_CLIENT_NAME = 'wdk-v2';
export const ELECTRUM_PROTOCOL_VERSION = '1.4';

/** Heartbeat interval (ms) */
export const ELECTRUM_PING_INTERVAL = 55000; // 55s (server timeout ~60s)

/** Request timeout (ms) */
export const ELECTRUM_REQUEST_TIMEOUT = 15000;
