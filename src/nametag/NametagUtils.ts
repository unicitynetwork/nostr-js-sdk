/**
 * NametagUtils - Privacy-preserving nametag normalization and hashing.
 * Supports phone number normalization to E.164 format.
 */

import { sha256 } from '@noble/hashes/sha256';
import { hkdf } from '@noble/hashes/hkdf';
import { bytesToHex } from '@noble/hashes/utils';
import { parsePhoneNumber, isValidPhoneNumber, CountryCode } from 'libphonenumber-js';

/**
 * Get the Web Crypto API (works in both Node.js and browser).
 */
async function getWebCrypto(): Promise<Crypto> {
  if (typeof globalThis.crypto?.subtle !== 'undefined') {
    return globalThis.crypto;
  }
  // Node.js environment - import webcrypto
  const nodeCrypto = await import('crypto');
  return nodeCrypto.webcrypto as unknown as Crypto;
}

/**
 * Base64 encode (works in both Node.js and browser).
 */
function toBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  return btoa(String.fromCharCode(...Array.from(bytes)));
}

/**
 * Base64 decode (works in both Node.js and browser).
 */
function fromBase64(base64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(base64, 'base64'));
  }
  return Uint8Array.from(atob(base64), c => c.charCodeAt(0));
}

/** Salt prefix for nametag hashing */
const NAMETAG_SALT = 'unicity:nametag:';

/** Minimum nametag length (after normalization) */
export const NAMETAG_MIN_LENGTH = 3;

/** Maximum nametag length (after normalization) */
export const NAMETAG_MAX_LENGTH = 20;

/** Default country code for phone number normalization */
const DEFAULT_COUNTRY = 'US';

/** Salt prefix for address hashing */
const ADDRESS_SALT = 'unicity:address:';

/**
 * Compute SHA-256 hash of a string.
 * @param input String to hash
 * @returns Hex-encoded hash
 */
export function sha256Hex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  return bytesToHex(sha256(bytes));
}

/**
 * Check if a string looks like a phone number.
 * Heuristic: starts with + OR has >50% digits AND >= 7 digits total.
 * @param str String to check
 * @returns true if the string looks like a phone number
 */
function isLikelyPhoneNumber(str: string): boolean {
  if (str.startsWith('+')) {
    return true;
  }

  const digitsOnly = str.replace(/\D/g, '');
  const digitCount = digitsOnly.length;

  if (digitCount < 7) {
    return false;
  }

  // Count non-digit characters (excluding common phone number chars)
  const cleanedLength = str.replace(/[\s\-().]/g, '').length;
  const digitRatio = digitCount / cleanedLength;

  return digitRatio > 0.5;
}

/**
 * Normalize a phone number to E.164 format.
 * @param phoneNumber Phone number string
 * @param defaultCountry Default country code
 * @returns E.164 formatted phone number, or null if invalid
 */
