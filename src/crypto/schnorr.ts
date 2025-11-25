/**
 * BIP-340 Schnorr signature implementation using secp256k1.
 * Uses @noble/curves for cryptographic operations.
 */

import { schnorr } from '@noble/curves/secp256k1';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';

/**
 * Get the x-only public key from a private key (BIP-340)
 * @param privateKey 32-byte private key
 * @returns 32-byte x-only public key
 */
export function getPublicKey(privateKey: Uint8Array): Uint8Array {
  if (privateKey.length !== 32) {
    throw new Error('Private key must be 32 bytes');
  }
  return schnorr.getPublicKey(privateKey);
}

/**
 * Get the x-only public key from a hex-encoded private key
 * @param privateKeyHex Hex-encoded private key
 * @returns Hex-encoded x-only public key
 */
export function getPublicKeyHex(privateKeyHex: string): string {
  const privateKey = hexToBytes(privateKeyHex);
  const publicKey = getPublicKey(privateKey);
  return bytesToHex(publicKey);
}

/**
 * Sign a message using BIP-340 Schnorr signature
 * @param message 32-byte message hash to sign
 * @param privateKey 32-byte private key
 * @returns 64-byte Schnorr signature (R.x || s)
 */
export function sign(message: Uint8Array, privateKey: Uint8Array): Uint8Array {
  if (message.length !== 32) {
    throw new Error('Message must be 32 bytes');
  }
  if (privateKey.length !== 32) {
    throw new Error('Private key must be 32 bytes');
  }
  return schnorr.sign(message, privateKey);
}

/**
 * Sign a message and return hex-encoded signature
 * @param message 32-byte message hash to sign
 * @param privateKey 32-byte private key
 * @returns Hex-encoded 64-byte Schnorr signature
 */
export function signHex(message: Uint8Array, privateKey: Uint8Array): string {
  return bytesToHex(sign(message, privateKey));
}

/**
 * Verify a BIP-340 Schnorr signature
 * @param signature 64-byte Schnorr signature
 * @param message 32-byte message hash
 * @param publicKey 32-byte x-only public key
 * @returns true if the signature is valid
 */
export function verify(
  signature: Uint8Array,
  message: Uint8Array,
  publicKey: Uint8Array
): boolean {
  if (signature.length !== 64) {
    return false;
  }
  if (message.length !== 32) {
    return false;
  }
  if (publicKey.length !== 32) {
    return false;
  }

  try {
    return schnorr.verify(signature, message, publicKey);
  } catch {
    return false;
  }
}

/**
 * Verify a hex-encoded Schnorr signature
 * @param signatureHex Hex-encoded 64-byte signature
 * @param message 32-byte message hash
 * @param publicKeyHex Hex-encoded 32-byte public key
 * @returns true if the signature is valid
 */
export function verifyHex(
  signatureHex: string,
  message: Uint8Array,
  publicKeyHex: string
): boolean {
  try {
    const signature = hexToBytes(signatureHex);
    const publicKey = hexToBytes(publicKeyHex);
    return verify(signature, message, publicKey);
  } catch {
    return false;
  }
}
