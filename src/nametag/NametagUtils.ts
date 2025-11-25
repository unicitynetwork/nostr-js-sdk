/**
 * NametagUtils - Privacy-preserving nametag normalization and hashing.
 * Supports phone number normalization to E.164 format.
 */

import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { parsePhoneNumber, isValidPhoneNumber, CountryCode } from 'libphonenumber-js';

/** Salt prefix for nametag hashing */
const NAMETAG_SALT = 'unicity:nametag:';

/** Default country code for phone number normalization */
const DEFAULT_COUNTRY = 'US';

/**
 * Compute SHA-256 hash of a string.
 * @param input String to hash
 * @returns Hex-encoded hash
 */
function sha256Hex(input: string): string {
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
  const cleanedLength = str.replace(/[\s\-\(\)\.]/g, '').length;
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
