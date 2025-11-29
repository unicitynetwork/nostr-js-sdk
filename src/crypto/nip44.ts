/**
 * NIP-44 Encryption implementation.
 * ChaCha20-Poly1305 AEAD encryption with HKDF key derivation.
 * Works in both Node.js and browser environments.
 * See: https://github.com/nostr-protocol/nips/blob/master/44.md
 */

import { chacha20poly1305 } from '@noble/ciphers/chacha';
import { secp256k1 } from '@noble/curves/secp256k1';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes, randomBytes, concatBytes } from '@noble/hashes/utils';

/** NIP-44 version byte */
export const VERSION = 0x02;

/** Nonce size for XChaCha20 (24 bytes) */
const NONCE_SIZE = 24;

/** MAC size for Poly1305 (16 bytes) */
const MAC_SIZE = 16;

/** Minimum padded length */
const MIN_PADDED_LEN = 32;

/** Maximum message length */
const MAX_MESSAGE_LEN = 65535;

/** HKDF salt for conversation key derivation */
const HKDF_SALT = new TextEncoder().encode('nip44-v2');

/**
 * Derive conversation key using ECDH + HKDF.
 * NIP-44 uses sorted public keys as salt for HKDF.
 *
 * @param myPrivateKey 32-byte private key
 * @param theirPublicKey 32-byte x-only public key
 * @returns 32-byte conversation key
 */
export function deriveConversationKey(
  myPrivateKey: Uint8Array,
  theirPublicKey: Uint8Array
): Uint8Array {
  if (myPrivateKey.length !== 32) {
    throw new Error('Private key must be 32 bytes');
  }
  if (theirPublicKey.length !== 32) {
    throw new Error('Public key must be 32 bytes');
  }

  // Get shared X coordinate via ECDH
  const sharedX = computeSharedX(myPrivateKey, theirPublicKey);

  // Get my public key
  const myPublicKey = secp256k1.getPublicKey(myPrivateKey, true).slice(1); // Remove prefix

  // Create salt from sorted public keys
  const salt = createSortedKeysSalt(myPublicKey, theirPublicKey);

  // Use HKDF to derive conversation key
  return hkdf(sha256, sharedX, salt, HKDF_SALT, 32);
}

/**
 * Derive conversation key from hex-encoded keys.
 */
export function deriveConversationKeyHex(
  myPrivateKeyHex: string,
  theirPublicKeyHex: string
): string {
  const myPrivateKey = hexToBytes(myPrivateKeyHex);
  const theirPublicKey = hexToBytes(theirPublicKeyHex);
  return bytesToHex(deriveConversationKey(myPrivateKey, theirPublicKey));
}

/**
 * Compute ECDH shared X coordinate.
 */
function computeSharedX(myPrivateKey: Uint8Array, theirPublicKey: Uint8Array): Uint8Array {
  // Reconstruct full public key (add 02 prefix for even y)
  const fullPublicKey = new Uint8Array(33);
  fullPublicKey[0] = 0x02;
  fullPublicKey.set(theirPublicKey, 1);

  // Compute shared point
  const sharedPoint = secp256k1.getSharedSecret(myPrivateKey, fullPublicKey);

  // Extract X coordinate (skip 04 prefix, take first 32 bytes)
  return sharedPoint.slice(1, 33);
}

/**
 * Create salt from lexicographically sorted public keys.
 */
function createSortedKeysSalt(pk1: Uint8Array, pk2: Uint8Array): Uint8Array {
  const cmp = compareBytes(pk1, pk2);
  if (cmp <= 0) {
    return concatBytes(pk1, pk2);
  } else {
    return concatBytes(pk2, pk1);
  }
}

/**
 * Compare two byte arrays lexicographically.
 */
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const diff = a[i]! - b[i]!;
    if (diff !== 0) return diff;
  }
  return a.length - b.length;
}

/**
 * Calculate padded length according to NIP-44 spec.
 * Uses power-of-2 chunk padding to hide message length.
 */
export function calcPaddedLen(unpaddedLen: number): number {
  if (unpaddedLen <= 0) {
    throw new Error('Message too short');
  }
  if (unpaddedLen > MAX_MESSAGE_LEN) {
    throw new Error('Message too long');
  }

  if (unpaddedLen <= 32) {
    return 32;
  }

  // Find next power of 2
  const nextPow2 = 1 << Math.ceil(Math.log2(unpaddedLen));
  const chunk = Math.max(32, nextPow2 >> 3);

  return Math.ceil(unpaddedLen / chunk) * chunk;
}

/**
 * Pad message according to NIP-44 spec.
 * Format: length(2 bytes big-endian) || message || padding
 */
export function pad(message: Uint8Array): Uint8Array {
  const len = message.length;
  if (len < 1) {
    throw new Error('Message too short');
  }
  if (len > MAX_MESSAGE_LEN) {
    throw new Error('Message too long');
  }

  const paddedLen = calcPaddedLen(len);
  const result = new Uint8Array(2 + paddedLen);

  // Big-endian length prefix
  result[0] = (len >> 8) & 0xff;
  result[1] = len & 0xff;

  // Copy message
  result.set(message, 2);

  // Remaining bytes are already zero (padding)

  return result;
}

/**
 * Unpad message according to NIP-44 spec.
 */
