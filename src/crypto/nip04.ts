/**
 * NIP-04 Encryption implementation.
 * AES-256-CBC encryption with ECDH key agreement and optional GZIP compression.
 * Works in both Node.js and browser environments.
 */

import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils';

/**
 * Get the Web Crypto API (works in both Node.js and browser)
 */
async function getWebCrypto(): Promise<Crypto> {
  if (typeof globalThis.crypto?.subtle !== 'undefined') {
    return globalThis.crypto;
  }
  // Node.js environment - import webcrypto
  const nodeCrypto = await import('crypto');
  return nodeCrypto.webcrypto as unknown as Crypto;
}

/** Compression threshold in bytes */
const COMPRESSION_THRESHOLD = 1024;

/** Prefix for compressed messages */
const COMPRESSION_PREFIX = 'gz:';

/**
 * Convert a Uint8Array to base64 string (browser and Node.js compatible)
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
 * Convert a base64 string to Uint8Array (browser and Node.js compatible)
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

/**
 * Convert Uint8Array to a standard ArrayBuffer view for Web Crypto API compatibility
 */
function toBufferSource(data: Uint8Array): ArrayBuffer {
  // Create a new ArrayBuffer to ensure compatibility with Web Crypto API
  const buffer = new ArrayBuffer(data.length);
  new Uint8Array(buffer).set(data);
  return buffer;
}

/**
 * GZIP compress data (browser and Node.js compatible)
 */
async function compress(data: Uint8Array): Promise<Uint8Array> {
  // Check for Node.js environment first
  if (typeof process !== 'undefined' && process.versions?.node) {
    // Node.js environment - use native zlib
    const { gzipSync } = await import('zlib');
    return new Uint8Array(gzipSync(Buffer.from(data)));
  } else if (typeof CompressionStream !== 'undefined') {
    // Browser with Compression Streams API
    const stream = new CompressionStream('gzip');
    const writer = stream.writable.getWriter();
    writer.write(toBufferSource(data));
    writer.close();

    const chunks: Uint8Array[] = [];
    const reader = stream.readable.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }

    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  }
  throw new Error('GZIP compression not supported in this environment');
}

/**
 * GZIP decompress data (browser and Node.js compatible)
 */
async function decompress(data: Uint8Array): Promise<Uint8Array> {
  // Check for Node.js environment first
  if (typeof process !== 'undefined' && process.versions?.node) {
    // Node.js environment - use native zlib
    const { gunzipSync } = await import('zlib');
    return new Uint8Array(gunzipSync(Buffer.from(data)));
  } else if (typeof DecompressionStream !== 'undefined') {
    // Browser with Compression Streams API
    const stream = new DecompressionStream('gzip');
    const writer = stream.writable.getWriter();
    writer.write(toBufferSource(data));
    writer.close();

    const chunks: Uint8Array[] = [];
    const reader = stream.readable.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }

    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  }
  throw new Error('GZIP decompression not supported in this environment');
}

/**
 * Import an AES-256-CBC key for encryption/decryption
 */
