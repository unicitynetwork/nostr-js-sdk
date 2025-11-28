/**
 * Unicity Nostr SDK
 *
 * A TypeScript SDK for Nostr protocol with Unicity extensions.
 * Works in both Node.js and browser environments.
 *
 * Features:
 * - BIP-340 Schnorr signatures
 * - NIP-04 encrypted direct messages with GZIP compression
 * - Multi-relay WebSocket connections with auto-reconnection
 * - Token transfers over Nostr
 * - Privacy-preserving nametag bindings
 *
 * @packageDocumentation
 */

// Core key management
export { NostrKeyManager } from './NostrKeyManager.js';

// Crypto utilities
export * from './crypto/index.js';
export {
  Bech32,
  SchnorrSigner,
  NIP04,
} from './crypto/index.js';

// Protocol types and classes
export * from './protocol/index.js';
export { EventKinds } from './protocol/index.js';

// Client
export * from './client/index.js';

// Nametag utilities
export * from './nametag/index.js';
export { NametagUtils, NametagBinding } from './nametag/index.js';

// Token transfer
export { TokenTransferProtocol } from './token/index.js';

// Payment requests
export { PaymentRequestProtocol } from './payment/index.js';

// Re-export common types for convenience
export type {
  DecodedBech32,
} from './crypto/bech32.js';

export type {
  EventTag,
  UnsignedEventData,
  SignedEventData,
} from './protocol/Event.js';

export type {
  FilterData,
} from './protocol/Filter.js';

export type {
  NostrEventListener,
} from './client/NostrEventListener.js';

export type {
  IWebSocket,
  WebSocketMessageEvent,
  WebSocketCloseEvent,
  WebSocketErrorEvent,
} from './client/WebSocketAdapter.js';

export type {
  PaymentRequest,
  ParsedPaymentRequest,
} from './payment/PaymentRequestProtocol.js';
