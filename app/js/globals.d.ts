/*
Globals the app puts on (or reads from) `window`, declared so the JS type
check (tsconfig.checkjs.json) knows them. Keep this list short: each is a
deliberate escape hatch, not a place for app state.
*/

interface Window {
  /** NIP-07 signer injected by a browser extension (key-provider.js). */
  nostr?: {
    getPublicKey(): Promise<string>;
    signEvent(event: object): Promise<any>;
    nip44?: {
      encrypt(peerPubkey: string, plaintext: string): Promise<string>;
      decrypt(peerPubkey: string, ciphertext: string): Promise<string>;
    };
  };
  /** Friend key scanned on the record page, handed to add-friend (app.js). */
  __prefillFriendKey?: string;
  /** State injected by e2e tests before the app loads (dev/seed.js). */
  __IOU_SEED_STATE?: any;
  /** Console helper: ping a connected peer (peer/client.js). */
  ping?: (peerId: string) => Promise<number | null>;
  /** Push-hint decryption, exposed by sw-crypto-entry.js inside the service worker. */
  __tallyPushCrypto?: { decryptHint(...args: any[]): Promise<string> };
}