async function importKey(keyBytes: Uint8Array): Promise<CryptoKey> {
  const crypto = await getWebCrypto();
  return crypto.subtle.importKey('raw', toBufferSource(keyBytes), { name: 'AES-CBC' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

/**
 * AES-256-CBC encrypt
 */
async function aesEncrypt(
  plaintext: Uint8Array,
  key: Uint8Array,
  iv: Uint8Array
): Promise<Uint8Array> {
  const crypto = await getWebCrypto();
  const cryptoKey = await importKey(key);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-CBC', iv: toBufferSource(iv) },
    cryptoKey,
    toBufferSource(plaintext)
  );
  return new Uint8Array(ciphertext);
}

/**
 * AES-256-CBC decrypt
 */
async function aesDecrypt(
  ciphertext: Uint8Array,
  key: Uint8Array,
  iv: Uint8Array
): Promise<Uint8Array> {
  const crypto = await getWebCrypto();
  const cryptoKey = await importKey(key);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-CBC', iv: toBufferSource(iv) },
    cryptoKey,
    toBufferSource(ciphertext)
  );
  return new Uint8Array(plaintext);
}

/**
 * Derive a shared secret using ECDH (NIP-04 compatible).
 * Returns SHA-256(sharedPoint.x) as the shared secret.
 * @param myPrivateKey 32-byte private key
 * @param theirPublicKey 32-byte x-only public key
 * @returns 32-byte shared secret
 */
export function deriveSharedSecret(
  myPrivateKey: Uint8Array,
  theirPublicKey: Uint8Array
): Uint8Array {
  if (myPrivateKey.length !== 32) {
    throw new Error('Private key must be 32 bytes');
  }
  if (theirPublicKey.length !== 32) {
    throw new Error('Public key must be 32 bytes');
  }

  // Reconstruct the full public key point from x-coordinate (assume even y)
  // For secp256k1, we need to prefix with 02 for even y
  const fullPublicKey = new Uint8Array(33);
  fullPublicKey[0] = 0x02;
  fullPublicKey.set(theirPublicKey, 1);

  // Compute ECDH shared point
  const sharedPoint = secp256k1.getSharedSecret(myPrivateKey, fullPublicKey);

  // Extract x-coordinate (skip the 0x04 prefix byte, take next 32 bytes)
  const sharedX = sharedPoint.slice(1, 33);

  // Return SHA-256 of the x-coordinate
  return sha256(sharedX);
}

/**
 * Derive a shared secret from hex-encoded keys
 * @param myPrivateKeyHex Hex-encoded private key
 * @param theirPublicKeyHex Hex-encoded public key
 * @returns Hex-encoded shared secret
 */
export function deriveSharedSecretHex(
  myPrivateKeyHex: string,
  theirPublicKeyHex: string
): string {
  const myPrivateKey = hexToBytes(myPrivateKeyHex);
  const theirPublicKey = hexToBytes(theirPublicKeyHex);
  return bytesToHex(deriveSharedSecret(myPrivateKey, theirPublicKey));
}

/**
 * Encrypt a message using NIP-04 encryption.
 * Format: "base64(ciphertext)?iv=base64(iv)"
 * If message > 1KB, automatically compresses with GZIP: "gz:base64(compressed)?iv=base64(iv)"
 * @param message Message to encrypt
 * @param myPrivateKey 32-byte private key
 * @param theirPublicKey 32-byte x-only public key
 * @returns Encrypted content string
 */
export async function encrypt(
  message: string,
  myPrivateKey: Uint8Array,
  theirPublicKey: Uint8Array
): Promise<string> {
  const encoder = new TextEncoder();
  let plaintext = encoder.encode(message);

  // Check if compression is needed
  let useCompression = false;
  let plaintextToEncrypt: Uint8Array = plaintext;
  if (plaintext.length > COMPRESSION_THRESHOLD) {
    const compressed = await compress(plaintext);
    // Only use compression if it actually reduces size
    if (compressed.length < plaintext.length) {
      plaintextToEncrypt = new Uint8Array(compressed);
      useCompression = true;
    }
  }

  // Derive shared secret
  const sharedSecret = deriveSharedSecret(myPrivateKey, theirPublicKey);

  // Generate random IV
  const iv = randomBytes(16);

  // Encrypt
  const ciphertext = await aesEncrypt(plaintextToEncrypt, sharedSecret, iv);

  // Format output
  const ciphertextBase64 = toBase64(ciphertext);
  const ivBase64 = toBase64(iv);

  if (useCompression) {
    return `${COMPRESSION_PREFIX}${ciphertextBase64}?iv=${ivBase64}`;
  }
  return `${ciphertextBase64}?iv=${ivBase64}`;
}

/**
 * Encrypt a message using hex-encoded keys
 * @param message Message to encrypt
 * @param myPrivateKeyHex Hex-encoded private key
 * @param theirPublicKeyHex Hex-encoded public key
 * @returns Encrypted content string
 */
export async function encryptHex(
  message: string,
  myPrivateKeyHex: string,
  theirPublicKeyHex: string
): Promise<string> {
  const myPrivateKey = hexToBytes(myPrivateKeyHex);
  const theirPublicKey = hexToBytes(theirPublicKeyHex);
  return encrypt(message, myPrivateKey, theirPublicKey);
}

/**
 * Decrypt a NIP-04 encrypted message.
 * Automatically decompresses if the message was compressed.
 * @param encryptedContent Encrypted content string
 * @param myPrivateKey 32-byte private key
 * @param theirPublicKey 32-byte x-only public key
 * @returns Decrypted message
 */
export async function decrypt(
  encryptedContent: string,
  myPrivateKey: Uint8Array,
  theirPublicKey: Uint8Array
): Promise<string> {
  // Check for compression prefix
  let content = encryptedContent;
  let isCompressed = false;
  if (content.startsWith(COMPRESSION_PREFIX)) {
    content = content.slice(COMPRESSION_PREFIX.length);
    isCompressed = true;
  }

  // Parse format: "base64(ciphertext)?iv=base64(iv)"
  const parts = content.split('?iv=');
  if (parts.length !== 2) {
    throw new Error('Invalid encrypted content format');
  }

  const ciphertextBase64 = parts[0]!;
  const ivBase64 = parts[1]!;

  const ciphertext = fromBase64(ciphertextBase64);
  const iv = fromBase64(ivBase64);

  if (iv.length !== 16) {
    throw new Error('Invalid IV length');
  }

  // Derive shared secret
  const sharedSecret = deriveSharedSecret(myPrivateKey, theirPublicKey);

  // Decrypt
  let plaintext = await aesDecrypt(ciphertext, sharedSecret, iv);

  // Decompress if needed
  if (isCompressed) {
    plaintext = await decompress(plaintext);
  }

  const decoder = new TextDecoder();
  return decoder.decode(plaintext);
}

/**
 * Decrypt a message using hex-encoded keys
 * @param encryptedContent Encrypted content string
 * @param myPrivateKeyHex Hex-encoded private key
 * @param theirPublicKeyHex Hex-encoded public key
 * @returns Decrypted message
 */
export async function decryptHex(
  encryptedContent: string,
  myPrivateKeyHex: string,
  theirPublicKeyHex: string
): Promise<string> {
  const myPrivateKey = hexToBytes(myPrivateKeyHex);
  const theirPublicKey = hexToBytes(theirPublicKeyHex);
  return decrypt(encryptedContent, myPrivateKey, theirPublicKey);
}
