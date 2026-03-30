/**
 * ElectrumTransport — low-level JSON-RPC 2.0 over WebSocket.
 *
 * Handles:
 *   - Connection lifecycle (connect, close, auto-reconnect)
 *   - Request/response matching by ID
 *   - Subscription notification dispatch
 *   - Heartbeat (server.ping every 55s)
 *   - Request timeout (15s default)
 *
 * Uses native.net.wsConnect/wsSend/wsOnMessage/wsOnClose from the C bridge.
 */

import type {
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcNotification,
} from './electrum-types.js';
import {
  ELECTRUM_CLIENT_NAME,
  ELECTRUM_PROTOCOL_VERSION,
  ELECTRUM_PING_INTERVAL,
  ELECTRUM_REQUEST_TIMEOUT,
} from './electrum-types.js';

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class ElectrumTransport {
  private wsHandle: number | null = null;
  private requestId = 0;
  private pending: Map<number, PendingRequest> = new Map();
  private subscriptions: Map<string, (params: unknown[]) => void> = new Map();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private url: string = '';
  private connected = false;
  private reconnecting = false;
  private reconnectAttempt = 0;
  private maxReconnectDelay = 30000;
  private onCloseCallback: (() => void) | null = null;

  /**
   * Connect to an Electrum WebSocket server.
   * Performs the server.version handshake.
   */
  async connect(url: string): Promise<{ serverVersion: string; protocolVersion: string }> {
    this.url = url;

    // Create WebSocket via native bridge
    this.wsHandle = native.net.wsConnect(url);

    // Set up message handler
    native.net.wsOnMessage(this.wsHandle, (data: string) => {
      this.handleMessage(data);
    });

    // Set up close handler
    native.net.wsOnClose(this.wsHandle, (error?: string) => {
      this.connected = false;
      this.rejectAllPending(error ?? 'Connection closed');
      if (this.pingTimer) {
        clearInterval(this.pingTimer);
        this.pingTimer = null;
      }
      if (this.onCloseCallback) this.onCloseCallback();
      // Auto-reconnect if not explicitly closed
      if (this.wsHandle !== null && !this.reconnecting) {
        this.scheduleReconnect();
      }
    });

    this.connected = true;
    this.reconnectAttempt = 0;

    // server.version handshake (MUST be first message)
    const result = await this.request('server.version', [
      ELECTRUM_CLIENT_NAME,
      ELECTRUM_PROTOCOL_VERSION,
    ]) as string[];

    // Start heartbeat
    this.pingTimer = setInterval(() => {
      if (this.connected) {
        this.request('server.ping', []).catch(() => {});
      }
    }, ELECTRUM_PING_INTERVAL);

    return {
      serverVersion: result[0] ?? 'unknown',
      protocolVersion: result[1] ?? '1.4',
    };
  }

  /**
   * Send a JSON-RPC request and wait for the response.
   */
  async request(method: string, params: unknown[]): Promise<unknown> {
    if (!this.connected || this.wsHandle === null) {
      throw new Error('Electrum transport not connected');
    }

    const id = ++this.requestId;
    const rpcRequest: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    return new Promise<unknown>((resolve, reject) => {
      // Set up timeout
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Electrum request timeout: ${method} (${ELECTRUM_REQUEST_TIMEOUT}ms)`));
      }, ELECTRUM_REQUEST_TIMEOUT);

      this.pending.set(id, { resolve, reject, timer });

      // Send (no newline — WebSocket framing handles it)
      native.net.wsSend(this.wsHandle!, JSON.stringify(rpcRequest));
    });
  }

  /**
   * Send a batch of JSON-RPC requests.
   */
  async batch(calls: Array<{ method: string; params: unknown[] }>): Promise<unknown[]> {
    if (!this.connected || this.wsHandle === null) {
      throw new Error('Electrum transport not connected');
    }

    const requests: JsonRpcRequest[] = [];
    const ids: number[] = [];

    for (const call of calls) {
      const id = ++this.requestId;
      ids.push(id);
      requests.push({
        jsonrpc: '2.0',
        id,
        method: call.method,
        params: call.params,
      });
    }

    // Create one Promise per request
    const promises = ids.map((id) => {
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`Electrum batch request timeout (${ELECTRUM_REQUEST_TIMEOUT}ms)`));
        }, ELECTRUM_REQUEST_TIMEOUT);
        this.pending.set(id, { resolve, reject, timer });
      });
    });

    // Send batch
    native.net.wsSend(this.wsHandle!, JSON.stringify(requests));

    return Promise.all(promises);
  }

  /**
   * Register a subscription notification handler.
   * When the server pushes a notification for this method, the callback is invoked.
   */
  onNotification(method: string, callback: (params: unknown[]) => void): void {
    this.subscriptions.set(method, callback);
  }

  /**
   * Remove a subscription handler.
   */
  removeNotification(method: string): void {
    this.subscriptions.delete(method);
  }

  /**
   * Set a callback for when the connection closes.
   */
  onClose(callback: () => void): void {
    this.onCloseCallback = callback;
  }

  /**
   * Close the connection. Prevents auto-reconnect.
   */
  close(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    this.connected = false;
    this.rejectAllPending('Connection closed by client');
    if (this.wsHandle !== null) {
      const handle = this.wsHandle;
      this.wsHandle = null; // prevent reconnect
      native.net.wsClose(handle);
    }
    this.subscriptions.clear();
  }

  /** Is the transport currently connected? */
  get isConnected(): boolean {
    return this.connected;
  }

  // ── Internal ───────────────────────────────────────────────────────────

  private handleMessage(data: string): void {
    let parsed: JsonRpcResponse | JsonRpcNotification | Array<JsonRpcResponse>;
    try {
      parsed = JSON.parse(data);
    } catch {
      return; // Malformed JSON — ignore
    }

    // Handle batch response (array)
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        this.dispatchResponse(item as JsonRpcResponse);
      }
      return;
    }

    // Check if it's a notification (no id) or a response (has id)
    if ('id' in parsed && typeof (parsed as JsonRpcResponse).id === 'number') {
      this.dispatchResponse(parsed as JsonRpcResponse);
    } else if ('method' in parsed) {
      this.dispatchNotification(parsed as JsonRpcNotification);
    }
  }

  private dispatchResponse(response: JsonRpcResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) return;

    this.pending.delete(response.id);
    clearTimeout(pending.timer);

    if (response.error) {
      const errMsg = typeof response.error === 'string'
        ? response.error
        : response.error.message;
      pending.reject(new Error(`Electrum error: ${errMsg}`));
    } else {
      pending.resolve(response.result);
    }
  }

  private dispatchNotification(notification: JsonRpcNotification): void {
    const handler = this.subscriptions.get(notification.method);
    if (handler) {
      handler(notification.params);
    }
  }

  private rejectAllPending(reason: string): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pending.clear();
  }

  private scheduleReconnect(): void {
    if (this.wsHandle === null) return; // explicitly closed
    this.reconnecting = true;
    const delay = Math.min(
      1000 * Math.pow(2, this.reconnectAttempt),
      this.maxReconnectDelay,
    );
    this.reconnectAttempt++;

    setTimeout(async () => {
      this.reconnecting = false;
      try {
        await this.connect(this.url);
        // Re-subscribe to all active subscriptions
        // (subscriptions are kept in the map — they survive reconnect)
      } catch {
        // Will trigger another reconnect via onClose
      }
    }, delay);
  }
}