function normalizePhoneNumber(
  phoneNumber: string,
  defaultCountry: string
): string | null {
  try {
    // Try to parse with default country
    if (isValidPhoneNumber(phoneNumber, defaultCountry as CountryCode)) {
      const parsed = parsePhoneNumber(phoneNumber, defaultCountry as CountryCode);
      return parsed.format('E.164');
    }

    // Try without default country (for numbers with country code)
    if (isValidPhoneNumber(phoneNumber)) {
      const parsed = parsePhoneNumber(phoneNumber);
      return parsed.format('E.164');
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Normalize a nametag for hashing.
 * - If it looks like a phone number, normalize to E.164
 * - Otherwise, lowercase and remove @unicity suffix
 * @param nametag Nametag to normalize
 * @param defaultCountry Default country code for phone normalization
 * @returns Normalized nametag
 */
export function normalizeNametag(
  nametag: string,
  defaultCountry: string = DEFAULT_COUNTRY
): string {
  const trimmed = nametag.trim();

  if (isLikelyPhoneNumber(trimmed)) {
    const normalized = normalizePhoneNumber(trimmed, defaultCountry);
    if (normalized) {
      return normalized;
    }
    // If phone normalization fails, fall through to standard normalization
  }

  // Standard normalization: lowercase, remove @unicity suffix
  let normalized = trimmed.toLowerCase();
  if (normalized.endsWith('@unicity')) {
    normalized = normalized.slice(0, -8);
  }

  return normalized;
}

/**
 * Hash a nametag with the standard salt.
 * @param nametag Nametag to hash
 * @param defaultCountry Default country code for phone normalization
 * @returns Hex-encoded SHA-256 hash
 */
export function hashNametag(
  nametag: string,
  defaultCountry: string = DEFAULT_COUNTRY
): string {
  const normalized = normalizeNametag(nametag, defaultCountry);
  return sha256Hex(NAMETAG_SALT + normalized);
}

/**
 * Compare two nametags for equality (handling format variations).
 * @param tag1 First nametag
 * @param tag2 Second nametag
 * @param defaultCountry Default country code for phone normalization
 * @returns true if the nametags represent the same identity
 */
export function areSameNametag(
  tag1: string,
  tag2: string,
  defaultCountry: string = DEFAULT_COUNTRY
): boolean {
  const normalized1 = normalizeNametag(tag1, defaultCountry);
  const normalized2 = normalizeNametag(tag2, defaultCountry);
  return normalized1 === normalized2;
}

/**
 * Format a nametag for display (privacy-preserving).
 * For phone numbers, hides middle digits.
 * @param nametag Nametag to format
 * @param defaultCountry Default country code for phone normalization
 * @returns Display-safe formatted nametag
 */
export function formatForDisplay(
  nametag: string,
  defaultCountry: string = DEFAULT_COUNTRY
): string {
  const trimmed = nametag.trim();

  if (isLikelyPhoneNumber(trimmed)) {
    const normalized = normalizePhoneNumber(trimmed, defaultCountry);
    if (normalized) {
      // Hide middle digits: +1415***2671
      const digits = normalized.slice(1); // Remove +
      if (digits.length > 6) {
        const start = digits.slice(0, 4);
        const end = digits.slice(-4);
        return '+' + start + '***' + end;
      }
    }
  }

  return normalizeNametag(nametag, defaultCountry);
}

/**
 * Check if a string is a valid phone number.
 * @param str String to check
 * @param defaultCountry Default country code
 * @returns true if the string is a valid phone number
 */
export function isPhoneNumber(
  str: string,
  defaultCountry: string = DEFAULT_COUNTRY
): boolean {
  try {
    return isValidPhoneNumber(str, defaultCountry as CountryCode) ||
           isValidPhoneNumber(str);
  } catch {
    return false;
  }
}

/**
 * Validate a nametag string. Strips leading @, normalizes, then checks format.
 * Regular nametags: lowercase alphanumeric, underscore, hyphen, 3-20 chars.
 * Phone numbers: validated via libphonenumber-js.
 * @param nametag Nametag to validate
 * @param defaultCountry Default country code for phone normalization
 * @returns true if the nametag is valid
 */
export function isValidNametag(
  nametag: string,
  defaultCountry: string = DEFAULT_COUNTRY
): boolean {
  const stripped = nametag.startsWith('@') ? nametag.slice(1) : nametag;
  const normalized = normalizeNametag(stripped, defaultCountry);

  if (isPhoneNumber(normalized)) {
    return true;
  }

  const pattern = new RegExp(
    `^[a-z0-9_-]{${NAMETAG_MIN_LENGTH},${NAMETAG_MAX_LENGTH}}$`
  );
  return pattern.test(normalized);
}

/**
 * Hash an address for use as an indexed relay tag.
 * Enables reverse lookup: address → binding event.
 * @param address Address string (e.g., DIRECT://..., alpha1..., PROXY://...)
 * @returns Hex-encoded SHA-256 hash
 */
export function hashAddressForTag(address: string): string {
  return sha256Hex(ADDRESS_SALT + address);
}

/**
 * Derive an AES-256 encryption key from a private key using HKDF-SHA256.
 * @param privateKeyHex Hex-encoded private key
 * @returns 32-byte derived key
 */
function deriveNametagEncryptionKey(privateKeyHex: string): Uint8Array {
  const privateKeyBytes = hexToBytes(privateKeyHex);
  const saltInput = new TextEncoder().encode('sphere-nametag-salt');
  const salt = sha256(saltInput);
  const info = new TextEncoder().encode('nametag-encryption');
  return hkdf(sha256, privateKeyBytes, salt, info, 32);
}

/**
 * Convert hex string to Uint8Array.
 */
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

/**
 * Encrypt a nametag with AES-GCM using a key derived from the private key.
 * Enables nametag recovery on wallet import.
 * @param nametag Plain text nametag
 * @param privateKeyHex Hex-encoded private key for key derivation
 * @returns Base64-encoded encrypted data (IV + ciphertext + auth tag)
 */
export async function encryptNametag(nametag: string, privateKeyHex: string): Promise<string> {
  const webCrypto = await getWebCrypto();
  const key = deriveNametagEncryptionKey(privateKeyHex);
  const iv = webCrypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(nametag);

  const cryptoKey = await webCrypto.subtle.importKey(
    'raw',
    new Uint8Array(key).buffer as ArrayBuffer,
    { name: 'AES-GCM' },
    false,
    ['encrypt'],
  );

  const encrypted = await webCrypto.subtle.encrypt(
    { name: 'AES-GCM', iv: new Uint8Array(iv).buffer as ArrayBuffer },
    cryptoKey,
    new Uint8Array(data).buffer as ArrayBuffer,
  );

  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(encrypted), iv.length);

  return toBase64(combined);
}

/**
 * Decrypt a nametag encrypted with encryptNametag().
 * @param encryptedBase64 Base64-encoded encrypted data (IV + ciphertext + auth tag)
 * @param privateKeyHex Hex-encoded private key for key derivation
 * @returns Decrypted nametag, or null if decryption fails (wrong key)
 */
export async function decryptNametag(encryptedBase64: string, privateKeyHex: string): Promise<string | null> {
  try {
    const webCrypto = await getWebCrypto();
    const key = deriveNametagEncryptionKey(privateKeyHex);
    const combined = fromBase64(encryptedBase64);

    const iv = combined.slice(0, 12);
    const ciphertext = combined.slice(12);

    const cryptoKey = await webCrypto.subtle.importKey(
      'raw',
      new Uint8Array(key).buffer as ArrayBuffer,
      { name: 'AES-GCM' },
      false,
      ['decrypt'],
    );

    const decrypted = await webCrypto.subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(iv).buffer as ArrayBuffer },
      cryptoKey,
      new Uint8Array(ciphertext).buffer as ArrayBuffer,
    );

    return new TextDecoder().decode(decrypted);
  } catch {
    return null;
  }
}
