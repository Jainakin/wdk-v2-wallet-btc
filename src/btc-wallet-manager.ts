/**
 * BtcWalletManager — Bitcoin chain manager.
 *
 * Owns the IBtcClient and network configuration.
 * Creates and caches BtcAccount/BtcAccountReadOnly per derivation path.
 *
 * Mirrors production: tetherto/wdk-wallet-btc WalletManagerBtc
 */

import { WalletManager } from '@aspect/wdk-v2-core';
import type { WalletAccount, WalletAccountReadOnly } from '@aspect/wdk-v2-core';
import type { NetworkConfig } from '@aspect/wdk-v2-utils';
import { generateSegwitAddress, generateLegacyAddress } from './address.js';
import type { IBtcClient } from './client/btc-client.js';
import { createClient, ElectrumWsClient, MempoolRestClient } from './client/index.js';
import type { BtcNetwork } from './types.js';
import { BtcAccount } from './btc-account.js';
import { BtcAccountReadOnly } from './btc-account-read-only.js';

export class BtcWalletManager extends WalletManager {
  private isTestnet_: boolean = false;
  private network_: BtcNetwork = 'bitcoin';
  private client_!: IBtcClient;

  constructor() {
    super('btc', 0, 'secp256k1');
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  async initialize(config: NetworkConfig): Promise<void> {
    this.config = config;

    // Determine network
    this.network_ = (config.network as BtcNetwork)
      ?? (config.isTestnet ? 'testnet' : 'bitcoin');
    this.isTestnet_ = this.network_ !== 'bitcoin';

    // Coin type: 0 for mainnet, 1 for testnet/regtest
    this.coinType = this.network_ === 'bitcoin' ? 0 : 1;

    // Create or accept the chain data client
    if ((config as any).btcClient) {
      this.client_ = createClient((config as any).btcClient, this.network_);
      await this.client_.connect();
    } else {
      // Try Electrum WebSocket first (production default)
      try {
        const electrum = new ElectrumWsClient(this.network_);
        await electrum.connect();
        this.client_ = electrum;
      } catch {
        // Fallback: MempoolRestClient
        this.client_ = new MempoolRestClient(this.network_);
        await this.client_.connect();
      }
    }
  }

  /**
   * BIP-84 (P2WPKH) or BIP-44 (P2PKH) derivation path.
   */
  override getDerivationPath(index: number, addressType?: string): string {
    const purpose = addressType === 'p2pkh' ? 44 : 84;
    return `m/${purpose}'/${this.coinType}'/0'/0/${index}`;
  }

  // ── Accessors for account classes ──────────────────────────────────────

  getClient(): IBtcClient { return this.client_; }
  getNetwork(): BtcNetwork { return this.network_; }
  isTestnetNetwork(): boolean { return this.isTestnet_; }

  // ── Account creation (template methods) ────────────────────────────────

  protected createAccount(
    keyHandle: number,
    publicKey: Uint8Array,
    index: number,
    path: string,
    addressType?: string,
  ): WalletAccount {
    // Derive address from public key
    let address: string;
    if (addressType === 'p2pkh') {
      address = generateLegacyAddress(keyHandle, this.isTestnet_);
    } else {
      address = generateSegwitAddress(keyHandle, this.isTestnet_, this.network_);
    }

    return new BtcAccount(
      this, keyHandle, publicKey, address, index, path, addressType ?? 'p2wpkh',
    );
  }

  protected createReadOnlyAccount(address: string, index: number): WalletAccountReadOnly {
    const path = this.getDerivationPath(index);
    return new BtcAccountReadOnly(this, address, index, path);
  }

  // ── Cleanup ────────────────────────────────────────────────────────────

  override destroy(): void {
    if (this.client_) {
      this.client_.close().catch(() => {});
    }
    this.network_ = 'bitcoin';
    this.isTestnet_ = false;
    super.destroy();
  }
}