export function unpad(padded: Uint8Array): Uint8Array {
  if (padded.length < 2 + MIN_PADDED_LEN) {
    throw new Error('Padded message too short');
  }

  // Read big-endian length prefix
  const len = (padded[0]! << 8) | padded[1]!;

  if (len < 1 || len > MAX_MESSAGE_LEN) {
    throw new Error(`Invalid message length: ${len}`);
  }

  const expectedPaddedLen = calcPaddedLen(len);
  if (padded.length !== 2 + expectedPaddedLen) {
    throw new Error('Invalid padding');
  }

  return padded.slice(2, 2 + len);
}

/**
 * Encrypt a message using NIP-44.
 *
 * @param message Plaintext message
 * @param myPrivateKey Sender's 32-byte private key
 * @param theirPublicKey Recipient's 32-byte x-only public key
 * @returns Base64-encoded encrypted payload
 */
export function encrypt(
  message: string,
  myPrivateKey: Uint8Array,
  theirPublicKey: Uint8Array
): string {
  const conversationKey = deriveConversationKey(myPrivateKey, theirPublicKey);
  return encryptWithKey(message, conversationKey);
}

/**
 * Encrypt a message using a pre-derived conversation key.
 *
 * @param message Plaintext message
 * @param conversationKey 32-byte conversation key
 * @returns Base64-encoded encrypted payload
 */
export function encryptWithKey(message: string, conversationKey: Uint8Array): string {
  const encoder = new TextEncoder();
  const messageBytes = encoder.encode(message);

  if (messageBytes.length > MAX_MESSAGE_LEN) {
    throw new Error(`Message too long (max ${MAX_MESSAGE_LEN} bytes)`);
  }

  // Pad the message
  const padded = pad(messageBytes);

  // Generate random nonce (24 bytes for XChaCha20)
  const nonce = randomBytes(NONCE_SIZE);

  // Derive message keys using HKDF
  const messageKey = hkdf(sha256, conversationKey, nonce, new Uint8Array(0), 76);
  const chachaKey = messageKey.slice(0, 32);
  const chachaNonce = messageKey.slice(32, 44);

  // Encrypt with ChaCha20-Poly1305
  const cipher = chacha20poly1305(chachaKey, chachaNonce);
  const ciphertext = cipher.encrypt(padded);

  // Assemble payload: version(1) || nonce(24) || ciphertext+mac
  const payload = new Uint8Array(1 + NONCE_SIZE + ciphertext.length);
  payload[0] = VERSION;
  payload.set(nonce, 1);
  payload.set(ciphertext, 1 + NONCE_SIZE);

  return toBase64(payload);
}

/**
 * Decrypt a NIP-44 encrypted message.
 *
 * @param encryptedContent Base64-encoded encrypted payload
 * @param myPrivateKey Recipient's 32-byte private key
 * @param theirPublicKey Sender's 32-byte x-only public key
 * @returns Decrypted plaintext message
 */
export function decrypt(
  encryptedContent: string,
  myPrivateKey: Uint8Array,
  theirPublicKey: Uint8Array
): string {
  const conversationKey = deriveConversationKey(myPrivateKey, theirPublicKey);
  return decryptWithKey(encryptedContent, conversationKey);
}

/**
 * Decrypt a message using a pre-derived conversation key.
 *
 * @param encryptedContent Base64-encoded encrypted payload
 * @param conversationKey 32-byte conversation key
 * @returns Decrypted plaintext message
 */
export function decryptWithKey(encryptedContent: string, conversationKey: Uint8Array): string {
  const payload = fromBase64(encryptedContent);

  if (payload.length < 1 + NONCE_SIZE + MIN_PADDED_LEN + MAC_SIZE) {
    throw new Error('Payload too short');
  }

  // Check version
  if (payload[0] !== VERSION) {
    throw new Error(`Unsupported NIP-44 version: ${payload[0]}`);
  }

  // Extract components
  const nonce = payload.slice(1, 1 + NONCE_SIZE);
  const ciphertext = payload.slice(1 + NONCE_SIZE);

  // Derive message keys
  const messageKey = hkdf(sha256, conversationKey, nonce, new Uint8Array(0), 76);
  const chachaKey = messageKey.slice(0, 32);
  const chachaNonce = messageKey.slice(32, 44);

  // Decrypt with ChaCha20-Poly1305
  const cipher = chacha20poly1305(chachaKey, chachaNonce);
  const padded = cipher.decrypt(ciphertext);

  // Unpad
  const messageBytes = unpad(padded);

  const decoder = new TextDecoder();
  return decoder.decode(messageBytes);
}

/**
 * Encrypt a message using hex-encoded keys.
 */
export function encryptHex(
  message: string,
  myPrivateKeyHex: string,
  theirPublicKeyHex: string
): string {
  const myPrivateKey = hexToBytes(myPrivateKeyHex);
  const theirPublicKey = hexToBytes(theirPublicKeyHex);
  return encrypt(message, myPrivateKey, theirPublicKey);
}

/**
 * Decrypt a message using hex-encoded keys.
 */
export function decryptHex(
  encryptedContent: string,
  myPrivateKeyHex: string,
  theirPublicKeyHex: string
): string {
  const myPrivateKey = hexToBytes(myPrivateKeyHex);
  const theirPublicKey = hexToBytes(theirPublicKeyHex);
  return decrypt(encryptedContent, myPrivateKey, theirPublicKey);
}

/**
 * Convert a Uint8Array to base64 string (browser and Node.js compatible).
 */
function toBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  // Browser environment
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

/**
 * Convert a base64 string to Uint8Array (browser and Node.js compatible).
 */
function fromBase64(base64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(base64, 'base64'));
  }
  // Browser environment
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
