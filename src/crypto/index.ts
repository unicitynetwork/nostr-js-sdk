/**
 * Crypto module - Cryptographic utilities for Nostr protocol
 */

export * from './bech32.js';
export * as Bech32 from './bech32.js';
export * from './schnorr.js';
export * as SchnorrSigner from './schnorr.js';

// NIP-04 and NIP-44 have conflicting function names (encrypt, decrypt, etc.)
// Export them as namespaces only to avoid ambiguity
export * as NIP04 from './nip04.js';
export * as NIP44 from './nip44.js';
